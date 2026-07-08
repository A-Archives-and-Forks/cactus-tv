# Cactus TV

Cactus TV 是一个运行在 Cloudflare Pages 上的私人媒体首页和网页播放器。当前版本：**v0.5.0**。

它可以连接你自己的 **Jellyfin / Emby**，也保留了兼容影视接口的搜索与播放功能。项目不附带媒体文件、服务器账号或可用片源。

## 能做什么

- 连接多个 Jellyfin、Emby 服务器
- 浏览媒体库、继续观看和最近加入
- 搜索电影、剧集和单集
- 展示海报、简介、演员、季和分集
- 原画直连；浏览器不兼容时自动尝试 HLS 转码
- 读取服务器字幕，并支持本地 VTT / SRT 字幕
- 将播放开始、暂停、进度和停止状态同步回媒体服务器
- 多来源搜索、线路切换、失败自动换源
- 自动下一集、断点续播、收藏和本机观看记录
- 手机、平板和桌面端自适应

目前不支持音乐、照片、Live TV、Emby Connect 和局域网自动发现。

## 连接 Jellyfin

Cactus TV 部署在 Cloudflare，不能直接访问 `192.168.x.x`、`localhost` 或只在家庭局域网里开放的地址。Jellyfin 需要先有一个公网可访问的 HTTPS 地址，例如：

```text
https://jellyfin.example.com
https://example.com/jellyfin
```

推荐给 Cactus TV 单独创建一个普通用户，只开放需要观看的媒体库，不要使用管理员账号。

连接步骤：

1. 确认这个 HTTPS 地址在外网可以正常打开 Jellyfin。
2. 打开 Cactus TV，进入右上角“设置”。
3. 在“Jellyfin / Emby”中点击“添加”。
4. 类型选择 `Jellyfin`。
5. 填写服务器地址、用户名和密码。
6. 点击“连接并保存”，然后进入顶部“媒体库”。

密码只用于向你的 Jellyfin 请求登录令牌，不会保存到浏览器；登录后保存的是访问令牌、用户 ID 和服务器地址。

### 使用访问令牌

账号密码登录最省事。需要使用令牌时，切换到“访问令牌”，填写：

- Jellyfin API key 或用户访问令牌
- 对应的用户 ID

API key 可在 Jellyfin 管理后台的 API Keys 页面创建。由于 Cactus TV 需要读取某个用户的媒体库和观看进度，所以仅有 API key 还不够，还要填写用户 ID。

## 连接 Emby

Emby 同样需要公网 HTTPS 地址，例如：

```text
https://emby.example.com
https://example.com/emby
```

连接方法与 Jellyfin 相同：

1. 在 Emby 中创建一个用于观看的普通用户，并允许该用户远程访问。
2. 在 Cactus TV 的“设置”中添加媒体库。
3. 类型选择 `Emby`，填写地址和账号密码。
4. 保存后进入“媒体库”。

Emby 的 API 通常位于服务器地址下的 `/emby`。填写 `https://emby.example.com` 即可，Cactus TV 会自动处理；如果你的反向代理本身已经使用 `/emby` 路径，也可以直接填写完整地址。

需要令牌登录时，可在 Emby Server Dashboard 的 `Advanced → Security` 中创建 API key，再和用户 ID 一起填写。

## 播放方式

Cactus TV 会先读取媒体服务器返回的播放信息：

- 浏览器可以直接播放 MP4 / WebM 等格式时，优先使用原画直连。
- 容器、视频编码、音频编码或字幕不兼容时，尝试由 Jellyfin / Emby 转为 HLS。
- 原画失败时会继续尝试转码线路，切换时保留当前进度。

是否发生转码取决于文件格式、浏览器能力和服务器设置。4K、高码率视频或烧录字幕可能明显增加媒体服务器负载。

## 媒体服务器的网络要求

连接 Jellyfin / Emby 时，需要满足下面几项：

- 地址必须是 `https://`
- 域名必须能从公网访问
- 证书必须受浏览器信任，不支持自签名证书
- 反向代理需要完整转发 Jellyfin / Emby API、视频和字幕请求
- 媒体服务器用户需要允许远程访问

Cactus TV 不要求新增 D1、KV、R2 或 Cloudflare 环境变量。媒体连接保存在当前浏览器；临时播放会话由 Pages Functions 处理。

