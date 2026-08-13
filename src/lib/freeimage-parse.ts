// freeimage.host HTML 解析器（FP-007，纯函数，可单测）
//
// freeimage 数据模型（实测）：
// - 图片项：<div class="list-item ..." data-type="image" data-object="{URL编码JSON}">
//     data-object JSON: { id_encoded, image:{url=原图}, medium:{url=展示图}, thumb:{url=缩略图},
//                         name/title=原始上传文件名, width, height, url_viewer }
// - 相册项：<div class="list-item ..." data-type="album" data-id="zLEWQ" data-name="芭比" data-description="...">
//     + a.image-container href=/a/{slug}.{ID} + 封面 img（iili.io/*.md.png）
// - 图片页属主：<a class="user-link" href="/username">Name</a>（匿名显示 Guest）
// - 页面标题：<title>相册名 — Freeimage.host</title>

import type { FhAlbum, FhImage, FhOwner } from './freeimage-types'

/** 提取标签属性值（支持单/双引号） */
function extractAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`)) ?? tag.match(new RegExp(`${name}='([^']*)'`))
  return m ? m[1] : null
}

/** 解析 data-object（URL 编码 JSON），失败返回 null */
function parseDataObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    return JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}

function objUrl(obj: unknown): string {
  if (obj && typeof obj === 'object' && 'url' in obj) {
    return String((obj as { url: string }).url)
  }
  return ''
}

/** 遍历 list-item 开标签（指定 data-type） */
function listItemTags(html: string, type: string): { tag: string; end: number }[] {
  const re = new RegExp(`<div class="list-item[^"]*"[^>]*data-type="${type}"[^>]*>`, 'g')
  const result: { tag: string; end: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    result.push({ tag: m[0], end: re.lastIndex })
  }
  return result
}

/** 提取某标签之后的块内容（到下一个 list-item 或 HTML 结束） */
function blockAfter(html: string, start: number): string {
  const next = html.slice(start).search(/<div class="list-item(?:\s|")/)
  return next === -1 ? html.slice(start, start + 6000) : html.slice(start, start + next)
}

// ---------- 图片项 ----------

export function parseImageItems(html: string): FhImage[] {
  const items: FhImage[] = []
  for (const { tag } of listItemTags(html, 'image')) {
    const obj = parseDataObject(extractAttr(tag, 'data-object'))
    if (!obj) continue
    const imgObj = (obj.image ?? obj) as Record<string, unknown> | undefined
    if (!imgObj) continue
    const originalUrl = objUrl(imgObj)
    if (!originalUrl) continue
    items.push({
      id: String(obj.id_encoded ?? extractAttr(tag, 'data-id') ?? ''),
      filename: String(imgObj.filename ?? ''),
      // 原始上传文件名（关键词筛选数据源）：obj.name/title → 兜底 hash 文件名
      name: String(obj.name ?? obj.title ?? imgObj.name ?? imgObj.filename ?? ''),
      originalUrl,
      mediumUrl: objUrl(obj.medium) || originalUrl,
      thumbUrl: objUrl(obj.thumb) || objUrl(obj.medium) || originalUrl,
      width: obj.width ? Number(obj.width) : undefined,
      height: obj.height ? Number(obj.height) : undefined,
      viewerUrl: String(obj.url_viewer ?? ''),
    })
  }
  return items
}

// ---------- 相册项 ----------

export function parseAlbumItems(html: string): FhAlbum[] {
  const items: FhAlbum[] = []
  for (const { tag, end } of listItemTags(html, 'album')) {
    const id = extractAttr(tag, 'data-id')
    if (!id) continue
    const name = extractAttr(tag, 'data-name') ?? id
    const block = blockAfter(html, end)
    const linkMatch = block.match(/href="(https?:\/\/freeimage\.host\/a\/[^"]*)"/)
    const coverMatch = block.match(/src="(https?:\/\/iili\.io\/[^"]*\.(?:md\.)?(?:jpg|png|webp|gif|jpeg))"/)
    const thumbMatch = block.match(/background-image: url\((https?:\/\/iili\.io\/[^)]*\.th\.(?:jpg|png|webp|gif|jpeg))\)/)
    items.push({
      id,
      name,
      url: linkMatch ? linkMatch[1] : `https://freeimage.host/a/${id}`,
      coverUrl: coverMatch ? coverMatch[1] : '',
      thumbUrl: thumbMatch ? thumbMatch[1] : (coverMatch ? coverMatch[1] : ''),
      description: extractAttr(tag, 'data-description') ?? undefined,
    })
  }
  return items
}

// ---------- 图片页属主 ----------

/** 图片页属主提取（/i/{id}），匿名返回 null */
export function extractOwner(html: string): FhOwner | null {
  // 属主名：user-link 链接文本（匿名时为 Guest，无 href）
  const linkRe = /<a[^>]*class="user-link"[^>]*href="(https?:\/\/freeimage\.host\/([a-zA-Z0-9_-]{2,32}))"[^>]*>([^<]*)</i
  const m = html.match(linkRe)
  if (!m) return null
  const url = m[1]
  const username = m[2]
  if (!username || /guest/i.test(username)) return null
  // 头像：user-image img
  const avatarMatch = html.match(/<img[^>]*class="user-image"[^>]*src="(https?:\/\/freeimage\.host\/content\/images\/users\/[^"]*)"/)
  return { username, url, avatarUrl: avatarMatch ? avatarMatch[1] : '' }
}

