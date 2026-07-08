import type { AppData, Env } from './types';

export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, message: string, code = 'REQUEST_FAILED', details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(data: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status >= 400 ? 'no-store' : 'private, no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

export function ok(data: Record<string, unknown> = {}, status = 200): Response {
  return json({ ok: true, ...data }, status);
}

export function errorResponse(error: unknown, requestId?: string): Response {
  if (error instanceof HttpError) {
    return json({ ok: false, error: error.message, code: error.code, details: error.details, requestId }, error.status);
  }
  console.error(`[${requestId || 'no-request-id'}]`, error);
  return json({ ok: false, error: '服务器处理请求时发生错误', code: 'INTERNAL_ERROR', requestId }, 500);
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 64_000): Promise<T> {
  const length = Number(request.headers.get('content-length') || '0');
  if (length > maxBytes) throw new HttpError(413, '请求内容过大', 'PAYLOAD_TOO_LARGE');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, '请求内容过大', 'PAYLOAD_TOO_LARGE');
  try { return JSON.parse(text || '{}') as T; }
  catch { throw new HttpError(400, '请求 JSON 格式无效', 'INVALID_JSON'); }
}

export function getRequestId(data?: AppData): string {
  return data?.requestId || crypto.randomUUID();
}

export function cleanText(value: unknown, max = 200): string {
  return String(value ?? '').trim().slice(0, max);
}

export function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return fallback;
}

export function envBool(env: Env, key: keyof Env, fallback = false): boolean {
  return boolValue(env[key], fallback);
}
