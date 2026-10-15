// 图站模块（FP-018）—— 搜索结果 / 推荐链接 解析器注册表
//
// 目的：把原先散落在 buondua-service.ts 与 lib/gallery-sites.ts 里的「按站点 id 分支」
// 收拢成「按定义字段（linkParser / scan / imageCountRule）查表」，新增站点无需改 switch。
//
// 阶段 1 约束：各解析器实现体与原版一致（原样搬移），仅调用入口由注册表分发。

import { parseAllPostLinks, parseRecommendedLinks } from '../lib/buondua-parse'
import { parseJrantsPostLinks } from '../lib/jrants-parse'
import { parsePixibbPostLinks } from '../lib/pixibb-parse'
import type { BuonduaLinkItem } from '../lib/types'
import { COMPILED_SITES } from './engine'
import type { GallerySiteConfig, ImageCountRuleName, ScanParserName } from './schema'

/** 统一解析器签名：html + 基址 + 站点（站点用于 hosts / searchAlbumPath / cleanTitle） */
type LinkParser = (html: string, base: string, site: GallerySiteConfig) => BuonduaLinkItem[]

/** 推荐/其他链接扫描上下文（others 分支需要排除推荐区已收录的 URL） */
interface ScanContext {
  recUrls: Set<string>
}

type ScanParser = (html: string, base: string, ctx: ScanContext) => BuonduaLinkItem[]

/** kaizty 相册链接解析：/photos/{base64}.html（页面其他相册，含标题附近文本） */
export function parseKaiztyPostLinks(html: string, _baseUrl: string): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*href="([^"]*\/photos\/[A-Za-z0-9+/=_-]+\.html)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const url = m[1]
    const abs = /^https?:\/\//i.test(url) ? url : `https:${url}`
    if (seen.has(abs)) continue
    seen.add(abs)
    let title = (m[0].match(/title="([^"]*)"/)?.[1] || '').trim()
    if (!title) {
      title = m[0].replace(/<[^>]*>/g, '').trim()
    }
    if (!title) {
      // 该 a 附近（后 600 字符）找相册标题（含 Page X/Y 的链接文本）
      const block = html.slice(m.index, m.index + 600)
      const tm = block.match(/>([^<>]{6,})</)
      if (tm) title = tm[1].trim()
    }
    const countMatch = title.match(/Page\s+(\d+)\s*\/\s*(\d+)/i)
    void countMatch // kaizty 标题含 Page X/Y 为页数非张数，imageCount 留空
    items.push({ url: abs, title: title || abs, coverUrl: '', imageCount: undefined })
  }
  return items
}

/** rrwsh（4khd 镜像）搜索页专用解析（FP-012）：逐 li.wp-block-post 卡片提取
 *  结构（实测 2026-08-14）：封面 <figure class="wp-block-post-featured-image"><a href=文章><img src=封面></a></figure>
 *  标题 <h2 class="wp-block-post-title"><a href=文章>标题[NNNMB-NNNphotos]</a></h2>（同 href，完美配对） */
export function parseRrwshSearchLinks(html: string, _baseUrl: string): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()
  const cardRe = /<li\b[^>]*class="[^"]*wp-block-post[^"]*"[^>]*>([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = cardRe.exec(html)) !== null) {
    const card = m[1]
    const lm = card.match(/<a[^>]*href="(https?:\/\/(?:www\.)?(?:4khd\.com|rrwsh\.uuss\.uk)[^"]*\/content\/[^"]+)"[^>]*>/i)
    if (!lm) continue
    const url = lm[1]
    if (seen.has(url)) continue
    let title = ''
    const tm = card.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)
    if (tm) title = tm[1].replace(/<[^>]*>/g, '').trim()
    let cover = ''
    const im = card.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i)
    if (im) cover = im[1]
    items.push({ url, title: title || url, coverUrl: cover, imageCount: undefined })
    seen.add(url)
  }
  return items
}

