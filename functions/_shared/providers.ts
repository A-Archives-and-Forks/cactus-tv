import { requireDb } from './db';
import { HttpError } from './http';
import type { Env, Provider } from './types';

const PRIVATE_HOSTS = /^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

export function validateHttpsUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new HttpError(400, 'URL 格式无效', 'INVALID_URL'); }
  if (url.protocol !== 'https:') throw new HttpError(400, '只允许 HTTPS 地址', 'HTTPS_REQUIRED');
  if (PRIVATE_HOSTS.test(url.hostname) || url.hostname.endsWith('.local')) throw new HttpError(400, '禁止访问本地或私有网络地址', 'PRIVATE_NETWORK_BLOCKED');
  if (url.username || url.password) throw new HttpError(400, 'URL 不得包含账号密码', 'URL_CREDENTIALS_BLOCKED');
  url.hash = '';
  return url.toString();
}

function cleanHeaders(value: unknown): Record<string, string> {
  const allowed = new Set(['referer', 'origin', 'user-agent', 'authorization', 'accept', 'accept-language']);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, val]) => [key.toLowerCase().trim(), String(val).trim()])
    .filter(([key, val]) => allowed.has(key) && val && val.length <= 500));
}

export function normalizeProvider(entry: any): Provider {
  if (!entry || typeof entry !== 'object') throw new HttpError(400, '数据源配置无效', 'INVALID_PROVIDER');
  const id = String(entry.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);
  const name = String(entry.name || '').trim().slice(0, 80);
  if (!id || !name) throw new HttpError(400, '数据源 ID 和名称不能为空', 'INVALID_PROVIDER');
  const baseUrl = validateHttpsUrl(String(entry.baseUrl || entry.base_url || ''));
  const rawHosts = Array.isArray(entry.mediaHosts) ? entry.mediaHosts : Array.isArray(entry.media_hosts) ? entry.media_hosts : [];
  const mediaHosts = [...new Set(rawHosts.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
  return {
    id, name, baseUrl,
    enabled: entry.enabled !== false && Number(entry.enabled ?? 1) !== 0,
    priority: Math.min(999, Math.max(-999, Number(entry.priority || 0) || 0)),
    proxyEnabled: entry.proxyEnabled === true || Number(entry.proxy_enabled || 0) === 1,
    mediaHosts,
    requestHeaders: cleanHeaders(entry.requestHeaders || entry.request_headers || safeJson(entry.headers_json, {})),
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
  };
}

function safeJson(value: unknown, fallback: any) {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function envProviders(env: Env): Provider[] {
  if (!env.PROVIDERS_JSON) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(env.PROVIDERS_JSON); } catch { throw new HttpError(500, 'PROVIDERS_JSON 不是合法 JSON', 'PROVIDER_CONFIG_ERROR'); }
  if (!Array.isArray(parsed)) throw new HttpError(500, 'PROVIDERS_JSON 必须是数组', 'PROVIDER_CONFIG_ERROR');
  return parsed.map(normalizeProvider).filter(provider => provider.enabled);
}

export async function getProviders(env: Env, includeDisabled = false): Promise<Provider[]> {
  if (env.DB) {
    try {
      const result = await env.DB.prepare(`SELECT id, name, base_url, enabled, priority, proxy_enabled, media_hosts, headers_json, created_at, updated_at
        FROM providers ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY priority DESC, name ASC`).all<any>();
      if ((result.results || []).length) return result.results.map(row => normalizeProvider({
        ...row, baseUrl: row.base_url, proxyEnabled: row.proxy_enabled, mediaHosts: safeJson(row.media_hosts, []), requestHeaders: safeJson(row.headers_json, {})
      }));
    } catch (error) { console.warn('D1 providers unavailable, falling back to env', error); }
  }
  const list = envProviders(env);
  return includeDisabled ? list : list.filter(p => p.enabled);
}

export async function findProvider(env: Env, id: string): Promise<Provider | undefined> {
  return (await getProviders(env, true)).find(provider => provider.id === id);
}

export function buildCmsUrl(provider: Provider, params: Record<string, string>): string {
  const url = new URL(provider.baseUrl);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  return url.toString();
}

export async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new HttpError(504, '上游请求超时', 'UPSTREAM_TIMEOUT');
    throw error;
  } finally { clearTimeout(timeout); }
}

export async function fetchJson(url: string, provider?: Provider, timeoutMs = 8_000): Promise<any> {
  const response = await fetchWithTimeout(url, {
    headers: { Accept: 'application/json, text/plain;q=0.9', 'User-Agent': 'CactusTV/0.2', ...(provider?.requestHeaders || {}) },
  }, timeoutMs);
  if (!response.ok) throw new HttpError(502, `上游返回 HTTP ${response.status}`, 'UPSTREAM_HTTP_ERROR');
  const text = await response.text();
  if (text.length > 5_000_000) throw new HttpError(502, '上游响应过大', 'UPSTREAM_TOO_LARGE');
  try { return JSON.parse(text); }
  catch { throw new HttpError(502, '上游没有返回有效 JSON', 'UPSTREAM_INVALID_JSON'); }
}

export async function saveProvider(env: Env, provider: Provider): Promise<void> {
  const db = requireDb(env);
  await db.prepare(`INSERT INTO providers
    (id, name, base_url, enabled, priority, proxy_enabled, media_hosts, headers_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url, enabled=excluded.enabled,
      priority=excluded.priority, proxy_enabled=excluded.proxy_enabled, media_hosts=excluded.media_hosts,
      headers_json=excluded.headers_json, updated_at=datetime('now')`)
    .bind(provider.id, provider.name, provider.baseUrl, provider.enabled ? 1 : 0, provider.priority,
      provider.proxyEnabled ? 1 : 0, JSON.stringify(provider.mediaHosts), JSON.stringify(provider.requestHeaders)).run();
}
