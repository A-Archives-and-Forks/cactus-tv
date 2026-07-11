import { HttpError, ok } from '../../_shared/http';
import { ensureStreamflowSchema, queueStreamflow, streamflowReady } from '../../_shared/streamflow';
import type { AppData, Env } from '../../_shared/types';

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ env }) => {
  if (!streamflowReady(env)) throw new HttpError(503, 'CactusStreamflow 尚未完成配置', 'STREAMFLOW_NOT_CONFIGURED');
  await ensureStreamflowSchema(env);
  const now = Date.now();
  await env.DB!.prepare(`UPDATE streamflow_sessions
    SET revision = revision + 1, cache_state = 'deleting', enabled = 0, updated_at = ?`).bind(now).run();
  await queueStreamflow(env, { type: 'clear', requestedAt: now });
  return ok({ clearing: true });
};
