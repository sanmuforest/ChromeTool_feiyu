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
  // 正文图床。2026-11-25 更新：实测该站已把正文图迁到 **lux.mrcong.com**
  // （mrcong 系图床，形如 https://lux.mrcong.com/images/2023/06/01/Coser-No.007-MrCong.com-001.webp），
  // 原 `tez.misskon.com` 已完全不再使用（p1/p2/p6 三页统计均为 0 次）。
  // 由于原定义只白名单 tez.misskon.com → 所有正文图被过滤 → 「首页解析 0 张、scanned 0」。
  // 保留旧域名作为兼容（老相册可能仍指向它）。
  // article 内另混有广告脚本（vertigovitalitywieldable.com、a.magsrv.com），非图片扩展名会被引擎跳过。
  imageOnlyHosts: ['lux.mrcong.com', 'tez.misskon.com'],
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
