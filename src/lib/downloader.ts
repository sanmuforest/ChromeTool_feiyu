// 下载队列管理器（background 内使用）
// 并发 ≤3，失败自动重试 1 次，失败项保留供手动重下
// 进度通过回调推送（onUpdate(done=true) 表示任务结束）

import { initLogger } from './logger'
import type { DownloadItem, DownloadJob } from './types'

const logger = initLogger('background')

const DEFAULT_CONCURRENCY = 12
/** 单项下载中断后的自动重试次数（2026-11-06：1 → 2）
 *  imgbb 的下载经常在传输中途被中断（Service Worker 生命周期 + 图床慢），
 *  只重试 1 次时容易留下永久失败项；提到 2 次可显著降低断联残留。 */
const MAX_RETRY = 2
const FETCH_TIMEOUT_MS = 40000

// 2026-11-06：429 自适应限速 + 退避重试
// 实测（v0.2.59 用户日志）：kaizty 的图床 i0.wp.com 单张请求 200，但打包时 12 并发
// 同时打同一 CDN 会被限流，日志出现大量 "HTTP 429" 且打包只成功一半左右。
// Referer 不是原因（实测 imgbb/无/kaizty/同源 四种 Referer 单张全部 200）。
// 策略：命中 429/503 时对该 host 启用最小间隔（此后同 host 串行化），并退避重试；
//      未触发过限流的 host 完全不受影响（正常站点速度不变）。
const RETRY_THROTTLE_MAX = 3
const HOST_THROTTLE_GAP_MS = 500
/** imgbb 图床主机（图片在 i.ibb.co，站点在 ibb.co / *.imgbb.com） */
const IMGBB_HOST_RE = /^(?:i\.ibb\.co|[^.]*\.imgbb\.com)$/i
/** 退避基数（2026-11-06 调整）：原 800/1600/3200 累计 5.6s，对 503 失败图拖慢明显
 *  实测日志：59 张的相册前 1.5 分钟处理 55 张，后 2 分钟全耗在 4 张失败图的重试上
 *  → 改为 500/1000/2000，累计 3.5s，成功率影响可接受 */
const THROTTLE_BACKOFF_BASE_MS = 500
const hostThrottle = new Map<string, { gap: number; lastAt: number }>()

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 同图床取字节节流：仅对已触发限流的 host 生效 */
async function awaitHostSlot(host: string): Promise<void> {
  const st = hostThrottle.get(host)
  if (!st || st.gap <= 0) return
  const wait = st.lastAt + st.gap - Date.now()
  if (wait > 0) await sleep(wait)
}

function noteHostResult(host: string, throttled: boolean): void {
  if (!host) return
  const st = hostThrottle.get(host) ?? { gap: 0, lastAt: 0 }
  // 2026-11-06：imgbb 的失败形态是「超时（AbortError）」，不是「429 限流」。
  // 对它启用 host 串行化只会把整个 host 拖成串行执行 ——
  // 实测（v0.2.67 日志）avgMsPerItem 3806ms × 92 张 = 350 秒，恰好等于「完全串行」的耗时，
  // 而同一份日志里的失败全是 elapsedMs=30000 的超时、没有 429。
  // → 并发改由 jobConcurrency（图床策略值）控制，这里不再给它加间隔。
  if (throttled && !IMGBB_HOST_RE.test(host)) st.gap = HOST_THROTTLE_GAP_MS
  st.lastAt = Date.now()
  hostThrottle.set(host, st)
}

/** 图床策略（2026-11-06）
 *  实测（v0.2.65，8 张图并发 vs 顺序）：
 *   - imgbb 的 i.ibb.co 单张响应 1~10 秒波动
 *   - 并发 8 张 → 成功 4/8，失败的 4 张全部卡到 30 秒超时
 *   - 顺序 8 张 → 成功 6/8，平均 8.7 秒/张
 *   - 网页端同样卡顿、相册加载不全 → 服务端本身慢且对并发极度敏感
 *  结论：对 imgbb 用默认的 12 并发 + 40 秒超时是反向优化（大量超时反而更慢）。
 *  策略：降并发（3）、缩短超时（12 秒快速失败）、只重试 1 次且快速退避（300ms）。 */
