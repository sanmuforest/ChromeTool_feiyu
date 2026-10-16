// 图站模块（FP-018）—— 定义编译 + 通用相册解析
//
// 编译：SiteDef → GallerySiteConfig（函数实现搬移自原 lib/gallery-sites.ts，行为逐字等价）
// 通用解析：正文容器提取 / 图片收集 / 最大页数 / 页面标题
//
// 阶段 1 约束：所有函数实现体与原版一致，仅「域名」来源由站点定义派生，
// 保证换域名 / 新增站点只需改数据（见 设计文档/变更日志/2026-10-07-001 的等价性对比结论）。

import { SITE_DEFS } from './defs'
import type { BuonduaImage } from '../lib/types'
import type { GallerySiteConfig, RegexSpec, SiteDef } from './schema'

/** 正则元字符转义（域名/类名拼入正则时使用） */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toRegExp(spec: RegexSpec): RegExp {
  return new RegExp(spec.source, spec.flags ?? '')
}

/** 主域（URL 基址 / 改写目标）：显式 role=primary 优先，其次首个非 m./www./mobile. 域 */
export function primaryHostOf(def: SiteDef): string {
  const explicit = def.endpoints.find((e) => e.role === 'primary')
  if (explicit) return explicit.host
  const bare = def.endpoints.find((e) => !/^(m|www|mobile)\./i.test(e.host))
  return (bare ?? def.endpoints[0]).host
}

/** 搜索基址 host：显式 searchBaseHost 优先，其次 role=search 端点，最后主域 */
export function searchHostOf(def: SiteDef): string {
  if (def.searchBaseHost) return def.searchBaseHost
  const search = def.endpoints.find((e) => e.role === 'search')
  return search ? search.host : primaryHostOf(def)
}

/** 分页 URL 构造（对应定义里的 pagination 声明） */
function buildPageUrl(def: SiteDef, base: string, page: number): string {
  switch (def.pagination.kind) {
    case 'query':
      return `${base}?${def.pagination.param ?? 'page'}=${page}`
    case 'path':
      return `${base}/${page}`
    case 'path-from-2':
      return page <= 1 ? base : `${base}/${page}`
    case 'path-slash-from-2':
      return page <= 1 ? base : `${base.replace(/\/?$/, '/')}${page}/`
    case 'page-path-slash':
      // WP 标准分页：/page/N/（第 1 页不带 page 段）
      return page <= 1 ? base : `${base.replace(/\/?$/, '/')}page/${page}/`
    case 'html-from-1':
      // 全页 /N.html（8se.me 实测形态：/photo/id-xxx/2.html）
      return `${base.replace(/\/?$/, '/')}${page}.html`
    case 'html-from-2':
      // 第 1 页用基址，其后 /N.html
      return page <= 1 ? base : `${base.replace(/\/?$/, '/')}${page}.html`
    case 'html-auto':
      // 2026-10-15（8se.me）：基址以 .html 结尾 = 单页相册 → 第 1 页即基址本身；
      // 后续页返回同一基址，由抓取流程的「连续页无新图」检测自然停止（不制造 404 以免中断抓取）
      if (/\.html?$/i.test(base)) return base
      return `${base.replace(/\/?$/, '/')}${page}.html`
    case 'single':
      return base
    default:
      return base
  }
}

/** 相册基址提取（去 query/hash；按需去除路径式分页后缀） */
function buildBaseUrl(def: SiteDef, url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    u.hash = ''
    const strip = def.baseUrl?.stripPagePath ?? 'none'
    if (strip === 'none') return u.href
    let path: string
    if (strip === 'suffix') {
      path = u.pathname.replace(/\/\d+$/, '')
    } else if (strip === 'page-segment') {
      // WP 标准分页：/page/N/ 或 /page/N → 去掉该段并保留结尾斜杠
      path = u.pathname.replace(/\/page\/\d+\/?$/, '/')
    } else if (strip === 'html') {
      // /N.html 分页（8se.me）：去掉尾部 /N.html；并把「无斜杠的 xxx.html」也规范化为目录形式。
      // 2026-10-15 实测：…/photo/id-xxx.html 与 …/photo/id-xxx/2.html 指向**同一相册**，
      // 必须归一到同一基址 …/photo/id-xxx/，否则前者会被当成单页而只抓到第 1 页
      let p = u.pathname.replace(/\/\d+\.html?$/i, '/')
      if (/\.html?$/i.test(p)) p = p.replace(/\.html?$/i, '/')
      path = p
    } else {
      path = u.pathname.replace(/\/\d+\/$/, '').replace(/\/\d+$/, '')
    }
    return `${u.origin}${path}`
  } catch {
    return url
  }
}

