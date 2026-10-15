// 8se.me（套图站，2026-10-11 实测探测适配）
//
// 探测结论（三轮浏览器内探测；该站主站与图床对服务端请求一律 403，属 Cloudflare 类反爬，无法离线抓取）：
// - 分页：/photo/id-{albumId}/{N}.html（用户给出的入口为 2.html）→ 第 1 页按同形态取 1.html
// - 标题：`{相册名} - {分类} - {分类2} - 8色人體攝影 - 第 N 頁`（站名与页码在尾部）
// - **正文图用 CSS `background-image` 渲染**（`<img>` 里只有站点 logo）→ 依赖引擎的 `style url(...)` 扫描
// - 缩略图 `img.xchina.io/photos/{id}/000NN_600x0.webp` → 原图 `img.xchina.io/photos/{id}/000NN.jpg`（imageThumbFix）
// - 推荐位在 `upload.xchina.io` / `xchina.click`（落在 `z-fixed-zones` 固定层）→ 用 imageOnlyHosts 排除
// - 抓取与取图均须走源页注入通道（world:'MAIN' 页面上下文 fetch，带 Cookie）→ 从 8se.me 页面打开插件
import type { SiteDef } from '../schema'

export const se8: SiteDef = {
  id: 'se8',
  label: '8se.me',
  uiOrder: 110,
  // 未探测到站内搜索接口 → 归入 Google 通道组
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  // 站点部署在区域子域（tw.8se.me）；primary 用裸域，匹配时自动覆盖子域
  endpoints: [{ host: '8se.me', role: 'primary' }],
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
  linkParser: 'generic-post-links',
}
