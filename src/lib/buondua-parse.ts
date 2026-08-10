// buondua 页面 HTML 解析器（纯函数，可单测）
//
// buondua 数据模型（实测 2026-08-10）：
// - 当前相册图片：<div class="article-fulltext"> 内 <p><img src="https://i2.buondua.com/{year}/{ID}/xxx-{NNN}.{ext}?{签名}" width height>
// - 分页链接：<a class="pagination-link" href="/coser-...-{ID}?page=N">
// - 推荐链接（bottom-articles）：<div class="items-row column ..." data-id="...">
//     <a class="item-link popunder" href="/coser-..."> + 封面 img + <h2><a class="item-link">相册名</a></h2>
// - 其他链接（popular-item）：<div class="popular-item column ...">
//     <a class="popunder" href="/xxx"> + 封面 img + <div class="item-title"><a href="/xxx">标题</a></div>

import type { BuonduaImage, BuonduaLinkItem } from './types'

/** 提取标签属性值（支持单/双引号） */
function extractAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`)) ?? tag.match(new RegExp(`${name}='([^']*)'`))
  return m ? m[1] : null
}

/** 提取 `<div class="article-fulltext">` 正文块（到 bottom-articles 或 HTML 结束） */
function articleFulltextBlock(html: string): string {
  const startMatch = html.match(/<div class="article-fulltext">/)
  if (!startMatch) return ''
  const start = (startMatch.index ?? 0) + startMatch[0].length
  const endMatch = html.slice(start).search(/<div class="bottom-articles">/)
  return endMatch === -1 ? html.slice(start) : html.slice(start, start + endMatch)
}

/** 从 img 开标签解析 BuonduaImage（需要 src） */
function parseImgTag(tag: string, baseUrl: string): BuonduaImage | null {
  const src = extractAttr(tag, 'src')
  if (!src) return null
  let url = src
  if (url.startsWith('//')) url = `https:${url}`
  else if (url.startsWith('/')) url = new URL(url, baseUrl).href
  let filename = ''
  try {
    filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || '')
  } catch {
    filename = url.split('/').pop() || ''
  }
  filename = filename.replace(/[\\/:*?"<>|]/g, '_')
  const width = Number(extractAttr(tag, 'width')) || undefined
  const height = Number(extractAttr(tag, 'height')) || undefined
  return { url, filename, width, height }
}

// ---------- 当前相册图片 ----------

/** 解析 article-fulltext 内的全部图片（仅限 buondua 图床域，排除广告/推荐封面） */
export function parseBuonduaImages(html: string, baseUrl: string): BuonduaImage[] {
  const block = articleFulltextBlock(html)
  if (!block) return []
  const items: BuonduaImage[] = []
  const re = /<img[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(block)) !== null) {
    const img = parseImgTag(m[0], baseUrl)
    if (!img) continue
    // 仅保留 i2.buondua.com / i.buondua.com / cdn.buondua.com 图床图
    if (!/^https?:\/\/(i2|i|cdn)\.buondua\.com\//.test(img.url)) continue
    items.push(img)
  }
  return items
}

// ---------- 分页 ----------

/** 解析分页链接（?page=N），返回绝对 URL 列表（含基址自身） */
export function parsePaginationUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>()
  const re = /<a class="pagination-link[^"]*"[^>]*href="([^"]*)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      urls.add(new URL(m[1], baseUrl).href)
    } catch {
      // 忽略非法链接
    }
  }
  return [...urls].sort()
}

/** 从相册 URL 去除 ?page= 参数，得到基址 */
export function albumBaseUrl(url: string): string {
  try {
    const u = new URL(url)
    u.search = ''
    return u.href
  } catch {
    return url
  }
}

// ---------- 相册链接（推荐 / 其他） ----------

/** 解析 items-row 卡片（bottom-articles 推荐相册） */
export function parseRecommendedLinks(html: string, baseUrl: string): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  const re = /<div class="items-row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const block = m[1]
    const hrefMatch = block.match(/href="(\/[^"]*)"[^>]*>/)
    if (!hrefMatch) continue
    const url = new URL(hrefMatch[1], baseUrl).href
    const cover = block.match(/src="(https?:\/\/[^"]*\.buondua\.com\/[^"]*)"/)
    const titleMatch = block.match(/<a class="item-link"[^>]*>\s*([^<]+?)\s*<\/a>/)
    const title = titleMatch ? titleMatch[1].trim() : url
    const countMatch = title.match(/\((\d+)\s*photos?\)/i)
    items.push({
      url,
      title,
      coverUrl: cover ? cover[1] : '',
      imageCount: countMatch ? Number(countMatch[1]) : undefined,
    })
  }
  return dedupeLinks(items)
}