/** 通用站点文章链接解析（聚合搜索 / 列表浏览用，无专用解析器时兜底）：
 *  提取指定 hosts（含子域）下的文章链接，排除首页/分类/标签/搜索/作者/分页等路径
 *  标题：a title 属性 → a 文本 → 附近文本；封面不提取（专用解析器负责）
 *
 *  opts.skipNumericFilter（2026-10-10）：跳过「尾部数字路径视为分页」的排除。
 *  该规则用于排除 /slug/2 形式的分页，但会把「ID 结尾的相册 URL」误杀（如 knit.bid 的 /ja/article/27027/）。
 *  当站点已配置 searchAlbumPath / searchAlbumPattern 这类精确过滤规则时，应跳过此启发式排除。 */
export function parseSitePostLinks(
  html: string,
  baseUrl: string,
  hosts: string[],
  opts?: { skipNumericFilter?: boolean },
): BuonduaLinkItem[] {
  const byUrl = new Map<string, BuonduaLinkItem>()
  const re = /<a[^>]*href="([^"]*)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1], baseUrl)
      const host = u.hostname.replace(/^www\./, '')
      const hostOk = hosts.some((h) => host === h || host.endsWith(`.${h}`))
      if (!hostOk) continue
      const path = u.pathname
      if (path === '/' || path === '/index.php') continue
      if (/^\/?(tag|category|search|author|page|pages|wp-|feed|comments|premium|videos|albums|home\d?|signup|login|recovery)\//i.test(path)) continue
      if (!opts?.skipNumericFilter && /\/\d+\/?$/.test(path)) continue // 分页尾部数字（可被 opts 跳过，见函数注释）
      const url = u.origin + path
      let title = (m[0].match(/title="([^"]*)"/)?.[1] || '').trim()
      if (!title) {
        title = m[0].replace(/<[^>]*>/g, '').trim()
      }
      if (!title) {
        const tm = html.slice(m.index, m.index + 600).match(/>([^<>]{2,})</)
        if (tm) {
          const t = tm[1].trim()
          // 跳过样式/CSS/脚本文本（如 .is-style-no-margin {margin:0 !important;}）
          if (t.length >= 2 && t.length < 200 && !/^[.#@]/.test(t) && !/[{;}]/.test(t)) title = t
        }
      }
      // 封面（2026-10-10 新增）：卡片常见写法是 <a href="文章"><img src="封面"></a>，
      // 故取该链接之后 1500 字符内的首个图片，并过滤 favicon/logo/占位图。
      // 此前通用解析器完全不给封面（注释写「封面不提取」），导致使用它的站点（knitbid/phimvuspot/ilovexs）
      // 在聚合搜索里全部没有预览图。
      let cover = ''
      const after = html.slice(m.index, m.index + 1500)
      const im = after.match(/<img[^>]+(?:data-src|data-lazy-src|src)="([^"]+)"/i)
      if (im) {
        try {
          const cu = new URL(im[1], baseUrl).href
          const isAsset = /\.(js|css|svg|ico)(\?|$)/i.test(cu)
          const isChrome = /(favicon|logo|avatar|sprite|placeholder|blank|loading)/i.test(cu)
          if (!isAsset && !isChrome) cover = cu
        } catch {
          cover = ''
        }
      }
      const existing = byUrl.get(url)
      if (existing) {
        // 同 URL 后到者补齐标题/封面（封面 a 先出现但无文本，标题 a 后出现）
        const next = { ...existing }
        if (existing.title === url && title && title !== url) next.title = title
        if (!existing.coverUrl && cover) next.coverUrl = cover
        if (next.title !== existing.title || next.coverUrl !== existing.coverUrl) byUrl.set(url, next)
        continue
      }
      byUrl.set(url, { url, title: title || url, coverUrl: cover, imageCount: undefined })
    } catch {
      // 忽略非法链接
    }
  }
  return [...byUrl.values()]
}

/** 列表页 → 相册链接（FP-023 列表浏览）：同域链接提取 + 相册路径过滤
 *  复用通用文章链接解析（已排除分类/标签/分页等路径），再按 albumPath 收窄 */
export function parseListPageLinks(html: string, baseUrl: string, site: GallerySiteConfig): BuonduaLinkItem[] {
  const cfg = site.def.listPages?.[0]
  const albumPath = cfg?.albumPath ?? site.searchAlbumPath
  const albumPattern = cfg?.albumPath ? undefined : site.searchAlbumPattern
  const items = parseSitePostLinks(html, baseUrl, site.hosts, {
    skipNumericFilter: !!(albumPath || albumPattern),
  })
  return items.filter((item) => {
    try {
      const pathname = new URL(item.url).pathname
      if (albumPath && !pathname.startsWith(albumPath)) return false
      if (albumPattern && !albumPattern.test(pathname)) return false
      return true
    } catch {
      return false
    }
  })
}