export interface HostPolicy {
  /** 该图床允许的并发上限 */
  concurrency?: number
  /** 单张取字节超时 */
  timeoutMs?: number
  /** 限流重试次数上限 */
  retryMax?: number
  /** 退避基数（指数递增） */
  backoffBaseMs?: number
}

const HOST_POLICIES: { re: RegExp; policy: HostPolicy }[] = [
  {
    re: IMGBB_HOST_RE,
    // 2026-11-06 v0.2.67 修正：v0.2.66 曾把超时压到 12 秒，实测代价极大 ——
    //   抓取 92 张只打包成功 52 张（57%），耗时 6 分 15 秒，日志出现 40+ 次 AbortError。
    // 根因判断错误：imgbb 的问题不是"请求太多"，而是"每次请求本身就慢"
    //   （实测单张 1~10 秒，并发下更慢）。压超时 = 自己把还在传输的请求掐断。
    // 现取值：超时 30 秒（覆盖实测最慢 10.5 秒并留并发余量）、并发 8（折中）、
    //         重试 2 次、退避 1 秒（给服务端喘息）。
    policy: { concurrency: 8, timeoutMs: 30000, retryMax: 2, backoffBaseMs: 1000 },
  },
]

/** 按 URL 取图床策略；未命中返回空对象（= 使用全局默认策略） */
export function policyForUrl(url: string): HostPolicy {
  const host = hostOf(url)
  if (!host) return {}
  for (const p of HOST_POLICIES) if (p.re.test(host)) return p.policy
  return {}
}

/** background fetch 抓取图片字节（imgbb 防 180x180 降级用；signal 支持取消）
 * 导出供 GRAB_FETCH_IMAGE（打包下载）复用
 * 2026-11-06：限流（429/503）自动退避重试；超时/重试次数/退避按图床策略生效 */
