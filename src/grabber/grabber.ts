// 抓取页主入口（grabber.html 对应脚本）
// 职责：页签切换、会话注册、消息接收（只处理 _FWD 转发）、视图挂载、自动开始解析

import { initLogPanel } from '../lib/log-panel'
import { initLogger } from '../lib/logger'
import { sendMessage } from '../lib/messages'
import type { GrabSession } from '../lib/types'
import { initAdaptersView, type AdaptersViewHandle } from './view-adapters'
import { initBuonduaView, type BuonduaViewHandle } from './view-buondua'
import { initImagesView, type ImagesViewHandle } from './view-images'
import { initTemplateView } from './view-template'
import { initWheelForward } from './wheel-forward'

const logger = initLogger('grabber')

// 构建时间戳（由 esbuild define 注入，格式 yyyymmddHHMMSS）
declare const __BUILD_TIME__: string
const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'

const params = new URLSearchParams(location.search)
const srcTabId = Number(params.get('srcTabId'))

let imagesView: ImagesViewHandle | null = null
let adaptersView: AdaptersViewHandle | null = null
let buonduaView: BuonduaViewHandle | null = null

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}

// ---------- 页签切换 ----------
function switchTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.grab-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.panel === name)
  })
  document.querySelectorAll('.panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `panel-${name}`)
  })
}

document.querySelectorAll<HTMLElement>('.grab-tab').forEach((tab) => {
  tab.addEventListener('click', () => switchTab(tab.dataset.panel || 'images'))
})

// ---------- 空白区域滚轮转发（FP-020）：两侧留白处滚轮驱动当前页签的滚动区 ----------
initWheelForward()

// ---------- 消息接收（只处理 background 的 _FWD 转发） ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (!imagesView) return
  switch (msg?.type) {
    case 'GRAB_PARSE_BATCH_FWD':
      imagesView.onParseBatch(msg)
      break
    case 'GRAB_PARSE_DONE_FWD':
      imagesView.onParseDone(msg.cancelled, msg.reachedLimit)
      break
    case 'GRAB_PARSE_ERROR_FWD':
      imagesView.onParseError(msg.error)
      break
    case 'GRAB_DOWNLOAD_PROGRESS':
      imagesView.onDownloadProgress(msg.job)
      adaptersView?.onDownloadProgress(msg.job)
      buonduaView?.onDownloadProgress(msg.job)
      break
    case 'GRAB_DOWNLOAD_DONE':
      imagesView.onDownloadDone(msg.job)
      adaptersView?.onDownloadDone(msg.job)
      buonduaView?.onDownloadDone(msg.job)
      break
    case 'GRAB_SESSION_END_FWD':
      imagesView.onSessionEnd()
      break
    case 'IMG_RESULT':
      adaptersView?.onImgbbResult(msg.kind, msg.data, msg.done, msg.error)
      break
    case 'IMG_SCORE_PROGRESS_FWD':
      adaptersView?.onScoreProgress(msg)
      break
    case 'BD_RESULT':
      buonduaView?.onResult(msg.kind, msg.data, msg.done, msg.error)
      break
  }
})

// ---------- 初始化 ----------
const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label}（${ms}ms 超时）`)), ms)),
  ])

void (async () => {
  // 版本号徽标（右下角）：确认插件是否已更新到最新构建
  const versionBadge = document.getElementById('version-badge')
  if (versionBadge) {
    versionBadge.textContent = `v${chrome.runtime.getManifest().version} · ${BUILD_TIME}`
  }

  const pageInfo = document.getElementById('page-info')
  if (!srcTabId) {
    if (pageInfo) pageInfo.textContent = '错误：缺少源网页参数（请从插件图标打开本页）'
    return
  }

  // ---------- 下载并发设置（header，全局生效） ----------
  const concurrencyInput = document.getElementById('dl-concurrency') as HTMLInputElement | null
  const concurrencyBtn = document.getElementById('dl-concurrency-set') as HTMLButtonElement | null
  void sendMessage({ type: 'GRAB_GET_CONCURRENCY' }).then((res) => {
    if (res.ok && res.concurrency && concurrencyInput) {
      concurrencyInput.value = String(res.concurrency)
    }
  })
  concurrencyBtn?.addEventListener('click', () => {
    const n = Math.max(1, Math.min(128, Number(concurrencyInput?.value) || 12))
    if (concurrencyInput) concurrencyInput.value = String(n)
    void sendMessage({ type: 'GRAB_SET_CONCURRENCY', concurrency: n }).then((res) => {
      if (res.ok) {
        logger.info('grabber', '下载并发已设置', { concurrency: res.concurrency })
        if (pageInfo) {
          const old = pageInfo.innerHTML
          pageInfo.innerHTML = old + `<br><span class="folder">下载并发：${res.concurrency}</span>`
        }
      }
    })
  })
  try {
    const currentTab = await chrome.tabs.getCurrent()
    const grabTabId = currentTab?.id ?? 0
    logger.info('grabber', '开始初始化', { srcTabId, grabTabId })

    // 会话注册：SW 休眠/重启可能导致响应丢失，超时自动重试 1 次
    let session: GrabSession | undefined
    let lastError = ''
    let created = false
    for (let attempt = 1; attempt <= 2 && !created; attempt++) {
      try {
        const res = await withTimeout(
          sendMessage<{ ok: true; session: GrabSession } | { ok: false; error: string }>({
            type: 'GRAB_SESSION_CREATE',
            srcTabId,
            grabTabId,
          }),
          8000,
          '会话注册超时',
        )
        if (res.ok) {
          session = res.session
          created = true
        } else {
          lastError = res.error
        }
      } catch (err) {
        lastError = String(err)
        logger.warn('grabber', `会话注册第 ${attempt} 次失败，重试中`, lastError)
      }
    }
    if (!created || !session) {
      throw new Error(lastError || '会话注册失败')
    }

    if (pageInfo) {
      pageInfo.innerHTML = `抓取：<b>${escapeHtml(session.title)}</b>（${escapeHtml(session.host)}）<br>保存到文件夹：<span class="folder">${escapeHtml(session.folderName)}</span>`
    }

    // 挂载页签
    imagesView = initImagesView(document.getElementById('panel-images') as HTMLElement, session)
    initLogPanel(document.getElementById('panel-logs') as HTMLElement)
    adaptersView = initAdaptersView(document.getElementById('panel-imgbb') as HTMLElement, srcTabId, session.url)
    buonduaView = initBuonduaView(document.getElementById('panel-buondua') as HTMLElement, srcTabId, session.url)
    initTemplateView(document.getElementById('panel-template') as HTMLElement)

    // 自动开始解析（不阻塞：超时仅警告）
    void withTimeout(sendMessage({ type: 'GRAB_PARSE_START', srcTabId }), 5000, '解析启动超时')
      .then(() => {})
      .catch((err) => logger.warn('grabber', '解析启动失败', String(err)))
    logger.info('grabber', '抓取页就绪，已请求解析', { srcTabId, title: session.title })
  } catch (err) {
    if (pageInfo) pageInfo.textContent = '错误：' + String(err)
    logger.error('grabber', '初始化失败', String(err))
  }
})()