/** 标题清理：HTML 实体解码 → 按序 replace → trim
 *  2026-10-15：后台从 HTML `<title>` 取标题时带实体（如 `瑄瑄&amp;依依`），不解码会直接进文件夹名；
 *  content script 的 document.title 已是解码后的，两者需一致 */
function buildCleanTitle(def: SiteDef, title: string): string {
  let out = title
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
  for (const spec of def.titleStrip ?? []) out = out.replace(toRegExp(spec), '')
  return out.trim()
}

/** 搜索 URL 构造（无搜索通道返回 null） */
function buildSearchUrl(def: SiteDef, q: string, page: number): string | null {
  const search = def.search
  if (!search) return null
  const host = searchHostOf(def)
  const query = encodeURIComponent(q)
  switch (search.kind) {
    case 'query': {
      const base = `https://${host}${search.path ?? '/'}?${search.param}=${query}`
      if (page > 1 && search.pageParam) {
        // 页码 = (page-1) × pageStep + pageBase（2026-10-15 新增 pageBase）：
        // 偏移量式站点（buondua 的 &start=）保持默认 pageBase=0；页码式站点（如 8se.me 的 &page=2）配 pageBase=1
        const value = (page - 1) * (search.pageStep ?? 10) + (search.pageBase ?? 0)
        return `${base}&${search.pageParam}=${value}`
      }
      return base
    }
    case 'path-template': {
      // 仅第 1 页（部分站搜索无分页）
      if (page > 1) return null
      return `https://${host}${search.template.replace('{q}', query)}`
    }
    case 'wp-query-path-page': {
      // path（2026-10-10）：搜索页可能不在根路径（如 knit.bid 的 /ja/search/）
      const basePath = (search.path ?? '/').replace(/\/?$/, '/')
      if (page <= 1) return `https://${host}${basePath}?${search.param}=${query}`
      return `https://${host}${basePath}page/${page}${search.trailingSlash ? '/' : ''}?${search.param}=${query}`
    }
    case 'google-sitesearch': {
      // Google 已拒绝 gbv=1 / sitesearch= 老参数（2026-10-07 实测直接返回 403），改用现行 site: 语法。
      // 2026-10-08 体检修复（P0-1）：site: 必须用**主域**而非 www 子域 —— 旧 sitesearch= 参数语义宽于
      // site: 操作符，保留 www 前缀会把查询限死在子域（漏掉裸域/其它子域的相册页，表现为「搜不到但不报错」）；
      // 同时与 googleSearchConfig（Google 全站模式/Google 组）保持同一目标域名。
      const siteQuery = encodeURIComponent(`${q} site:${primaryHostOf(def)}`)
      return `https://www.google.com/search?q=${siteQuery}&hl=zh-CN${page > 1 ? `&start=${(page - 1) * 10}` : ''}`
    }
    default:
      return null
  }
}

/** 搜索结果 URL 改写：镜像域名 → 本站主域 */
function buildRewriteUrl(def: SiteDef, url: string): string {
  let out = url
  for (const rule of def.urlRewrite ?? []) {
    out = out.replace(
      new RegExp(`https?://(?:www\\.)?${escapeRegex(rule.fromHost)}`, 'i'),
      `https://${primaryHostOf(def)}`,
    )
  }
  return out
}