export async function fetchImageBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const t0 = Date.now()
  const host = hostOf(url)
  const policy = policyForUrl(url)
  const timeoutMs = policy.timeoutMs ?? FETCH_TIMEOUT_MS
  const retryMax = policy.retryMax ?? RETRY_THROTTLE_MAX
  const backoffBase = policy.backoffBaseMs ?? THROTTLE_BACKOFF_BASE_MS
  let lastErr: Error | null = null
  for (let attempt = 0; attempt <= retryMax; attempt++) {
    await awaitHostSlot(host)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // 外部取消（用户点取消按钮）时同时中断
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    let retryable = false
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://imgbb.com/',
        },
      })
      if (resp.status === 429 || resp.status === 503) {
        noteHostResult(host, true)
        lastErr = new Error(`HTTP ${resp.status}`)
        retryable = true
      } else if (!resp.ok) {
        noteHostResult(host, false)
        throw new Error(`HTTP ${resp.status}`)
      } else {
        const buf = await resp.arrayBuffer()
        noteHostResult(host, false)
        logger.debug('download', '图片字节抓取完成', { ms: Date.now() - t0, bytes: buf.byteLength })
        return buf
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      // 诊断（2026-11-06）：区分「超时掐断」与「其他中断」—— 前者该加长超时，后者该查 SW 生命周期，
      // 两者优化方向相反，不能靠猜。likelyTimeout=true 表示请求跑满超时才被中断。
      if (/abort/i.test(lastErr.message)) {
        const elapsedMs = Date.now() - t0
        logger.warn('download', '取字节被中断', {
          host,
          elapsedMs,
          timeoutMs,
          likelyTimeout: elapsedMs >= timeoutMs - 800,
        })
      }
      // 4xx（除 429）是确定性失败，不重试；网络错误/超时/限流可重试
      const m = /^HTTP (\d{3})$/.exec(lastErr.message)
      retryable = !m || m[1] === '429' || m[1] === '503'
    } finally {
      clearTimeout(timer)
    }
    if (!retryable || attempt >= retryMax) break
    const backoff = backoffBase * Math.pow(2, attempt)
    logger.debug('download', '取字节受限，退避后重试', { attempt: attempt + 1, backoff, host })
    await sleep(backoff)
  }
  throw lastErr ?? new Error('图片字节抓取失败')
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
/** @deprecated 2026-11-06 起不再被调用
 *  原因：imgbb 图片在 i.ibb.co、源页在 ibb.co，跨子域 fetch 必然 CORS 失败
 *  （日志里每张都白跑一次 TypeError: Failed to fetch），且该通道没有超时约束；
 *  实测 i.ibb.co 对任意 Referer 都返回原图（1024×768 / 102KB，非 180 降级），
 *  background 的 fetchImageBytes 已能可靠取得原图。
 *  保留定义仅为避免与历史变更记录失联，勿在新代码中调用。 */
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
  private queue: { jobId: number; item: DownloadItem; enqueuedAt: number; attempt?: number }[] = []
  /** 每个 job 正在 fetch 阶段的项数（2026-11-06 修复）
   *  原实现是 `Set<number>`，写入的是 jobId —— 同一 job 的多个文件共享一个 jobId，
   *  Set 去重后 size 恒为 1，导致并发上限完全失效，整个队列被一次性派发
   *  （77 个 chrome.downloads.download 同时发起 → 浏览器卡死、imgbb 限流缺图） */
  private pendingByJob = new Map<number, number>()
  /** fetch 阶段的取消控制器（2026-11-06 修复）
   *  原实现 `Map<jobId, AbortController>` 会被同一 job 的后续项覆盖，取消时只能中断最后一项。
   *  改为以 controller 为键记录所属 job，取消时按 jobId 遍历中断 */
  private fetchControllers = new Map<AbortController, number>() // controller → jobId
  private jobStartedAt = new Map<number, number>() // jobId → 任务启动时刻（汇总统计用）
  /** 每个任务的并发上限（2026-11-06）
   *  全局上限之外，任务还可因图床策略被压得更低：imgbb 对并发敏感
   *  （实测 12 并发时大量请求跑满 30 秒超时；同一张图不同时刻时好时坏）。 */
  private jobConcurrency = new Map<number, number>()
  private nextJobId = 1
  private maxConcurrent = DEFAULT_CONCURRENCY

  /** 该任务在途（fetch 中 + 下载中）的项数 */
  private countInflightOfJob(jobId: number): number {
    let downloading = 0
    for (const a of this.active.values()) if (a.jobId === jobId) downloading++
    return downloading + (this.pendingByJob.get(jobId) ?? 0)
  }

  /** 当前处于 fetch 阶段的项总数（跨 job 汇总） */
  private pendingFetchTotal(): number {
    let n = 0
    for (const v of this.pendingByJob.values()) n += v
    return n
  }

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
    // 2026-11-06：按图床策略设定本任务并发上限。
    // 实测（v0.2.67 日志）：imgbb 在全局 12 并发下大量请求跑满 30 秒超时（elapsedMs 精确 30000/61000），
    // 而同一张图换个时刻又能成功 → 降低并发可减少相互拥塞。
    const imgbbPolicy = policyForUrl(items[0]?.url ?? '')
    const hasImgbb = items.some((i) => /(?:^|\/\/)(?:[^/]*\.)?(?:ibb\.co|imgbb\.com)\//i.test(i.url))
    const jobLimit =
      hasImgbb && imgbbPolicy.concurrency !== undefined
        ? Math.min(this.maxConcurrent, imgbbPolicy.concurrency)
        : this.maxConcurrent
    this.jobConcurrency.set(job.id, jobLimit)
    if (hasImgbb) logger.info('download', '按图床策略限制本任务并发', { jobId: job.id, jobLimit, total: items.length })
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
    this.jobConcurrency.delete(jobId)
    // 中断正在进行的 imgbb 字节抓取（fetch 阶段无 downloadId，需 abort controller）
    for (const [ctrl, jid] of [...this.fetchControllers]) {
      if (jid === jobId) {
        ctrl.abort()
        this.fetchControllers.delete(ctrl)
      }
    }
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
      // 2026-11-06 修复：原实现重新入队时**没有带上重试次数**，
      // 导致每次重建的 active.attempts 都是 0 → `0 < MAX_RETRY` 永远成立 → 无限重试。
      // 现在把 attempt 随队列入队并在 startOne 时回填到 active。
      this.queue.push({ jobId: active.jobId, item: active.item, enqueuedAt: Date.now(), attempt: active.attempts + 1 })
    } else {
      job.failed++
      job.failedItems.push({ url: active.item.url, filename: active.item.filename, error: '下载中断' })
      logger.warn('download', '下载失败（重试后）', { url: active.item.url })
    }
    this.emit(job, false)
    this.pump()
  }

  private pump(): void {
    // 派发排队项：fetch 阶段与下载中合并计入并发槽（避免一次性全派发导致排队）。
    // 2026-11-06：除全局上限外，还要满足各任务自身的并发上限（图床策略），
    // 否则 imgbb 任务仍会按全局 12 并发铺开，继续互相拥塞。
    while (this.active.size + this.pendingFetchTotal() < this.maxConcurrent && this.queue.length > 0) {
      let pickIdx = -1
      for (let i = 0; i < this.queue.length; i++) {
        const cand = this.queue[i]
        const candJob = this.jobs.get(cand.jobId)
        if (!candJob || candJob.status !== 'running') continue
        const jobLimit = this.jobConcurrency.get(cand.jobId) ?? this.maxConcurrent
        if (this.countInflightOfJob(cand.jobId) < jobLimit) {
          pickIdx = i
          break
        }
      }
      if (pickIdx < 0) break // 所有排队项所属任务都已达到各自并发上限
      const next = this.queue.splice(pickIdx, 1)[0]
      if (!next) break
      const job = this.jobs.get(next.jobId)
      if (!job || job.status !== 'running') continue
      const jid = next.jobId
      this.pendingByJob.set(jid, (this.pendingByJob.get(jid) ?? 0) + 1)
      void this.startOne(job, next.item, next.enqueuedAt, next.attempt ?? 0).finally(() => {
        const n = (this.pendingByJob.get(jid) ?? 1) - 1
        if (n <= 0) this.pendingByJob.delete(jid)
        else this.pendingByJob.set(jid, n)
        this.pump()
      })
    }
    // 检查完成态
    for (const job of this.jobs.values()) {
      if (job.status !== 'running') continue
      const hasQueued = this.queue.some((q) => q.jobId === job.id)
      const hasActive = [...this.active.values()].some((a) => a.jobId === job.id)
      const hasFetch = (this.pendingByJob.get(job.id) ?? 0) > 0
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

  private async startOne(job: DownloadJob, item: DownloadItem, enqueuedAt: number, attempt = 0): Promise<void> {
    const filename = `${job.folderName}/${item.filename}`
    logger.debug('download', '派发下载项', { jobId: job.id, filename: item.filename, queueWaitMs: Date.now() - enqueuedAt, attempt })
    try {
      let url = item.url
      // imgbb 防 180x180：SW / 扩展页 / 沙箱上下文一律被降级（2026-08-11 实测），
      // 仅源页（imgbb 域页面）上下文请求放行原图 → 优先源页注入，失败降级 background fetch
      if (/(i\.ibb\.co|ibb\.co)/.test(url)) {
        const tFetch = Date.now()
        const controller = new AbortController()
        this.fetchControllers.set(controller, job.id)
        try {
          // 2026-11-06：跳过源页注入 —— imgbb 图片在 i.ibb.co、源页在 ibb.co，跨子域必然 CORS 失败
          // （日志里每张都白跑一次 TypeError: Failed to fetch，且该通道没有超时约束）。
          // 实测 i.ibb.co 对任意 Referer 都返回原图（1024×768 / 102KB，非 180 降级）→ 直接用 background fetch。
          const buf = await fetchImageBytes(item.url, controller.signal)
          if (job.status !== 'running') return // 抓取期间已取消
          url = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`
          logger.debug('download', 'imgbb 原图转 data URL', { jobId: job.id, fetchMs: Date.now() - tFetch, bytes: buf.byteLength })
        } catch (err) {
          if (job.status !== 'running') return
          logger.warn('download', 'imgbb 取字节失败，降级直连', { url: item.url, error: String(err) })
        } finally {
          this.fetchControllers.delete(controller)
        }
      }
      const tDl = Date.now()
      const downloadId = await chrome.downloads.download({ url, filename })
      this.active.set(downloadId, { jobId: job.id, downloadId, item, attempts: attempt, startedAt: Date.now() })
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
