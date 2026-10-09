// 共享抓取视图组件（复用：抓取页签 + imgbb 用户主页/相册子场景）
//
// 职责：图片网格展示、尺寸筛选、去重、选择（单击/双击/拖拽）、
//       双击预览（滚轮缩放）、下载（进度/取消/失败重试）、打包下载、打开文件夹
// 解析数据由外部注入（appendImages），解析控制通过回调（onReparse/onLoadMore/onCancelParse）

import JSZip from 'jszip'
import { extractFilename } from '../lib/downloader'
import { initLogger } from '../lib/logger'
import { sendMessage } from '../lib/messages'
import type { DownloadItem, DownloadJob, GrabbedImage } from '../lib/types'

const logger = initLogger('grabber')

/** 缩略图加载失败日志上限（避免整册失败时刷屏；角标仍会逐张标注） */
const MAX_THUMB_FAIL_LOGS = 5

export interface GrabViewOptions {
  srcTabId: number
  /** 下载文件夹名（每次下载时调用） */
  getFolderName: () => string
  /** 图片名前缀 = 相册名（默认 = 文件夹名；buondua 等可提供纯相册名） */
  getAlbumName?: () => string
  onReparse?: () => void
  onLoadMore?: () => void
  onCancelParse?: () => void
  /** 控制工具栏是否显示「重新解析」「下一批」（imgbb 场景由专用控制行代替） */
  showReparse?: boolean
  showLoadMore?: boolean
}

export interface GrabViewHandle {
  appendImages(images: GrabbedImage[]): void
  setParseProgress(scanned: number, total: number): void
  setParseText(text: string): void
  setBusyParsing(busy: boolean): void
  /** loading=true 时按钮显示「加载中…」；否则显示「加载下一批」（仅 enabled 时可点） */
  setLoadMoreEnabled(enabled: boolean, loading?: boolean): void
  setDownloadJob(job: DownloadJob | null): void
  selectAll(): void
  clear(): void
}

interface SizeGroup {
  minW: number
  minH: number
  maxW: number
  maxH: number
  count: number
}

