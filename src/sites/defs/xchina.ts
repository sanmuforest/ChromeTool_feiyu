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
//
// 站内搜索（2026-10-15 用户浏览器内探测 https://xchina.co/search?q=xc）：
// - 搜索页：/search?q={q}，标题「xc - 站内搜索 - 小黄书 xChina」
// - **探测分页数 = 0**（页面无分页链接）→ 用 path-template，只取第 1 页，避免重复请求同一 URL
// - 结果卡片：span.ph > a.group.block（正文图 img.xchina.io/photos2/{id}/…_600x0.webp）
// - 页面另有侧边栏推荐（upload.xchina.io / xchina.click）与视频结果（r2.xchina.download，aspect-video）
//   → 用 searchAlbumPath '/photo/' 收窄为相册链接
// - ⚠️ 该站有 Cloudflare：探测走浏览器 DOM，后台 fetch 是否被 CF 拦截需实测日志确认
import type { SiteDef } from '../schema'

export const xchina: SiteDef = {
  id: 'xchina',
  label: '小黄书 xChina',
  uiOrder: 140,
  channels: ['site'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'xchina.co', role: 'primary' }],
  // Tailwind 类名不稳定 → 整页容器，靠图床白名单精确取正文图
  container: { tag: 'body', className: '' },
  // 第 1 页 /photo/{id}，其后 /photo/{id}/N → 基址需剥掉尾部 /N
  // （相册 id 为十六进制串，不会被 /\d+$/ 误伤）
  pagination: { kind: 'path-from-2' },
  baseUrl: { stripPagePath: 'suffix' },
  // 标题形如「潼潼 (2/34) - 小黄书 xChina」或新版「极品小清新 - 第 2 页 - 希威社 - 小黄书 xChina」：
  // - 旧格式括号内给总页数（只捕获组 1 = 总页数，见 schema 注释）
  // - **新版第 2 页起标题不再给总页数**（「第 2 页」），且页面探测无分页链接
  //   → 必须靠 followPagesUntilEmpty 顺序翻页；maxPagePattern 仅作旧格式兼容
  maxPagePattern: { source: '\\(\\d+/(\\d+)\\)' },
  followPagesUntilEmpty: true,
  imageThumbFix: { source: '_\\d+x\\d+\\.webp$', flags: 'i', replace: '.jpg' },
  imageOnlyHosts: ['img.xchina.io'],
  titleStrip: [
    { source: '\\s*\\(\\d+/\\d+\\)\\s*' },
    // 新版第 2 页起标题带「- 第 N 页」，清理掉避免进入文件夹名
    { source: '\\s*-\\s*第\\s*\\d+\\s*页\\s*' },
    { source: '\\s*-\\s*小黄书\\s*xChina\\s*$', flags: 'i' },
  ],
  // 站内搜索：/search?q={q}。探测无分页链接 → path-template（仅第 1 页）
  search: { kind: 'path-template', template: '/search?q={q}' },
  // 结果收窄为相册链接（排除侧边栏推荐与视频结果）
  searchAlbumPath: '/photo/',
  linkParser: 'generic-post-links',
}