/** 图片 URL 清洗：缩略图还原原图（imageThumbFix）+ CDN 缩放参数修正（imageQueryFix） */
function buildImageUrlClean(def: SiteDef, url: string): string {
  let out = url
  const tf = def.imageThumbFix
  if (tf) {
    try {
      out = out.replace(new RegExp(tf.source, tf.flags ?? ''), tf.replace)
    } catch {
      // 正则非法时保持原样（单个定义写错不应导致整站抓取失败）
    }
  }
  for (const fix of def.imageQueryFix ?? []) {
    out = out.replace(new RegExp(`[?&]${escapeRegex(fix.param)}=\\d+`), `?${fix.param}=${fix.value}`)
  }
  return out
}

/** 列表页分页方式：缺省按站点分页派生（FP-023） */
function deriveListPageKind(def: SiteDef): 'query' | 'path' | 'path-slash' {
  switch (def.pagination.kind) {
    case 'query':
      return 'query'
    case 'path-slash-from-2':
      return 'path-slash'
    default:
      return 'path'
  }
}

/** 列表页分页 URL 构造（FP-023 列表浏览）：?page=N 或 /page/N[/]
 *  pageKindOverride：界面手动指定的分页方式（2026-10-08 体检 P0-3），优先于定义与派生值 */
export function listPageUrl(
  site: GallerySiteConfig,
  base: string,
  page: number,
  pageKindOverride?: 'query' | 'path' | 'path-slash',
): string {
  if (page <= 1) return base
  const cfg = site.def.listPages?.[0]
  const kind = pageKindOverride ?? cfg?.pageKind ?? deriveListPageKind(site.def)
  if (kind === 'query') {
    const param = cfg?.param ?? 'page'
    return `${base}${base.includes('?') ? '&' : '?'}${param}=${page}`
  }
  const trimmed = base.replace(/\/$/, '')
  return kind === 'path-slash' ? `${trimmed}/page/${page}/` : `${trimmed}/page/${page}`
}

/** 定义 → 运行期站点对象 */
export function compileSite(def: SiteDef): GallerySiteConfig {
  const site: GallerySiteConfig = {
    id: def.id,
    hosts: def.endpoints.map((e) => e.host),
    // className 为空时匹配该标签的任意出现（2026-10-11）：配合 imageOnlyHosts 使用整页容器，
    // 适用于「正文图床独立、但容器 class 未知或不稳定」的站点（如 8se.me 正文为 CSS 背景图）
    containerOpen: def.container.className
      ? new RegExp(`<${def.container.tag}[^>]*class="[^"]*${escapeRegex(def.container.className)}[^"]*"[^>]*>`)
      : new RegExp(`<${def.container.tag}(?:\\s[^>]*)?>`, 'i'),
    pagePattern: def.maxPagePattern ? toRegExp(def.maxPagePattern) : /(?!)0/,
    pageUrl: (base, page) => buildPageUrl(def, base, page),
    baseUrlOf: (url) => buildBaseUrl(def, url),
    cleanTitle: (title) => buildCleanTitle(def, title),
    searchAlbumPath: def.searchAlbumPath,
    def,
  }
  if (def.search) site.searchUrl = (q, page) => buildSearchUrl(def, q, page)
  if (def.searchAlbumPattern) site.searchAlbumPattern = toRegExp(def.searchAlbumPattern)
  if (def.urlRewrite?.length) site.rewriteUrl = (url) => buildRewriteUrl(def, url)
  if (def.imageQueryFix?.length || def.imageThumbFix) site.imageUrlClean = (url) => buildImageUrlClean(def, url)
  return site
}

/** 全部运行期站点（顺序 = SITE_DEFS 顺序） */
export const COMPILED_SITES: GallerySiteConfig[] = SITE_DEFS.map(compileSite)

/** 图床白名单（无扩展名图片判定）：全部站点 imageHosts 去重并集 */
const IMAGE_HOSTS = [...new Set(SITE_DEFS.flatMap((d) => d.imageHosts ?? []))]
const IMG_HOST = IMAGE_HOSTS.length > 0 ? new RegExp(IMAGE_HOSTS.map(escapeRegex).join('|'), 'i') : /(?!)/

/** 提取正文容器块（div 深度匹配，从开标签到闭合） */
/** 提取容器块：从开标签起按**同标签**嵌套深度配对到闭合标签
 *  tag（2026-10-11 修复）：原先硬编码只数 `<div>`，容器为非 div 标签时（如 ilovexs 的
 *  `<section class="image-gallery">`）闭合标签不被识别、深度永不归零 → 一直截取到 HTML 末尾，
 *  把容器之后的内容一并吞入（实测 ilovexs 解析出 56 张，其中 16 张是相关推荐封面） */
