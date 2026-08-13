// freeimage 后台服务（FP-007，background 内使用）
// 职责：fetch freeimage.host 页面 HTML → 解析 → 返回结构化数据
// 通道：全部公开页，实测无登录墙/无 Cloudflare，后台 fetch 直连
// 节流：批内串行 + 间隔；连续 429 暂停提示（对齐 imgbb 扩散节流经验）

import { initLogger } from '../lib/logger'
import { extractAlbumName, extractOwner, parseAlbumItems, parseExploreAlbums, parseExploreNextPage, parseExploreUsers, parseImageItems } from '../lib/freeimage-parse'
import type { FhAlbum, FhAlbumIndexEntry, FhImage, FhOwner } from '../lib/freeimage-types'
import type { ExploreSearchProgress, FhExploreMode, FhExploreType } from '../lib/messages'

const logger = initLogger('background')

const FETCH_TIMEOUT_MS = 20000
const FETCH_ATTEMPTS = 2
const MAX_ALBUM_PAGES = 50 // 相册内翻页上限（6 图/页 → 约 300 图）
const MAX_ALBUM_LIST_PAGES = 10 // 相册列表单次分析页数上限

/** 模式 → 排序参数（实测） */
const SORT_BY_MODE: Record<FhExploreMode, string> = {
  recent: 'date_desc',
  popular: 'views_desc',
  trending: 'likes_desc',
}

/** 探索检索条目 key（users/images 与相册区分） */
function indexKeyOf(type: FhExploreType, rawId: string): string {
  return type === 'albums' ? rawId : `${type}:${rawId}`
}

