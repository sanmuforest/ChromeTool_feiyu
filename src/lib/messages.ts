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
} from './types'

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
  // ---- buondua 适配器（FP-004）：grabber → bg ----
  | { type: 'BD_FETCH_ALBUM'; srcTabId: number; url: string }
  | { type: 'BD_SCAN_LINKS'; srcTabId: number; url: string; kind: 'recommended' | 'popular' }
  | { type: 'BD_FETCH_ALBUMS'; srcTabId: number; targets: BuonduaTarget[] }
  // ---- buondua 适配器：bg → grabber 推送 ----
  | { type: 'BD_RESULT'; kind: BuonduaResultKind; data: BuonduaImage[] | BuonduaLinkItem[] | BuonduaBatchItem; done: boolean; error?: string }

export type ImgResultKind = 'album-images' | 'gallery' | 'gallery-range' | 'albums' | 'following'

export type BuonduaResultKind = 'album' | 'scan' | 'batch-item'

/** 批量抓取单个相册完成推送 */
export interface BuonduaBatchItem {
  index: number
  target: BuonduaTarget
  images: BuonduaImage[]
  pages: string[]
}

export type MessageResponse =
  | { ok: true; entries?: LogEntry[]; level?: LogLevel; session?: GrabSession; job?: DownloadJob; username?: string | null }
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
