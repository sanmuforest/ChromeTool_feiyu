// Background Service Worker（MV3）
// 职责（FP-002）：
// 1. 日志唯一写入者（FP-001 保留）
// 2. 抓取会话管理：srcTabId ↔ grabTabId 映射，页面关闭自动清理
// 3. 消息路由：content 上报 → 路由给对应 grabber；grabber 控制 → 转发给 content
// 4. 下载队列管理（DownloadManager）
// 注意：SW 生命周期短、无 DOM，状态持久化到 chrome.storage（内存 Map 可重建）

import { DownloadManager, arrayBufferToBase64, fetchImageBytes, fetchImgbbViaSrcTab } from '../lib/downloader'
import { DiffuseEngine } from './imgbb-diffuse'
import { emptyDb, loadDb, mergeInDegree, mergeDb, dbSummary, inDegreeDist, unconfirmedCandidates, unconfirmedCount, confirmedScored, matchAlbums, scoreTop, degreeTop, albumTop, resetConfirmations, setStarRating, ensureEntry, starInfo, PRODUCER_DB_KEY } from '../lib/producer-db'
import { normalizeConfig, pullDb, pushDb, GITHUB_CONFIG_KEY } from '../lib/github-sync'
import { computeTags, loadCustomDict, emptyCustomDict, type TagCustomDict } from '../lib/tag-extract'
import type { GithubConfig } from '../lib/github-sync'
import { parseAlbumItems, parseAlbumNextPage } from '../lib/imgbb-parse'
import type { ProducerDb } from '../lib/producer-db'
import { appendLog, clearEntries, getEntries, getLevel, initLogger, setLevel } from '../lib/logger'
import { sendToTab, type ImgResultKind, type Message, type MessageResponse, type PageProbeResult } from '../lib/messages'
import { storageGet, storageSet } from '../lib/storage'
import type { GrabSession, ImgbbAlbum, ImgbbFollowingUser, ImgbbImage } from '../lib/types'
import { ImgbbService } from './imgbb-service'
import { BuonduaService } from './buondua-service'

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

// ---------- 标签云自定义词典（FP-016） ----------

/** 自定义标签词典与屏蔽词（storage 键 tag_custom） */
const TAG_CUSTOM_KEY = 'tag_custom'
let tagCustomDict: TagCustomDict = emptyCustomDict()
const tagCustomReady = (async (): Promise<void> => {
  tagCustomDict = loadCustomDict(await storageGet<unknown>(TAG_CUSTOM_KEY))
})()

// ---------- 标星悬浮窗（FP-017） ----------

/** 悬浮窗开关（storage 键 star_overlay_enabled） */
const STAR_OVERLAY_KEY = 'star_overlay_enabled'
/** 动态注册的 content script id */
const STAR_OVERLAY_ID = 'star-overlay'
/** 注入范围：imgbb 用户页（*.imgbb.com）+ 相册详情页（ibb.co/album/*）
 * 声明在 manifest 的 optional_host_permissions，用户点「启用」时才申请 */
const STAR_OVERLAY_ORIGINS = ['*://*.imgbb.com/*', '*://ibb.co/*']

/** 按当前权限注册悬浮窗内容脚本（幂等，权限未授予则返回 false） */
async function registerStarOverlay(): Promise<boolean> {
  try {
    const granted = await chrome.permissions.contains({ origins: STAR_OVERLAY_ORIGINS })
    if (!granted) return false
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [STAR_OVERLAY_ID] })
    if (existing.length === 0) {
      await chrome.scripting.registerContentScripts([
        {
          id: STAR_OVERLAY_ID,
          matches: STAR_OVERLAY_ORIGINS,
          js: ['js/star-overlay.js'],
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ])
      logger.info('star', '标星悬浮窗已注册', { matches: STAR_OVERLAY_ORIGINS })
    }
    return true
  } catch (err) {
    logger.error('star', '标星悬浮窗注册失败', String(err))
    return false
  }
}

async function unregisterStarOverlay(): Promise<void> {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [STAR_OVERLAY_ID] })
    logger.info('star', '标星悬浮窗已注销')
  } catch {
    // 未注册过：忽略
  }
}

