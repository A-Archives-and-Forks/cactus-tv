# Cactus TV v0.8.2 部署教程（Fork + Cloudflare Pages）

这份教程使用推荐部署方式：

```text
Fork GitHub 仓库 → Cloudflare Pages 连接 Fork → 自动部署
```

不推荐下载 ZIP 后手动上传。Fork 可以保留完整 Git 历史，后续更新也只需要同步代码。

不要使用 Cloudflare Pages 的静态文件直接上传，也不要只上传 `public` 文件夹。`functions` 必须和 `public` 一起位于仓库根目录，否则 Pages Functions 不会部署。

---

## 一、准备账号

需要两个账号：

1. GitHub
2. Cloudflare

建议先分别登录，再开始下面的步骤。

---

## 二、Fork 项目

1. 打开 GitHub 项目主页。
2. 点击右上角 `Fork`。
3. 选择自己的账号和仓库名称。
4. 等待 Fork 完成。

Fork 完成后，你的仓库根目录应该直接包含：

```text
functions/
migrations/
public/
scripts/
package.json
README.md
```

不要重新套一层文件夹。

## 三、创建 Cloudflare Pages 项目

### 1. 连接 GitHub

进入 Cloudflare Dashboard：

```text
Workers & Pages
→ Create application
→ Pages
→ Connect to Git
```

首次使用时，Cloudflare 会要求授权 GitHub。

选择刚才创建的 `cactus-tv` 仓库。

### 2. 设置生产分支

填写：

```text
Project name: cactus-tv
Production branch: main
```

项目名称可以改，但下面示例统一使用 `cactus-tv`。

### 3. 填写构建设置

按下面填写：

```text
Framework preset: None
Build command: 留空
Build output directory: public
Root directory: /
```

不要填写 `npm run build`。

这个项目没有前端编译步骤。Cloudflare 会直接发布 `public`，同时识别仓库根目录下的 `functions`。

### 4. 第一次部署

点击 `Save and Deploy`。

第一次部署完成后会得到一个地址，例如：

```text
https://cactus-tv.pages.dev
```

此时首页可能能打开，但接口还不能正常使用，因为 D1 和管理密钥还没有配置。

---

## 五、创建 D1 数据库

在 Cloudflare Dashboard 中进入：

```text
D1 SQL database
→ Create Database
```

数据库名称填写：

```text
cactus-tv-db
```

位置可以使用默认设置。

点击创建。

---

## 六、初始化 D1

### 1. 打开 SQL Console

进入刚创建的 `cactus-tv-db`，打开：

```text
Console
```

### 2. 执行初始化 SQL

在项目里打开：

```text
migrations/0001_init.sql
```

复制文件中的全部内容，粘贴到 D1 Console，然后执行。

