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
  // 手动星级评定（FP-015）：入度 Top 第 5 列点击评星，0 = 取消评星
  // autoCreate（FP-017）：库外用户标星时自动建条目（入度 0）
  | { type: 'IMG_DB_SET_STAR'; username: string; stars: number; autoCreate?: boolean }
  // 单人星级查询（FP-017 悬浮窗：只读单条，不返回全库排行）
  | { type: 'IMG_DB_GET_STAR'; username: string }
  // 标星悬浮窗注入开关（FP-017：按需授权 imgbb 域 + 动态注册 content script）
  | { type: 'STAR_OVERLAY_SET'; enabled: boolean }
  | { type: 'STAR_OVERLAY_STATUS' }
  | { type: 'IMG_TAG_GET'; topN?: number; minAlbums?: number; minUsers?: number; includeSlug?: boolean }
  // 标签云自定义词典与屏蔽词（FP-016）
  | { type: 'IMG_TAG_DICT_GET' }
  | { type: 'IMG_TAG_DICT_SAVE'; tagDict: unknown }
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
  // ---- 站内列表浏览（FP-023）：不依赖搜索引擎，直接遍历站点分类/列表页 ----
  // pageKind：界面手动指定列表页分页方式（2026-10-08 体检 P0-3）；缺省按定义/分页类型派生
  | {
      type: 'BD_FETCH_LIST'
      srcTabId: number
      siteId: string
      listUrl: string
      pages: number
      pageKind?: 'query' | 'path' | 'path-slash'
    }
  // ---- 多页图站聚合搜索（FP-010/096）：grabber → bg ----
  // startPage：每站起始页（默认 1）；「下一批」续搜时传上次结束页 +1，结果追加扩充
  // useGoogleAll：Google 全站搜索开关（FP-013 调整：开启后全部站点走 Google sitesearch 网页通道，仅标题+链接，速度快）
  // googleSites：Google 组站点（FP-014 修复：站内无结果的站强制走 Google，失败自动降级站内）
  | { type: 'BD_SEARCH'; srcTabId: number; query: string; sites: string[]; pagesPerSite: number; startPage?: number; useGoogleAll?: boolean; googleSites?: string[] }
  // ---- 聚合搜索：Google 连接测试（FP-012）：grabber → bg ----
  | { type: 'BD_TEST_GOOGLE'; srcTabId: number }
  // ---- buondua 适配器：bg → grabber 推送 ----
  | { type: 'BD_RESULT'; kind: BuonduaResultKind; data: BuonduaImage[] | BuonduaLinkItem[] | BuonduaBatchItem | SearchSiteResult; done: boolean; error?: string }
  // ---- 多页站点：bg → content 页面内 fetch（带 Cookie 穿透反爬，hitxhot 等） ----
  | { type: 'BD_FETCH_HTML'; url: string }
  // ---- 页面结构探测（FP-014 站点扩充）：grabber → bg，开标签执行提取并关闭 ----
  | { type: 'BD_PROBE_PAGE'; url: string }

export type ImgResultKind = 'album-images' | 'gallery' | 'gallery-range' | 'albums' | 'following'

export type BuonduaResultKind = 'album' | 'scan' | 'batch-item' | 'search' | 'search-site' | 'list'

/** 聚合搜索单站结果（BD_RESULT kind=search-site 的 data） */
export interface SearchSiteResult {
  siteId: string
  items: BuonduaLinkItem[]
}

/** 批量抓取单个相册完成推送（error 存在表示该相册抓取失败，096 增强） */
export interface BuonduaBatchItem {
  index: number
  target: BuonduaTarget
  images: BuonduaImage[]
  pages: string[]
  error?: string
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
      rankDegree?: { username: string; url: string; inDegree: number; starRating: number }[]
      rankAlbum?: { username: string; url: string; albumCount: number; inDegree: number; truncated?: boolean }[]
      /** 手动星级设置结果（FP-015：返回落库后的星级） */
      starRating?: number
      /** 单人星级与库内状态（FP-017 悬浮窗） */
      starInfo?: {
        username: string
        starRating: number
        inDegree: number
        albumCount?: number
        albumsChecked: boolean
        inLibrary: boolean
      }
      /** 标星悬浮窗状态（FP-017） */
      overlay?: { enabled: boolean; registered: boolean }
      full?: { username: string; albumCount: number; truncated: boolean }
      cancelled?: boolean
      tags?: import('./tag-extract').TagStat[]
      /** 自定义标签词典与屏蔽词（FP-016） */
      tagDict?: import('./tag-extract').TagCustomDict
      score?: ScoreBatchResult
      search?: SearchBatchResult
      unconfirmed?: number
      config?: { repo: string; branch: string; configured: boolean }
      github?: { message: string; total?: number }
      json?: string
      // ---- 聚合搜索 Google 连接测试（FP-012） ----
      google?: {
        ok: boolean
        status?: number
        blocked: boolean
        ms: number
        error?: string
        /** 返回页诊断特征（089-091 增强）：长度/标题/是否含可解析结果/同意页/meta refresh/0 结果文案/跳数/可见文本预览 */
        diag?: {
          len: number
          title: string
          hasH3: boolean
          isConsent: boolean
          hasMetaRefresh: boolean
          hasNoResultText: boolean
          hops: number
          bodyPreview: string
        }
      }
      // ---- 页面结构探测（FP-014） ----
      probe?: PageProbeResult
    }
  | { ok: false; error: string }

/** 页面结构探测结果（FP-014 站点扩充：适配新站前先探测结构） */
export interface PageProbeResult {
  title: string
  url: string
  ogImage: string
  /** 图片 src 样本（最多 40，去重） */
  imgSrcs: string[]
  /** 图片祖先容器 class 候选（按出现次数降序） */
  containerCandidates: { cls: string; n: number }[]
  /** 分页链接样本 */
  pagination: { href: string; text: string }[]
  /** 按图片 host 分组（2026-10-11 新增，新站适配主力依据）：
   *  旧字段把站点 logo/图标与正文图混在一起（样本常被 logo 占满），且容器候选只统计「有 class 的父元素」，
   *  遇到正文图父级无 class 或分页为 `N.html` 形态时会完全看不出结构 */
  imageGroups?: {
    host: string
    count: number
    samples: string[]
    /** 代表图向上 5 层的 `tag.class` 链（最能指示正文容器） */
    chains: string[][]
  }[]
  /** 疑似分页链接（2026-10-11 新增）：覆盖 `N.html` / `?page=N` / `/page/N` 等任意形态 */
  pageLinks?: string[]
  /** `img[data-src]` 数量（判断 lazy load：真图在 data-src 而非 src） */
  lazyCount?: number
}

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
