// knit.bid（日本多页图站，2026-10-10 实测探测适配）
//
// 页面结构（实测 https://xx.knit.bid/ja/article/29937/ 与 .../page/9/）：
// - 分页：/ja/article/{id}/（第 1 页）与 /ja/article/{id}/page/N/（第 N 页）—— WP 标准分页
// - 正文容器：<div class="image-container"> 内 <p class="item-image"><img class="item-image__img" src="/static/images/…">
// - 图片为 **root-relative 路径**（引擎已支持相对路径按页面基址解析），图床同域且带扩展名（无需 imageHosts）
// - 标题：`{标题} - {标签} - 妹を愛する`（站名「妹を愛する」出现在页脚）
// - 分页总数**不可测**（分页链接不在 <a> 标签内、标题无 Page X/Y、无「尾页」链接）→ 启用顺序翻页
import type { SiteDef } from '../schema'

export const knitbid: SiteDef = {
  id: 'knitbid',
  label: 'Knit.bid',
  uiOrder: 100,
  // 站内搜索（2026-10-10 探测：表单 action=/ja/search/ + input name=s → /ja/search/?s=…；分页 /ja/search/page/N/）
  channels: ['site'],
  defaultChecked: false,
  folderTag: 'buondua',
  // 站点实际部署在 xx. 子域（用户给出与实测的 URL 均为 xx.knit.bid）→ primary 用子域，
  // 裸域作为 mirror 仅在用户直接访问裸域时匹配（搜索 URL 由 primary 生成，必须指向可用的子域）
  endpoints: [{ host: 'xx.knit.bid', role: 'primary' }, { host: 'knit.bid', role: 'mirror' }],
  container: { tag: 'div', className: 'image-container' },
  pagination: { kind: 'page-path-slash' },
  baseUrl: { stripPagePath: 'page-segment' },
  // maxPagePattern 缺省：页面无 Page X/Y 标记（由 followPagesUntilEmpty 兜底）
  // 2026-10-11：实测 /ja/ 页站名为「妹を愛する」，中文页为「爱妹子」
  // （用户日志中文件夹名仍带「- 爱妹子」）→ 两种站名都剥离
  titleStrip: [{ source: '\\s*-\\s*(?:妹を愛する|爱妹子)\\s*$' }],
  followPagesUntilEmpty: true,
  // 顺序翻页请求较多（实测一次抓取即触发站点 429 限流）→ 第 2 页起页间等待 1.2s
  throttle: { fromPage: 2, delayMs: 1200 },
  // 站内搜索：/ja/search/?s={q}，分页 /ja/search/page/N/?s={q}（实测均 HTTP 200）
  search: { kind: 'wp-query-path-page', param: 's', path: '/ja/search/', trailingSlash: true },
  // 结果只保留相册页，排除 /ja/type/N/ 等分类页。
  // 2026-10-11 实测：站点同时存在 /ja/article/{id}/ 与 /article/{id}/ 两种形态 → 正则放宽为可选 ja 前缀
  searchAlbumPattern: { source: '^/(?:ja/)?article/\\d+/?$' },
  // 列表浏览（2026-10-11 实测）：分类页 /ja/type/N/，分页 /ja/type/N/page/M/（带尾斜杠 → pageKind: path-slash）
  listPages: [{ label: '分类列表', path: '/ja/type/1/', pageKind: 'path-slash' }],
  linkParser: 'generic-post-links',
}
