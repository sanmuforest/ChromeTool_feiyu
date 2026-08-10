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

// ========== buondua 适配器（FP-004） ==========

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
