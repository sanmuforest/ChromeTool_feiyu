// jliji.com（聚丽集，2026-10-15 用户浏览器内探测适配）
//
// 探测结论（相册页 /set/17916）：
// - 相册：/set/{id}，**单页无分页**；?lang=zh 为语言参数（可省略，探测 URL 即无该参数）
// - 正文容器：div.gallery-grid（其下 div.gallery-item.progressive-image ×N；实测 110 个 = 标题「110P」）
// - **真图在 `data-full` 属性**（`src` 只是 …/thumbs/N.webp 缩略图）→ 用 imageAttr 声明
// - 图床：cdn.jliji.com/galleries/8se/{hash}/…（与 8se.me 同源内容）
// - 标题：`{相册名} - {模特} - 聚丽集`（站名在尾部）
// - 站内搜索：/images/search?q={q}（无分页参数）
import type { SiteDef } from '../schema'

export const jliji: SiteDef = {
  id: 'jliji',
  label: '聚丽集',
  uiOrder: 120,
  channels: ['site'],
  defaultChecked: false,
  folderTag: 'buondua',
  // 站点实际入口是 www. 子域（用户提供的相册页与搜索页均为 www.jliji.com）；
  // primary 用该子域，裸域作 mirror —— 搜索 URL 由 primary 生成，必须指向实际可用的域
  endpoints: [{ host: 'www.jliji.com', role: 'primary' }, { host: 'jliji.com', role: 'mirror' }],
  container: { tag: 'div', className: 'gallery-grid' },
  pagination: { kind: 'single' },
  // 真图属性（src 是缩略图，取它会得到小图）
  imageAttr: 'data-full',
  titleStrip: [{ source: '\\s*-\\s*聚丽集\\s*$' }],
  search: { kind: 'query', path: '/images/search', param: 'q' },
  searchAlbumPattern: { source: '^/set/\\d+/?$' },
  linkParser: 'generic-post-links',
}
