// rrwsh（4khd 镜像体系）：.entry-content + 路径式 /N 分页 + /search/{q}
//
// hosts 说明（FP-014 修复 8）：rrwsh.uuss.uk 为 4khd 模板镜像（/content/N/slug.html），
// 4khd.com 相册页被反爬网关拦截（302 → y5gx.uuss.uk/4khd.php），搜索命中后由 urlRewrite
// 改写为 rrwsh 域；iftye.uuss.uk 为同体系镜像。
import type { SiteDef } from '../schema'

export const rrwsh: SiteDef = {
  id: 'rrwsh',
  label: 'RRWSH (4KHD)',
  uiOrder: 20,
  channels: ['site'],
  // 2026-10-07 实测：rrwsh.uuss.uk 背后已换成「豆豆」视频站（iozl.uuss.uk），
  // 原 4KHD 图集站不在该域，解析器依赖的 li.wp-block-post 结构也已消失 → 暂不默认勾选（避免聚合搜索白跑）
  defaultChecked: false,
  folderTag: 'buondua',
  // 2026-10-15：实测 hfjsg.ssuu.uk 是**同一 4KHD 模板的可用镜像**
  // （页面 title 含「4KHD」、正文容器同为 div.entry-content、单页无分页）
  // 而 rrwsh.uuss.uk 已被「豆豆」视频站占用、4khd.com 被反爬网关拦截 → primary 改为实测可用的 hfjsg.ssuu.uk
  endpoints: [
    { host: 'hfjsg.ssuu.uk', role: 'primary' },
    { host: 'ssuu.uk', role: 'mirror' },
    { host: 'rrwsh.uuss.uk', role: 'mirror' },
    { host: '4khd.com', role: 'mirror' },
    { host: 'iftye.uuss.uk', role: 'mirror' },
  ],
  container: { tag: 'div', className: 'entry-content' },
  pagination: { kind: 'path' },
  baseUrl: { stripPagePath: 'suffix' },
  maxPagePattern: { source: 'Page\\s+\\d+\\s+of\\s+(\\d+)', flags: 'i' },
  titleStrip: [
    { source: '\\s*[-–—]\\s*Page\\s+\\d+\\s+of\\s+\\d+\\s*[-–—]\\s*[^-]*$', flags: 'i' },
    { source: '\\s*[-–—]\\s*4KHD\\s*$', flags: 'i' },
  ],
  // 2026-11-11：站点改版成 SPA —— 服务端 HTML 是空壳（约 1991 字节、0 个 <img>、
  // title 为站点默认标题），后台/页面内 fetch 都拿不到图，改由浏览器 DOM 通道逐页渲染提取。
  // 因为空壳 HTML 里读不到总页数，必须用顺序翻页（DOM 通道会按页走）。
  // 代价：每页要开临时标签页 + 等渲染约 1.2 秒，11 页约 20~30 秒。
  followPagesUntilEmpty: true,
  throttle: { fromPage: 2, delayMs: 800 },
  // SPA 站点：服务端 HTML 无图 → 必须在浏览器里渲染后读 DOM（详见 fetchAlbumAllPages 的 domFetchFn）
  domFallback: true,
  // 2026-11-11：图床从 wp.com 换成 img.ssuu.uk（用户探测样本 29 张全为该域）。
  // 图片带 .webp 扩展名，引擎按扩展名即可识别；这里把 ssuu.uk 也纳入白名单，
  // 以防将来出现「无扩展名」的图片 URL 被漏掉。
  // **同时用于 DOM 通道的图床过滤**：SPA 站点的 DOM 里混有推荐位/广告/相关文章缩略图，
  // 只保留正文图床（img.ssuu.uk）的图片，与 HTML 解析口径一致。
  imageHosts: ['wp.com', 'ssuu.uk'],
  imageOnlyHosts: ['img.ssuu.uk'],
  // 2026-11-11：**移除站内搜索**（原为 path-template: '/search/{q}'）。
  // 站点改版成 SPA 后，搜索结果页与相册页一样只剩空壳，fetch 拿不到任何结果 ——
  // 每次聚合搜索都会为它白跑一轮请求再失败，实测表现为「搜索变慢」。
  // 与其留一条必然失败的通道拖慢全局搜索，不如明确不支持：该站只保留「贴相册 URL 直接抓」。
  // 4khd.com 结果链接改写回 rrwsh 域（primary）
  urlRewrite: [{ fromHost: '4khd.com' }],
  linkParser: 'rrwsh-cards',
  imageCountRule: 'rrwsh-photos',
}
