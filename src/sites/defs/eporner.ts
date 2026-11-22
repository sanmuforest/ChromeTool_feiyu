// eporner（2026-11-23 新站）：div.gallerypage 正文 + 单页无分页 + 缩略图去尺寸后缀还原原图
//
// 结构实测（https://www.eporner.com/gallery/OYnlGBsLlxz/Women-in-stockings-photographed-4/）：
// - 正文容器：`<div id="content" class="gallerypage">`
// - 图片标签：`<img id="t38093122" src=".../38093122-10001_296x1000.jpg" alt="amateur photo 10001" ...>`
// - **缩略图 → 原图**：直接去掉 `_宽x高` 后缀
//   实测 `_296x1000` = 20,885 字节  →  无后缀 = 1,053,502 字节（约 1MB）
//   试过 `_1000x1000` / `_2000x2000` / `_1920x1080` / `_300x0` / `_1000x0` 全部 404，
//   说明该站原图地址就是「无尺寸后缀」形态，不需要猜尺寸
// - 单页：页面声明 `145 pics`，HTML 内唯一正文图恰好 145 张，全站无任何分页链接
// - 图床：`static-sg-cdn.eporner.com`
//
// 两个踩过的坑（2026-11-23）：
// 1. **不要写 `imageHosts`** —— 它是全部站点 `imageHosts` 的**全局并集**（engine.ts 的 IMAGE_HOSTS），
//    写了 `'eporner.com'` 会让所有站点都把 eporner 的页面链接（/profile/、/cat/）当成图片；
//    本站图片全部带 `.jpg` 扩展名，用不到这个字段。
// 2. **`imageOnlyHosts` 挡不住推荐位** —— 推荐位图也在 `static-sg-cdn.eporner.com` 且带 `.jpg`。
//    真正的分界是：正文图带 `_宽x高` 尺寸后缀，推荐位图不带 → 用 `imagePathPattern` 精确切分
//    （实测加它之前 199 张，加之后正好 145 张）。
import type { SiteDef } from '../schema'

export const eporner: SiteDef = {
  id: 'eporner',
  label: 'EPORNER',
  uiOrder: 100,
  channels: ['site'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'eporner.com', role: 'primary' }],
  container: { tag: 'div', className: 'gallerypage' },
  pagination: { kind: 'single' },
  // 标题：`Women in stockings photographed---4 Photo Gallery - EPORNER`
  titleStrip: [{ source: '\\s*Photo Gallery\\s*-\\s*EPORNER\\s*$', flags: 'i' }],
  // 只保留带尺寸后缀的正文图（推荐位图没有该后缀）
  imagePathPattern: { source: '_\\d+x\\d+\\.jpg$' },
  // **关键**：正文图与「相关相册」推荐位图的 URL 结构完全相同（同域同格式 `_296x1000.jpg`），
  // 唯一差别在 <img> 标签的 alt：
  //   正文  → alt="amateur photo 10001"（纯数字）
  //   推荐位 → alt="amateur photo The receptionist who was filming"（文字标题）
  // 实测块内 165 个 img：alt 为纯数字的 145 个**全部属于本相册**，
  // 其余 20 个**全部不属于本相册**（交叉验证通过）。
  imageTagPattern: { source: 'alt="amateur photo \\d+"' },
  // 缩略图还原原图：`38093122-10001_296x1000.jpg` → `38093122-10001.jpg`
  imageThumbFix: { source: '_\\d+x\\d+(\\.jpg)$', replace: '$1', flags: 'i' },
  // 只保留 eporner 自家 CDN（排除外部广告/CDN）
  imageOnlyHosts: ['eporner.com'],
  linkParser: 'generic-post-links',
}
