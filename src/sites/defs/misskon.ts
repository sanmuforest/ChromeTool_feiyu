// misskon.com（MissKon，2026-10-15 真实页面探测适配）
//
// 探测结论（文章页 /{id}-{slug}/2/）：
// - WordPress 站（wp-content / wp-json / GeneratePress 主题痕迹），但**不是**现有任何模板
//   （entry-content / article-fulltext / image-gallery / contentme 全部 0 命中）→ 新增站点
// - 正文容器：`<article class="post-listing post-111358 post type-post …">`（article 内 img 8 个，8 个全是正文图）
// - 分页：`/{slug}/`（第 1 页）与 `/{slug}/{N}/`（其后）→ path-slash-from-2，基址去尾部 /N/
// - 标题：`[OtherXXX] … (124 photos + 16 videos) – Page 2 – MissKon.com`（只有当前页码，**无总页数**）
//   → 分页链接也不是标准 page-numbers 形态 → 用顺序翻页（遇空页/重复页停止）
// - 图片：`tez.misskon.com/uploads/…-018.FLxgMYTM.webp`
//   懒加载写法：`src` 是 1×1 SVG 占位（data: URI，会被引擎跳过）、真图在 `data-src`（引擎自 v0.2.46 已支持）
import type { SiteDef } from '../schema'

export const misskon: SiteDef = {
  id: 'misskon',
  label: 'MissKon',
  uiOrder: 150,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'misskon.com', role: 'primary' }],
  container: { tag: 'article', className: 'post-listing' },
  // 正文图全在 tez.misskon.com；article 内还会混入站内图（首图/下载按钮）→ 只保留图床
  imageOnlyHosts: ['tez.misskon.com'],
  pagination: { kind: 'path-slash-from-2' },
  baseUrl: { stripPagePath: 'trailing-slash' },
  // 标题只有当前页码、无总页数；分页链接不是标准 page-numbers 形态 → 顺序翻页
  followPagesUntilEmpty: true,
  throttle: { fromPage: 2, delayMs: 1200 },
  titleStrip: [
    { source: '\\s*[-–—]\\s*Page\\s+\\d+\\s*' },
    { source: '\\s*[-–—]\\s*MissKon\\.com\\s*$', flags: 'i' },
  ],
  linkParser: 'generic-post-links',
}
