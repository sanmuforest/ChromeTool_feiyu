// rrwsh（4khd 镜像体系）：.entry-content + 路径式 /N 分页 + /search/{q}
//
// hosts 说明（FP-014 修复 8）：rrwsh.uuss.uk 为 4khd 模板镜像（/content/N/slug.html），
// 4khd.com 相册页被反爬网关拦截（302 → y5gx.uuss.uk/4khd.php），搜索命中后由 urlRewrite
// 改写为 rrwsh 域；iftye.uuss.uk 为同体系镜像。
import type { SiteDef } from '../schema'

export const rrwsh: SiteDef = {
  id: 'rrwsh',
  label: 'RRWSH (4KHD)',
  uiOrder: 20,
  channels: ['site'],
  // 2026-10-07 实测：rrwsh.uuss.uk 背后已换成「豆豆」视频站（iozl.uuss.uk），
  // 原 4KHD 图集站不在该域，解析器依赖的 li.wp-block-post 结构也已消失 → 暂不默认勾选（避免聚合搜索白跑）
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [
    { host: 'rrwsh.uuss.uk', role: 'primary' },
    { host: '4khd.com', role: 'mirror' },
    { host: 'iftye.uuss.uk', role: 'mirror' },
  ],
  container: { tag: 'div', className: 'entry-content' },
  pagination: { kind: 'path' },
  baseUrl: { stripPagePath: 'suffix' },
  maxPagePattern: { source: 'Page\\s+\\d+\\s+of\\s+(\\d+)', flags: 'i' },
  titleStrip: [
    { source: '\\s*[-–—]\\s*Page\\s+\\d+\\s+of\\s+\\d+\\s*[-–—]\\s*[^-]*$', flags: 'i' },
    { source: '\\s*[-–—]\\s*4KHD\\s*$', flags: 'i' },
  ],
  imageHosts: ['wp.com'],
  // 搜索无分页（实测 2026-08-14：/search/{q}/2 为空白页），每页固定 4 条
  search: { kind: 'path-template', template: '/search/{q}' },
  // 4khd.com 结果链接改写回 rrwsh 域（primary）
  urlRewrite: [{ fromHost: '4khd.com' }],
  linkParser: 'rrwsh-cards',
  imageCountRule: 'rrwsh-photos',
}
