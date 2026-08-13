// 通用多页相册站点适配（FP-004 扩展）：buondua / rrwsh.uuss.uk(4khd) / hitxhot / jrants(FP-008)
//
// 三种站点均为「多页相册」：正文容器内图片 + 分页（?page=N 或 路径式 /N）+ 标题 Page 标记。
// 配置驱动：新增站点只需在 GALLERY_SITES 添加配置（hosts / 容器 / 分页 / 标题清理）。
//
// 实测结构（2026-08-11 / 2026-08-13）：
// - buondua：.article-fulltext 内 <img src="i2.buondua.com/...jpeg?签名">；分页 ?page=N；标题 ( Page X / N )
// - rrwsh（4khd 镜像）：.entry-content 内 <a href="i0.wp.com/...w1300...webp?w=1300"><img src="同URL"></a>；分页 路径式 /N；标题 - Page X of N -
// - hitxhot：.contentme 内 <a href="/img.html?url=IMG"><img src="IMG"></a>；分页 ?page=N；标题 | Page X/N
// - jrants（FP-008）：.entry-content 内 <img class="wp-image-*" src="m2.jrants.com/wp-content/uploads/...">；分页 路径式 /N（page-links 导航）

import type { BuonduaImage, BuonduaLinkItem } from './types'

/** 站点配置 */
export interface GallerySiteConfig {
  id: string
  /** 匹配 hostname（含 www. 子域） */
  hosts: string[]
  /** 正文容器开标签（含 class 匹配） */
  containerOpen: RegExp
  /** 标题中分页标记：捕获组 2 = 总页数（如 "( Page 1 / 41 )" 组2=41） */
  pagePattern: RegExp
  /** 构造分页 URL */
  pageUrl: (base: string, page: number) => string
  /** 从 URL 提取相册基址 */
  baseUrlOf: (url: string) => string
  /** 标题清理（文件夹名用）：去掉分页标记与站点后缀 */
  cleanTitle: (title: string) => string
  /** 搜索 URL 构造（聚合搜索用）；返回 null 表示该站不支持搜索 */
  searchUrl: (q: string, page: number) => string | null
}

export const GALLERY_SITES: GallerySiteConfig[] = [
  {
    id: 'buondua',
    hosts: ['buondua.com'],
    containerOpen: /<div[^>]*class="[^"]*article-fulltext[^"]*"[^>]*>/,
    pagePattern: /\(\s*Page\s+\d+\s*\/\s*(\d+)\s*\)/i,
    pageUrl: (base, page) => `${base}?page=${page}`,
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        u.hash = ''
        return u.href
      } catch {
        return url
      }
    },
    cleanTitle: (title) => title.replace(/\s*[-–—]\s*\(\s*Page\s+\d+\s*\/\s*\d+\s*\)\s*$/i, '').trim(),
    // buondua 站点当前不可达且搜索入口未验证，暂不支持聚合搜索
    searchUrl: () => null,
  },
  {
    id: 'rrwsh',
    hosts: ['rrwsh.uuss.uk', '4khd.com'],
    containerOpen: /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/,
    pagePattern: /Page\s+\d+\s+of\s+(\d+)/i,
    pageUrl: (base, page) => `${base}/${page}`,
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        u.hash = ''
        // 去尾部 "/N"（路径式分页）
        const path = u.pathname.replace(/\/\d+$/, '')
        return `${u.origin}${path}`
      } catch {
        return url
      }
    },
    cleanTitle: (title) =>
      title
        .replace(/\s*[-–—]\s*Page\s+\d+\s+of\s+\d+\s*[-–—]\s*[^-]*$/i, '')
        .replace(/\s*[-–—]\s*4KHD\s*$/i, '')
        .trim(),
    // rrwsh 为 4khd 镜像：4khd.com 相册页被反爬网关拦截（302 → y5gx.uuss.uk/4khd.php，实测 2026-08-13），
    // 搜索结果打不开，暂不支持聚合搜索
    searchUrl: () => null,
  },
  {
    id: 'hitxhot',
    hosts: ['hitxhot.org'],
    containerOpen: /<div[^>]*class="[^"]*contentme[^"]*"[^>]*>/,
    // 兼容英文 "| Page 2/3" 与中文 "| 第1/6页"（组2 = 总页数）
    pagePattern: /\|\s*(?:Page\s+\d+\s*\/\s*(\d+)|第\s*\d+\s*\/\s*(\d+)\s*页)/i,
    pageUrl: (base, page) => `${base}?page=${page}`,
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        u.hash = ''
        return u.href
      } catch {
        return url
      }
    },
    cleanTitle: (title) =>
      title
        .replace(/\s*\|\s*(?:Page\s+\d+\s*\/\s*\d+|第\s*\d+\s*\/\s*\d+\s*页)\s*$/i, '')
        .trim(),
    // hitxhot 无搜索入口（?s= 返回首页，实测 2026-08-13），不支持聚合搜索
    searchUrl: () => null,
  },
  {
    id: 'kaizty',
    hosts: ['kaizty.com'],
    containerOpen: /<div[^>]*class="[^"]*contentme[^"]*"[^>]*>/,
    // 与 hitxhot 同模板：标题含 "| Page X/Y"（组2 = 总页数）
    pagePattern: /\|\s*(?:Page\s+\d+\s*\/\s*(\d+)|第\s*\d+\s*\/\s*(\d+)\s*页)/i,
    pageUrl: (base, page) => `${base}?page=${page}`,
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        u.hash = ''
        return u.href
      } catch {
        return url
      }
    },
    cleanTitle: (title) =>
      title
        .replace(/^Kaizty Photos:\s*/i, '')
        .replace(/\s*\|\s*(?:Page\s+\d+\s*\/\s*\d+|第\s*\d+\s*\/\s*\d+\s*页)\s*$/i, '')
        .trim(),
    // kaizty 无搜索入口（同 hitxhot 模板），不支持聚合搜索
    searchUrl: () => null,
  },
  {
    id: 'jrants',
    hosts: ['jrants.com'],
    containerOpen: /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/,
    // WP 多页文章：标题无 Page 标记（h1 不分页），总页数靠分页链接兜底（见 parseGalleryMaxPage 兜底3）
    pagePattern: /(?!)0/,
    pageUrl: (base, page) => (page <= 1 ? base : `${base}/${page}`),
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        u.hash = ''
        // 去尾部 "/N"（路径式分页）
        const path = u.pathname.replace(/\/\d+$/, '')
        return `${u.origin}${path}`
      } catch {
        return url
      }
    },
    cleanTitle: (title) => title.trim(),
    // WP 标准搜索（?s= + paged）
    searchUrl: (q, page) =>
      `https://jrants.com/?s=${encodeURIComponent(q)}${page > 1 ? `&paged=${page}` : ''}`,
  },
  {
    id: 'pixibb',
    hosts: ['pixibb.com'],
    containerOpen: /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/,
    // WP 多页文章（magezix 主题）：标题无 Page 标记，总页数靠分页链接兜底（post-page-numbers，尾斜杠 /N/）
    pagePattern: /(?!)0/,
    pageUrl: (base, page) => (page <= 1 ? base : `${base.replace(/\/?$/, '/')}${page}/`),
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        u.hash = ''
        // 去尾部 "/N/" 或 "/N"（路径式分页，带尾斜杠）
        const path = u.pathname.replace(/\/\d+\/$/, '').replace(/\/\d+$/, '')
        return `${u.origin}${path}`
      } catch {
        return url
      }
    },
    cleanTitle: (title) => title.trim(),
    // WP 标准搜索（?s= + paged）；主内容子域 sexy
    searchUrl: (q, page) =>
      `https://sexy.pixibb.com/?s=${encodeURIComponent(q)}${page > 1 ? `&paged=${page}` : ''}`,
  },
]

