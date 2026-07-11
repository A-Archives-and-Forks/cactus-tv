import { cleanText, HttpError, ok, readJson } from '../../_shared/http';
import { findProvider } from '../../_shared/providers';
import {
  cacheWindow,
  ensureStreamflowSchema,
  finiteNumber,
  providerAllowsUrl,
  queueStreamflow,
  streamflowReady,
  validStreamflowId,
} from '../../_shared/streamflow';
import type { AppData, Env } from '../../_shared/types';

type HeartbeatBody = {
  id?: unknown;
  itemKey?: unknown;
  provider?: unknown;
  sourceUrl?: unknown;
  title?: unknown;
  episodeName?: unknown;
  lineIndex?: unknown;
  episodeIndex?: unknown;
  position?: unknown;
  duration?: unknown;
  phase?: unknown;
  enabled?: unknown;
};

type SessionRow = {
  revision: number;
  cached_bytes: number;
  last_queued_at: number;
};

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  if (!streamflowReady(env)) {
    throw new HttpError(503, 'CactusStreamflow 尚未完成 R2、Queue 与 D1 绑定', 'STREAMFLOW_NOT_CONFIGURED');
  }
  await ensureStreamflowSchema(env);

  const body = await readJson<HeartbeatBody>(request, 32_000);
  const id = cleanText(body.id, 80).toLowerCase();
  if (!validStreamflowId(id)) throw new HttpError(400, '缓存会话 ID 无效', 'STREAMFLOW_INVALID_ID');

  const itemKey = cleanText(body.itemKey, 500);
  const providerId = cleanText(body.provider, 64);
  const sourceUrl = cleanText(body.sourceUrl, 4000);
  if (!itemKey || !providerId || !sourceUrl) throw new HttpError(400, '缓存会话缺少影片或片源信息', 'STREAMFLOW_INCOMPLETE_SESSION');

  const provider = await findProvider(env, providerId);
  if (!provider || !provider.enabled || !provider.proxyEnabled) {
    throw new HttpError(409, '该片源未启用受控代理，无法使用 CactusStreamflow', 'STREAMFLOW_PROXY_REQUIRED');
  }
  const normalizedSource = providerAllowsUrl(provider, sourceUrl).toString();

  const now = Date.now();
  const position = Math.max(0, finiteNumber(body.position));
  const duration = Math.max(0, finiteNumber(body.duration));
  const phaseRaw = cleanText(body.phase, 20).toLowerCase();
  const phase = ['playing', 'paused', 'hidden', 'exit'].includes(phaseRaw) ? phaseRaw : 'playing';
  const enabled = body.enabled !== false;
  const window = cacheWindow(position, duration);
  const existing = await env.DB!.prepare('SELECT revision, cached_bytes, last_queued_at FROM streamflow_sessions WHERE id = ?')
    .bind(id).first<SessionRow>();

  let revision = Number(existing?.revision || 0);
  const shouldQueue = Boolean(enabled && window.eligible);
  if (shouldQueue) revision += 1;

  await env.DB!.prepare(`INSERT INTO streamflow_sessions (
    id, item_key, provider_id, source_url, title, episode_name, line_index, episode_index,
    position_seconds, duration_seconds, target_start_seconds, target_end_seconds,
    revision, playback_state, cache_state, enabled, last_heartbeat, last_queued_at,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    item_key = excluded.item_key,
    provider_id = excluded.provider_id,
    source_url = excluded.source_url,
    title = excluded.title,
    episode_name = excluded.episode_name,
    line_index = excluded.line_index,
    episode_index = excluded.episode_index,
    position_seconds = excluded.position_seconds,
    duration_seconds = excluded.duration_seconds,
    target_start_seconds = excluded.target_start_seconds,
    target_end_seconds = excluded.target_end_seconds,
    revision = excluded.revision,
    playback_state = excluded.playback_state,
    cache_state = CASE
      WHEN excluded.enabled = 0 THEN 'disabled'
      WHEN streamflow_sessions.cache_state = 'deleting' THEN streamflow_sessions.cache_state
      ELSE streamflow_sessions.cache_state
    END,
    enabled = excluded.enabled,
    last_heartbeat = excluded.last_heartbeat,
    last_queued_at = excluded.last_queued_at,
    updated_at = excluded.updated_at`)
    .bind(
      id,
      itemKey,
      providerId,
      normalizedSource,
      cleanText(body.title, 240),
      cleanText(body.episodeName, 160),
      Math.max(0, Math.floor(finiteNumber(body.lineIndex))),
      Math.max(0, Math.floor(finiteNumber(body.episodeIndex))),
      position,
      duration,
      window.start,
      window.end,
      revision,
      phase,
      enabled ? 'idle' : 'disabled',
      enabled ? 1 : 0,
      now,
      shouldQueue ? now : Number(existing?.last_queued_at || 0),
      now,
      now,
    ).run();

  if (shouldQueue) {
    const message = { type: 'cache', sessionId: id, revision } as const;
    if (phase === 'playing') {
      // 每个心跳都留下一个延迟看门狗：浏览器被直接杀掉时，最后一条仍会启动云端缓存。
      // 已经存在 R2 缓存时，再立即投递一条，用于边看边向后扩展滚动窗口。
      if (Number(existing?.cached_bytes || 0) > 0) await queueStreamflow(env, message);
      await queueStreamflow(env, message, 70);
    } else {
      await queueStreamflow(env, message, phase === 'exit' ? 4 : 18);
    }
  }

  return ok({
    ready: true,
    eligible: enabled && window.eligible,
    queued: shouldQueue,
    targetStart: window.start,
    targetEnd: window.end,
    cachedBytes: Number(existing?.cached_bytes || 0),
  });
};
