// Bing SERP（搜索引擎结果页）解析（FP-013）
// M1 主通道：Bing 网页/图片搜索（反爬比 Google 宽松，成人题材必须 adlt=off）
// 纯函数：URL 构造 + HTML 解析，可单测（红线 3：src/lib 纯逻辑允许自动测试）

export interface BingWebResult {
  url: string
  title: string
  snippet: string
}

export interface BingImageResult {
  /** 原图 URL（murl） */
  murl: string
  /** 缩略图 URL（turl，可当封面） */
  turl: string
  /** 来源页 URL（purl） */
  purl: string
  title: string
}

/** 构造 Bing 网页搜索 URL（adlt=off 关闭 SafeSearch，成人题材必需） */
export function buildBingWebUrl(q: string, first = 1): string {
  return `https://www.bing.com/search?q=${encodeURIComponent(q)}&adlt=off&count=30&first=${first}`
}

/** 构造 Bing 图片搜索 URL（adlt=off；first 为图片偏移，每页约 35 张） */
export function buildBingImageUrl(q: string, first = 1): string {
  return `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&adlt=off&first=${first}`
}

// ---------- Yandex 图片通道（FP-013 v2：对成人内容宽容，无 SafeSearch 过滤） ----------

export interface YandexImageResult {
  /** 详情页 URL（yandex /images 查看页） */
  url: string
  /** 代理缩略图 URL */
  thumb: string
  title: string
}

/** 构造 Yandex 图片搜索 URL（itype=photo 仅照片 / isize=large 大图 / nomisspell 禁纠错） */
export function buildYandexImageUrl(q: string): string {
  return `https://yandex.com/images/search?text=${encodeURIComponent(q)}&itype=photo&isize=large&nomisspell=1`
}

/**
 * 解析 Yandex 图片搜索结果（v2）：
 * 每项 = <div class="serp-item" data-bem="{"img":{"url":"缩略图",...}}"> 内
 *       <a class="serp-item__link" href="/images/search?...&img_url=原图&...">
 * 兼容：data-bem 单/双引号包裹（HTML 实体 &quot; 不构成裸引号）；
 *      协议相对 URL（//avatars...）补全 https:；
 *      链接缺失时用缩略图 URL 兜底定位。
 * 注意：Yandex 对无 cookie 请求可能返回 Smart Captcha（诊断 captcha 特征）
 */
export function parseYandexImageSerp(html: string): YandexImageResult[] {
  const out: YandexImageResult[] = []
  // data-bem：单双引号均可（值内实体引号不干扰非贪婪匹配）
  const bemRe = /data-bem=(["'])(.*?)\1/gi
  const linkRe = /<a[^>]*class="[^"]*serp-item__link[^"]*"[^>]*href="([^"]+)"/gi
  const bems: string[] = []
  const links: string[] = []
  let m: RegExpExecArray | null
  while ((m = bemRe.exec(html)) !== null) bems.push(m[2])
  while ((m = linkRe.exec(html)) !== null) links.push(m[1])
  const n = Math.max(bems.length, links.length)
  for (let i = 0; i < n; i++) {
    let thumb = ''
    let detailUrl = ''
    let origUrl = ''
    try {
      if (i < bems.length) {
        const obj = JSON.parse(bems[i].replace(/&quot;/g, '"')) as { img?: { url?: string } }
        thumb = fullUrl(obj.img?.url ?? '')
      }
      if (i < links.length) {
        detailUrl = new URL(decodeHtml(links[i]), 'https://yandex.com').href
        origUrl = new URL(detailUrl).searchParams.get('img_url') ?? ''
      }
    } catch {
      /* 单项损坏跳过 */
    }
    if (!detailUrl && !thumb) continue
    out.push({
      url: detailUrl || origUrl,
      thumb,
      title: origUrl ? (new URL(origUrl).pathname.split('/').pop() ?? '') : '',
    })
  }
  // 兜底 1：data-bem/link 结构均未命中时，直接扫描 avatars 缩略图（至少出图，url 用图片直链可点开）
  if (out.length === 0) {
    const thumbRe = /"img":"(?:https?:)?\/\/([^"]+?)"/gi
    const seen = new Set<string>()
    while ((m = thumbRe.exec(html)) !== null) {
      const u = `https://${m[1]}`
      if (seen.has(u)) continue
      seen.add(u)
      out.push({ url: u, thumb: u, title: '' })
      if (out.length >= 40) break
    }
  }
  // 兜底 2：官方缩略图 class（serp-item__thumb）扫描（结构再变也能出图）
  if (out.length === 0) {
    const imgRe = /<img[^>]*class="[^"]*serp-item__thumb[^"]*"[^>]*src="([^"]+)"/gi
    const seen = new Set<string>()
    while ((m = imgRe.exec(html)) !== null) {
      const u = fullUrl(decodeHtml(m[1]))
      if (!u || seen.has(u)) continue
      seen.add(u)
      out.push({ url: u, thumb: u, title: '' })
      if (out.length >= 40) break
    }
  }
  return out
}

