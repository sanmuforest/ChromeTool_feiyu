// buondua 适配页（FP-004）：多页相册站点
// 三个子选项卡：
//   1. 抓取：输入相册 URL → 抓取全部子页图片 → 去重 → 共享抓取视图
//   2. 批量抓取推荐链接：解析 bottom-articles 推荐相册 → 勾选批量抓取（独立文件夹）
//   3. 批量抓取其他链接：解析 popular-item 其他相册 → 同上
// 链接列表按批展示（10/批），抓完一批可点「下一批」继续

import { initLogger } from '../lib/logger'
import { sendMessage, type BuonduaBatchItem, type BuonduaResultKind, type SearchSiteResult } from '../lib/messages'
import { extractBuonduaAlbumName, extractBuonduaAlbumShortName } from '../lib/buondua-parse'
import { GALLERY_SITES, matchGallerySite } from '../lib/gallery-sites'
import { extractJrantsFolderName } from '../lib/jrants-parse'
import { extractPixibbFolderName } from '../lib/pixibb-parse'
import type { BuonduaImage, BuonduaLinkItem, DownloadJob, GrabbedImage } from '../lib/types'
import { createGrabView, type GrabViewHandle } from './image-grab-view'

const logger = initLogger('grabber')

const BATCH_SIZE = 10 // 链接列表每批数量

export interface BuonduaViewHandle {
  onResult(kind: BuonduaResultKind, data: BuonduaImage[] | BuonduaLinkItem[] | BuonduaBatchItem | SearchSiteResult, done: boolean, error?: string): void
  onDownloadProgress(job: DownloadJob): void
  onDownloadDone(job: DownloadJob): void
}

/** BuonduaImage → GrabbedImage */
function toGrabbed(img: BuonduaImage): GrabbedImage {
  return {
    id: img.url,
    url: img.url,
    downloadUrl: img.url,
    width: img.width,
    height: img.height,
    sizeStatus: img.width && img.height ? 'ok' : 'unknown',
  }
}

/** 文件夹名 = 页面名（按站点路由：jrants/pixibb 用标题直接清洗，其余用 buondua 规则） */
export function buildBuonduaFolderName(title: string, url: string): string {
  const site = matchGallerySite(url)
  if (site?.id === 'jrants') return extractJrantsFolderName(title)
  if (site?.id === 'pixibb') return extractPixibbFolderName(title)
  return extractBuonduaAlbumName(title, url)
}

interface LinkListHandle {
  show(items: BuonduaLinkItem[]): void
  setBusy(busy: boolean): void
}

