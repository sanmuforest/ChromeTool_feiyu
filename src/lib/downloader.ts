// 下载队列管理器（background 内使用）
// 并发 ≤3，失败自动重试 1 次，失败项保留供手动重下
// 进度通过回调推送（onUpdate(done=true) 表示任务结束）

import { initLogger } from './logger'
import type { DownloadItem, DownloadJob } from './types'

const logger = initLogger('background')

const DEFAULT_CONCURRENCY = 12
const MAX_RETRY = 1
const FETCH_TIMEOUT_MS = 40000

/** background fetch 抓取图片字节（imgbb 防 180x180 降级用；signal 支持取消）
 * 导出供 GRAB_FETCH_IMAGE（打包下载）复用 */
export async function fetchImageBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const t0 = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  // 外部取消（用户点取消按钮）时同时中断
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        Referer: 'https://imgbb.com/',
      },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const buf = await resp.arrayBuffer()
    logger.debug('download', 'imgbb 字节抓取完成', { ms: Date.now() - t0, bytes: buf.byteLength })
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/** ArrayBuffer → base64（data URL 下载 / 消息回传用，避免大文件栈溢出分块拼接） */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** 源页注入取字节的结果（2026-10-11：改为结构化返回，便于日志定位真实失败原因 ——
 *  原先注入函数内部抛错会被 executeScript 吞掉，统一表现为「页面未返回字节」，
 *  无法区分「页面内 fetch 也被 403」与「CORS 拦截」，导致无法对症修复） */
export interface SrcTabFetchResult {
  ok: boolean
  bytes?: ArrayBuffer
  error?: string
}

/**
 * 源页（当前标签页）MAIN world 注入抓图字节：
 * 页面上下文 fetch 的 Referer = 页面 URL，可带该页面对目标域的会话，用于穿透防盗链/反爬；
 * 目标域非页面同源时受 CORS 约束（这一点必须由日志暴露，不能再被吞掉）
 */
export async function fetchViaSrcTab(srcTabId: number, url: string): Promise<SrcTabFetchResult> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: srcTabId },
      world: 'MAIN',
      func: (imgUrl: string) =>
        (async () => {
          try {
            const resp = await fetch(imgUrl, {
              headers: {
                Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              },
            })
            if (!resp.ok) return { error: 'HTTP ' + resp.status }
            const buf = await resp.arrayBuffer()
            return { bytes: Array.from(new Uint8Array(buf)) }
          } catch (e) {
            return { error: String(e) }
          }
        })(),
      args: [url],
    })
    const r = results?.[0]?.result as { bytes?: number[]; error?: string } | undefined
    if (!r) return { ok: false, error: '注入无返回（标签页可能已关闭）' }
    if (r.error) return { ok: false, error: `页面内 fetch 失败：${r.error}` }
    if (!r.bytes || r.bytes.length === 0) return { ok: false, error: '页面返回空字节' }
    return { ok: true, bytes: new Uint8Array(r.bytes).buffer }
  } catch (e) {
    return { ok: false, error: `注入异常：${String(e)}` }
  }
}

/** 抛错式包装（保留既有调用签名） */
export async function fetchImgbbViaSrcTab(srcTabId: number, url: string): Promise<ArrayBuffer> {
  const res = await fetchViaSrcTab(srcTabId, url)
  if (!res.ok || !res.bytes) throw new Error(res.error ?? '源页注入失败')
  return res.bytes
}

interface ActiveDownload {
  jobId: number
  downloadId: number
  item: DownloadItem
  attempts: number
  /** 派发时刻（用于统计单项总耗时） */
  startedAt: number
}

export interface DownloadManagerCallbacks {
  /** job 有更新；done=true 表示任务已结束（done/cancelled） */
  onUpdate: (job: DownloadJob, done: boolean) => void
}

/** 从 URL 提取合法文件名（序号-原名，过长截断；albumName 提供时用「序号-相册名.扩展名」）
 * 扩展名缺失时留空（Chrome 按 content-type 补） */
