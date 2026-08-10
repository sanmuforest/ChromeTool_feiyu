// 通用多页相册站点适配（FP-004 扩展）：buondua / rrwsh.uuss.uk(4khd) / hitxhot
//
// 三种站点均为「多页相册」：正文容器内图片 + 分页（?page=N 或 路径式 /N）+ 标题 Page 标记。
// 配置驱动：新增站点只需在 GALLERY_SITES 添加配置（hosts / 容器 / 分页 / 标题清理）。
//
// 实测结构（2026-08-11）：
// - buondua：.article-fulltext 内 <img src="i2.buondua.com/...jpeg?签名">；分页 ?page=N；标题 ( Page X / N )
// - rrwsh（4khd 镜像）：.entry-content 内 <a href="i0.wp.com/...w1300...webp?w=1300"><img src="同URL"></a>；分页 路径式 /N；标题 - Page X of N -
// - hitxhot：.contentme 内 <a href="/img.html?url=IMG"><img src="IMG"></a>；分页 ?page=N；标题 | Page X/N

import type { BuonduaImage } from './types'

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
        return u.href
      } catch {
        return url
      }
    },
    cleanTitle: (title) => title.replace(/\s*[-–—]\s*\(\s*Page\s+\d+\s*\/\s*\d+\s*\)\s*$/i, '').trim(),
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
  },
  {
    id: 'hitxhot',
    hosts: ['hitxhot.org'],
    containerOpen: /<div[^>]*class="[^"]*contentme[^"]*"[^>]*>/,
    pagePattern: /\|\s*Page\s+\d+\s*\/\s*(\d+)/i,
    pageUrl: (base, page) => `${base}?page=${page}`,
    baseUrlOf: (url) => {
      try {
        const u = new URL(url)
        u.search = ''
        return u.href
      } catch {
        return url
      }
    },
    cleanTitle: (title) => title.replace(/\s*\|\s*Page\s+\d+\s*\/\s*\d+\s*$/i, '').trim(),
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
const IMG_HOST = /(buondua\.com|wp\.com)/i

/** 从正文容器解析图片：收集块内所有图片 URL（a href / img src），去重 */
export function parseGalleryImages(html: string, _baseUrl: string, site: GallerySiteConfig): BuonduaImage[] {
  const block = extractContainerBlock(html, site.containerOpen)
  if (!block) return []
  const seen = new Set<string>()
  const urls: string[] = []
  const collect = (u: string): void => {
    if (!u || !/^https?:\/\//i.test(u)) return
    if (/\.(js|css|svg|ico)(\?|$)/i.test(u)) return
    if (!IMG_EXT.test(u) && !IMG_HOST.test(u)) return
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
    const n = Number(m[1])
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
  return max
}

/** 页面标题（文件夹名用，已 clean）：h1 优先，og:title / title 兜底 */
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
  return site.cleanTitle(raw)
}
