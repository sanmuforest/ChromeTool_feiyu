// buondua 后台服务（background 内使用）
// 职责：fetch buondua 相册页 HTML → 解析 → 返回结构化数据
// 通道：全部为公开页面，实测无需登录、图片直连可下载

import { initLogger } from '../lib/logger'
import {
  extractBuonduaAlbumName,
  parseAllPostLinks,
  parseRecommendedLinks,
} from '../lib/buondua-parse'
import {
  GALLERY_SITES,
  matchGallerySite,
  parseGalleryImages,
  parseGalleryMaxPage,
  parseGalleryPageTitle,
  parseKaiztyPostLinks,
  parseRrwshSearchLinks,
  parseSitePostLinks,
  type GallerySiteConfig,
} from '../lib/gallery-sites'
import { parseJrantsPostLinks } from '../lib/jrants-parse'
import { parsePixibbPostLinks } from '../lib/pixibb-parse'
import type { BuonduaImage, BuonduaLinkItem } from '../lib/types'

const logger = initLogger('background')

const FETCH_TIMEOUT_MS = 40000 // 部分站点对无 Cookie 请求响应慢（hitxhot 实测 >20s）
const FETCH_ATTEMPTS = 2
const CONCURRENCY = 3 // 批量抓取并发（用户确认）

