// 生产者库（FP-005）：入度表 CRUD / 合并 / 持久化 / 综合评分（纯逻辑，无副作用）
//
// 数据模型：entries: Record<username, ProducerEntry>
// - 入度（被关注次数）：多起点扩散合并时累加
// - 综合评分：w1×归一化(入度) + w2×归一化(相册数)，对数归一化防大 V 碾压
// - 本地存储键 producer_db；GitHub 同步（github-sync.ts）后续接入

import type { ProducerEntry } from './types'

export const PRODUCER_DB_KEY = 'producer_db'
export const PRODUCER_DB_VERSION = 1
export const PRODUCER_DB_LIMIT = 50000 // 容量警示阈值
export const DEFAULT_SCORE_W1 = 0.6 // 入度权重
export const DEFAULT_SCORE_W2 = 0.4 // 相册数权重

export interface ProducerDb {
  version: number
  updatedAt: number
  entries: Record<string, ProducerEntry>
}

export function emptyDb(): ProducerDb {
  return { version: PRODUCER_DB_VERSION, updatedAt: Date.now(), entries: {} }
}

/** 从 storage 读取（数据校验容错，损坏则返回空库） */
export function loadDb(raw: unknown): ProducerDb {
  if (raw && typeof raw === 'object' && typeof (raw as ProducerDb).entries === 'object') {
    const entries = (raw as ProducerDb).entries as Record<string, ProducerEntry>
    // 清理非法条目（缺 username / inDegree 非数）
    const cleaned: Record<string, ProducerEntry> = {}
    for (const [k, v] of Object.entries(entries)) {
      if (v && typeof v.username === 'string' && typeof v.inDegree === 'number') {
        cleaned[k] = v
      }
    }
    return { version: PRODUCER_DB_VERSION, updatedAt: Date.now(), entries: cleaned }
  }
  return emptyDb()
}

/** 合并入度增量到库（source = 本次起点用户） */
export function mergeInDegree(
  db: ProducerDb,
  delta: Record<string, number>,
  source: string,
  now = Date.now(),
): ProducerDb {
  const entries = { ...db.entries }
  for (const [username, inc] of Object.entries(delta)) {
    const prev = entries[username]
    if (prev) {
      entries[username] = {
        ...prev,
        inDegree: prev.inDegree + inc,
        lastSeenAt: now,
        sources: prev.sources.includes(source) ? prev.sources : [...prev.sources, source].slice(-20),
      }
    } else {
      entries[username] = { username, inDegree: inc, firstSeenAt: now, lastSeenAt: now, sources: [source] }
    }
  }
  return { ...db, updatedAt: now, entries }
}

/** 合并整张库（GitHub 拉取合并 / 加载外部表）：入度累加、相册信息互补 */
export function mergeDb(target: ProducerDb, incoming: ProducerDb): ProducerDb {
  const merged = { ...target.entries }
  for (const [username, entry] of Object.entries(incoming.entries)) {
    const prev = merged[username]
    if (prev) {
      merged[username] = {
        username,
        inDegree: prev.inDegree + entry.inDegree,
        firstSeenAt: Math.min(prev.firstSeenAt, entry.firstSeenAt),
        lastSeenAt: Math.max(prev.lastSeenAt, entry.lastSeenAt),
        sources: Array.from(new Set([...prev.sources, ...entry.sources])).slice(-20),
        albumCount: entry.albumCount ?? prev.albumCount,
        albumsChecked: (prev.albumsChecked || entry.albumsChecked) || undefined,
        albums: entry.albums ?? prev.albums,
      }
    } else {
      merged[username] = { ...entry }
    }
  }
  return { ...target, updatedAt: Date.now(), entries: merged }
}

/** 对数归一化 log(1+x)/log(1+max)；max<=0 时返回 0 */
export function logNorm(x: number, max: number): number {
  if (max <= 0 || x <= 0) return 0
  return Math.log(1 + x) / Math.log(1 + max)
}

/** 综合评分：w1×归一化(入度) + w2×归一化(相册数)；未确认相册的用户仅按入度部分计分 */
export function computeScore(
  entry: ProducerEntry,
  maxInDegree: number,
  maxAlbumCount: number,
  w1 = DEFAULT_SCORE_W1,
  w2 = DEFAULT_SCORE_W2,
): number {
  const albumCount = entry.albumsChecked ? entry.albumCount ?? 0 : 0
  return w1 * logNorm(entry.inDegree, maxInDegree) + w2 * logNorm(albumCount, maxAlbumCount)
}

/** 全量统计（排序用） */
export function collectStats(db: ProducerDb): { maxInDegree: number; maxAlbumCount: number } {
  let maxInDegree = 0
  let maxAlbumCount = 0
  for (const e of Object.values(db.entries)) {
    if (e.inDegree > maxInDegree) maxInDegree = e.inDegree
    if ((e.albumCount ?? 0) > maxAlbumCount) maxAlbumCount = e.albumCount ?? 0
  }
  return { maxInDegree, maxAlbumCount }
}

