// 消息协议：所有跨上下文通信走这里（类型安全，集中定义）
// 响应一律使用 Promise 模式（onMessage 返回 Promise）
//
// 路由约定（FP-002）：
// - grabber → background：chrome.runtime.sendMessage
// - content → background：chrome.runtime.sendMessage（background 用 sender.tab.id 识别来源）
// - background → grabber：chrome.tabs.sendMessage（转发消息用 *_FWD 后缀，grabber 只处理 _FWD）
// - background → content：chrome.tabs.sendMessage

import type {
  DownloadItem,
  DownloadJob,
  GrabbedImage,
  GrabSession,
  ImgbbAlbum,
  ImgbbFollowingUser,
  ImgbbImage,
  LogContext,
  LogEntry,
  LogLevel,
  BuonduaImage,
  BuonduaLinkItem,
  BuonduaTarget,
  DiffuseBatchResult,
  DiffuseSnapshot,
  ScoreBatchResult,
  SearchBatchResult,
} from './types'
import type { ProducerDb } from './producer-db'
import type { FhAlbum, FhImage, FhOwner, FhProducerDb, FhProducerStatus } from './freeimage-types'
import type { FhAlbumIndexEntry } from './freeimage-types'

export type Message =
  // ---- 日志（FP-001，复用）----
  | { type: 'LOG_ADD'; level: LogLevel; context: LogContext; module: string; message: string; data?: unknown }
  | { type: 'LOG_GET' }
  | { type: 'LOG_CLEAR' }
  | { type: 'LOG_SET_LEVEL'; level: LogLevel }
  | { type: 'LOG_GET_LEVEL' }
  // ---- 会话（FP-002）----
  | { type: 'GRAB_SESSION_CREATE'; srcTabId: number; grabTabId: number }
  | { type: 'GRAB_SESSION_END_FWD'; srcTabId: number }
  // ---- 解析控制：grabber → bg（srcTabId 可选：bg 转发给 content 时省略）----
  | { type: 'GRAB_PARSE_START'; srcTabId?: number }
  | { type: 'GRAB_PARSE_CANCEL'; srcTabId?: number }
  | { type: 'GRAB_LOAD_MORE'; srcTabId?: number }
  // ---- 解析上报：content → bg（bg 按 sender.tab.id 路由为 _FWD）----
  | { type: 'GRAB_PARSE_BATCH'; images: GrabbedImage[]; total: number; scanned: number }
  | { type: 'GRAB_PARSE_DONE'; cancelled?: boolean; reachedLimit?: boolean }
  | { type: 'GRAB_PARSE_ERROR'; error: string }
  // ---- 解析转发：bg → grabber（grabber 只处理 _FWD 类型）----
  | { type: 'GRAB_PARSE_BATCH_FWD'; srcTabId: number; images: GrabbedImage[]; total: number; scanned: number }
  | { type: 'GRAB_PARSE_DONE_FWD'; srcTabId: number; cancelled?: boolean; reachedLimit?: boolean }
  | { type: 'GRAB_PARSE_ERROR_FWD'; srcTabId: number; error: string }
  // ---- 下载：grabber → bg ----
  | { type: 'GRAB_DOWNLOAD_START'; srcTabId: number; folderName: string; items: DownloadItem[] }
  | { type: 'GRAB_DOWNLOAD_CANCEL'; jobId: number }
  | { type: 'GRAB_DOWNLOAD_RETRY'; jobId: number }
  | { type: 'GRAB_DOWNLOAD_GET'; jobId: number }
  | { type: 'GRAB_OPEN_FOLDER' }
  // ---- 打包下载：grabber → bg 抓取图片字节（imgbb 扩展页 fetch 会降级 180，需 background 上下文） ----
  | { type: 'GRAB_FETCH_IMAGE'; srcTabId: number; url: string }
  // ---- 下载并发设置 ----
  | { type: 'GRAB_SET_CONCURRENCY'; concurrency: number }
  | { type: 'GRAB_GET_CONCURRENCY' }
  // ---- 下载推送：bg → grabber ----
  | { type: 'GRAB_DOWNLOAD_PROGRESS'; job: DownloadJob }
  | { type: 'GRAB_DOWNLOAD_DONE'; job: DownloadJob }
  // ---- imgbb 适配器（FP-003）：grabber → bg ----
  | { type: 'IMG_GET_ALBUM_IMAGES'; srcTabId: number; albumUrl: string }
  | { type: 'IMG_RESOLVE_USER'; srcTabId: number; albumUrl: string }
  | { type: 'IMG_FETCH_GALLERY'; srcTabId: number; url: string; pageFrom: number; pageTo: number }
  | { type: 'IMG_FETCH_GALLERY_RANGE'; srcTabId: number; url: string; prefix: string; from: number; to: number }
  | { type: 'IMG_ANALYZE_ALBUMS'; srcTabId: number; username: string; page: number }
  | { type: 'IMG_ANALYZE_FOLLOWING'; srcTabId: number; username: string; side: 'following' | 'followers' | 'both'; batchStart: number; batchSize: number }
  // ---- imgbb 适配器：bg → grabber 推送 ----
  | { type: 'IMG_RESULT'; kind: ImgResultKind; data: ImgbbImage[] | ImgbbAlbum[] | ImgbbFollowingUser[]; done: boolean; error?: string }
  // ---- 扩散检索（FP-005）：grabber → bg ----
  | { type: 'IMG_DIFFUSE_START'; srcTabId: number; startUser: string }
  | { type: 'IMG_DIFFUSE_BATCH'; srcTabId: number; batchSize: number; concurrency: number; intervalMs: number }
  | { type: 'IMG_DIFFUSE_PROGRESS' }
  | { type: 'IMG_DB_GET'; w1?: number; topN?: number }
  | { type: 'IMG_DB_SAVE'; source: string }
  | { type: 'IMG_DB_CLEAR' }
  | { type: 'IMG_DB_EXPORT' }
  | { type: 'IMG_DB_IMPORT'; db: unknown }
  | { type: 'IMG_DB_RESET_CONFIRM' }
  | { type: 'IMG_TAG_GET'; topN?: number }
  | { type: 'IMG_SCORE_BATCH'; srcTabId: number; batchSize: number; concurrency: number; intervalMs: number; order?: 'inDegree' | 'newest' | 'score'; w1?: number; w2?: number }
  | { type: 'IMG_SCORE_STOP' }
  | { type: 'IMG_SCORE_FULL'; username: string }
  | { type: 'IMG_SCORE_PROGRESS_FWD'; done: number; total: number; username: string; albumCount: number; truncated?: boolean; failed: number; cancelled?: boolean }
  | { type: 'IMG_SEARCH_START'; keywords: string[]; fromPct: number; toPct: number; w1: number; w2: number; batchSize: number }
  | { type: 'IMG_SEARCH_BATCH'; batchSize: number }
  // ---- GitHub 同步（FP-005） ----
  | { type: 'IMG_GITHUB_GET_CONFIG' }
  | { type: 'IMG_GITHUB_SAVE_CONFIG'; repo: string; token: string; branch?: string }
  | { type: 'IMG_GITHUB_PUSH' }
  | { type: 'IMG_GITHUB_PULL' }
  // ---- buondua 适配器（FP-004）：grabber → bg ----
  | { type: 'BD_FETCH_ALBUM'; srcTabId: number; url: string }
  | { type: 'BD_SCAN_LINKS'; srcTabId: number; url: string; kind: 'recommended' | 'popular' }
  | { type: 'BD_FETCH_ALBUMS'; srcTabId: number; targets: BuonduaTarget[] }
  // ---- buondua 适配器：bg → grabber 推送 ----
  | { type: 'BD_RESULT'; kind: BuonduaResultKind; data: BuonduaImage[] | BuonduaLinkItem[] | BuonduaBatchItem; done: boolean; error?: string }
  // ---- 多页站点：bg → content 页面内 fetch（带 Cookie 穿透反爬，hitxhot 等） ----
  | { type: 'BD_FETCH_HTML'; url: string }
  // ---- freeimage 适配器（FP-007）：grabber → bg ----
  | { type: 'FH_FETCH_USER'; srcTabId: number; url: string; pageFrom: number; pageTo: number }
  | { type: 'FH_FETCH_ALBUM'; srcTabId: number; albumUrl: string }
  | { type: 'FH_FETCH_ALBUMS'; srcTabId: number; username: string; sort: string; page: number }
  | { type: 'FH_FETCH_EXPLORE'; srcTabId: number; pageFrom: number; pageTo: number }
  | { type: 'FH_EXTRACT_OWNER'; srcTabId: number; imageViewerUrls: string[]; samplePerPage: number; intervalMs: number }
  | { type: 'FH_SCAN_PRODUCERS'; srcTabId: number; usernames: string[]; intervalMs: number }
  // ---- freeimage 探索检索（FP-007 场景 D v8/v9：批次会话 + 仅中文 + 中文深挖） ----
  | { type: 'FH_EXPLORE_SEARCH_START'; srcTabId: number; mode: FhExploreMode; list: FhExploreType; rounds: number; intervalMs: number; chineseOnly?: boolean }
  | { type: 'FH_EXPLORE_SEARCH_NEXT'; srcTabId: number; rounds: number; intervalMs: number; chineseOnly?: boolean }
  | { type: 'FH_EXPLORE_MINE'; srcTabId: number; rounds: number; intervalMs: number }
  | { type: 'FH_EXPLORE_STOP' }
  // ---- freeimage 相册索引库（场景 D 记录/合并/导入导出） ----
  | { type: 'FH_ALBUM_INDEX_GET' }
  | { type: 'FH_ALBUM_INDEX_EXPORT' }
  | { type: 'FH_ALBUM_INDEX_IMPORT'; db: unknown }
  | { type: 'FH_ALBUM_INDEX_CLEAR' }
  // ---- freeimage 关注墙（FP-007 迁移 imgbb 关注墙） ----
  | { type: 'FH_FETCH_FOLLOWING'; srcTabId: number; username: string; side: 'following' | 'followers' | 'both' }
  // ---- freeimage 扩散检索（FP-007 迁移 imgbb FP-005：BFS + 入度 + 生产者库） ----
  | { type: 'FH_DIFFUSE_START'; srcTabId: number; startUser: string }
  | { type: 'FH_DIFFUSE_BATCH'; srcTabId: number; batchSize: number; concurrency: number; intervalMs: number }
  | { type: 'FH_DIFFUSE_PROGRESS' }
  | { type: 'FH_DIFFUSE_DB_GET'; w1?: number; topN?: number }
  | { type: 'FH_DIFFUSE_DB_SAVE'; source: string }
  | { type: 'FH_DIFFUSE_DB_CLEAR' }
  | { type: 'FH_DIFFUSE_DB_EXPORT' }
  | { type: 'FH_DIFFUSE_DB_IMPORT'; db: unknown }
  | { type: 'FH_DIFFUSE_DB_RESET_CONFIRM' }
  | { type: 'FH_DIFFUSE_SCORE_BATCH'; srcTabId: number; batchSize: number; concurrency: number; intervalMs: number; order?: 'inDegree' | 'newest' | 'score'; w1?: number; w2?: number }
  | { type: 'FH_DIFFUSE_SCORE_STOP' }
  | { type: 'FH_DIFFUSE_SEARCH_START'; keywords: string[]; fromPct: number; toPct: number; w1: number; w2: number }
  // ---- freeimage 扩散：bg → grabber 推送 ----
  | { type: 'FH_DIFFUSE_SCORE_PROGRESS_FWD'; done: number; total: number; username: string; albumCount: number; truncated?: boolean; failed: number; cancelled?: boolean }
  | { type: 'FH_PRODUCER_GET' }
  | { type: 'FH_PRODUCER_SAVE'; username: string; status: FhProducerStatus; reason?: string }
  | { type: 'FH_PRODUCER_CLEAR'; username: string }
  | { type: 'FH_PRODUCER_EXPORT' }
  | { type: 'FH_PRODUCER_IMPORT'; db: unknown }
  // ---- freeimage 适配器：bg → grabber 推送 ----
  | { type: 'FH_RESULT'; kind: FhResultKind; data: FhImage[] | FhAlbum[] | FhOwner[] | ScanAlbumEntry[] | ExploreSearchProgress; done: boolean; error?: string }