/** Google 搜索结果项清洗（解析 / tab 通道共用，FP-012/093）：
 *  域名过滤 + searchAlbumPath 相册过滤 + &amp; 还原 + 去 query（?m=1/&page=N）+ cleanTitle */
export function cleanGoogleResult(
  site: GallerySiteConfig,
  rawUrl: string,
  rawTitle: string,
): BuonduaLinkItem | null {
  try {
    const url = rawUrl.replace(/&amp;/g, '&')
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const hostOk = site.hosts.some((h) => host === h || host.endsWith(`.${h}`))
    if (!hostOk) return null
    if (site.searchAlbumPath && !u.pathname.startsWith(site.searchAlbumPath)) return null
    // 2026-10-08 体检 P1-2：无固定路径前缀的站点用正则过滤（如 pixibb 的 -photos）
    if (site.searchAlbumPattern && !site.searchAlbumPattern.test(u.pathname)) return null
    u.search = ''
    u.hash = ''
    const cleanUrl = u.href
    const title = site.cleanTitle(rawTitle.replace(/<[^>]*>/g, '').trim()) || cleanUrl
    return { url: cleanUrl, title, coverUrl: '', imageCount: undefined }
  } catch {
    return null
  }
}

/** Google 网页搜索结果解析（FP-012，2026-08-14 两次校准）：
 *  双模式兼容：
 *  ① 现代 UI：结果块 <a class="zReHs" href="{真实直链}">…<h3>标题</h3></a>（用户保存的渲染后 DOM）
 *  ② 基础 HTML（gbv=1，无 JS 服务端渲染，插件 fetch 视角）：<h3 class="r"><a href="{真实直链}">标题</a></h3>
 *  过滤：仅保留目标域且命中 searchAlbumPath（如 /photos/、/gallerys/）的相册链接；分类/标签页剔除
 *  链接清理：&amp; 实体还原、去 query（?m=1 移动版参数、&page=N 相册分页参数） */
