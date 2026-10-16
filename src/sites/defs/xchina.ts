// xchina.co（小黄书 xChina，2026-10-15 用户浏览器内探测适配）
//
// 探测结论（相册 /photo/63872e17c02a1 与 /photo/63872e17c02a1/2）：
// - 相册：/photo/{id}（第 1 页）与 /photo/{id}/{N}（其后各页，**路径式**）
// - **总页数直接写在标题里**：`潼潼 (2/34) - 小黄书 xChina` → maxPagePattern 只捕获总页数（组 1）
// - 正文容器：页面用 Tailwind 类名（div.relative.flex.h-[calc(100svh-84px)]…），类名长且易变
//   → 采用「整页容器 + imageOnlyHosts」方案（与 se8.me 相同）
// - 图床：img.xchina.io/photos/{id}/000NN.jpg（原图）；正文渲染用 …_600x0.webp（600 宽预览）
//   → imageThumbFix 还原原图（与 se8.me 同一条正则）
// - 页面另有广告位背景图（z6v2p9a8.bkcdn.net，ExoClick）→ 由 imageOnlyHosts 排除
// - 该站与 se8.me / jliji.com 同一内容源
//
// 取图限制（与 se8.me 完全相同）：img.xchina.io 对服务端请求 403、页面内 fetch 受 CORS 限制，
// 因此「网格缩略图显示」与「打包下载」不可用；**请用「下载选中」**（浏览器原生下载，实测可用）。
import type { SiteDef } from '../schema'

export const xchina: SiteDef = {
  id: 'xchina',
  label: '小黄书 xChina',
  uiOrder: 140,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'xchina.co', role: 'primary' }],
  // Tailwind 类名不稳定 → 整页容器，靠图床白名单精确取正文图
  container: { tag: 'body', className: '' },
  // 第 1 页 /photo/{id}，其后 /photo/{id}/N → 基址需剥掉尾部 /N
  // （相册 id 为十六进制串，不会被 /\d+$/ 误伤）
  pagination: { kind: 'path-from-2' },
  baseUrl: { stripPagePath: 'suffix' },
  // 标题形如「潼潼 (2/34) - 小黄书 xChina」：只捕获总页数（引擎取组 1，见 schema 注释）
  maxPagePattern: { source: '\\(\\d+/(\\d+)\\)' },
  imageThumbFix: { source: '_\\d+x\\d+\\.webp$', flags: 'i', replace: '.jpg' },
  imageOnlyHosts: ['img.xchina.io'],
  titleStrip: [
    { source: '\\s*\\(\\d+/\\d+\\)\\s*' },
    { source: '\\s*-\\s*小黄书\\s*xChina\\s*$', flags: 'i' },
  ],
  linkParser: 'generic-post-links',
}
