// tuzac.com（图宅网，2026-11-04 真实页面探测适配）
//
// 页面结构（文章页 /file/{slug}/{id}/?at=2 实测）：
// - 正文容器：`div.image-loading-box`（内含全部正文图，实测 26 张/页）
// - 正文图：`https://image.tuzac.com/jw-photos/…/{NNN}-{hash}.jpg`
//   写法为 `src` 与 `data-src` **相同**（都是原图），并带 `data-photo-num` 标记
// - 站点另用 `img.tuzac.com` 作为推荐位/预告缩略图（`teaser-*` 区块）→ 用 imageOnlyHosts 排除
// - 分页：`?at=N`（第 1 页不带参数）→ query 式；页面只给出相邻页码，取不到总页数 → 顺序翻页
// - 标题：`{相册名} | 图宅网 | 高清美女无圣光图集`（站名与副标题在 `|` 之后）
import type { SiteDef } from '../schema'

export const tuzac: SiteDef = {
  id: 'tuzac',
  label: '图宅网',
  uiOrder: 160,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'tuzac.com', role: 'primary' }],
  // 正文容器：file-detail（实测块长 ~30KB，包含全部正文图）
  // 注意：image-loading-box 是「每图一个」的外壳（块长仅 301 字符、只含 1 张）——不要用它当容器
  container: { tag: 'div', className: 'file-detail' },
  // 第 1 页 /file/{slug}/{id}/（无参数），其后 ?at=N
  pagination: { kind: 'query', param: 'at' },
  // 只保留正文图床（img.tuzac.com 是 teaser 推荐缩略图）
  imageOnlyHosts: ['image.tuzac.com'],
  // 页面只显示相邻页码，无总页数 → 顺序翻页
  followPagesUntilEmpty: true,
  throttle: { fromPage: 2, delayMs: 1200 },
  titleStrip: [{ source: '\\s*\\|\\s*图宅网.*$' }],
  linkParser: 'generic-post-links',
}