export function createGrabView(root: HTMLElement, options: GrabViewOptions): GrabViewHandle {
  const showReparse = options.showReparse ?? true
  const showLoadMore = options.showLoadMore ?? true

  // ---------- 状态 ----------
  let images: GrabbedImage[] = []
  /** 缩略图加载失败计数（仅用于日志限流） */
  let thumbFailCount = 0

  /** 图片直接加载失败的兜底（2026-10-08）：经 background 取字节转 blob 显示
   *  背景：kaizty 等站的图片 URL 可正常取得字节（外部验证 200），但扩展页 <img> 加载/解码失败
   *  → 用本地 blob 绕过加载限制；同时记录体积与文件头，用于判断是否为格式或截断问题 */
  async function recoverThumb(el: HTMLImageElement, url: string): Promise<number | null> {
    try {
      const res = await sendMessage<{ ok: true; data?: string } | { ok: false; error: string }>({
        type: 'GRAB_FETCH_IMAGE',
        srcTabId: options.srcTabId,
        url,
      })
      if (!res.ok || !res.data) return null
      const bin = atob(res.data)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const head = Array.from(bytes.slice(0, 4))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
      logger.info('view', '图片兜底取字节成功（改用 blob 显示）', { url, bytes: bytes.length, head })
      el.src = URL.createObjectURL(new Blob([bytes]))
      return bytes.length
    } catch (err) {
      logger.warn('view', '图片兜底取字节失败', { url, error: String(err) })
      return null
    }
  }
  let selected = new Set<string>()
  let filterSize: { w: number; h: number } | null = null
  let job: DownloadJob | null = null
  let zipState: { current: number; total: number } | null = null
  let dedupeOn = true
  let filterSmallOn = true // 默认剔除 <100x100 小图

  // ---------- DOM 构建 ----------
  root.innerHTML = `
    <div class="images-view">
      <div class="toolbar">
        <div class="group">
          ${showReparse ? '<button id="gv-reparse" class="btn">重新解析</button>' : ''}
          ${showLoadMore ? '<button id="gv-load-more" class="btn" disabled>加载下一批</button>' : ''}
          <button id="gv-dedupe" class="btn">去重</button>
          <button id="gv-small-filter" class="btn">小图过滤</button>
        </div>
        <div class="group">
          <button id="gv-select-all" class="btn">全选</button>
          <button id="gv-select-none" class="btn">取消选择</button>
          <span id="gv-stat" class="stat-text">0 张</span>
        </div>
        <div class="group">
          <button id="gv-download" class="btn primary">下载选中</button>
          <button id="gv-zip" class="btn">打包下载</button>
          <button id="gv-folder" class="btn">打开文件夹</button>
        </div>
      </div>
      <div class="size-filter-bar">
        <span class="size-filter-label">尺寸筛选</span>
        <div id="gv-size-btns" class="size-btns"></div>
      </div>
      <div class="progress-area">
        <div class="progress-row" id="gv-parse-row">
          <span class="progress-label">解析</span>
          <div class="progress-bar"><div id="gv-parse-fill" class="progress-fill"></div></div>
          <span id="gv-parse-text" class="progress-text"></span>
          ${options.onCancelParse ? '<button id="gv-parse-cancel" class="btn danger">取消</button>' : ''}
        </div>
        <div class="progress-row" id="gv-dl-row" style="display:none">
          <span class="progress-label" id="gv-dl-label">下载</span>
          <div class="progress-bar"><div id="gv-dl-fill" class="progress-fill"></div></div>
          <span id="gv-dl-text" class="progress-text"></span>
          <button id="gv-dl-cancel" class="btn danger">取消</button>
        </div>
      </div>
      <div class="grid" id="gv-grid"></div>
      <div class="failed-area" id="gv-failed" style="display:none"></div>
    </div>
  `

  const grid = root.querySelector('#gv-grid') as HTMLElement
  const statEl = root.querySelector('#gv-stat') as HTMLElement
  const parseFill = root.querySelector('#gv-parse-fill') as HTMLElement
  const parseText = root.querySelector('#gv-parse-text') as HTMLElement
  const btnParseCancel = root.querySelector('#gv-parse-cancel') as HTMLButtonElement | null
  const btnLoadMore = root.querySelector('#gv-load-more') as HTMLButtonElement | null
  const btnDedupe = root.querySelector('#gv-dedupe') as HTMLButtonElement
  const btnSmallFilter = root.querySelector('#gv-small-filter') as HTMLButtonElement
  const dlRow = root.querySelector('#gv-dl-row') as HTMLElement
  const dlLabel = root.querySelector('#gv-dl-label') as HTMLElement
  const dlFill = root.querySelector('#gv-dl-fill') as HTMLElement
  const dlText = root.querySelector('#gv-dl-text') as HTMLElement
  const failedArea = root.querySelector('#gv-failed') as HTMLElement
  const sizeBtns = root.querySelector('#gv-size-btns') as HTMLElement

  // ---------- 工具 ----------
  function downloadUrlOf(img: GrabbedImage): string {
    return img.downloadUrl ?? img.url
  }

  function collectSelectedItems(): DownloadItem[] {
    // 命名顺序 = 抓取顺序（images 数组顺序）：
    // - 多页图站：页序 × 页内 DOM 序（fetchAlbumAllPages 串行按页收集）
    // - imgbb：翻页序；主抓取页：DOM / 滚动序
    // 注意：禁止按 URL 字典序重排——曾导致 hash / base64 文件名的站点（imgbb、phimvuspot 等）
    //      编号与页面顺序错位（变更日志 2026-09-29-004）
    const items: { url: string }[] = []
    for (const img of images) {
      if (selected.has(img.url)) items.push({ url: downloadUrlOf(img) })
    }
    const albumName = options.getAlbumName ? options.getAlbumName() : ''
    return items.map((u, i) => ({ url: u.url, filename: extractFilename(u.url, i + 1, albumName || undefined) }))
  }

  // ---------- 去重 ----------
  function normalizeKey(url: string): string {
    try {
      const u = new URL(url)
      u.hash = ''
      u.search = ''
      const dir = u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1)
      let name = u.pathname.split('/').pop() || ''
      name = name.replace(/\.[a-z0-9]+$/i, '')
      name = name.replace(/[-_](thumb|small|medium|large|thumbnail|s|m|l|orig|original)$/i, '')
      name = name.replace(/[-_]?\d{2,4}x\d{2,4}$/i, '')
      name = name.replace(/[-_]w\d+$/i, '')
      return `${u.host}${dir}${name}`
    } catch {
      return url
    }
  }

  function applyDedupe(list: GrabbedImage[]): { kept: GrabbedImage[]; removed: Set<string> } {
    if (!dedupeOn) return { kept: list, removed: new Set() }
    const groups = new Map<string, GrabbedImage[]>()
    for (const img of list) {
      const key = normalizeKey(downloadUrlOf(img))
      const arr = groups.get(key)
      if (arr) arr.push(img)
      else groups.set(key, [img])
    }
    const kept: GrabbedImage[] = []
    const removed = new Set<string>()
    for (const arr of groups.values()) {
      const sorted = [...arr].sort(
        (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
      )
      kept.push(sorted[0])
      for (let i = 1; i < sorted.length; i++) removed.add(sorted[i].url)
    }
    return { kept, removed }
  }

  // ---------- 小图过滤（默认剔除 <100x100；仅作用于渲染/选择，images 全量保留） ----------
  function isSmallImage(img: GrabbedImage): boolean {
    if (img.sizeStatus !== 'ok' || !img.width || !img.height) return false
    return img.width < 100 || img.height < 100
  }

  function applySmallFilter(list: GrabbedImage[]): GrabbedImage[] {
    if (!filterSmallOn) return list
    return list.filter((img) => !isSmallImage(img))
  }

  /** 最终可见列表：去重 → 尺寸筛选 → 小图过滤 */
  function visibleImages(): GrabbedImage[] {
    const { kept } = applyDedupe(images)
    return applySmallFilter(applyFilter(kept))
  }

  // ---------- 缩略图显示：服务器 thumbUrl 优先，无则直接原图（浏览器小容器自动降采样） ----------
  function displayUrlOf(img: GrabbedImage): string {
    return img.thumbUrl || img.url
  }

  // ---------- 尺寸筛选 ----------
  function applyFilter(list: GrabbedImage[]): GrabbedImage[] {
    const fs = filterSize
    if (!fs) return list
    return list.filter((img) => {
      if (img.sizeStatus !== 'ok' || !img.width || !img.height) return false
      return img.width * img.height >= fs.w * fs.h
    })
  }

  function buildSizeGroups(): SizeGroup[] {
    const okImages = applySmallFilter(applyDedupe(images).kept).filter((img) => img.sizeStatus === 'ok' && img.width && img.height)
    const unique = new Map<string, { w: number; h: number }>()
    for (const img of okImages) {
      unique.set(`${img.width}x${img.height}`, { w: img.width as number, h: img.height as number })
    }
    const sizes = [...unique.values()].sort((a, b) => b.w * b.h - a.w * a.h)

    const groups: SizeGroup[] = []
    const used = new Set<number>()
    for (let i = 0; i < sizes.length; i++) {
      if (used.has(i)) continue
      used.add(i)
      let minW = sizes[i].w
      let minH = sizes[i].h
      let maxW = sizes[i].w
      let maxH = sizes[i].h
      for (let j = i + 1; j < sizes.length; j++) {
        if (used.has(j)) continue
        const s = sizes[j]
        if (Math.abs(s.w - sizes[i].w) <= 100 && Math.abs(s.h - sizes[i].h) <= 100) {
          used.add(j)
          minW = Math.min(minW, s.w)
          minH = Math.min(minH, s.h)
          maxW = Math.max(maxW, s.w)
          maxH = Math.max(maxH, s.h)
        }
      }
      const area = minW * minH
      const count = okImages.filter((img) => (img.width as number) * (img.height as number) >= area).length
      groups.push({ minW, minH, maxW, maxH, count })
    }
    return groups
  }

  function renderSizeFilter(): void {
    sizeBtns.innerHTML = ''
    const groups = buildSizeGroups()
    if (groups.length === 0) {
      sizeBtns.innerHTML = '<span class="size-hint">解析完成后在此按尺寸筛选</span>'
      return
    }
    for (const group of groups) {
      const btn = document.createElement('button')
      btn.className = 'size-btn'
      const active = filterSize !== null && filterSize.w === group.minW && filterSize.h === group.minH
      if (active) btn.classList.add('active')
      btn.textContent = `≥${group.maxW}×${group.maxH}（${group.count}）`
      const rangeText =
        group.minW === group.maxW && group.minH === group.maxH
          ? `${group.minW}×${group.minH}`
          : `${group.minW}×${group.minH} ~ ${group.maxW}×${group.maxH}`
      btn.title = `覆盖范围 ${rangeText}；点击筛选不小于该范围的图片，再点一次清除`
      btn.addEventListener('click', () => {
        if (filterSize && filterSize.w === group.minW && filterSize.h === group.minH) {
          filterSize = null
        } else {
          filterSize = { w: group.minW, h: group.minH }
        }
        renderSizeFilter()
        renderGrid()
        updateStats()
      })
      sizeBtns.appendChild(btn)
    }
  }

  // ---------- 渲染 ----------
  function updateStats(): void {
    const { kept, removed } = applyDedupe(images)
    const filtered = applyFilter(kept)
    const shown = applySmallFilter(filtered)
    const smallRemoved = filtered.length - shown.length
    const dedupeText = removed.size > 0 ? `（去重 ${removed.size}）` : ''
    const smallText = smallRemoved > 0 ? `（小图剔除 ${smallRemoved}）` : ''
    statEl.textContent = `共 ${images.length} 张${dedupeText}${smallText}，显示 ${shown.length} 张，选中 ${selected.size} 张`
  }

  function renderGrid(): void {
    const filtered = visibleImages()
    grid.innerHTML = ''
    if (filtered.length === 0) {
      const { kept } = applyDedupe(images)
      if (images.length === 0) {
        grid.innerHTML = '<div class="empty-tip">暂无图片。请先抓取/解析。</div>'
      } else if (kept.length === 0) {
        grid.innerHTML = '<div class="empty-tip">去重后无剩余图片。可关闭去重查看。</div>'
      } else {
        grid.innerHTML = '<div class="empty-tip">当前筛选/小图过滤条件下没有图片。可调整筛选查看。</div>'
      }
      updateStats()
      return
    }
    let staggerIndex = 0
    for (const img of filtered) {
      const card = document.createElement('div')
      card.className = 'img-card' + (selected.has(img.url) ? ' selected' : '')
      card.dataset.url = img.url

      const thumb = document.createElement('img')
      thumb.className = 'thumb'
      thumb.loading = 'lazy'
      thumb.decoding = 'async'
      thumb.draggable = false
      // 2026-10-08：扩展页 Referer 为 chrome-extension://，部分站点据此判为盗链 → 不发送 Referer
      thumb.referrerPolicy = 'no-referrer'

      const sizeTag = document.createElement('div')
      const restoreSizeTag = (): void => {
        sizeTag.style.cursor = ''
        sizeTag.className = 'size-tag' + (img.sizeStatus === 'ok' ? '' : ' unknown')
        sizeTag.textContent =
          img.sizeStatus === 'ok' ? `${img.width}×${img.height}` : img.sizeStatus === 'loading' ? '尺寸获取中…' : '尺寸未知'
      }
      restoreSizeTag()

      // 五级容错（2026-10-10）：错开加载 → 失败延迟重试 → blob 兜底 → 标记失败 → 手动重试入口
      // 依据：实测该图床（i0.wp.com Photon）的失败是**暂时性**的（新标签可打开、网页端稍后自行恢复）
      //       → 多为突发并发限流，故先降并发、再重试，最后才用 background 取字节兜底
      let attempt = 0
      const MAX_RETRY = 2
      /** 生成加载 URL；force=true 时附加时间戳强制重新请求（绕过浏览器对失败结果的缓存） */
      const loadSrc = (force: boolean): string => {
        const base = displayUrlOf(img)
        return force ? `${base}${base.includes('?') ? '&' : '?'}t=${Date.now()}` : base
      }
      const markFailed = (): void => {
        sizeTag.className = 'size-tag unknown'
        sizeTag.textContent = '加载失败（点击重试）'
        sizeTag.style.cursor = 'pointer'
        thumbFailCount++
        if (thumbFailCount <= MAX_THUMB_FAIL_LOGS) {
          logger.warn('view', '图片加载失败（重试与兜底均失败）', { url: img.url, failedTotal: thumbFailCount })
        } else if (thumbFailCount === MAX_THUMB_FAIL_LOGS + 1) {
          logger.warn('view', '图片加载失败过多，后续不再逐条记录', { failedTotal: thumbFailCount })
        }
      }
      // ⑤ 手动重试入口：只有处于「加载失败」状态时角标才可点（避免误触），且不触发卡片的选中切换
      sizeTag.addEventListener('click', (ev) => {
        if (!sizeTag.textContent?.startsWith('加载失败')) return
        ev.stopPropagation()
        attempt = 0
        sizeTag.style.cursor = ''
        sizeTag.textContent = '重试中…'
        logger.info('view', '手动重试加载图片', { url: img.url })
        thumb.src = loadSrc(true)
      })
      // 加载成功（含错峰、自动重试、手动重试成功）：补齐尺寸并恢复角标
      // 1) 回归修复（2026-10-10）：此前缺少 load 处理，重试成功的图角标滞留在「重试中 N/2…」，看不到尺寸
      // 2) 尺寸补齐：多页图站的图片由后台解析（只给 URL，无宽高），原本恒显示「尺寸未知」；
      //    图片加载后可直接读取真实像素尺寸，零额外请求即可显示尺寸并修正统计
      thumb.addEventListener('load', () => {
        if ((!img.width || !img.height) && thumb.naturalWidth > 0 && thumb.naturalHeight > 0) {
          img.width = thumb.naturalWidth
          img.height = thumb.naturalHeight
          img.sizeStatus = 'ok'
          updateStats()
        }
        restoreSizeTag()
      })
      thumb.addEventListener('error', () => {
        // ① 延迟重试：限流多为暂时性，错峰后重试常可成功
        if (attempt < MAX_RETRY) {
          attempt++
          sizeTag.textContent = `重试中 ${attempt}/${MAX_RETRY}…`
          window.setTimeout(
            () => {
              thumb.src = loadSrc(true)
            },
            1200 * attempt,
          )
          return
        }
        // ② 兜底：经 background 取字节转 blob 显示（同时记录体积与文件头用于诊断）
        sizeTag.textContent = '兜底加载中…'
        void recoverThumb(thumb, img.url).then((size) => {
          if (size === null) markFailed()
          else restoreSizeTag()
        })
      })

      // ③ 错开加载：避免一次性数十张并发请求触发图床限流（每张间隔 80ms，最多错开 2s）
      const staggerDelay = Math.min(staggerIndex++ * 80, 2000)
      if (staggerDelay === 0) {
        thumb.src = loadSrc(false)
      } else {
        window.setTimeout(() => {
          thumb.src = loadSrc(false)
        }, staggerDelay)
      }

      const check = document.createElement('div')
      check.className = 'check-mark'
      check.textContent = '✓'

      card.append(thumb, sizeTag, check)
      grid.appendChild(card)
    }
    updateStats()
  }

  function toggleSelect(url: string): void {
    if (selected.has(url)) {
      selected.delete(url)
    } else {
      selected.add(url)
    }
    const card = grid.querySelector<HTMLElement>(`.img-card[data-url="${CSS.escape(url)}"]`)
    card?.classList.toggle('selected')
    updateStats()
  }

  // ---------- 预览（双击触发，滚轮缩放，点击关闭） ----------
  let previewScale = 1

  function showPreview(img: GrabbedImage): void {
    const layer = document.getElementById('preview-layer')
    const previewImg = document.getElementById('preview-img') as HTMLImageElement | null
    const previewSize = document.getElementById('preview-size')
    if (!layer || !previewImg || !previewSize) return
    previewScale = 1
    previewImg.style.transform = ''
    // 同网格：预览也不发送扩展页 Referer（避免防盗链站点拒绝）
    previewImg.referrerPolicy = 'no-referrer'
    previewImg.src = downloadUrlOf(img)
    previewSize.textContent =
      (img.sizeStatus === 'ok' ? `${img.width}×${img.height}` : '尺寸未知') + ' · 滚轮缩放 · 点击关闭'
    layer.classList.remove('hidden')
  }

  function hidePreview(): void {
    document.getElementById('preview-layer')?.classList.add('hidden')
  }

  const previewLayer = document.getElementById('preview-layer')
  previewLayer?.addEventListener('click', hidePreview)
  previewLayer?.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const previewImg = document.getElementById('preview-img') as HTMLImageElement | null
      if (!previewImg) return
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
      previewScale = Math.min(4, Math.max(0.25, previewScale * factor))
      previewImg.style.transform = `scale(${previewScale})`
    },
    { passive: false },
  )

  // ---------- 鼠标交互：单击/双击/拖拽（每张只变更一次） ----------
  let drag: { startX: number; startY: number; dragging: boolean } | null = null
  let dragTouched = new Set<string>()
  let lastClickUrl = ''
  let lastClickTime = 0

  grid.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    drag = { startX: e.clientX, startY: e.clientY, dragging: false }
    dragTouched = new Set()
    e.preventDefault()
  })

  grid.addEventListener('mousemove', (e) => {
    if (!drag) return
    const dx = Math.abs(e.clientX - drag.startX)
    const dy = Math.abs(e.clientY - drag.startY)
    if (!drag.dragging && (dx > 5 || dy > 5)) {
      drag.dragging = true
    }
    if (drag.dragging) {
      const rect = {
        left: Math.min(drag.startX, e.clientX),
        top: Math.min(drag.startY, e.clientY),
        right: Math.max(drag.startX, e.clientX),
        bottom: Math.max(drag.startY, e.clientY),
      }
      for (const card of Array.from(grid.querySelectorAll<HTMLElement>('.img-card'))) {
        const url = card.dataset.url
        if (!url) continue
        if (dragTouched.has(url)) continue
        const cr = card.getBoundingClientRect()
        const hit = cr.right > rect.left && cr.left < rect.right && cr.bottom > rect.top && cr.top < rect.bottom
        if (hit) {
          dragTouched.add(url)
          if (selected.has(url)) {
            selected.delete(url)
            card.classList.remove('selected')
          } else {
            selected.add(url)
            card.classList.add('selected')
          }
        }
      }
      updateStats()
    }
  })

  grid.addEventListener('mouseup', (e) => {
    if (!drag) return
    const wasDrag = drag.dragging
    drag = null
    dragTouched = new Set()
    if (wasDrag) return

    const card = (e.target as HTMLElement).closest('.img-card') as HTMLElement | null
    const url = card?.dataset.url
    if (!url) return

    const now = Date.now()
    if (lastClickUrl === url && now - lastClickTime < 280) {
      // 双击：撤销第一次单击的切换（选中状态不变），显示大图预览
      toggleSelect(url)
      lastClickUrl = ''
      lastClickTime = 0
      const img = images.find((i) => i.url === url)
      if (img) showPreview(img)
    } else {
      toggleSelect(url)
      lastClickUrl = url
      lastClickTime = now
    }
  })

  // ---------- 下载渲染 ----------
  function renderDownload(): void {
    if (!job) {
      dlRow.style.display = 'none'
      return
    }
    dlRow.style.display = 'flex'
    dlLabel.textContent = '下载'
    const doneCount = job.done + job.failed
    const pct = job.total > 0 ? Math.round((doneCount / job.total) * 100) : 0
    dlFill.style.width = `${pct}%`
    dlFill.classList.toggle('done', job.status === 'done')
    const statusText =
      job.status === 'running' ? '下载中' : job.status === 'cancelled' ? '已取消' : job.status === 'done' ? '完成' : '异常'
    dlText.innerHTML = `${statusText} ${doneCount}/${job.total} <span class="stat-text">成功 ${job.done}</span> <span class="stat-fail">失败 ${job.failed}</span>`
    renderFailed()
  }

  function renderZip(): void {
    if (!zipState) {
      if (!job) dlRow.style.display = 'none'
      return
    }
    dlRow.style.display = 'flex'
    dlLabel.textContent = '打包'
    const pct = Math.round((zipState.current / zipState.total) * 100)
    dlFill.style.width = `${pct}%`
    dlFill.classList.remove('done')
    dlText.textContent = `打包中 ${zipState.current}/${zipState.total}（${pct}%）`
  }

  function renderFailed(): void {
    const items = job?.failedItems ?? []
    failedArea.style.display = items.length ? 'block' : 'none'
    failedArea.innerHTML = ''
    for (const item of items) {
      const row = document.createElement('div')
      row.className = 'failed-item'
      const urlSpan = document.createElement('span')
      urlSpan.className = 'url'
      urlSpan.textContent = item.filename
      const retryBtn = document.createElement('button')
      retryBtn.className = 'btn retry-btn'
      retryBtn.textContent = '重试'
      retryBtn.addEventListener('click', () => {
        if (job) void sendMessage({ type: 'GRAB_DOWNLOAD_RETRY', jobId: job.id })
      })
      row.append(urlSpan, retryBtn)
      failedArea.appendChild(row)
    }
  }

  // ---------- 下载 / 打包 / 打开文件夹（组件内置，统一行为） ----------
  async function startDownload(): Promise<void> {
    const items = collectSelectedItems()
    if (items.length === 0) return
    const res = await sendMessage({
      type: 'GRAB_DOWNLOAD_START',
      srcTabId: options.srcTabId,
      folderName: options.getFolderName(),
      items,
    })
    if (res.ok && res.job) {
      job = res.job
      renderDownload()
      logger.info('grab-view', '开始下载', { jobId: job.id, count: items.length })
    }
  }

  async function zipDownload(): Promise<void> {
    const items = collectSelectedItems()
    if (items.length === 0) return
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] })
    if (!granted) {
      logger.warn('grab-view', '用户未授权 host 权限，打包取消')
      return
    }
    zipState = { current: 0, total: items.length }
    renderZip()
    const zip = new JSZip()
    let okCount = 0
    // 打包并发 = 全局下载并发设置（imgbb/buondua/通用统一生效），读取失败回退默认 12
    const ccRes = await sendMessage<{ ok: true; concurrency: number } | { ok: false; error: string }>({ type: 'GRAB_GET_CONCURRENCY' })
    const CONCURRENCY = Math.max(1, Math.min(128, ccRes.ok ? ccRes.concurrency : 12))
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++
        if (idx >= items.length) return
        const item = items[idx]
        const t0 = Date.now()
        try {
          let blob: Blob | null = null
          if (/(i\.ibb\.co|ibb\.co)/.test(item.url)) {
            // imgbb：background 抓取字节（内部优先源页注入拿原图，失败降级 SW fetch）
            // 响应为 base64 字符串（runtime message 为 JSON 序列化，ArrayBuffer 直传会丢失数据）
            const res = await sendMessage<{ ok: true; data?: string } | { ok: false; error: string }>({
              type: 'GRAB_FETCH_IMAGE',
              srcTabId: options.srcTabId,
              url: item.url,
            })
            if (res.ok && res.data) {
              const bin = atob(res.data)
              const bytes = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
              blob = new Blob([bytes])
            }
          } else {
            const resp = await fetch(item.url)
            if (resp.ok) blob = await resp.blob()
          }
          if (blob) {
            zip.file(item.filename, blob)
            okCount++
          }
          logger.debug('grab-view', '打包单图完成', { url: item.url, ms: Date.now() - t0, bytes: blob?.size })
        } catch (err) {
          logger.warn('grab-view', '打包抓取图片失败', { url: item.url, error: String(err) })
        }
        zipState!.current = Math.min(items.length, zipState!.current + 1)
        renderZip()
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => worker()))
    // STORE：图片本身已压缩（jpg/png），跳过 DEFLATE 纯 CPU 开销，体积几乎不变
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' })
    const objectUrl = URL.createObjectURL(blob)
    try {
      await chrome.downloads.download({ url: objectUrl, filename: `${options.getFolderName()}.zip` })
      logger.info('grab-view', '打包下载完成', { total: items.length, ok: okCount })
    } catch (err) {
      logger.error('grab-view', 'zip 下载失败', String(err))
    }
    URL.revokeObjectURL(objectUrl)
    zipState = null
    renderZip()
  }

  // ---------- 事件 ----------
  root.querySelector('#gv-reparse')?.addEventListener('click', () => options.onReparse?.())
  btnLoadMore?.addEventListener('click', () => {
    if (btnLoadMore.disabled) return
    btnLoadMore.disabled = true
    btnLoadMore.textContent = '加载中…'
    options.onLoadMore?.()
  })
  btnParseCancel?.addEventListener('click', () => {
    if (btnParseCancel) btnParseCancel.disabled = true
    options.onCancelParse?.()
  })
  root.querySelector('#gv-select-all')?.addEventListener('click', () => {
    selected = new Set(visibleImages().map((img) => img.url))
    renderGrid()
  })
  root.querySelector('#gv-select-none')?.addEventListener('click', () => {
    selected.clear()
    renderGrid()
  })
  root.querySelector('#gv-download')?.addEventListener('click', () => void startDownload())
  root.querySelector('#gv-zip')?.addEventListener('click', () => void zipDownload())
  root.querySelector('#gv-folder')?.addEventListener('click', () => void sendMessage({ type: 'GRAB_OPEN_FOLDER' }))
  root.querySelector('#gv-dl-cancel')?.addEventListener('click', () => {
    if (job && job.status === 'running') {
      void sendMessage({ type: 'GRAB_DOWNLOAD_CANCEL', jobId: job.id })
    }
  })
  btnDedupe.addEventListener('click', () => {
    dedupeOn = !dedupeOn
    const { removed } = applyDedupe(images)
    for (const url of removed) selected.delete(url)
    btnDedupe.classList.toggle('active', dedupeOn)
    btnDedupe.textContent = dedupeOn ? '去重：开' : '去重：关'
    renderSizeFilter()
    renderGrid()
  })

  btnSmallFilter.addEventListener('click', () => {
    filterSmallOn = !filterSmallOn
    // 移除选中中被过滤的小图
    const visible = visibleImages()
    selected = new Set([...selected].filter((url) => visible.some((img) => img.url === url)))
    btnSmallFilter.classList.toggle('active', filterSmallOn)
    btnSmallFilter.textContent = filterSmallOn ? '小图过滤：开' : '小图过滤：关'
    renderSizeFilter()
    renderGrid()
  })

  // ---------- 初始 ----------
  renderDedupeBtn()
  renderSmallFilterBtn()
  renderSizeFilter()
  renderGrid()

  function renderDedupeBtn(): void {
    btnDedupe.classList.toggle('active', dedupeOn)
    btnDedupe.textContent = dedupeOn ? '去重：开' : '去重：关'
  }

  function renderSmallFilterBtn(): void {
    btnSmallFilter.classList.toggle('active', filterSmallOn)
    btnSmallFilter.textContent = filterSmallOn ? '小图过滤：开' : '小图过滤：关'
  }

  // ---------- 对外句柄 ----------
  return {
    appendImages: (list) => {
      images = images.concat(list)
      renderSizeFilter()
      renderGrid()
    },
    setParseProgress: (scanned, total) => {
      const pct = total > 0 ? Math.round((scanned / total) * 100) : 0
      parseFill.style.width = `${pct}%`
      parseFill.classList.toggle('done', total > 0 && scanned >= total)
      parseText.textContent = total > 0 ? `${scanned} / ${total}（${pct}%）` : '等待解析…'
    },
    setParseText: (text) => {
      parseText.textContent = text
    },
    setBusyParsing: (busy) => {
      if (btnParseCancel) btnParseCancel.disabled = !busy
    },
    setLoadMoreEnabled: (enabled, loading = false) => {
      if (!btnLoadMore) return
      btnLoadMore.disabled = !enabled
      btnLoadMore.textContent = loading ? '加载中…' : '加载下一批'
    },
    setDownloadJob: (j) => {
      job = j
      renderDownload()
    },
    selectAll: () => {
      selected = new Set(visibleImages().map((img) => img.url))
      renderGrid()
    },
    clear: () => {
      images = []
      selected.clear()
      filterSize = null
      renderSizeFilter()
      renderGrid()
    },
  }
}
