// 内容脚本：网页图片解析器（由 background 动态注入，isolated world）
//
// 双模式：
// - 通用模式：扫描 img[src]/srcset/懒加载属性/picture>source，并发取尺寸，分批上报
// - imgbb 适配器模式（FP-003）：页面为 imgbb 时，解析 .list-item data-object JSON
//   （原图 URL 直读 + 尺寸免加载 + <100px UI 小图过滤），配合滚动加载分批抓取
//
// 公共机制：
// - 收到 GRAB_PARSE_START 开始全新解析；GRAB_PARSE_CANCEL 停止并保留已收集
// - 收到 GRAB_LOAD_MORE：滚动页面触发动态加载 → 增量解析新图（单批上限 MAX_PER_PARSE）
// - 重复注入防护：isolated world 持久，用全局标记避免重复注册

import type { GrabbedImage } from '../lib/types'

const BATCH_SIZE = 20
const REPORT_INTERVAL_MS = 300
const CONCURRENCY = 4 // 解析并发（尺寸多已 DOM 直读，加载测尺寸仅兜底）
const SIZE_TIMEOUT_MS = 5000 // 兜底测尺寸超时（原 15s → 5s，避免拖慢）
const MAX_PER_PARSE = 200
const SCROLL_STEPS = 3
const SCROLL_DELAY_MS = 800
const MIN_IMAGE_SIZE = 100 // 过滤 <100px UI 小图

interface Candidate {
  url: string
  /** 展示用缩略图（页面实际渲染的小图 / imgbb thumb） */
  thumbUrl?: string
  width?: number
  height?: number
}

declare global {
  interface Window {
    __grabberContentInjected?: boolean
  }
}

// 重复注入防护
if (!window.__grabberContentInjected) {
  window.__grabberContentInjected = true
  initScanner()
}