export class BuonduaService {
  /** fetch 单个页面 HTML（带 UA + 超时 + 重试 1 次） */
  async fetchHtml(url: string): Promise<string> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        return await this.fetchOnce(url)
      } catch (err) {
        lastErr = err
        logger.warn('buondua', `页面抓取第 ${attempt} 次失败`, { url, error: String(err) })
      }
    }
    throw lastErr
  }

  private async fetchOnce(url: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: new URL(url).origin + '/',
        },
        signal: controller.signal,
      })
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}（${url}）`)
      }
      return await resp.text()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`请求超时（${url}）`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** 单相册全子页抓取（buondua / rrwsh / hitxhot 通用）：按最大页数遍历全部子页 → 合并去重
   *  fetchHtmlFn：可选，降级用（content 页面内 fetch 带 Cookie 穿透反爬） */
  async fetchAlbumAllPages(
    url: string,
    fetchHtmlFn?: (u: string) => Promise<string>,
  ): Promise<{ images: BuonduaImage[]; pages: string[]; title: string }> {
    const getHtml = fetchHtmlFn ?? ((u: string) => this.fetchHtml(u))
    const site = matchGallerySite(url)
    if (!site) {
      throw new Error(`暂不支持该站点（${url}）`)
    }
    const base = site.baseUrlOf(url)
    const firstHtml = await getHtml(base)
    const title = parseGalleryPageTitle(firstHtml, site)
    // 大相册分页导航只显示部分页码：按标题 Page 标记的最大页数完整遍历
    const maxPage = parseGalleryMaxPage(firstHtml, site)
    const all: string[] = []
    for (let p = 1; p <= maxPage; p++) {
      all.push(site.pageUrl(base, p))
    }
    const imagesMap = new Map<string, BuonduaImage>()
    let scanned = 0
    let emptyStreak = 0
    for (const pageUrl of all) {
      const html = await getHtml(pageUrl)
      const imgs = parseGalleryImages(html, pageUrl, site)
      scanned += imgs.length
      emptyStreak = imgs.length === 0 ? emptyStreak + 1 : 0
      for (const img of imgs) {
        // 去重键：路径 + 文件名（去掉签名/尺寸 query）
        const key = `${img.url.split('?')[0]}`
        if (!imagesMap.has(key)) imagesMap.set(key, img)
      }
      // 连续 3 页无图（视频页/末尾）提前停止，避免超限浪费
      if (emptyStreak >= 3) break
    }
    const images = [...imagesMap.values()]
    logger.info('buondua', '相册全子页抓取完成', {
      site: site.id,
      url,
      pages: all.length,
      scanned,
      unique: images.length,
      title,
      maxPage,
    })
    return { images, pages: all, title }
  }

  /** 解析推荐/其他相册链接（按站点路由：buondua 用 buondua-parse，jrants 用 jrants-parse） */
  async scanLinks(url: string, kind: 'recommended' | 'popular'): Promise<BuonduaLinkItem[]> {
    const html = await this.fetchHtml(url)
    const base = url
    const site = matchGallerySite(url)
    let items: BuonduaLinkItem[]
    if (site?.id === 'jrants') {
      // jrants：推荐 = wp-show-posts 相关文章卡片；其他 = 全页链接 − 推荐区
      const rec = parseJrantsPostLinks(html, base, { onlyRecommended: true })
      if (kind === 'recommended') {
        items = rec
      } else {
        const recUrls = new Set(rec.map((i) => i.url))
        items = parseJrantsPostLinks(html, base, { excludeUrls: recUrls })
      }
    } else if (site?.id === 'pixibb') {
      // pixibb：推荐 = post-nav 前后文章；其他 = 全页链接 − 推荐区
      const rec = parsePixibbPostLinks(html, base, { onlyRecommended: true })
      if (kind === 'recommended') {
        items = rec
      } else {
        const recUrls = new Set(rec.map((i) => i.url))
        items = parsePixibbPostLinks(html, base, { excludeUrls: recUrls })
      }
    } else if (kind === 'recommended') {
      items = parseRecommendedLinks(html, base)
    } else {
      // 其他链接：全页扫描帖子链接，排除推荐区已收录
      const recUrls = new Set(parseRecommendedLinks(html, base).map((i) => i.url))
      items = parseAllPostLinks(html, base, recUrls)
    }
    logger.info('buondua', '链接扫描完成', { kind, count: items.length, site: site?.id ?? 'buondua' })
    return items
  }

  /** 批量抓取：targets 逐个全子页抓取（并发受限），返回每个目标的图片 */
  async fetchAlbumsBatch(
    targets: { url: string; title: string }[],
    onItem: (index: number, target: { url: string; title: string }, images: BuonduaImage[]) => void,
  ): Promise<void> {
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++
        if (idx >= targets.length) return
        const target = targets[idx]
        try {
          const { images } = await this.fetchAlbumAllPages(target.url)
          onItem(idx, target, images)
        } catch (err) {
          logger.warn('buondua', '批量相册抓取失败', { url: target.url, error: String(err) })
          onItem(idx, target, [])
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()))
  }

  /** 聚合搜索：多站点逐页搜索 → 按站点路由解析 → 合并去重
   *  onSite：每站完成后回调（推送该站结果，增量展示）；返回全部合并去重结果 */
  async searchSites(
    query: string,
    sites: string[],
    pagesPerSite: number,
    onSite: (siteId: string, items: BuonduaLinkItem[], error?: string) => Promise<void> | void,
  ): Promise<BuonduaLinkItem[]> {
    const mergedMap = new Map<string, BuonduaLinkItem>()
    for (const siteId of sites) {
      const site = GALLERY_SITES.find((s) => s.id === siteId)
      if (!site || !site.searchUrl) {
        await onSite(siteId, [], '该站不支持搜索')
        continue
      }
      const items: BuonduaLinkItem[] = []
      let error: string | undefined
      try {
        for (let page = 1; page <= pagesPerSite; page++) {
          const url = site.searchUrl(query, page)
          if (!url) break
          // jrants 连续快速搜索触发反爬限流（实测 2026-08-13/14），页间强制间隔
          if (siteId === 'jrants' && page > 1) await sleep(2000)
          const html = await this.fetchHtml(url)
          if (isBlockedPage(html)) {
            // 反爬拦截页：跳过该站（避免把热门/推荐链接当搜索结果）
            error = '搜索被反爬拦截（限流），请稍后重试'
            logger.warn('buondua', '站点搜索被反爬拦截', { site: siteId })
            break
          }
          const parsed = parseLinksForSite(siteId, html, url)
          if (parsed.length === 0) {
            // Google 通道（searchAlbumPath 站点）第 1 页无结果：多半是验证/同意页，给出明确提示
            if (page === 1 && site.searchAlbumPath) {
              error = 'Google 未返回可解析的相册结果（可能被验证页/同意页拦截，请用「测试 Google 连接」确认）'
              logger.warn('buondua', 'Google 搜索无结果', { site: siteId })
            }
            break // 无更多结果
          }
          items.push(...parsed)
        }
      } catch (err) {
        error = String(err)
        logger.warn('buondua', '站点搜索失败', { site: siteId, error })
      }
      // 站点后处理：URL 改写（rrwsh 网关绕过）+ 张数提取（jrants 标题 / pixibb slug / rrwsh 标题）
      const unique = dedupeLinks(items.map((item) => enrichSearchItem(siteId, site, item)))
      for (const item of unique) {
        if (!mergedMap.has(item.url)) mergedMap.set(item.url, item)
      }
      await onSite(siteId, unique, error)
    }
    logger.info('buondua', '聚合搜索完成', { query, sites: sites.length, merged: mergedMap.size })
    return [...mergedMap.values()]
  }

  /** 相册文件夹名：ID-buondua-{相册名}-{时间戳} */
  buildFolderName(title: string, url: string): string {
    const name = extractBuonduaAlbumName(title, url)
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return `ID-buondua-${name}-${ts}`
  }

  /** Google 连接测试（聚合搜索 Google 通道，FP-012）：请求 google 搜索，报告可达性/拦截/耗时 */
  async testGoogleConnection(): Promise<{ ok: boolean; status?: number; blocked: boolean; ms: number; error?: string }> {
    const start = Date.now()
    try {
      const resp = await fetch('https://www.google.com/search?q=test', {
        credentials: 'include',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      })
      const html = await resp.text()
      const blocked = isBlockedPage(html)
      return { ok: true, status: resp.status, blocked, ms: Date.now() - start }
    } catch (err) {
      return { ok: false, blocked: false, ms: Date.now() - start, error: String(err) }
    }
  }
}

/** 按站点路由搜索页链接解析：jrants/pixibb 用专用解析器，其余用通用解析 */
function parseLinksForSite(siteId: string, html: string, base: string): BuonduaLinkItem[] {
  if (siteId === 'jrants') return parseJrantsPostLinks(html, base, {})
  if (siteId === 'pixibb') return parsePixibbPostLinks(html, base, {})
  if (siteId === 'kaizty') return parseKaiztyPostLinks(html, base)
  if (siteId === 'rrwsh') return parseRrwshSearchLinks(html, base)
  const site = GALLERY_SITES.find((s) => s.id === siteId)
  if (site && site.searchAlbumPath) return parseGoogleResults(html, site)
  return parseSitePostLinks(html, base, site?.hosts ?? [siteId])
}

/** Google 网页搜索结果解析（FP-012 预研 004，用户代理环境真实 HTML 校准，2026-08-14）：
 *  结构：结果块 <a class="zReHs" href="{真实直链}">…<h3>标题</h3></a>（现代 Google 直链，无 /url?q= 重定向）
 *  过滤：仅保留目标域且命中 searchAlbumPath（如 /photos/、/gallerys/）的相册链接；分类/标签页剔除
 *  链接清理：&amp; 实体还原、去 query（?m=1 移动版参数、&page=N 相册分页参数） */
function parseGoogleResults(html: string, site: GallerySiteConfig): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*class="[^"]*zReHs[^"]*"[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<h3[^>]*>([\s\S]*?)<\/h3>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      const url = m[1].replace(/&amp;/g, '&')
      const u = new URL(url)
      const host = u.hostname.replace(/^www\./, '')
      const hostOk = site.hosts.some((h) => host === h || host.endsWith(`.${h}`))
      if (!hostOk) continue
      if (site.searchAlbumPath && !u.pathname.startsWith(site.searchAlbumPath)) continue
      u.search = ''
      u.hash = ''
      const cleanUrl = u.href
      if (seen.has(cleanUrl)) continue
      seen.add(cleanUrl)
      const title = site.cleanTitle(m[2].replace(/<[^>]*>/g, '').trim()) || cleanUrl
      items.push({ url: cleanUrl, title, coverUrl: '', imageCount: undefined })
    } catch {
      // 忽略非法链接
    }
  }
  return items
}

/** 搜索项站点后处理：URL 改写（rrwsh 4khd→rrwsh 域）+ 张数提取（FP-012） */
function enrichSearchItem(siteId: string, site: GallerySiteConfig, item: BuonduaLinkItem): BuonduaLinkItem {
  const url = site.rewriteUrl ? site.rewriteUrl(item.url) : item.url
  return { ...item, url, imageCount: item.imageCount ?? extractSearchImageCount(siteId, item, url) }
}

/** 搜索结果张数提取：jrants 标题 (NNNP)/[NNNP]；pixibb slug -NNN-photos（videos 段可选）；rrwsh 标题 [..NNNphotos]（括号形式兼容） */
function extractSearchImageCount(siteId: string, item: BuonduaLinkItem, finalUrl: string): number | undefined {
  if (siteId === 'jrants') {
    const m = item.title.match(/[(\[]\s*(\d+)\s*P\s*[)\]]/i)
    return m ? Number(m[1]) : undefined
  }
  if (siteId === 'pixibb') {
    const m = finalUrl.match(/-(\d+)-photos/i)
    return m ? Number(m[1]) : undefined
  }
  if (siteId === 'rrwsh') {
    const m = item.title.match(/[\[(][^\]()]*?(\d+)\s*photos/i)
    return m ? Number(m[1]) : undefined
  }
  return undefined
}

/** 请求间隔（jrants 反爬限流用） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 反爬/错误页检测（搜索时跳过，避免把热门/推荐链接当搜索结果）
 *  注意：Google 页面脚本内含 /sorry/index 字符串（iframe 兜底），不能作为拦截特征；
 *  用 sorry 页专属文案（unusual traffic / recaptcha / enable JavaScript） */
function isBlockedPage(html: string): boolean {
  return /search request blocked|正在进行安全验证|just a moment|cf-chl|cloudflare|turnstile|attention required|unusual traffic|enable JavaScript and cookies|recaptcha|our systems have detected/i.test(html)
}

/** 按 URL 去重 */
function dedupeLinks(items: BuonduaLinkItem[]): BuonduaLinkItem[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    if (seen.has(i.url)) return false
    seen.add(i.url)
    return true
  })
}
