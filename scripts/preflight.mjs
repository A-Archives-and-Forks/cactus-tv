import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

const required = [
  'public/index.html', 'public/admin.html', 'public/styles.css', 'public/_headers', 'public/_redirects',
  'public/js/app.js', 'public/js/app-legacy.js', 'public/js/admin.js', 'public/js/api.js', 'public/js/player.js', 'public/js/player-ui.js',
  'public/vendor/hls.min.js', 'public/vendor/dash.all.min.js', 'functions/_middleware.ts', 'functions/_shared/auth.ts',
  'functions/api/health.ts', 'functions/api/subtitle.ts', 'functions/api/library.ts', 'functions/api/admin/providers.ts',
  'functions/api/cache/heartbeat.ts', 'functions/api/cache/status.ts', 'functions/api/cache/clear.ts',
  'functions/_shared/streamflow.ts', 'streamflow-worker/src/index.ts', 'streamflow-worker/wrangler.toml.example',
  'migrations/0001_init.sql', 'migrations/0002_library.sql', 'migrations/0003_streamflow.sql', 'CACTUS_STREAMFLOW.md', 'DEPLOY.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
];

const failures = [];
for (const file of required) {
  try { await access(file, constants.R_OK); }
  catch { failures.push(`缺少文件：${file}`); }
}

for (const forbidden of [
  'functions/api/auth/login.ts', 'functions/api/auth/logout.ts', 'functions/api/me.ts',
  'functions/api/admin/users.ts',
]) {
  try { await access(forbidden, constants.F_OK); failures.push(`不应包含账户接口：${forbidden}`); }
  catch {}
}

try {
  const vendor = await stat('public/vendor/hls.min.js');
  if (vendor.size < 200_000) failures.push('内置 hls.js 文件异常或不完整');
  const dashVendor = await stat('public/vendor/dash.all.min.js');
  if (dashVendor.size < 500_000) failures.push('内置 dash.js 文件异常或不完整');
} catch {}

try {
  const html = await readFile('public/index.html', 'utf8');
  for (const ref of ['/styles.css', '/js/app.js']) if (!html.includes(ref)) failures.push(`首页缺少资源引用：${ref}`);
  if (/登录 Cactus TV|loginForm|authDialog/.test(html)) failures.push('首页仍包含登录界面');
} catch {}

try {
  const sql = await readFile('migrations/0001_init.sql', 'utf8');
  for (const table of ['settings', 'providers', 'provider_health', 'subtitles', 'favorites', 'watch_history']) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql)) failures.push(`数据库迁移缺少表：${table}`);
  }
  for (const table of ['users', 'sessions', 'login_attempts']) {
    if (new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql)) failures.push(`数据库不应创建账户表：${table}`);
  }
} catch {}


try {
  const streamflowSql = await readFile('migrations/0003_streamflow.sql', 'utf8');
  for (const table of ['streamflow_sessions', 'streamflow_objects', 'streamflow_hints']) {
    if (!new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(streamflowSql)) failures.push(`CactusStreamflow 迁移缺少表：${table}`);
  }
} catch {}

try {
  const wrangler = await readFile('wrangler.toml.example', 'utf8');
  for (const binding of ['STREAMFLOW_R2', 'STREAMFLOW_QUEUE']) {
    if (!wrangler.includes(`binding = "${binding}"`)) failures.push(`Pages Wrangler 缺少 Binding：${binding}`);
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
