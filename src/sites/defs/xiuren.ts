// xiuren.org（秀人网 XiuRen，2026-10-17 用户浏览器内探测适配）
//
// 页面结构（用户提供 HTML 实测）：
// - 正文容器：`div.post`（页面唯一，包含全部相册图）
// - 每张图：`<span class="photoThum"><a href="原图"><img src="缩略图" width=… height=…></a></span>`
// - 缩略图：`http://www.xiuren.org/ru1mm/259/Thum/Thum-ru1mm-259-001.jpg`
// - 原图：  `http://www.xiuren.org/ru1mm/259/ru1mm-259-001.jpg`（1800×1200 / 1200×1800）
// - 单页 42P，无分页
// - 同域噪声：正文容器内还有 `images/2015/03/2001236775.jpg`（首图）与 `img/download_all.gif`（下载按钮）
//   → imagePathPattern 只保留 `/Thum/Thum-` 的缩略图，再经 imageThumbFix 还原原图
// - 标题：`[RU1MM_如壹写真] No.259 小鲜肉NUNU无内肉丝美臀套图 42P - 秀人网 XiuRen.org`
//
// 注意：站点为 http（非 https），扩展页 `<img>` 可能被混合内容策略拦截；
// 若实测网格大量失败，会走 blob 兜底（background fetch），届时再看日志判断。
import type { SiteDef } from '../schema'

export const xiuren: SiteDef = {
  id: 'xiuren',
  label: '秀人网 XiuRen',
  uiOrder: 150,
  channels: ['site'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [
    { host: 'www.xiuren.org', role: 'primary' },
    { host: 'xiuren.org', role: 'mirror' },
  ],
  // 唯一正文容器 div.post（id="post" 不是 class，不会误匹配）
  container: { tag: 'div', className: 'post' },
  // 单页相册：/ru1mm-259.html 一页 42 张，无分页
  pagination: { kind: 'single' },
  // 只扫 src（缩略图）；路径过滤剔除正文里的首图/下载按钮/广告图
  imageAttr: 'src',
  imagePathPattern: { source: '/Thum/Thum-' },
  // 缩略图 → 原图：/259/Thum/Thum-ru1mm-259-001.jpg → /259/ru1mm-259-001.jpg
  imageThumbFix: { source: '/Thum/Thum-', replace: '/' },
  titleStrip: [{ source: '\\s*-\\s*秀人网\\s*XiuRen\\.org\\s*$', flags: 'i' }],
  linkParser: 'generic-post-links',
}
