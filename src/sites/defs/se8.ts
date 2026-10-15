// 8se.me（套图站，2026-10-11 实测探测适配）
//
// 探测结论（三轮浏览器内探测；该站主站与图床对服务端请求一律 403，属 Cloudflare 类反爬，无法离线抓取）：
// - 分页：/photo/id-{albumId}/{N}.html（用户给出的入口为 2.html）→ 第 1 页按同形态取 1.html
// - 标题：`{相册名} - {分类} - {分类2} - 8色人體攝影 - 第 N 頁`（站名与页码在尾部）
// - **正文图用 CSS `background-image` 渲染**（`<img>` 里只有站点 logo）→ 依赖引擎的 `style url(...)` 扫描
// - 缩略图 `img.xchina.io/photos/{id}/000NN_600x0.webp` → 原图 `img.xchina.io/photos/{id}/000NN.jpg`（imageThumbFix）
// - 推荐位在 `upload.xchina.io` / `xchina.click`（落在 `z-fixed-zones` 固定层）→ 用 imageOnlyHosts 排除
// - **取图通道（2026-10-15 实测结论）**：
//   · 缩略图显示与「打包下载」都需要**读取字节** → 三条通道全不可用（扩展页 img 被服务器拒 /
//     页面内 fetch 被 CORS 拦（TypeError: Failed to fetch）/ 后台 fetch 403）
//     → 网格缩略图显示「加载失败」、打包取不到字节，均为预期现象
//   · 「下载选中」走 chrome.downloads.download（浏览器一级请求，不受 CORS 且带正常 Cookie）
//     → **实测可用** ✓ 该站请用「下载选中」，不要用「打包下载」
import type { SiteDef } from '../schema'

export const se8: SiteDef = {
  id: 'se8',
  label: '8se.me',
  uiOrder: 110,
  // 站内搜索（2026-10-15 用户提供）：/search.html?keyword={q} → 归入站内搜索组
  channels: ['site'],
  defaultChecked: false,
  folderTag: 'buondua',
  // 站点部署在区域子域：实测可用的是 tw.8se.me（用户使用的入口）→ primary 用该子域，
  // 裸域作为 mirror；搜索 URL 由 primary 生成，必须指向实际可用的域
  endpoints: [{ host: 'tw.8se.me', role: 'primary' }, { host: '8se.me', role: 'mirror' }],
  // 正文容器 class 未知且不稳定（正文是 background-image，探测的容器候选里没有它）
  // → 宽容器（整页 body）+ imageOnlyHosts 精确取图，不依赖容器 class
  container: { tag: 'body', className: '' },
  pagination: { kind: 'html-auto' },
  baseUrl: { stripPagePath: 'html' },
  // 两条规则按序执行（2026-10-15 实测两种相册形态）：
  //   多页相册标题：`… - 8色人體攝影 - 第 2 頁`（先去掉页码段）
  //   单页相册标题：`… - 8色人體攝影`（再去掉站名段）
  titleStrip: [
    { source: '\\s*-\\s*第\\s*\\d+\\s*頁\\s*$' },
    { source: '\\s*-\\s*8色人體攝影\\s*$' },
  ],
  imageThumbFix: { source: '_\\d+x\\d+\\.webp$', flags: 'i', replace: '.jpg' },
  imageOnlyHosts: ['img.xchina.io'],
  // 分页总数不可测（标题只显示当前页）→ 顺序翻页，靠「连续 3 页无新图」停止
  followPagesUntilEmpty: true,
  throttle: { fromPage: 2, delayMs: 1200 },
  // 站内搜索（2026-10-15）：/search.html?keyword={q}；分页暂按页码式 &page=N（pageStep: 1），
  // 待实测确认（若该站用偏移量或别的参数名，改这里一行即可）
  search: { kind: 'query', path: '/search.html', param: 'keyword', pageParam: 'page', pageStep: 1, pageBase: 1 },
  // 搜索结果只保留相册页（实测两种形态）：
  //   /photo/id-6ab82e0dab417.html（无斜杠）与 /photo/id-6ac1747801b63/2.html（有斜杠 + 页码）
  searchAlbumPattern: { source: '^/photo/id-[0-9a-f]+(?:\\.html|/\\d+\\.html)?/?$' },
  linkParser: 'generic-post-links',
}
