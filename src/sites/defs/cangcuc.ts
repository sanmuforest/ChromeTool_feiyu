// cangcuc（FP-014 新站）：post-single-body 正文 + 无分页（pageUrl 恒为基址）
// 图片 media01.cangcuc.com/size_large_v1/{相册}_{ts}/NNN.jpg；标题「李佳 - OL | Căng Cực」
import type { SiteDef } from '../schema'

export const cangcuc: SiteDef = {
  id: 'cangcuc',
  label: 'Cangcuc',
  uiOrder: 70,
  channels: ['site'],
  // 2026-10-07 实测：cangcuc.com DNS 已失效（getaddrinfo ENOTFOUND），暂无新域名 → 暂不默认勾选
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'cangcuc.com', role: 'primary' }],
  container: { tag: 'div', className: 'post-single-body' },
  pagination: { kind: 'single' },
  // maxPagePattern 缺省 = 无标题标记
  titleStrip: [{ source: '\\s*\\|\\s*Căng\\s*Cực\\s*$', flags: 'i' }],
  // WP 站内搜索（标准 ?s= + 路径式分页 /page/N/?s=）
  search: { kind: 'wp-query-path-page', param: 's', trailingSlash: true },
  linkParser: 'generic-post-links',
}
