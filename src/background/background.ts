// Background Service Worker（MV3）
// 职责（FP-002）：
// 1. 日志唯一写入者（FP-001 保留）
// 2. 抓取会话管理：srcTabId ↔ grabTabId 映射，页面关闭自动清理
// 3. 消息路由：content 上报 → 路由给对应 grabber；grabber 控制 → 转发给 content
// 4. 下载队列管理（DownloadManager）
// 注意：SW 生命周期短、无 DOM，状态持久化到 chrome.storage（内存 Map 可重建）

import { DownloadManager, arrayBufferToBase64, fetchImageBytes, fetchImgbbViaSrcTab } from '../lib/downloader'
import { DiffuseEngine } from './imgbb-diffuse'
import { emptyDb, loadDb, mergeInDegree, mergeDb, dbSummary, inDegreeDist, unconfirmedCandidates, unconfirmedCount, confirmedScored, matchAlbums, scoreTop, degreeTop, albumTop, resetConfirmations, PRODUCER_DB_KEY } from '../lib/producer-db'
import { normalizeConfig, pullDb, pushDb, GITHUB_CONFIG_KEY } from '../lib/github-sync'
import { computeTags } from '../lib/tag-extract'
import type { GithubConfig } from '../lib/github-sync'
import { parseAlbumItems, parseAlbumNextPage } from '../lib/imgbb-parse'
import type { ProducerDb } from '../lib/producer-db'
import { appendLog, clearEntries, getEntries, getLevel, initLogger, setLevel } from '../lib/logger'
import { sendToTab, type ImgResultKind, type Message, type MessageResponse } from '../lib/messages'
import { storageGet, storageSet } from '../lib/storage'
import type { GrabSession, ImgbbAlbum, ImgbbFollowingUser, ImgbbImage } from '../lib/types'
import { ImgbbService } from './imgbb-service'
import { BuonduaService } from './buondua-service'
import { FreeimageService } from './freeimage-service'
import { FhDiffuseEngine } from './freeimage-diffuse'
import { extractOwner, isChineseAlbum, parseExploreUsers } from '../lib/freeimage-parse'
import { emptyFhProducerDb, loadFhProducerDb } from '../lib/freeimage-types'
import type { FhProducerDb } from '../lib/freeimage-types'
import { emptyFhAlbumIndexDb, loadFhAlbumIndexDb } from '../lib/freeimage-types'
import type { FhAlbumIndexDb } from '../lib/freeimage-types'
import type { FhOwner } from '../lib/freeimage-types'

const logger = initLogger('background')

// ---------- 会话管理 ----------

const sessions = new Map<number, GrabSession>() // key: srcTabId

