import { cleanText, HttpError, ok, readJson } from '../../_shared/http';
import { findProvider } from '../../_shared/providers';
import {
  cacheWindow,
  finiteNumber,
  normalizeStreamflowGeneration,
  prefetchStreamflow,
  providerAllowsUrl,
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
  generation?: unknown;
};

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request, env, waitUntil }) => {
  if (!streamflowReady()) {
    throw new HttpError(503, '当前 Cloudflare 运行环境不支持 Cache API', 'STREAMFLOW_NOT_AVAILABLE');
  }

  const body = await readJson<HeartbeatBody>(request, 32_000);
  const id = cleanText(body.id, 80).toLowerCase();
  if (!validStreamflowId(id)) throw new HttpError(400, '缓存会话 ID 无效', 'STREAMFLOW_INVALID_ID');

  const providerId = cleanText(body.provider, 64);
  const sourceUrl = cleanText(body.sourceUrl, 4000);
  if (!providerId || !sourceUrl) throw new HttpError(400, '缓存会话缺少片源信息', 'STREAMFLOW_INCOMPLETE_SESSION');

  const provider = await findProvider(env, providerId);
  if (!provider || !provider.enabled || !provider.proxyEnabled) {
    throw new HttpError(409, '该片源未启用受控代理，无法使用 CactusStreamflow', 'STREAMFLOW_PROXY_REQUIRED');
  }
  const normalizedSource = providerAllowsUrl(provider, sourceUrl).toString();

  const position = Math.max(0, finiteNumber(body.position));
  const duration = Math.max(0, finiteNumber(body.duration));
  const phaseRaw = cleanText(body.phase, 20).toLowerCase();
  const phase = ['playing', 'paused', 'hidden', 'exit'].includes(phaseRaw) ? phaseRaw : 'playing';
  const enabled = body.enabled !== false;
  const generation = normalizeStreamflowGeneration(body.generation);
  const window = cacheWindow(position, duration);
  const shouldPrefetch = Boolean(enabled && window.eligible);

  if (shouldPrefetch) {
    const origin = new URL(request.url).origin;
    waitUntil(prefetchStreamflow({
      origin,
      sessionId: id,
      generation,
      provider,
      sourceUrl: normalizedSource,
      position,
      duration,
      phase,
    }).catch(error => console.warn('CactusStreamflow prefetch failed', error)));
  }

  return ok({
    ready: true,
    engine: 'cache-api',
    eligible: enabled && window.eligible,
    prefetchScheduled: shouldPrefetch,
    targetStart: window.start,
    targetEnd: window.end,
    generation,
    phase,
  });
};
