import { requireDb } from '../_shared/db';
import { cleanText, HttpError, ok, readJson } from '../_shared/http';
import type { AppData, Env } from '../_shared/types';

type LibraryItem = Record<string, unknown> & { key?: unknown };
type LibraryOperation = {
  type?: unknown;
  enabled?: unknown;
  key?: unknown;
  item?: LibraryItem;
};

const FAVORITES_LIMIT = 300;
const HISTORY_LIMIT = 200;
const MAX_ITEM_BYTES = 48_000;
const MAX_BATCH_OPERATIONS = 20;
let schemaReady: Promise<void> | null = null;

function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS favorites (
        item_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_favorites_updated ON favorites(updated_at DESC)'),
      db.prepare(`CREATE TABLE IF NOT EXISTS watch_history (
        item_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        watched_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS idx_watch_history_watched ON watch_history(watched_at DESC)'),
    ]).then(() => undefined).catch(error => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

function itemKey(value: unknown): string {
  const key = cleanText(value, 500);
  if (!key) throw new HttpError(400, '缺少有效的影片标识', 'INVALID_ITEM_KEY');
  return key;
}

function serializeItem(item: LibraryItem | undefined): { key: string; json: string; watchedAt: number } {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new HttpError(400, '影片数据格式无效', 'INVALID_LIBRARY_ITEM');
  }
  const key = itemKey(item.key);
  const normalized = { ...item, key };
  const json = JSON.stringify(normalized);
  if (new TextEncoder().encode(json).byteLength > MAX_ITEM_BYTES) {
    throw new HttpError(413, '单条收藏或观看记录过大', 'LIBRARY_ITEM_TOO_LARGE');
  }
  const watchedAt = Math.max(0, Number(item.watchedAt) || Date.now());
  return { key, json, watchedAt };
}

function parseRows(rows: Array<{ payload_json: string }> | undefined): LibraryItem[] {
  const items: LibraryItem[] = [];
  for (const row of rows || []) {
    try {
      const item = JSON.parse(row.payload_json);
      if (item && typeof item === 'object' && !Array.isArray(item) && item.key) items.push(item);
    } catch {}
  }
  return items;
}

function operationStatements(db: D1Database, operation: LibraryOperation, now: number): D1PreparedStatement[] {
  const type = cleanText(operation.type, 32).toLowerCase();

  if (type === 'favorite') {
    const enabled = operation.enabled !== false;
    if (!enabled) {
      return [db.prepare('DELETE FROM favorites WHERE item_key = ?').bind(itemKey(operation.key ?? operation.item?.key))];
    }
    const item = serializeItem(operation.item);
    return [db.prepare(`INSERT INTO favorites (item_key, payload_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
      .bind(item.key, item.json, now, now)];
  }

  if (type === 'history') {
    const item = serializeItem(operation.item);
    return [db.prepare(`INSERT INTO watch_history (item_key, payload_json, watched_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(item_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        watched_at = excluded.watched_at,
        updated_at = excluded.updated_at`)
      .bind(item.key, item.json, item.watchedAt, now)];
  }

  if (type === 'history-delete') {
    return [db.prepare('DELETE FROM watch_history WHERE item_key = ?').bind(itemKey(operation.key ?? operation.item?.key))];
  }

  throw new HttpError(400, '不支持的片单操作', 'INVALID_LIBRARY_OPERATION');
}

export const onRequestGet: PagesFunction<Env, any, AppData> = async ({ env }) => {
  const db = requireDb(env);
  await ensureSchema(db);
  const [favoritesResult, historyResult] = await db.batch([
    db.prepare('SELECT payload_json FROM favorites ORDER BY updated_at DESC LIMIT ?').bind(FAVORITES_LIMIT),
    db.prepare('SELECT payload_json FROM watch_history ORDER BY watched_at DESC, updated_at DESC LIMIT ?').bind(HISTORY_LIMIT),
  ]);
  return ok({
    favorites: parseRows(favoritesResult.results as Array<{ payload_json: string }>),
    history: parseRows(historyResult.results as Array<{ payload_json: string }>),
  });
};

export const onRequestPost: PagesFunction<Env, any, AppData> = async ({ request, env }) => {
  const db = requireDb(env);
  await ensureSchema(db);
  const body = await readJson<{ action?: unknown; operations?: LibraryOperation[] } & LibraryOperation>(request, 1_000_000);
  const action = cleanText(body.action, 24).toLowerCase();
  const operations = action === 'batch'
    ? (Array.isArray(body.operations) ? body.operations.slice(0, MAX_BATCH_OPERATIONS) : [])
    : [body];

  if (!operations.length) throw new HttpError(400, '没有可保存的数据', 'EMPTY_LIBRARY_BATCH');

  const now = Date.now();
  const statements = operations.flatMap(operation => operationStatements(db, operation, now));
  statements.push(
    db.prepare(`DELETE FROM favorites WHERE item_key NOT IN (
      SELECT item_key FROM favorites ORDER BY updated_at DESC LIMIT ?
    )`).bind(FAVORITES_LIMIT),
    db.prepare(`DELETE FROM watch_history WHERE item_key NOT IN (
      SELECT item_key FROM watch_history ORDER BY watched_at DESC, updated_at DESC LIMIT ?
    )`).bind(HISTORY_LIMIT),
  );
  await db.batch(statements);
  return ok({ saved: operations.length });
};