export type ImgResultKind = 'album-images' | 'gallery' | 'gallery-range' | 'albums' | 'following'

export type FhResultKind = 'user' | 'album' | 'albums' | 'explore' | 'owners' | 'scan' | 'explore-search' | 'index-saved' | 'following' | 'explore-mine'

/** 探索页模式（路径）+ 类型（query list） */
export type FhExploreMode = 'recent' | 'popular' | 'trending'
export type FhExploreType = 'albums' | 'images' | 'users'

/** 场景 D 相册名采集扫描结果 */
export interface ScanAlbumEntry {
  username: string
  albums: { name: string; url: string }[]
  albumCount: number
  truncated: boolean
}

/** 探索检索每轮进度推送（仅文字信息） */
export interface ExploreSearchProgress {
  round: number
  pageFrom: number
  pageTo: number
  added: number // 本轮新增条目数
  total: number // 索引库累计
  newEntries: FhAlbumIndexEntry[]
  mode: FhExploreMode
  type: FhExploreType
  more?: boolean // 批次结束时：是否还有下一页（可继续下一批）
}

export type BuonduaResultKind = 'album' | 'scan' | 'batch-item'

/** 批量抓取单个相册完成推送 */
export interface BuonduaBatchItem {
  index: number
  target: BuonduaTarget
  images: BuonduaImage[]
  pages: string[]
}

