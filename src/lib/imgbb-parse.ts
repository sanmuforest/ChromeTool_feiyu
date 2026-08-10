// imgbb 页面 HTML 解析器（纯函数，可单测）
//
// imgbb 数据模型（实测）：
// - 图片项：<div class="list-item ..." data-type="image" data-id="..." data-object="{URL编码JSON}">
//     data-object JSON: { id_encoded, image:{url=原图}, medium:{url=展示图}, thumb:{url=缩略图},
//                         width, height, filename, name, url_viewer, user:{username} }
// - 相册项：<div class="list-item ..." data-type="album" data-id="GFHG7S" data-name="雪莉"> + 封面 img + a.image-container
// - 用户项：<div class="list-item ..." data-type="user"> + a[href={user}.imgbb.com] + 头像 img

import type { ImgbbAlbum, ImgbbImage, ImgbbUser } from './types'

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

/** 遍历 list-item 开标签（指定 data-type），返回 [开标签, 标签结束位置] */
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

export function parseImageItems(html: string): ImgbbImage[] {
  const items: ImgbbImage[] = []
  for (const { tag } of listItemTags(html, 'image')) {
    const obj = parseDataObject(extractAttr(tag, 'data-object'))
    if (!obj) continue
    const imgObj = (obj.image ?? obj) as Record<string, unknown> | undefined
    if (!imgObj) continue
    const originalUrl = objUrl(imgObj)
    const mediumUrl = objUrl(obj.medium)
    const thumbUrl = objUrl(obj.thumb)
    if (!originalUrl) continue
    const user = obj.user as { username?: string } | undefined
    items.push({
      id: String(obj.id_encoded ?? extractAttr(tag, 'data-id') ?? ''),
      filename: String(imgObj.filename ?? extractAttr(tag, 'data-title') ?? ''),
      name: String(imgObj.name ?? extractAttr(tag, 'data-title') ?? ''),
      originalUrl,
      mediumUrl: mediumUrl || originalUrl,
      thumbUrl: thumbUrl || mediumUrl || originalUrl,
      width: obj.width ? Number(obj.width) : undefined,
      height: obj.height ? Number(obj.height) : undefined,
      viewerUrl: String(obj.url_viewer ?? ''),
      username: String(user?.username ?? ''),
    })
  }
  return items
}

// ---------- 相册项 ----------

export function parseAlbumItems(html: string): ImgbbAlbum[] {
  const items: ImgbbAlbum[] = []
  for (const { tag, end } of listItemTags(html, 'album')) {
    const id = extractAttr(tag, 'data-id')
    if (!id) continue
    const name = extractAttr(tag, 'data-name') ?? id
    const block = blockAfter(html, end)
    const coverMatch = block.match(/src="(https?:\/\/i\.ibb\.co\/[^"]*)"/)
    const countMatch = block.match(/data-count="(\d+)"/) ?? block.match(/(\d+)\s*(?:张|张图片|images?)/i)
    items.push({
      id,
      name,
      coverUrl: coverMatch ? coverMatch[1] : '',
      url: `https://ibb.co/album/${id}`,
      imageCount: countMatch ? Number(countMatch[1]) : undefined,
    })
  }
  return items
}

// ---------- 用户项（关注墙） ----------

export function parseUserItems(html: string): ImgbbUser[] {
  const items: ImgbbUser[] = []
  for (const { end } of listItemTags(html, 'user')) {
    const block = blockAfter(html, end)
    const linkMatch = block.match(/href="(https?:\/\/[^"]+?\.imgbb\.com\/)"/)
    const avatarMatch = block.match(/src="(\/\/simgbb\.com\/avatar\/[^"]*)"|src="(https?:\/\/simgbb\.com\/avatar\/[^"]*)"/)
    if (!linkMatch) continue
    const url = linkMatch[1]
    const usernameMatch = url.match(/https?:\/\/([^.\/]+)\.imgbb\.com/)
    if (!usernameMatch) continue
    const avatar = avatarMatch ? (avatarMatch[1] || avatarMatch[2]) : ''
    items.push({
      username: usernameMatch[1],
      url,
      avatarUrl: avatar.startsWith('//') ? `https:${avatar}` : avatar,
    })
  }
  return items
}

// ---------- 页面判定 ----------

/** 登录墙检测：<title>Sign in — ImgBB</title> 或登录表单 */
export function isLoginWall(html: string): boolean {
  return html.includes('<title>Sign in') || html.includes('Sign in — ImgBB')
}

/** 从 URL 提取 imgbb 用户名（https://xxx.imgbb.com/） */
export function extractUsername(url: string): string | null {
  const m = url.match(/https?:\/\/([^.\/]+)\.imgbb\.com/)
  return m ? m[1] : null
}

/** 从相册 URL 提取相册 ID（ibb.co/album/{ID}） */
export function extractAlbumId(url: string): string | null {
  const m = url.match(/ibb\.co\/album\/([a-zA-Z0-9]+)/)
  return m ? m[1] : null
}

/** 文件名编号匹配：prefix + 数字，返回数字或 null */
export function matchFilenameNumber(filename: string, prefix: string): number | null {
  if (!prefix) return null
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = filename.match(new RegExp(`^${escaped}(\\d+)`))
  return m ? Number(m[1]) : null
}

/** 从任意 imgbb 页面 HTML 提取属主用户名（相册页/图片页无用户名子域时用）
 * 优先级：parent_url（data-object 属主 URL）> 面包屑用户链接 > data-object username */
export function parseUsernameFromHtml(html: string): string | null {
  // 1. 相册属主：data-object 内 parent_url（最可靠，不受登录态推荐区块干扰）
  const m1 =
    html.match(/"parent_url"%3A%22https%3A%5C%2F%5C%2F([^%]+?)%5C%2F%5C%2F[^"]*\.imgbb\.com%5C%2F/) ??
    html.match(/"parent_url":"https:\\\/\\\/([a-zA-Z0-9][\w-]*)\.imgbb\.com\\\//)
  if (m1) return m1[1]
  // 2. 面包屑区域用户链接
  const m2 = html.match(/breadcrum[^>]*>[\s\S]{0,300}?href="https?:\/\/([a-zA-Z0-9][\w-]*)\.imgbb\.com\//)
  if (m2) return m2[1]
  // 3. data-object user.username（兜底）
  const m3 = html.match(/"username"%3A%22([^%"]+)%22/) ?? html.match(/"username":"([^"]+)"/)
  if (m3) return m3[1]
  return null
}

/** 从任意 imgbb 页面 HTML 提取页面标题（文件夹命名用）
 * 优先级：h1 > <title>，去掉 " — ImgBB — Page N"/" — ImgBB" 等站点后缀 */
export function parseAlbumPageTitle(html: string): string | null {
  const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/)
  if (h1 && h1[1].trim()) return h1[1].trim()
  const title = html.match(/<title>([^<]+)<\/title>/)
  if (!title) return null
  return (
    title[1]
      .replace(/\s*[-—–]\s*ImgBB\s*[-—–]\s*Page\s*\d+\s*$/i, '')
      .replace(/\s*[-—–]\s*ImgBB\s*$/i, '')
      .trim() || null
  )
}

/** 从 imgbb 相册页 HTML 提取下一个分页链接（仅 seek 游标，跳过 peek/排序等）
 * imgbb 为无尽滚动：裸 ?page=N 不可靠，必须跟随 ?page=N&seek=游标；每页返回累计内容 */
export function parseAlbumNextPage(html: string, baseUrl: string): string | null {
  const re = /href="([^"]*\?[^"]*page=\d+[^"]*seek=[^"]*)"/g
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