/** 启动校验：开关为开但注册丢失（扩展更新/权限撤销）时补注册，权限失效则关掉开关 */
void (async (): Promise<void> => {
  const enabled = await storageGet<boolean>(STAR_OVERLAY_KEY)
  if (!enabled) return
  const ok = await registerStarOverlay()
  if (!ok) {
    await storageSet(STAR_OVERLAY_KEY, false)
    logger.warn('star', '标星悬浮窗权限已失效，开关置为关闭')
  }
})()

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

// ---------- 页面结构探测（FP-014 站点扩充） ----------

/** 探测执行函数（executeScript 注入，返回页面结构特征供新站适配） */
function extractProbeData(): PageProbeResult {
  const out: PageProbeResult = {
    title: document.title,
    url: location.href,
    ogImage: '',
    imgSrcs: [],
    containerCandidates: [],
    pagination: [],
  }
  out.ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') ?? ''
  const seenImg = new Set<string>()
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const s = img.getAttribute('data-src') || img.src || img.getAttribute('data-original') || ''
    if (!s || seenImg.has(s)) continue
    seenImg.add(s)
    out.imgSrcs.push(s)
    if (out.imgSrcs.length >= 40) break
  }
  // 图片祖先容器 class 统计（4 层，适配正文容器）
  const counter: Record<string, number> = {}
  for (const img of Array.from(document.querySelectorAll('img'))) {
    let el: HTMLElement | null = img.parentElement
    for (let d = 0; d < 4 && el; d++) {
      const cls = typeof el.className === 'string' ? el.className : ''
      for (const c of cls.split(/\s+/)) {
        if (c && c.length > 3) counter[c] = (counter[c] ?? 0) + 1
      }
      el = el.parentElement
    }
  }
  out.containerCandidates = Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([cls, n]) => ({ cls, n }))
  // 分页链接（?page=N / page/N / 路径尾 /N）
  const pageSeen = new Set<string>()
  for (const a of Array.from(document.querySelectorAll('a[href]'))) {
    const href = (a as HTMLAnchorElement).href
    if (/[?&]page=\d+|page\/\d+|(?<![a-z])\/\d+\/?$/i.test(href) && !pageSeen.has(href)) {
      pageSeen.add(href)
      out.pagination.push({ href, text: (a.textContent ?? '').trim().slice(0, 20) })
      if (out.pagination.length >= 10) break
    }
  }
  return out
}

