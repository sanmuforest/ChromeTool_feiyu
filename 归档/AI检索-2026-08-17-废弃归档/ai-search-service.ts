// AI 检索编排服务（FP-013，background 内使用）
// 状态机：策略 → 查询队列（变体 × 域名）→ 分批 fetch Bing SERP → 解析 → L0 过滤 → 推送
// 批次节奏阀：AI_SEARCH_BATCH 每批 5 条查询，并发 2 + 间隔，防反爬
// 会话预算：maxQueries 硬性计数，超限自动结束

import { initLogger } from '../lib/logger'
import { buildSeedStrategy, isCompliantText } from '../lib/ai-strategy'
import {
  buildBingImageUrl,
  buildBingWebUrl,
  buildYandexImageUrl,
  parseBingImageSerp,
  parseBingWebSerp,
  parseYandexImageSerp,
  type BingImageResult,
} from '../lib/ai-serp'
import { filterAndScore } from '../lib/ai-filter'
import type {
  AiAlbumItem,
  AiCustomDomains,
  AiQuery,
  AiSearchProgress,
  AiSearchRequest,
  AiSearchSession,
  AiStrategy,
} from '../lib/ai-types'
import { sendToTab } from '../lib/messages'
import { BuonduaService } from './buondua-service'
import { GALLERY_SITES } from '../lib/gallery-sites'
import type { BuonduaLinkItem } from '../lib/types'

const logger = initLogger('background')

const BATCH_SIZE = 5 // 每批查询数（节奏阀）
const CONCURRENCY = 2 // 批内并发
const INTERVAL_MS = 1200 // 批内请求间隔
const FETCH_TIMEOUT_MS = 20000
const DEFAULT_MAX_QUERIES = 40 // 会话查询预算默认值（Yandex+Bing 双通道后调高）
const SEARCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** 站内搜索站点（FP-012 已验证链路：写真站自身搜索，不受搜索引擎政策影响） */
const SITE_SEARCH_IDS = ['jrants', 'pixibb', 'rrwsh', 'hitxhot', 'kaizty']

export class AiSearchService {
  private session: AiSearchSession | null = null
  private running = false
  /** 启动锁：runSiteSearch 阶段 running 未置位，连点 AI 检索会交叉覆盖 session——start 全程上锁 */
  private starting = false
  /** 取消信号：cancel 时 abort 所有在途 fetch（取消及时性） */
  private cancelCtrl: AbortController | null = null

  /** 启动 AI 检索（重置状态机） */
  async start(srcTabId: number, request: AiSearchRequest): Promise<void> {
    if (this.running || this.starting) {
      throw new Error('已有进行中的 AI 检索，请先取消')
    }
    this.starting = true
    this.cancelCtrl = new AbortController()
    try {
      const customDomains = await this.loadCustomDomains()
      const strategy = buildSeedStrategy(request.keyword, request.manualVariants || [], customDomains)
      if (strategy.variants.length === 0) {
        throw new Error('关键词被合规过滤拦截，请更换关键词')
      }
      this.session = {
        request,
        strategy,
        queries: this.buildQueries(strategy, request.useImages !== false),
        queryIndex: 0,
        results: [],
        requests: 0,
        cancelled: false,
        finished: false,
        startedAt: Date.now(),
      }
      const maxQueries = request.maxQueries ?? DEFAULT_MAX_QUERIES
      if (this.session.queries.length > maxQueries) {
        this.session.queries = this.session.queries.slice(0, maxQueries)
      }
      logger.info('ai-search', 'AI 检索启动', {
        keyword: request.keyword,
        variants: strategy.variants.length,
        domains: strategy.domains.length,
        queries: this.session.queries.length,
      })
      await this.pushProgress(srcTabId, 'strategy', '检索中：站内 + Google + Yandex 三路并行')
      // 三路并行（修复记录 13：原串行总时长 = 三路之和，现 ≈ 最慢一路；各路独立增量推送）
      const tasks: Promise<void>[] = [this.runSiteSearch(srcTabId, strategy.variants)]
      if (request.useImages !== false) {
        tasks.push(this.runGoogleImageSearch(srcTabId, strategy.domains, strategy.variants))
        tasks.push(this.runYandexQueue(srcTabId))
      }
      await Promise.all(tasks)
      const session = this.session
      if (!session) return
      if (session.cancelled) {
        await this.pushDone(srcTabId, '已取消')
        session.finished = true
      } else {
        await this.pushDone(srcTabId, `完成，共 ${session.requests} 次请求，${session.results.length} 条候选`)
        session.finished = true
      }
    } finally {
      this.starting = false
    }
  }