function initScanner(): void {
  let scanning = false
  let cancelled = false
  let seenUrls = new Set<string>()

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GRAB_PARSE_START') {
      if (!scanning) {
        seenUrls.clear() // 全新解析
        void parse()
      }
      sendResponse({ ok: true })
    } else if (msg?.type === 'GRAB_PARSE_CANCEL') {
      if (scanning) {
        cancelled = true
      }
      sendResponse({ ok: true })
    } else if (msg?.type === 'GRAB_LOAD_MORE') {
      if (!scanning) {
        void loadMore()
      }
      sendResponse({ ok: true })
    } else if (msg?.type === 'BD_FETCH_HTML') {
      // 页面内 fetch（带 Cookie/Referer，穿透反爬；background fetch 超时时降级用）
      void (async () => {
        try {
          const resp = await fetch(msg.url, { credentials: 'include', headers: { Referer: location.href } })
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          sendResponse({ ok: true, data: await resp.text() })
        } catch (err) {
          sendResponse({ ok: false, error: String(err) })
        }
      })()
      return true // 异步响应
    }
  })

  /** 加载下一批：滚动页面触发动态加载，再增量解析 */
  async function loadMore(): Promise<void> {
    scanning = true
    cancelled = false
    for (let i = 0; i < SCROLL_STEPS; i++) {
      window.scrollTo(0, document.body.scrollHeight)
      await new Promise((resolve) => setTimeout(resolve, SCROLL_DELAY_MS))
    }
    await parse()
  }

  /** 解析：仅处理未上报过的新候选，单批上限 MAX_PER_PARSE */
  async function parse(): Promise<void> {
    if (!scanning) scanning = true
    cancelled = false

    const imgbb = isImgbbPage()
    const rawCandidates = imgbb ? collectImgbbCandidates() : collectCandidates()
    const candidates = rawCandidates.filter((c) => !seenUrls.has(c.url)).slice(0, MAX_PER_PARSE)
    const total = candidates.length
    let scanned = 0
    let batch: GrabbedImage[] = []
    let lastReport = 0

    const flush = (): void => {
      if (batch.length === 0) return
      void chrome.runtime.sendMessage({ type: 'GRAB_PARSE_BATCH', images: batch, total, scanned })
      batch = []
      lastReport = Date.now()
    }

    const timer = setInterval(() => {
      if (batch.length > 0 && Date.now() - lastReport >= REPORT_INTERVAL_MS) {
        flush()
      }
    }, 100)

    let cursor = 0

    async function worker(): Promise<void> {
      while (cursor < candidates.length) {
        if (cancelled) return
        const candidate = candidates[cursor]
        cursor++
        seenUrls.add(candidate.url)
        const item: GrabbedImage = {
          id: candidate.url,
          url: candidate.url,
          thumbUrl: candidate.thumbUrl || undefined,
          width: candidate.width,
          height: candidate.height,
          sizeStatus: candidate.width && candidate.height ? 'ok' : 'loading',
        }
        batch.push(item)
        if (!candidate.width || !candidate.height) {
          // 尺寸缺失（懒加载/srcset 等）才加载测尺寸
          const size = await measureSize(candidate.url)
          if (size.ok) {
            item.width = size.w
            item.height = size.h
            item.sizeStatus = 'ok'
          } else {
            item.sizeStatus = 'unknown'
          }
        }
        scanned++
        if (batch.length >= BATCH_SIZE) {
          flush()
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
    clearInterval(timer)
    flush()

    scanning = false
    const reachedLimit = !cancelled && total >= MAX_PER_PARSE
    void chrome.runtime.sendMessage({
      type: 'GRAB_PARSE_DONE',
      cancelled: cancelled || undefined,
      reachedLimit: reachedLimit || undefined,
    })
  }
}

// ---------- 页面判定 ----------

function isImgbbPage(): boolean {
  const host = location.hostname
  return host.endsWith('imgbb.com') || host.endsWith('ibb.co') || host.endsWith('i.ibb.co')
}

// ---------- imgbb 适配器扫描（FP-003） ----------

function collectImgbbCandidates(): Candidate[] {
  const results: Candidate[] = []
  const items = Array.from(document.querySelectorAll<HTMLElement>('.list-item[data-type="image"]'))
  for (const item of items) {
    const raw = item.getAttribute('data-object')
    if (!raw) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(decodeURIComponent(raw)) as Record<string, unknown>
    } catch {
      continue
    }
    const imgObj = (obj.image ?? obj) as { url?: string } | undefined
    const url = imgObj?.url || (obj.url as string) || ''
    if (!/^https?:\/\//i.test(url)) continue
    const width = obj.width ? Number(obj.width) : undefined
    const height = obj.height ? Number(obj.height) : undefined
    if (width && height && (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE)) {
      continue // 过滤 <100px UI 小图
    }
    const thumbObj = obj.thumb as { url?: string } | undefined
    results.push({ url, thumbUrl: thumbObj?.url || '', width, height })
  }
  return results
}

// ---------- 通用扫描 ----------

function collectCandidates(): Candidate[] {
  const map = new Map<string, Candidate>()

  const add = (url: string, thumbUrl = '', dim: { width?: number; height?: number } = {}): void => {
    if (!url) return
    if (!/^https?:\/\//i.test(url)) return // 排除 data:/blob:/javascript: 等不可下载协议
    const existing = map.get(url)
    map.set(url, {
      url,
      thumbUrl: existing?.thumbUrl || thumbUrl,
      width: existing?.width ?? dim.width,
      height: existing?.height ?? dim.height,
    })
  }

  document.querySelectorAll('img').forEach((img) => {
    const current = img.currentSrc || '' // 页面实际渲染的展示图（通常已是小图）
    const src = img.getAttribute('src') || ''
    // DOM 直读尺寸（免加载）：naturalWidth 优先，其次 width/height 属性
    const w = img.naturalWidth || parseInt(img.getAttribute('width') || '', 10) || 0
    const h = img.naturalHeight || parseInt(img.getAttribute('height') || '', 10) || 0
    const dim = w && h ? { width: w, height: h } : {}
    add(current, current || src, dim)
    add(src, current || src, dim)
    add(img.getAttribute('data-src') || '', current || src, dim)
    add(img.getAttribute('data-original') || '', current || src, dim)
    add(img.getAttribute('data-lazy-src') || '', current || src, dim)
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset')
    if (srcset) add(pickLargestSrcset(srcset), current || src, dim)
  })

  document.querySelectorAll('picture source').forEach((source) => {
    const srcset = source.getAttribute('srcset')
    if (srcset) add(pickLargestSrcset(srcset))
  })

  return [...map.values()]
}

/** srcset 解析：取尺寸描述最大的一项（1x/2x 取最大倍率，100w 取最大宽度） */
function pickLargestSrcset(srcset: string): string {
  let best = ''
  let bestScore = -1
  for (const part of srcset.split(',')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const segments = trimmed.split(/\s+/)
    const url = segments[0]
    const descriptor = segments[1] || '1x'
    const score = descriptor.endsWith('w') ? parseInt(descriptor, 10) : parseFloat(descriptor)
    if (score > bestScore) {
      bestScore = score
      best = url
    }
  }
  return best
}

// ---------- 尺寸获取 ----------

function measureSize(url: string): Promise<{ ok: boolean; w?: number; h?: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    const timer = setTimeout(() => resolve({ ok: false }), SIZE_TIMEOUT_MS)
    img.onload = () => {
      clearTimeout(timer)
      resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      clearTimeout(timer)
      resolve({ ok: false })
    }
    img.src = url
  })
}
