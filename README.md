# Cactus TV

当前版本：**v1.1.3**

> v1.1.3 Gesture Stability：修复音量手势实时调节、手势浮层残留和长按倍速提示遮挡；继续保留 Performance Core、深度缓冲、个性化推荐与可关闭的实验性 HLS 净流层。

Cactus TV 是一个部署在 Cloudflare Pages 上的私人影视检索与播放前端。它提供首页推荐、聚合搜索、片源切换、HLS 播放、观看记录、字幕和管理后台，但**项目本身不内置、不提供、也不推荐任何影视数据源**。

TG频道 https://t.me/CactusFreeTv

前台地址：`/`  
管理后台：`/admin.html`

> Cactus TV 的定位是播放器与片源管理界面，不是影视内容服务。部署完成后，需要由使用者自行配置合法、可用且已获授权的数据接口。

## 功能

### 前台

- 响应式影视首页，适配桌面、平板和手机
- 豆瓣或 TMDB 首页元数据
- 多数据源并发搜索与结果去重
- 同一影片的多片源切换
- 播放失败自动尝试同源备用线路与其他数据源，并保留当前进度
- 根据本机历史成功率自动调整备用片源顺序
- 电影、剧集和分集播放
- 上一集、下一集与播放结束自动续播
- 原生 HLS 与内置 hls.js 播放
- 收藏片单、观看历史和断点续播
- 首页分类入口、搜索结果类型/年份/片源筛选
- 搜索结果分批渲染，减少低性能设备首屏压力
- 首页继续观看与轻量个性化推荐，不增加额外网络请求
- 首页首屏不再等待 D1 片单同步和站点健康检查
- 详情、播放、分类、搜索、收藏和历史支持可刷新直达路由
- 在线字幕与本地 VTT/SRT 字幕
- 豆瓣海报代理、缓存与失败重试
- 播放错误、接口错误和空状态提示
- Cloudflare Cache API 搜索缓存与受控上游并发
- Cactus Player 2.0：深度本地缓冲、成熟触控手势、分级错误恢复与硬件解码压力自适应
- Cactus Performance Core：渐进首页、图片视口预加载、推荐多样性重排和非阻塞初始化
- Cactus Clean Stream：实验性过滤 HLS 中带明确广告标记、SCTE/CUE 信号或强广告 URL 特征的分片

### 管理后台

- 使用 `ADMIN_TOKEN` 保护后台接口
- 添加、编辑、启用、停用和删除数据源
- 设置数据源优先级
- 数据源测速与状态记录
- 配置媒体域名白名单
- 按数据源启用受控播放代理
- 设置站点名称、首页公告和元数据来源
- 为指定影片添加或删除在线字幕

### 数据保存

D1 数据库保存：

- 站点设置
- 数据源配置
- 数据源测速结果
- 在线字幕

- 收藏片单
- 观看历史
- 播放进度
- 播放偏好

## 项目特色

### 轻量部署

前端由 Cloudflare Pages 托管，API 使用 Pages Functions，配置数据使用 D1。播放器按需加载，首页不会提前解析播放引擎。

部署方式保持开源项目常见流程：

```text
Fork GitHub 项目
        ↓
Cloudflare Pages 连接仓库
        ↓
自动部署
        ↓
后台配置数据源
```

不需要下载 ZIP、手动解压、上传文件。

### 数据源与播放器分离

项目不绑定固定片源。兼容的 Apple CMS JSON 接口由部署者在后台自行配置，后续可以独立添加、停用或更换。

### 受控播放代理

播放代理不是开放代理。代理请求必须同时满足：

- 数据源已启用播放代理
- 目标地址使用 HTTPS
- 目标域名是数据源接口域名或已配置的媒体白名单域名
- 返回内容属于视频、音频、播放列表、字幕或允许的二进制媒体类型

HLS 播放列表中的分片和密钥地址会按相同规则重写并再次校验。

### 不写死海报

首页和详情页海报来自所选元数据服务或数据源。豆瓣图片会经过代理、候选域名重试和缓存处理，但不会在代码中为某部影片写死固定海报。

## 技术结构