/** 打开标签探测页面结构（静默开/关），返回提取结果 */
async function probePageStructure(url: string): Promise<PageProbeResult | null> {
  const tab = await chrome.tabs.create({ url, active: false })
  try {
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tab.id!)
      if (t.status === 'complete' && (t.url ?? '').startsWith('http')) break
      await new Promise((r) => setTimeout(r, 300))
    }
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: extractProbeData,
    })
    return (res[0]?.result as PageProbeResult | undefined) ?? null
  } finally {
    await chrome.tabs.remove(tab.id!).catch(() => {})
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
    // ---- 手动星级评定（FP-015）：入度 Top 第 5 列点击评星 → 写库并立即持久化 ----
    case 'IMG_DB_SET_STAR': {
      await producerDbReady
      // FP-017：悬浮窗在库外用户上标星 → 自动建条目（入度 0，来源 star）
      if (message.autoCreate) producerDb = ensureEntry(producerDb, message.username, 'star')
      producerDb = setStarRating(producerDb, message.username, message.stars)
      await storageSet(PRODUCER_DB_KEY, producerDb)
      const stars = producerDb.entries[message.username]?.starRating ?? 0
      logger.info('score', '手动星级已设置', { username: message.username, stars, autoCreate: !!message.autoCreate })
      return { ok: true, starRating: stars, starInfo: starInfo(producerDb, message.username) }
    }
    // ---- 单人星级查询（FP-017 悬浮窗：只读单条，避免拉全库排行） ----
    case 'IMG_DB_GET_STAR': {
      await producerDbReady
      return { ok: true, starInfo: starInfo(producerDb, message.username) }
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
      await tagCustomReady
      const tags = computeTags(Object.values(producerDb.entries), {
        topN: message.topN ?? 200,
        minAlbums: message.minAlbums ?? 5,
        minUsers: message.minUsers ?? 1,
        custom: tagCustomDict,
        includeSlug: !!message.includeSlug,
      })
      logger.info('tag', '标签云统计完成', {
        tags: tags.length,
        topN: message.topN ?? 200,
        minAlbums: message.minAlbums ?? 5,
        minUsers: message.minUsers ?? 1,
        custom: tagCustomDict.entries.length,
        blocked: tagCustomDict.blocked.length,
      })
      return { ok: true, tags }
    }
    // ---- 标签云：自定义词典与屏蔽词（FP-016） ----
    case 'IMG_TAG_DICT_GET': {
      await tagCustomReady
      return { ok: true, tagDict: tagCustomDict }
    }
    case 'IMG_TAG_DICT_SAVE': {
      tagCustomDict = loadCustomDict(message.tagDict)
      await storageSet(TAG_CUSTOM_KEY, tagCustomDict)
      logger.info('tag', '自定义标签词典已保存', {
        entries: tagCustomDict.entries.length,
        blocked: tagCustomDict.blocked.length,
      })
      return { ok: true, tagDict: tagCustomDict }
    }
    // ---- 标星悬浮窗开关（FP-017） ----
    case 'STAR_OVERLAY_STATUS': {
      const enabled = (await storageGet<boolean>(STAR_OVERLAY_KEY)) === true
      const regs = await chrome.scripting
        .getRegisteredContentScripts({ ids: [STAR_OVERLAY_ID] })
        .catch(() => [] as chrome.scripting.RegisteredContentScript[])
      return { ok: true, overlay: { enabled, registered: regs.length > 0 } }
    }
    case 'STAR_OVERLAY_SET': {
      if (message.enabled) {
        const ok = await registerStarOverlay()
        await storageSet(STAR_OVERLAY_KEY, ok)
        const regs = await chrome.scripting
          .getRegisteredContentScripts({ ids: [STAR_OVERLAY_ID] })
          .catch(() => [] as chrome.scripting.RegisteredContentScript[])
        return { ok: true, overlay: { enabled: ok, registered: regs.length > 0 } }
      }
      await unregisterStarOverlay()
      await storageSet(STAR_OVERLAY_KEY, false)
      return { ok: true, overlay: { enabled: false, registered: false } }
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

    // ---- 聚合搜索：Google 连接测试（FP-012） ----
    case 'BD_TEST_GOOGLE': {
      try {
        return { ok: true, google: await buondua.testGoogleConnection() }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    }

    // ---- 多页图站聚合搜索（FP-010） ----
    case 'BD_SEARCH': {
      try {
        await buondua.searchSites(
          message.query,
          message.sites,
          message.pagesPerSite,
          async (siteId, items, error) => {
            await sendToTab(sessionOf(message.srcTabId), {
              type: 'BD_RESULT',
              kind: 'search-site',
              data: { siteId, items },
              done: false,
              error,
            })
          },
          message.startPage ?? 1,
          message.useGoogleAll === true,
          message.googleSites ?? [],
        )
        await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'search', data: [], done: true })
      } catch (err) {
        logger.error('buondua', '聚合搜索失败', String(err))
        await sendToTab(sessionOf(message.srcTabId), {
          type: 'BD_RESULT',
          kind: 'search-site',
          data: [],
          done: false,
          error: String(err),
        })
      }
      return { ok: true }
    }

    case 'BD_FETCH_ALBUMS': {
      try {
        const targets = message.targets
        let completed = 0
        await buondua.fetchAlbumsBatch(
          targets.map((t) => ({ url: t.url, title: t.folderName })),
          (index, _target, images, error) => {
            completed++
            void sendToTab(sessionOf(message.srcTabId), {
              type: 'BD_RESULT',
              kind: 'batch-item',
              data: { index, target: targets[index], images, pages: [], error },
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

    case 'BD_PROBE_PAGE': {
      try {
        const probe = await probePageStructure(message.url)
        if (!probe) throw new Error('页面结构提取失败（可能加载超时/被拦截）')
        logger.info('buondua', '页面结构探测', {
          url: message.url,
          title: probe.title,
          imgs: probe.imgSrcs.length,
          containers: probe.containerCandidates.slice(0, 3),
          pages: probe.pagination.length,
        })
        return { ok: true, probe }
      } catch (err) {
        logger.warn('buondua', '页面结构探测失败', { url: message.url, error: String(err) })
        return { ok: false, error: String(err) }
      }
    }

  }

  // 兜底（理论上不可达，消息类型已穷举）
  return { ok: false, error: '未知消息类型' }
}

logger.info('runtime', 'background 初始化完成')
