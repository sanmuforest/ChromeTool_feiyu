# FP-004 buondua 多页相册站点适配（开发完成，待实测）

## 需求

适配 buondua.com 这类「多页面相册」网站（相册由多个子页面构成，`?page=1..N` 分页）。
三个子选项卡：

1. **抓取**：输入相册 URL → 读取全部子页面 → 抓取全部子页图片 → 去重 → 展示（复用共享抓取视图：筛选/去重/选择/预览/下载）
2. **批量抓取推荐链接**：解析页面 `bottom-articles` 区块的推荐相册链接（item-link）→ 列表勾选 → 批量抓取，每个相册独立展示 + 独立文件夹
3. **批量抓取其他链接**：解析页面 `popular-item` 区块的其他相册链接 → 同上

「下一批」按钮：链接列表按批展示（10 个/批），抓完一批可点「下一批」继续。

## 页面结构（实测 2026-08-10）

- 相册页 URL：`/coser-{名}-{N}-photos-{hash}-{ID}`，分页 `?page=1..N`
- 标题：`<h1>Coser@年年Nnian: 晨 (80 photos)  - ( Page 1 / 4 )</h1>` → 相册名、总张数、页数
- 当前相册图片：`<div class="article-fulltext">` 内 `<p><img src="https://i2.buondua.com/{year}/{ID}/xxx-{NNN}.jpeg?{签名}" width height>`，每页 20 张
- 分页链接：`<a class="pagination-link" href="...?page=N">`
- 推荐链接：`<div class="bottom-articles">` 内 `items-row` 卡片，`<a class="item-link" href="/coser-...">` + 封面 img
- 其他链接：`<div class="popular-item column ...">` 内 `<a class="popunder" href="/xxx">` + `<a class="item-title">` 标题 + 封面 img

## 数据通道

- 全部后台 fetch（公开页面，无登录墙；实测直连可抓，无需 Referer）
- 图片可直接 `chrome.downloads.download`（实测 200 OK）

## 文件夹命名

`ID-buondua-{相册名}-{时间戳}`（跨插件下载协作规范，ID- 前缀）

## 消息协议

| type | 发起方 | 处理方 | 说明 |
|------|--------|--------|------|
| `BD_FETCH_ALBUM` | grabber | background | 单相册全子页抓取（tab 1） |
| `BD_SCAN_LINKS` | grabber | background | 解析推荐/其他链接（tab 2/3） |
| `BD_FETCH_ALBUMS` | grabber | background | 批量抓取选中相册（并发 3，逐个完成推送） |
| `BD_RESULT` | background | grabber | 结果推送（kind: album / scan / album-batch-item） |

## 类型

- `BuonduaImage { url, filename, width?, height? }`
- `BuonduaLinkItem { url, title, coverUrl?, imageCount? }`

## 范围与冻结

- 新模块：`src/lib/buondua-parse.ts` / `src/background/buondua-service.ts` / `src/grabber/view-buondua.ts`
- 修改：types.ts（新增类型）、messages.ts（新消息）、background.ts（新分支）、grabber.ts（挂载+路由）、grabber.html/css（页签+样式）、模块边界.md
- 共享抓取视图组件 image-grab-view.ts 仅复用，不改内部实现

## 开发侧实测（2026-08-10）

- 解析器：真实页面 20 图 / 4 分页 / 20 推荐 / 20 其他
- 全子页抓取：4 页扫描 80 张，去重后 80 张（001~080 完整）
- 待用户浏览器实测（抓取 / 批量推荐 / 批量其他 / 下一批 / 文件夹命名）
