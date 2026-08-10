// 下载队列管理器（background 内使用）
// 并发 ≤3，失败自动重试 1 次，失败项保留供手动重下
// 进度通过回调推送（onUpdate(done=true) 表示任务结束）

import { initLogger } from './logger'
import type { DownloadItem, DownloadJob } from './types'

const logger = initLogger('background')

const DEFAULT_CONCURRENCY = 12
const MAX_RETRY = 1
const FETCH_TIMEOUT_MS = 40000

/** background fetch 抓取图片字节（imgbb 防 180x180 降级用；signal 支持取消） */
async function fetchImageBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
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
    return await resp.arrayBuffer()
  } finally {
    clearTimeout(timer)
  }
}

/** ArrayBuffer → base64（data URL 下载用，避免大文件栈溢出分块拼接） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

interface ActiveDownload {
  jobId: number
  downloadId: number
  item: DownloadItem
  attempts: number
}

export interface DownloadManagerCallbacks {
  /** job 有更新；done=true 表示任务已结束（done/cancelled） */
  onUpdate: (job: DownloadJob, done: boolean) => void
}

/** 从 URL 提取合法文件名（序号-原名，过长截断；扩展名缺失时留空 Chrome 按 content-type 补） */
export function extractFilename(url: string, index: number): string {
  let name = ''
  try {
    const path = new URL(url).pathname
    name = decodeURIComponent(path.split('/').pop() || '')
  } catch {
    name = ''
  }
  name = name.replace(/[\\/:*?"<>|]/g, '_').trim()
  if (!name || name === '.') {
    name = 'image'
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
  private queue: { jobId: number; item: DownloadItem }[] = []
  private pendingFetches = new Set<number>() // jobId → 正在 background fetch（占并发槽）
  private fetchControllers = new Map<number, AbortController>() // jobId → imgbb 字节抓取 controller
  private nextJobId = 1
  private maxConcurrent = DEFAULT_CONCURRENCY

  /** 设置下载并发（1~24），由 background 经 GRAB_SET_CONCURRENCY 调用 */
  setConcurrency(n: number): void {
    this.maxConcurrent = Math.max(1, Math.min(24, Math.round(n) || DEFAULT_CONCURRENCY))
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
    for (const item of items) {
      this.queue.push({ jobId: job.id, item })
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
      this.queue.push({ jobId, item })
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
    } else if (active.attempts < MAX_RETRY) {
      logger.warn('download', '下载中断，自动重试', { url: active.item.url, attempt: active.attempts + 1 })
      this.queue.push({ jobId: active.jobId, item: active.item })
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
      void this.startOne(job, next.item).finally(() => {
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
        logger.info('download', '下载任务完成', { jobId: job.id, done: job.done, failed: job.failed })
        this.emit(job, true)
      }
    }
  }

  private async startOne(job: DownloadJob, item: DownloadItem): Promise<void> {
    const filename = `${job.folderName}/${item.filename}`
    try {
      let url = item.url
      // imgbb 防 180x180：chrome.downloads 直连 i.ibb.co 会被 imgbb 降级为 180 缩略图
      // （扩展上下文 TLS 指纹差异），background fetch 能拿原图 → 转 data URL 下载
      // （data URL 无服务器文件名，filename 参数必定生效）
      if (/(i\.ibb\.co|ibb\.co)/.test(url)) {
        const controller = new AbortController()
        this.fetchControllers.set(job.id, controller)
        try {
          const buf = await fetchImageBytes(item.url, controller.signal)
          this.fetchControllers.delete(job.id)
          if (job.status !== 'running') return // 抓取期间已取消
          url = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`
          logger.info('download', 'imgbb 原图经 background 抓取', { size: buf.byteLength })
        } catch (err) {
          this.fetchControllers.delete(job.id)
          if (job.status !== 'running') return
          logger.warn('download', 'imgbb background 抓取失败，降级直连', { url: item.url, error: String(err) })
        }
      }
      const downloadId = await chrome.downloads.download({ url, filename })
      this.active.set(downloadId, { jobId: job.id, downloadId, item, attempts: 0 })
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
