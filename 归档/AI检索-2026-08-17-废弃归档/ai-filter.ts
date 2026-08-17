// L0 规则过滤引擎（FP-013）：URL/标题/域名层过滤与粗打分
// 金字塔第一层：零成本挡掉大部分噪音，视觉验证（M3）只处理幸存者
// 纯函数，可单测

import type { AiAlbumItem } from './ai-types'
import { isCompliantDomain, isCompliantText, isSpamDomain } from './ai-strategy'

/** 相册页 URL 启发式：排除明显非相册页（图片直链/社交/搜索/首页等） */
const NON_ALBUM_PATH = [
  /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?|$)/i,
  /\/wp-content\//i,
  /\/wp-includes\//i,
  /\/wp-json\//i,
  /\/feed\/?$/i,
  /\/login/i,
  /\/register/i,
  /\/cart/i,
  /\/checkout/i,
  /\/cdn-cgi\//i,
]

/** 相册页正特征（命中加分）：常见相册路径/标题特征 */
const ALBUM_POSITIVE = [
  /\/album\//i,
  /\/gallery\//i,
  /\/galleries\//i,
  /\/photos?\//i,
  /\/post\//i,
  /\/p\/\d/i,
  /-\d{3,}photos?/i, // NNNphotos 标题特征（写真站生态）
  /\(\d{2,}\s*(?:photos?|pics|images?)\)/i,
  /\[?\d{3,}\]?/i,
]

/** 规范化 URL：去 tracking 参数与 hash，用于去重 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    const TRACKING_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'fbclid', 'ref']
    u.searchParams.forEach((_v, key) => {
      if (TRACKING_KEYS.includes(key)) u.searchParams.delete(key)
    })
    return u.href.replace(/\/+$/, '')
  } catch {
    return url.replace(/\/+$/, '')
  }
}

/** 单个 URL 是否值得保留（黑名单/格式/合规） */
export function isAlbumCandidate(url: string, title = ''): boolean {
  try {
    const u = new URL(url)
    if (!['http:', 'https:'].includes(u.protocol)) return false
    if (isSpamDomain(u.hostname) || !isCompliantDomain(u.hostname)) return false
    if (NON_ALBUM_PATH.some((re) => re.test(u.pathname))) return false
    if (title && !isCompliantText(title)) return false
    return true
  } catch {
    return false
  }
}

/** 候选粗打分（0~100）：命中相册正特征越多分越高；域名为已知种子域名加分 */
export function scoreAlbumCandidate(url: string, title = '', hitDomain = ''): number {
  let score = 40 // 基础分
  try {
    const u = new URL(url)
    for (const re of ALBUM_POSITIVE) {
      if (re.test(u.pathname) || (title && re.test(title))) score += 10
    }
    if (title && title.length > 8) score += 5 // 有描述性标题
    if (hitDomain && hostMatches(u.hostname, hitDomain)) score += 10
    if (u.pathname.split('/').filter(Boolean).length >= 2) score += 5
  } catch {
    /* 保持基础分 */
  }
  return Math.min(100, score)
}

/** host 是否匹配限定域名（含子域/主域双向匹配，如 www.jrants.com ↔ jrants.com） */
export function hostMatches(host: string, hitDomain: string): boolean {
  const h = host.toLowerCase()
  const d = hitDomain.toLowerCase()
  return h === d || h.endsWith('.' + d) || d.endsWith('.' + h)
}

/** 批量过滤 + 去重：返回通过项（已打分、已规范化 URL）
 *  过滤语义（修复记录 12 分层）：
 *  - 带限定域名（hitDomain，site: 查询）：host 强校验，结果必须落在限定域
 *  - 广域查询（无 hitDomain，纯词）：不做 host 白名单，但陌生结果必须通过
 *    「写真相册特征」判定（score ≥ 60：至少命中 2 个相册正特征），过滤无关站点 */
export function filterAndScore(
  candidates: { url: string; title?: string; coverUrl?: string; source: string; hitDomain?: string }[],
): AiAlbumItem[] {
  const seen = new Set<string>()
  const out: AiAlbumItem[] = []
  for (const c of candidates) {
    const title = c.title || ''
    if (!isAlbumCandidate(c.url, title)) continue
    const norm = normalizeUrl(c.url)
    if (seen.has(norm)) continue
    seen.add(norm)
    let domain = ''
    try {
      domain = new URL(norm).hostname
    } catch {
      continue
    }
    // 限定域名强校验：不匹配直接丢弃
    if (c.hitDomain && !hostMatches(domain, c.hitDomain)) continue
    const score = scoreAlbumCandidate(norm, title, c.hitDomain || '')
    // 广域（无 hitDomain）：必须像写真相册页（相册特征 ≥60），否则丢弃
    if (!c.hitDomain && score < 60) continue
    out.push({
      url: norm,
      title: title || norm,
      coverUrl: c.coverUrl,
      domain,
      hitDomain: c.hitDomain,
      source: c.source,
      score,
    })
  }
  return out
}