```text
cactus-tv/
├─ functions/                 Cloudflare Pages Functions
│  ├─ api/                    前台与后台 API
│  └─ _shared/                鉴权、数据库、元数据和数据源工具
├─ migrations/                D1 初始化与升级脚本
├─ public/                    静态前端文件
├─ scripts/                   本地预检与部署烟雾测试
├─ .dev.vars.example          本地环境变量示例
├─ wrangler.toml.example      本地 Wrangler 配置示例
├─ package.json
└─ README.md
```


## Cactus Player 2.0

本版不使用主动边缘预取。性能预算全部交给播放器本体、设备本地缓冲和播放恢复。

### 播放内核

- HLS：hls.js 1.6.13，启用 Web Worker、渐进加载、快速/慢速带宽双窗口估算、真实码率修正和 FPS 降级保护；
- DASH：dash.js 5.2.0，启用自动码率、快速清晰度切换与长缓冲；
- Safari / iOS：可继续优先使用系统原生 HLS；
- MP4 和普通媒体：使用浏览器原生 video。

### 深度本地缓冲

- 手机和平板目标约 200 秒，弹性上限约 300 秒；
- 桌面目标约 300 秒，弹性上限约 450 秒；
- 极弱设备、省流量或 2G 环境保留约 90 秒安全目标；
- DASH 使用相同的目标缓冲；
- 浏览器或片源可能因内存、码率和实现限制提前停止，不保证所有设备都精确达到目标秒数。

### 手势引擎

- 单击显示或隐藏控制栏，2.8 秒后自动隐藏；
- 左/右区域连续双击可累计快退或快进 10、20、30 秒；
- 左侧垂直滑动调亮度，右侧垂直滑动调音量；
- 横向滑动采用非线性速度曲线，短视频精细、长视频可快速跨越较长区间；
- 长按临时 2 倍速，松手恢复原速度；
- 16px 防抖阈值与方向锁，轻微手抖不会误触；
- 手势更新合并到 requestAnimationFrame，减少重绘。

### 分级恢复

发生卡顿时依次尝试：

1. 紧急降低一个自动码率等级；
2. 从当前时间附近重新加载；
3. 轻微越过缓冲孔；
4. 恢复媒体解码器；
5. 仍失败时保留进度切换备用线路。

### Cactus Clean Stream（实验性）

设置页可开启或关闭。该功能仅对经过 `/api/stream` 的 HLS 线路生效，采用保守规则：

- 识别 `EXT-X-CUE-OUT / CUE-IN`、SCTE35 和 HLS interstitial 标记；
- 识别分片 URL 或标题中明确的 `ads / advert / commercial / promo / casino / betting / 博彩` 等特征；
- 命中过多、清单过短或存在隐式 AES-128 IV 时自动放弃过滤，优先保证正常播放；
- 不使用纯时长猜测，不会为了去广告大规模删除不确定分片。

它不能识别已经烧录进正片画面的广告，也不能保证适配所有片源。若某条线路出现进度异常，可在设置中关闭。

媒体白名单支持安全通配符，例如：

```text
*.maowushi.com
*.examplecdn.net
```

`*.com`、`*.net` 这类过宽规则不会被接受为有效匹配。


## 部署教程

### 一、准备账号

需要：

- GitHub 账号
- Cloudflare 账号

本教程使用：

```text
GitHub 仓库
→ Cloudflare Pages Git 集成
→ Pages Functions
→ D1 数据库
```

不要只把 `public` 文件夹拖进 Cloudflare Pages。Cloudflare 控制台的静态文件拖拽上传不会部署本项目的 `functions` 目录，因此前台可能能打开，但搜索、后台和播放代理都无法工作。

### 二、Fork GitHub

推荐方式：直接 Fork 项目，不需要下载 ZIP。

1. 打开项目主页。
2. 点击右上角 `Fork`。
3. 在自己的仓库中继续维护。

Fork 后，仓库根目录应直接包含：

```text
functions/
migrations/
public/
scripts/
package.json
README.md
```

不要额外套一层项目文件夹。

### 三、创建 Cloudflare Pages 项目

在 Cloudflare Dashboard 中进入 `Workers & Pages`，创建 Pages 项目并连接刚才的 GitHub 仓库。界面名称可能随 Cloudflare 更新略有变化。

构建设置填写：

```text
Framework preset: None
Build command: exit 0
Build output directory: public
Root directory: /
```

说明：

- 项目没有前端构建步骤。
- `exit 0` 明确告诉 Cloudflare 构建成功，同时保留 Pages Functions 支持。
- 输出目录必须是 `public`。
- `functions` 必须位于仓库根目录。

