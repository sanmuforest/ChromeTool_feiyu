// freeimage 扩散引擎（FP-007 关注链扩散，迁移自 imgbb-diffuse）
//
// 设计要点（对齐 imgbb FP-005，数据源换 freeimage 关注页）：
// - BFS：queue 待探索 + visited 已抓过（防环），入度 = 被关注次数（从别人 following 列表统计）
// - 数据源：https://freeimage.host/{username}/following（用户项，parseExploreUsers 解析）
// - 批次控制：每批 batchSize 人 + 批内并发 + 请求间隔（机器节流）
// - 手动「下一批」驱动（grabber 按钮），节奏由用户控制（人肉节流）
// - 单用户失败跳过（404/空关注），不中断整批；连续 429 暂停提示

import { initLogger } from '../lib/logger'
import { parseExploreUsers } from '../lib/freeimage-parse'
import type { DiffuseBatchResult, DiffuseSnapshot } from '../lib/types'

const logger = initLogger('background')

const FETCH_TIMEOUT_MS = 20000

/** 可序列化的扩散状态（storage.session 持久化，SW 休眠/重启后恢复） */
export interface FhDiffusePersistState {
  queue: string[]
  visited: string[]
  inDegree: Record<string, number>
  startUser: string
  totalRequests: number
  consecutive429: number
  recentLog: string[]
}

export class FhDiffuseEngine {
  private queue: string[] = []
  private queueSet = new Set<string>()
  private visited = new Set<string>()
  private inDegree = new Map<string, number>()
  private startUser = ''
  private started = false
  private totalRequests = 0
  private consecutive429 = 0
  private inBatchProcessed = 0
  private inBatchSize = 0
  private inBatchFailed = 0
  private recentLog: string[] = []
  private static readonly LOG_MAX = 200

  /** 序列化当前状态（storage.session 保存用） */
  save(): FhDiffusePersistState {
    return {
      queue: [...this.queue],
      visited: [...this.visited],
      inDegree: Object.fromEntries(this.inDegree),
      startUser: this.startUser,
      totalRequests: this.totalRequests,
      consecutive429: this.consecutive429,
      recentLog: [...this.recentLog],
    }
  }

  /** 从持久化状态恢复（SW 重启后续跑） */
  restore(state: FhDiffusePersistState): void {
    this.queue = [...state.queue]
    this.queueSet = new Set(state.queue)
    this.visited = new Set(state.visited)
    this.inDegree = new Map(Object.entries(state.inDegree ?? {}))
    this.startUser = state.startUser
    this.started = true
    this.totalRequests = state.totalRequests ?? 0
    this.consecutive429 = state.consecutive429 ?? 0
    this.recentLog = [...(state.recentLog ?? [])]
    this.inBatchProcessed = 0
    this.inBatchSize = 0
    this.inBatchFailed = 0
  }

  /** 是否已有活动扩散（started 且有状态） */
  isActive(): boolean {
    return this.started
  }

  private log(text: string): void {
    this.recentLog.push(text)
    if (this.recentLog.length > FhDiffuseEngine.LOG_MAX) this.recentLog.shift()
  }

  /** 开始新扩散：重置状态机 */
  start(startUser: string): void {
    const user = startUser.trim().toLowerCase()
    this.queue = [user]
    this.queueSet = new Set([user])
    this.visited = new Set()
    this.inDegree = new Map()
    this.startUser = user
    this.started = true
    this.totalRequests = 0
    this.consecutive429 = 0
    this.inBatchProcessed = 0
    this.inBatchSize = 0
    this.inBatchFailed = 0
    this.recentLog = []
    this.log(`▶ 扩散启动：起点 ${user}`)
    logger.info('diffuse', 'freeimage 扩散已启动', { startUser: user })
  }

