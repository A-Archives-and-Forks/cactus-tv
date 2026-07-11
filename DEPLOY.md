# Cactus TV v1.1.0 部署教程

推荐部署方式：

```text
Fork GitHub 仓库
        ↓
Cloudflare Pages 连接自己的 Fork
        ↓
绑定 D1 并设置 ADMIN_TOKEN
        ↓
自动部署
```

不需要下载 ZIP、解压后手动上传。也不要只上传 `public` 文件夹，否则 `functions` 不会部署，搜索、后台、详情和播放代理都无法工作。

## 一、Fork 项目

1. 打开 Cactus TV 的 GitHub 项目主页。
2. 点击右上角 **Fork**。
3. 选择自己的 GitHub 账号。
4. 等待 Fork 完成。

Fork 后，仓库根目录应直接包含：

```text
functions/
migrations/
public/
scripts/
package.json
README.md
```

## 二、创建 Cloudflare Pages 项目

进入 Cloudflare：

```text
Workers & Pages
→ Create application
→ Pages
→ Connect to Git
```

选择刚刚 Fork 的仓库。

构建设置：

```text
Framework preset: None
Build command: exit 0
Build output directory: public
Root directory: /
Production branch: main
```

点击部署。第一次部署时首页可能可以打开，但在完成 D1 和密钥配置前，后台与数据接口不会完整工作。

## 三、创建 D1 数据库

进入：

```text
Storage & Databases
→ D1 SQL Database
→ Create database
```

建议名称：

```text
cactus-tv-db
```

创建后打开数据库的 **Console**。

先执行：

```text
migrations/0001_init.sql
```

再执行：

```text
migrations/0002_library.sql
```

复制两个文件中的 SQL 到 D1 Console，依次执行即可。`CREATE TABLE IF NOT EXISTS` 不会清空现有数据。

## 四、绑定 D1

进入：

```text
Workers & Pages
→ 你的 Cactus TV Pages 项目
→ Settings
→ Bindings
```

新增 D1 绑定：

```text
Variable name: DB
Database: cactus-tv-db（或你的实际数据库）
```

变量名必须是大写的 `DB`。

## 五、设置管理密钥

进入 Pages 项目：

```text
Settings
→ Variables and Secrets
```

新增加密变量：

```text
ADMIN_TOKEN=你自己的管理密码
```

建议使用较长、不可猜测的密码。项目代码要求至少 8 个字符。

可选变量：

```text
SITE_NAME=Cactus TV
TMDB_BEARER_TOKEN=你的 TMDB Token
PROVIDERS_JSON=可选的静态数据源 JSON
```

没有 TMDB Token 时，可以继续使用项目支持的其他元数据配置。

## 六、重新部署

绑定和环境变量修改后，进入：

```text
Deployments
→ 最新部署
→ Retry deployment
```

也可以在 GitHub 提交一次修改，让 Pages 自动重新部署。

部署完成后打开：

```text
https://你的域名/api/health
```

至少应看到：

```json
{
  "ok": true,
  "dbReady": true,
  "adminReady": true,
  "playerEngine": "cactus-player-2"
}
```

## 七、配置数据源

打开：

```text
https://你的域名/admin.html
```

输入 `ADMIN_TOKEN`，添加兼容的数据接口。

播放代理是可选功能：

- 未开启代理时，播放器直接访问媒体地址；
- 开启代理后，只有接口域名或媒体白名单内的 HTTPS 域名可以通过 `/api/stream`；
- `Cactus Clean Stream` 只对经过代理的 HLS 播放列表生效；
- 某些 CDN 会绑定 IP、Referer 或 Cookie，不兼容 Cloudflare 回源。遇到首分片超时，应关闭该线路代理或移除对应白名单规则，优先恢复直连播放。

媒体白名单支持：

```text
vod.example.com
*.examplecdn.com
```

不要使用 `*`、`*.com`、`*.net` 等过宽规则。

## 八、更新项目

以后更新时，不需要重建 Pages、D1 或环境变量。

常见方式：

1. 在 GitHub 打开自己的 Fork；
2. 使用 **Sync fork** 同步上游；
3. Cloudflare Pages 自动部署新提交。

涉及数据库迁移的版本，才需要额外执行新 migration 文件。

## 九、v1.1.0 播放器说明

Cactus Player 2.0 使用：

```text
原生 video
+ hls.js
+ dash.js
+ 自研手势与恢复状态机
```

本版已彻底移除主动 Streamflow 预取，不需要 R2、Queue 或额外 Worker。手机和平板的 HLS.js 目标前向缓冲约 200 秒，桌面和宽屏设备约 300 秒；实际缓冲仍受码率、浏览器内存与片源速度限制。

实验性的 `Cactus Clean Stream` 默认开启，可以在播放设置中关闭。它只根据明确的 HLS 广告标记和强广告特征进行保守过滤，异常时会回退原始清单，不能保证识别所有广告。

## 十、常见问题

### 首页能打开，但搜索或后台报错

通常是 `functions` 没有部署，或只上传了 `public`。确认 Pages 是连接完整 GitHub 仓库，输出目录为 `public`。

### `/api/health` 显示 `dbReady: false`

检查 Pages 的 D1 Binding 名称是否为 `DB`，并在保存后重新部署。

### `/admin.html` 无法进入

检查 `ADMIN_TOKEN` 是否已配置、是否至少 8 个字符，并重新部署。

### 视频直连能播，开启代理后超时

说明该 CDN 不接受 Cloudflare 回源。关闭该数据源的播放代理，或移除该媒体域名白名单。播放器性能优化不依赖代理。

### 缓冲没有达到 200/300 秒

目标值是 HLS.js 的缓冲策略，不是强制下载量。高码率、浏览器内存限制、原生 HLS 或片源速度不足时，实际缓冲可能更短。
