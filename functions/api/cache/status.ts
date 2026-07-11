import { ok } from '../../_shared/http';
import { ensureStreamflowSchema, streamflowReady } from '../../_shared/streamflow';
import type { AppData, Env } from '../../_shared/types';

type Totals = { bytes: number | null; objects: number | null; sessions: number | null };
type Session = {
  id: string;
  item_key: string;
  title: string;
  episode_name: string;
  position_seconds: number;
  duration_seconds: number;
  cached_start_seconds: number;
  cached_end_seconds: number;
  cached_bytes: number;
  cached_objects: number;
  cache_state: string;
  playback_state: string;
  last_error: string;
  updated_at: number;
};

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env }) => {
  if (!streamflowReady(env)) return ok({ ready: false, totalBytes: 0, totalObjects: 0, sessions: [] });
  await ensureStreamflowSchema(env);
  const [totals, sessions] = await env.DB!.batch([
    env.DB!.prepare(`SELECT
      COALESCE(SUM(cached_bytes), 0) AS bytes,
      COALESCE(SUM(cached_objects), 0) AS objects,
      COUNT(*) AS sessions
      FROM streamflow_sessions WHERE cached_bytes > 0 OR cache_state NOT IN ('idle', 'disabled')`),
    env.DB!.prepare(`SELECT id, item_key, title, episode_name, position_seconds, duration_seconds,
      cached_start_seconds, cached_end_seconds, cached_bytes, cached_objects,
      cache_state, playback_state, last_error, updated_at
      FROM streamflow_sessions
      WHERE cached_bytes > 0 OR cache_state NOT IN ('idle', 'disabled')
      ORDER BY updated_at DESC LIMIT 12`),
  ]);
  const summary = (totals.results?.[0] || {}) as Totals;
  return ok({
    ready: true,
    totalBytes: Number(summary.bytes || 0),
    totalObjects: Number(summary.objects || 0),
    sessionCount: Number(summary.sessions || 0),
    limitBytes: 5_000_000_000,
    perSessionLimitBytes: 950 * 1024 * 1024,
    sessions: (sessions.results || []) as Session[],
  });
};
