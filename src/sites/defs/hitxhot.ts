// hitxhot：.contentme 正文 + ?page=N 分页；无站内搜索（官方搜索表单即 Google sitesearch）
// 标题：英文 "| Page 2/3" 与中文 "| 第1/6页" 双模式；相册路径 /gallerys/
import type { SiteDef } from '../schema'

export const hitxhot: SiteDef = {
  id: 'hitxhot',
  label: 'Hitxhot',
  uiOrder: 30,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'hitxhot.org', role: 'primary' }],
  container: { tag: 'div', className: 'contentme' },
  pagination: { kind: 'query', param: 'page' },
  maxPagePattern: {
    source: '\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*(\\d+)|第\\s*\\d+\\s*\\/\\s*(\\d+)\\s*页)',
    flags: 'i',
  },
  titleStrip: [{ source: '\\s*\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*\\d+|第\\s*\\d+\\s*\\/\\s*\\d+\\s*页)\\s*$', flags: 'i' }],
  search: { kind: 'google-sitesearch' },
  searchAlbumPath: '/gallerys/',
  // FP-023 列表浏览：站内相册列表页（不依赖搜索引擎，Google 通道被拒时的替代通道）
  listPages: [{ label: '相册列表 /gallerys/', path: '/gallerys/', pageKind: 'query', param: 'page' }],
  linkParser: 'google-serp',
  hint: '无站内搜索：走 Google 站内搜索（sitesearch）',
}