function extractContainerBlock(html: string, openTag: RegExp, tag = 'div'): string {
  const re = new RegExp(openTag.source, openTag.flags.replace('g', ''))
  const m = re.exec(html)
  if (!m) return ''
  let i = m.index + m[0].length
  let depth = 1
  const closeTag = `</${tag}>`
  const scan = new RegExp(`<${tag}[\\s>]|${closeTag}`, 'g')
  scan.lastIndex = i
  let mm: RegExpExecArray | null
  while ((mm = scan.exec(html)) !== null) {
    if (mm[0] === closeTag) depth--
    else depth++
    if (depth === 0) return html.slice(i, mm.index)
  }
  return html.slice(i)
}

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i

/** 从正文容器解析图片：收集块内所有图片 URL（a href / img src），去重 */
export function parseGalleryImages(html: string, baseUrl: string, site: GallerySiteConfig): BuonduaImage[] {
  const block = extractContainerBlock(html, site.containerOpen, site.def.container.tag)
  if (!block) return []
  const seen = new Set<string>()
  const urls: string[] = []
  /** 相对路径 → 绝对 URL（2026-10-10：knit.bid 等站正文图片为 root-relative，如 /static/images/…） */
  const toAbsolute = (raw: string): string | null => {
    if (!raw) return null
    if (/^https?:\/\//i.test(raw)) return raw
    if (/^\/\//.test(raw)) return `https:${raw}` // 协议相对
    if (/^(data|blob|javascript):/i.test(raw)) return null
    try {
      return new URL(raw, baseUrl).href
    } catch {
      return null
    }
  }
  const collect = (raw: string): void => {
    const u = toAbsolute(raw)
    if (!u) return
    if (/\.(js|css|svg|ico)(\?|$)/i.test(u)) return
    // 图片判定：扩展名优先；非图片扩展名时按 hostname 白名单（各站 imageHosts 并集），
    // 避免 addtoany 分享链接内嵌目标 URL 被字符串误匹配
    let host = ''
    try {
      host = new URL(u).hostname
    } catch {
      return
    }
    if (!IMG_EXT.test(u) && !IMG_HOST.test(host)) return
    // 占位图过滤（2026-10-15）：懒加载占位图会混入正文（实测 xiuzhai5 的 /img/load.gif）
    if (/\/(?:load|loading|placeholder|blank|spacer|pixel|1x1|lazyload|grey)\.(?:gif|png|jpe?g|webp)$/i.test(u)) return
    // 只保留指定图床（2026-10-11）：正文图床与站点自身/推荐位不同时，用它精确过滤
    const onlyHosts = site.def.imageOnlyHosts
    if (onlyHosts?.length && !onlyHosts.some((h) => host === h || host.endsWith(`.${h}`))) return
    // 页面链接（.html 等）非图片：排除（jrants 的 page-links 分页链接在正文容器内）
    if (/\.html?($|[\/?#])/i.test(u)) return
    // 数字路径分页链接（/N/ 或 /N 结尾，无扩展名）非图片：排除（pixibb 路径式分页在正文容器内）
    try {
      if (/\/\d+\/?$/.test(new URL(u).pathname)) return
    } catch {
      return
    }
    if (seen.has(u)) return
    seen.add(u)
    urls.push(u)
  }
  let m: RegExpExecArray | null
  const imgAttr = site.def.imageAttr
  if (imgAttr) {
    // 站点声明了图片属性（2026-10-15）：如 jliji.com 的真图在 data-full、src 只是缩略图。
    // 声明后只扫该属性，避免把缩略图与原图同时收进来
    const reAttr = new RegExp(`${escapeRegex(imgAttr)}="([^"]+)"`, 'gi')
    while ((m = reAttr.exec(block)) !== null) {
      collect(m[1])
    }
  } else {
    // 同时匹配绝对与相对 URL（相对路径在 collect 内用页面基址解析为绝对 URL）。
    // 2026-10-15：加入 data-src —— 大量站点用「src=占位图 + data-src=真图」的懒加载写法
    // （实测 xiuzhai5：src=/img/load.gif、data-src=真图；只扫 src 会漏掉大半图片）
    const re = /(?:href|src|data-src)="([^"]+)"/g
    while ((m = re.exec(block)) !== null) {
      collect(m[1])
    }
    // 正文图也可能是 CSS 背景（2026-10-11：8se.me 实测 —— 正文用 background-image 渲染，
    // <img> 里只有站点 logo，导致纯 img 解析在该站永远 0 张）
    const reStyle = /style="[^"]*url\((['"]?)([^'")]+)\1\)[^"]*"/gi
    while ((m = reStyle.exec(block)) !== null) {
      collect(m[2])
    }
  }
  // 站点图片 URL 清洗（CDN 缩放参数放大等）
  const clean = site.imageUrlClean
  return urls.map((url) => {
    const finalUrl = clean ? clean(url) : url
    let filename = ''
    try {
      filename = decodeURIComponent(new URL(finalUrl).pathname.split('/').pop() || '')
    } catch {
      filename = finalUrl.split('/').pop() || ''
    }
    filename = filename.replace(/[\\/:*?"<>|]/g, '_')
    return { url: finalUrl, filename }
  })
}

/** 解析最大页数：标题 Page 标记（组2）优先，分页链接兜底
 * 注意：rrwsh 首页标题无 Page 标记（标记只在 /N 页面），需用 page-numbers 链接兜底 */
export function parseGalleryMaxPage(html: string, site: GallerySiteConfig): number {
  const m = html.match(site.pagePattern)
  if (m) {
    const n = Number(m[1] ?? m[2])
    if (n > 0) return n
  }
  let max = 1
  // 分页链接：page-numbers class（路径式 /N 或 ?page=N 均含尾部数字）
  const re = /<a[^>]*class="[^"]*page-numbers[^"]*"[^>]*href="[^"]*(\d+)"[^>]*>/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(html)) !== null) {
    max = Math.max(max, Number(mm[1]) || 1)
  }
  // 兜底：?page=N 参数链接
  const re2 = /href="[^"]*page=(\d+)[^"]*"/g
  while ((mm = re2.exec(html)) !== null) {
    max = Math.max(max, Number(mm[1]) || 1)
  }
  // 兜底3：href 在前 class 在后的分页链接（WP post-page-numbers：<a href=".../N" class="post-page-numbers">，属性顺序与 re 相反）
  const re3 = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*page-numbers[^"]*"[^>]*>/g
  while ((mm = re3.exec(html)) !== null) {
    const n = Number(mm[1].match(/(\d+)\/?$/)?.[1] || 0)
    if (n > 0) max = Math.max(max, n)
  }
  // 兜底4（2026-10-10）：任意位置的 /page/N/ 引用（分页链接可能不在 <a> 标签内，如 knit.bid）
  const re4 = /\/page\/(\d+)\/?/g
  while ((mm = re4.exec(html)) !== null) {
    const n = Number(mm[1]) || 0
    if (n > 0) max = Math.max(max, n)
  }
  return max
}

/** 页面标题（文件夹名用，已 clean）：h1 优先，og:title / title / h2 兜底 */
export function parseGalleryPageTitle(html: string, site: GallerySiteConfig): string {
  let raw = ''
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/)
  if (h1 && h1[1].trim()) raw = h1[1].trim()
  if (!raw) {
    const og = html.match(/<meta property="og:title" content="([^"]*)"/)
    if (og && og[1].trim()) raw = og[1].trim()
  }
  if (!raw) {
    const title = html.match(/<title>([^<]+)<\/title>/)
    if (title) raw = title[1].trim()
  }
  if (!raw) {
    // h2 兜底（kaizty 等无 title 标签的站点）：取第一个长度合理的内容标题（过滤短文本如 Advertising）
    const h2s = [...html.matchAll(/<h2[^>]*>([^<]{16,})<\/h2>/g)]
    if (h2s.length > 0) raw = h2s[0][1].trim()
  }
  return site.cleanTitle(raw)
}