export function parseGoogleResults(html: string, site: GallerySiteConfig): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()
  const add = (rawUrl: string, rawTitle: string): void => {
    const clean = cleanGoogleResult(site, rawUrl, rawTitle)
    if (!clean || seen.has(clean.url)) return
    seen.add(clean.url)
    items.push(clean)
  }
  // 模式 ①：现代 zReHs
  const re1 = /<a[^>]*class="[^"]*zReHs[^"]*"[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<h3[^>]*>([\s\S]*?)<\/h3>/g
  let m: RegExpExecArray | null
  while ((m = re1.exec(html)) !== null) add(m[1], m[2])
  // 模式 ②：基础 HTML（gbv=1）h3.r > a
  const re2 = /<h3[^>]*class="[^"]*\br\b[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  while ((m = re2.exec(html)) !== null) add(m[1], m[2])
  return items
}

/** 搜索页链接解析器注册表（定义 linkParser 字段 → 实现） */
const LINK_PARSERS: Record<string, LinkParser | undefined> = {
  'buondua-items-row': (html, base) => parseRecommendedLinks(html, base),
  'rrwsh-cards': (html, base) => parseRrwshSearchLinks(html, base),
  'kaizty-photos': (html, base) => parseKaiztyPostLinks(html, base),
  'jrants-wp': (html, base) => parseJrantsPostLinks(html, base, {}),
  'pixibb-magezix': (html, base) => parsePixibbPostLinks(html, base, {}),
  'google-serp': (html, _base, site) => parseGoogleResults(html, site),
  'generic-post-links': (html, base, site) =>
    parseSitePostLinks(html, base, site.hosts, {
      skipNumericFilter: !!(site.searchAlbumPath || site.searchAlbumPattern),
    }),
}

/** 推荐/其他链接扫描解析器注册表（定义 scan 字段 → 实现） */
const SCAN_PARSERS: Record<ScanParserName, ScanParser> = {
  'buondua-recommended': (html, base) => parseRecommendedLinks(html, base),
  'buondua-others': (html, base, ctx) => parseAllPostLinks(html, base, ctx.recUrls),
  'jrants-recommended': (html, base) => parseJrantsPostLinks(html, base, { onlyRecommended: true }),
  'jrants-others': (html, base, ctx) => parseJrantsPostLinks(html, base, { excludeUrls: ctx.recUrls }),
  'pixibb-recommended': (html, base) => parsePixibbPostLinks(html, base, { onlyRecommended: true }),
  'pixibb-others': (html, base, ctx) => parsePixibbPostLinks(html, base, { excludeUrls: ctx.recUrls }),
}

/** 搜索结果张数提取规则注册表（定义 imageCountRule 字段 → 实现）
 *  jrants 标题 (NNNP)/[NNNP]；pixibb slug -NNN-photos（videos 段可选）；rrwsh 标题 [..NNNphotos]（括号形式兼容） */
const IMAGE_COUNT_RULES: Record<ImageCountRuleName, (item: BuonduaLinkItem, finalUrl: string) => number | undefined> = {
  'jrants-p': (item) => {
    const m = item.title.match(/[(\[]\s*(\d+)\s*P\s*[)\]]/i)
    return m ? Number(m[1]) : undefined
  },
  'pixibb-slug': (_item, finalUrl) => {
    const m = finalUrl.match(/-(\d+)-photos/i)
    return m ? Number(m[1]) : undefined
  },
  'rrwsh-photos': (item) => {
    const m = item.title.match(/[\[(][^\]()]*?(\d+)\s*photos/i)
    return m ? Number(m[1]) : undefined
  },
}

/** 按站点相册路径规则过滤结果（2026-10-10）：searchAlbumPath 前缀 + searchAlbumPattern 正则（同时配置为「且」）
 *  通用解析器 generic-post-links 提取的是同域全部文章链接，必须再收窄为相册链接 ——
 *  否则带语言前缀路径的站点（如 knit.bid 的 /ja/type/1/）会把分类页混进搜索结果 */
function filterAlbumLinks(site: GallerySiteConfig, items: BuonduaLinkItem[]): BuonduaLinkItem[] {
  const albumPath = site.searchAlbumPath
  const albumPattern = site.searchAlbumPattern
  if (!albumPath && !albumPattern) return items
  return items.filter((item) => {
    try {
      const pathname = new URL(item.url).pathname
      if (albumPath && !pathname.startsWith(albumPath)) return false
      if (albumPattern && !albumPattern.test(pathname)) return false
      return true
    } catch {
      return false
    }
  })
}

/** 按站点 id 解析搜索页链接（聚合搜索 / 站内搜索共用） */
export function parseLinksForSite(siteId: string, html: string, base: string): BuonduaLinkItem[] {
  const site = COMPILED_SITES.find((s) => s.id === siteId)
  const parser = site ? LINK_PARSERS[site.def.linkParser] : undefined
  if (site && parser) return filterAlbumLinks(site, parser(html, base, site))
  if (site && site.searchAlbumPath) return parseGoogleResults(html, site)
  return parseSitePostLinks(html, base, site ? site.hosts : [siteId])
}

/** 按站点定义解析搜索结果张数 */
export function extractSearchImageCount(
  siteId: string,
  item: BuonduaLinkItem,
  finalUrl: string,
): number | undefined {
  const rule = COMPILED_SITES.find((s) => s.id === siteId)?.def.imageCountRule
  if (!rule) return undefined
  return IMAGE_COUNT_RULES[rule](item, finalUrl)
}

/** 推荐 / 其他链接扫描（按定义 scan 字段路由；缺省 = buondua 那对解析器） */
export function scanSiteLinks(
  site: GallerySiteConfig | null,
  html: string,
  base: string,
  kind: 'recommended' | 'popular',
): BuonduaLinkItem[] {
  const scan = site?.def.scan ?? { recommended: 'buondua-recommended' as const, others: 'buondua-others' as const }
  const recommended = SCAN_PARSERS[scan.recommended](html, base, { recUrls: new Set<string>() })
  if (kind === 'recommended') return recommended
  const recUrls = new Set(recommended.map((i) => i.url))
  return SCAN_PARSERS[scan.others](html, base, { recUrls })
}
