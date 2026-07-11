import { ok } from '../../_shared/http';
import { bumpStreamflowGeneration } from '../../_shared/streamflow';
import type { AppData, Env } from '../../_shared/types';

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ env }) => {
  const generation = await bumpStreamflowGeneration(env);
  return ok({
    reset: true,
    generation,
    message: '已切换到新的缓存代数；旧边缘缓存将由 Cloudflare 自动淘汰。',
  });
};
