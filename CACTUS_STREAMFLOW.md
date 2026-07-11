# CactusStreamflow 仙人掌流式缓存

CactusStreamflow v0.8.2 使用 **Cloudflare Cache API**。它不需要 R2、Queue、信用卡或额外 Worker，只依赖原来的 Cloudflare Pages、Pages Functions 和 D1。

## 工作原理

HLS 播放列表和分片经过 `/api/stream`：

```text
播放器请求分片
  ↓
Pages Function 查询当前 Cloudflare 数据中心的 Cache API
  ├─ HIT：直接从边缘缓存返回
  └─ MISS：访问片源，返回给播放器，同时写入边缘缓存
```

播放器识别到 HLS 和有效时长后，Streamflow 立即开始主动预取：

```text
当前位置
  ↓
目标至少向后 600 秒
  ↓
每次只取一小批 HLS 对象
  ↓
记录 cachedThrough 缓存游标
  ↓
下一批从游标继续
```

目标终点采用：

```text
max（当前位置 + 600 秒，当前位置 + 剩余时长的一半）
```

但不会超过片尾。若距离片尾不足 600 秒，就缓存到片尾。

## 为什么不再只看到约 30 秒

v0.8.0 每次只处理少量对象，而且重复从目标窗口开头扫描。前面的分片已经命中后，后续批次仍把大量额度消耗在旧分片上，因此实际向后推进很有限。

v0.8.1 增加缓存游标，v0.8.2 移除三分之一触发门槛：

- 从视频开头或当前恢复进度就开始建立前方缓存，不再等待观看到三分之一。
- 每批记录已经连续覆盖到哪一秒。
- 下一批直接从该秒数之后继续。
- 播放中约每 10 秒触发一批。
- 暂停后每 7 秒触发一批。
- 达到目标窗口后自动停止暂停定时器。
- 同一批仍在执行时，20 秒内不会启动重叠批次。

## 性能面板

播放器左上角会显示：

```text
CactusStreamflow · 流式预取中
286 / 600 秒 · 新增 47 · 复用 13 · 播放命中 8/11（73%）
```

含义：

- `286 / 600 秒`：当前位置之后已经连续缓存 286 秒，本轮目标为 600 秒。
- `新增`：Cloudflare 主动从片源拉取并新写入 Cache API 的对象数量。
- `复用`：预取时发现已经存在于边缘缓存中的对象数量。
- `播放命中`：hls.js 实际播放分片收到 `x-cactus-streamflow: HIT` 的数量和比例。

Safari/iOS 等使用原生 HLS 时，浏览器不会把每个分片响应头暴露给页面，因此只能显示预取覆盖和新增/复用统计，`播放命中`会显示为 `—`。

## 单批限制

Cloudflare Workers Free 每次请求的 Cache API 调用和子请求共享 50 次额度。v0.8.2 每批最多处理 9 个 HLS 对象，并把播放列表、状态读写和可能的重定向留在预算内。

一批通常能推进几十秒。600 秒不是一次请求全部完成，而是由多批连续推进；片源速度、分片长度、重定向和加密依赖都会影响完成时间。

## 支持范围

支持：

- HLS 点播 m3u8
- 主清单和多清晰度子清单
- TS、M4S / fMP4
- `EXT-X-MAP`
- AES-128 密钥
- HLS Byte Range
- 没有 `.m3u8` 后缀但内容实际为 HLS 的地址

不主动预取：

- 普通 MP4
- DASH / MPD
- 直播 HLS
- DRM 视频
- 没有启用播放代理的数据源

## 真实限制

Cache API 不是 R2：

- 缓存只存在于处理请求的 Cloudflare 数据中心。
- 换网络、换地区或调度到其他节点时可能 MISS。
- Cloudflare 可以提前淘汰对象，7 天 TTL 不是永久保存承诺。
- 页面彻底退出后，不能保证继续长时间预取；`waitUntil()`只负责完成已经提交的当前批次。
- “重置边缘缓存”通过更换缓存代数实现，旧对象不再读取，之后由 Cloudflare 自动淘汰。

## 部署

v0.8.2 不新增 Cloudflare 资源。新用户按以下方式部署：

```text
Fork GitHub 项目
  ↓
Cloudflare Pages 连接自己的 Fork
  ↓
保留 D1 绑定 DB
  ↓
自动部署
```

不需要下载 ZIP、手动解压或上传文件，也不需要：

```text
R2
Queue
独立 Worker
STREAMFLOW_R2
STREAMFLOW_QUEUE
0003_streamflow.sql
```

已有 Cactus TV 用户只需要同步 v0.8.2 代码，Cloudflare 端无需新增配置。

## 检查

访问：

```text
https://你的域名/api/health
```

应包含：

```json
{
  "streamflowReady": true,
  "streamflowEngine": "cache-api"
}
```

视频时长识别完成后，播放器性能面板应直接进入“准备预取”或“流式预取中”，不再出现“等待 33%”。同一地区再次播放已缓存分片时，响应头为：

```text
x-cactus-streamflow: HIT
```
