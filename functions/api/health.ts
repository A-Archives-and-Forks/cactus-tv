import { adminConfigured } from '../_shared/auth';
import { getSetting } from '../_shared/db';
import { ok } from '../_shared/http';
import { streamflowReady } from '../_shared/streamflow';
import { getProviders } from '../_shared/providers';
import type { AppData, Env } from '../_shared/types';

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env }) => {
  const providers = await getProviders(env);
  const siteName = await getSetting(env, 'site_name', env.SITE_NAME || 'Cactus TV');
  return ok({
    siteName,
    dbReady: Boolean(env.DB),
    tmdbReady: Boolean(env.TMDB_BEARER_TOKEN),
    adminReady: adminConfigured(env),
    privateMode: true,
    streamflowReady: streamflowReady(env),
    providers: providers.map(({ id, name, proxyEnabled }) => ({ id, name, proxyEnabled })),
  }, 200, { 'cache-control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' });
};
