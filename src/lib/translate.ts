// 标题中文化（FP-019）：Google 翻译免费端点 + 本地缓存 + 失败回退原文
//
// 设计要点：
// 1. 仅在抓取页（grabber）使用；请求发往 translate.googleapis.com，依赖已授权的 <all_urls>
// 2. 任何失败（未授权 / 超时 / 接口变动 / 限流）一律回退原文，绝不影响抓取主流程
// 3. 结果按原文缓存到 storage（translate_cache），同一标题不重复请求
// 4. 已是中文的标题直接跳过；开关见 storage translate_enabled（默认开）

import { initLogger } from './logger'
import { storageGet, storageSet } from './storage'

const logger = initLogger('grabber')

const KEY_ENABLED = 'translate_enabled'
const KEY_CACHE = 'translate_cache'
/** Google 翻译免费端点（非官方接口，无需 key；client=gtx 返回 JSON） */
const ENDPOINT = 'https://translate.googleapis.com/translate_a/single'
const TIMEOUT_MS = 8000
const CACHE_LIMIT = 500
const MAX_NAME_LEN = 120

export interface TranslateCache {
  [source: string]: string
}

const HAS_CJK = /[\u4e00-\u9fff]/

/** 开关（默认开） */
export async function isTranslateEnabled(): Promise<boolean> {
  return (await storageGet<boolean>(KEY_ENABLED)) ?? true
}

export async function setTranslateEnabled(enabled: boolean): Promise<void> {
  await storageSet(KEY_ENABLED, enabled)
}

/** 清洗译文：去包裹引号与多余空白，替换文件名非法字符，限长 */
function sanitize(text: string): string {
  return text
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
}

/** 调用翻译端点；返回 null 表示无有效译文 */
async function requestTranslate(text: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const url = `${ENDPOINT}?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`
    const resp = await fetch(url, { signal: controller.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data: unknown = await resp.json()
    // 响应形如 [[["译文","原文",null,null,10]],null,"ja",...]
    if (!Array.isArray(data) || !Array.isArray(data[0])) return null
    const parts = (data[0] as unknown[])
      .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('')
    return parts.trim() || null
  } finally {
    clearTimeout(timer)
  }
}

/** 写缓存（超上限丢弃较早的一半） */
async function saveCache(cache: TranslateCache, source: string, translated: string): Promise<void> {
  cache[source] = translated
  const keys = Object.keys(cache)
  if (keys.length <= CACHE_LIMIT) {
    await storageSet(KEY_CACHE, cache)
    return
  }
  const kept: TranslateCache = {}
  for (const key of keys.slice(-Math.floor(CACHE_LIMIT / 2))) {
    kept[key] = cache[key]
  }
  await storageSet(KEY_CACHE, kept)
}

/** 标题 → 中文；关闭开关、已是中文、翻译失败时均返回原文 */
export async function translateTitleToChinese(title: string): Promise<string> {
  const source = title.trim()
  if (!source) return title
  try {
    if (!(await isTranslateEnabled())) return title
    if (HAS_CJK.test(source)) return title // 已是中文，无需翻译
    const cache = (await storageGet<TranslateCache>(KEY_CACHE)) ?? {}
    const hit = cache[source]
    if (hit) return hit
    const raw = await requestTranslate(source)
    if (!raw) return title
    const translated = sanitize(raw)
    if (!translated) return title
    await saveCache(cache, source, translated)
    logger.info('translate', '相册标题已翻译', { source: source.slice(0, 40), translated })
    return translated
  } catch (err) {
    logger.warn('translate', '翻译失败，回退原文', { source: source.slice(0, 40), error: String(err) })
    return title
  }
}
