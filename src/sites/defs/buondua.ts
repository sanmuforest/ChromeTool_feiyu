// Buondua：.article-fulltext 正文 + ?page=N 分页 + 站内 ?search= 搜索（分页 &start=）
// 实测（2026-08-11）：图片 i2.buondua.com/...jpeg?签名；标题 "( Page X / N )"
import type { SiteDef } from '../schema'

export const buondua: SiteDef = {
  id: 'buondua',
  label: 'Buondua',
  uiOrder: 10,
  channels: ['site'],
  defaultChecked: true,
  folderTag: 'buondua',
  endpoints: [{ host: 'buondua.com', role: 'primary' }],
  container: { tag: 'div', className: 'article-fulltext' },
  pagination: { kind: 'query', param: 'page' },
  maxPagePattern: { source: '\\(\\s*Page\\s+\\d+\\s*\\/\\s*(\\d+)\\s*\\)', flags: 'i' },
  titleStrip: [{ source: '\\s*[-–—]\\s*\\(\\s*Page\\s+\\d+\\s*\\/\\s*\\d+\\s*\\)\\s*$', flags: 'i' }],
  imageHosts: ['buondua.com'],
  // 站内搜索（2026-08-14 实测恢复可用）：GET ?search={q}，分页 &start={offset}（每页 20 条）
  search: { kind: 'query', path: '/', param: 'search', pageParam: 'start', pageStep: 20 },
  linkParser: 'buondua-items-row',
}
