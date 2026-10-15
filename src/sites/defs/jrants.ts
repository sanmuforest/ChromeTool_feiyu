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
  // 2026-10-08 体检 P0-2：命名规则由定义声明（视图侧不再判断 site.id）
  folderNameRule: 'jrants',
  endpoints: [{ host: 'jrants.com', role: 'primary' }],
  container: { tag: 'div', className: 'entry-content' },
  pagination: { kind: 'path-from-2' },
  baseUrl: { stripPagePath: 'suffix' },
  // maxPagePattern 缺省 = 无标题标记
  imageHosts: ['jrants.com'],
  search: { kind: 'google-sitesearch' },
  // 相册 URL 形态（2026-10-11 实测）：/2026101206911.html（13 位数字 + .html，并非 8 位日期）
  // 作用：① 过滤 Google 结果中的分类/标签页 ② 列表浏览解析的相册过滤（listPages 未配 albumPath 时复用）
  searchAlbumPattern: { source: '^/\\d+\\.html$' },
  // 列表浏览（2026-10-11 实测）：首页分页为 /page/N（无尾斜杠 → pageKind: path），每页约 20 条
  listPages: [{ label: '最新', path: '/', pageKind: 'path' }],
  linkParser: 'google-serp',
  scan: { recommended: 'jrants-recommended', others: 'jrants-others' },
  imageCountRule: 'jrants-p',
  // jrants 连续快速搜索触发反爬限流（实测 2026-08-13/14），页间强制间隔
  throttle: { fromPage: 2, delayMs: 2000 },
}
