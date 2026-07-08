import { HttpError } from './http';
import type { Env } from './types';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function suppliedToken(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return (request.headers.get('x-admin-token') || '').trim();
}

export function requireAdmin(request: Request, env: Env): void {
  const configured = (env.ADMIN_TOKEN || '').trim();
  if (!configured) throw new HttpError(503, '尚未配置 ADMIN_TOKEN，管理后台已禁用', 'ADMIN_NOT_CONFIGURED');
  if (configured.length < 16) throw new HttpError(503, 'ADMIN_TOKEN 至少需要 16 个字符', 'ADMIN_TOKEN_TOO_SHORT');
  const provided = suppliedToken(request);
  if (!provided || !timingSafeEqual(provided, configured)) throw new HttpError(401, '管理密钥无效', 'ADMIN_TOKEN_INVALID');
}

export function adminConfigured(env: Env): boolean {
  return Boolean((env.ADMIN_TOKEN || '').trim().length >= 16);
}