保存并完成第一次部署。此时会得到类似下面的地址：

```text
https://你的项目.pages.dev
```

第一次部署后首页可能可以打开，但在完成 D1 和环境变量配置前，后台功能尚未就绪。

### 五、创建并初始化 D1

在 Cloudflare Dashboard 中创建 D1 数据库，名称可填写：

```text
cactus-tv-db
```

创建完成后进入数据库的 SQL Console，打开项目中的：

```text
migrations/0001_init.sql
```

复制全部 SQL，粘贴到 Console 并执行。

初始化成功后应存在四张表：

```text
settings
providers
provider_health
subtitles
```

### 六、绑定 D1

回到 Cactus TV 的 Pages 项目，进入项目设置中的 Bindings，添加 D1 database binding：

```text
Variable name: DB
D1 database: cactus-tv-db
```

变量名必须是大写的 `DB`，不能改成其他名称。

若 Cloudflare 分别显示 Production 和 Preview 环境，请至少为 Production 配置；需要预览分支正常工作时，也为 Preview 配置同样的绑定。

### 七、设置环境变量

进入 Pages 项目的 Variables and Secrets。

#### 必填

```text
ADMIN_TOKEN=至少16个字符的随机管理密钥
```

建议使用较长、不可猜测的随机字符串，并作为 Secret 保存。该密钥用于进入 `/admin.html` 和调用后台 API。

#### 可选

```text
SITE_NAME=Cactus TV
TMDB_BEARER_TOKEN=
DOUBAN_METADATA_URL=
PROVIDERS_JSON=[]
```

变量说明：

| 变量 | 作用 |
|---|---|
| `SITE_NAME` | D1 尚未保存站点名时使用的默认名称 |
| `TMDB_BEARER_TOKEN` | 启用 TMDB 元数据、海报和背景图 |
| `DOUBAN_METADATA_URL` | 可选的自定义豆瓣兼容元数据接口 |
| `PROVIDERS_JSON` | 高级用法：通过环境变量提供数据源配置 |

通常不需要设置 `PROVIDERS_JSON`，直接在管理后台添加数据源更方便。

添加或修改 Binding、变量、Secret 后，重新部署一次最新提交，确保生产部署加载新配置。

### 八、进入管理后台

打开：

```text
https://你的项目.pages.dev/admin.html
```

输入刚才设置的 `ADMIN_TOKEN`。

管理密钥只保存在当前标签页的 `sessionStorage` 中。关闭标签页后需要重新输入，也可以在后台点击“清除管理密钥”。

### 九、添加数据源

后台目前支持 Apple CMS JSON 接口。

示例接口格式：

```text
https://example.com/api.php/provide/vod/
```

填写：

```text
唯一 ID: source-1
显示名称: 数据源名称
接口地址: HTTPS Apple CMS JSON 地址
优先级: 数字越大排序越靠前
```

媒体域名白名单只填写域名：

```text
cdn.example.com
media.example.com
```

不要填写：

```text
https://cdn.example.com/path/
```

只有在源站存在浏览器 CORS、Referer 或跨域播放问题时，才需要启用播放代理。启用后，应把实际承载 m3u8、视频分片、密钥或字幕的域名加入白名单。

### 十、部署检查

访问：

```text
/api/health
```

正常情况下应看到：

```json
{
  "ok": true,
  "dbBound": true,
  "dbReady": true,
  "adminReady": true
}
```

其中：

- `dbBound` 表示 Pages 项目已经绑定 D1。
- `dbReady` 表示 D1 已完成建表初始化。
- `adminReady` 表示 `ADMIN_TOKEN` 已配置且长度合格。

也可以在本地运行部署烟雾测试：

```bash
BASE_URL=https://你的项目.pages.dev \
ADMIN_TOKEN=你的管理密钥 \
npm run smoke
```

## 本地开发

需要 Node.js 20 或更高版本。

安装依赖并运行完整检查：

```bash
npm ci
npm run check
```

准备本地配置：

```bash
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
```

Windows PowerShell：

