// buondua 适配页（FP-004）：多页相册站点
// 三个子选项卡：
//   1. 抓取：输入相册 URL → 抓取全部子页图片 → 去重 → 共享抓取视图
//   2. 批量抓取推荐链接：解析 bottom-articles 推荐相册 → 勾选批量抓取（独立文件夹）
//   3. 批量抓取其他链接：解析 popular-item 其他相册 → 同上
// 链接列表按批展示（10/批），抓完一批可点「下一批」继续

import { initLogger } from '../lib/logger'
import { sendMessage, type BuonduaBatchItem, type BuonduaResultKind, type SearchSiteResult } from '../lib/messages'
import { extractBuonduaAlbumName, extractBuonduaAlbumShortName } from '../lib/buondua-parse'
import { GALLERY_SITES, matchGallerySite, siteById } from '../sites/registry'
import { extractJrantsFolderName } from '../lib/jrants-parse'
import { extractPixibbFolderName } from '../lib/pixibb-parse'
import { isTranslateEnabled, setTranslateEnabled, translateTitleToChinese } from '../lib/translate'
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

/** 文件夹名 = 页面名（按站点定义的 folderNameRule 路由；2026-10-08 体检 P0-2：
 *  原先用 `site.id === 'jrants'` 判断，违反模块边界禁止事项第 6 条，改为读定义字段） */