export class FreeimageService {
  /** fetch 单个页面 HTML（UA + 超时 + 重试 1 次） */
  async fetchHtml(url: string): Promise<string> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      try {
        return await this.fetchOnce(url)
      } catch (err) {
        lastErr = err
        logger.warn('freeimage', `页面抓取第 ${attempt} 次失败`, { url, error: String(err) })
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
          Referer: 'https://freeimage.host/',
        },
        signal: controller.signal,
      })
      if (!resp.ok) {
        // 429 带独立信息，方便上层限流判断
        if (resp.status === 429) throw new Error('HTTP 429（限流）')
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

  /** 提取用户主页 URL（输入用户名或完整 URL → 规范化） */
  normalizeUserUrl(input: string): string {
    const trimmed = input.trim()
    if (/^https?:\/\/freeimage\.host\//i.test(trimmed)) {
      return trimmed.replace(/\/+$/, '')
    }
    return `https://freeimage.host/${trimmed.replace(/^\/+|\/+$/g, '')}`
  }

  /** 用户主页分页抓取：{user}?list=images&sort=date_desc&page=N&ajax=1 */
  async fetchUserPages(url: string, pageFrom: number, pageTo: number): Promise<FhImage[]> {
    const base = url.split('?')[0]
    const all: FhImage[] = []
    for (let page = pageFrom; page <= pageTo; page++) {
      const pageUrl = `${base}?list=images&sort=date_desc&page=${page}&ajax=1`
      const html = await this.fetchHtml(pageUrl)
      const images = parseImageItems(html)
      all.push(...images)
      if (images.length === 0) break // 无更多页
    }
    logger.info('freeimage', '用户主页分页抓取完成', { url: base, pageFrom, pageTo, count: all.length })
    return all
  }

  /** 探索页分页抓取：/explore?ajax=1&list=images&sort=date-added-desc&page=N */
  async fetchExplorePages(pageFrom: number, pageTo: number): Promise<FhImage[]> {
    const all: FhImage[] = []
    for (let page = pageFrom; page <= pageTo; page++) {
      const pageUrl = `https://freeimage.host/explore?ajax=1&list=images&sort=date-added-desc&page=${page}`
      const html = await this.fetchHtml(pageUrl)
      const images = parseImageItems(html)
      all.push(...images)
      if (images.length === 0) break
    }
    logger.info('freeimage', '探索页分页抓取完成', { pageFrom, pageTo, count: all.length })
    return all
  }

  /** 相册列表分页：/{user}/albums?sort={sort}&page=N */
  async fetchAlbumsPage(username: string, sort: string, page: number): Promise<FhAlbum[]> {
    const html = await this.fetchHtml(
      `https://freeimage.host/${encodeURIComponent(username)}/albums?sort=${sort}&page=${page}`,
    )
    const albums = parseAlbumItems(html)
    logger.info('freeimage', '相册列表抓取完成', { username, sort, page, count: albums.length })
    return albums
  }

  /** 相册全量抓取：首屏 + AJAX 翻页（6 图/页，去重终止） */
  async fetchAlbumImages(albumUrl: string): Promise<{ images: FhImage[]; name: string }> {
    const base = albumUrl.split('?')[0]
    const firstHtml = await this.fetchHtml(base)
    const name = extractAlbumName(firstHtml) ?? ''
    // 相册 ID：data-params-hidden="list=images&from=album&albumid=zLEWQ" 或列表容器 data-id
    const albumId =
      firstHtml.match(/albumid=([a-zA-Z0-9]+)/)?.[1] ?? firstHtml.match(/data-id="([a-zA-Z0-9]+)"[^>]*data-type="album"/)?.[1]

    const seen = new Map<string, FhImage>()
    const addImages = (images: FhImage[]): number => {
      let added = 0
      for (const img of images) {
        if (!seen.has(img.originalUrl)) {
          seen.set(img.originalUrl, img)
          added++
        }
      }
      return added
    }
    addImages(parseImageItems(firstHtml))

    if (albumId) {
      for (let page = 2; page <= MAX_ALBUM_PAGES; page++) {
        const pageUrl = `${base}?list=images&from=album&albumid=${albumId}&sort=date_desc&page=${page}&ajax=1`
        try {
          const html = await this.fetchHtml(pageUrl)
          const images = parseImageItems(html)
          const added = addImages(images)
          logger.debug('freeimage', '相册翻页', { page, pageImages: images.length, added, total: seen.size })
          if (images.length === 0 || added === 0) break // 无更多或已无新增
        } catch (err) {
          logger.warn('freeimage', '相册翻页失败（截断）', { page, error: String(err) })
          break
        }
      }
    }

    const images = [...seen.values()]
    logger.info('freeimage', '相册全量抓取完成', { albumUrl: base, name, count: images.length })
    return { images, name }
  }

  /** 图片页属主提取（批量串行 + 间隔，匿名跳过），返回 {url → owner} 映射 */
  async extractOwners(
    imageViewerUrls: string[],
    samplePerPage: number,
    intervalMs: number,
  ): Promise<{ owner: FhOwner; imageUrl: string }[]> {
    // 采样：每页最多 samplePerPage 张（保持顺序）
    const sampled = samplePerPage > 0 ? imageViewerUrls.filter((_, i) => i % Math.ceil(Math.max(1, imageViewerUrls.length / Math.min(samplePerPage, imageViewerUrls.length))) === 0) : imageViewerUrls
    const results: { owner: FhOwner; imageUrl: string }[] = []
    for (const viewerUrl of sampled.slice(0, 200)) {
      try {
        const html = await this.fetchHtml(viewerUrl)
        const owner = extractOwner(html)
        if (owner) {
          results.push({ owner, imageUrl: viewerUrl })
        }
        await sleep(intervalMs)
      } catch (err) {
        logger.warn('freeimage', '属主提取失败（跳过）', { url: viewerUrl, error: String(err) })
      }
    }
    logger.info('freeimage', '属主提取完成', { sampled: sampled.length, owners: results.length })
    return results
  }

  /** 候选用户相册名采集（L2 扩散）：抓相册列表 → 返回相册线索 */
  async collectAlbumsForUser(
    username: string,
    maxPages: number = MAX_ALBUM_LIST_PAGES,
  ): Promise<{ username: string; albums: { name: string; url: string }[]; albumCount: number; truncated: boolean }> {
    const all: FhAlbum[] = []
    const seen = new Set<string>()
    let truncated = false
    for (let page = 1; page <= maxPages; page++) {
      try {
        const albums = await this.fetchAlbumsPage(username, 'views_desc', page)
        let added = 0
        for (const a of albums) {
          if (!seen.has(a.id)) {
            seen.add(a.id)
            all.push(a)
            added++
          }
        }
        if (albums.length === 0 || added === 0) break
      } catch (err) {
        logger.warn('freeimage', '用户相册采集失败', { username, page, error: String(err) })
        truncated = true
        break
      }
    }
    return {
      username,
      albums: all.map((a) => ({ name: a.name, url: a.url })),
      albumCount: all.length,
      truncated,
    }
  }

  // ---------- 探索检索（场景 D v8：批次会话，仅文字信息，快） ----------

  /** 检索会话（批次间保持游标） */
  private searchSession: { mode: FhExploreMode; list: FhExploreType; currentUrl: string; cancelled: boolean } | null = null

  /** 开始新检索会话（重置游标到第 1 页） */
  startSearch(mode: FhExploreMode, list: FhExploreType): void {
    const sort = SORT_BY_MODE[mode]
    this.searchSession = {
      mode,
      list,
      currentUrl: `https://freeimage.host/explore/${mode}/?list=${list}&sort=${sort}&page=1`,
      cancelled: false,
    }
  }

  /** 是否有活动检索会话 */
  hasSearchSession(): boolean {
    return this.searchSession !== null && !this.searchSession.cancelled
  }

  /** 当前会话模式/类型（NEXT 批沿用） */
  getSessionInfo(): { mode: FhExploreMode; list: FhExploreType } | null {
    const s = this.searchSession
    if (!s || s.cancelled) return null
    return { mode: s.mode, list: s.list }
  }

  /** 请求停止探索检索 */
  cancelExploreSearch(): void {
    if (this.searchSession) this.searchSession.cancelled = true
  }

  /**
   * 跑一批（rounds 页）：跟 seek 游标逐页抓取，仅解析文字，每页 onRound 推送
   * 返回是否有更多页（false = 已到最后一页，会话自动结束）
   */
  async runSearchBatch(
    rounds: number,
    intervalMs: number,
    onRound: (progress: ExploreSearchProgress) => Promise<void>,
  ): Promise<{ more: boolean }> {
    const s = this.searchSession
    if (!s || s.cancelled) {
      throw new Error('无活动检索会话（请先开始检索）')
    }
    for (let round = 1; round <= rounds; round++) {
      if (s.cancelled) break
      let html: string
      try {
        html = await this.fetchHtml(s.currentUrl)
      } catch (err) {
        logger.warn('freeimage', '探索检索抓页失败（截断）', { url: s.currentUrl, error: String(err) })
        s.cancelled = true
        return { more: false }
      }
      const newEntries: FhAlbumIndexEntry[] = []
      if (s.list === 'albums') {
        for (const a of parseExploreAlbums(html)) {
          newEntries.push({
            id: indexKeyOf(s.list, a.id),
            name: a.name,
            url: a.url,
            imageCount: a.description ? Number(a.description.replace(/[^0-9]/g, '')) || undefined : undefined,
            source: `${s.mode}-${s.list}`,
            collectedAt: Date.now(),
          })
        }
      } else if (s.list === 'users') {
        for (const u of parseExploreUsers(html)) {
          newEntries.push({
            id: indexKeyOf(s.list, u.username),
            name: u.username,
            url: u.url,
            username: u.username,
            source: `${s.mode}-${s.list}`,
            collectedAt: Date.now(),
          })
        }
      } else {
        for (const img of parseImageItems(html)) {
          newEntries.push({
            id: indexKeyOf(s.list, img.id),
            name: img.name,
            url: img.viewerUrl || img.originalUrl,
            source: `${s.mode}-${s.list}`,
            collectedAt: Date.now(),
          })
        }
      }
      await onRound({
        round,
        pageFrom: round,
        pageTo: round,
        added: newEntries.length,
        total: 0, // 由调用方（background）回填索引库累计
        newEntries,
        mode: s.mode,
        type: s.list,
      })
      // 跟随 seek 游标翻页
      const next = parseExploreNextPage(html, s.currentUrl)
      if (!next || next === s.currentUrl || newEntries.length === 0) {
        s.cancelled = true
        return { more: false }
      }
      s.currentUrl = next
      if (intervalMs > 0) await sleep(intervalMs)
    }
    return { more: !s.cancelled }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
