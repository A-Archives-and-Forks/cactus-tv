# Cactus TV v0.2.3 检查记录

## 接口

- 前台页面不要求登录。
- 后台接口读取 `ADMIN_TOKEN`。
- D1 Binding 名称为 `DB`。
- 数据源、设置、测速结果和字幕写入 D1。
- 收藏、历史和进度保存在浏览器。

## 播放代理

代理只处理已配置数据源允许的 HTTPS 媒体域名。

需要同时满足：

- 数据源已启用播放代理；
- 目标地址使用 HTTPS；
- 目标域名是接口域名或媒体白名单中的域名；
- 返回内容属于媒体、播放列表、字幕或二进制流。

## 检查命令

```bash
npm ci
npm run check
```

部署后：

```bash
BASE_URL=https://你的项目.pages.dev \
ADMIN_TOKEN=你的管理密钥 \
npm run smoke
```
