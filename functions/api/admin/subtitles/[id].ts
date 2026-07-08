import { requireAdmin } from '../../../_shared/auth';
import { requireDb } from '../../../_shared/db';
import { ok } from '../../../_shared/http';
import type { AppData, Env } from '../../../_shared/types';

export const onRequestDelete: PagesFunction<Env, 'id', AppData> = async ({ request, env, params }) => {
  requireAdmin(request, env);
  const db = requireDb(env);
  await db.prepare('DELETE FROM subtitles WHERE id = ?').bind(String(params.id)).run();
  return ok({ deleted: true });
};