需要执行的 SQL 如下：

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  proxy_enabled INTEGER NOT NULL DEFAULT 0,
  media_hosts TEXT NOT NULL DEFAULT '[]',
  headers_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_health (
  provider_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subtitles (
  id TEXT PRIMARY KEY,
  item_key TEXT NOT NULL,
  name TEXT NOT NULL,
  lang TEXT NOT NULL DEFAULT 'zh',
  url TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'vtt',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subtitles_item ON subtitles(item_key);

INSERT INTO settings (key, value)
VALUES ('site_name', 'Cactus TV')
ON CONFLICT(key) DO NOTHING;

INSERT INTO settings (key, value)
VALUES ('home_notice', '')
ON CONFLICT(key) DO NOTHING;
```

执行成功后，数据库里应出现：

```text
settings
providers
provider_health
subtitles
```

重复执行这份 SQL 不会删除现有数据。

---

## 七、把 D1 绑定到 Pages

回到：

```text
Workers & Pages
→ cactus-tv
→ Settings
→ Bindings
```

点击添加 Binding，类型选择：

```text
D1 database
```

填写：

```text
Variable name: DB
D1 database: cactus-tv-db
```

`DB` 必须全部大写。代码读取的是 `env.DB`，写成 `db` 或其他名称都会导致接口报错。

如果 Cloudflare 分开显示 Production 和 Preview，请至少给 Production 添加 `DB`。需要测试预览分支时，再给 Preview 添加同一个或单独的 D1 数据库。

保存 Binding。

---

## 八、添加环境变量

进入 Pages 项目：

```text
Settings
→ Variables and Secrets
```

### 1. ADMIN_TOKEN

添加：

```text
Name: ADMIN_TOKEN
Value: 你自己设置的管理密钥
```

要求：

- 至少 8 个字符
- 不要使用常用密码
- 不要写进 GitHub 文件

示例格式：

```text
cactus-7f3d0b9a2e6c4f18
```

示例只能看格式，不要直接照抄。

建议把 `ADMIN_TOKEN` 保存为 Secret。

### 2. SITE_NAME

可选：

```text
Name: SITE_NAME
Value: Cactus TV
```

站点名称也可以部署后在后台修改。

### 3. TMDB_BEARER_TOKEN

可选：

```text
Name: TMDB_BEARER_TOKEN
Value: 你的 TMDB Read Access Token
```

不配置时仍可使用数据源搜索。首页分类、TMDB 海报和部分简介可能不会出现。

建议保存为 Secret。

### 4. DOUBAN_METADATA_URL

没有自己的元数据适配器时留空，不需要创建这个变量。

格式：

```text
Name: DOUBAN_METADATA_URL
Value: https://你的适配器地址
```

### 5. PROVIDERS_JSON

使用 D1 后通常不需要这个变量。

需要保留空值时可设置：

```text
Name: PROVIDERS_JSON
Value: []
```

后台添加的数据源会保存到 D1。

---

## 九、重新部署

添加 D1 Binding 或环境变量后，需要重新部署一次。

进入：

```text
Workers & Pages
→ cactus-tv
→ Deployments
```

找到最新一次部署，点击重新部署。不同版本的 Cloudflare Dashboard 中，按钮可能显示为：

```text
Retry deployment
Redeploy
Deploy version
```

也可以在 GitHub 仓库中修改一个文件并提交，Git 集成会自动触发新的部署。

确认新部署状态为成功后，再进行下面的检查。

---

## 十、检查部署

### 1. 检查首页

打开：

```text
https://你的项目.pages.dev/
```

页面应正常加载。

### 2. 检查接口

打开：

```text
https://你的项目.pages.dev/api/health
```

正常时会返回 JSON，主要字段应为：

```json
{
  "ok": true,
  "dbReady": true,
  "adminReady": true
}
```

只要 `dbReady` 和 `adminReady` 都是 `true`，D1 与管理密钥就已经生效。

### 3. 进入后台

打开：

```text
https://你的项目.pages.dev/admin.html
```

输入刚才设置的 `ADMIN_TOKEN`。

密钥只保存在当前标签页。关闭标签页后，下次进入需要重新输入。

---

## 十一、添加数据源

进入后台的“数据源”页面。

### 唯一 ID

例如：

```text
source-1
```

只能用于区分数据源。保存后不要随意修改。

### 显示名称

例如：

```text
线路一
```

### Apple CMS 接口地址

填写完整 JSON 接口地址，例如：

```text
https://example.com/api.php/provide/vod/
```

### 优先级

数字越大，搜索时越靠前。没有特别要求可以填 `0`。

### 媒体域名白名单

只在播放地址和接口地址不是同一个域名时填写。

正确：

```text
cdn.example.com, media.example.com
```

错误：

```text
https://cdn.example.com/video/
```

### 请求头 JSON

数据源不需要特殊请求头时填写：

```json
{}
```

需要 Referer 时可填写：

```json
{
  "Referer": "https://example.com/"
}
```

必须是合法 JSON，键名和值都要使用英文双引号。

### 播放代理

直连能播放时不要开启。

遇到跨域、分片地址或请求头限制时，可以打开“启用播放代理”，并把实际使用的媒体域名加入白名单。

保存后点击“测速”。

---

## 十二、更新网站

以后修改网站时，仍然使用原来的 GitHub → Cloudflare Pages 方式。

### GitHub 网页更新单个文件

1. 打开 GitHub 仓库。
2. 找到要替换的文件。
3. 点击右上角的编辑或上传入口。
4. 提交到 `main` 分支。
5. Cloudflare Pages 自动开始部署。

### 上传整套新版本

1. 先备份旧仓库。
2. 保留 Cloudflare Pages 项目和 D1 数据库。
3. 把新版本文件上传到同一个 GitHub 仓库根目录。
4. 提交后等待 Pages 自动部署。
5. 如果新版本带有新的迁移 SQL，再按版本说明执行对应迁移。

更新仓库不会自动删除 D1 中的数据源和设置。

不要重新创建 Pages 项目，否则需要重新配置 Binding 和环境变量。

---

## 十三、自定义域名

需要绑定自己的域名时，进入：

```text
Workers & Pages
→ cactus-tv
→ Custom domains
→ Set up a custom domain
```

输入域名并按 Cloudflare 提示确认。

域名接入后，前台和后台地址分别是：

```text
https://你的域名/
https://你的域名/admin.html
```

---

## 十四、常见问题

### 首页能打开，搜索时报 500

检查：

1. D1 是否绑定到当前 Pages 项目。
2. Binding 名称是否为大写 `DB`。
3. 是否执行了 `migrations/0001_init.sql`。
4. 添加 Binding 后是否重新部署。

### `/api/health` 中 `dbReady` 为 false

D1 没有绑定成功，或 Binding 名称不对。

删除错误 Binding，重新添加：

```text
Variable name: DB
```

然后重新部署。

### `/api/health` 中 `adminReady` 为 false

没有设置 `ADMIN_TOKEN`，或变量没有应用到 Production。

检查 Variables and Secrets，确认 `ADMIN_TOKEN` 至少 8 个字符，然后重新部署。

### 后台一直提示管理密钥错误

确认输入的是 Cloudflare 中当前生效的 `ADMIN_TOKEN`。

修改 Secret 后必须重新部署。旧部署不会自动读取新值。

### 首页没有电影分类

没有配置 `TMDB_BEARER_TOKEN`，或 Token 无效。

这不会影响数据源搜索。可以直接在首页搜索框输入片名。

### 搜索没有结果

检查：

1. 后台是否已经添加数据源。
2. 数据源是否启用。
3. 接口地址是否能返回 Apple CMS JSON。
4. 点击测速后是否显示错误。
5. 接口是否要求 Referer、Origin 或其他请求头。

### 视频直连不能播放

依次检查：

1. 播放地址是否已经失效。
2. 浏览器是否拦截跨域请求。
3. 数据源是否要求请求头。
4. 是否需要开启播放代理。
5. 视频、M3U8 分片、密钥和跳转后的域名是否都在白名单中。
6. 播放内容是否使用 DRM。

### 收藏和观看进度换设备后消失

收藏、历史和进度保存在当前浏览器。更换设备、浏览器或清理站点数据后不会保留。

### Cloudflare 部署成功，但 `/api/health` 返回 404

通常是仓库目录套了一层，导致 `functions` 没在仓库根目录。

GitHub 仓库首页必须直接看到：

```text
functions
public
package.json
```

整理目录后再次提交。

### 修改代码后网站没有变化

检查：

1. 修改是否提交到了 Pages 使用的生产分支。
2. Cloudflare Deployments 中是否出现新的部署。
3. 新部署是否成功。
4. 浏览器是否仍在使用旧缓存。

可以使用无痕窗口检查，或在页面刷新时清除缓存。

## D1 片单同步（0.6.3+）

收藏和继续观看记录会自动写入现有的 `DB` 绑定。接口首次运行时会自动创建 `favorites` 和 `watch_history` 表，因此从旧版本升级后只需正常推送代码并等待 Cloudflare Pages 部署完成，不需要重新创建 D1，也不需要添加用户表或用户 ID。

---

# v0.8.2 CactusStreamflow 全程 600 秒滚动缓存升级

从旧版升级到 v0.8.2 后，仍然只需要原来的 Pages + D1。CactusStreamflow 使用 Cache API，从开始播放就维持前方至少 600 秒的滚动预取，并保留暂停续批和播放器性能面板；仍不需要 R2、Queue 或独立 Worker。

完整说明：

```text
CACTUS_STREAMFLOW.md
```

升级步骤：

1. 在自己的 Fork 中同步或提交 v0.8.2 代码。
2. 删除仓库里的 `streamflow-worker/`。
3. 删除 `migrations/0003_streamflow.sql`。
4. 在 Pages Settings → Bindings 中删除 `STREAMFLOW_R2` 和 `STREAMFLOW_QUEUE`（如果以前添加过）。
5. 保留原来的 D1 `DB` 绑定。
6. 不需要创建 R2，不需要创建 Queue，不需要单独部署 Worker。
7. 重新部署 Pages，打开 `/api/health`，确认 `streamflowReady` 为 `true`、`streamflowEngine` 为 `cache-api`。

旧 R2 版留下的三张 D1 表不会影响运行，是否删除均可。