/** 匿名判断（属主为 Guest 或缺失） */
export function isGuestOwner(html: string): boolean {
  return extractOwner(html) === null
}

// ---------- 探索页相册项（FP-007 v6） ----------

/** 探索页相册项：list-item-desc-title-link 文本 = 相册名，无 data-name（实测） */
export function parseExploreAlbums(html: string): FhAlbum[] {
  const items: FhAlbum[] = []
  for (const { end } of listItemTags(html, 'album')) {
    const block = blockAfter(html, end)
    const linkMatch = block.match(/href="(https?:\/\/freeimage\.host\/a\/[^"]*)"/)
    const nameMatch = block.match(/list-item-desc-title-link"[^>]*>([^<]*)</)
    const coverMatch = block.match(/src="(https?:\/\/iili\.io\/[^"]*\.(?:md\.)?(?:jpg|png|webp|gif|jpeg))"/)
    const countMatch = block.match(/(\d+)\s*(?:images|张图片|张)/i)
    if (!linkMatch) continue
    const id = linkMatch[1].match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? linkMatch[1].match(/([a-zA-Z0-9]+)$/)?.[1] ?? ''
    const name = (nameMatch ? nameMatch[1].trim() : '') || id
    items.push({
      id,
      name,
      url: linkMatch[1],
      coverUrl: coverMatch ? coverMatch[1] : '',
      thumbUrl: '',
      description: countMatch ? `${countMatch[1]} 张` : undefined,
    })
  }
  return items
}

// ---------- 探索页用户项（FP-007 v6） ----------

/** 探索页用户项：list-item-desc-title-link 文本 = 用户名 */
export function parseExploreUsers(html: string): FhOwner[] {
  const items: FhOwner[] = []
  for (const { end } of listItemTags(html, 'user')) {
    const block = blockAfter(html, end)
    const linkMatch = block.match(/href="(https?:\/\/freeimage\.host\/([a-zA-Z0-9_-]{2,32}))"/)
    const avatarMatch = block.match(/src="(https?:\/\/freeimage\.host\/content\/images\/users\/[^"]*)"/)
    if (!linkMatch || !linkMatch[2]) continue
    const username = linkMatch[2]
    if (/explore|login|upload|api|signup|donate|help|about|tos|privacy|plugin|sharex|contact|report/i.test(username)) continue
    items.push({
      username,
      url: linkMatch[1],
      avatarUrl: avatarMatch ? avatarMatch[1] : '',
    })
  }
  return items
}

// ---------- 相册页标题（文件夹命名） ----------

/** 相册页标题解析（文件夹命名）：<title>芭比 — Freeimage.host</title> → 芭比
 * 注意：相册页 h1 是描述（如完整文件名），不是相册名，不可用（实测）
 * 优先级：og:title → title（去站点后缀） */
export function extractAlbumName(html: string): string | null {
  const og = html.match(/<meta property="og:title" content="([^"]*)"/)
  if (og && og[1].trim()) return og[1].trim()
  const title = html.match(/<title>([^<]+)<\/title>/)
  if (!title) return null
  return (
    title[1]
      .replace(/\s*[-—–]\s*Freeimage\.host\s*$/i, '')
      .replace(/\s*[-—–]\s*Page\s*\d+\s*$/i, '')
      .trim() || null
  )
}

// ---------- 探索页分页（seek 游标） ----------

/** 解析探索页下一页链接（page=N&seek=游标）；imgbb 同款思路：选 page 最大的链接 */
export function parseExploreNextPage(html: string, baseUrl: string): string | null {
  const re = /href="([^"]*\?[^"]*page=\d+[^"']*seek=[^"]*)"/g
  let best: string | null = null
  let bestPage = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1]
    const pageMatch = href.match(/page=(\d+)/)
    const page = pageMatch ? Number(pageMatch[1]) : 0
    if (page > bestPage) {
      bestPage = page
      best = href
    }
  }
  if (!best) return null
  try {
    return new URL(best, baseUrl).href
  } catch {
    return null
  }
}

// ---------- 关键词过滤（场景 D：相册名检索） ----------

/** 相册名/图片名关键词过滤（本地零请求，大小写不敏感；支持多关键词，全部命中 AND） */
export function matchAlbumKeywords(
  albums: { name: string; url: string; username?: string }[],
  keywords: string[],
): { name: string; url: string; username?: string }[] {
  const ks = keywords.map((k) => k.toLowerCase()).filter(Boolean)
  if (ks.length === 0) return albums
  return albums.filter((a) => {
    const haystack = `${a.name} ${a.username ?? ''}`.toLowerCase()
    return ks.every((k) => haystack.includes(k))
  })
}
