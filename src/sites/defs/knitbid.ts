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
  // 未探测到可用的站内搜索接口 → 归入 Google 通道组
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'knit.bid', role: 'primary' }],
  container: { tag: 'div', className: 'image-container' },
  pagination: { kind: 'page-path-slash' },
  baseUrl: { stripPagePath: 'page-segment' },
  // maxPagePattern 缺省：页面无 Page X/Y 标记（由 followPagesUntilEmpty 兜底）
  titleStrip: [{ source: '\\s*-\\s*妹を愛する\\s*$' }],
  followPagesUntilEmpty: true,
  linkParser: 'generic-post-links',
}
