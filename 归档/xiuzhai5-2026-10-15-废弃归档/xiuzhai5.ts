// xiuzhai5.com（秀宅，2026-10-15 用户浏览器内探测适配）
//
// 探测结论（相册页 /19544 与 /19544?page=2）：
// - 相册：/{id}，第 1 页不带参数，其后 `?page=N`（query 式）
// - 正文容器：div.article-fulltext（父级链 p < div.article-fulltext < div.article.content < …）
//   —— 与 buondua 同一套模板
// - 正文图床：img.xiuzhai5.com/yishijie/photo/uploadfile/{年月}/{日}/{hash}.jpg（每页 40 张）
// - 底部推荐区在图床 img.05mm3.cc、外层 div.bottom-articles → 容器选对即自动隔离，无需图床白名单
// - 标题：`{相册名} - 第 N 页`（**无站名后缀**，只需剥页码）
// - 总页数可由分页链接（?page=N）自动提取（实测 7 页），无需顺序翻页
// - 页面有站内搜索表单，但参数名未知 → 暂归 Google 组，拿到搜索页 URL 后改
import type { SiteDef } from '../schema'

export const xiuzhai5: SiteDef = {
  id: 'xiuzhai5',
  label: '秀宅',
  uiOrder: 130,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'xiuzhai5.com', role: 'primary' }],
  container: { tag: 'div', className: 'article-fulltext' },
  pagination: { kind: 'query', param: 'page' },
  // 标题末尾为「- 第 N 页」（简体「页」），无站名后缀
  titleStrip: [{ source: '\\s*-\\s*第\\s*\\d+\\s*页\\s*$' }],
  linkParser: 'generic-post-links',
}
