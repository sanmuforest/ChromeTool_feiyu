// Background Service Worker（MV3）
// 职责（FP-002）：
// 1. 日志唯一写入者（FP-001 保留）
// 2. 抓取会话管理：srcTabId ↔ grabTabId 映射，页面关闭自动清理
// 3. 消息路由：content 上报 → 路由给对应 grabber；grabber 控制 → 转发给 content
// 4. 下载队列管理（DownloadManager）
// 注意：SW 生命周期短、无 DOM，状态持久化到 chrome.storage（内存 Map 可重建）

import { DownloadManager, arrayBufferToBase64, fetchImageBytes } from '../lib/downloader'
import { appendLog, clearEntries, getEntries, getLevel, initLogger, setLevel } from '../lib/logger'
import { sendToTab, type ImgResultKind, type Message, type MessageResponse } from '../lib/messages'
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

chrome.downloads.onChanged.addListener((delta) => {
  downloadManager.handleChanged(delta)
})

// ---------- imgbb 适配器服务（FP-003） ----------

const imgbb = new ImgbbService()
/** 关注墙用户列表缓存（按 用户名|方向 缓存，避免每批重复抓取） */
const followingUsersCache = new Map<string, import('../lib/types').ImgbbUser[]>()

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
    case 'GRAB_FETCH_IMAGE': {
      try {
        const buf = await fetchImageBytes(message.url)
        logger.debug('download', 'GRAB_FETCH_IMAGE 抓取完成', { bytes: buf.byteLength, url: message.url })
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

    // ---- buondua 适配器（FP-004） ----
    case 'BD_FETCH_ALBUM': {
      try {
        const { images, pages, title } = await buondua.fetchAlbumAllPages(message.url)
        await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'album', data: images, done: true })
        logger.info('buondua', '全子页抓取完成', { url: message.url, pages: pages.length, count: images.length, title })
        return { ok: true, name: title || undefined }
      } catch (err) {
        logger.error('buondua', '全子页抓取失败', String(err))
        await sendToTab(sessionOf(message.srcTabId), { type: 'BD_RESULT', kind: 'album', data: [], done: true, error: String(err) })
        return { ok: false, error: String(err) }
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
  }

  // 兜底（理论上不可达，消息类型已穷举）
  return { ok: false, error: '未知消息类型' }
}

logger.info('runtime', 'background 初始化完成')
