// 下载队列管理器（background 内使用）
// 并发 ≤3，失败自动重试 1 次，失败项保留供手动重下
// 进度通过回调推送（onUpdate(done=true) 表示任务结束）

import { initLogger } from './logger'
import type { DownloadItem, DownloadJob } from './types'

const logger = initLogger('background')

const MAX_CONCURRENT = 3
const MAX_RETRY = 1

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

/** 从 URL 提取合法文件名（序号-原名），扩展名缺失时留空（Chrome 按 content-type 补） */
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
  return `${String(index).padStart(3, '0')}-${name}`
}

export class DownloadManager {
  private jobs = new Map<number, DownloadJob>()
  private active = new Map<number, ActiveDownload>() // downloadId → active
  private queue: { jobId: number; item: DownloadItem }[] = []
  private nextJobId = 1

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
    // 派发排队项
    while (this.active.size < MAX_CONCURRENT && this.queue.length > 0) {
      const next = this.queue.shift()
      if (!next) break
      const job = this.jobs.get(next.jobId)
      if (!job || job.status !== 'running') continue
      void this.startOne(job, next.item)
    }
    // 检查完成态
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      const hasQueued = this.queue.some((q) => q.jobId === job.id)
      const hasActive = [...this.active.values()].some((a) => a.jobId === job.id)
      if (!hasQueued && !hasActive) {
        job.status = 'done'
        logger.info('download', '下载任务完成', { jobId: job.id, done: job.done, failed: job.failed })
        this.emit(job, true)
      }
    }
  }

  private async startOne(job: DownloadJob, item: DownloadItem): Promise<void> {
    const filename = `${job.folderName}/${item.filename}`
    try {
      const downloadId = await chrome.downloads.download({ url: item.url, filename })
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