/** 按 URL hostname 匹配站点配置 */
export function matchGallerySite(url: string): GallerySiteConfig | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    for (const site of GALLERY_SITES) {
      if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site
    }
  } catch {
    // 非法 URL
  }
  return null
}

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
const IMG_HOST = /(buondua\.com|wp\.com|jrants\.com|pixibb\.com|thismore\.fun)/i

/** 从正文容器解析图片：收集块内所有图片 URL（a href / img src），去重 */
export function parseGalleryImages(html: string, _baseUrl: string, site: GallerySiteConfig): BuonduaImage[] {
  const block = extractContainerBlock(html, site.containerOpen)
  if (!block) return []
  const seen = new Set<string>()
  const urls: string[] = []
  const collect = (u: string): void => {
    if (!u || !/^https?:\/\//i.test(u)) return
    if (/\.(js|css|svg|ico)(\?|$)/i.test(u)) return
    // 图片判定：扩展名优先；非图片扩展名时按 hostname 白名单（IMG_HOST），
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
  return urls.map((url) => {
    let filename = ''
    try {
      filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
    } catch {
      filename = url.split('/').pop() || ''
    }
    filename = filename.replace(/[\\/:*?"<>|]/g, '_')
    return { url, filename }
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

/** 通用站点文章链接解析（聚合搜索用，无专用解析器时兜底）：
 *  提取指定 hosts（含子域）下的文章链接，排除首页/分类/标签/搜索/作者/分页等路径
 *  标题：a title 属性 → a 文本 → 附近文本；封面不提取（专用解析器负责） */
export function parseSitePostLinks(html: string, baseUrl: string, hosts: string[]): BuonduaLinkItem[] {
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
      if (/\/\d+\/?$/.test(path)) continue // 分页尾部数字
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
      const existing = byUrl.get(url)
      if (existing) {
        // 同 URL 后到者补齐标题（封面 a 先出现但无文本，标题 a 后出现）
        if (existing.title === url && title && title !== url) {
          byUrl.set(url, { ...existing, title })
        }
        continue
      }
      byUrl.set(url, { url, title: title || url, coverUrl: '', imageCount: undefined })
    } catch {
      // 忽略非法链接
    }
  }
  return [...byUrl.values()]
}
