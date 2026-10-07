// jrants（青年美图，WordPress）：.entry-content + 路径式 /N 分页（page-links 导航）
// 标题无 Page 标记（总页数靠分页链接兜底）；WP 站内搜索 /page/N?s={q}
import type { SiteDef } from '../schema'

export const jrants: SiteDef = {
  id: 'jrants',
  label: 'Jrants',
  uiOrder: 50,
  // 2026-10-07：站内搜索被反爬拒绝（HTTP 403，首页亦不可后台直接访问）→ 改走 Google 站内搜索通道
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'jrants.com', role: 'primary' }],
  container: { tag: 'div', className: 'entry-content' },
  pagination: { kind: 'path-from-2' },
  baseUrl: { stripPagePath: 'suffix' },
  // maxPagePattern 缺省 = 无标题标记
  imageHosts: ['jrants.com'],
  search: { kind: 'google-sitesearch' },
  linkParser: 'google-serp',
  scan: { recommended: 'jrants-recommended', others: 'jrants-others' },
  imageCountRule: 'jrants-p',
  // jrants 连续快速搜索触发反爬限流（实测 2026-08-13/14），页间强制间隔
  throttle: { fromPage: 2, delayMs: 2000 },
}
