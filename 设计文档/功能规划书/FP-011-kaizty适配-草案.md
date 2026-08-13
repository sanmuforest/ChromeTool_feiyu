# FP-011 站点适配：kaizty.com（Kaizty Photos）设计草案 v1

- 状态：**已实现（2026-08-13，见变更日志 078）**
- 前置调研：agent-browser 实测（2026-08-13），示例相册 `https://www.kaizty.com/photos/R2k4YlpBVURWNk9oNC8ydjQ2cDFBZz09.html`（[会计姐姐和她的闺蜜系列]无缝黑丝大尺度展示，8 页）

## 一、站点实测结构

| 通道 | URL | 实测 |
|------|-----|------|
| 相册页 | `/photos/{base64}.html` | 与 hitxhot **同模板**：正文容器 `<div class="contentme">`；每页 ~11 图 |
| 分页 | `?page=N`（Next > 链接） | 标题含 `| Page X/Y`（组2 = 总页数） |
| 图片 | `i{N}.wp.com/cdn{N}.thismore.fun/d{N}/{base64}.jpg?w=640` 或 `cdn{N}.thismore.fun/...` | thismore.fun CDN，**curl 200 可下载**（231KB 实测） |
| 标题 | `<title>` / `<h2 class="box-mt-output">… \| Page 1/8</h2>` | `<title>` 完整可用（含 Page 标记） |
| 相关相册 | 页面其他 `Kaizty Photos: … | Page X/Y` 链接 | 可作推荐链接 |

- **无登录墙** ✅（内容直接可见）
- **反爬**：Cloudflare TLS 指纹拦截 curl（schannel handshake failed 实测）——后台 fetch 用 Chrome 网络栈可能可过；不可过时自动走既有页面内 fetch 降级通道（BD_FETCH_HTML）
- **无搜索入口**（同 hitxhot 模板，`?s=` 不适用）→ 聚合搜索不参与

## 二、功能范围（对齐多页图站 3 子标签，不含聚合搜索）

| 子标签 | 功能 | 说明 |
|--------|------|------|
| 抓取 | 相册全子页抓取 | URL → 全部 `?page=N` 分页图片 → 去重 → 共享抓取视图 → 下载 |
| 批量抓取推荐链接 | 页面相关相册 | 页面其他 `Kaizty Photos:` 相册链接 → 勾选批量抓取 |
| 批量抓取其他链接 | 全页相册链接 | 全页相册链接 − 推荐区 → 同上 |

## 三、实现方案（复用 hitxhot 同模板配置，改动最小）

| 文件 | 改动 |
|------|------|
| `src/lib/gallery-sites.ts` | ① 新增 `kaizty` 站点配置（复制 hitxhot 结构：containerOpen=`contentme`、pagePattern=`\| Page X/Y`、pageUrl=`?page=N`、baseUrlOf 去 query；cleanTitle 去 `Kaizty Photos: ` 前缀 + `\| Page X/Y`；searchUrl=null）② `IMG_HOST` 加入 `thismore\.fun` |
| `src/grabber/view-buondua.ts` | 适配提示文案与 placeholder 加入 kaizty.com（自动填充走 matchGallerySite 已自动生效） |
| `src/background/buondua-service.ts` | 无需改动（链接扫描路由：kaizty 无专用解析器 → 走通用 `parseSitePostLinks` 兜底；`fetchAlbumAllPages` 已通用） |
| `src/lib/messages.ts` | 无需新增（复用 BD_* 全链路 + 页面内 fetch 降级通道） |

- 通道：后台 fetch 为主 + 页面内 fetch 降级（BD_FETCH_HTML）
- 推荐/其他链接解析：kaizty 相册链接格式 `/photos/{base64}.html`（无专用解析器，通用 `parseSitePostLinks` 兜底可提取）

## 四、实测验证方案（红线 3）

1. **抓取**：输入示例 URL → 全 8 页 ≈ 80+ 张 → 网格展示 → 下载
2. **推荐链接**：同一 URL 识别页面其他相册 → 勾选批量抓取
3. **其他链接**：扫描全页相册链接
4. **降级通道**：若后台 fetch 被 CF 拦，验证打开 kaizty 页面后自动走页面内 fetch 仍可抓
5. tsc + build

## 五、回归检查（红线 1）

- `gallery-sites.ts`：新增配置为追加；`IMG_HOST` 正则追加不影响既有站点
- `view-buondua.ts`：仅文案更新
- 不触碰 FROZEN 模块

## 六、风险与遗留

- 后台 fetch 是否过 Cloudflare 需实测；不过则需用户打开 kaizty 页面（降级通道）
- 图片为 `?w=640` 缩放版本（i0.wp.com 代理）；若用户需要更高清原图，后续可加"去 w 参数取原图"优化（先按页面 URL 直用）
- 图片 onerror 有 JS 替换逻辑（imgErrorHF），若个别图加载失败需留意
