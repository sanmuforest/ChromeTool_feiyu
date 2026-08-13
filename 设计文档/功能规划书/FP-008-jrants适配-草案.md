# FP-008 站点适配：jrants.com（青年美图，WordPress）设计草案 v1

- 状态：**已实现（2026-08-13，见变更日志 069）**
- 前置调研：agent-browser 浏览器实测（2026-08-13），示例文章 `https://jrants.com/2026071187497.html`（米娜米娜 - BimilStory，3 页分页）

## 一、站点实测结构

| 通道 | URL | 实测 |
|------|-----|------|
| 文章页（相册） | `/2026071187497.html` | WordPress 多页文章；正文容器 `<div class="entry-content" itemprop="text">`；每页 20 图 |
| 文章内分页 | `/2026071187497.html/2`、`/3`（路径式） | `<div class="page-links">` 导航（`post-page-numbers` 链接 + 「下一页 »」） |
| 图片 | `m2.jrants.com/wp-content/uploads/YYYY/MM/DD/{name}.jpg` | 原图直链（`img.wp-image-*`，含 width/height） |
| 列表页 | `/`、`/page/{N}`、分类/标签页 | 每页 30 篇；首页共 4904 页 |
| 相关文章 | 文章页正文下方 `wp-show-posts-single` 卡片 | 标题 + 文章链接 + 封面 |

- **无登录墙** ✅（与 v2ph 不同，正文图片直接可见）
- **反爬**：Cloudflare TLS 指纹拦截 curl（schannel handshake failed 实测）；后台 fetch 用 Chrome 网络栈可能可过，不可过时自动走既有页面内 fetch 降级通道（BD_FETCH_HTML）

## 二、功能范围（对齐 buondua 适配 3 子标签）

| 子标签 | 功能 | 说明 |
|--------|------|------|
| 抓取 | 文章全子页抓取 | URL → 全部路径分页（/2 /3…）图片 → 去重 → 共享抓取视图 → 下载 |
| 批量抓取推荐链接 | 相关文章解析 | 文章页 `wp-show-posts-single` 卡片 → 勾选批量抓取（独立文件夹） |
| 批量抓取其他链接 | 全页帖子链接 | 全页文章链接 − 推荐区 → 同上 |

## 三、实现方案（复用配置驱动 + 既有通道，无新消息）

| 文件 | 改动 |
|------|------|
| `src/lib/gallery-sites.ts` | ① 新增 `jrants` 配置（containerOpen=`entry-content`；pagePattern 用分页链接兜底；pageUrl=路径式 `base/N`；baseUrlOf=去尾部 `/N`；cleanTitle 去分页后缀）② `IMG_HOST` 正则加入 `jrants\.com`（覆盖 m2.jrants.com）③ `parseGalleryMaxPage` 兜底增加 `post-page-numbers` 的 href 数字提取（放宽 class 匹配，对现有三站无副作用） |
| `src/lib/jrants-parse.ts` | **新增**：`parseJrantsPostLinks(html, base, exclude?)`（`wp-show-posts-single` 卡片 + 列表 `article` 卡片链接解析，去重、排除自身）；`extractJrantsFolderName(title)` 文件夹名清洗 |
| `src/background/buondua-service.ts` | `scanLinks` 按站点路由：`jrants` → `parseJrantsPostLinks`（recommended=相关文章；popular=全页帖子链接）；`fetchAlbumAllPages` 已通用无需改 |
| `src/grabber/view-buondua.ts` | 适配提示文案更新（buondua / rrwsh / hitxhot / jrants）；文件夹名按站点路由 |
| `src/lib/messages.ts` | 无需新增（复用 `BD_FETCH_ALBUM` / `BD_SCAN_LINKS` / `BD_FETCH_ALBUMS` / `BD_RESULT` 全链路） |

- 通道：后台 fetch 为主 + 页面内 fetch 降级（BD_FETCH_HTML，Content 带 Cookie/Referer 穿透 CF）——零新增
- host 权限：`jrants.com` / `m2.jrants.com` 纳入按需申请（复用现有模式，不新增静态权限）

## 四、实测验证方案（红线 3）

1. **抓取**：输入 `https://jrants.com/2026071187497.html` → 应抓全 3 页 ≈ 60 张（20/页）→ 网格展示 → 下载
2. **推荐链接**：同一 URL 识别相关文章（wp-show-posts-single 卡片数）→ 勾选 1~2 篇批量抓取
3. **其他链接**：输入首页或文章页 → 全页帖子链接列表
4. **大相册**：找一个 5+ 页文章验证页数遍历与去重
5. **降级通道**：若后台 fetch 被 CF 拦，验证打开 jrants 页面后自动走页面内 fetch 仍可抓
6. tsc + build 通过

## 五、回归检查（红线 1）

- `gallery-sites.ts`（ACTIVE）：新增配置为追加；`parseGalleryMaxPage` 仅放宽兜底正则（buondua/rrwsh/hitxhot 的 page-numbers 链接仍匹配，结果不变）
- `buondua-service.ts`：`scanLinks` 加站点路由分支，buondua 走原逻辑不动
- `view-buondua.ts`：仅文案与文件夹名路由，不触碰既有交互
- 不触碰 FROZEN 模块（types.ts / storage.ts / logger.ts / downloader.ts 等）

## 六、风险与遗留

- 后台 fetch 是否过 Cloudflare 需实测；不过则每篇文章首屏请求走降级通道（需用户已打开 jrants 页面），速度略慢
- 站点共 4904 页列表、图片量大，批量抓取沿用每批节流机制，不做全站爬取
- 图片为原图直链（m2.jrants.com），打包下载走既有通道