/** 按综合评分降序取 Top-N（返回带评分的条目） */
export function topCandidates(db: ProducerDb, n: number, w1?: number, w2?: number): (ProducerEntry & { score: number })[] {
  const { maxInDegree, maxAlbumCount } = collectStats(db)
  const scored = Object.values(db.entries).map((e) => ({
    ...e,
    score: computeScore(e, maxInDegree, maxAlbumCount, w1, w2),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(0, n))
}

/** 库摘要（UI 统计） */
export function dbSummary(db: ProducerDb): {
  total: number
  producers: number
  confirmed: number
  maxInDegree: number
} {
  let producers = 0
  let confirmed = 0
  let maxInDegree = 0
  for (const e of Object.values(db.entries)) {
    if (e.inDegree > maxInDegree) maxInDegree = e.inDegree
    if (e.albumCount && e.albumCount > 0) producers++
    if (e.albumsChecked) confirmed++
  }
  return { total: Object.keys(db.entries).length, producers, confirmed, maxInDegree }
}

/** 入度分布（图表用）：区间 → 用户数 */
export function inDegreeDist(db: ProducerDb): { label: string; count: number }[] {
  const buckets: { label: string; min: number; max: number }[] = [
    { label: '1', min: 1, max: 1 },
    { label: '2~5', min: 2, max: 5 },
    { label: '6~10', min: 6, max: 10 },
    { label: '11~50', min: 11, max: 50 },
    { label: '51~200', min: 51, max: 200 },
    { label: '200+', min: 201, max: Infinity },
  ]
  const counts = buckets.map(() => 0)
  for (const e of Object.values(db.entries)) {
    const idx = buckets.findIndex((b) => e.inDegree >= b.min && e.inDegree <= b.max)
    if (idx >= 0) counts[idx]++
  }
  return buckets.map((b, i) => ({ label: b.label, count: counts[i] }))
}

/** Top 列表（带主页 URL，点击打开用） */
export function topList(db: ProducerDb, n: number): { username: string; inDegree: number; url: string }[] {
  return Object.values(db.entries)
    .sort((a, b) => b.inDegree - a.inDegree)
    .slice(0, Math.max(0, n))
    .map((e) => ({ username: e.username, inDegree: e.inDegree, url: `https://${e.username}.imgbb.com` }))
}

/** 未确认候选（排序：inDegree 入度 / newest 最新 / score 评分近似，取前 n）——确认阶段调度用
 * 注：未确认用户无相册数，score 排序仅入度项有效（近似入度优先） */
export function unconfirmedCandidates(
  db: ProducerDb,
  n: number,
  order: 'inDegree' | 'newest' | 'score' = 'inDegree',
  w1 = DEFAULT_SCORE_W1,
  w2 = DEFAULT_SCORE_W2,
): ProducerEntry[] {
  const list = Object.values(db.entries).filter((e) => !e.albumsChecked)
  if (order === 'newest') {
    list.sort((a, b) => b.firstSeenAt - a.firstSeenAt)
  } else if (order === 'score') {
    const { maxInDegree, maxAlbumCount } = collectStats(db)
    list.sort(
      (a, b) =>
        computeScore(b, maxInDegree, maxAlbumCount, w1, w2) - computeScore(a, maxInDegree, maxAlbumCount, w1, w2),
    )
  } else {
    list.sort((a, b) => b.inDegree - a.inDegree)
  }
  return list.slice(0, Math.max(0, n))
}

/** 未确认候选总数 */
export function unconfirmedCount(db: ProducerDb): number {
  let n = 0
  for (const e of Object.values(db.entries)) if (!e.albumsChecked) n++
  return n
}

/** 已确认用户按综合评分降序（检索区间选取基础） */
export function confirmedScored(db: ProducerDb, w1?: number, w2?: number): (ProducerEntry & { score: number })[] {
  const { maxInDegree, maxAlbumCount } = collectStats(db)
  return Object.values(db.entries)
    .filter((e) => e.albumsChecked && (e.albumCount ?? 0) > 0)
    .map((e) => ({ ...e, score: computeScore(e, maxInDegree, maxAlbumCount, w1, w2) }))
    .sort((a, b) => b.score - a.score)
}

/** 关键词匹配相册名（多词 OR，大小写不敏感，纯本地零请求） */
export function matchAlbums(entry: ProducerEntry, keywords: string[]): { name: string; url: string; imageCount?: number }[] {
  if (keywords.length === 0 || !entry.albums) return []
  return entry.albums.filter((a) => keywords.some((k) => a.name.toLowerCase().includes(k)))
}