export type MessageResponse =
  | {
      ok: true
      entries?: LogEntry[]
      level?: LogLevel
      session?: GrabSession
      job?: DownloadJob
      username?: string | null
      name?: string
      concurrency?: number
      data?: string
      // ---- FP-005 扩散检索 ----
      result?: DiffuseBatchResult
      snapshot?: DiffuseSnapshot
      db?: ProducerDb
      total?: number
      confirmed?: number
      producers?: number
      maxInDegree?: number
      dist?: { label: string; count: number }[]
      topUsers?: { username: string; inDegree: number; url: string; score?: number; albumCount?: number; checked?: boolean }[]
      rankScore?: { username: string; url: string; inDegree: number; albumCount?: number; score: number; truncated?: boolean }[]
      rankDegree?: { username: string; url: string; inDegree: number }[]
      rankAlbum?: { username: string; url: string; albumCount: number; inDegree: number; truncated?: boolean }[]
      full?: { username: string; albumCount: number; truncated: boolean }
      cancelled?: boolean
      tags?: import('./tag-extract').TagStat[]
      score?: ScoreBatchResult
      search?: SearchBatchResult
      unconfirmed?: number
      config?: { repo: string; branch: string; configured: boolean }
      github?: { message: string; total?: number }
      json?: string
      // ---- FP-007 freeimage ----
      fh?: FhProducerDb
      fhImported?: { before: number; after: number }
      // ---- FP-007 场景 D 相册索引库 ----
      fhIndex?: import('./freeimage-types').FhAlbumIndexDb
      fhIndexImported?: { before: number; after: number }
    }
  | { ok: false; error: string }

/** 通用发送：扩展页面 → background */
export function sendMessage<T extends MessageResponse>(message: Message): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>
}

/** 发送到指定 tab（background → content / grabber），目标无监听时静默失败 */
export async function sendToTab(tabId: number, message: Message): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch {
    // 目标页面不可达（未加载完/已关闭），静默忽略
  }
}