export function buildBuonduaFolderName(title: string, url: string): string {
  const rule = matchGallerySite(url)?.def.folderNameRule ?? 'buondua'
  if (rule === 'jrants') return extractJrantsFolderName(title)
  if (rule === 'pixibb') return extractPixibbFolderName(title)
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
        <label class="bd-google-all-check" title="用 Google 翻译把相册名译成中文（文件夹名与图片名前缀一起生效；关闭或翻译失败时自动用原文）"><input type="checkbox" id="bd-translate" checked> 相册名译成中文</label>
      </div>
      <div class="adapter-tabs">
        <button data-sub="bd-album" class="adapter-tab active">抓取</button>
        <button data-sub="bd-recommended" class="adapter-tab">批量抓取推荐链接</button>
        <button data-sub="bd-popular" class="adapter-tab">批量抓取其他链接</button>
        <button data-sub="bd-search" class="adapter-tab">聚合搜索</button>
      </div>

      <div id="sub-bd-album" class="adapter-panel active">
        <div class="row">
          <input id="bd-album-url" class="text-input" placeholder="相册 URL：buondua / rrwsh.uuss.uk / hitxhot.org / jrants.com / pixibb.com / kaizty.com / 新站">
          <button id="bd-album-fetch" class="btn primary">抓取全部子页</button>
          <button id="bd-probe" class="btn" title="开标签提取页面结构（图片模式/容器 class/分页），用于适配新站">探测结构</button>
        </div>
        <pre id="bd-probe-out" class="ai-probe-out hidden"></pre>
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
          <span class="ctrl-label">列表浏览</span>
          <select id="bd-list-site" class="num-input" title="选择站点（直接遍历站点分类/列表页，不依赖搜索引擎）"></select>
          <input id="bd-list-path" class="text-input" placeholder="列表路径，如 /gallerys/">
          <select id="bd-list-pages" class="num-input" title="抓取页数">
            <option value="1">1 页</option>
            <option value="2" selected>2 页</option>
            <option value="3">3 页</option>
            <option value="5">5 页</option>
          </select>
          <select id="bd-list-pagekind" class="num-input" title="列表页分页方式（若第 2 页抓不到新链接，换一种再试）">
            <option value="" selected>分页：自动</option>
            <option value="query">分页：?page=N</option>
            <option value="path-slash">分页：/page/N/</option>
            <option value="path">分页：/page/N</option>
          </select>
          <button id="bd-list-fetch" class="btn">抓取列表页</button>
          <span id="bd-list-status" class="status-text"></span>
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
          <div id="bd-search-sites" class="bd-search-sites">
            <div class="bd-site-group">
              <div class="bd-site-group-title">站内搜索（直接站内接口，快）</div>
              <div id="bd-search-sites-site" class="bd-site-boxes"></div>
            </div>
            <div class="bd-site-group">
              <div class="bd-site-group-title">Google 通道（仅 Google 可搜｜已限频：每轮最多 8 次请求、间隔 4 秒，被拒后暂停 15 分钟）</div>
              <div id="bd-search-sites-google" class="bd-site-boxes"></div>
            </div>
          </div>
          <span id="bd-search-site-status" class="status-text"></span>
        </div>
        <div class="row">
          <label class="bd-google-all-check" title="开启后忽略上方勾选，全部站点走 Google 网页通道（仅标题+链接）。注意：会显著增加 Google 请求量，已受限频保护（每轮最多 8 次、间隔 4 秒），请勿短时间内反复搜索"><input type="checkbox" id="bd-google-all"> Google 全站搜索</label>
          <button id="bd-google-test" class="btn">测试 Google 连接</button>
          <span id="bd-google-status" class="status-text"></span>
        </div>
        <div class="row">
          <button class="btn bd-select-all">全选/取消</button>
          <button class="btn bd-fetch-selected">抓取选中</button>
          <button class="btn bd-next-batch" title="继续检索更多结果（每站追加一页）">下一批（继续检索）</button>
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

  // ---------- 相册名中文化开关（FP-019）：文件夹名与图片名前缀同源生效 ----------
  const translateCheck = root.querySelector('#bd-translate') as HTMLInputElement | null
  if (translateCheck) {
    void isTranslateEnabled().then((on) => {
      translateCheck.checked = on
    })
    translateCheck.addEventListener('change', () => {
      void setTranslateEnabled(translateCheck.checked)
      logger.info('view', '相册名中文化开关已切换', { enabled: translateCheck.checked })
    })
  }

  /** 标题中文化：开关关闭 / 已是中文 / 翻译失败时返回原文 */
  async function localizeName(title: string): Promise<string> {
    if (!translateCheck?.checked) return title
    return await translateTitleToChinese(title)
  }

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

  // ---------- 页面结构探测（FP-014 站点扩充） ----------
  const probeBtn = root.querySelector('#bd-probe') as HTMLButtonElement | null
  const probeOut = root.querySelector('#bd-probe-out') as HTMLElement | null
  probeBtn?.addEventListener('click', async () => {
    const url = albumUrlInput.value.trim()
    if (!url) {
      albumGrabView.setParseText('请先填写相册 URL')
      return
    }
    if (!(await ensureHostPermission())) {
      albumGrabView.setParseText('需要授权访问 <all_urls> 后才能探测')
      return
    }
    probeBtn.disabled = true
    probeBtn.textContent = '探测中…'
    if (probeOut) {
      probeOut.classList.remove('hidden')
      probeOut.textContent = '加载页面并提取结构中…'
    }
    try {
      const res = await sendMessage<{ ok: true; probe: import('../lib/messages').PageProbeResult } | { ok: false; error: string }>({
        type: 'BD_PROBE_PAGE',
        url,
      })
      if (res.ok && probeOut) {
        const p = res.probe
        probeOut.textContent =
          `标题: ${p.title}\n` +
          `URL: ${p.url}\n` +
          `og:image: ${p.ogImage || '无'}\n` +
          `图片样本(${p.imgSrcs.length}):\n  ${p.imgSrcs.slice(0, 8).join('\n  ')}\n` +
          `容器候选: ${p.containerCandidates.map((c) => `${c.cls}(${c.n})`).join(' ')}\n` +
          `分页(${p.pagination.length}):\n  ${p.pagination.map((pg) => `${pg.href} [${pg.text}]`).join('\n  ') || '（无）'}` +
          // 2026-10-11 增强：按图床分组（正文容器与图床的判据）+ 任意形态分页 + lazy 检测
          (p.imageGroups && p.imageGroups.length
            ? '\n\n== 按图床分组（正文容器判据）==\n' +
              p.imageGroups
                .map(
                  (g) =>
                    `${g.host} ×${g.count}\n  样本:\n    ${g.samples.slice(0, 3).join('\n    ')}\n  父级链:\n    ${g.chains
                      .map((c) => c.join(' < '))
                      .join('\n    ')}`,
                )
                .join('\n')
            : '') +
          (p.pageLinks && p.pageLinks.length ? `\n\n== 疑似分页链接（任意形态）==\n  ${p.pageLinks.slice(0, 12).join('\n  ')}` : '') +
          (p.lazyCount ? `\n\ndata-src（lazy）数量: ${p.lazyCount}` : '') +
          // 2026-10-11 第二轮增强：正文图不在 <img> 时的排查线索
          (p.imgAttrKeys && p.imgAttrKeys.length ? `\n\n== img 上的 src/data-* 属性名 ==\n  ${p.imgAttrKeys.join(' , ')}` : '') +
          (p.bgImages && p.bgImages.length
            ? `\n\n== 内联 background-image 样本 ==\n  ${p.bgImages
                .slice(0, 8)
                .map((u, i) => `${u}\n    父级链: ${(p.bgChains?.[i] ?? []).join(' < ')}`)
                .join('\n  ')}`
            : '') +
          (p.iframeSrcs && p.iframeSrcs.length ? `\n\n== iframe src ==\n  ${p.iframeSrcs.join('\n  ')}` : '')
        logger.info('view', '页面结构探测完成', {
          url,
          imgs: p.imgSrcs.length,
          containers: p.containerCandidates.slice(0, 5),
          pages: p.pagination.length,
        })
      } else if (!res.ok && probeOut) {
        probeOut.textContent = `探测失败：${res.error}`
      }
    } catch (err) {
      if (probeOut) probeOut.textContent = `探测异常：${String(err)}`
    } finally {
      probeBtn.disabled = false
      probeBtn.textContent = '探测结构'
    }
  })

  // ---------- 抓取（全子页） ----------
  const albumUrlInput = root.querySelector('#bd-album-url') as HTMLInputElement

  /** 抓取当前输入框的相册（2026-10-10）：面板「抓取全部子页」与视图工具栏「重新抓取」共用同一逻辑 */
  async function runAlbumFetch(): Promise<void> {
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
      // 文件夹名 = 页面标题（后台解析 h1，可按开关译成中文），失败兜底 URL；图片名前缀 = 纯相册名
      const name = await localizeName(res.name ?? url)
      lastAlbumFolder = buildBuonduaFolderName(name, url)
      lastAlbumShort = extractBuonduaAlbumShortName(name)
    } else {
      albumGrabView.setBusyParsing(false)
      albumGrabView.setParseText(`请求失败：${res.error}`)
    }
  }

  const albumGrabView = createGrabView(root.querySelector('#bd-album-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => lastAlbumFolder,
    getAlbumName: () => lastAlbumShort,
    // 2026-10-10：视图工具栏显示「重新抓取」（与面板上方按钮共用 runAlbumFetch）
    showReparse: true,
    reparseLabel: '重新抓取',
    onReparse: () => {
      void runAlbumFetch()
    },
    showLoadMore: false,
  })

  root.querySelector('#bd-album-fetch')?.addEventListener('click', () => {
    void runAlbumFetch()
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
    btnFetch.addEventListener('click', async () => {
      if (btnFetch.disabled) return
      const picked = [...selected].sort((a, b) => a - b)
      if (picked.length === 0) {
        setStatus(statusEl, '请先勾选要抓取的相册', true)
        return
      }
      setBusy(true)
      // 相册名中文化（FP-019）：先逐个翻译（命中缓存不发请求），失败自动回退原文
      const prepared: { url: string; folderName: string; albumName: string }[] = []
      for (const [n, idx] of picked.entries()) {
        const item = items[idx]
        setStatus(statusEl, `翻译相册名 ${n + 1}/${picked.length}…`)
        const name = await localizeName(item.title)
        prepared.push({
          url: item.url,
          folderName: buildBuonduaFolderName(name, item.url),
          albumName: extractBuonduaAlbumShortName(name),
        })
      }
      // 为每个目标创建独立结果卡片 + grab view
      resultsHost.innerHTML = ''
      batchViews.clear()
      batchFolders.clear()
      prepared.forEach((target, idx) => {
        batchFolders.set(idx, target.folderName)
        batchAlbumNames.set(idx, target.albumName)
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
        // 关闭按钮（FP-020）：只移除本相册卡片，不影响其它卡片与后台任务
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'bd-batch-close'
        closeBtn.title = '移除此相册结果卡片'
        closeBtn.textContent = '×'
        closeBtn.addEventListener('click', () => {
          batchViews.get(idx)?.clear()
          batchViews.delete(idx)
          batchFolders.delete(idx)
          batchAlbumNames.delete(idx)
          card.remove()
          logger.info('view', '已移除批量结果卡片', { index: idx })
        })
        head.append(title, status, closeBtn)
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
      setStatus(statusEl, `开始批量抓取 ${prepared.length} 个相册（并发 3）…`)
      setBusy(true)
      void sendMessage({
        type: 'BD_FETCH_ALBUMS',
        srcTabId,
        targets: prepared.map((t) => ({ url: t.url, folderName: t.folderName })),
      }).then((res) => {
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

  // ---------- 站内列表浏览（FP-023）：不依赖搜索引擎，直接遍历站点分类/列表页 ----------
  const listSiteSelect = root.querySelector('#bd-list-site') as HTMLSelectElement | null
  const listPathInput = root.querySelector('#bd-list-path') as HTMLInputElement | null
  const listPagesSelect = root.querySelector('#bd-list-pages') as HTMLSelectElement | null
  const listPageKindSelect = root.querySelector('#bd-list-pagekind') as HTMLSelectElement | null
  const listFetchBtn = root.querySelector('#bd-list-fetch') as HTMLButtonElement | null
  const listStatusEl = root.querySelector('#bd-list-status') as HTMLElement | null
  if (listSiteSelect) {
    for (const site of GALLERY_SITES) {
      const option = document.createElement('option')
      option.value = site.id
      option.textContent = site.def.label
      listSiteSelect.appendChild(option)
    }
    const applyListDefault = (): void => {
      const site = siteById(listSiteSelect.value)
      const cfg = site?.def.listPages?.[0]
      if (listPathInput) listPathInput.value = cfg?.path ?? '/'
      setStatus(listStatusEl, cfg ? `列表：${cfg.label}` : '未预置列表路径，可自行填写后抓取')
    }
    listSiteSelect.addEventListener('change', applyListDefault)
    applyListDefault()
  }
  listFetchBtn?.addEventListener('click', async () => {
    const siteId = listSiteSelect?.value ?? ''
    const site = siteById(siteId)
    if (!site) {
      setStatus(listStatusEl, '请先选择站点', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(listStatusEl, '需要授权访问 <all_urls> 后才能抓取列表页', true)
      return
    }
    const path = (listPathInput?.value.trim() || '/').replace(/^\/?/, '/')
    const host = site.hosts.find((h) => !/^(m|www|mobile)\./i.test(h)) ?? site.hosts[0]
    if (!host) {
      setStatus(listStatusEl, '站点主域未配置', true)
      return
    }
    const pages = Number(listPagesSelect?.value) || 1
    const rawKind = listPageKindSelect?.value ?? ''
    const pageKind = rawKind === 'query' || rawKind === 'path' || rawKind === 'path-slash' ? rawKind : undefined
    const listUrl = `https://${host}${path}`
    setStatus(listStatusEl, `抓取列表页 ${pages} 页（分页：${pageKind ?? '自动'}）：${listUrl}`)
    listFetchBtn.disabled = true
    try {
      const res = await sendMessage({ type: 'BD_FETCH_LIST', srcTabId, siteId, listUrl, pages, pageKind })
      if (!res.ok) setStatus(listStatusEl, `请求失败：${res.error}`, true)
      // 成功时结果经 BD_RESULT(kind=list) 推送到本面板链接列表
    } finally {
      listFetchBtn.disabled = false
    }
  })

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

    // 站点勾选：分类存放（FP-013 调整）——站内搜索类（直接站内接口）/ Google 通道类（Google 优先，失败降级站内）
    // 2026-10-07 调整：jrants 站内搜索被反爬（403）→ 移入 Google 组并取消默认勾选；
    // rrwsh（域名已被他人站占用）取消默认勾选，仍可在列表中手动勾选
    // 2026-10-11：cangcuc 域名长期失效，用户决定放弃 → 定义已归档并从站点列表移除
    const googleGroupIds = ['hitxhot', 'kaizty', 'phimvuspot', 'ilovexs', 'pixibb', 'jrants', 'xiuzhai5']
    const defaultChecked = new Set(['buondua'])
    const googleChannel = new Set(googleGroupIds)
    const googleAllCheck = panel.querySelector('#bd-google-all') as HTMLInputElement
    let googleAll = false // Google 全站搜索开关状态
    googleAllCheck.addEventListener('change', () => {
      googleAll = googleAllCheck.checked
      siteStatus.textContent = googleAll ? 'Google 全站模式：忽略上方勾选，全部站点走 Google' : ''
    })
    const disabledNotes: Record<string, string> = {
      imgbb: '无搜索（图床）',
    }
    /** 不在 GALLERY_SITES 中的站点首页（FP-014 修复 6：imgbb 图床） */
    const HOME_URLS: Record<string, string> = {
      imgbb: 'imgbb.com',
    }
    const renderSiteBoxes = (): void => {
      const renderGroup = (ids: string[], containerId: string): void => {
        const container = panel.querySelector(`#${containerId}`) as HTMLElement
        container.innerHTML = ids
          .map(
            (id) =>
              `<label class="bd-site-check ${disabledNotes[id] ? 'disabled' : ''}" title="${disabledNotes[id] ?? ''}"><input type="checkbox" value="${id}" ${defaultChecked.has(id) ? 'checked' : ''} ${disabledNotes[id] ? 'disabled' : ''}> <a class="bd-site-name" href="#" data-site="${id}" title="打开网站首页">${id}</a>${googleChannel.has(id) ? '<span class="bd-site-note">（Google）</span>' : ''}${disabledNotes[id] ? `<span class="bd-site-note">（${disabledNotes[id]}）</span>` : ''}</label>`,
          )
          .join('')
      }
      // 站内搜索类：buondua/rrwsh/knitbid/se8/jliji + imgbb（无搜索灰显，保留原列表提示）；jrants 已移入 Google 组
      renderGroup(['buondua', 'rrwsh', 'knitbid', 'se8', 'jliji', 'imgbb'], 'bd-search-sites-site')
      // Google 通道类：仅 Google 可搜
      renderGroup(googleGroupIds, 'bd-search-sites-google')
      // 站点名点击 → 打开网站首页（FP-014 修复 6：点击名字跳首页，checkbox 勾选不受影响）
      panel.querySelectorAll('.bd-site-boxes').forEach((box) => {
        box.addEventListener('click', (ev) => {
          const target = ev.target as HTMLElement
          const link = target.closest('a.bd-site-name')
          if (!link) return
          ev.preventDefault()
          ev.stopPropagation()
          const siteId = link.getAttribute('data-site') || ''
          const site = GALLERY_SITES.find((s) => s.id === siteId)
          const host = site
            ? site.hosts.find((h) => !/^(m|www|mobile)\./i.test(h)) ?? site.hosts[0]
            : HOME_URLS[siteId]
          if (host) void chrome.tabs.create({ url: `https://${host}` })
        })
      })
    }
    renderSiteBoxes()
    /** 分组勾选分流：返回站内组站点与 Google 组站点（FP-014 修复 2：Google 组站点显式标记，后台强制走 Google） */
    const selectedSites = (): { sites: string[]; googleSites: string[] } => {
      if (googleAll) {
        // Google 全站：全部已适配站点
        return { sites: GALLERY_SITES.map((s) => s.id), googleSites: [] }
      }
      const checked = Array.from(panel.querySelectorAll<HTMLInputElement>('.bd-site-boxes input[type="checkbox"]:checked')).map((c) => c.value)
      return {
        sites: checked,
        googleSites: checked.filter((id) => googleChannel.has(id)),
      }
    }

    let items: BuonduaLinkItem[] = [] // 平铺全站结果（跨站不去重，各站分栏展示）
    let itemSites: string[] = [] // 与 items 同序：来源站点（徽标/分组用）
    const siteSeen = new Map<string, Set<string>>() // 站内 URL 去重
    const selected = new Set<number>()
    let pendingSites = 0
    let lastQuery = '' // 最近一次搜索关键词（日志用）
    let nextStartPage = 1 // 每站起始页（「下一批」续搜 +pagesPerSite，096）
    const siteHasResult = new Set<string>() // 出过结果的站点（续搜跳过空站）

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

    /** 文字行（Google 通道站点用，096：无封面依赖，紧密列表） */
    function makeTextRow(item: BuonduaLinkItem, globalIdx: number): HTMLDivElement {
      const row = document.createElement('div')
      row.className = 'bd-search-text-item' + (selected.has(globalIdx) ? ' selected' : '')
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.className = 'bd-search-check'
      check.checked = selected.has(globalIdx)
      check.title = '勾选以批量抓取'
      check.addEventListener('click', (ev) => {
        ev.stopPropagation()
        if (selected.has(globalIdx)) selected.delete(globalIdx)
        else selected.add(globalIdx)
        row.classList.toggle('selected', selected.has(globalIdx))
      })
      const title = document.createElement('span')
      title.className = 'bd-search-text-title'
      title.textContent = item.title
      title.title = item.title
      const meta = document.createElement('span')
      meta.className = 'bd-search-text-meta'
      meta.textContent = item.imageCount !== undefined ? `${item.imageCount} 张` : ''
      const open = document.createElement('span')
      open.className = 'bd-search-text-open'
      open.textContent = '打开 ↗'
      row.append(check, title, meta, open)
      row.addEventListener('click', (ev) => {
        const t = ev.target as HTMLElement
        if (t.closest('input')) return
        window.open(item.url, '_blank', 'noreferrer')
      })
      return row
    }

    function renderList(): void {
      listEl.innerHTML = ''
      if (items.length === 0) {
        listEl.innerHTML = '<div class="empty-tip">暂无结果。请输入关键词后点击「聚合搜索」。</div>'
        btnFetch.disabled = true
        btnSelectAll.disabled = true
        btnNext.disabled = true
        batchInfo.textContent = ''
        return
      }
      // 全量分站点分组展示：站内站点封面网格；Google 通道站点（无封面）纯文字紧密列表
      const bySite = new Map<string, number[]>()
      items.forEach((_item, idx) => {
        const siteId = itemSites[idx] ?? ''
        if (!bySite.has(siteId)) bySite.set(siteId, [])
        bySite.get(siteId)!.push(idx)
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
        if (googleAll || googleChannel.has(siteId)) {
          const list = document.createElement('div')
          list.className = 'bd-search-text-list'
          for (const globalIdx of indices) {
            list.appendChild(makeTextRow(items[globalIdx], globalIdx))
          }
          block.appendChild(list)
        } else {
          const grid = document.createElement('div')
          grid.className = 'bd-search-site-grid'
          for (const globalIdx of indices) {
            grid.appendChild(makeCard(items[globalIdx], globalIdx))
          }
          block.appendChild(grid)
        }
        listEl.appendChild(block)
      }
      btnFetch.disabled = false
      btnSelectAll.disabled = false
      btnNext.disabled = false
      batchInfo.textContent = `共 ${items.length} 个结果（已检索 ${nextStartPage - 1} 页/站）`
    }

    function setBusy(busy: boolean): void {
      searchBtn.disabled = busy
      btnFetch.disabled = busy
      btnSelectAll.disabled = busy
      googleTestBtn.disabled = busy
      btnNext.disabled = busy
      searchBtn.textContent = busy ? '搜索中…' : '聚合搜索'
    }

    btnSelectAll.addEventListener('click', () => {
      // 全选/取消全部（跨站）
      const allSelected = items.length > 0 && items.every((_i, idx) => selected.has(idx))
      if (allSelected) selected.clear()
      else items.forEach((_i, idx) => selected.add(idx))
      renderList()
    })
    btnNext.addEventListener('click', () => {
      // 「下一批」= 继续检索（096）：每站从 nextStartPage 起追加 pagesPerSite 页，结果扩充
      if (searchBtn.disabled) return
      const query = lastQuery
      if (!query) {
        setStatus(statusEl, '请先进行一次聚合搜索', true)
        return
      }
      const sel = selectedSites()
      const sites = sel.sites.filter((s) => siteHasResult.has(s))
      const googleSites = sel.googleSites.filter((s) => siteHasResult.has(s))
      if (sites.length === 0) {
        setStatus(statusEl, '没有可继续检索的站点（尚无结果），请重新搜索', true)
        return
      }
      nextStartPage += Number(pagesInput.value) || 2
      pendingSites = sites.length
      setStatus(statusEl, `继续检索「${query}」第 ${nextStartPage} 页起：${sites.join(' / ')}`)
      setBusy(true)
      void sendMessage({ type: 'BD_SEARCH', srcTabId, query, sites, pagesPerSite: Number(pagesInput.value) || 2, startPage: nextStartPage, useGoogleAll: googleAll, googleSites }).then((res) => {
        if (!res.ok) {
          setStatus(statusEl, `请求失败：${res.error}`, true)
          setBusy(false)
        }
      })
    })
    btnFetch.addEventListener('click', async () => {
      if (btnFetch.disabled) return
      const picked = [...selected].sort((a, b) => a - b)
      if (picked.length === 0) {
        setStatus(statusEl, '请先勾选要抓取的相册', true)
        return
      }
      setBusy(true)
      // 相册名中文化（FP-019）：先逐个翻译（命中缓存不发请求），失败自动回退原文
      const prepared: { url: string; folderName: string; albumName: string }[] = []
      for (const [n, idx] of picked.entries()) {
        const item = items[idx]
        setStatus(statusEl, `翻译相册名 ${n + 1}/${picked.length}…`)
        const name = await localizeName(item.title)
        prepared.push({
          url: item.url,
          folderName: buildBuonduaFolderName(name, item.url),
          albumName: extractBuonduaAlbumShortName(name),
        })
      }
      resultsHost.innerHTML = ''
      batchViews.clear()
      batchFolders.clear()
      prepared.forEach((target, idx) => {
        batchFolders.set(idx, target.folderName)
        batchAlbumNames.set(idx, target.albumName)
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
        // 关闭按钮（FP-020）：只移除本相册卡片，不影响其它卡片与后台任务
        const closeBtn = document.createElement('button')
        closeBtn.type = 'button'
        closeBtn.className = 'bd-batch-close'
        closeBtn.title = '移除此相册结果卡片'
        closeBtn.textContent = '×'
        closeBtn.addEventListener('click', () => {
          batchViews.get(idx)?.clear()
          batchViews.delete(idx)
          batchFolders.delete(idx)
          batchAlbumNames.delete(idx)
          card.remove()
          logger.info('view', '已移除批量结果卡片', { index: idx })
        })
        head.append(title, status, closeBtn)
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
      setStatus(statusEl, `开始批量抓取 ${prepared.length} 个相册（并发 3）…`)
      setBusy(true)
      void sendMessage({
        type: 'BD_FETCH_ALBUMS',
        srcTabId,
        targets: prepared.map((t) => ({ url: t.url, folderName: t.folderName })),
      }).then((res) => {
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
          | {
              ok: true
              google?: {
                ok: boolean
                status?: number
                blocked: boolean
                ms: number
                error?: string
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
            }
          | { ok: false; error: string }
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
        const d = g.diag
        const diagText = d
          ? ` [${(d.len / 1024).toFixed(0)}KB, ${d.hasH3 ? '含结果' : '无结果标记'}${d.isConsent ? ', 同意页' : ''}${d.hasMetaRefresh ? ', meta刷新' : ''}${d.hasNoResultText ? ', 0结果文案' : ''}${d.hops > 0 ? `, ${d.hops}跳` : ''}] 页面: ${d.bodyPreview.slice(0, 120)}`
          : ''
        if (!g.ok) {
          setStatus(googleStatus, `连接失败：${g.error}（${g.ms}ms）`, true)
        } else if (g.blocked) {
          setStatus(googleStatus, `可达但触发验证页（HTTP ${g.status} · ${g.ms}ms）——代理/cookie 可能未生效`, true)
        } else {
          setStatus(googleStatus, `连接正常（HTTP ${g.status} · ${g.ms}ms）${diagText}`)
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
      const { sites, googleSites } = selectedSites()
      if (sites.length === 0) {
        setStatus(statusEl, '请至少勾选一个搜索站点', true)
        return
      }
      lastQuery = query
      logger.info('view', '聚合搜索发起', { query, sites, googleSites, pagesPerSite: Number(pagesInput.value) || 2 })
      if (!(await ensureHostPermission())) {
        setStatus(statusEl, '需要授权访问多页图站（<all_urls>）后才能搜索', true)
        return
      }
      items = []
      itemSites = []
      siteSeen.clear()
      siteHasResult.clear()
      nextStartPage = 1
      selected.clear()
      pendingSites = sites.length
      renderList()
      siteStatus.textContent = '搜索中（0/' + pendingSites + '）…'
      setStatus(statusEl, `聚合搜索「${query}」：${sites.join(' / ')}${googleAll ? '（Google 全站）' : ''}`)
      setBusy(true)
      void sendMessage({ type: 'BD_SEARCH', srcTabId, query, sites, pagesPerSite: Number(pagesInput.value) || 2, useGoogleAll: googleAll, googleSites }).then((res) => {
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
        if (list.length > 0) siteHasResult.add(key)
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
        logger.info('view', '聚合搜索完成', { query: lastQuery, total: items.length, sites: new Set(itemSites).size })
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
    onResult: (kind, data, done, error) => {      if (kind === 'album') {
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
      } else if (kind === 'list') {
        // 站内列表浏览结果（FP-023）：载入「批量抓取其他链接」面板的链接列表
        const items = data as BuonduaLinkItem[]
        popList.show(items)
        logger.info('view', '列表页链接已载入', { count: items.length })
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
