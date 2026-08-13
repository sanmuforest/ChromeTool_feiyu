# FP-009 站点适配：sexy.pixibb.com（PixiBB，WordPress）设计草案 v1

- 状态：**已实现（2026-08-13，见变更日志 070）**
- 前置调研：curl 直连实测（2026-08-13），示例文章 `https://sexy.pixibb.com/otherxxx-kiy-55-photos-31-videos/`（55 photos，6 页分页）

## 一、站点实测结构

| 通道 | URL | 实测 |
|------|-----|------|
| 文章页（相册） | `/{slug}-{N}-photos-{M}-videos/` | WordPress（magezix 主题）；正文容器 `<div class="entry-content">`（`wp-block-image > figure > img`）；每页 10 图 |
| 文章内分页 | `/{slug}.../{N}/`（路径式带尾斜杠） | `post-page-numbers` 链接，55 photos → 6 页 |
| 图片 | `imgx{NNN}.pixibb.com/{YYYY}/{MM}/{DD}/{ID}/{name}-{NNN}.jpg` | **原图直链**（含序号命名） |
| 封面 | `wpmedia001.pixibb.com/...` | `wp-post-image` / 列表卡片封面 |
| 列表页 | `/albums/` + `/albums/page/{N}/` | WP 标准分页（`page-numbers` class），共 916 页 |
| 前后文章导航 | 文章页 `post-nav__link`（上一篇/下一篇） | 相邻文章链接 |

- **无登录墙** ✅（正文图片直接可见）
- **反爬**：无 Cloudflare 拦截，**curl 直连 HTTP 200** → 后台 fetch 主通道可行（无需页面内 fetch 降级）
- **视频**：myvidplay iframe 嵌入 + premium JS 动态加载（31 videos）——**第三方播放器，超出图片下载器范围，v1 不处理**（仅图片抓取）

## 二、功能范围（对齐 buondua 适配 3 子标签）

| 子标签 | 功能 | 说明 |
|--------|------|------|
| 抓取 | 文章全子页抓取 | URL → 全部路径分页（/2/ /3/…）图片 → 去重 → 共享抓取视图 → 下载 |
| 批量抓取推荐链接 | 前后文章解析 | `post-nav__link` 上一篇/下一篇 → 勾选批量抓取 |
| 批量抓取其他链接 | 全页帖子链接 | 全页文章链接 − 推荐区（含 Recent Post 侧边栏） → 同上 |

## 三、实现方案（复用 FP-008 jrants 模式，改动更小）

| 文件 | 改动 |
|------|------|
| `src/lib/gallery-sites.ts` | ① 新增 `pixibb` 配置：hosts=`['pixibb.com']`（覆盖 sexy/cosplay/hub 子域）；containerOpen=`entry-content`；pageUrl 路径式 `base/{N}/`（带尾斜杠）；baseUrlOf 去尾部 `/N/`；cleanTitle=trim ② `IMG_HOST` 加入 `pixibb\.com`（覆盖 imgx004/wpmedia001 子域）③ 无需新增兜底（re3 已支持 `post-page-numbers`，FP-008 已验证 `(\d+)\/?$` 兼容尾斜杠） |
| `src/lib/pixibb-parse.ts` | **新增**：`parsePixibbPostLinks(html, base, opts)`（文章链接 `/{slug}-{N}-photos-{M}-videos/`：仅推荐=post-nav 2 链接 / 全页 − 推荐；标题/封面提取）；`extractPixibbFolderName(title)` 文件夹名清洗 |
| `src/background/buondua-service.ts` | `scanLinks` 路由加 `pixibb` 分支 |
| `src/grabber/view-buondua.ts` | 提示文案加 pixibb.com；文件夹名路由加 pixibb |
| `src/lib/messages.ts` | 无需新增（复用 BD_* 全链路） |

- 通道：后台 fetch 直连（curl 200 实测），页面内 fetch 降级仅作兜底保留（复用既有 BD_FETCH_HTML）
- host 权限：`pixibb.com` 子域纳入按需申请（复用现有模式）

## 四、实测验证方案（红线 3）

1. **抓取**：输入示例 URL → 全 6 页 ≈ 55 张（10/页，末页 5）→ 网格 → 下载
2. **推荐链接**：识别 post-nav 上一篇/下一篇 → 抓取
3. **其他链接**：列表页 `/albums/` 或文章页 → 全页文章链接
4. **大相册**：找一个 10+ 页文章验证遍历（如 w-fantia-jan-2024-113-photos）
5. tsc + build；后台 fetch 直连验证

## 五、回归检查（红线 1）

- `gallery-sites.ts`（ACTIVE）：新增 pixibb 配置为追加；`parseGalleryMaxPage` re3 已支持 pixibb 格式（FP-008 已验证 `(\d+)\/?$` 兼容 `/2/` 尾斜杠）；buondua/rrwsh/hitxhot/jrants 配置不动
- `buondua-service.ts` / `view-buondua.ts`：仅加路由分支与文案，既有逻辑不动
- 不触碰 FROZEN 模块

## 六、风险与遗留

- 视频（myvidplay / premium）不在范围：本插件为图片下载器，视频需另议（如后续要支持可单独立项）
- 列表页 916 页、站点大，批量抓取沿用每批节流机制
- 图片为原图直链（imgxNNN.pixibb.com），打包下载走既有通道
