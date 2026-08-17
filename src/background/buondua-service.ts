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
  /** Google 全站模式：为无 sitesearch 配置的站点构造 Google sitesearch 搜索配置（FP-013 调整）
   *  gbv=1 强制基础 HTML 版；结果提取走 searchGoogleViaTab（标签页 + executeScript，仅标题+链接） */
  private googleSearchConfig(site: GallerySiteConfig): GallerySiteConfig {
    const host = site.hosts[0] ?? site.id
    return {
      ...site,
      searchUrl: (q, page) =>
        `https://www.google.com/search?q=${encodeURIComponent(q)}&sitesearch=${host}&gbv=1${
          page > 1 ? `&start=${(page - 1) * 10}` : ''
        }`,
    }
  }

  /** Google 通道：页面降级搜索（FP-012/093）——后台静默打开 Google 搜索标签（真实浏览器 JS 渲染），
   *  提取渲染后结果（a.zReHs + h3 / h3.r > a），逐页进行，完成后关闭标签。
   *  后台 fetch 拿不到新版 Google 结果（JS 渲染壳，gbv=1 已废弃），此通道与用户手动搜索等效。 */
  async searchGoogleViaTab(
    site: GallerySiteConfig,
    query: string,
    pagesPerSite: number,
    startPage = 1,
  ): Promise<{ items: BuonduaLinkItem[]; pages: number }> {
    const items: BuonduaLinkItem[] = []
    const seen = new Set<string>()
    let pagesFetched = 0
    for (let page = startPage; page < startPage + pagesPerSite; page++) {
      const url = site.searchUrl?.(query, page)
      if (!url) break
      const tab = await chrome.tabs.create({ url, active: false })
      try {
        const ok = await this.waitForTabComplete(tab.id!)
        if (!ok) {
          logger.warn('buondua', 'Google 标签页加载超时', { site: site.id, page })
          break
        }
        const extracted = await this.extractGoogleTabResults(tab.id!)
        logger.info('buondua', 'Google 标签页提取', { site: site.id, page, count: extracted.length })
        if (extracted.length === 0) break // 无结果（验证页/无匹配）
        pagesFetched++
        for (const { url: rawUrl, title } of extracted) {
          const clean = cleanGoogleResult(site, rawUrl, title)
          if (clean && !seen.has(clean.url)) {
            seen.add(clean.url)
            items.push(clean)
          }
        }
      } finally {
        await chrome.tabs.remove(tab.id!).catch(() => {})
      }
    }
    return { items, pages: pagesFetched }
  }

  /** 等待标签页加载完成（tabs.create 后页面加载是异步的，未加载完 executeScript 会失败） */
  private async waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const tab = await chrome.tabs.get(tabId)
        if (tab.status === 'complete' && (tab.url ?? '').startsWith('http')) return true
      } catch {
        return false // 标签页已关闭
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    return false
  }

  /** 在 Google 搜索标签内等待 JS 渲染并提取结果（executeScript 注入，func 返回 Promise 会被等待） */
  private extractGoogleTabResults(tabId: number): Promise<{ url: string; title: string }[]> {
    return chrome.scripting
      .executeScript({
        target: { tabId },
        func: async () => {
          // 等待结果渲染（最多 ~12s，500ms 轮询）
          for (let i = 0; i < 24; i++) {
            if (document.querySelector('a.zReHs, h3.r')) break
            if (document.title.includes('未找到') || /did not match|No results found/i.test(document.body?.innerText ?? '')) break
            await new Promise((r) => setTimeout(r, 500))
          }
          const out: { url: string; title: string }[] = []
          const seen = new Set<string>()
          const push = (u: string, t: string): void => {
            if (seen.has(u)) return
            seen.add(u)
            out.push({ url: u, title: t })
          }
          // 模式 ①：现代 zReHs（渲染后 DOM）
          document.querySelectorAll('a.zReHs').forEach((a) => {
            const h3 = a.querySelector('h3')
            if (h3) push((a as HTMLAnchorElement).href, h3.textContent ?? '')
          })
          // 模式 ②：h3.r > a
          if (out.length === 0) {
            document.querySelectorAll('h3.r > a').forEach((a) => {
              const anchor = a as HTMLAnchorElement
              push(anchor.href, a.textContent ?? '')
            })
          }
          return out
        },
      })
      .then((res) => (res[0]?.result ?? []))
      .catch((err) => {
        logger.warn('buondua', 'Google 标签页注入失败', { tabId, error: String(err) })
        return []
      })
  }

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

  /** 批量抓取：targets 逐个全子页抓取（并发受限），返回每个目标的图片（失败带 error，096） */
  async fetchAlbumsBatch(
    targets: { url: string; title: string }[],
    onItem: (index: number, target: { url: string; title: string }, images: BuonduaImage[], error?: string) => void,
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
          const error = String(err)
          logger.warn('buondua', '批量相册抓取失败', { url: target.url, error })
          onItem(idx, target, [], error)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()))
  }

  /** 聚合搜索：多站点逐页搜索 → 按站点路由解析 → 合并去重
   *  startPage：每站起始页（「下一批」续搜传上次结束页 +1，096）
   *  onSite：每站完成后回调（推送该站结果，增量展示）；返回全部合并去重结果
   *  useGoogleAll：Google 全站搜索开关（FP-013 调整）——开启后全部站点走 Google sitesearch
   *  网页通道（标签页渲染，仅标题+链接，同站去重，速度快）；不读站内搜索接口 */
  async searchSites(
    query: string,
    sites: string[],
    pagesPerSite: number,
    onSite: (siteId: string, items: BuonduaLinkItem[], error?: string) => Promise<void> | void,
    startPage = 1,
    useGoogleAll = false,
  ): Promise<BuonduaLinkItem[]> {
    const mergedMap = new Map<string, BuonduaLinkItem>()
    const siteStats: Record<string, { count: number; pages: number; error?: string }> = {}
    for (const siteId of sites) {
      const site = GALLERY_SITES.find((s) => s.id === siteId)
      // FP-014：useGoogleAll 模式下不要求站内 searchUrl（无搜索接口的站也能走 Google sitesearch）
      if (!site || (!site.searchUrl && !useGoogleAll)) {
        await onSite(siteId, [], '该站不支持搜索')
        continue
      }
      const items: BuonduaLinkItem[] = []
      let error: string | undefined
      let pagesFetched = 0
      try {
        // Google 通道站点（searchAlbumPath）或 Google 全站模式（useGoogleAll）：
        // 后台 fetch 拿不到新版 Google 结果（JS 渲染壳），走页面降级通道（静默开标签渲染 + 提取，FP-012/093）
        if (site.searchAlbumPath || useGoogleAll) {
          const googleSite = useGoogleAll && !site.searchAlbumPath ? this.googleSearchConfig(site) : site
          const tabRes = await this.searchGoogleViaTab(googleSite, query, pagesPerSite, startPage)
          pagesFetched = tabRes.pages
          for (const item of tabRes.items) items.push(item)
          if (tabRes.items.length === 0) {
            error = 'Google 标签页未提取到相册结果（可能验证页/无匹配，日志含诊断）'
          }
        } else {
          for (let page = startPage; page < startPage + pagesPerSite; page++) {
            const url = site.searchUrl?.(query, page)
            if (!url) break
            // jrants 连续快速搜索触发反爬限流（实测 2026-08-13/14），页间强制间隔
            if (siteId === 'jrants' && page > 1) await sleep(2000)
            const html = await this.fetchHtml(url)
            pagesFetched++
            if (isBlockedPage(html)) {
              // 反爬拦截页：跳过该站（避免把热门/推荐链接当搜索结果）
              error = '搜索被反爬拦截（限流），请稍后重试'
              logger.warn('buondua', '站点搜索被反爬拦截', { site: siteId, len: html.length })
              break
            }
            const parsed = parseLinksForSite(siteId, html, url)
            if (parsed.length === 0) {
              break // 无更多结果
            }
            items.push(...parsed)
          }
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
      siteStats[siteId] = { count: unique.length, pages: pagesFetched, ...(error ? { error } : {}) }
      await onSite(siteId, unique, error)
    }
    logger.info('buondua', '聚合搜索完成', {
      query,
      sites: sites.length,
      merged: mergedMap.size,
      perSite: siteStats,
    })
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

  /** Google 连接测试（FP-012/093）：页面降级通道验证——后台开 Google 搜索标签（真实渲染），
   *  等待渲染后报告结果条数/标题/可见文本；结果写日志 */
  async testGoogleConnection(): Promise<{
    ok: boolean
    status?: number
    blocked: boolean
    ms: number
    error?: string
    diag?: {
      len: number
      title: string
      hasH3: boolean
      isConsent: boolean
      hasMetaRefresh: boolean
      hasNoResultText: boolean
      hops: number
      bodyPreview: string
    }
  }> {
    const start = Date.now()
    try {
      const tab = await chrome.tabs.create({ url: 'https://www.google.com/search?q=test&gbv=1', active: false })
      try {
        await this.waitForTabComplete(tab.id!)
        const info = await chrome.scripting
          .executeScript({
            target: { tabId: tab.id! },
            func: async () => {
              for (let i = 0; i < 24; i++) {
                if (document.querySelector('a.zReHs, h3.r') || /did not match|No results found|未找到/i.test(document.body?.innerText ?? '')) break
                await new Promise((r) => setTimeout(r, 500))
              }
              const count = document.querySelectorAll('a.zReHs, h3.r').length
              return { count, title: document.title, body: (document.body?.innerText ?? '').slice(0, 200) }
            },
          })
          .then((res) => res[0]?.result ?? { count: 0, title: '', body: '' })
        const diag = {
          len: info.body.length,
          title: info.title.slice(0, 100),
          hasH3: info.count > 0,
          isConsent: false,
          hasMetaRefresh: false,
          hasNoResultText: /did not match|No results found|未找到/i.test(info.body),
          hops: 0,
          bodyPreview: info.body,
        }
        const ms = Date.now() - start
        if (diag.hasH3) logger.info('buondua', 'Google 标签页测试：正常', { ...diag, ms })
        else logger.warn('buondua', 'Google 标签页测试：无结果', { ...diag, ms })
        return { ok: true, status: 200, blocked: false, ms, diag }
      } finally {
        await chrome.tabs.remove(tab.id!).catch(() => {})
      }
    } catch (err) {
      logger.warn('buondua', 'Google 标签页测试失败', { error: String(err), ms: Date.now() - start })
      return { ok: false, blocked: false, ms: Date.now() - start, error: String(err) }
    }
  }
}

/** 按站点路由搜索页链接解析：jrants/pixibb 用专用解析器，buondua 搜索卡片与推荐区同构（items-row），其余用通用解析 */
function parseLinksForSite(siteId: string, html: string, base: string): BuonduaLinkItem[] {
  if (siteId === 'buondua') return parseRecommendedLinks(html, base)
  if (siteId === 'jrants') return parseJrantsPostLinks(html, base, {})
  if (siteId === 'pixibb') return parsePixibbPostLinks(html, base, {})
  if (siteId === 'kaizty') return parseKaiztyPostLinks(html, base)
  if (siteId === 'rrwsh') return parseRrwshSearchLinks(html, base)
  const site = GALLERY_SITES.find((s) => s.id === siteId)
  if (site && site.searchAlbumPath) return parseGoogleResults(html, site)
  return parseSitePostLinks(html, base, site?.hosts ?? [siteId])
}

/** Google 搜索结果项清洗（解析/tab 通道共用，FP-012/093）：
 *  域名过滤 + searchAlbumPath 相册过滤 + &amp; 还原 + 去 query（?m=1/&page=N）+ cleanTitle */
function cleanGoogleResult(site: GallerySiteConfig, rawUrl: string, rawTitle: string): BuonduaLinkItem | null {
  try {
    const url = rawUrl.replace(/&amp;/g, '&')
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    const hostOk = site.hosts.some((h) => host === h || host.endsWith(`.${h}`))
    if (!hostOk) return null
    if (site.searchAlbumPath && !u.pathname.startsWith(site.searchAlbumPath)) return null
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
function parseGoogleResults(html: string, site: GallerySiteConfig): BuonduaLinkItem[] {
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

/** 反爬/错误页检测（站内站点搜索用）：使用 challenge 页专属特征
 *  注意：① 不能用裸 "cloudflare"——正常页面会引用 /cdn-cgi/.../cloudflare-static/rocket-loader.min.js 资源（实测误判 pixibb 2026-08-14）
 *  ② Google 页面脚本内含 /sorry/index 字符串（iframe 兜底），不能作为拦截特征 */
function isBlockedPage(html: string): boolean {
  return /search request blocked|正在进行安全验证|just a moment|cf-chl|turnstile|attention required|unusual traffic|enable JavaScript and cookies|recaptcha|our systems have detected/i.test(html)
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
