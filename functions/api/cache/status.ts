import { ok } from '../../_shared/http';
import {
  getStreamflowGeneration,
  STREAMFLOW_CACHE_TTL_SECONDS,
  STREAMFLOW_MAX_PREFETCH_OBJECTS,
  streamflowReady,
} from '../../_shared/streamflow';
import type { AppData, Env } from '../../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env }) => {
  const ready = streamflowReady();
  const generation = await getStreamflowGeneration(env);
  return ok({
    ready,
    engine: 'cache-api',
    generation,
    ttlSeconds: STREAMFLOW_CACHE_TTL_SECONDS,
    maxExitPrefetchObjects: STREAMFLOW_MAX_PREFETCH_OBJECTS,
    capacityKnown: false,
    localToDataCenter: true,
    persistent: false,
  });
};
