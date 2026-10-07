// kaizty：与 hitxhot 同模板（.contentme，标题 "| Page X/Y"）；无站内搜索（Google sitesearch）
// 相册路径 /photos/{base64}.html；标题前缀 "Kaizty Photos:" / "Kaizty 照片："
import type { SiteDef } from '../schema'

export const kaizty: SiteDef = {
  id: 'kaizty',
  label: 'Kaizty',
  uiOrder: 40,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'kaizty.com', role: 'primary' }],
  container: { tag: 'div', className: 'contentme' },
  pagination: { kind: 'query', param: 'page' },
  maxPagePattern: {
    source: '\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*(\\d+)|第\\s*\\d+\\s*\\/\\s*(\\d+)\\s*页)',
    flags: 'i',
  },
  titleStrip: [
    { source: '^Kaizty Photos:\\s*', flags: 'i' },
    { source: '^Kaizty 照片：\\s*', flags: 'i' },
    { source: '\\s*\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*\\d+|第?\\s*\\d+\\s*\\/\\s*\\d+\\s*页)\\s*$', flags: 'i' },
  ],
  search: { kind: 'google-sitesearch' },
  searchAlbumPath: '/photos/',
  // FP-023 列表浏览：站内相册列表页（不依赖搜索引擎，Google 通道被拒时的替代通道）
  listPages: [{ label: '相册列表 /photos/', path: '/photos/', pageKind: 'query', param: 'page' }],
  linkParser: 'kaizty-photos',
  hint: '无站内搜索：走 Google 站内搜索（sitesearch）',
}