function buildFolderName(title: string): string {
  const cleanTitle = cleanPageTitle(title).replace(/[\\/:*?"<>|\n\r]/g, '_').trim().slice(0, 120) || '页面'
  return cleanTitle
}

/** 清理页面标题中的常见站点后缀（主抓取页签文件夹/相册名用） */
function cleanPageTitle(title: string): string {
  return title
    .replace(/\s*[-—–]\s*ImgBB\s*$/i, '')
    .replace(/\s*[-–—]\s*Buondua\s*$/i, '')
    .replace(/\s*\|\s*(?:Page\s+\d+\s*\/\s*\d+|第\s*\d+\s*\/\s*\d+\s*页)\s*$/i, '')
    .trim()
}

// ---------- 下载 ----------

const downloadManager = new DownloadManager({
  onUpdate: (job, done) => {
    const session = sessions.get(job.srcTabId)
    const grabTabId = session?.grabTabId
    if (!grabTabId) return
    void sendToTab(grabTabId, done ? { type: 'GRAB_DOWNLOAD_DONE', job } : { type: 'GRAB_DOWNLOAD_PROGRESS', job })
  },
})

// 启动时恢复用户设置的下载并发（SW 重启后保持）
void storageGet<number>('dl_concurrency').then((n) => {
  if (typeof n === 'number' && n > 0) downloadManager.setConcurrency(n)
})

// 启动时恢复生产者库（SW 重启后保持，FP-005）
// 注意：恢复是异步的，所有使用 producerDb 的消息分支必须先 await producerDbReady（防导出/检索读到空库）
// （producerDbReady 定义在 producerDb 声明之后，见扩散引擎区块）

chrome.downloads.onChanged.addListener((delta) => {
  downloadManager.handleChanged(delta)
})

// ---------- imgbb 适配器服务（FP-003） ----------

const imgbb = new ImgbbService()
/** 关注墙用户列表缓存（按 用户名|方向 缓存，避免每批重复抓取） */
const followingUsersCache = new Map<string, import('../lib/types').ImgbbUser[]>()

/** 遍历用户全部相册分页（返回相册列表 + 是否因页数上限截断） */
async function fetchUserAlbums(
  username: string,
  maxPages: number,
): Promise<{ albums: import('../lib/types').ImgbbAlbum[]; truncated: boolean }> {
  const all: import('../lib/types').ImgbbAlbum[] = []
  const seen = new Set<string>()
  let url: string | null = `https://${username}.imgbb.com/albums`
  let page = 0
  while (url && page < maxPages) {
    const html = await imgbb.fetchHtml(url)
    const items = parseAlbumItems(html)
    for (const a of items) {
      if (!seen.has(a.id)) {
        seen.add(a.id)
        all.push(a)
      }
    }
    const next = parseAlbumNextPage(html, `https://${username}.imgbb.com/albums`)
    if (!next || next === url || items.length === 0) break
    url = next
    page++
  }
  return { albums: all, truncated: url !== null && page >= maxPages }
}

const SCORE_MAX_PAGES = 20 // 常规确认页数上限（截断后点相册数可彻底遍历）
const SCORE_FULL_MAX_PAGES = 300 // 单用户彻底遍历上限
/** 确认批内停止标志（IMG_SCORE_STOP 设置，worker 检测后中断） */
let scoreBatchCancelled = false

// ---------- 扩散引擎 + 生产者库（FP-005） ----------

const diffuse = new DiffuseEngine()
let producerDb: ProducerDb = emptyDb()
/** 生产者库就绪（SW 启动时从 storage 异步恢复；各分支先 await 防读空库） */
const producerDbReady = (async (): Promise<void> => {
  const raw = await storageGet<unknown>(PRODUCER_DB_KEY)
  producerDb = loadDb(raw)
  logger.info('diffuse', '生产者库已恢复', { total: Object.keys(producerDb.entries).length })
})()
/** 扩散状态持久化键（storage.session：SW 休眠/重启不丢，不写磁盘） */
const DIFFUSE_STATE_KEY = 'diffuse_state'

/** 消息处理前恢复扩散状态（SW 重启后续跑） */
async function ensureDiffuseRestored(): Promise<void> {
  try {
    const r = await chrome.storage.session.get(DIFFUSE_STATE_KEY)
    const state = r[DIFFUSE_STATE_KEY] as import('./imgbb-diffuse').DiffusePersistState | undefined
    if (state && Array.isArray(state.queue) && !diffuse.isActive()) {
      diffuse.restore(state)
      logger.info('diffuse', '扩散状态已从 session 恢复', { queueSize: state.queue.length, visited: state.visited.length })
    }
  } catch {
    // session 存储不可用（极端情况）静默，下次扩散重新开始
  }
}

/** 扩散状态持久化 */
async function saveDiffuseState(): Promise<void> {
  try {
    await chrome.storage.session.set({ [DIFFUSE_STATE_KEY]: diffuse.save() })
  } catch {
    // 忽略：session 存储失败不影响运行
  }
}

// ---------- freeimage 适配器服务（FP-007） ----------

const freeimage = new FreeimageService()
/** freeimage 类群标注库（fh_producer_db，持久化） */
let fhProducerDb: FhProducerDb = emptyFhProducerDb()
const FH_PRODUCER_DB_KEY = 'fh_producer_db'
/** 标注库就绪（SW 启动时从 storage 异步恢复） */
const fhProducerDbReady = (async (): Promise<void> => {
  const raw = await storageGet<unknown>(FH_PRODUCER_DB_KEY)
  fhProducerDb = loadFhProducerDb(raw)
  logger.info('freeimage', '类群标注库已恢复', { total: Object.keys(fhProducerDb.entries).length })
})()

/** freeimage 结果数据类型（FH_RESULT data 联合） */
type FhResultData =
  | import('../lib/freeimage-types').FhImage[]
  | import('../lib/freeimage-types').FhAlbum[]
  | import('../lib/freeimage-types').FhOwner[]
  | import('../lib/messages').ScanAlbumEntry[]
  | import('../lib/messages').ExploreSearchProgress

/** 向指定抓取页推送 freeimage 结果 */
async function pushFhResult(
  srcTabId: number,
  kind: import('../lib/messages').FhResultKind,
  data: FhResultData,
  done: boolean,
  error?: string,
): Promise<void> {
  const session = sessions.get(srcTabId)
  if (!session) return
  await sendToTab(session.grabTabId, { type: 'FH_RESULT', kind, data, done, error })
}

/** 探索检索批次执行（START/NEXT 共用）：抓取 → 合并入索引库（每轮持久化保存）→ 推送进度 */
async function runSearchBatch(
  srcTabId: number,
  mode: import('../lib/messages').FhExploreMode,
  list: import('../lib/messages').FhExploreType,
  rounds: number,
  intervalMs: number,
  chineseOnly?: boolean,
): Promise<void> {
  await fhAlbumIndexReady
  const onRound = async (progress: import('../lib/messages').ExploreSearchProgress): Promise<void> => {
    let added = 0
    for (const e of progress.newEntries) {
      // 仅中文模式：非中文相册跳过（无用信息过滤）
      if (chineseOnly && !isChineseAlbum(e.name)) continue
      const existing = fhAlbumIndex.entries[e.id]
      if (!existing) {
        fhAlbumIndex.entries[e.id] = e
        added++
      } else {
        fhAlbumIndex.entries[e.id] = { ...existing, ...e, name: existing.name, collectedAt: existing.collectedAt }
      }
    }
    fhAlbumIndex.updatedAt = Date.now()
    await storageSet(FH_ALBUM_INDEX_KEY, fhAlbumIndex)
    const total = Object.keys(fhAlbumIndex.entries).length
    await pushFhResult(srcTabId, 'explore-search', { ...progress, added, total }, false)
  }
  try {
    const { more } = await freeimage.runSearchBatch(rounds, intervalMs, onRound)
    await pushFhResult(
      srcTabId,
      'explore-search',
      {
        round: rounds,
        pageFrom: 0,
        pageTo: 0,
        added: 0,
        total: Object.keys(fhAlbumIndex.entries).length,
        newEntries: [],
        mode,
        type: list,
        more,
      },
      true,
    )
  } catch (err) {
    logger.error('freeimage', '探索检索批次失败', String(err))
    await pushFhResult(
      srcTabId,
      'explore-search',
      {
        round: 0,
        pageFrom: 0,
        pageTo: 0,
        added: 0,
        total: Object.keys(fhAlbumIndex.entries).length,
        newEntries: [],
        mode,
        type: list,
        more: false,
      },
      true,
      String(err),
    )
  }
}

// ---------- 相册索引记录库（FP-007 场景 D：仅文字信息） ----------

let fhAlbumIndex: FhAlbumIndexDb = emptyFhAlbumIndexDb()
const FH_ALBUM_INDEX_KEY = 'fh_album_index'
/** 索引库就绪（SW 启动时从 storage 异步恢复） */
const fhAlbumIndexReady = (async (): Promise<void> => {
  const raw = await storageGet<unknown>(FH_ALBUM_INDEX_KEY)
  fhAlbumIndex = loadFhAlbumIndexDb(raw)
  logger.info('freeimage', '相册索引库已恢复', { total: Object.keys(fhAlbumIndex.entries).length })
})()

// ---------- freeimage 扩散引擎 + 生产者库（FP-007 迁移 imgbb FP-005） ----------

const fhDiffuse = new FhDiffuseEngine()
let fhDiffuseDb: ProducerDb = emptyDb()
const FH_DIFFUSE_DB_KEY = 'fh_diffuse_db'
/** 生产者库就绪（SW 启动时从 storage 异步恢复） */
const fhDiffuseDbReady = (async (): Promise<void> => {
  const raw = await storageGet<unknown>(FH_DIFFUSE_DB_KEY)
  fhDiffuseDb = loadDb(raw)
  logger.info('freeimage', 'freeimage 生产者库已恢复', { total: Object.keys(fhDiffuseDb.entries).length })
})()
/** 扩散状态持久化键（storage.session） */
const FH_DIFFUSE_STATE_KEY = 'fh_diffuse_state'
/** 评分批内停止标志 */
let fhScoreBatchCancelled = false

/** 恢复扩散状态（SW 重启后续跑） */
async function ensureFhDiffuseRestored(): Promise<void> {
  try {
    const r = await chrome.storage.session.get(FH_DIFFUSE_STATE_KEY)
    const state = r[FH_DIFFUSE_STATE_KEY] as import('./freeimage-diffuse').FhDiffusePersistState | undefined
    if (state && Array.isArray(state.queue) && !fhDiffuse.isActive()) {
      fhDiffuse.restore(state)
      logger.info('freeimage', '扩散状态已从 session 恢复', { queueSize: state.queue.length, visited: state.visited.length })
    }
  } catch {
    // session 存储不可用静默
  }
}

/** 保存扩散状态 */
async function saveFhDiffuseState(): Promise<void> {
  try {
    await chrome.storage.session.set({ [FH_DIFFUSE_STATE_KEY]: fhDiffuse.save() })
  } catch {
    // 忽略
  }
}

/** 遍历 freeimage 用户全部相册分页（相册确认评分用） */
async function fhFetchUserAlbums(
  username: string,
  maxPages: number,
): Promise<{ albums: import('../lib/freeimage-types').FhAlbum[]; truncated: boolean }> {
  const all: import('../lib/freeimage-types').FhAlbum[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= maxPages; page++) {
    try {
      const albums = await freeimage.fetchAlbumsPage(username, 'views_desc', page)
      let added = 0
      for (const a of albums) {
        if (!seen.has(a.id)) {
          seen.add(a.id)
          all.push(a)
          added++
        }
      }
      if (albums.length === 0 || added === 0) break
    } catch (err) {
      logger.warn('freeimage', '用户相册遍历失败（截断）', { username, page, error: String(err) })
      return { albums: all, truncated: true }
    }
  }
  return { albums: all, truncated: false }
}

/** freeimage 关注墙用户抓取（/followers + /following 用户项，去重） */
async function fetchFhFollowingUsers(username: string, side: 'following' | 'followers' | 'both'): Promise<FhOwner[]> {
  const urls: string[] = []
  if (side === 'following' || side === 'both') {
    urls.push(`https://freeimage.host/${encodeURIComponent(username)}/following`)
  }
  if (side === 'followers' || side === 'both') {
    urls.push(`https://freeimage.host/${encodeURIComponent(username)}/followers`)
  }
  const htmls = await Promise.all(urls.map((u) => freeimage.fetchHtml(u)))
  const users = htmls.flatMap((h) => parseExploreUsers(h))
  const seen = new Set<string>()
  return users.filter((u) => {
    if (seen.has(u.username)) return false
    seen.add(u.username)
    return true
  })
}

// ---------- buondua 适配器服务（FP-004） ----------

const buondua = new BuonduaService()

/** 向指定抓取页推送 imgbb 分析结果 */
async function pushImgbbResult(
  srcTabId: number,
  kind: ImgResultKind,
  data: ImgbbImage[] | ImgbbAlbum[] | ImgbbFollowingUser[],
  done: boolean,
  error?: string,
): Promise<void> {
  const session = sessions.get(srcTabId)
  if (!session) return
  await sendToTab(session.grabTabId, { type: 'IMG_RESULT', kind, data, done, error })
}

/** 获取 srcTabId 对应抓取页 tabId（无会话返回 0，sendToTab 静默失败） */
function sessionOf(srcTabId: number): number {
  return sessions.get(srcTabId)?.grabTabId ?? 0
}

/** 发送消息到指定 tab 并等待响应（content 页面内 fetch 用），失败返回 undefined */
async function sendToTabAndGet<T>(tabId: number, message: Message): Promise<T | undefined> {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T
  } catch {
    return undefined
  }
}

// ---------- action 点击：创建抓取页 ----------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
    logger.warn('action', '无法抓取该页面（非 http(s) 页面）', { url: tab.url })
    return
  }
  try {
    const grabTab = await chrome.tabs.create({
      url: `grabber.html?srcTabId=${tab.id}`,
      index: (tab.index ?? 0) + 1,
    })
    logger.info('action', '已创建抓取页', { srcTabId: tab.id, grabTabId: grabTab.id })
  } catch (err) {
    logger.error('action', '创建抓取页失败', { error: String(err) })
  }
})