/** 协议相对 URL（//xxx）补全为 https: */
function fullUrl(u: string): string {
  if (!u) return ''
  return u.startsWith('//') ? `https:${u}` : u
}

function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2F;/g, '/')
}

/** 解码 Bing 跳转链接（/ck/a?u=a1... 或 /redirect?url=），非跳转直链原样返回 */
export function decodeBingUrl(href: string): string | null {
  try {
    const u = new URL(href, 'https://www.bing.com')
    if (u.hostname.endsWith('bing.com') || u.hostname.endsWith('microsoft.com')) {
      const cand = u.searchParams.get('u') || u.searchParams.get('url')
      if (cand) {
        // Bing 的 u 参数为 base64（a1 前缀）+ 可再带 query；标准形式可直接解
        try {
          const decoded = atob(cand)
          const httpIdx = decoded.indexOf('http')
          if (httpIdx >= 0) return decoded.slice(httpIdx)
        } catch {
          /* 非 base64，忽略 */
        }
        return null
      }
    }
    return href.startsWith('http') ? href : null
  } catch {
    return null
  }
}

/**
 * 解析 Bing 网页搜索结果（<li class="b_algo"> 容器）
 * 仅返回 http(s) 直链结果，剔除 Bing 内部页与广告跳转
 */
export function parseBingWebSerp(html: string): BingWebResult[] {
  const out: BingWebResult[] = []
  const algoRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = algoRe.exec(html)) !== null) {
    const block = m[1]
    const aRe = /<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i
    const a = aRe.exec(block)
    if (!a) continue
    const url = decodeBingUrl(a[1].replace(/&amp;/g, '&'))
    if (!url) continue
    const title = stripHtml(a[2]).trim()
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/i
    const p = pRe.exec(block)
    const snippet = p ? stripHtml(p[1]).trim() : ''
    out.push({ url, title: title || url, snippet })
  }
  return out
}

/**
 * 解析 Bing 图片搜索结果（<a class="iusc" m="{json}">）
 * m 字段：murl=原图 / turl=缩略图 / purl=来源页 / t=标题
 */
export function parseBingImageSerp(html: string): BingImageResult[] {
  const out: BingImageResult[] = []
  const iuscRe = /<a[^>]*class="[^"]*iusc[^"]*"[^>]*m="([^"]+)"[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = iuscRe.exec(html)) !== null) {
    const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    try {
      const obj = JSON.parse(raw) as {
        murl?: string
        turl?: string
        purl?: string
        t?: string
      }
      if (!obj.murl || !obj.purl) continue
      out.push({
        murl: obj.murl,
        turl: obj.turl || '',
        purl: obj.purl,
        title: obj.t || '',
      })
    } catch {
      /* 单条损坏跳过 */
    }
  }
  return out
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
}
