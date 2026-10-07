// phimvuspot：.contentme 正文（与 hitxhot 同模板）+ ?page=N；标题「Page 1/18」
// 图片经 WordPress Photon CDN 代理（iN.wp.com/im.thismore.fun/s2/{base64}.jpg?w=640），?w 可放大
import type { SiteDef } from '../schema'

export const phimvuspot: SiteDef = {
  id: 'phimvuspot',
  label: 'PhimVuSpot',
  uiOrder: 80,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  // 主域优先：m. 子域 Google 索引差（FP-014）
  endpoints: [{ host: 'm.phimvuspot.com', role: 'mirror' }, { host: 'phimvuspot.com', role: 'primary' }],
  container: { tag: 'div', className: 'contentme' },
  pagination: { kind: 'query', param: 'page' },
  maxPagePattern: { source: '\\|\\s*Page\\s+\\d+\\s*\\/\\s*(\\d+)', flags: 'i' },
  titleStrip: [
    { source: '^PhimVu\\s*Blog:\\s*', flags: 'i' },
    { source: '\\s*\\|\\s*Page\\s+\\d+\\s*\\/\\s*\\d+\\s*$', flags: 'i' },
  ],
  imageHosts: ['wp.com', 'thismore.fun'],
  // Photon 缩放参数放大：?w=640 → ?w=1920（高清原图级）
  imageQueryFix: [{ param: 'w', value: '1920' }],
  linkParser: 'generic-post-links',
}