```powershell
Copy-Item wrangler.toml.example wrangler.toml
Copy-Item .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，把 `ADMIN_TOKEN` 改为至少 16 个字符。

初始化本地 D1：

```bash
npm run db:local
```

启动本地开发服务器：

```bash
npm run dev
```

Wrangler 会在终端显示本地访问地址。

## 更新项目

通过 GitHub 集成部署时，只需把新文件提交到原仓库，Cloudflare Pages 会自动生成新部署。

更新时不要删除：

- Pages 项目的 D1 Binding
- `ADMIN_TOKEN` 和其他环境变量
- 已创建的 D1 数据库
- D1 中现有的数据源和字幕配置

仓库代码更新不会自动清空 D1。

本项目的 JS 和 CSS 使用浏览器重新验证缓存，避免同名文件更新后仍长期加载旧版本；第三方版本化文件仍可使用长缓存。

## 常见问题

### 首页能打开，但搜索和后台都报错

通常是只部署了 `public`，没有部署 Pages Functions。请使用 Git 集成，确认 `functions` 位于仓库根目录。

### `/api/health` 显示 `dbBound: false`

Pages 项目没有绑定 D1，或 Binding 名称不是 `DB`。

### `dbBound: true`，但 `dbReady: false`

D1 已绑定，但没有执行 `migrations/0001_init.sql`，或绑定了错误的数据库。

### 后台提示管理密钥无效

检查生产环境的 `ADMIN_TOKEN` 是否和输入内容完全一致。修改 Secret 后需要重新部署。

### 搜索没有结果

检查：

- 是否已添加并启用数据源
- 接口是否兼容 Apple CMS JSON
- 接口地址是否使用 HTTPS
- 后台测速是否正常
- 数据源是否限制请求头、地区或访问频率

### 能搜索但不能播放

优先检查浏览器控制台和播放错误提示。常见原因：

- 媒体地址已经失效
- 目标站禁止跨域播放
- 媒体域名没有加入白名单
- 数据源需要 Referer 或 Origin 请求头
- m3u8 内部引用了其他未加入白名单的域名
- 上游使用 HTTP，浏览器或代理要求 HTTPS

### 海报偶尔显示占位图

海报来自元数据服务或数据源，上游图片失效、限流或临时不可达时会触发重试和占位图。项目不会把某部影片的海报固定写进代码，因此上游海报变化后仍会按新地址获取。

## 安全建议

- 使用至少 8 个字符的密码 `ADMIN_TOKEN`
- 不要把 `.dev.vars`、真实 `wrangler.toml` 或管理密钥提交到 GitHub
- GitHub 仓库建议设为 Private
- 只配置可信、合法的数据接口
- 播放代理白名单只加入必要的媒体域名
- 不要把 Cactus TV 当作通用公开代理
- 定期检查数据源和字幕地址

## 声明

Cactus TV 仅提供网页播放器、影视信息展示、接口管理和个人观看记录功能。

本项目：

- 不提供、内置、维护、销售或推荐任何影视片源、解析接口或账号
- 不托管、不存储、不上传、不转码、不分发任何影视内容
- 不对第三方接口返回内容的合法性、版权状态、可用性、安全性或准确性作出保证
- 不提供绕过 DRM、付费限制、访问控制或版权保护的功能

部署者和使用者应仅接入自己有权使用或已获得合法授权的数据源，并自行遵守所在地区的法律法规、内容许可和第三方服务条款。因自行配置第三方接口或播放第三方内容产生的责任，由相应接口提供者、部署者和使用者承担。

Cactus TV 与 Cloudflare、TMDB、豆瓣及任何影视平台不存在隶属、授权或合作关系。第三方名称和商标归其各自权利人所有。

## 许可与第三方组件

项目许可见 [LICENSE](./LICENSE)。

第三方组件和许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 参考文档

- [Cloudflare Pages Git integration](https://developers.cloudflare.com/pages/get-started/git-integration/)
- [Cloudflare Pages Functions](https://developers.cloudflare.com/pages/functions/)
- [Pages Functions D1 bindings](https://developers.cloudflare.com/pages/functions/bindings/)
- [Cloudflare Pages custom headers](https://developers.cloudflare.com/pages/configuration/headers/)

### 收藏与观看记录

收藏、继续观看进度和当前集数会保存在绑定的 D1 数据库中。Cactus TV 按私人影院设计，不创建用户账号或用户标识；同一个部署下的手机、平板和电视共用一份片单。浏览器本地仅保留缓存，首次升级会自动把旧版浏览器中的收藏和观看记录迁移到 D1。