export function initBuonduaView(root: HTMLElement, srcTabId: number, sourceUrl?: string): BuonduaViewHandle {
  // ---------- DOM 构建（先于组件创建） ----------
  root.innerHTML = `
    <div class="adapters-view">
      <div class="adapter-head">
        <h3>多页图站</h3>
        <span class="adapter-hint">buondua / rrwsh / hitxhot / jrants / pixibb / kaizty：全子页抓取 / 推荐 / 其他链接批量抓取</span>
      </div>
      <div class="adapter-tabs">
        <button data-sub="bd-album" class="adapter-tab active">抓取</button>
        <button data-sub="bd-recommended" class="adapter-tab">批量抓取推荐链接</button>
        <button data-sub="bd-popular" class="adapter-tab">批量抓取其他链接</button>
        <button data-sub="bd-search" class="adapter-tab">聚合搜索</button>
      </div>

      <div id="sub-bd-album" class="adapter-panel active">
        <div class="row">
          <input id="bd-album-url" class="text-input" placeholder="相册 URL：buondua / rrwsh.uuss.uk / hitxhot.org / jrants.com / pixibb.com / kaizty.com">
          <button id="bd-album-fetch" class="btn primary">抓取全部子页</button>
        </div>
        <div id="bd-album-grab-view" class="grab-view-host"></div>
      </div>

      <div id="sub-bd-recommended" class="adapter-panel">
        <div class="row">
          <input id="bd-rec-url" class="text-input" placeholder="相册 URL（自动识别推荐相册）">
          <button id="bd-rec-scan" class="btn primary">识别推荐链接</button>
        </div>
        <div class="row">
          <button class="btn bd-select-all">全选本批/取消</button>
          <button class="btn bd-fetch-selected">抓取选中</button>
          <button class="btn bd-prev-batch">上一批</button>
          <button class="btn bd-next-batch">下一批</button>
          <span class="bd-batch-info status-text"></span>
          <span class="bd-list-status status-text"></span>
        </div>
        <div class="bd-link-list"></div>
        <div class="bd-batch-results"></div>
      </div>

      <div id="sub-bd-popular" class="adapter-panel">
        <div class="row">
          <input id="bd-pop-url" class="text-input" placeholder="相册 URL（扫描全页其他帖子链接）">
          <button id="bd-pop-scan" class="btn primary">扫描全部链接</button>
        </div>
        <div class="row">
          <button class="btn bd-select-all">全选本批/取消</button>
          <button class="btn bd-fetch-selected">抓取选中</button>
          <button class="btn bd-prev-batch">上一批</button>
          <button class="btn bd-next-batch">下一批</button>
          <span class="bd-batch-info status-text"></span>
          <span class="bd-list-status status-text"></span>
        </div>
        <div class="bd-link-list"></div>
        <div class="bd-batch-results"></div>
      </div>

      <div id="sub-bd-search" class="adapter-panel">
        <div class="row">
          <input id="bd-search-q" class="text-input" placeholder="关键词（聚合搜索多站点）">
          <select id="bd-search-pages" class="num-input" title="每站搜索页数">
            <option value="1">1 页/站</option>
            <option value="2" selected>2 页/站</option>
            <option value="3">3 页/站</option>
          </select>
          <button id="bd-search-go" class="btn primary">聚合搜索</button>
        </div>
        <div class="row">
          <div id="bd-search-sites" class="bd-search-sites"></div>
          <span id="bd-search-site-status" class="status-text"></span>
        </div>
        <div class="row">
          <button id="bd-google-test" class="btn">测试 Google 连接</button>
          <span id="bd-google-status" class="status-text"></span>
        </div>
        <div class="row">
          <button class="btn bd-select-all">全选本批/取消</button>
          <button class="btn bd-fetch-selected">抓取选中</button>
          <button class="btn bd-prev-batch">上一批</button>
          <button class="btn bd-next-batch">下一批</button>
          <span class="bd-batch-info status-text"></span>
          <span class="bd-list-status status-text"></span>
        </div>
        <div class="bd-link-list bd-search-list"></div>
        <div class="bd-batch-results"></div>
      </div>
    </div>
  `

  // ---------- 状态 ----------
  let lastAlbumFolder = `ID-buondua-相册-${Date.now()}`
  let lastAlbumShort = 'album' // 图片名前缀（纯相册名）
  const batchViews = new Map<number, GrabViewHandle>() // index → grab view
  const batchFolders = new Map<number, string>() // index → folderName
  const batchAlbumNames = new Map<number, string>() // index → 图片名前缀
  const linkLists: LinkListHandle[] = []

  // ---------- 子标签切换 ----------
  root.querySelectorAll<HTMLElement>('.adapter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      root.querySelectorAll('.adapter-tab').forEach((t) => t.classList.remove('active'))
      tab.classList.add('active')
      root.querySelectorAll('.adapter-panel').forEach((p) => {
        p.classList.toggle('active', p.id === `sub-${tab.dataset.sub}`)
      })
    })
  })

  // ---------- 工具 ----------
  function setStatus(el: Element | null, text: string, isError = false): void {
    if (!el) return
    el.textContent = text
    el.classList.toggle('error', isError)
  }

  async function ensureHostPermission(): Promise<boolean> {
    try {
      if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true
      return await chrome.permissions.request({ origins: ['<all_urls>'] })
    } catch {
      return false
    }
  }

  // ---------- 抓取（全子页） ----------
  const albumGrabView = createGrabView(root.querySelector('#bd-album-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => lastAlbumFolder,
    getAlbumName: () => lastAlbumShort,
    showReparse: false,
    showLoadMore: false,
  })

  const albumUrlInput = root.querySelector('#bd-album-url') as HTMLInputElement
  root.querySelector('#bd-album-fetch')?.addEventListener('click', async () => {
    const url = albumUrlInput.value.trim()
    if (!url) {
      albumGrabView.setParseText('请填写相册 URL')
      return
    }
    if (!(await ensureHostPermission())) {
      albumGrabView.setParseText('需要授权访问 buondua（<all_urls>）后才能抓取')
      return
    }
    albumGrabView.clear()
    albumGrabView.setBusyParsing(true)
    albumGrabView.setParseText('抓取全部子页中…')
    const res = await sendMessage<{ ok: true; name?: string } | { ok: false; error: string }>({
      type: 'BD_FETCH_ALBUM',
      srcTabId,
      url,
    })
    if (res.ok) {
      // 文件夹名 = 页面标题（后台解析 h1），失败兜底 URL；图片名前缀 = 纯相册名
      lastAlbumFolder = buildBuonduaFolderName(res.name ?? url, url)
      lastAlbumShort = extractBuonduaAlbumShortName(res.name ?? url)
    } else {
      albumGrabView.setBusyParsing(false)
      albumGrabView.setParseText(`请求失败：${res.error}`)
    }
  })

  // ---------- 批量抓取面板（推荐 / 其他） ----------
  function setupBatchPanel(panelId: string, kind: 'recommended' | 'popular'): LinkListHandle {
    const panel = root.querySelector(`#sub-${panelId}`) as HTMLElement
    const urlInput = panel.querySelector('.row .text-input') as HTMLInputElement
    const scanBtn = panel.querySelector('.btn.primary') as HTMLButtonElement
    const listEl = panel.querySelector('.bd-link-list') as HTMLElement
    const resultsHost = panel.querySelector('.bd-batch-results') as HTMLElement
    const statusEl = panel.querySelector('.bd-list-status') as HTMLElement
    const btnSelectAll = panel.querySelector('.bd-select-all') as HTMLButtonElement
    const btnFetch = panel.querySelector('.bd-fetch-selected') as HTMLButtonElement
    const btnNext = panel.querySelector('.bd-next-batch') as HTMLButtonElement
    const btnPrev = panel.querySelector('.bd-prev-batch') as HTMLButtonElement
    const batchInfo = panel.querySelector('.bd-batch-info') as HTMLElement

    // ---------- 链接列表状态 ----------
    let items: BuonduaLinkItem[] = []
    let page = 0
    const selected = new Set<number>()
    const pageCount = () => Math.ceil(items.length / BATCH_SIZE)

    function renderList(): void {
      listEl.innerHTML = ''
      if (items.length === 0) {
        listEl.innerHTML = '<div class="empty-tip">暂无链接。请先点击「识别链接」。</div>'
        btnNext.disabled = true
        btnPrev.disabled = true
        btnFetch.disabled = true
        btnSelectAll.disabled = true
        batchInfo.textContent = ''
        return
      }
      const start = page * BATCH_SIZE
      const slice = items.slice(start, start + BATCH_SIZE)
      for (const [i, item] of slice.entries()) {
        const globalIdx = start + i
        const card = document.createElement('div')
        card.className = 'bd-link-card' + (selected.has(globalIdx) ? ' selected' : '')
        card.dataset.idx = String(globalIdx)

        const cover = document.createElement('img')
        cover.className = 'bd-link-cover'
        cover.loading = 'lazy'
        cover.src = item.coverUrl || ''
        cover.draggable = false

        const info = document.createElement('div')
        info.className = 'bd-link-info'
        const title = document.createElement('div')
        title.className = 'bd-link-title'
        title.textContent = item.title
        const meta = document.createElement('div')
        meta.className = 'bd-link-meta'
        meta.textContent = item.imageCount !== undefined ? `${item.imageCount} 张` : '张数未知'
        info.append(title, meta)

        card.append(cover, info)
        card.addEventListener('click', () => {
          if (selected.has(globalIdx)) selected.delete(globalIdx)
          else selected.add(globalIdx)
          card.classList.toggle('selected', selected.has(globalIdx))
        })
        listEl.appendChild(card)
      }
      btnNext.disabled = page >= pageCount() - 1
      btnPrev.disabled = page <= 0
      btnFetch.disabled = false
      btnSelectAll.disabled = false
      batchInfo.textContent = `第 ${page + 1}/${pageCount()} 批（共 ${items.length} 个，本批 ${slice.length} 个）`
    }

    function setBusy(busy: boolean): void {
      btnFetch.disabled = busy
      btnSelectAll.disabled = busy
      btnNext.disabled = busy || page >= pageCount() - 1
      btnPrev.disabled = busy || page <= 0
      if (busy) {
        btnFetch.textContent = '抓取中…'
      } else {
        btnFetch.textContent = '抓取选中'
      }
    }

    // ---------- 事件 ----------
    btnSelectAll.addEventListener('click', () => {
      const start = page * BATCH_SIZE
      for (let i = start; i < Math.min(start + BATCH_SIZE, items.length); i++) {
        if (selected.has(i)) selected.delete(i)
        else selected.add(i)
      }
      renderList()
    })
    btnNext.addEventListener('click', () => {
      if (page < pageCount() - 1) {
        page++
        renderList()
      }
    })
    btnPrev.addEventListener('click', () => {
      if (page > 0) {
        page--
        renderList()
      }
    })
    btnFetch.addEventListener('click', () => {
      if (btnFetch.disabled) return
      const targets = [...selected]
        .sort((a, b) => a - b)
        .map((idx) => ({
          url: items[idx].url,
          folderName: buildBuonduaFolderName(items[idx].title, items[idx].url),
        }))
      if (targets.length === 0) {
        setStatus(statusEl, '请先勾选要抓取的相册', true)
        return
      }
      // 为每个目标创建独立结果卡片 + grab view
      resultsHost.innerHTML = ''
      batchViews.clear()
      batchFolders.clear()
      targets.forEach((target, idx) => {
        batchFolders.set(idx, target.folderName)
        batchAlbumNames.set(idx, extractBuonduaAlbumShortName(target.folderName))
        const card = document.createElement('div')
        card.className = 'bd-batch-card'
        const head = document.createElement('div')
        head.className = 'bd-batch-head'
        const title = document.createElement('span')
        title.className = 'bd-batch-title'
        title.textContent = target.folderName.replace(/^ID-buondua-/, '').replace(/-\d{8}_\d{6}$/, '')
        const status = document.createElement('span')
        status.className = 'bd-batch-status'
        status.textContent = '等待抓取…'
        head.append(title, status)
        const host = document.createElement('div')
        host.className = 'grab-view-host'
        card.append(head, host)
        resultsHost.appendChild(card)
        const grabView = createGrabView(host, {
          srcTabId,
          getFolderName: () => batchFolders.get(idx) ?? `ID-buondua-相册-${Date.now()}`,
          getAlbumName: () => batchAlbumNames.get(idx) ?? 'album',
          showReparse: false,
          showLoadMore: false,
        })
        grabView.setBusyParsing(true)
        grabView.setParseText('抓取中…')
        batchViews.set(idx, grabView)
      })
      setStatus(statusEl, `开始批量抓取 ${targets.length} 个相册（并发 3）…`)
      setBusy(true)
      void sendMessage({ type: 'BD_FETCH_ALBUMS', srcTabId, targets }).then((res) => {
        if (!res.ok) {
          setStatus(statusEl, `请求失败：${res.error}`, true)
          setBusy(false)
        }
      })
    })
    scanBtn.addEventListener('click', async () => {
      const url = urlInput.value.trim()
      if (!url) {
        setStatus(statusEl, '请填写相册 URL', true)
        return
      }
      if (!(await ensureHostPermission())) {
        setStatus(statusEl, '需要授权访问 buondua（<all_urls>）后才能识别', true)
        return
      }
      setStatus(statusEl, '识别链接中…')
      const res = await sendMessage({ type: 'BD_SCAN_LINKS', srcTabId, url, kind })
      if (!res.ok) {
        setStatus(statusEl, `请求失败：${res.error}`, true)
      }
      // 成功时结果经 BD_RESULT(scan) 推送
    })

    return {
      show: (list) => {
        items = list
        page = 0
        selected.clear()
        renderList()
        setStatus(statusEl, `识别完成：${items.length} 个链接`, false)
      },
      setBusy,
    }
  }

  const recList = setupBatchPanel('bd-recommended', 'recommended')
  const popList = setupBatchPanel('bd-popular', 'popular')
  linkLists.push(recList, popList)

  // ---------- 聚合搜索面板（FP-010：多站点搜索 → 结果列表复用批量抓取） ----------
  interface SearchListHandle extends LinkListHandle {
    append(items: BuonduaLinkItem[], error?: string, siteId?: string): void
    finish(): void
  }
  function setupSearchPanel(): SearchListHandle {
    const panel = root.querySelector('#sub-bd-search') as HTMLElement
    const queryInput = panel.querySelector('#bd-search-q') as HTMLInputElement
    const pagesInput = panel.querySelector('#bd-search-pages') as HTMLSelectElement
    const searchBtn = panel.querySelector('#bd-search-go') as HTMLButtonElement
    const siteBoxes = panel.querySelector('#bd-search-sites') as HTMLElement
    const siteStatus = panel.querySelector('#bd-search-site-status') as HTMLElement
    const listEl = panel.querySelector('.bd-link-list') as HTMLElement
    const resultsHost = panel.querySelector('.bd-batch-results') as HTMLElement
    const statusEl = panel.querySelector('.bd-list-status') as HTMLElement
    const btnSelectAll = panel.querySelector('.bd-select-all') as HTMLButtonElement
    const btnFetch = panel.querySelector('.bd-fetch-selected') as HTMLButtonElement
    const batchInfo = panel.querySelector('.bd-batch-info') as HTMLElement
    const googleTestBtn = panel.querySelector('#bd-google-test') as HTMLButtonElement
    const googleStatus = panel.querySelector('#bd-google-status') as HTMLElement
    const btnNext = panel.querySelector('.bd-next-batch') as HTMLButtonElement
    const btnPrev = panel.querySelector('.bd-prev-batch') as HTMLButtonElement

    // 站点勾选：支持搜索的站点可选（默认勾选 jrants/pixibb/rrwsh；hitxhot/kaizty 为 Google 通道，请求较慢，默认不勾选）；
    // 不支持的灰显禁用并标注原因（FP-012）
    const searchable = GALLERY_SITES.filter((s) => s.searchUrl)
    const defaultChecked = new Set(['jrants', 'pixibb', 'rrwsh'])
    const googleChannel = new Set(['hitxhot', 'kaizty'])
    const disabledNotes: Record<string, string> = {
      buondua: '站点不可达',
      imgbb: '无搜索（图床）',
    }
    const renderSiteBoxes = (): void => {
      const ok = searchable
        .map(
          (s) =>
            `<label class="bd-site-check"><input type="checkbox" value="${s.id}" ${defaultChecked.has(s.id) ? 'checked' : ''}> ${s.id}${googleChannel.has(s.id) ? '<span class="bd-site-note">（Google）</span>' : ''}</label>`,
        )
        .join('')
      const disabled = [...GALLERY_SITES.filter((s) => !s.searchUrl), { id: 'imgbb' }]
        .map(
          (s) =>
            `<label class="bd-site-check disabled" title="${disabledNotes[s.id] ?? '不支持搜索'}"><input type="checkbox" disabled> ${s.id}<span class="bd-site-note">（${disabledNotes[s.id] ?? '不支持'}）</span></label>`,
        )
        .join('')
      siteBoxes.innerHTML = ok + disabled
    }
    renderSiteBoxes()
    const selectedSites = (): string[] =>
      Array.from(siteBoxes.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')).map((c) => c.value)

    let items: BuonduaLinkItem[] = [] // 平铺全站结果（跨站不去重，各站分栏展示）
    let itemSites: string[] = [] // 与 items 同序：来源站点（徽标/分组用）
    const siteSeen = new Map<string, Set<string>>() // 站内 URL 去重
    let page = 0
    const selected = new Set<number>()
    const pageCount = () => Math.max(1, Math.ceil(items.length / BATCH_SIZE))
    let pendingSites = 0

    /** 创建结果卡片（大封面网格）：勾选框独立选中，点卡片打开相册页 */
    function makeCard(item: BuonduaLinkItem, globalIdx: number): HTMLDivElement {
      const card = document.createElement('div')
      card.className = 'bd-search-card' + (selected.has(globalIdx) ? ' selected' : '')
      card.dataset.idx = String(globalIdx)
      const badge = document.createElement('span')
      badge.className = 'bd-search-badge'
      badge.textContent = itemSites[globalIdx] ?? ''
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.className = 'bd-search-check'
      check.checked = selected.has(globalIdx)
      check.title = '勾选以批量抓取'
      check.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (selected.has(globalIdx)) selected.delete(globalIdx)
        else selected.add(globalIdx)
        card.classList.toggle('selected', selected.has(globalIdx))
      })
      const cover = document.createElement('div')
      cover.className = 'bd-search-cover'
      cover.title = '点击打开相册页'
      const img = document.createElement('img')
      img.loading = 'lazy'
      img.src = item.coverUrl || ''
      img.alt = item.title
      img.draggable = false
      img.addEventListener('error', () => {
        img.style.display = 'none'
        cover.classList.add('no-cover')
      })
      cover.appendChild(img)
      const info = document.createElement('div')
      info.className = 'bd-search-info'
      const title = document.createElement('div')
      title.className = 'bd-search-title'
      title.textContent = item.title
      title.title = item.title
      const meta = document.createElement('div')
      meta.className = 'bd-search-meta'
      meta.textContent = item.imageCount !== undefined ? `${item.imageCount} 张` : '张数未知'
      info.append(title, meta)
      card.append(check, badge, cover, info)
      card.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement
        if (t.closest('input')) return
        window.open(item.url, '_blank', 'noreferrer')
      })
      return card
    }

    function renderList(): void {
      listEl.innerHTML = ''
      if (items.length === 0) {
        listEl.innerHTML = '<div class="empty-tip">暂无结果。请输入关键词后点击「聚合搜索」。</div>'
        btnFetch.disabled = true
        btnSelectAll.disabled = true
        btnNext.disabled = true
        btnPrev.disabled = true
        batchInfo.textContent = ''
        return
      }
      // 当前批：分站点分组展示（FP-012：各站独立区块，顺序按 GALLERY_SITES 配置）
      const start = page * BATCH_SIZE
      const slice = items.slice(start, start + BATCH_SIZE)
      const bySite = new Map<string, number[]>()
      slice.forEach((_item, i) => {
        const globalIdx = start + i
        const siteId = itemSites[globalIdx] ?? ''
        if (!bySite.has(siteId)) bySite.set(siteId, [])
        bySite.get(siteId)!.push(globalIdx)
      })
      const order = [...GALLERY_SITES.map((s) => s.id), ...bySite.keys()].filter(
        (id, i, arr) => arr.indexOf(id) === i,
      )
      for (const siteId of order) {
        const indices = bySite.get(siteId)
        if (!indices) continue
        const block = document.createElement('div')
        block.className = 'bd-search-site-block'
        const head = document.createElement('div')
        head.className = 'bd-search-site-head'
        head.textContent = `${siteId} · ${indices.length} 条`
        block.appendChild(head)
        const grid = document.createElement('div')
        grid.className = 'bd-search-site-grid'
        for (const globalIdx of indices) {
          grid.appendChild(makeCard(items[globalIdx], globalIdx))
        }
        block.appendChild(grid)
        listEl.appendChild(block)
      }
      btnFetch.disabled = false
      btnSelectAll.disabled = false
      btnNext.disabled = page >= pageCount() - 1
      btnPrev.disabled = page <= 0
      batchInfo.textContent = `第 ${page + 1}/${pageCount()} 批（共 ${items.length} 个，本批 ${slice.length} 个）`
    }

    function setBusy(busy: boolean): void {
      searchBtn.disabled = busy
      btnFetch.disabled = busy
      btnSelectAll.disabled = busy
      googleTestBtn.disabled = busy
      btnNext.disabled = busy || page >= pageCount() - 1
      btnPrev.disabled = busy || page <= 0
      searchBtn.textContent = busy ? '搜索中…' : '聚合搜索'
    }

    btnSelectAll.addEventListener('click', () => {
      // 全选/取消本批
      const start = page * BATCH_SIZE
      const batchAll = items
        .slice(start, start + BATCH_SIZE)
        .every((_i, idx) => selected.has(start + idx))
      if (batchAll) {
        for (let i = start; i < Math.min(start + BATCH_SIZE, items.length); i++) selected.delete(i)
      } else {
        for (let i = start; i < Math.min(start + BATCH_SIZE, items.length); i++) selected.add(i)
      }
      renderList()
    })
    btnNext.addEventListener('click', () => {
      if (page < pageCount() - 1) {
        page++
        renderList()
      }
    })
    btnPrev.addEventListener('click', () => {
      if (page > 0) {
        page--
        renderList()
      }
    })
    btnFetch.addEventListener('click', () => {
      if (btnFetch.disabled) return
      const targets = [...selected]
        .sort((a, b) => a - b)
        .map((idx) => ({
          url: items[idx].url,
          folderName: buildBuonduaFolderName(items[idx].title, items[idx].url),
        }))
      if (targets.length === 0) {
        setStatus(statusEl, '请先勾选要抓取的相册', true)
        return
      }
      resultsHost.innerHTML = ''
      batchViews.clear()
      batchFolders.clear()
      targets.forEach((target, idx) => {
        batchFolders.set(idx, target.folderName)
        batchAlbumNames.set(idx, extractBuonduaAlbumShortName(target.folderName))
        const card = document.createElement('div')
        card.className = 'bd-batch-card'
        const head = document.createElement('div')
        head.className = 'bd-batch-head'
        const title = document.createElement('span')
        title.className = 'bd-batch-title'
        title.textContent = target.folderName.replace(/^ID-buondua-/, '').replace(/-\d{8}_\d{6}$/, '')
        const status = document.createElement('span')
        status.className = 'bd-batch-status'
        status.textContent = '等待抓取…'
        head.append(title, status)
        const host = document.createElement('div')
        host.className = 'grab-view-host'
        card.append(head, host)
        resultsHost.appendChild(card)
        const grabView = createGrabView(host, {
          srcTabId,
          getFolderName: () => batchFolders.get(idx) ?? `ID-buondua-相册-${Date.now()}`,
          getAlbumName: () => batchAlbumNames.get(idx) ?? 'album',
          showReparse: false,
          showLoadMore: false,
        })
        grabView.setBusyParsing(true)
        grabView.setParseText('抓取中…')
        batchViews.set(idx, grabView)
      })
      setStatus(statusEl, `开始批量抓取 ${targets.length} 个相册（并发 3）…`)
      setBusy(true)
      void sendMessage({ type: 'BD_FETCH_ALBUMS', srcTabId, targets }).then((res) => {
        if (!res.ok) {
          setStatus(statusEl, `请求失败：${res.error}`, true)
          setBusy(false)
        }
      })
    })

    // ---------- Google 连接测试（FP-012） ----------
    googleTestBtn.addEventListener('click', async () => {
      if (!(await ensureHostPermission())) {
        setStatus(googleStatus, '需要授权访问 <all_urls> 后才能测试 Google', true)
        return
      }
      setStatus(googleStatus, '测试中…')
      googleTestBtn.disabled = true
      try {
        const res = await sendMessage<
          { ok: true; google?: { ok: boolean; status?: number; blocked: boolean; ms: number; error?: string } } | { ok: false; error: string }
        >({ type: 'BD_TEST_GOOGLE', srcTabId })
        if (!res.ok) {
          setStatus(googleStatus, `测试失败：${res.error}`, true)
          return
        }
        if (!res.google) {
          setStatus(googleStatus, '测试失败：无响应', true)
          return
        }
        const g = res.google
        if (!g.ok) {
          setStatus(googleStatus, `连接失败：${g.error}（${g.ms}ms）`, true)
        } else if (g.blocked) {
          setStatus(googleStatus, `可达但触发验证页（HTTP ${g.status} · ${g.ms}ms）——代理/cookie 可能未生效`, true)
        } else {
          setStatus(googleStatus, `连接正常（HTTP ${g.status} · ${g.ms}ms）`)
        }
      } catch (err) {
        setStatus(googleStatus, `测试异常：${String(err)}`, true)
      } finally {
        googleTestBtn.disabled = false
      }
    })

    searchBtn.addEventListener('click', async () => {
      const query = queryInput.value.trim()
      if (!query) {
        setStatus(statusEl, '请输入搜索关键词', true)
        return
      }
      const sites = selectedSites()
      if (sites.length === 0) {
        setStatus(statusEl, '请至少勾选一个搜索站点', true)
        return
      }
      if (!(await ensureHostPermission())) {
        setStatus(statusEl, '需要授权访问多页图站（<all_urls>）后才能搜索', true)
        return
      }
      items = []
      itemSites = []
      siteSeen.clear()
      page = 0
      selected.clear()
      pendingSites = sites.length
      renderList()
      siteStatus.textContent = '搜索中（0/' + pendingSites + '）…'
      setStatus(statusEl, `聚合搜索「${query}」：${sites.join(' / ')}`)
      setBusy(true)
      void sendMessage({ type: 'BD_SEARCH', srcTabId, query, sites, pagesPerSite: Number(pagesInput.value) || 2 }).then((res) => {
        if (!res.ok) {
          setStatus(statusEl, `请求失败：${res.error}`, true)
          setBusy(false)
        }
      })
    })

    return {
      show: (list) => {
        items = list
        itemSites = list.map(() => '')
        selected.clear()
        renderList()
      },
      append: (list, error, siteId) => {
        const key = siteId ?? ''
        let seen = siteSeen.get(key)
        if (!seen) {
          seen = new Set()
          siteSeen.set(key, seen)
        }
        for (const item of list) {
          if (!seen.has(item.url)) {
            seen.add(item.url)
            items.push(item)
            itemSites.push(key)
          }
        }
        pendingSites = Math.max(0, pendingSites - 1)
        const done = pendingSites === 0
        const tag = siteId ? `${siteId}：${list.length} 条` : `${list.length} 条`
        const err = error ? `（失败：${error}）` : ''
        siteStatus.textContent = `${done ? '搜索完成' : `搜索中（${pendingSites} 站待查）`}：${tag}${err}`
        renderList()
      },
      setBusy,
      finish: () => {
        setBusy(false)
        siteStatus.textContent = `搜索完成：${items.length} 个结果`
        setStatus(statusEl, `搜索完成：共 ${items.length} 个结果（按站点分栏展示）`)
      },
    }
  }
  const searchList = setupSearchPanel()
  linkLists.push(searchList)

  // ---------- 自动填充：从源网页 URL 识别多页站点（matchGallerySite 通用匹配，覆盖全部已适配站点） ----------
  if (sourceUrl && matchGallerySite(sourceUrl)) {
    albumUrlInput.value = sourceUrl
    ;(root.querySelector('#bd-rec-url') as HTMLInputElement).value = sourceUrl
    ;(root.querySelector('#bd-pop-url') as HTMLInputElement).value = sourceUrl
    logger.info('view', '已自动填充多页图站网址', { sourceUrl, site: matchGallerySite(sourceUrl)?.id })
  }

  // ---------- 对外句柄 ----------
  /** 按文件夹名路由下载进度到对应抓取视图 */
  function routeDownload(job: DownloadJob): void {
    if (job.folderName === lastAlbumFolder) {
      albumGrabView.setDownloadJob(job)
      return
    }
    for (const [idx, folder] of batchFolders) {
      if (folder === job.folderName) {
        const view = batchViews.get(idx)
        if (view) view.setDownloadJob(job)
        return
      }
    }
  }

  return {
    onResult: (kind, data, done, error) => {
      if (kind === 'album') {
        const images = data as BuonduaImage[]
        albumGrabView.appendImages(images.map(toGrabbed))
        albumGrabView.selectAll()
        albumGrabView.setBusyParsing(false)
        if (error) {
          albumGrabView.setParseText(`抓取失败：${error}`)
        } else {
          albumGrabView.setParseText(`全子页抓取完成，共 ${images.length} 张（已去重）`)
        }
        logger.info('view', 'buondua 全子页抓取结果', { count: images.length })
      } else if (kind === 'scan') {
        const items = data as BuonduaLinkItem[]
        // 推荐/其他面板分别接收（后台按 kind 已区分，这里按当前激活面板路由）
        const activePanel = root.querySelector('.adapter-panel.active')?.id ?? ''
        if (activePanel === 'sub-bd-recommended') {
          recList.show(items)
        } else if (activePanel === 'sub-bd-popular') {
          popList.show(items)
        } else {
          // 未激活面板时按来源推测：封面为 i2.buondua.com 的属推荐区，其余归其他
          recList.show(items)
        }
        logger.info('view', 'buondua 链接识别结果', { count: items.length, panel: activePanel })
      } else if (kind === 'batch-item') {
        const item = data as BuonduaBatchItem
        const view = batchViews.get(item.index)
        const statusEls = root.querySelectorAll<HTMLElement>('.bd-batch-status')
        if (item.index >= 0 && item.index < statusEls.length) {
          statusEls[item.index].textContent =
            item.images.length > 0 ? `完成：${item.images.length} 张` : error ? `失败：${error}` : '失败：0 张'
        }
        if (view) {
          view.appendImages(item.images.map(toGrabbed))
          view.selectAll()
          view.setBusyParsing(false)
          view.setParseText(item.images.length > 0 ? `完成：${item.images.length} 张（已去重）` : `抓取失败：${error ?? '0 张'}`)
        }
        if (done) {
          linkLists.forEach((l) => l.setBusy(false))
          logger.info('view', 'buondua 批量抓取完成', { index: item.index, count: item.images.length })
        }
      } else if (kind === 'search-site') {
        // 聚合搜索：单站结果增量追加（带站点标识）
        const r = data as SearchSiteResult
        searchList.append(r.items, error, r.siteId)
      } else if (kind === 'search') {
        // 聚合搜索：全部站点完成
        searchList.finish()
      }
    },
    onDownloadProgress: (job) => routeDownload(job),
    onDownloadDone: (job) => {
      routeDownload(job)
      logger.info('view', 'buondua 下载任务结束', { jobId: job.id, done: job.done, failed: job.failed })
    },
  }
}
