import { HttpError } from './http';
import type { Env } from './types';

export function requireDb(env: Env): D1Database {
  if (!env.DB) throw new HttpError(503, 'D1 数据库尚未绑定，请完成部署配置', 'DB_NOT_CONFIGURED');
  return env.DB;
}

export async function getSetting(env: Env, key: string, fallback = ''): Promise<string> {
  if (!env.DB) return fallback;
  try {
    const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>();
    return row?.value ?? fallback;
  } catch { return fallback; }
}

export async function setSetting(env: Env, key: string, value: string): Promise<void> {
  const db = requireDb(env);
  await db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).bind(key, value).run();
}

export async function getSettings(env: Env): Promise<Record<string, string>> {
  if (!env.DB) return {};
  const result = await env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>();
  return Object.fromEntries((result.results || []).map(row => [row.key, row.value]));
}
