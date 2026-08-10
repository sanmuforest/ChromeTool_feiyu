// imgbb 后台服务（background 内使用）
// 职责：fetch imgbb 页面 HTML → 解析 → 返回结构化数据
// 通道：全部为公开页面（/albums、ibb.co/album/{ID}、/following、/followers）；
//       用户主页 `{user}.imgbb.com/` 有登录墙，由 content script 通道处理（不在本服务）

import { initLogger } from '../lib/logger'
import {
  extractUsername,
  isLoginWall,
  parseAlbumItems,
  parseAlbumNextPage,
  parseAlbumPageTitle,
  parseImageItems,
  parseUsernameFromHtml,
  parseUserItems,
} from '../lib/imgbb-parse'
import type { ImgbbAlbum, ImgbbFollowingUser, ImgbbImage, ImgbbUser } from '../lib/types'

const logger = initLogger('background')

export class LoginWallError extends Error {
  constructor() {
    super('页面需要登录（imgbb 登录墙）')
    this.name = 'LoginWallError'
  }
}

const FETCH_TIMEOUT_MS = 20000
const CONCURRENCY = 6

export class ImgbbService {
  /** fetch 单个页面 HTML，检测登录墙 */
  async fetchHtml(url: string): Promise<string> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://imgbb.com/',
        },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}（${url}）`)
      }
      const html = await resp.text()
      if (isLoginWall(html)) {
        throw new LoginWallError()
      }
      return html
    } catch (err) {
      if (err instanceof LoginWallError) throw err
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`请求超时（${url}）`)
      }
      throw err
    }
  }

  /** 相册详情：跟随 seek 游标翻页抓取相册内全部图片（imgbb 无尽滚动，每页返回累计内容）+ 相册名 */
  async fetchAlbumImages(albumUrl: string): Promise<{ images: ImgbbImage[]; name: string }> {
    const base = albumUrl.split('?')[0]
    let currentUrl = base
    const seen = new Map<string, ImgbbImage>() // 去重键：原图 URL
    let name = ''
    let page = 0
    const MAX_PAGES = 20 // 反爬限量（参考项目同款）

    while (currentUrl && page < MAX_PAGES) {
      const html = await this.fetchHtml(currentUrl)
      if (!name) name = parseAlbumPageTitle(html) ?? ''
      const images = parseImageItems(html)
      let added = 0
      for (const img of images) {
        if (!seen.has(img.originalUrl)) {
          seen.set(img.originalUrl, img)
          added++
        }
      }
      logger.info('imgbb', '相册分页抓取', { page: page + 1, url: currentUrl, pageImages: images.length, unique: seen.size, added })
      const next = parseAlbumNextPage(html, base)
      if (!next || next === currentUrl) break
      // 页数超限或已无新增（累计页内容重复）则停止
      if (page + 1 >= MAX_PAGES || (images.length > 0 && added === 0 && seen.size >= images.length)) break
      currentUrl = next
      page++
    }

    const images = [...seen.values()]
    logger.info('imgbb', '相册全量抓取完成', { url: albumUrl, pages: page + 1, count: images.length, name })
    return { images, name }
  }

  /** 用户主页/相册页：按页抓取图片 */
  async fetchGalleryPages(url: string, pageFrom: number, pageTo: number): Promise<ImgbbImage[]> {
    const all: ImgbbImage[] = []
    for (let page = pageFrom; page <= pageTo; page++) {
      const pageUrl = `${url}${url.includes('?') ? '&' : '?'}page=${page}`
      const html = await this.fetchHtml(pageUrl)
      const images = parseImageItems(html)
      all.push(...images)
      if (images.length === 0) break // 没有更多页
    }
    logger.info('imgbb', '用户主页分页抓取完成', { url, pageFrom, pageTo, count: all.length })
    return all
  }

  /** 相册列表：抓某页相册 */
  async fetchAlbumsPage(username: string, page: number): Promise<ImgbbAlbum[]> {
    const html = await this.fetchHtml(`https://${username}.imgbb.com/albums?page=${page}`)
    const albums = parseAlbumItems(html)
    logger.info('imgbb', '相册列表抓取完成', { username, page, count: albums.length })
    return albums
  }

  /** 关注墙：抓关注/被关注用户列表（可按方向） */
  async fetchFollowingUsers(username: string, side: 'following' | 'followers' | 'both'): Promise<ImgbbUser[]> {
    const urls: string[] = []
    if (side === 'following' || side === 'both') {
      urls.push(`https://${username}.imgbb.com/following`)
    }
    if (side === 'followers' || side === 'both') {
      urls.push(`https://${username}.imgbb.com/followers`)
    }
    const htmls = await Promise.all(urls.map((u) => this.fetchHtml(u)))
    const users = htmls.flatMap((h) => parseUserItems(h))
    // 去重（同名用户可能同时关注+被关注）
    const seen = new Set<string>()
    const unique = users.filter((u) => {
      if (seen.has(u.username)) return false
      seen.add(u.username)
      return true
    })
    logger.info('imgbb', '关注墙用户抓取完成', { username, side, total: unique.length })
    return unique
  }

  /** 分析单个用户的相册（公开 /albums） */
  async analyzeUserAlbums(user: ImgbbUser): Promise<ImgbbAlbum[]> {
    const html = await this.fetchHtml(`${user.url}albums`)
    return parseAlbumItems(html)
  }

  /** 关注墙分析：一批用户逐个检索相册（并发受限），跳过无相册用户 */
  async analyzeFollowingBatch(users: ImgbbUser[], batchSize: number): Promise<ImgbbFollowingUser[]> {
    const batch = users.slice(0, batchSize)
    const results: (ImgbbFollowingUser | null)[] = new Array(batch.length).fill(null)
    let cursor = 0

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++
        if (idx >= batch.length) return
        const user = batch[idx]
        try {
          const albums = await this.analyzeUserAlbums(user)
          if (albums.length > 0) {
            results[idx] = { user, albums }
          }
        } catch (err) {
          logger.warn('imgbb', '用户相册检索失败（跳过）', { user: user.username, error: String(err) })
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()))

    const valid = results.filter((r): r is ImgbbFollowingUser => r !== null)
    logger.info('imgbb', '关注墙批次分析完成', { requested: batch.length, valid: valid.length })
    return valid
  }

  /** 从任意 imgbb URL 提取用户名（相册分析/关注墙输入框辅助） */
  extractUsernameFromUrl(url: string): string | null {
    return extractUsername(url)
  }

  /** 相册页无用户名子域：fetch 相册页 HTML 解析用户名 */
  async resolveUsernameFromAlbum(albumUrl: string): Promise<string | null> {
    const html = await this.fetchHtml(albumUrl)
    return parseUsernameFromHtml(html)
  }
}
