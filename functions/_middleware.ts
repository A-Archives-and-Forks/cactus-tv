import { errorResponse } from './_shared/http';
import type { AppData, Env } from './_shared/types';

const COOKIE_NAME = 'cactus_session';
const LOGIN_PATH = '/__cactus/login';
const LOGOUT_PATH = '/__cactus/logout';
const SESSION_MESSAGE = 'cactus-tv-session-v1';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return mismatch === 0;
}

function getCookie(request: Request, name: string): string {
  const cookieHeader = request.headers.get('cookie') || '';

  for (const item of cookieHeader.split(';')) {
    const [key, ...valueParts] = item.trim().split('=');
    if (key === name) return decodeURIComponent(valueParts.join('='));
  }

  return '';
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function createSessionSignature(adminToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(adminToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(SESSION_MESSAGE),
  );

  return bytesToBase64Url(new Uint8Array(signature));
}

async function hasValidSession(request: Request, adminToken: string): Promise<boolean> {
  const supplied = getCookie(request, COOKIE_NAME);
  if (!supplied) return false;

  const expected = await createSessionSignature(adminToken);
  return timingSafeEqual(supplied, expected);
}

function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';

  try {
    const parsed = new URL(value, 'https://cactus.invalid');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '/';
  }
}

function loginPage(returnPath: string, message = ''): Response {
  const safeReturn = safeReturnPath(returnPath);
  const escapedReturn = safeReturn
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const escapedMessage = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta name="theme-color" content="#080808">
  <title>Cactus TV · 私人访问</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #080808;
      color: #fff;
    }

    * { box-sizing: border-box; }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      overflow: hidden;
      background:
        radial-gradient(circle at 16% 12%, rgba(89, 255, 145, .15), transparent 32%),
        radial-gradient(circle at 86% 82%, rgba(37, 124, 255, .12), transparent 35%),
        #080808;
    }

    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background-image:
        linear-gradient(rgba(255,255,255,.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255,255,255,.018) 1px, transparent 1px);
      background-size: 42px 42px;
      mask-image: linear-gradient(to bottom, black, transparent 88%);
    }

    .card {
      position: relative;
      width: min(100%, 420px);
      padding: 36px;
      border: 1px solid rgba(255,255,255,.11);
      border-radius: 26px;
      background: rgba(17,17,17,.86);
      box-shadow: 0 28px 90px rgba(0,0,0,.55);
      backdrop-filter: blur(20px);
    }

    .brand {
      display: flex;
      align-items: baseline;
      gap: 7px;
      margin-bottom: 42px;
      font-weight: 900;
      letter-spacing: -.04em;
    }

    .brand-main { font-size: 25px; }
    .brand-tv { color: #6dff9a; font-size: 17px; }

    .eyebrow {
      color: #6dff9a;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: .2em;
    }

    h1 {
      margin: 9px 0 10px;
      font-size: clamp(30px, 8vw, 42px);
      letter-spacing: -.055em;
      line-height: 1.05;
    }

    p {
      margin: 0 0 28px;
      color: rgba(255,255,255,.58);
      line-height: 1.65;
      font-size: 14px;
    }

    label {
      display: block;
      margin-bottom: 9px;
      color: rgba(255,255,255,.76);
      font-size: 13px;
      font-weight: 700;
    }

    input {
      width: 100%;
      height: 52px;
      padding: 0 16px;
      border: 1px solid rgba(255,255,255,.13);
      border-radius: 14px;
      outline: none;
      background: rgba(255,255,255,.055);
      color: #fff;
      font: inherit;
      transition: border-color .2s, box-shadow .2s, background .2s;
    }

    input:focus {
      border-color: rgba(109,255,154,.78);
      background: rgba(255,255,255,.075);
      box-shadow: 0 0 0 4px rgba(109,255,154,.1);
    }

    button {
      width: 100%;
      height: 52px;
      margin-top: 14px;
      border: 0;
      border-radius: 14px;
      background: #f4f4f4;
      color: #080808;
      font: inherit;
      font-weight: 850;
      cursor: pointer;
      transition: transform .16s, opacity .16s;
    }

    button:active { transform: scale(.985); }
    button:hover { opacity: .92; }

    .message {
      min-height: 20px;
      margin-top: 14px;
      color: #ff8585;
      font-size: 13px;
      text-align: center;
    }

    .foot {
      margin-top: 30px;
      color: rgba(255,255,255,.3);
      font-size: 11px;
      text-align: center;
    }

    @media (max-width: 520px) {
      .card {
        padding: 28px 22px;
        border-radius: 22px;
      }
    }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">
      <span class="brand-main">CACTUS</span>
      <span class="brand-tv">TV</span>
    </div>

    <span class="eyebrow">PRIVATE ACCESS</span>
    <h1>请输入访问密码</h1>
    <p>此站点仅供私人访问。密码与管理后台的 ADMIN_TOKEN 相同。</p>

    <form method="post" action="${LOGIN_PATH}" id="loginForm">
      <input type="hidden" name="return" value="${escapedReturn}">

      <label for="password">访问密码</label>
      <input
        id="password"
        name="password"
        type="password"
        minlength="8"
        autocomplete="current-password"
        autofocus
        required
      >

      <button type="submit">进入 Cactus TV</button>
      <div class="message" role="alert">${escapedMessage}</div>
    </form>

    <div class="foot">密码不会写入网页代码或公开仓库</div>
  </main>

  <script>
    document.getElementById('loginForm').addEventListener('submit', function () {
      const password = document.getElementById('password').value.trim();
      if (password) {
        // 与当前 /admin.html 保持一致：只在本标签页中保存管理密钥。
        sessionStorage.setItem('cactus:admin-token', password);
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    status: message ? 401 : 200,
    headers: {
      'content-type': 'text/html; charset=UTF-8',
      'cache-control': 'no-store, private',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  });
}

function jsonUnauthorized(): Response {
  return new Response(
    JSON.stringify({
      error: '需要先输入站点访问密码',
      code: 'SITE_AUTH_REQUIRED',
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'cache-control': 'no-store, private',
      },
    },
  );
}

function sessionCookie(value: string): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}

function clearSessionCookie(): string {
  return [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Max-Age=0',
  ].join('; ');
}

export const onRequest: PagesFunction<Env, any, AppData> = async context => {
  const requestId = context.request.headers.get('cf-ray') || crypto.randomUUID();
  const url = new URL(context.request.url);
  const adminToken = (context.env.ADMIN_TOKEN || '').trim();

  context.data.requestId = requestId;

  try {
    if (!adminToken || adminToken.length < 8) {
      return new Response('尚未正确配置 ADMIN_TOKEN，站点已锁定。', {
        status: 503,
        headers: {
          'content-type': 'text/plain; charset=UTF-8',
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === LOGIN_PATH) {
      if (context.request.method === 'GET') {
        return loginPage(safeReturnPath(url.searchParams.get('return')));
      }

      if (context.request.method !== 'POST') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { allow: 'GET, POST' },
        });
      }

      const formData = await context.request.formData();
      const returnPath = safeReturnPath(String(formData.get('return') || '/'));
      const password = String(formData.get('password') || '').trim();

      if (!password || !timingSafeEqual(password, adminToken)) {
        return loginPage(returnPath, '密码错误，请重新输入。');
      }

      const signature = await createSessionSignature(adminToken);
      return new Response(null, {
        status: 303,
        headers: {
          location: new URL(returnPath, url.origin).toString(),
          'set-cookie': sessionCookie(signature),
          'cache-control': 'no-store',
        },
      });
    }

    if (url.pathname === LOGOUT_PATH) {
      return new Response(null, {
        status: 303,
        headers: {
          location: new URL(LOGIN_PATH, url.origin).toString(),
          'set-cookie': clearSessionCookie(),
          'cache-control': 'no-store',
        },
      });
    }

    if (!(await hasValidSession(context.request, adminToken))) {
      if (url.pathname.startsWith('/api/')) return jsonUnauthorized();

      const returnPath = `${url.pathname}${url.search}${url.hash}`;
      return loginPage(returnPath);
    }

    const response = await context.next();
    const headers = new Headers(response.headers);

    headers.set('x-request-id', requestId);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'strict-origin-when-cross-origin');
    headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');

    if (
      url.pathname === '/' ||
      url.pathname.endsWith('.html') ||
      (url.pathname.startsWith('/api/')
        && url.pathname !== '/api/stream'
        && url.pathname !== '/api/subtitle')
    ) {
      headers.set('cache-control', 'no-store, private');
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    if (url.pathname.startsWith('/api/')) return errorResponse(error, requestId);

    console.error(`[${requestId}]`, error);
    return new Response('Cactus TV 暂时无法处理此请求', {
      status: 500,
      headers: {
        'content-type': 'text/plain; charset=UTF-8',
        'cache-control': 'no-store',
      },
    });
  }
};
