import { requireAdmin } from '../../../_shared/auth';
import { HttpError, ok, readJson } from '../../../_shared/http';
import { findProvider, normalizeProvider, saveProvider } from '../../../_shared/providers';
import { requireDb } from '../../../_shared/db';
import type { AppData, Env } from '../../../_shared/types';

export const onRequestPatch: PagesFunction<Env, 'id', AppData> = async ({ request, env, params }) => {
  requireAdmin(request, env);
  const existing = await findProvider(env, String(params.id));
  if (!existing) throw new HttpError(404, '数据源不存在', 'PROVIDER_NOT_FOUND');
  const patch = await readJson<any>(request, 40_000);
  const provider = normalizeProvider({ ...existing, ...patch, id: existing.id });
  await saveProvider(env, provider);
  return ok({ provider });
};

export const onRequestDelete: PagesFunction<Env, 'id', AppData> = async ({ request, env, params }) => {
  requireAdmin(request, env);
  const db = requireDb(env);
  const id = String(params.id);
  await db.batch([
    db.prepare('DELETE FROM provider_health WHERE provider_id = ?').bind(id),
    db.prepare('DELETE FROM providers WHERE id = ?').bind(id),
  ]);
  return ok({ deleted: true });
};
