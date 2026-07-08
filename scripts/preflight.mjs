import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

const required = [
  'public/index.html', 'public/admin.html', 'public/styles.css', 'public/_headers', 'public/_redirects',
  'public/js/app.js', 'public/js/admin.js', 'public/js/api.js', 'public/js/player.js', 'public/js/player-ui.js',
  'public/vendor/hls.min.js', 'functions/_middleware.ts', 'functions/_shared/auth.ts',
  'functions/api/health.ts', 'functions/api/admin/providers.ts',
  'migrations/0001_init.sql', 'DEPLOY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
];

const failures = [];
for (const file of required) {
  try { await access(file, constants.R_OK); }
  catch { failures.push(`缺少文件：${file}`); }
}

for (const forbidden of [
  'functions/api/auth/login.ts', 'functions/api/auth/logout.ts', 'functions/api/me.ts',
  'functions/api/library.ts', 'functions/api/admin/users.ts',
]) {
  try { await access(forbidden, constants.F_OK); failures.push(`不应包含账户接口：${forbidden}`); }
  catch {}
}

try {
  const vendor = await stat('public/vendor/hls.min.js');
  if (vendor.size < 200_000) failures.push('内置 hls.js 文件异常或不完整');
} catch {}

try {
  const html = await readFile('public/index.html', 'utf8');
  for (const ref of ['/styles.css', '/js/app.js']) if (!html.includes(ref)) failures.push(`首页缺少资源引用：${ref}`);
  if (/登录 Cactus TV|loginForm|authDialog/.test(html)) failures.push('首页仍包含登录界面');
} catch {}

try {
  const sql = await readFile('migrations/0001_init.sql', 'utf8');
  for (const table of ['settings', 'providers', 'provider_health', 'subtitles']) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql)) failures.push(`数据库迁移缺少表：${table}`);
  }
  for (const table of ['users', 'sessions', 'login_attempts', 'favorites', 'history']) {
    if (new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql)) failures.push(`数据库不应创建账户表：${table}`);
  }
} catch {}

try {
  const headers = await readFile('public/_headers', 'utf8');
  if (!headers.includes("script-src 'self'")) failures.push('CSP 未限制脚本为本站资源');
} catch {}

if (failures.length) {
  console.error('Cactus TV 预检失败：\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log(`Cactus TV 预检通过：已检查 ${required.length} 个文件。`);