  /** 处理一批（取队列前 batchSize，批内并发 + 间隔） */
  async processBatch(batchSize: number, concurrency: number, intervalMs: number): Promise<DiffuseBatchResult> {
    if (!this.started || this.queue.length === 0) {
      return this.result(0, 0, true)
    }
    const batch = this.queue.splice(0, batchSize)
    for (const u of batch) this.queueSet.delete(u)
    this.inBatchProcessed = 0
    this.inBatchSize = batch.length
    this.inBatchFailed = 0
    const tStart = Date.now()
    const requestTimes: number[] = []

    let cursor = 0
    let failed = 0
    let newUsers = 0
    const inDegreeDelta: Record<string, number> = {}

    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++
        if (idx >= batch.length) return
        const user = batch[idx]
        this.totalRequests++
        await sleep(intervalMs)
        const tReq = Date.now()
        try {
          const html = await this.fetchFollowingPage(user)
          const targets = parseExploreUsers(html)
          for (const t of targets) {
            const name = t.username.toLowerCase()
            this.inDegree.set(name, (this.inDegree.get(name) ?? 0) + 1)
            inDegreeDelta[name] = (inDegreeDelta[name] ?? 0) + 1
            if (!this.visited.has(name) && !this.queueSet.has(name)) {
              this.queue.push(name)
              this.queueSet.add(name)
              newUsers++
            }
          }
          this.consecutive429 = 0
          this.log(`✓ ${user}：发现 ${targets.length} 个关注（新 ${newUsers}）`)
        } catch (err) {
          failed++
          this.inBatchFailed++
          const msg = String(err)
          if (msg.includes('429')) {
            this.consecutive429++
            if (this.consecutive429 >= 3) {
              logger.warn('diffuse', '连续 429，建议暂停 30s 再继续', { count: this.consecutive429 })
            }
          }
          this.log(`✗ ${user}：失败（${msg.slice(0, 60)}）`)
          logger.warn('diffuse', '用户关注页抓取失败（跳过）', { user, error: msg })
        } finally {
          this.visited.add(user)
          this.inBatchProcessed++
          requestTimes.push(Date.now() - tReq)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()))

    const durationMs = Date.now() - tStart
    const avgRequestMs = requestTimes.length > 0 ? Math.round(requestTimes.reduce((a, b) => a + b, 0) / requestTimes.length) : 0
    const done = this.queue.length === 0
    const result = this.result(batch.length, failed, done)
    result.newUsers = newUsers
    result.inDegreeDelta = inDegreeDelta
    result.durationMs = durationMs
    result.avgRequestMs = avgRequestMs
    logger.info('diffuse', 'freeimage 批次完成', {
      processed: result.processed,
      newUsers,
      queueSize: result.queueSize,
      failed,
      durationMs,
      avgRequestMs,
      totalRequests: this.totalRequests,
    })
    return result
  }

  /** 会话快照（进度展示） */
  snapshot(): DiffuseSnapshot {
    const top = [...this.inDegree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([username, inDegree]) => ({ username, inDegree }))
    const users = [...this.inDegree.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([username, inDegree]) => ({ username, inDegree }))
    return {
      startUser: this.startUser,
      queueSize: this.queue.length,
      visitedTotal: this.visited.size,
      inDegreeSize: this.inDegree.size,
      totalRequests: this.totalRequests,
      inBatchProcessed: this.inBatchProcessed,
      inBatchSize: this.inBatchSize,
      inBatchFailed: this.inBatchFailed,
      consecutive429: this.consecutive429,
      recentLog: [...this.recentLog],
      users,
      userTotal: this.inDegree.size,
      top,
    }
  }

  get totalRequestCount(): number {
    return this.totalRequests
  }

  get is429Throttled(): boolean {
    return this.consecutive429 >= 3
  }

  private result(processed: number, failed: number, done: boolean): DiffuseBatchResult {
    return {
      processed,
      newUsers: 0,
      queueSize: this.queue.length,
      inDegreeDelta: {},
      failed,
      visitedTotal: this.visited.size,
      done,
      durationMs: 0,
      avgRequestMs: 0,
    }
  }

  /** freeimage 关注页抓取（用户项，parseExploreUsers 解析） */
  private async fetchFollowingPage(username: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const resp = await fetch(`https://freeimage.host/${encodeURIComponent(username)}/following`, {
        credentials: 'include',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Referer: 'https://freeimage.host/',
        },
        signal: controller.signal,
      })
      if (!resp.ok) {
        if (resp.status === 429) throw new Error('HTTP 429（限流）')
        throw new Error(`HTTP ${resp.status}（${username}）`)
      }
      return await resp.text()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`请求超时（${username}）`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}