/** 解析 popular-item 卡片（其他相册） */
export function parsePopularLinks(html: string, baseUrl: string): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  // popular-item 块：开标签 → item-title 的 a → 两连 </div>（item-title + popular-item）
  const re = /<div class="popular-item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const block = m[1]
    const hrefMatch = block.match(/href="(\/[^"]*)"[^>]*>/)
    if (!hrefMatch) continue
    const url = new URL(hrefMatch[1], baseUrl).href
    const cover = block.match(/src="(https?:\/\/[^"]*)"/)
    const titleMatch = block.match(/<a href="\/[^"]*"[^>]*>([^<]+?)<\/a>/)
    const title = titleMatch ? titleMatch[1].trim() : url
    const countMatch = title.match(/\((\d+)\s*photos?\)/i)
    items.push({
      url,
      title,
      coverUrl: cover ? cover[1] : '',
      imageCount: countMatch ? Number(countMatch[1]) : undefined,
    })
  }
  return dedupeLinks(items)
}

/** 链接去重（按 URL，保留首个） */
function dedupeLinks(items: BuonduaLinkItem[]): BuonduaLinkItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.url)) return false
    seen.add(item.url)
    return true
  })
}

/** 全页扫描 buondua 帖子链接（参考项目 collectLinksFromPage 方案）：
 *  遍历所有 a[href]，按 URL 规则过滤——hostname=buondua.com、路径 /xxx-数字 结尾、
 *  排除 tag/search/category/author/分页/推荐区（excludeUrls） */
export function parseAllPostLinks(html: string, baseUrl: string, excludeUrls?: Set<string>): BuonduaLinkItem[] {
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()
  const re = /<a[^>]*href="([^"]*)"[^>]*>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1], baseUrl)
      if (u.hostname !== 'buondua.com') continue
      const path = u.pathname
      if (path === '/' || /^\/?(tag|search|category|author)\//i.test(path)) continue
      if (/page=\d+/.test(u.search)) continue // 分页链接
      if (!/\/[^\/]+-\d+$/.test(path)) continue // 帖子路径格式：/xxx-数字
      const url = u.origin + path
      if (seen.has(url)) continue
      seen.add(url)
      if (excludeUrls?.has(url)) continue // 排除推荐区已收录
      // 标题：优先该 a 的 title 属性（popular-item 封面 a 带 title），其次 a 内文本，
      // 最后从后 800 字符内找首个非空白文本（封面 a 后通常是标题 a）
      let title = (extractAttr(m[0], 'title') || '').trim()
      if (!title) {
        title = m[0].replace(/<[^>]*>/g, '').trim()
      }
      if (!title) {
        const block = html.slice(m.index, m.index + 800)
        const tr = />([^<>]*)</g
        let tm: RegExpExecArray | null
        while ((tm = tr.exec(block)) !== null) {
          const t = tm[1].trim()
          if (t.length >= 2 && !/^\d+$/.test(t)) {
            title = t
            break
          }
        }
      }
      const countMatch = title.match(/\((\d+)\s*photos?\)/i)
      items.push({
        url,
        title: title || url,
        coverUrl: '',
        imageCount: countMatch ? Number(countMatch[1]) : undefined,
      })
    } catch {
      // 忽略非法链接
    }
  }
  return dedupeLinks(items)
}

// ---------- 相册名 / 文件夹名 ----------

/** 从标题或 URL 提取文件夹名（直接使用页面名：保留 (N photos)，去掉分页标记，清洗非法字符） */
export function extractBuonduaAlbumName(title: string, url: string): string {
  let name = title.trim()
  name = name.replace(/\s*[-–—]\s*\(\s*Page \d+\s*\/\s*\d+\s*\)\s*$/i, '')
  if (!name) {
    try {
      const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || ''
      const m = slug.match(/^([a-z0-9-]+)-\d+$/)
      name = m ? m[1] : slug
    } catch {
      name = 'album'
    }
  }
  name = name.replace(/[\\/:*?"<>|\n\r]/g, '_').trim().slice(0, 120)
  return name || 'album'
}

/** 当前相册页判定：HTML 含 article-fulltext 且标题含 ( Page X / Y ) */
export function isBuonduaAlbumPage(html: string): boolean {
  return html.includes('article-fulltext') && /\( *Page \d+ *\/ *\d+ *\)/.test(html)
}
