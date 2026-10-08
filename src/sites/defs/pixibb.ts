// pixibb（PixiBB，WordPress magezix 主题）：.entry-content + 路径式 /N/ 分页（post-page-numbers）
// 标题无 Page 标记；WP 搜索主内容子域 sexy.pixibb.com（?s={q} 与 /page/N/?s={q}）
import type { SiteDef } from '../schema'

export const pixibb: SiteDef = {
  id: 'pixibb',
  label: 'PixiBB',
  uiOrder: 60,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  // 2026-10-08 体检 P0-2：命名规则由定义声明（视图侧不再判断 site.id）
  folderNameRule: 'pixibb',
  endpoints: [{ host: 'pixibb.com', role: 'primary' }],
  container: { tag: 'div', className: 'entry-content' },
  pagination: { kind: 'path-slash-from-2' },
  baseUrl: { stripPagePath: 'trailing-slash' },
  // maxPagePattern 缺省 = 无标题标记
  imageHosts: ['pixibb.com'],
  search: { kind: 'wp-query-path-page', param: 's', trailingSlash: true },
  searchBaseHost: 'sexy.pixibb.com',
  linkParser: 'pixibb-magezix',
  scan: { recommended: 'pixibb-recommended', others: 'pixibb-others' },
  imageCountRule: 'pixibb-slug',
  hint: '站内搜索无结果：走 Google 通道',
}