  /** Yandex fetch 队列（自动连续跑完；供 start 并行调用与 batch 消息兼容） */
  private async runYandexQueue(srcTabId: number): Promise<void> {
    const session = this.session
    if (!session || session.finished || session.cancelled) return
    if (this.running) return
    this.running = true
    try {
      while (session.queryIndex < session.queries.length && !session.cancelled) {
        const slice = session.queries.slice(session.queryIndex, session.queryIndex + BATCH_SIZE)
        session.queryIndex += slice.length
        await this.processQueries(srcTabId, slice)
      }
    } catch (err) {
      logger.error('ai-search', 'Yandex 队列执行失败', { error: String(err) })
      await this.pushError(srcTabId, String(err))
    } finally {
      this.running = false
    }
  }

  /** 处理查询批次（消息兼容：AI_SEARCH_BATCH 已从 UI 移除，保留入口） */
  async batch(srcTabId: number): Promise<void> {
    await this.runYandexQueue(srcTabId)
  }

  /** 取消（保留已产出结果；立即中断在途请求） */
  cancel(srcTabId: number): void {
    if (!this.session) return // SW 重启后无会话：静默忽略
    this.session.cancelled = true
    this.cancelCtrl?.abort() // 中断在途 fetch，批处理随之快速结束
    logger.info('ai-search', 'AI 检索取消')
    void this.pushProgress(srcTabId, 'filter', '取消请求已提交')
  }

  // ---------- 内部 ----------

  /** 生成查询队列（修复记录 12 通道分工）：
   *  Yandex 纯词广域查询（广域发现通道：成人宽容 + 全网图，陌生结果经相册特征判定保留）
   *  Google 图片走标签页通道（runGoogleImageSearch：site: 深挖已知站 + 纯词广域轮） */
  private buildQueries(strategy: AiStrategy, useImages: boolean): AiQuery[] {
    const qs: AiQuery[] = []
    if (!useImages) return qs
    for (const v of strategy.variants) {
      qs.push({ text: v, channel: 'yandex-image' })
    }
    return qs
  }

  /** Google 图片标签页通道：Google 对无 cookie fetch 反爬（JS 渲染壳），
   *  复用 FP-012 标签页模式——静默开标签 → 等待渲染 → executeScript 提取 imgres → 关闭
   *  通道分工（修复记录 12）：每域名 site: 深挖（host 强校验）+ 末轮纯词广域（相册特征判定） */
  private async runGoogleImageSearch(srcTabId: number, domains: string[], variants: string[]): Promise<void> {
    const session = this.session
    if (!session) return
    // 每域名 site: 深挖
    for (let di = 0; di < domains.length; di++) {
      if (session.cancelled) return
      const d = domains[di]
      const q = `site:${d} (${variants.join(' OR ')})`
      const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&tbm=isch&safe=off`
      await this.pushProgress(srcTabId, 'strategy', `Google 检索中（${di + 1}/${domains.length + 1}：${d}）`)
      const got = await this.runGoogleImageTab(srcTabId, url, d)
      if (got > 0) {
        logger.info('ai-search', 'Google 图片提取', { domain: d, count: got })
      }
    }
    if (session.cancelled) return
    // 末轮：纯词广域（发现未知写真站，陌生结果经相册特征判定）
    const broadQ = variants.join(' OR ')
    await this.pushProgress(srcTabId, 'strategy', `Google 广域检索中（${domains.length + 1}/${domains.length + 1}：全网）`)
    const broadGot = await this.runGoogleImageTab(
      srcTabId,
      `https://www.google.com/search?q=${encodeURIComponent(broadQ)}&tbm=isch&safe=off`,
      '',
    )
    if (broadGot > 0) {
      logger.info('ai-search', 'Google 广域提取', { count: broadGot })
    }
  }

