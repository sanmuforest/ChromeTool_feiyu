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
    const path =
      strip === 'suffix'
        ? u.pathname.replace(/\/\d+$/, '')
        : u.pathname.replace(/\/\d+\/$/, '').replace(/\/\d+$/, '')
    return `${u.origin}${path}`
  } catch {
    return url
  }
}

/** 标题清理：按序 replace + trim */
function buildCleanTitle(def: SiteDef, title: string): string {
  let out = title
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
        return `${base}&${search.pageParam}=${(page - 1) * (search.pageStep ?? 10)}`
      }
      return base
    }
    case 'path-template': {
      // 仅第 1 页（部分站搜索无分页）
      if (page > 1) return null
      return `https://${host}${search.template.replace('{q}', query)}`
    }
    case 'wp-query-path-page': {
      if (page <= 1) return `https://${host}/?${search.param}=${query}`
      return `https://${host}/page/${page}${search.trailingSlash ? '/' : ''}?${search.param}=${query}`
    }
    case 'google-sitesearch': {
      // Google 已拒绝 gbv=1 / sitesearch= 老参数（2026-10-07 实测直接返回 403），改用现行 site: 语法
      const siteHost = `www.${primaryHostOf(def)}`
      const siteQuery = encodeURIComponent(`${q} site:${siteHost}`)
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

/** 图片 URL query 修正（CDN 缩放参数放大等） */
function buildImageUrlClean(def: SiteDef, url: string): string {
  let out = url
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

/** 列表页分页 URL 构造（FP-023 列表浏览）：?page=N 或 /page/N[/] */
export function listPageUrl(site: GallerySiteConfig, base: string, page: number): string {
  if (page <= 1) return base
  const cfg = site.def.listPages?.[0]
  const kind = cfg?.pageKind ?? deriveListPageKind(site.def)
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
    containerOpen: new RegExp(
      `<${def.container.tag}[^>]*class="[^"]*${escapeRegex(def.container.className)}[^"]*"[^>]*>`,
    ),
    pagePattern: def.maxPagePattern ? toRegExp(def.maxPagePattern) : /(?!)0/,
    pageUrl: (base, page) => buildPageUrl(def, base, page),
    baseUrlOf: (url) => buildBaseUrl(def, url),
    cleanTitle: (title) => buildCleanTitle(def, title),
    searchAlbumPath: def.searchAlbumPath,
    def,
  }
  if (def.search) site.searchUrl = (q, page) => buildSearchUrl(def, q, page)
  if (def.urlRewrite?.length) site.rewriteUrl = (url) => buildRewriteUrl(def, url)
  if (def.imageQueryFix?.length) site.imageUrlClean = (url) => buildImageUrlClean(def, url)
  return site
}

/** 全部运行期站点（顺序 = SITE_DEFS 顺序） */
export const COMPILED_SITES: GallerySiteConfig[] = SITE_DEFS.map(compileSite)

/** 图床白名单（无扩展名图片判定）：全部站点 imageHosts 去重并集 */
const IMAGE_HOSTS = [...new Set(SITE_DEFS.flatMap((d) => d.imageHosts ?? []))]
const IMG_HOST = IMAGE_HOSTS.length > 0 ? new RegExp(IMAGE_HOSTS.map(escapeRegex).join('|'), 'i') : /(?!)/

/** 提取正文容器块（div 深度匹配，从开标签到闭合） */
function extractContainerBlock(html: string, openTag: RegExp): string {
  const re = new RegExp(openTag.source, openTag.flags.replace('g', ''))
  const m = re.exec(html)
  if (!m) return ''
  let i = m.index + m[0].length
  let depth = 1
  const scan = /<div[\s>]|<\/div>/g
  scan.lastIndex = i
  let mm: RegExpExecArray | null
  while ((mm = scan.exec(html)) !== null) {
    if (mm[0] === '</div>') depth--
    else depth++
    if (depth === 0) return html.slice(i, mm.index)
  }
  return html.slice(i)
}

const IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i

/** 从正文容器解析图片：收集块内所有图片 URL（a href / img src），去重 */
export function parseGalleryImages(html: string, _baseUrl: string, site: GallerySiteConfig): BuonduaImage[] {
  const block = extractContainerBlock(html, site.containerOpen)
  if (!block) return []
  const seen = new Set<string>()
  const urls: string[] = []
  const collect = (u: string): void => {
    if (!u || !/^https?:\/\//i.test(u)) return
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
  const re = /href="(https?:\/\/[^"]+)"|src="(https?:\/\/[^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    collect(m[1] || m[2])
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