如果只想在家里使用，又不想把 Jellyfin / Emby 直接暴露到公网，建议在自己的反向代理或 VPN 网关上提供一个受保护的 HTTPS 入口。Cloudflare Pages 本身无法进入你的家庭局域网。

## 部署

### 只使用 Jellyfin / Emby

这种用法不需要数据库。

1. 把项目上传到 GitHub 仓库。
2. 在 Cloudflare `Workers & Pages` 中创建 Pages 项目并连接仓库。
3. 构建设置填写：

```text
Framework preset: None
Build command: exit 0
Build output directory: public
Root directory: /
```

4. 完成部署后打开 Pages 地址，在站内“设置”里连接媒体服务器。

仓库根目录必须直接包含：

```text
functions/
public/
package.json
```

不要只上传 `public`，否则 Pages Functions 不会部署，媒体库、搜索和播放都无法工作。

### 使用兼容接口和管理后台

需要后台管理数据源时，再配置 D1：

1. 在 Cloudflare 创建 D1 数据库。
2. 在 D1 SQL Console 执行 `migrations/0001_init.sql`。
3. 给 Pages 项目添加 D1 Binding：

```text
Variable name: DB
```

4. 添加 Secret：

```text
ADMIN_TOKEN=至少16个字符的随机字符串
```

5. 重新部署后访问：

```text
https://你的域名/admin.html
```

可选变量：

```text
SITE_NAME=Cactus TV
TMDB_BEARER_TOKEN=
DOUBAN_METADATA_URL=
PROVIDERS_JSON=[]
```

## 本地运行

需要 Node.js 20 或更高版本。

```bash
npm ci
npm run check
npm run dev
```

需要本地调试 D1 时：

```bash
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev
```

## 数据保存在哪里

保存在浏览器本地：

- Jellyfin / Emby 地址、访问令牌和用户 ID
- 收藏、历史和 Cactus TV 播放偏好

同步回 Jellyfin / Emby：

- 播放开始
- 播放进度
- 暂停和停止状态

保存在 D1（启用管理后台时）：

- 站点设置
- 兼容接口配置
- 接口状态
- 在线字幕配置

不要在公共电脑上保存媒体服务器连接。删除连接会清除 Cactus TV 当前浏览器中的服务器令牌，但不会删除媒体服务器中的账号或 API key。

## 常见问题

### 提示只能连接公网 HTTPS

这是正常限制。Cloudflare Pages Functions 无法访问你家里的 `192.168.x.x:8096`。请先为媒体服务器配置公网域名和可信 HTTPS 证书。

### 能看到海报，但播放失败

先在 Jellyfin / Emby 官方网页中播放同一文件，然后检查：

- 用户是否允许远程播放
- 反向代理是否限制大文件、Range 请求或长连接
- 服务器是否允许转码
- FFmpeg 是否工作正常
- 磁盘是否有转码临时空间
- 外网上行带宽是否足够

### 一播放就开始转码

通常是浏览器不支持文件的容器、视频编码、音频编码或字幕格式。H.264 + AAC 的 MP4 最容易直放；其他格式可能需要服务器转码。

### 观看进度没有回到服务器

确认使用的是普通用户登录令牌，而不是权限不足的 API key；同时检查该用户能否在 Jellyfin / Emby 官方客户端中正常记录进度。

### 登录一段时间后失效

媒体服务器可能撤销了令牌，或者临时 Pages 会话已过期。打开“设置”，点击对应服务器的“测试”；仍然失败时重新填写账号密码连接。

## 安全建议

- 为 Cactus TV 创建单独的普通用户
- 只授予需要的媒体库权限
- 不要给该用户媒体删除和服务器管理权限
- 使用可信 HTTPS 证书
- 定期撤销不再使用的令牌或 API key
- 不要把真实令牌、密码、`.dev.vars` 提交到仓库
- 私人部署建议使用私有 GitHub 仓库，并给 Cactus TV 本身增加访问控制

## 说明

Cactus TV 只提供媒体展示、搜索和播放界面，不包含媒体文件、可用片源、Jellyfin / Emby 账号，也不绕过 DRM、付费或访问控制。

请只连接自己管理或获准使用的媒体库和接口。第三方名称及商标归各自权利人所有；Cactus TV 与 Jellyfin、Emby、Cloudflare、TMDB、豆瓣不存在隶属或授权关系。

## License

项目许可见 [LICENSE](./LICENSE)，第三方组件见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
