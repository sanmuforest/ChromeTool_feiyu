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
  matchGallerySite,
  parseGalleryImages,
  parseGalleryMaxPage,
  parseGalleryPageTitle,
} from '../lib/gallery-sites'
import type { BuonduaImage, BuonduaLinkItem } from '../lib/types'

const logger = initLogger('background')

const FETCH_TIMEOUT_MS = 20000
const CONCURRENCY = 3 // 批量抓取并发（用户确认）

export class BuonduaService {
  /** fetch 单个页面 HTML（带 UA + 超时） */
  async fetchHtml(url: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
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

  /** 单相册全子页抓取（buondua / rrwsh / hitxhot 通用）：按最大页数遍历全部子页 → 合并去重 */
  async fetchAlbumAllPages(url: string): Promise<{ images: BuonduaImage[]; pages: string[]; title: string }> {
    const site = matchGallerySite(url)
    if (!site) {
      throw new Error(`暂不支持该站点（${url}）`)
    }
    const base = site.baseUrlOf(url)
    const firstHtml = await this.fetchHtml(base)
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
      const html = await this.fetchHtml(pageUrl)
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

  /** 解析推荐/其他相册链接（其他 = 全页帖子链接 - 推荐区） */
  async scanLinks(url: string, kind: 'recommended' | 'popular'): Promise<BuonduaLinkItem[]> {
    const html = await this.fetchHtml(url)
    const base = url
    let items: BuonduaLinkItem[]
    if (kind === 'recommended') {
      items = parseRecommendedLinks(html, base)
    } else {
      // 其他链接：全页扫描帖子链接，排除推荐区已收录
      const recUrls = new Set(parseRecommendedLinks(html, base).map((i) => i.url))
      items = parseAllPostLinks(html, base, recUrls)
    }
    logger.info('buondua', '链接扫描完成', { kind, count: items.length })
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

  /** 相册文件夹名：ID-buondua-{相册名}-{时间戳} */
  buildFolderName(title: string, url: string): string {
    const name = extractBuonduaAlbumName(title, url)
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    return `ID-buondua-${name}-${ts}`
  }
}