  /** 单个 Google 图片标签页：开标签 → 提取 → 关标签；hitDomain 空 = 广域轮（不做 host 白名单，相册特征判定） */
  private async runGoogleImageTab(srcTabId: number, url: string, hitDomain: string): Promise<number> {
    const session = this.session
    if (!session) return 0
    const tab = await chrome.tabs.create({ url, active: false })
    try {
      const ok = await this.waitForTabComplete(tab.id!, 25000)
      session.requests++
      if (!ok) {
        logger.warn('ai-search', 'Google 图片标签页加载超时', { hitDomain })
        return 0
      }
      const items = await this.extractGoogleImageTab(tab.id!)
      if (items.length > 0) {
        await this.mergeAndPush(
          srcTabId,
          items.map((it) => ({
            url: it.imgrefurl,
            title: it.title || hitDomain || url,
            coverUrl: it.thumb,
            source: 'google-image',
            hitDomain,
          })),
        )
      }
      return items.length
    } catch (err) {
      logger.warn('ai-search', 'Google 图片通道失败', { hitDomain, error: String(err) })
      return 0
    } finally {
      await chrome.tabs.remove(tab.id!).catch(() => {})
    }
  }

  /** 等待标签页加载完成（复制 FP-012 模式） */
  private async waitForTabComplete(tabId: number, timeoutMs = 25000): Promise<boolean> {
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

  /** 在 Google 图片搜索标签内等待 JS 渲染并提取 imgres 结果（原图/来源页/缩略图/标题） */
  private extractGoogleImageTab(tabId: number): Promise<{ imgurl: string; imgrefurl: string; thumb: string; title: string }[]> {
    return chrome.scripting
      .executeScript({
        target: { tabId },
        func: async () => {
          // 等待图片结果渲染（最多 ~15s，500ms 轮询）
          for (let i = 0; i < 30; i++) {
            if (document.querySelector('a[href*="/imgres?"]')) break
            if (/did not match|未找到|No results found/i.test(document.body?.innerText ?? '')) break
            await new Promise((r) => setTimeout(r, 500))
          }
          const out: { imgurl: string; imgrefurl: string; thumb: string; title: string }[] = []
          const seen = new Set<string>()
          document.querySelectorAll('a[href*="/imgres?"]').forEach((a) => {
            try {
              const u = new URL((a as HTMLAnchorElement).href)
              const imgurl = u.searchParams.get('imgurl') ?? ''
              const imgrefurl = u.searchParams.get('imgrefurl') ?? ''
              if (!imgurl || !imgrefurl) return
              const img = a.querySelector('img')
              let thumb = img?.getAttribute('data-src') || img?.src || ''
              if (!thumb || thumb.startsWith('data:')) thumb = imgurl
              const title = (img?.alt || a.getAttribute('aria-label') || '').slice(0, 120)
              if (seen.has(imgrefurl)) return
              seen.add(imgrefurl)
              out.push({ imgurl, imgrefurl, thumb, title })
            } catch {
              /* 单项跳过 */
            }
          })
          return out
        },
      })
      .then((res) => (res[0]?.result ?? []))
      .catch((err) => {
        logger.warn('ai-search', 'Google 图片标签页注入失败', { tabId, error: String(err) })
        return []
      })
  }

  /** 公共合并推送：候选 → 过滤（host 强校验/相册特征判定/黑名单/去重）→ 陌生域名标记 → 增量推送 */
  private async mergeAndPush(srcTabId: number, candidates: Parameters<typeof filterAndScore>[0]): Promise<void> {
    const session = this.session
    if (!session) return
    const fresh = filterAndScore(candidates)
    // 陌生域名标记（广域新发现：不在种子域名候选列表）
    const knownDomains = new Set(session.strategy.domains.map((d) => d.toLowerCase()))
    const knownHosts = new Set<string>()
    for (const d of knownDomains) knownHosts.add(d)
    const known = new Set(session.results.map((r) => r.url))
    const added: AiAlbumItem[] = []
    for (const item of fresh) {
      if (known.has(item.url)) continue
      known.add(item.url)
      session.results.push(item)
      if (!knownDomains.has(item.domain)) {
        item.isNewDomain = true
      }
      added.push(item)
    }
    await this.pushItems(srcTabId, added)
  }

  /** 站内搜索融合：写真站站内搜索（复用 FP-012 searchSites 链路，不受搜索引擎成人政策影响），结果增量推送 */
  private async runSiteSearch(srcTabId: number, variants: string[]): Promise<void> {
    const buondua = new BuonduaService()
    for (const v of variants) {
      if (this.session?.cancelled) return
      try {
        await buondua.searchSites(v, SITE_SEARCH_IDS, 1, async (siteId, siteItems, error) => {
          if (this.session?.cancelled) return
          if (siteItems.length === 0) {
            if (error) logger.warn('ai-search', '站内搜索站点失败', { variant: v, siteId, error })
            return
          }
          const aiItems = siteItems.map((it) => this.toAiAlbumItem(it, siteId))
          await this.mergeAndPush(srcTabId, aiItems)
        })
        logger.info('ai-search', '站内搜索完成', { variant: v })
      } catch (err) {
        logger.warn('ai-search', '站内搜索失败', { variant: v, error: String(err) })
      }
    }
  }

  /** BuonduaLinkItem → AiAlbumItem（站内来源，高可信度分） */
  private toAiAlbumItem(it: BuonduaLinkItem, siteId: string): AiAlbumItem {
    const site = GALLERY_SITES.find((s) => s.id === siteId)
    const domain = site?.hosts[0] ?? siteId
    return {
      url: it.url,
      title: it.title,
      coverUrl: it.coverUrl,
      domain,
      source: 'site-search',
      score: 80,
    }
  }

  private async processQueries(srcTabId: number, queries: AiQuery[]): Promise<{ empty: number }> {
    const session = this.session!
    const results: Parameters<typeof filterAndScore>[0] = []
    let empty = 0 // 无产出查询计数（诊断：引擎过滤/无匹配）
    const queue = [...queries]
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0 && !session.cancelled) {
        const q = queue.shift()!
        const url = this.buildSerpUrl(q)
        try {
          const html = await this.fetchHtml(url)
          session.requests++
          const items = this.parseSerp(html, q)
          results.push(...items)
          if (items.length === 0) {
            empty++
            // 空结果诊断（对齐 FP-012 diag 思路）：记录响应特征区分「引擎过滤/无结果」与「解析失效」
            const diag = this.diagnoseSerp(html)
            logger.warn('ai-search', 'SERP 空结果诊断', { q: q.text, channel: q.channel, ...diag })
          }
          logger.debug('ai-search', 'SERP 解析', { q: q.text, channel: q.channel, got: items.length, requests: session.requests })
        } catch (err) {
          session.requests++
          // 取消触发的 AbortError 静默（批循环将因 cancelled 退出）
          if (err instanceof Error && err.name === 'AbortError') break
          empty++
          logger.warn('ai-search', 'SERP 请求失败', { q: q.text, channel: q.channel, error: String(err) })
        }
        if (queue.length > 0 && !session.cancelled) {
          await sleep(INTERVAL_MS)
        }
      }
    })
    await Promise.all(workers)
    if (session.cancelled) return { empty }
    const candidates = results
    const before = session.results.length
    await this.mergeAndPush(srcTabId, candidates)
    const added = session.results.length - before
    logger.info('ai-search', '批次结果', {
      fresh: filterAndScore(candidates).length,
      added,
      total: session.results.length,
    })
    await this.pushProgress(srcTabId, 'filter', '')
    return { empty }
  }

  /** 按通道构造 SERP URL */
  private buildSerpUrl(q: AiQuery): string {
    if (q.channel === 'yandex-image') return buildYandexImageUrl(q.text)
    if (q.channel === 'bing-image') return buildBingImageUrl(q.text)
    return buildBingWebUrl(q.text)
  }

  /** 按通道解析 SERP HTML → 候选（未过滤） */
  private parseSerp(html: string, q: AiQuery): Parameters<typeof filterAndScore>[0] {
    if (q.channel === 'yandex-image') {
      // Yandex 广域纯词：url 为 yandex 详情页/原图直链，不做 host 白名单（陌生结果经相册特征判定，修复记录 12）
      return parseYandexImageSerp(html)
        .filter((r) => isCompliantText(r.title))
        .map((r) => ({
          url: r.url,
          title: r.title || q.text,
          coverUrl: r.thumb,
          source: 'yandex-image',
          hitDomain: '',
        }))
    }
    if (q.channel === 'bing-image') {
      // Bing 图片 site: 查询：purl 应在限定域内，恢复 host 强校验（修复记录 10：防跨站无关内容）
      return parseBingImageSerp(html)
        .filter((r) => isCompliantText(r.title))
        .map((r: BingImageResult) => ({
          url: r.purl,
          title: r.title,
          coverUrl: r.murl,
          source: 'bing-image',
          hitDomain: this.hitDomainOf(q.text),
        }))
    }
    return parseBingWebSerp(html).map((r) => ({
      url: r.url,
      title: r.title,
      source: 'bing-web',
      hitDomain: this.hitDomainOf(q.text),
    }))
  }

  /** 空结果响应特征诊断：区分「引擎过滤/无结果/验证页」与「解析失效」 */
  private diagnoseSerp(html: string): { len: number; title: string; noResult: boolean; captcha: boolean; hasBAlgo: boolean; hasIusc: boolean; hasSerpItem: boolean } {
    const title = /<title>(.*?)<\/title>/i.exec(html)?.[1] ?? ''
    return {
      len: html.length,
      title: title.trim(),
      noResult:
        html.includes('没有与此相关的结果') ||
        html.includes('There are no results') ||
        html.includes('未找到相关结果') ||
        html.includes('Ничего не нашлось'),
      captcha:
        html.includes('unusual traffic') ||
        html.includes('SmartCaptcha') ||
        html.includes('CheckboxCaptcha') ||
        html.toLowerCase().includes('验证码') ||
        html.includes('challenge-form'),
      hasBAlgo: html.includes('b_algo'),
      hasIusc: html.includes('iusc'),
      hasSerpItem: html.includes('serp-item'),
    }
  }

  /** 从查询串提取限定域名（"变体 域名" 或兼容 "site:域名"） */
  private hitDomainOf(query: string): string {
    const m = /(?:site:)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(query)
    return m ? m[1].toLowerCase() : ''
  }

  private async fetchHtml(url: string): Promise<string> {
    let lastErr: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
      const onCancel = (): void => ctrl.abort()
      this.cancelCtrl?.signal.addEventListener('abort', onCancel)
      try {
        const res = await fetch(url, {
          signal: ctrl.signal,
          credentials: 'omit',
          headers: {
            'User-Agent': SEARCH_UA,
            'Accept-Language': 'en-US,en;q=0.9',
            Accept: 'text/html,application/xhtml+xml',
          },
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.text()
      } catch (err) {
        // 取消导致的 AbortError 不重试、不报错（批循环会检查 cancelled 退出）
        if (err instanceof Error && err.name === 'AbortError') {
          throw err
        }
        lastErr = err
      } finally {
        clearTimeout(timer)
        this.cancelCtrl?.signal.removeEventListener('abort', onCancel)
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
  }

  private async loadCustomDomains(): Promise<string[]> {
    try {
      const data = await chrome.storage.local.get('ai_custom_domains')
      const cfg = data.ai_custom_domains as AiCustomDomains | undefined
      return cfg?.domains ?? []
    } catch {
      return []
    }
  }

  private async pushProgress(srcTabId: number, phase: AiSearchProgress['phase'], note: string): Promise<void> {
    const session = this.session
    if (!session) return // 防御：SW 重启后无会话
    const progress: AiSearchProgress = {
      phase,
      queryIndex: session.queryIndex,
      queryTotal: session.queries.length,
      requests: session.requests,
      results: session.results.length,
      // 首次推送（strategy 阶段）携带策略摘要供 UI 展示
      variants: phase === 'strategy' ? session.strategy.variants : undefined,
      domains: phase === 'strategy' ? session.strategy.domains : undefined,
      note: note || undefined,
    }
    logger.info('ai-search', `进度 ${phase}`, { ...progress, note })
    await sendToTab(srcTabId, { type: 'AI_RESULT', payload: { kind: 'progress', progress } })
  }

  private async pushItems(srcTabId: number, items: AiAlbumItem[]): Promise<void> {
    if (items.length === 0) return
    await sendToTab(srcTabId, { type: 'AI_RESULT', payload: { kind: 'items', items } })
    logger.debug('ai-search', '结果推送', { count: items.length })
  }

  private async pushDone(srcTabId: number, note: string): Promise<void> {
    await sendToTab(srcTabId, { type: 'AI_RESULT', payload: { kind: 'done' } })
    logger.info('ai-search', 'AI 检索结束', { note })
  }

  private async pushError(srcTabId: number, error: string): Promise<void> {
    await sendToTab(srcTabId, { type: 'AI_RESULT', payload: { kind: 'error', error } })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
