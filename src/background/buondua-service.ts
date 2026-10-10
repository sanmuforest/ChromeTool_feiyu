// buondua 后台服务（background 内使用）
// 职责：fetch buondua 相册页 HTML → 解析 → 返回结构化数据
// 通道：全部为公开页面，实测无需登录、图片直连可下载

import { initLogger } from '../lib/logger'
import { storageGet, storageSet } from '../lib/storage'
import { extractBuonduaAlbumName } from '../lib/buondua-parse'
import {
  listPageUrl,
  matchGallerySite,
  parseGalleryImages,
  parseGalleryMaxPage,
  parseGalleryPageTitle,
  siteById,
  type GallerySiteConfig,
} from '../sites/registry'
import {
  cleanGoogleResult,
  extractSearchImageCount,
  parseLinksForSite,
  parseListPageLinks,
  scanSiteLinks,
} from '../sites/parsers'
import type { BuonduaImage, BuonduaLinkItem } from '../lib/types'

const logger = initLogger('background')

const FETCH_TIMEOUT_MS = 40000 // 部分站点对无 Cookie 请求响应慢（hitxhot 实测 >20s）
const FETCH_ATTEMPTS = 2
const CONCURRENCY = 3 // 批量抓取并发（用户确认）
/** 顺序翻页上限（站点定义 followPagesUntilEmpty 时生效；靠流程内「连续 3 页无图」提前停止） */
const FOLLOW_PAGES_CAP = 40

// ---- Google 通道限频（FP-024）：密集/高频请求会触发 Google 反爬，必须极力避免 ----
const KEY_GOOGLE_COOLDOWN = 'google_cooldown_until'
/** 相邻两次 Google 页面请求的最小间隔（含跨站；标签页本身还要渲染，实际间隔更长） */
const GOOGLE_TAB_INTERVAL_MS = 4000
/** 单轮聚合搜索允许的 Google 页面请求上限（跨站共享） */
const GOOGLE_MAX_REQUESTS_PER_RUN = 8
/** 被 Google 拒绝后的冷却时长：冷却期内不再发起任何 Google 请求 */
const GOOGLE_COOLDOWN_MS = 15 * 60 * 1000

export class BuonduaService {
  /** Google 全站模式：为无 sitesearch 配置的站点构造 Google 搜索配置（FP-013 调整）
   *  2026-10-07（FP-022）：Google 已拒绝 gbv=1 / sitesearch= 老参数（实测 403），改用现行 site: 语法；
   *  结果提取走 searchGoogleViaTab（标签页 + executeScript，仅标题+链接）
   *  FP-014：优先主域（m./www./mobile. 子域 Google 索引差，如 phimvuspot 用 phimvuspot.com 而非 m. 版） */
  private googleSearchConfig(site: GallerySiteConfig): GallerySiteConfig {
    const host = site.hosts.find((h) => !/^(m|www|mobile)\./i.test(h)) ?? site.hosts[0] ?? site.id
    return {
      ...site,
      searchUrl: (q, page) =>
        `https://www.google.com/search?q=${encodeURIComponent(`${q} site:${host}`)}&hl=zh-CN${
          page > 1 ? `&start=${(page - 1) * 10}` : ''
        }`,
    }
  }

  /** 站内搜索接口 fetch（FP-014 抽取：Google 降级与普通站内分支共用）：
   *  jrants 页间强制间隔防限流；反爬拦截页跳过；无结果提前 break */
  private async fetchSiteSearch(
    site: GallerySiteConfig,
    query: string,
    pagesPerSite: number,
    startPage: number,
  ): Promise<{ items: BuonduaLinkItem[]; pages: number; error?: string }> {
    const items: BuonduaLinkItem[] = []
    let pages = 0
    let error: string | undefined
    for (let page = startPage; page < startPage + pagesPerSite; page++) {
      const url = site.searchUrl?.(query, page)
      if (!url) break
      // 页间节流：按站点定义 throttle（jrants 连续快速搜索触发反爬限流，实测 2026-08-13/14）
      const throttle = site.def.throttle
      if (throttle && page >= throttle.fromPage) await sleep(throttle.delayMs)
      const html = await this.fetchHtml(url)
      pages++
      if (isBlockedPage(html)) {
        // 反爬拦截页：跳过该站（避免把热门/推荐链接当搜索结果）
        error = '搜索被反爬拦截（限流），请稍后重试'
        logger.warn('buondua', '站点搜索被反爬拦截', { site: site.id, len: html.length })
        break
      }
      const parsed = parseLinksForSite(site.id, html, url)
      if (parsed.length === 0) {
        break // 无更多结果
      }
      items.push(...parsed)
    }
    return { items, pages, error }
  }

