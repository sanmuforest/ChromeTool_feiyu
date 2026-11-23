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
/** 翻译端点（2026-11-23 更新）
 *
 *  原实现只用 `translate.googleapis.com/translate_a/single?client=gtx`，
 *  实测该端点已长期返回 **HTTP 429 Too Many Requests**（直连与代理均如此，间隔 5 秒连试 3 次全 429），
 *  而 `translate_a/t?client=gtx` 同样 429。
 *  由于本模块设计为「任何失败一律回退原文」，用户侧表现为「相册名中文化功能像是没生效」——
 *  实际是端点被限流后静默降级。
 *
 *  改用 Chrome 词典扩展同款入口 `clients5.google.com/translate_a/t?client=dict-chrome-ex`（实测 200 可译），
 *  并保留原端点作为备选：按序尝试，任一成功即用，避免单点被限流导致整体失效。 */
const ENDPOINTS = [
  'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=zh-CN&q=',
  'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=',
]
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

/** 解析两种端点的响应结构，取出译文
 *
 *  格式 A（`clients5…dict-chrome-ex`）：`[["译文","en"]]`
 *    → `data[0]` 是 `[译文, 源语言]`，`data[0][0]` 为 string
 *  格式 B（`translate_a/single?client=gtx`）：`[[["译文","原文",null,null,10]],null,"en",…]`
 *    → `data[0]` 是片段数组，每段 `[0]` 为译文片段，需要拼接
 *  两者靠 `data[0][0]` 是 string 还是 array 区分。 */
function parseTranslatePayload(data: unknown): string | null {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null
  const head = data[0] as unknown[]
  if (head.length === 0) return null
  // 格式 A
  if (typeof head[0] === 'string') return (head[0] as string).trim() || null
  // 格式 B
  const joined = head
    .map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : ''))
    .join('')
  return joined.trim() || null
}

/** 依次尝试各端点；返回 null 表示所有端点都无有效译文 */
async function requestTranslate(text: string): Promise<string | null> {
  const q = encodeURIComponent(text)
  let lastErr = ''
  for (const base of ENDPOINTS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const resp = await fetch(`${base}${q}`, { signal: controller.signal })
      if (!resp.ok) {
        lastErr = `HTTP ${resp.status}`
        continue // 换下一个端点（典型场景：429 限流）
      }
      const parsed = parseTranslatePayload(await resp.json())
      if (parsed) return parsed
      lastErr = '空译文'
    } catch (err) {
      lastErr = err instanceof DOMException && err.name === 'AbortError' ? '超时' : String(err)
    } finally {
      clearTimeout(timer)
    }
  }
  if (lastErr) logger.debug('translate', '所有翻译端点均失败', { error: lastErr, source: text.slice(0, 40) })
  return null
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
    if (!raw) {
      // 2026-11-23：此前所有端点失败时只打 debug 日志，用户侧表现为「翻译功能像是没生效」却查不到原因。
      // 改为 warn，让翻译降级可被日志面板看到。
      logger.warn('translate', '翻译无结果（端点限流/不可用），本次回退原文', { source: source.slice(0, 40) })
      return title
    }
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