// ---------- tab 关闭清理 ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  const session = sessions.get(tabId)
  if (session) {
    sessions.delete(tabId)
    logger.info('session', '源网页关闭，清理会话', { srcTabId: tabId })
    if (session.grabTabId && session.grabTabId !== tabId) {
      void sendToTab(session.grabTabId, { type: 'GRAB_SESSION_END_FWD', srcTabId: tabId })
    }
  }
  for (const [srcTabId, s] of sessions) {
    if (s.grabTabId === tabId) {
      sessions.delete(srcTabId)
      logger.info('session', '抓取页关闭，清理会话', { srcTabId, grabTabId: tabId })
    }
  }
})

// ---------- 生命周期日志 ----------

chrome.runtime.onInstalled.addListener((details) => {
  logger.info('runtime', '插件已安装/更新', { reason: details.reason, version: chrome.runtime.getManifest().version })
})

chrome.runtime.onStartup.addListener(() => {
  logger.info('runtime', '浏览器启动，SW 唤醒')
})

// ---------- 消息处理器 ----------

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  void handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      logger.error('msg-handler', '消息处理失败', { type: message.type, error: String(err) })
      sendResponse({ ok: false, error: String(err) })
    })
  return true // 异步响应
})

async function handleMessage(message: Message, sender: chrome.runtime.MessageSender): Promise<MessageResponse> {
  switch (message.type) {
    // ---- 日志（FP-001）----
    case 'LOG_ADD':
      await appendLog(message.context, message.level, message.module, message.message, message.data)
      return { ok: true }
    case 'LOG_GET':
      return { ok: true, entries: await getEntries() }
    case 'LOG_CLEAR':
      await clearEntries()
      return { ok: true }
    case 'LOG_SET_LEVEL':
      await setLevel(message.level)
      return { ok: true, level: message.level }
    case 'LOG_GET_LEVEL':
      return { ok: true, level: await getLevel() }

    // ---- 会话 ----
    case 'GRAB_SESSION_CREATE': {
      const srcTab = await chrome.tabs.get(message.srcTabId).catch(() => undefined)
      if (!srcTab?.url || !/^https?:\/\//.test(srcTab.url)) {
        return { ok: false, error: '源网页不可用（已关闭或非 http 页面）' }
      }
      const url = new URL(srcTab.url)
      const existing = sessions.get(message.srcTabId)
      const session: GrabSession = existing ?? {
        srcTabId: message.srcTabId,
        grabTabId: message.grabTabId,
        title: cleanPageTitle(srcTab.title || url.host),
        host: url.host,
        url: srcTab.url,
        folderName: '',
        status: 'idle',
      }
      session.grabTabId = message.grabTabId
      session.url = srcTab.url
      if (!session.folderName) {
        session.folderName = buildFolderName(session.title)
      }
      sessions.set(message.srcTabId, session)
      logger.info('session', '会话已注册', { srcTabId: session.srcTabId, grabTabId: session.grabTabId, folderName: session.folderName })
      return { ok: true, session }
    }

    // ---- 解析控制：grabber → bg ----
    case 'GRAB_PARSE_START': {
      const srcTabId = message.srcTabId
      if (srcTabId === undefined) return { ok: false, error: '缺少 srcTabId' }
      const session = sessions.get(srcTabId)
      if (!session) return { ok: false, error: '会话不存在' }
      session.status = 'parsing'
      try {
        await chrome.scripting.executeScript({
          target: { tabId: srcTabId },
          files: ['js/content.js'],
        })
        await sendToTab(srcTabId, { type: 'GRAB_PARSE_START' })
        logger.info('parse', '解析已启动', { srcTabId })
      } catch (err) {
        session.status = 'error'
        logger.error('parse', '注入解析器失败', { srcTabId, error: String(err) })
        await sendToTab(session.grabTabId, {
          type: 'GRAB_PARSE_ERROR_FWD',
          srcTabId,
          error: String(err),
        })
      }
      return { ok: true }
    }

    case 'GRAB_PARSE_CANCEL': {
      const srcTabId = message.srcTabId
      if (srcTabId === undefined) return { ok: false, error: '缺少 srcTabId' }
      const session = sessions.get(srcTabId)
      if (session) {
        session.status = 'idle'
      }
      await sendToTab(srcTabId, { type: 'GRAB_PARSE_CANCEL' })
      logger.info('parse', '请求取消解析', { srcTabId })
      return { ok: true }
    }

    case 'GRAB_LOAD_MORE': {
      const srcTabId = message.srcTabId
      if (srcTabId === undefined) return { ok: false, error: '缺少 srcTabId' }
      const session = sessions.get(srcTabId)
      if (!session) return { ok: false, error: '会话不存在' }
      session.status = 'parsing'
      await sendToTab(srcTabId, { type: 'GRAB_LOAD_MORE' })
      logger.info('parse', '请求加载下一批', { srcTabId })
      return { ok: true }
    }

    // ---- 解析上报：content → bg（按 sender.tab.id 路由到 grabber）----
    case 'GRAB_PARSE_BATCH': {
      const srcTabId = sender.tab?.id
      if (srcTabId === undefined) return { ok: false, error: '无法识别消息来源' }
      const session = sessions.get(srcTabId)
      if (!session) return { ok: false, error: '会话不存在' }
      await sendToTab(session.grabTabId, {
        type: 'GRAB_PARSE_BATCH_FWD',
        srcTabId,
        images: message.images,
        total: message.total,
        scanned: message.scanned,
      })
      return { ok: true }
    }

    case 'GRAB_PARSE_DONE': {
      const srcTabId = sender.tab?.id
      if (srcTabId === undefined) return { ok: false, error: '无法识别消息来源' }
      const session = sessions.get(srcTabId)
      if (!session) return { ok: false, error: '会话不存在' }
      session.status = message.cancelled ? 'idle' : 'idle'
      await sendToTab(session.grabTabId, {
        type: 'GRAB_PARSE_DONE_FWD',
        srcTabId,
        cancelled: message.cancelled,
        reachedLimit: message.reachedLimit,
      })
      return { ok: true }
    }

    case 'GRAB_PARSE_ERROR': {
      const srcTabId = sender.tab?.id
      if (srcTabId === undefined) return { ok: false, error: '无法识别消息来源' }
      const session = sessions.get(srcTabId)
      if (!session) return { ok: false, error: '会话不存在' }
      session.status = 'error'
      await sendToTab(session.grabTabId, { type: 'GRAB_PARSE_ERROR_FWD', srcTabId, error: message.error })
      return { ok: true }
    }

    // ---- 下载 ----
    case 'GRAB_DOWNLOAD_START': {
      const job = downloadManager.start(message.srcTabId, message.folderName, message.items)
      logger.info('download', '下载任务启动', { jobId: job.id, total: job.total, folderName: job.folderName })
      return { ok: true, job }
    }
    case 'GRAB_DOWNLOAD_CANCEL':
      downloadManager.cancel(message.jobId)
      return { ok: true }
    case 'GRAB_DOWNLOAD_RETRY':
      downloadManager.retry(message.jobId)
      return { ok: true }
    case 'GRAB_DOWNLOAD_GET': {
      const job = downloadManager.get(message.jobId)
      return job ? { ok: true, job } : { ok: false, error: '任务不存在' }
    }
    case 'GRAB_OPEN_FOLDER':
      chrome.downloads.showDefaultFolder()
      return { ok: true }

    // ---- 打包下载：background 抓取图片字节（imgbb 防降级） ----
    // 降级链：源页注入（imgbb 域页面 MAIN world，Referer=页面URL 放行原图）→ background fetch（现可能 180）
    case 'GRAB_FETCH_IMAGE': {
      try {
        let buf: ArrayBuffer
        if (message.srcTabId) {
          try {
            buf = await fetchImgbbViaSrcTab(message.srcTabId, message.url)
            logger.debug('download', 'GRAB_FETCH_IMAGE 源页注入抓取完成', { bytes: buf.byteLength, url: message.url })
          } catch (err) {
            logger.warn('download', 'GRAB_FETCH_IMAGE 源页注入失败，降级 background', { url: message.url, error: String(err) })
            buf = await fetchImageBytes(message.url)
          }
        } else {
          buf = await fetchImageBytes(message.url)
        }
        // runtime message 为 JSON 序列化，ArrayBuffer 会丢失（实测变空对象）→ 必须 base64 字符串回传
        return { ok: true, data: arrayBufferToBase64(buf) }
      } catch (err) {
        logger.warn('download', 'GRAB_FETCH_IMAGE 抓取失败', { url: message.url, error: String(err) })
        return { ok: false, error: String(err) }
      }
    }

    // ---- 下载并发设置 ----
    case 'GRAB_SET_CONCURRENCY': {
      downloadManager.setConcurrency(message.concurrency)
      await storageSet('dl_concurrency', downloadManager.getConcurrency())
      return { ok: true, concurrency: downloadManager.getConcurrency() }
    }
    case 'GRAB_GET_CONCURRENCY':
      return { ok: true, concurrency: downloadManager.getConcurrency() }

    // ---- imgbb 适配器（FP-003） ----
    case 'IMG_RESOLVE_USER': {
      try {
        const username = await imgbb.resolveUsernameFromAlbum(message.albumUrl)
        logger.info('imgbb', '相册用户名解析完成', { albumUrl: message.albumUrl, username })
        return { ok: true, username }
      } catch (err) {
        logger.error('imgbb', '相册用户名解析失败', String(err))
        return { ok: false, error: String(err) }
      }
    }

    case 'IMG_GET_ALBUM_IMAGES': {
      try {
        const { images, name } = await imgbb.fetchAlbumImages(message.albumUrl)
        await pushImgbbResult(message.srcTabId, 'album-images', images, true)
        return { ok: true, name: name || undefined }
      } catch (err) {
        logger.error('imgbb', '相册抓取失败', String(err))
        await pushImgbbResult(message.srcTabId, 'album-images', [], true, String(err))
        return { ok: false, error: String(err) }
      }
    }

    case 'IMG_FETCH_GALLERY': {
      try {
        const images = await imgbb.fetchGalleryPages(message.url, message.pageFrom, message.pageTo)
        await pushImgbbResult(message.srcTabId, 'gallery', images, true)
      } catch (err) {
        logger.error('imgbb', '用户主页抓取失败', String(err))
        await pushImgbbResult(message.srcTabId, 'gallery', [], true, String(err))
      }
      return { ok: true }
    }

    case 'IMG_FETCH_GALLERY_RANGE': {
      try {
        // 按文件名编号范围：抓前 N 页后按前缀+编号过滤
        const all = await imgbb.fetchGalleryPages(message.url, 1, 60)
        const filtered = all.filter((img) => {
          const m = img.filename.match(new RegExp(`^${message.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`))
          if (!m) return false
          const n = Number(m[1])
          return n >= message.from && n <= message.to
        })
        logger.info('imgbb', '编号范围抓取完成', { prefix: message.prefix, from: message.from, to: message.to, count: filtered.length, scanned: all.length })
        await pushImgbbResult(message.srcTabId, 'gallery-range', filtered, true)
      } catch (err) {
        logger.error('imgbb', '编号范围抓取失败', String(err))
        await pushImgbbResult(message.srcTabId, 'gallery-range', [], true, String(err))
      }
      return { ok: true }
    }

    case 'IMG_ANALYZE_ALBUMS': {
      try {
        const albums = await imgbb.fetchAlbumsPage(message.username, message.page)
        await pushImgbbResult(message.srcTabId, 'albums', albums, true)
      } catch (err) {
        logger.error('imgbb', '相册分析失败', String(err))
        await pushImgbbResult(message.srcTabId, 'albums', [], true, String(err))
      }
      return { ok: true }
    }

    case 'IMG_ANALYZE_FOLLOWING': {
      try {
        const cacheKey = `${message.username}|${message.side}`
        if (message.batchStart === 0 || !followingUsersCache.has(cacheKey)) {
          followingUsersCache.set(cacheKey, await imgbb.fetchFollowingUsers(message.username, message.side))
        }
        const allUsers = followingUsersCache.get(cacheKey) ?? []
        const batch = allUsers.slice(message.batchStart, message.batchStart + message.batchSize)
        const results = await imgbb.analyzeFollowingBatch(batch, message.batchSize)
        const done = message.batchStart + message.batchSize >= allUsers.length
        await pushImgbbResult(
          message.srcTabId,
          'following',
          results,
          done,
          done && results.length === 0 ? '无更多有效用户' : undefined,
        )
      } catch (err) {
        logger.error('imgbb', '关注墙分析失败', String(err))
        await pushImgbbResult(message.srcTabId, 'following', [], true, String(err))
      }
      return { ok: true }
    }

    // ---- 扩散检索（FP-005） ----
    case 'IMG_DIFFUSE_START': {
      diffuse.start(message.startUser)
      await saveDiffuseState()
      return { ok: true, snapshot: diffuse.snapshot() }
    }
    case 'IMG_DIFFUSE_BATCH': {
      await ensureDiffuseRestored()
      await producerDbReady
      if (diffuse.is429Throttled) {
        logger.warn('diffuse', '连续 429，已阻止继续扩散，请稍后再试')
        return { ok: false, error: '连续 429 限流，请等待 30 秒后再继续' }
      }
      const result = await diffuse.processBatch(message.batchSize, message.concurrency, message.intervalMs)
      await saveDiffuseState()
      const snapshot = diffuse.snapshot()
      // 本批入度增量立即合并入本地库（起点 = 本次起点用户）并持久化（防 SW 重启丢失）
      if (Object.keys(result.inDegreeDelta).length > 0) {
        producerDb = mergeInDegree(producerDb, result.inDegreeDelta, snapshot.startUser)
        await storageSet(PRODUCER_DB_KEY, producerDb)
      }
      return { ok: true, result, snapshot }
    }
    case 'IMG_DIFFUSE_PROGRESS': {
      await ensureDiffuseRestored()
      return { ok: true, snapshot: diffuse.snapshot() }
    }
    case 'IMG_DB_GET': {
      await producerDbReady
      const sum = dbSummary(producerDb)
      const dist = inDegreeDist(producerDb)
      const w1 = message.w1 ?? 0.6
      const topN = message.topN ?? 100
      const rankScore = scoreTop(producerDb, topN, w1, 1 - w1)
      const rankDegree = degreeTop(producerDb, topN)
      const rankAlbum = albumTop(producerDb, topN)
      return {
        ok: true,
        db: producerDb,
        total: sum.total,
        confirmed: sum.confirmed,
        producers: sum.producers,
        maxInDegree: sum.maxInDegree,
        dist,
        rankScore,
        rankDegree,
        rankAlbum,
      }
    }
    case 'IMG_DB_SAVE': {
      await producerDbReady
      await storageSet(PRODUCER_DB_KEY, producerDb)
      const sum = dbSummary(producerDb)
      logger.info('diffuse', '生产者库已保存', { total: sum.total, source: message.source })
      return { ok: true, total: sum.total, confirmed: sum.confirmed, producers: sum.producers, maxInDegree: sum.maxInDegree }
    }
    case 'IMG_DB_CLEAR': {
      await producerDbReady
      producerDb = emptyDb()
      await storageSet(PRODUCER_DB_KEY, producerDb)
      logger.info('diffuse', '生产者库已清空')
      return { ok: true, total: 0 }
    }
    case 'IMG_DB_EXPORT': {
      await producerDbReady
      return { ok: true, json: JSON.stringify(producerDb, null, 1) }
    }
    case 'IMG_DB_RESET_CONFIRM': {
      await producerDbReady
      producerDb = resetConfirmations(producerDb)
      await storageSet(PRODUCER_DB_KEY, producerDb)
      logger.info('diffuse', '确认状态已重置（保留入度），需重新确认评分')
      return { ok: true, total: Object.keys(producerDb.entries).length }
    }
    case 'IMG_TAG_GET': {
      await producerDbReady
      const tags = computeTags(Object.values(producerDb.entries), message.topN ?? 100)
      logger.info('tag', '标签云统计完成', { tags: tags.length, topN: message.topN ?? 100 })
      return { ok: true, tags }
    }
    case 'IMG_DB_IMPORT': {
      await producerDbReady
      const imported = loadDb(message.db)
      const before = Object.keys(producerDb.entries).length
      producerDb = mergeDb(producerDb, imported)
      await storageSet(PRODUCER_DB_KEY, producerDb)
      const after = Object.keys(producerDb.entries).length
      const sum = dbSummary(producerDb)
      logger.info('diffuse', '数据表已导入合并', { before, after, imported: Object.keys(imported.entries).length })
      return {
        ok: true,
        total: after,
        confirmed: sum.confirmed,
        producers: sum.producers,
        maxInDegree: sum.maxInDegree,
        github: { message: `导入合并：${before} → ${after}` },
      }
    }

    // ---- 确认+评分（FP-005 模块 2）：抓 albums 补相册名 → 回写库 ----
    case 'IMG_SCORE_BATCH': {
      await producerDbReady
      scoreBatchCancelled = false
      const candidates = unconfirmedCandidates(producerDb, message.batchSize, message.order ?? 'inDegree', message.w1, message.w2)
      if (candidates.length === 0) {
        return { ok: true, score: { processed: 0, withAlbums: 0, zeroAlbums: 0, failed: 0, done: true } }
      }
      let withAlbums = 0
      let zeroAlbums = 0
      let failed = 0
      let cursor = 0
      const updated: Record<string, import('../lib/types').ProducerEntry> = {}
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor++
          if (idx >= candidates.length) return
          const c = candidates[idx]
          await sleep(message.intervalMs)
          try {
            const { albums: userAlbums, truncated } = await fetchUserAlbums(c.username, SCORE_MAX_PAGES)
            updated[c.username] = {
              ...c,
              albumCount: userAlbums.length,
              albumsChecked: true,
              albumsTruncated: truncated || undefined,
              albums: userAlbums.map((a) => ({ name: a.name, url: a.url })),
            }
            if (userAlbums.length > 0) withAlbums++
            else zeroAlbums++
            // 逐个推送进度（确认一个更新一个）
            const session = sessions.get(message.srcTabId)
            if (session) {
              await sendToTab(session.grabTabId, {
                type: 'IMG_SCORE_PROGRESS_FWD',
                done: withAlbums + zeroAlbums + failed,
                total: candidates.length,
                username: c.username,
                albumCount: userAlbums.length,
                truncated: truncated || undefined,
                failed,
                cancelled: scoreBatchCancelled || undefined,
              })
            }
          } catch (err) {
            failed++
            logger.warn('score', 'albums 确认失败（跳过）', { user: c.username, error: String(err) })
          }
          if (scoreBatchCancelled) return // 用户点停止 → 中断整批
        }
      }
      await Promise.all(Array.from({ length: Math.min(message.concurrency, candidates.length) }, () => worker()))
      const entries = { ...producerDb.entries }
      for (const [u, e] of Object.entries(updated)) entries[u] = e
      producerDb = { ...producerDb, updatedAt: Date.now(), entries }
      // 持久化：防 SW 重启丢失确认数据（此前仅存内存导致检索 0 候选）
      await storageSet(PRODUCER_DB_KEY, producerDb)
      const unconfirmed = unconfirmedCount(producerDb)
      const truncatedCount = Object.values(updated).filter((u) => u.albumsTruncated).length
      logger.info('score', '确认批次完成', { processed: Object.keys(updated).length, withAlbums, zeroAlbums, failed, unconfirmed, truncated: truncatedCount, cancelled: scoreBatchCancelled })
      return {
        ok: true,
        score: {
          processed: Object.keys(updated).length,
          withAlbums,
          zeroAlbums,
          failed,
          done: !scoreBatchCancelled && unconfirmed === 0,
        },
        unconfirmed,
        cancelled: scoreBatchCancelled || undefined,
      }
    }
    case 'IMG_SCORE_STOP': {
      scoreBatchCancelled = true
      logger.info('score', '确认已请求停止')
      return { ok: true }
    }

    // ---- 单用户彻底遍历（点击截断相册数触发，上限 300 页） ----
    case 'IMG_SCORE_FULL': {
      await producerDbReady
      const username = (message.username || '').toLowerCase()
      const entry = producerDb.entries[username]
      if (!entry) return { ok: false, error: '库中无此用户' }
      logger.info('score', '彻底遍历开始', { user: username, maxPages: SCORE_FULL_MAX_PAGES })
      try {
        const { albums: userAlbums, truncated } = await fetchUserAlbums(username, SCORE_FULL_MAX_PAGES)
        producerDb.entries[username] = {
          ...entry,
          albumCount: userAlbums.length,
          albumsChecked: true,
          albumsTruncated: truncated || undefined,
          albums: userAlbums.map((a) => ({ name: a.name, url: a.url })),
        }
        await storageSet(PRODUCER_DB_KEY, producerDb)
        logger.info('score', '彻底遍历完成', { user: username, albums: userAlbums.length, truncated })
        return {
          ok: true,
          full: { username, albumCount: userAlbums.length, truncated },
        }
      } catch (err) {
        logger.error('score', '彻底遍历失败', { user: username, error: String(err) })
        return { ok: false, error: String(err) }
      }
    }

    // ---- 区间检索（FP-005 模块 2）：纯本地评分区间 + 关键词匹配（零请求，一次全量） ----
    case 'IMG_SEARCH_START': {
      await producerDbReady
      const scored = confirmedScored(producerDb, message.w1, message.w2)
      const from = Math.min(scored.length, Math.floor((scored.length * message.fromPct) / 100))
      const to = Math.min(scored.length, Math.floor((scored.length * message.toPct) / 100))
      const keywords = message.keywords.map((k) => k.toLowerCase()).filter(Boolean)
      const matches = scored
        .slice(from, to)
        .map((c) => ({ username: c.username, inDegree: c.inDegree, albums: matchAlbums(c, keywords) }))
        .filter((m) => m.albums.length > 0)
      logger.info('search', '检索完成（全量）', {
        keywords,
        range: `0~${message.toPct}%`,
        candidates: to - from,
        hits: matches.length,
      })
      return {
        ok: true,
        search: { total: matches.length, processed: matches.length, matches, done: true },
        unconfirmed: unconfirmedCount(producerDb),
      }
    }
    case 'IMG_SEARCH_BATCH': {
      // 已由全量返回取代（保留分支兼容旧调用）
      return { ok: true, search: { total: 0, processed: 0, matches: [], done: true } }
    }

    // ---- GitHub 同步（FP-005，手动触发） ----
    case 'IMG_GITHUB_GET_CONFIG': {
      const cfg = normalizeConfig(await storageGet<GithubConfig>(GITHUB_CONFIG_KEY))
      return {
        ok: true,
        config: cfg ? { repo: cfg.repo, branch: cfg.branch, configured: true } : { repo: '', branch: 'main', configured: false },
      }
    }
    case 'IMG_GITHUB_SAVE_CONFIG': {
      const cfg = normalizeConfig({ repo: message.repo, token: message.token, branch: message.branch })
      if (!cfg) return { ok: false, error: '仓库与 token 不能为空' }
      await storageSet(GITHUB_CONFIG_KEY, cfg)
      logger.info('github', '同步配置已保存', { repo: cfg.repo, branch: cfg.branch })
      return { ok: true }
    }
    case 'IMG_GITHUB_PUSH': {
      try {
        await producerDbReady
        const cfg = normalizeConfig(await storageGet<GithubConfig>(GITHUB_CONFIG_KEY))
        if (!cfg) return { ok: false, error: '未配置 GitHub，请先保存仓库与 token' }
        // 先拉取拿远程 sha（远程不存在则创建），再推送覆盖
        const remote = await pullDb(cfg)
        const res = await pushDb(cfg, producerDb, remote.sha)
        logger.info('github', '生产者库已推送', { repo: cfg.repo, total: Object.keys(producerDb.entries).length })
        return { ok: true, github: { message: `${res.message}（库 ${Object.keys(producerDb.entries).length} 用户）` } }
      } catch (err) {
        logger.error('github', '推送失败', String(err))
        return { ok: false, error: String(err) }
      }
    }
    case 'IMG_GITHUB_PULL': {
      try {
        await producerDbReady
        const cfg = normalizeConfig(await storageGet<GithubConfig>(GITHUB_CONFIG_KEY))
        if (!cfg) return { ok: false, error: '未配置 GitHub，请先保存仓库与 token' }
        const remote = await pullDb(cfg)
        if (remote.db) {
          producerDb = mergeDb(producerDb, remote.db)
          await storageSet(PRODUCER_DB_KEY, producerDb)
          logger.info('github', '生产者库已拉取合并', { total: Object.keys(producerDb.entries).length })
        }
        return { ok: true, github: { message: `${remote.message}（库 ${Object.keys(producerDb.entries).length} 用户）` } }
      } catch (err) {
        logger.error('github', '拉取失败', String(err))
        return { ok: false, error: String(err) }
      }
    }

    // ---- buondua 适配器（FP-004） ----
    case 'BD_FETCH_ALBUM': {
      try {
        const { images, pages, title } = await buondua.fetchAlbumAllPages(message.url)
        await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'album', data: images, done: true })
        logger.info('buondua', '全子页抓取完成', { url: message.url, pages: pages.length, count: images.length, title })
        return { ok: true, name: title || undefined }
      } catch (err) {
        // 降级：content 页面内 fetch（带 Cookie/Referer 穿透反爬，hitxhot 等站点）
        logger.warn('buondua', '后台抓取失败，尝试页面内 fetch 降级', String(err))
        try {
          const contentFetch = async (u: string): Promise<string> => {
            const res = await sendToTabAndGet<{ ok: true; data?: string } | { ok: false; error: string }>(
              message.srcTabId,
              { type: 'BD_FETCH_HTML', url: u },
            )
            if (!res || !res.ok || !res.data) throw new Error(res && !res.ok ? res.error : '页面内 fetch 无响应')
            return res.data
          }
          const { images, pages, title } = await buondua.fetchAlbumAllPages(message.url, contentFetch)
          await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'album', data: images, done: true })
          logger.info('buondua', '全子页抓取完成（页面内 fetch 降级）', { url: message.url, pages: pages.length, count: images.length, title })
          return { ok: true, name: title || undefined }
        } catch (err2) {
          logger.error('buondua', '全子页抓取失败（含降级）', String(err2))
          await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'album', data: [], done: true, error: String(err2) })
          return { ok: false, error: String(err2) }
        }
      }
    }

    case 'BD_SCAN_LINKS': {
      try {
        const items = await buondua.scanLinks(message.url, message.kind)
        await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'scan', data: items, done: true })
        logger.info('buondua', '链接扫描完成', { kind: message.kind, count: items.length })
      } catch (err) {
        logger.error('buondua', '链接扫描失败', String(err))
        await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'scan', data: [], done: true, error: String(err) })
      }
      return { ok: true }
    }

    case 'BD_FETCH_ALBUMS': {
      try {
        const targets = message.targets
        let completed = 0
        await buondua.fetchAlbumsBatch(
          targets.map((t) => ({ url: t.url, title: t.folderName })),
          (index, _target, images) => {
            completed++
            void sendToTab(sessionOf(message.srcTabId), {
              type: 'BD_RESULT',
              kind: 'batch-item',
              data: { index, target: targets[index], images, pages: [] },
              done: completed >= targets.length,
            })
          },
        )
        logger.info('buondua', '批量抓取完成', { total: targets.length })
      } catch (err) {
        logger.error('buondua', '批量抓取失败', String(err))
        await sendToTab(sessionOf(message.srcTabId), {
          type: 'BD_RESULT',
          kind: 'batch-item',
          data: { index: -1, target: { url: '', folderName: '' }, images: [], pages: [] },
          done: true,
          error: String(err),
        })
      }
      return { ok: true }
    }

    // ---- freeimage 适配器（FP-007） ----
    case 'FH_FETCH_USER': {
      try {
        const images = await freeimage.fetchUserPages(message.url, message.pageFrom, message.pageTo)
        await pushFhResult(message.srcTabId, 'user', images, true)
      } catch (err) {
        logger.error('freeimage', '用户主页抓取失败', String(err))
        await pushFhResult(message.srcTabId, 'user', [], true, String(err))
      }
      return { ok: true }
    }

    case 'FH_FETCH_ALBUM': {
      try {
        const { images, name } = await freeimage.fetchAlbumImages(message.albumUrl)
        await pushFhResult(message.srcTabId, 'album', images, true)
        return { ok: true, name: name || undefined }
      } catch (err) {
        logger.error('freeimage', '相册抓取失败', String(err))
        await pushFhResult(message.srcTabId, 'album', [], true, String(err))
        return { ok: false, error: String(err) }
      }
    }

    case 'FH_FETCH_ALBUMS': {
      try {
        const albums = await freeimage.fetchAlbumsPage(message.username, message.sort, message.page)
        await pushFhResult(message.srcTabId, 'albums', albums, true)
      } catch (err) {
        logger.error('freeimage', '相册列表抓取失败', String(err))
        await pushFhResult(message.srcTabId, 'albums', [], true, String(err))
      }
      return { ok: true }
    }

    case 'FH_FETCH_EXPLORE': {
      try {
        const images = await freeimage.fetchExplorePages(message.pageFrom, message.pageTo)
        await pushFhResult(message.srcTabId, 'explore', images, true)
      } catch (err) {
        logger.error('freeimage', '探索页抓取失败', String(err))
        await pushFhResult(message.srcTabId, 'explore', [], true, String(err))
      }
      return { ok: true }
    }

    case 'FH_EXTRACT_OWNER': {
      try {
        const results = await freeimage.extractOwners(message.imageViewerUrls, message.samplePerPage, message.intervalMs)
        const owners = results.map((r) => r.owner)
        await pushFhResult(message.srcTabId, 'owners', owners, true)
      } catch (err) {
        logger.error('freeimage', '属主提取失败', String(err))
        await pushFhResult(message.srcTabId, 'owners', [], true, String(err))
      }
      return { ok: true }
    }

    case 'FH_SCAN_PRODUCERS': {
      try {
        await fhProducerDbReady
        const entries = []
        for (const username of message.usernames) {
          try {
            const info = await freeimage.collectAlbumsForUser(username)
            entries.push(info)
          } catch (err) {
            logger.warn('freeimage', '相册名采集失败（跳过）', { username, error: String(err) })
          }
          await new Promise((r) => setTimeout(r, message.intervalMs))
        }
        await pushFhResult(message.srcTabId, 'scan', entries, true)
      } catch (err) {
        logger.error('freeimage', '相册名采集失败', String(err))
        await pushFhResult(message.srcTabId, 'scan', [], true, String(err))
      }
      return { ok: true }
    }

    case 'FH_PRODUCER_GET': {
      await fhProducerDbReady
      return { ok: true, fh: fhProducerDb }
    }

    case 'FH_PRODUCER_SAVE': {
      await fhProducerDbReady
      const existing = fhProducerDb.entries[message.username] ?? {
        username: message.username,
        status: null,
        seenAt: Date.now(),
      }
      fhProducerDb.entries[message.username] = {
        ...existing,
        status: message.status,
        reason: message.reason || undefined,
        notedAt: Date.now(),
      }
      fhProducerDb.updatedAt = Date.now()
      await storageSet(FH_PRODUCER_DB_KEY, fhProducerDb)
      logger.info('freeimage', '标注已保存', { username: message.username, status: message.status })
      return { ok: true }
    }

    case 'FH_PRODUCER_CLEAR': {
      await fhProducerDbReady
      delete fhProducerDb.entries[message.username]
      fhProducerDb.updatedAt = Date.now()
      await storageSet(FH_PRODUCER_DB_KEY, fhProducerDb)
      logger.info('freeimage', '标注已清除', { username: message.username })
      return { ok: true }
    }

    case 'FH_PRODUCER_EXPORT': {
      await fhProducerDbReady
      return { ok: true, json: JSON.stringify(fhProducerDb, null, 1) }
    }

    case 'FH_PRODUCER_IMPORT': {
      await fhProducerDbReady
      const imported = loadFhProducerDb(message.db)
      const before = Object.keys(fhProducerDb.entries).length
      // 合并：已存在条目以导入的为准（导入新标注），不存在则新增
      for (const [username, e] of Object.entries(imported.entries)) {
        fhProducerDb.entries[username] = e
      }
      fhProducerDb.updatedAt = Date.now()
      await storageSet(FH_PRODUCER_DB_KEY, fhProducerDb)
      const after = Object.keys(fhProducerDb.entries).length
      logger.info('freeimage', '标注库已导入合并', { before, after })
      return { ok: true, fhImported: { before, after } }
    }

    // ---- freeimage 探索检索（FP-007 场景 D v8/v9：批次会话 + 仅中文 + 中文深挖） ----
    case 'FH_EXPLORE_SEARCH_START': {
      freeimage.startSearch(message.mode, message.list)
      logger.info('freeimage', '探索检索开始新会话', { mode: message.mode, list: message.list, rounds: message.rounds, chineseOnly: message.chineseOnly })
      await runSearchBatch(message.srcTabId, message.mode, message.list, message.rounds, message.intervalMs, message.chineseOnly)
      return { ok: true }
    }

    case 'FH_EXPLORE_SEARCH_NEXT': {
      const info = freeimage.getSessionInfo()
      if (!info) {
        return { ok: false, error: '无活动检索会话（请先开始检索）' }
      }
      logger.info('freeimage', '探索检索下一批', { mode: info.mode, list: info.list, rounds: message.rounds })
      await runSearchBatch(message.srcTabId, info.mode, info.list, message.rounds, message.intervalMs, message.chineseOnly)
      return { ok: true }
    }

    // 中文深挖：索引内未深挖的中文相册 → 属主 → 属主相册（中文聚集地）→ 递归入索引
    case 'FH_EXPLORE_MINE': {
      await fhAlbumIndexReady
      const MINE_BATCH = 5 // 每轮最多深挖的种子数
      let round = 0
      let done = false
      while (round < message.rounds && !done) {
        round++
        const candidates = Object.values(fhAlbumIndex.entries)
          .filter((e) => !e.mined && isChineseAlbum(e.name))
          .slice(0, MINE_BATCH)
        if (candidates.length === 0) {
          done = true
          break
        }
        const newEntries: import('../lib/freeimage-types').FhAlbumIndexEntry[] = []
        for (const c of candidates) {
          try {
            // 属主提取（相册页 user-link）
            const html = await freeimage.fetchHtml(c.url)
            const owner = extractOwner(html)
            if (owner) {
              // 属主全部相册（中文聚集地）
              const info = await freeimage.collectAlbumsForUser(owner.username)
              let ownerCn = 0
              for (const a of info.albums) {
                const aid = a.url.match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? a.url
                const entry: import('../lib/freeimage-types').FhAlbumIndexEntry = {
                  id: aid,
                  name: a.name,
                  url: a.url,
                  username: owner.username,
                  source: 'mine',
                  collectedAt: Date.now(),
                }
                const existing = fhAlbumIndex.entries[aid]
                if (!existing) {
                  fhAlbumIndex.entries[aid] = entry
                  if (isChineseAlbum(a.name)) ownerCn++
                } else if (!existing.username) {
                  fhAlbumIndex.entries[aid] = { ...existing, username: owner.username }
                }
              }
              logger.info('freeimage', '中文深挖：属主相册', { seed: c.name, owner: owner.username, albums: info.albumCount, chinese: ownerCn })
            }
          } catch (err) {
            logger.warn('freeimage', '深挖种子失败（跳过）', { seed: c.name, error: String(err) })
          }
          // 标记已深挖
          fhAlbumIndex.entries[c.id] = { ...fhAlbumIndex.entries[c.id], mined: true }
        }
        fhAlbumIndex.updatedAt = Date.now()
        await storageSet(FH_ALBUM_INDEX_KEY, fhAlbumIndex)
        const total = Object.keys(fhAlbumIndex.entries).length
        await pushFhResult(
          message.srcTabId,
          'explore-mine',
          {
            round,
            pageFrom: 0,
            pageTo: 0,
            added: newEntries.length,
            total,
            newEntries,
            mode: 'recent',
            type: 'albums',
          },
          round >= message.rounds,
        )
        await new Promise((r) => setTimeout(r, message.intervalMs))
      }
      if (done) {
        await pushFhResult(
          message.srcTabId,
          'explore-mine',
          {
            round,
            pageFrom: 0,
            pageTo: 0,
            added: 0,
            total: Object.keys(fhAlbumIndex.entries).length,
            newEntries: [],
            mode: 'recent',
            type: 'albums',
          },
          true,
        )
      }
      return { ok: true }
    }

    case 'FH_EXPLORE_STOP': {
      freeimage.cancelExploreSearch()
      logger.info('freeimage', '探索检索已请求停止')
      return { ok: true }
    }

    // ---- freeimage 相册索引库 CRUD ----
    case 'FH_ALBUM_INDEX_GET': {
      await fhAlbumIndexReady
      return { ok: true, fhIndex: fhAlbumIndex }
    }
    case 'FH_ALBUM_INDEX_EXPORT': {
      await fhAlbumIndexReady
      return { ok: true, json: JSON.stringify(fhAlbumIndex, null, 1) }
    }
    case 'FH_ALBUM_INDEX_CLEAR': {
      await fhAlbumIndexReady
      fhAlbumIndex = emptyFhAlbumIndexDb()
      await storageSet(FH_ALBUM_INDEX_KEY, fhAlbumIndex)
      logger.info('freeimage', '相册索引库已清空')
      return { ok: true, fhIndexImported: { before: 0, after: 0 } }
    }
    case 'FH_ALBUM_INDEX_IMPORT': {
      await fhAlbumIndexReady
      const imported = loadFhAlbumIndexDb(message.db)
      const before = Object.keys(fhAlbumIndex.entries).length
      // 合并：以导入为准覆盖同 key，新增加入
      for (const [id, e] of Object.entries(imported.entries)) {
        fhAlbumIndex.entries[id] = e
      }
      fhAlbumIndex.updatedAt = Date.now()
      await storageSet(FH_ALBUM_INDEX_KEY, fhAlbumIndex)
      const after = Object.keys(fhAlbumIndex.entries).length
      logger.info('freeimage', '相册索引库已导入合并', { before, after })
      return { ok: true, fhIndexImported: { before, after } }
    }

    // ---- freeimage 关注墙（FP-007 迁移 imgbb 关注墙） ----
    case 'FH_FETCH_FOLLOWING': {
      try {
        const users = await fetchFhFollowingUsers(message.username, message.side)
        await pushFhResult(message.srcTabId, 'following', users, true)
      } catch (err) {
        logger.error('freeimage', '关注墙抓取失败', String(err))
        await pushFhResult(message.srcTabId, 'following', [], true, String(err))
      }
      return { ok: true }
    }

    // ---- freeimage 扩散检索（FP-007 迁移 imgbb FP-005） ----
    case 'FH_DIFFUSE_START': {
      fhDiffuse.start(message.startUser)
      await saveFhDiffuseState()
      return { ok: true, snapshot: fhDiffuse.snapshot() }
    }
    case 'FH_DIFFUSE_BATCH': {
      await ensureFhDiffuseRestored()
      await fhDiffuseDbReady
      if (fhDiffuse.is429Throttled) {
        logger.warn('freeimage', '连续 429，已阻止继续扩散，请稍后再试')
        return { ok: false, error: '连续 429 限流，请等待 30 秒后再继续' }
      }
      const result = await fhDiffuse.processBatch(message.batchSize, message.concurrency, message.intervalMs)
      await saveFhDiffuseState()
      const snapshot = fhDiffuse.snapshot()
      if (Object.keys(result.inDegreeDelta).length > 0) {
        fhDiffuseDb = mergeInDegree(fhDiffuseDb, result.inDegreeDelta, snapshot.startUser)
        await storageSet(FH_DIFFUSE_DB_KEY, fhDiffuseDb)
      }
      return { ok: true, result, snapshot }
    }
    case 'FH_DIFFUSE_PROGRESS': {
      await ensureFhDiffuseRestored()
      return { ok: true, snapshot: fhDiffuse.snapshot() }
    }
    case 'FH_DIFFUSE_DB_GET': {
      await fhDiffuseDbReady
      const sum = dbSummary(fhDiffuseDb)
      const dist = inDegreeDist(fhDiffuseDb)
      const w1 = message.w1 ?? 0.6
      const topN = message.topN ?? 100
      return {
        ok: true,
        db: fhDiffuseDb,
        total: sum.total,
        confirmed: sum.confirmed,
        producers: sum.producers,
        maxInDegree: sum.maxInDegree,
        dist,
        rankScore: scoreTop(fhDiffuseDb, topN, w1, 1 - w1),
        rankDegree: degreeTop(fhDiffuseDb, topN),
        rankAlbum: albumTop(fhDiffuseDb, topN),
      }
    }
    case 'FH_DIFFUSE_DB_SAVE': {
      await fhDiffuseDbReady
      await storageSet(FH_DIFFUSE_DB_KEY, fhDiffuseDb)
      const sum = dbSummary(fhDiffuseDb)
      logger.info('freeimage', 'freeimage 生产者库已保存', { total: sum.total, source: message.source })
      return { ok: true, total: sum.total, confirmed: sum.confirmed, producers: sum.producers, maxInDegree: sum.maxInDegree }
    }
    case 'FH_DIFFUSE_DB_CLEAR': {
      await fhDiffuseDbReady
      fhDiffuseDb = emptyDb()
      await storageSet(FH_DIFFUSE_DB_KEY, fhDiffuseDb)
      logger.info('freeimage', 'freeimage 生产者库已清空')
      return { ok: true, total: 0 }
    }
    case 'FH_DIFFUSE_DB_EXPORT': {
      await fhDiffuseDbReady
      return { ok: true, json: JSON.stringify(fhDiffuseDb, null, 1) }
    }
    case 'FH_DIFFUSE_DB_IMPORT': {
      await fhDiffuseDbReady
      const imported = loadDb(message.db)
      const before = Object.keys(fhDiffuseDb.entries).length
      fhDiffuseDb = mergeDb(fhDiffuseDb, imported)
      await storageSet(FH_DIFFUSE_DB_KEY, fhDiffuseDb)
      const after = Object.keys(fhDiffuseDb.entries).length
      const sum = dbSummary(fhDiffuseDb)
      logger.info('freeimage', 'freeimage 生产者库已导入合并', { before, after })
      return { ok: true, total: after, confirmed: sum.confirmed, producers: sum.producers, maxInDegree: sum.maxInDegree, github: { message: `导入合并：${before} → ${after}` } }
    }
    case 'FH_DIFFUSE_DB_RESET_CONFIRM': {
      await fhDiffuseDbReady
      fhDiffuseDb = resetConfirmations(fhDiffuseDb)
      await storageSet(FH_DIFFUSE_DB_KEY, fhDiffuseDb)
      logger.info('freeimage', '确认状态已重置（保留入度），需重新确认评分')
      return { ok: true, total: Object.keys(fhDiffuseDb.entries).length }
    }
    case 'FH_DIFFUSE_SCORE_BATCH': {
      await fhDiffuseDbReady
      fhScoreBatchCancelled = false
      const candidates = unconfirmedCandidates(fhDiffuseDb, message.batchSize, message.order ?? 'inDegree', message.w1, message.w2)
      if (candidates.length === 0) {
        return { ok: true, score: { processed: 0, withAlbums: 0, zeroAlbums: 0, failed: 0, done: true } }
      }
      let withAlbums = 0
      let zeroAlbums = 0
      let failed = 0
      let cursor = 0
      const updated: Record<string, import('../lib/types').ProducerEntry> = {}
      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
      const worker = async (): Promise<void> => {
        while (true) {
          const idx = cursor++
          if (idx >= candidates.length) return
          const c = candidates[idx]
          await sleep(message.intervalMs)
          try {
            const { albums: userAlbums, truncated } = await fhFetchUserAlbums(c.username, 10)
            updated[c.username] = {
              ...c,
              albumCount: userAlbums.length,
              albumsChecked: true,
              albumsTruncated: truncated || undefined,
              albums: userAlbums.map((a) => ({ name: a.name, url: a.url })),
            }
            if (userAlbums.length > 0) withAlbums++
            else zeroAlbums++
            const session = sessions.get(message.srcTabId)
            if (session) {
              await sendToTab(session.grabTabId, {
                type: 'FH_DIFFUSE_SCORE_PROGRESS_FWD',
                done: withAlbums + zeroAlbums + failed,
                total: candidates.length,
                username: c.username,
                albumCount: userAlbums.length,
                truncated: truncated || undefined,
                failed,
                cancelled: fhScoreBatchCancelled || undefined,
              })
            }
          } catch (err) {
            failed++
            logger.warn('freeimage', 'albums 确认失败（跳过）', { user: c.username, error: String(err) })
          }
          if (fhScoreBatchCancelled) return
        }
      }
      await Promise.all(Array.from({ length: Math.min(message.concurrency, candidates.length) }, () => worker()))
      const entries = { ...fhDiffuseDb.entries }
      for (const [u, e] of Object.entries(updated)) entries[u] = e
      fhDiffuseDb = { ...fhDiffuseDb, updatedAt: Date.now(), entries }
      await storageSet(FH_DIFFUSE_DB_KEY, fhDiffuseDb)
      const unconfirmed = unconfirmedCount(fhDiffuseDb)
      logger.info('freeimage', 'freeimage 确认批次完成', { processed: Object.keys(updated).length, withAlbums, zeroAlbums, failed, unconfirmed, cancelled: fhScoreBatchCancelled })
      return {
        ok: true,
        score: { processed: Object.keys(updated).length, withAlbums, zeroAlbums, failed, done: !fhScoreBatchCancelled && unconfirmed === 0 },
        unconfirmed,
        cancelled: fhScoreBatchCancelled || undefined,
      }
    }
    case 'FH_DIFFUSE_SCORE_STOP': {
      fhScoreBatchCancelled = true
      logger.info('freeimage', '确认已请求停止')
      return { ok: true }
    }
    case 'FH_DIFFUSE_SEARCH_START': {
      await fhDiffuseDbReady
      const scored = confirmedScored(fhDiffuseDb, message.w1, message.w2)
      const from = Math.min(scored.length, Math.floor((scored.length * message.fromPct) / 100))
      const to = Math.min(scored.length, Math.floor((scored.length * message.toPct) / 100))
      const keywords = message.keywords.map((k) => k.toLowerCase()).filter(Boolean)
      const matches = scored
        .slice(from, to)
        .map((c) => ({ username: c.username, inDegree: c.inDegree, albums: matchAlbums(c, keywords) }))
        .filter((m) => m.albums.length > 0)
      logger.info('freeimage', 'freeimage 检索完成（全量）', { keywords, range: `0~${message.toPct}%`, candidates: to - from, hits: matches.length })
      return { ok: true, search: { total: matches.length, processed: matches.length, matches, done: true }, unconfirmed: unconfirmedCount(fhDiffuseDb) }
    }
  }

  // 兜底（理论上不可达，消息类型已穷举）
  return { ok: false, error: '未知消息类型' }
}

logger.info('runtime', 'background 初始化完成')