  /** Google 通道冷却剩余毫秒（FP-024；0 表示可用） */
  private async googleCooldownRemainMs(): Promise<number> {
    const until = (await storageGet<number>(KEY_GOOGLE_COOLDOWN)) ?? 0
    return Math.max(0, until - Date.now())
  }

  /** Google 通道：页面降级搜索（FP-012/093）——后台静默打开 Google 搜索标签（真实浏览器 JS 渲染），
   *  提取渲染后结果（a.zReHs + h3 / h3.r > a），逐页进行，完成后关闭标签。
   *  后台 fetch 拿不到新版 Google 结果（JS 渲染壳），此通道与用户手动搜索等效。
   *
   *  FP-024 限频（用户实测结论：密集高频请求会触发 Google 反爬，必须极力避免）：
   *  ① 冷却检查：被拒后 GOOGLE_COOLDOWN_MS 内不再发起任何 Google 请求
   *  ② 请求间隔：相邻请求（含跨站）至少 GOOGLE_TAB_INTERVAL_MS
   *  ③ 单轮预算：整轮聚合搜索共享 GOOGLE_MAX_REQUESTS_PER_RUN 次上限
   *  ④ 标签页复用：同站多页在同一标签页内导航，避免反复新建标签页的自动化特征 */
  async searchGoogleViaTab(
    site: GallerySiteConfig,
    query: string,
    pagesPerSite: number,
    startPage = 1,
    budget: { used: number } = { used: 0 },
  ): Promise<{
    items: BuonduaLinkItem[]
    pages: number
    blocked?: boolean
    cooldownRemainMs?: number
    budgetExhausted?: boolean
  }> {
    const cooldown = await this.googleCooldownRemainMs()
    if (cooldown > 0) {
      logger.warn('buondua', 'Google 通道冷却中，跳过', {
        site: site.id,
        remainMin: Math.ceil(cooldown / 60000),
      })
      return { items: [], pages: 0, blocked: true, cooldownRemainMs: cooldown }
    }
    const items: BuonduaLinkItem[] = []
    const seen = new Set<string>()
    let pagesFetched = 0
    let blocked = false
    let cooldownRemainMs: number | undefined
    let budgetExhausted = false
    let tabId: number | undefined
    try {
      for (let page = startPage; page < startPage + pagesPerSite; page++) {
        const url = site.searchUrl?.(query, page)
        if (!url) break
        if (budget.used >= GOOGLE_MAX_REQUESTS_PER_RUN) {
          budgetExhausted = true
          logger.warn('buondua', '本轮 Google 请求已达上限，停止', {
            site: site.id,
            used: budget.used,
            limit: GOOGLE_MAX_REQUESTS_PER_RUN,
          })
          break
        }
        // ② 请求间隔（首个请求不等）
        if (budget.used > 0) await sleep(GOOGLE_TAB_INTERVAL_MS)
        budget.used++
        // ④ 标签页复用：首个请求新建，其后在同一标签页内导航
        if (tabId === undefined) {
          const tab = await chrome.tabs.create({ url, active: false })
          tabId = tab.id
        } else {
          await chrome.tabs.update(tabId, { url })
          await sleep(600) // 等导航状态切换，避免把上一次的 complete 误判为本次完成
        }
        if (tabId === undefined) break
        const ok = await this.waitForTabComplete(tabId, 12000)
        if (!ok) {
          logger.warn('buondua', 'Google 标签页加载超时', { site: site.id, page })
          break
        }
        const extracted = await this.extractGoogleTabResults(tabId)
        logger.info('buondua', 'Google 标签页提取', {
          site: site.id,
          page,
          count: extracted.items.length,
          blocked: extracted.blocked,
          requestsUsed: budget.used,
        })
        // Google 明确拒绝（403 / 人机验证）：进入冷却并停止，标签页保留给用户手动完成验证
        if (extracted.blocked) {
          blocked = true
          cooldownRemainMs = GOOGLE_COOLDOWN_MS
          await storageSet(KEY_GOOGLE_COOLDOWN, Date.now() + GOOGLE_COOLDOWN_MS)
          logger.warn('buondua', 'Google 拒绝请求，进入冷却期', {
            site: site.id,
            cooldownMin: GOOGLE_COOLDOWN_MS / 60000,
          })
          break
        }
        if (extracted.items.length === 0) break // 无结果（无匹配）
        pagesFetched++
        for (const { url: rawUrl, title } of extracted.items) {
          const clean = cleanGoogleResult(site, rawUrl, title)
          if (clean && !seen.has(clean.url)) {
            seen.add(clean.url)
            items.push(clean)
          }
        }
      }
    } finally {
      // 被拒时保留标签页（用户需在其中手动完成验证），其余情况关闭
      if (tabId !== undefined && !blocked) await chrome.tabs.remove(tabId).catch(() => {})
    }
    return { items, pages: pagesFetched, blocked, cooldownRemainMs, budgetExhausted }
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

  /** 在 Google 搜索标签内等待 JS 渲染并提取结果；同时识别 403 / 人机验证页（FP-022）
   *  被拒时返回 blocked=true（调用方据此保留标签页供用户手动完成验证） */
  private extractGoogleTabResults(
    tabId: number,
  ): Promise<{ items: { url: string; title: string }[]; blocked: boolean }> {
    return chrome.scripting
      .executeScript({
        target: { tabId },
        func: async () => {
          // 等待结果渲染（最多 ~8s，500ms 轮询；缩短防无响应卡死，FP-014 修复 5）
          for (let i = 0; i < 16; i++) {
            if (document.querySelector('a.zReHs, h3.r')) break
            if (document.title.includes('未找到') || /did not match|No results found/i.test(document.body?.innerText ?? '')) break
            await new Promise((r) => setTimeout(r, 500))
          }
          const head = `${document.title} ${(document.body?.innerText ?? '').slice(0, 1500)}`
          // 403 / 人机验证特征（Google 中文/英文错误页与验证页）
          const isBlocked = /您的客户端没有权限|没有权限.{0,10}获取 URL|系统检测到异常流量|unusual traffic|not a robot|recaptcha|sorry\/index|自动化查询/i.test(
            head,
          )
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
          // 模式 ②：h3.r > a（基础 HTML 版遗留结构）
          if (out.length === 0) {
            document.querySelectorAll('h3.r > a').forEach((a) => {
              const anchor = a as HTMLAnchorElement
              push(anchor.href, a.textContent ?? '')
            })
          }
          // 仅在「命中特征且确实没提取到结果」时判定被拒，避免正常页面误判
          return { items: out, blocked: isBlocked && out.length === 0 }
        },
      })
      .then((res) => (res[0]?.result ?? { items: [], blocked: false }))
      .catch((err) => {
        logger.warn('buondua', 'Google 标签页注入失败', { tabId, error: String(err) })
        return { items: [], blocked: false }
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
        // 429/503：短时过载或限流 → 退避后再抛，交由上层重试（FETCH_ATTEMPTS）避开限流窗口
        if (resp.status === 429 || resp.status === 503) {
          logger.warn('buondua', `HTTP ${resp.status} 被限流，等待 2500ms 后重试`, { url })
          await sleep(2500)
        }
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
    const detectedMax = parseGalleryMaxPage(firstHtml, site)
    // 2026-10-10：分页总数不可测的站点（分页链接不在 <a> 中，如 knit.bid）→ 顺序翻页，
    // 由下方「连续 3 页无图」提前停止；上限 FOLLOW_PAGES_CAP 防止无意义翻页
    const maxPage = site.def.followPagesUntilEmpty ? Math.max(detectedMax, FOLLOW_PAGES_CAP) : detectedMax
    if (site.def.followPagesUntilEmpty) {
      logger.info('buondua', '启用顺序翻页（分页总数不可测）', {
        site: site.id,
        detected: detectedMax,
        cap: FOLLOW_PAGES_CAP,
      })
    }
    const all: string[] = []
    for (let p = 1; p <= maxPage; p++) {
      all.push(site.pageUrl(base, p))
    }
    const imagesMap = new Map<string, BuonduaImage>()
    let scanned = 0
    let emptyStreak = 0
    // 页间节流（站点定义 throttle，与站内搜索共用）：顺序翻页的站点请求较多，避免触发站点限流（429）
    const pageThrottle = site.def.throttle
    for (let pageIndex = 0; pageIndex < all.length; pageIndex++) {
      const pageUrl = all[pageIndex]
      let html: string
      if (pageIndex === 0) {
        // 第 1 页内容已在上方抓取（firstHtml）→ 复用，避免重复请求
        html = firstHtml
      } else {
        if (pageThrottle && pageIndex + 1 >= pageThrottle.fromPage) await sleep(pageThrottle.delayMs)
        html = await getHtml(pageUrl)
      }
      const imgs = parseGalleryImages(html, pageUrl, site)
      // 诊断（2026-10-08）：首页解析 0 张时记录容器匹配情况，用于区分
      // 「容器 class 已变」（hasContainer=false）与「页面本身没有图片内容」（imgCount 小）
      if (imgs.length === 0 && imagesMap.size === 0 && pageUrl === all[0]) {
        logger.warn('buondua', '首页解析 0 张，诊断信息', {
          site: site.id,
          url: pageUrl,
          hasContainer: site.containerOpen.test(html),
          htmlLen: html.length,
          imgTags: (html.match(/<img\b/gi) ?? []).length,
        })
      }
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

  /** 解析推荐/其他相册链接（按站点定义 scan 字段路由，解析器注册表见 sites/parsers.ts） */
  async scanLinks(url: string, kind: 'recommended' | 'popular'): Promise<BuonduaLinkItem[]> {
    const html = await this.fetchHtml(url)
    const base = url
    const site = matchGallerySite(url)
    const items = scanSiteLinks(site, html, base, kind)
    logger.info('buondua', '链接扫描完成', { kind, count: items.length, site: site?.id ?? 'buondua' })
    return items
  }

  /** 站内列表页遍历（FP-023 列表浏览）：逐页 fetch + 解析相册链接，不依赖搜索引擎
   *  pageKind：界面手动指定的分页方式（2026-10-08 体检 P0-3）
   *  fetchHtmlFn：可选，降级用（content 页面内 fetch 带 Cookie 穿透反爬） */
  async fetchSiteList(
    siteId: string,
    listUrl: string,
    pages: number,
    pageKind?: 'query' | 'path' | 'path-slash',
    fetchHtmlFn?: (u: string) => Promise<string>,
  ): Promise<{ items: BuonduaLinkItem[]; pages: string[] }> {
    const getHtml = fetchHtmlFn ?? ((u: string) => this.fetchHtml(u))
    const site = siteById(siteId)
    if (!site) throw new Error(`未知站点（${siteId}）`)
    const urls: string[] = []
    for (let p = 1; p <= Math.max(1, pages); p++) urls.push(listPageUrl(site, listUrl, p, pageKind))
    const byUrl = new Map<string, BuonduaLinkItem>()
    for (const pageUrl of urls) {
      const html = await getHtml(pageUrl)
      if (isBlockedPage(html)) {
        logger.warn('buondua', '列表页被反爬拦截', { site: siteId, url: pageUrl })
        break
      }
      for (const item of parseListPageLinks(html, pageUrl, site)) {
        if (!byUrl.has(item.url)) byUrl.set(item.url, item)
      }
    }
    logger.info('buondua', '列表页抓取完成', {
      site: siteId,
      listUrl,
      pages: urls.length,
      unique: byUrl.size,
    })
    return { items: [...byUrl.values()], pages: urls }
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
   *  网页通道（标签页渲染，仅标题+链接，同站去重，速度快）；不读站内搜索接口
   *  googleSites：Google 组站点（FP-014）——这些站优先走 Google，失败自动降级站内 */
  async searchSites(
    query: string,
    sites: string[],
    pagesPerSite: number,
    onSite: (siteId: string, items: BuonduaLinkItem[], error?: string) => Promise<void> | void,
    startPage = 1,
    useGoogleAll = false,
    googleSites: string[] = [],
  ): Promise<BuonduaLinkItem[]> {
    const mergedMap = new Map<string, BuonduaLinkItem>()
    const siteStats: Record<string, { count: number; pages: number; error?: string }> = {}
    // Google 通道限频预算（FP-024）：整轮聚合搜索跨站共享，避免密集请求触发反爬
    const googleBudget = { used: 0 }
    for (const siteId of sites) {
      const site = siteById(siteId)
      // Google 通道站点不要求站内 searchUrl：useGoogleAll（全站模式）或 googleSites（Google 组）
      // 都会用 googleSearchConfig 动态构造 Google 搜索 URL（FP-025 修复：此前漏判 googleSites，
      // 导致 ilovexs / phimvuspot 这类「无 search 字段、只靠 Google 通道」的站点被误判为「该站不支持搜索」）
      const useGoogleChannel = useGoogleAll || googleSites.includes(siteId)
      if (!site || (!site.searchUrl && !useGoogleChannel)) {
        await onSite(siteId, [], '该站不支持搜索')
        continue
      }
      const items: BuonduaLinkItem[] = []
      let error: string | undefined
      let pagesFetched = 0
      try {
        // Google 通道站点（searchAlbumPath）或 Google 全站模式（useGoogleAll）或无站内搜索接口的站（isGoogleOnly）或
        // Google 组站点（googleSites 显式指定，FP-014：pixibb/rrwsh/cangcuc 站内无结果 → 强制 Google 优先，失败降级站内）：
        // 后台 fetch 拿不到新版 Google 结果（JS 渲染壳），走页面降级通道（静默开标签渲染 + 提取，FP-012/093）
        const isGoogleOnly = !site.searchUrl && !site.searchAlbumPath
        if (site.searchAlbumPath || useGoogleAll || isGoogleOnly || googleSites.includes(siteId)) {
          const googleSite = useGoogleAll || isGoogleOnly || googleSites.includes(siteId) ? this.googleSearchConfig(site) : site
          const tabRes = await this.searchGoogleViaTab(googleSite, query, pagesPerSite, startPage, googleBudget)
          pagesFetched = tabRes.pages
          for (const item of tabRes.items) items.push(item)
          if (tabRes.blocked) {
            // Google 拒绝（403 / 人机验证，FP-022）或处于冷却期（FP-024）：明确提示并停止，避免反复触发
            const remainMin = tabRes.cooldownRemainMs ? Math.ceil(tabRes.cooldownRemainMs / 60000) : 0
            error =
              remainMin > 0
                ? `Google 拒绝本次请求（403 / 人机验证）：Google 通道已暂停 ${remainMin} 分钟，请稍后重试或改用站内通道`
                : 'Google 拒绝本次请求（403 / 人机验证）：已保留搜索标签页，请手动完成验证后重试'
          } else if (tabRes.budgetExhausted) {
            error = `本轮 Google 请求已达上限（${GOOGLE_MAX_REQUESTS_PER_RUN} 次），已停止以避免触发反爬，请稍后再搜或改用站内通道`
          } else if (tabRes.items.length === 0 && site.searchUrl) {
            // FP-014 修复：Google 通道无结果且该站有站内搜索接口 → 自动降级站内 fetch
            // （Google 全站模式下老站 buondua/rrwsh/jrants 等的救回路）
            logger.info('buondua', 'Google 通道无结果，降级站内搜索', { site: siteId, query })
            const fallback = await this.fetchSiteSearch(site, query, pagesPerSite, startPage)
            pagesFetched = Math.max(pagesFetched, fallback.pages)
            for (const item of fallback.items) items.push(item)
            if (fallback.items.length > 0) {
              error = undefined // 降级成功：清掉 Google 错误提示
            } else if (fallback.error) {
              error = fallback.error
            }
          }
          if (tabRes.items.length === 0 && items.length === 0 && !error) {
            error = 'Google 标签页未提取到相册结果（可能验证页/无匹配，日志含诊断）'
          }
        } else {
          const fallback = await this.fetchSiteSearch(site, query, pagesPerSite, startPage)
          pagesFetched = fallback.pages
          for (const item of fallback.items) items.push(item)
          if (fallback.error) error = fallback.error
        }
      } catch (err) {
        error = humanizeFetchError(String(err))
        logger.warn('buondua', '站点搜索失败', { site: siteId, error: String(err), hint: error })
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

  /** 相册文件夹名：ID-{站点 folderTag}-{相册名}-{时间戳}
   *  阶段 1：全部站点 folderTag='buondua'，命名与旧版逐字一致（语义化改名属行为变更，另行申请） */
  buildFolderName(title: string, url: string): string {
    const tag = matchGallerySite(url)?.def.folderTag ?? 'buondua'
    const name = extractBuonduaAlbumName(title, url)
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return `ID-${tag}-${name}-${ts}`
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
      const tab = await chrome.tabs.create({ url: 'https://www.google.com/search?q=test', active: false })
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
        // 403 / 人机验证识别（FP-022）
        const blocked = /403|您的客户端没有权限|系统检测到异常流量|unusual traffic|not a robot|recaptcha/i.test(
          `${info.title} ${info.body}`,
        )
        if (blocked) logger.warn('buondua', 'Google 测试：被拒绝（403 / 人机验证）', { ...diag, ms })
        else if (diag.hasH3) logger.info('buondua', 'Google 标签页测试：正常', { ...diag, ms })
        else logger.warn('buondua', 'Google 标签页测试：无结果', { ...diag, ms })
        return { ok: true, status: 200, blocked, ms, diag }
      } finally {
        await chrome.tabs.remove(tab.id!).catch(() => {})
      }
    } catch (err) {
      logger.warn('buondua', 'Google 标签页测试失败', { error: String(err), ms: Date.now() - start })
      return { ok: false, blocked: false, ms: Date.now() - start, error: String(err) }
    }
  }
}

/** 搜索项站点后处理：URL 改写（rrwsh 4khd→rrwsh 域）+ 张数提取（FP-012） */
function enrichSearchItem(siteId: string, site: GallerySiteConfig, item: BuonduaLinkItem): BuonduaLinkItem {
  const url = site.rewriteUrl ? site.rewriteUrl(item.url) : item.url
  return { ...item, url, imageCount: item.imageCount ?? extractSearchImageCount(siteId, item, url) }
}

/** 网络 / HTTP 错误 → 可读提示（用户实测反馈的「搜索失败」需要能判断该做什么） */
export function humanizeFetchError(raw: string): string {
  if (/Failed to fetch|NetworkError|ERR_/i.test(raw)) return '站点不可达（域名可能已变更或网络受限）'
  if (/HTTP 403/.test(raw)) return '被站点拒绝（反爬拦截，可稍后重试）'
  if (/HTTP 429/.test(raw)) return '被站点限流（429，请求过于频繁）：请等待几分钟后再试'
  if (/HTTP 404/.test(raw)) return '页面不存在（链接可能已失效）'
  if (/HTTP 5\d\d/.test(raw)) return '站点服务器错误'
  if (/请求超时|AbortError/i.test(raw)) return '请求超时'
  return raw
}

/** 请求间隔（站点节流用） */
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