export function extractFilename(url: string, index: number, albumName?: string): string {
  let name = ''
  try {
    const path = new URL(url).pathname
    name = decodeURIComponent(path.split('/').pop() || '')
  } catch {
    name = ''
  }
  // 提取扩展名（供相册名模式使用）
  let ext = ''
  const extMatch = name.match(/\.([a-z0-9]+)$/i)
  if (extMatch) ext = `.${extMatch[1].toLowerCase()}`
  name = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!name || name === '.') {
    name = 'image'
  }
  // 相册名模式：序号-相册名.扩展名（完全替换原文件名）
  const album = albumName?.replace(/[\\/:*?"<>|\n\r]/g, '_').trim()
  if (album) {
    return `${String(index).padStart(3, '0')}-${album.slice(0, 60) || 'image'}${ext || '.jpg'}`
  }
  // 简化：过长文件名截断（保留开头 + 结尾，含扩展名与尾部序号）
  const MAX_LEN = 40
  if (name.length > MAX_LEN) {
    name = `${name.slice(0, 22)}_${name.slice(-14)}`
  }
  return `${String(index).padStart(3, '0')}-${name}`
}

export class DownloadManager {
  private jobs = new Map<number, DownloadJob>()
  private active = new Map<number, ActiveDownload>() // downloadId → active（下载中）
  private queue: { jobId: number; item: DownloadItem; enqueuedAt: number }[] = []
  private pendingFetches = new Set<number>() // jobId → 正在 background fetch（占并发槽）
  private fetchControllers = new Map<number, AbortController>() // jobId → imgbb 字节抓取 controller
  private jobStartedAt = new Map<number, number>() // jobId → 任务启动时刻（汇总统计用）
  private nextJobId = 1
  private maxConcurrent = DEFAULT_CONCURRENCY

  /** 设置下载并发（1~128），由 background 经 GRAB_SET_CONCURRENCY 调用 */
  setConcurrency(n: number): void {
    this.maxConcurrent = Math.max(1, Math.min(128, Math.round(n) || DEFAULT_CONCURRENCY))
    logger.info('download', '下载并发已设置', { concurrency: this.maxConcurrent })
    this.pump()
  }

  getConcurrency(): number {
    return this.maxConcurrent
  }

  constructor(private callbacks: DownloadManagerCallbacks) {}

  start(srcTabId: number, folderName: string, items: DownloadItem[]): DownloadJob {
    const job: DownloadJob = {
      id: this.nextJobId++,
      srcTabId,
      folderName,
      total: items.length,
      done: 0,
      failed: 0,
      status: 'running',
      failedItems: [],
    }
    this.jobs.set(job.id, job)
    this.jobStartedAt.set(job.id, Date.now())
    for (const item of items) {
      this.queue.push({ jobId: job.id, item, enqueuedAt: Date.now() })
    }
    this.pump()
    return job
  }

  get(jobId: number): DownloadJob | undefined {
    return this.jobs.get(jobId)
  }

  cancel(jobId: number): void {
    const job = this.jobs.get(jobId)
    if (!job || job.status !== 'running') return
    job.status = 'cancelled'
    this.queue = this.queue.filter((q) => q.jobId !== jobId)
    // 中断正在进行的 imgbb 字节抓取（fetch 阶段无 downloadId，需 abort controller）
    this.fetchControllers.get(jobId)?.abort()
    this.fetchControllers.delete(jobId)
    for (const [downloadId, a] of this.active) {
      if (a.jobId === jobId) {
        this.active.delete(downloadId)
        void chrome.downloads.cancel(downloadId).catch(() => {})
      }
    }
    logger.info('download', '下载已取消', { jobId })
    this.emit(job, true)
    this.pump()
  }

  retry(jobId: number): void {
    const job = this.jobs.get(jobId)
    if (!job || job.failedItems.length === 0) return
    const items = [...job.failedItems]
    job.failedItems = []
    job.done = 0
    job.failed = 0
    job.status = 'running'
    for (const item of items) {
      this.queue.push({ jobId, item, enqueuedAt: Date.now() })
    }
    this.emit(job, false)
    this.pump()
  }

  /** 由 chrome.downloads.onChanged 驱动 */
  handleChanged(delta: chrome.downloads.DownloadDelta): void {
    const state = delta.state?.current
    if (state !== 'complete' && state !== 'interrupted') return
    const active = this.active.get(delta.id)
    if (!active) return
    this.active.delete(delta.id)

    const job = this.jobs.get(active.jobId)
    if (!job) return

    if (state === 'complete') {
      job.done++
      logger.debug('download', '单项下载完成', {
        jobId: active.jobId,
        downloadId: delta.id,
        ms: Date.now() - active.startedAt,
        fileSize: delta.fileSize?.current,
      })
    } else if (active.attempts < MAX_RETRY) {
      logger.warn('download', '下载中断，自动重试', { url: active.item.url, attempt: active.attempts + 1 })
      this.queue.push({ jobId: active.jobId, item: active.item, enqueuedAt: Date.now() })
    } else {
      job.failed++
      job.failedItems.push({ url: active.item.url, filename: active.item.filename, error: '下载中断' })
      logger.warn('download', '下载失败（重试后）', { url: active.item.url })
    }
    this.emit(job, false)
    this.pump()
  }

  private pump(): void {
    // 派发排队项：fetch 阶段与下载中合并计入并发槽（避免一次性全派发导致排队）
    while (this.active.size + this.pendingFetches.size < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) break
      const job = this.jobs.get(next.jobId)
      if (!job || job.status !== 'running') continue
      this.pendingFetches.add(next.jobId)
      void this.startOne(job, next.item, next.enqueuedAt).finally(() => {
        this.pendingFetches.delete(next.jobId)
        this.pump()
      })
    }
    // 检查完成态
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      const hasQueued = this.queue.some((q) => q.jobId === job.id)
      const hasActive = [...this.active.values()].some((a) => a.jobId === job.id)
      const hasFetch = this.pendingFetches.has(job.id)
      if (!hasQueued && !hasActive && !hasFetch) {
        job.status = 'done'
        const totalMs = Date.now() - (this.jobStartedAt.get(job.id) ?? Date.now())
        const avgMs = job.done > 0 ? Math.round(totalMs / job.done) : 0
        logger.info('download', '下载任务完成', {
          jobId: job.id,
          done: job.done,
          failed: job.failed,
          totalMs,
          avgMsPerItem: avgMs,
          concurrency: this.maxConcurrent,
        })
        this.jobStartedAt.delete(job.id)
        this.emit(job, true)
      }
    }
  }

  private async startOne(job: DownloadJob, item: DownloadItem, enqueuedAt: number): Promise<void> {
    const filename = `${job.folderName}/${item.filename}`
    logger.debug('download', '派发下载项', { jobId: job.id, filename: item.filename, queueWaitMs: Date.now() - enqueuedAt })
    try {
      let url = item.url
      // imgbb 防 180x180：SW / 扩展页 / 沙箱上下文一律被降级（2026-08-11 实测），
      // 仅源页（imgbb 域页面）上下文请求放行原图 → 优先源页注入，失败降级 background fetch
      if (/(i\.ibb\.co|ibb\.co)/.test(url)) {
        const tFetch = Date.now()
        const controller = new AbortController()
        this.fetchControllers.set(job.id, controller)
        try {
          const buf = await fetchImgbbViaSrcTab(job.srcTabId, item.url)
          this.fetchControllers.delete(job.id)
          if (job.status !== 'running') return // 抓取期间已取消
          url = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`
          logger.debug('download', 'imgbb 源页注入转 data URL', { jobId: job.id, fetchMs: Date.now() - tFetch, bytes: buf.byteLength })
        } catch (err) {
          // 降级 1：background fetch（历史方案，现可能拿到 180 缩略图）
          this.fetchControllers.delete(job.id)
          if (job.status !== 'running') return
          logger.warn('download', 'imgbb 源页注入失败，降级 background fetch', { url: item.url, error: String(err) })
          try {
            const buf = await fetchImageBytes(item.url, controller.signal)
            this.fetchControllers.delete(job.id)
            if (job.status !== 'running') return // 抓取期间已取消
            const tB64 = Date.now()
            url = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`
            logger.debug('download', 'imgbb 原图转 data URL', {
              jobId: job.id,
              fetchMs: tB64 - tFetch,
              b64Ms: Date.now() - tB64,
              bytes: buf.byteLength,
            })
          } catch (err2) {
            this.fetchControllers.delete(job.id)
            if (job.status !== 'running') return
            logger.warn('download', 'imgbb background 抓取失败，降级直连', { url: item.url, error: String(err2) })
          }
        }
      }
      const tDl = Date.now()
      const downloadId = await chrome.downloads.download({ url, filename })
      this.active.set(downloadId, { jobId: job.id, downloadId, item, attempts: 0, startedAt: Date.now() })
      logger.debug('download', 'downloads.download 已发起', { jobId: job.id, downloadId, setupMs: Date.now() - tDl })
    } catch (err) {
      // 启动即失败（参数问题/URL 非法）
      job.failed++
      job.failedItems.push({ url: item.url, filename: item.filename, error: String(err) })
      this.emit(job, false)
      this.pump()
    }
  }

  private emit(job: DownloadJob, done: boolean): void {
    this.callbacks.onUpdate(job, done)
  }
}
