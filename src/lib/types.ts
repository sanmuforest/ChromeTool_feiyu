// 共享类型定义（schema 单一来源）

/** 日志等级 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** 日志来源上下文 */
export type LogContext = 'background' | 'content' | 'grabber'

/** 单条日志条目 */
export interface LogEntry {
  id: number
  ts: number
  context: LogContext
  level: LogLevel
  module: string
  message: string
  data?: unknown
}

/** 等级数值（用于比较过滤） */
export const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

// ========== 图片抓取器（FP-002） ==========

/** 抓取到的图片条目（grabber 页内存保存，不进 storage） */
export interface GrabbedImage {
  id: string
  url: string
  /** 下载地址（默认 = url；imgbb 等站点显示图与下载图不同） */
  downloadUrl?: string
  /** 展示用缩略图（服务器提供；无则网格原图占位 + canvas 降采样） */
  thumbUrl?: string
  width?: number
  height?: number
  sizeStatus: 'ok' | 'loading' | 'unknown'
}

export type GrabSessionStatus = 'parsing' | 'idle' | 'error'

/** 抓取会话：源网页 ↔ 抓取页 映射（background 内存维护，storage 兜底） */
export interface GrabSession {
  srcTabId: number
  grabTabId: number
  title: string
  host: string
  url: string
  folderName: string
  status: GrabSessionStatus
}

/** 下载项：url + 相对文件名（不含文件夹前缀） */
export interface DownloadItem {
  url: string
  filename: string
}

export type DownloadJobStatus = 'running' | 'cancelled' | 'done' | 'error'

export interface DownloadFailedItem {
  url: string
  filename: string
  error?: string
}

/** 下载任务（background 维护，实时推送 grabber） */
export interface DownloadJob {
  id: number
  srcTabId: number
  folderName: string
  total: number
  done: number
  failed: number
  status: DownloadJobStatus
  failedItems: DownloadFailedItem[]
}

// ========== imgbb 适配器（FP-003） ==========

/** imgbb 图片（列表项 data-object 解析结果） */
export interface ImgbbImage {
  id: string
  filename: string
  name: string
  originalUrl: string // 原图（最大尺寸）
  mediumUrl: string // 展示图
  thumbUrl: string // 缩略图
  width?: number
  height?: number
  viewerUrl: string
  username: string
}

/** imgbb 相册 */
export interface ImgbbAlbum {
  id: string
  name: string
  coverUrl: string
  url: string
  imageCount?: number
}

/** imgbb 用户（关注墙） */
export interface ImgbbUser {
  username: string
  url: string
  avatarUrl: string
}

/** 关注墙分析结果：用户 + 其相册 */
export interface ImgbbFollowingUser {
  user: ImgbbUser
  albums: ImgbbAlbum[]
}

// ========== 关注链扩散检索（FP-005） ==========

/** 生产者库条目（入度表，username 为主键） */
export interface ProducerEntry {
  username: string
  /** 被关注次数（多次扩散合并时累加） */
  inDegree: number
  firstSeenAt: number
  lastSeenAt: number
  /** 发现该用户的起点用户（追溯用） */
  sources: string[]
  /** 相册数（albums 确认后补充，供综合评分） */
  albumCount?: number
  /** 是否已做过 albums 确认 */
  albumsChecked?: boolean
  /** 相册名列表（确认时缓存，检索零请求本地匹配） */
  albums?: { name: string; url: string }[]
}

/** 确认+评分批次结果 */
export interface ScoreBatchResult {
  processed: number
  /** 有相册用户数 */
  withAlbums: number
  /** 零相册用户数 */
  zeroAlbums: number
  failed: number
  /** 无更多未确认候选 */
  done: boolean
}

/** 检索命中：用户 + 命中的相册 */
export interface SearchMatch {
  username: string
  inDegree: number
  albums: { name: string; url: string; imageCount?: number }[]
}

/** 检索批次结果 */
export interface SearchBatchResult {
  /** 区间候选总数 */
  total: number
  /** 本批处理数 */
  processed: number
  matches: SearchMatch[]
  done: boolean
}

/** 扩散批次处理结果 */
export interface DiffuseBatchResult {
  /** 本批处理的用户数（= 请求数） */
  processed: number
  /** 本批新发现的用户数 */
  newUsers: number
  /** 待探索队列大小 */
  queueSize: number
  /** 本批入度增量（username → +n） */
  inDegreeDelta: Record<string, number>
  /** 本批失败（限流/登录墙/404 跳过） */
  failed: number
  /** 已抓取 following 的用户总数 */
  visitedTotal: number
  /** 队列耗尽 */
  done: boolean
  /** 本批总耗时 ms */
  durationMs: number
  /** 本批平均每请求耗时 ms（含网络+间隔） */
  avgRequestMs: number
}

/** 扩散会话快照（进度展示） */
export interface DiffuseSnapshot {
  startUser: string
  queueSize: number
  visitedTotal: number
  inDegreeSize: number
  /** 累计请求数 */
  totalRequests: number
  /** 当前批内已处理数（批处理中轮询用） */
  inBatchProcessed: number
  /** 当前批目标数 */
  inBatchSize: number
  /** 当前批失败数 */
  inBatchFailed: number
  /** 连续 429 计数 */
  consecutive429: number
  /** 运行日志（环形，最近 N 条，判断是否卡住） */
  recentLog: string[]
  /** 当前会话入度表（按入度降序，前 200） */
  users: { username: string; inDegree: number }[]
  /** 入度表总人数 */
  userTotal: number
  /** 当前入度 Top5（username: 入度） */
  top: { username: string; inDegree: number }[]
}


/** buondua 图片（article-fulltext 内解析，宽高直接取自 img 属性） */
export interface BuonduaImage {
  url: string
  filename: string
  width?: number
  height?: number
}

/** buondua 相册链接（推荐/其他区块解析） */
export interface BuonduaLinkItem {
  url: string
  title: string
  coverUrl: string
  imageCount?: number
}

/** 批量抓取目标（url + 文件夹名） */
export interface BuonduaTarget {
  url: string
  folderName: string
}
