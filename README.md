# Cactus TV v0.2.3

Cactus TV 运行在 Cloudflare Pages、Pages Functions 和 D1 上。

前台地址是 `/`，后台地址是 `/admin.html`。前台不要求登录，后台使用部署时设置的 `ADMIN_TOKEN`。

## 目录

```text
functions/                Pages Functions
migrations/0001_init.sql  D1 初始化脚本
public/                   前端文件
scripts/                  检查脚本
DEPLOY.md                 部署教程
package.json              本地命令
```

## 部署

本项目沿用以下方式：

```text
GitHub 仓库
→ Cloudflare Pages Git 集成
→ Pages Functions
→ D1 数据库
```

不需要修改构建方式，也不要把项目改成纯静态 Pages。

详细步骤见 [DEPLOY.md](./DEPLOY.md)。

## Cloudflare 配置

Pages 构建设置：

```text
Framework preset: None
Build command: 留空
Build output directory: public
Root directory: /
```

D1 Binding：

```text
Variable name: DB
```

必须设置：

```text
ADMIN_TOKEN=至少16个字符
```

可选设置：

```text
SITE_NAME=Cactus TV
TMDB_BEARER_TOKEN=
DOUBAN_METADATA_URL=
PROVIDERS_JSON=[]
```

## 本地检查

需要 Node.js 20 或更高版本。

```bash
npm ci
npm run check
```

本地运行：

```bash
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

## 数据保存位置

D1 保存：

- 站点设置
- 数据源配置
- 数据源测速记录
- 字幕地址

浏览器保存：

- 收藏
- 观看历史
- 播放进度
- 播放设置

浏览器数据不会自动同步到其他设备。

## 数据源

后台支持 Apple CMS JSON 接口。项目包内不包含数据源。

媒体域名白名单只填写域名，例如：

```text
cdn.example.com
media.example.com
```

不要填写 `https://`，也不要填写路径。

## 更新项目

修改文件后推送到已经连接的 GitHub 仓库。Cloudflare Pages 会使用原来的项目设置重新部署。

更新代码时不要删除：

- Pages 项目的 D1 Binding
- `ADMIN_TOKEN`
- 其他环境变量
- D1 数据库

只更新仓库代码不会清空 D1 数据。
