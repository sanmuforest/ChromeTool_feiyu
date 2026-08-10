// 抓取页签（薄桥接）：解析/下载消息 ↔ 共享抓取视图组件
// 所有展示与交互（网格/筛选/去重/选择/预览/下载进度）由 image-grab-view 提供

import { initLogger } from '../lib/logger'
import { sendMessage } from '../lib/messages'
import type { DownloadJob, GrabSession, GrabbedImage } from '../lib/types'
import { createGrabView, type GrabViewHandle } from './image-grab-view'

const logger = initLogger('grabber')

export interface ParseBatchMsg {
  images: GrabbedImage[]
  total: number
  scanned: number
}

export interface ImagesViewHandle {
  onParseBatch(msg: ParseBatchMsg): void
  onParseDone(cancelled?: boolean, reachedLimit?: boolean): void
  onParseError(error: string): void
  onDownloadProgress(job: DownloadJob): void
  onDownloadDone(job: DownloadJob): void
  onSessionEnd(): void
}

export function initImagesView(root: HTMLElement, session: GrabSession): ImagesViewHandle {
  let totalImages = 0

  const grabView: GrabViewHandle = createGrabView(root, {
    srcTabId: session.srcTabId,
    getFolderName: () => session.folderName,
    onReparse: () => {
      grabView.clear()
      void sendMessage({ type: 'GRAB_PARSE_START', srcTabId: session.srcTabId })
    },
    onLoadMore: () => {
      void sendMessage({ type: 'GRAB_LOAD_MORE', srcTabId: session.srcTabId })
    },
    onCancelParse: () => {
      void sendMessage({ type: 'GRAB_PARSE_CANCEL', srcTabId: session.srcTabId })
    },
  })

  return {
    onParseBatch: (msg) => {
      totalImages += msg.images.length
      grabView.appendImages(msg.images)
      grabView.setParseProgress(msg.scanned, msg.total)
      grabView.setBusyParsing(true)
    },
    onParseDone: (cancelled, reachedLimit) => {
      grabView.setBusyParsing(false)
      if (!cancelled) {
        grabView.selectAll() // 解析完成默认全选
      }
      const limitText = reachedLimit ? '（已达单批上限，可加载下一批）' : ''
      grabView.setParseText((cancelled ? '已取消，展示已解析 ' : '解析完成，共 ') + totalImages + ' 张' + limitText)
      logger.info('view', cancelled ? '解析已取消，保留已解析内容' : '解析完成（默认全选）', { count: totalImages, reachedLimit })
    },
    onParseError: (error) => {
      grabView.setBusyParsing(false)
      grabView.setParseText(`解析失败，展示已解析 ${totalImages} 张`)
      logger.error('view', '解析失败（已保留已解析内容）', error)
    },
    onDownloadProgress: (job) => {
      grabView.setDownloadJob(job)
    },
    onDownloadDone: (job) => {
      grabView.setDownloadJob(job)
      logger.info('view', '下载任务结束', { jobId: job.id, done: job.done, failed: job.failed })
    },
    onSessionEnd: () => {
      root.innerHTML = '<div class="empty-tip">源网页已关闭，此抓取页已失效。请在源网页重新点击插件图标。</div>'
      logger.info('view', '源网页已关闭，抓取页失效')
    },
  }
}
