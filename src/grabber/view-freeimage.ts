// freeimage 适配页（FP-007）
// 5 个子场景（对齐 imgbb 5 子功能需求）：
//   A 用户主页抓取（对齐 imgbb①）：用户主页分页抓取 → 共享抓取视图
//   B 相册抓取（对齐 imgbb②）：相册全量抓取 → 共享抓取视图
//   C 相册分析（对齐 imgbb③）：用户相册列表 → 相册卡片（点击新开页）
//   D 探索检索（对齐 imgbb④ 变体搜索）：模式×类型 并发抓取仅文字信息 → 记录库 → 关键词检索
//   E 类群鉴别（对齐 imgbb⑤ 强化搜索）：多轮手动扩散 → 候选 → 标注（目标/排除）→ 类群库 → 导出/导入

import { initLogger } from '../lib/logger'
import { sendMessage, type ExploreSearchProgress, type FhResultKind } from '../lib/messages'
import { matchAlbumKeywords } from '../lib/freeimage-parse'
import { emptyFhAlbumIndexDb, emptyFhProducerDb } from '../lib/freeimage-types'
import type { FhAlbum, FhAlbumIndexDb, FhImage, FhOwner, FhProducerDb } from '../lib/freeimage-types'
import type { DownloadJob, GrabbedImage } from '../lib/types'
import { createGrabView, type GrabViewHandle } from './image-grab-view'

const logger = initLogger('grabber')

const BATCH_PAGES = 3 // 每批页数（探索页 36 张/页 → 一批约 100 张）

/** 相册名采集结果（FH_RESULT kind=scan） */
interface ScanAlbumEntry {
  username: string
  albums: { name: string; url: string }[]
  albumCount: number
  truncated: boolean
}

type FhResultData = FhImage[] | FhAlbum[] | FhOwner[] | ScanAlbumEntry[] | ExploreSearchProgress

export interface FreeimageViewHandle {
  onResult(kind: FhResultKind, data: FhResultData, done: boolean, error?: string): void
  onScoreProgress(msg: { done: number; total: number; username: string; albumCount: number; truncated?: boolean; failed: number; cancelled?: boolean }): void
  onDownloadProgress(job: DownloadJob): void
  onDownloadDone(job: DownloadJob): void
}

/** FhImage → GrabbedImage（原图即展示，免费图床无降级） */
function toGrabbed(img: FhImage): GrabbedImage {
  return {
    id: img.id,
    url: img.originalUrl,
    downloadUrl: img.originalUrl,
    thumbUrl: img.thumbUrl || img.mediumUrl,
    width: img.width,
    height: img.height,
    sizeStatus: img.width && img.height ? 'ok' : 'unknown',
  }
}

export function initFreeimageView(root: HTMLElement, srcTabId: number, _sourceUrl?: string): FreeimageViewHandle {
  // ---------- 状态 ----------
  let homeFolder = 'freeimage用户主页'
  let albumFolder = 'freeimage相册'
  // 相册分析
  let albumsPage = 0
  // 场景 D：探索检索
  let fhAlbumIndex: FhAlbumIndexDb = emptyFhAlbumIndexDb()
  let searchBusy = false
  let searchRounds = 0
  let searchMode: string = 'recent'
  let searchType: string = 'albums'
  // 场景 E：扩散轮次状态机（探索页 → 属主 → 相册名 串联）
  type RoundStage = 'idle' | 'explore' | 'owners' | 'scan'
  let roundStage: RoundStage = 'idle'
  let roundPageSize = 2
  let roundSample = 12
  let exploreCursor = 0
  let exploreImages: FhImage[] = []
  let owners: FhOwner[] = []
  let scanEntries: ScanAlbumEntry[] = []
  let producerDb: FhProducerDb = emptyFhProducerDb()

  // ---------- DOM 构建 ----------
  root.innerHTML = `
    <div class="adapters-view">
      <div class="adapter-head">
        <h3>freeimage 图床</h3>
        <span class="adapter-hint">Chevereto 图床：用户主页 / 相册 / 相册分析 / 探索检索 / 类群鉴别</span>
      </div>
      <div class="adapter-tabs">
        <button data-sub="fh-home" class="adapter-tab active">用户主页</button>
        <button data-sub="fh-album" class="adapter-tab">相册抓取</button>
        <button data-sub="fh-albums" class="adapter-tab">相册分析</button>
        <button data-sub="fh-search" class="adapter-tab">探索检索</button>
        <button data-sub="fh-following" class="adapter-tab">关注墙</button>
        <button data-sub="fh-diffuse" class="adapter-tab">扩散检索</button>
        <button data-sub="fh-producers" class="adapter-tab">类群鉴别</button>
      </div>

      <!-- A 用户主页 -->
      <div id="sub-fh-home" class="adapter-panel active">
        <div class="row">
          <input id="fh-home-url" class="text-input" placeholder="freeimage 用户名或主页 URL，如 jzqgoodlife / https://freeimage.host/jzqgoodlife">
          <button id="fh-home-fetch" class="btn primary">抓第一批（约100）</button>
          <button id="fh-home-next" class="btn">下一批</button>
        </div>
        <div class="row">
          <span class="row-label">分页范围</span>
          <input id="fh-home-from" class="num-input" value="1" type="number" min="1">
          <span>~</span>
          <input id="fh-home-to" class="num-input" value="3" type="number" min="1">
          <button id="fh-home-pages" class="btn">按页抓取</button>
        </div>
        <div id="fh-home-grab-view" class="grab-view-host"></div>
      </div>

      <!-- B 相册抓取 -->
      <div id="sub-fh-album" class="adapter-panel">
        <div class="row">
          <input id="fh-album-url" class="text-input" placeholder="相册 URL，如 https://freeimage.host/a/ba-bi.zLEWQ 或 /album/zLEWQ">
          <button id="fh-album-fetch" class="btn primary">抓取全部图片</button>
        </div>
        <div id="fh-album-grab-view" class="grab-view-host"></div>
      </div>

      <!-- C 相册分析 -->
      <div id="sub-fh-albums" class="adapter-panel">
        <div class="row">
          <input id="fh-albums-user" class="text-input" placeholder="freeimage 用户名，如 jzqgoodlife">
          <label class="row-label">排序</label>
          <select id="fh-albums-sort" class="select-input">
            <option value="views_desc">最多浏览</option>
            <option value="date_desc">最新</option>
            <option value="likes_desc">最多喜欢</option>
            <option value="name_asc">名称</option>
          </select>
          <button id="fh-albums-start" class="btn primary">开始分析</button>
          <button id="fh-albums-next" class="btn">下一批</button>
          <span id="fh-albums-status" class="status-text"></span>
        </div>
        <div class="album-grid" id="fh-albums-grid"></div>
      </div>

      <!-- D 探索检索 -->
      <div id="sub-fh-search" class="adapter-panel">
        <div class="diffuse-section">
          <div class="section-title">① 探索检索：模式 × 类型（仅文字，每批自动保存到记录库）</div>
          <div class="row">
            <span class="row-label">模式</span>
            <button class="btn fh-mode active" data-fh-mode="recent">最新</button>
            <button class="btn fh-mode" data-fh-mode="popular">热门</button>
            <button class="btn fh-mode" data-fh-mode="trending">最多喜欢</button>
            <span class="row-label">类型</span>
            <button class="btn fh-type active" data-fh-type="albums">相册</button>
            <button class="btn fh-type" data-fh-type="images">图片</button>
            <button class="btn fh-type" data-fh-type="users">用户</button>
          </div>
          <div class="row">
            <span class="row-label">每批轮数</span>
            <input id="fh-sr-rounds" class="num-input" value="5" type="number" min="1" max="200">
            <span class="status-text">每轮 1 页（36 条），每批完成自动保存</span>
            <button id="fh-sr-start" class="btn primary">开始检索</button>
            <button id="fh-sr-next-batch" class="btn" disabled>下一批</button>
            <button id="fh-sr-stop" class="btn danger" disabled>终止</button>
          </div>
          <div class="row">
            <span class="row-label">进度</span>
            <div class="progress-bar thin" style="flex:1"><div id="fh-sr-fill" class="progress-fill" style="width:0%"></div></div>
            <span id="fh-sr-progress" class="progress-text">未开始</span>
          </div>
          <div class="diffuse-log" id="fh-sr-log"></div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">② 记录库（已保存条目，自动去重合并，可导出备份）</div>
          <div class="row">
            <span id="fh-sr-stats" class="status-text">已记录 0 条</span>
            <button id="fh-sr-export" class="btn primary">导出 JSON</button>
            <button id="fh-sr-import" class="btn">导入合并</button>
            <input id="fh-sr-import-file" type="file" accept=".json" style="display:none">
            <button id="fh-sr-clear" class="btn danger">清空</button>
          </div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">③ 相册关键词检索（纯本地匹配记录库，imgbb 风格）</div>
          <div class="row">
            <input id="fh-sr-keywords" class="text-input" placeholder="关键词，逗号分隔（匹配相册名/用户名）">
            <button id="fh-sr-run" class="btn primary">检索</button>
            <span id="fh-sr-hit" class="status-text"></span>
          </div>
          <div class="row">
            <button id="fh-sr-prev" class="btn" disabled>上一页</button>
            <span id="fh-sr-page" class="status-text"></span>
            <button id="fh-sr-next" class="btn" disabled>下一页</button>
            <span id="fh-sr-total" class="status-text"></span>
          </div>
          <div class="fh-hit-list" id="fh-sr-hits"></div>
        </div>
      </div>

      <!-- F 关注墙（迁移 imgbb 关注墙） -->
      <div id="sub-fh-following" class="adapter-panel">
        <div class="row">
          <input id="fh-fw-user" class="text-input" placeholder="freeimage 用户名，如 holystick">
          <label class="radio-label"><input type="radio" name="fh-fw-side" value="both" checked>全部</label>
          <label class="radio-label"><input type="radio" name="fh-fw-side" value="following">关注者</label>
          <label class="radio-label"><input type="radio" name="fh-fw-side" value="followers">被关注者</label>
          <button id="fh-fw-start" class="btn primary">开始分析</button>
          <button id="fh-fw-next" class="btn" disabled>下一批</button>
          <span id="fh-fw-status" class="status-text"></span>
        </div>
        <div class="row"><span class="status-text">每批 30 用户：抓取关注关系 → 逐个查相册 → 展示用户+相册</span></div>
        <div class="following-list" id="fh-fw-list"></div>
      </div>

      <!-- G 扩散检索（迁移 imgbb FP-005） -->
      <div id="sub-fh-diffuse" class="adapter-panel">
        <div class="diffuse-section">
          <div class="section-title">① 广域筛选：following 扩散 → 入度统计</div>
          <div class="row">
            <input id="fh-df-user" class="text-input diffuse-user-input" placeholder="起点用户名，如 holystick">
            <button id="fh-df-start" class="btn primary">开始扩散</button>
            <button id="fh-df-next" class="btn">下一批(50)</button>
            <span id="fh-df-status" class="status-text"></span>
          </div>
          <div class="row">
            <span class="row-label">实时</span>
            <span id="fh-df-progress" class="status-text"></span>
            <span class="row-label">429</span>
            <span id="fh-df-429" class="status-text"></span>
          </div>
          <div class="batch-progress-row">
            <div class="progress-bar thin"><div id="fh-df-batch-fill" class="progress-fill"></div></div>
            <span id="fh-df-batch-text" class="progress-text"></span>
          </div>
          <div class="diffuse-log" id="fh-df-log"></div>
          <table class="batch-history" id="fh-df-history">
            <thead><tr><th>批</th><th>处理</th><th>新增</th><th>失败</th><th>耗时</th><th>均请求</th><th>入度+</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="diffuse-section">
          <div class="section-title">② 生产者库：入度合并 → 相册确认 → 综合评分排行</div>
          <div class="row">
            <button id="fh-db-save" class="btn">合并入库</button>
            <button id="fh-db-load" class="btn">读取</button>
            <button id="fh-db-reset" class="btn primary">重新确认</button>
            <button id="fh-db-clear" class="btn danger">清空</button>
            <span id="fh-db-status" class="status-text"></span>
          </div>
          <div class="row">
            <button id="fh-score-start" class="btn">确认评分</button>
            <button id="fh-score-next" class="btn">下一批确认</button>
            <button id="fh-score-stop" class="btn danger" disabled>停止</button>
            <label class="radio-label">入度权重 <input id="fh-w1" class="num-input" value="60" type="number" min="0" max="100" style="width:48px">%</label>
            <span id="fh-score-status" class="status-text"></span>
          </div>
          <div class="row"><span class="row-label">排行数量</span><input id="fh-rank-n" class="num-input" value="100" type="number" min="10" max="500" style="width:60px"></div>
          <div class="rank-groups">
            <div class="rank-group"><div class="rank-title">得分 Top <span class="rank-num" id="fh-rank-score-n">100</span></div><div class="user-list" id="fh-rank-score"></div></div>
            <div class="rank-group"><div class="rank-title">入度 Top <span class="rank-num" id="fh-rank-degree-n">100</span></div><div class="user-list" id="fh-rank-degree"></div></div>
            <div class="rank-group"><div class="rank-title">相册数 Top <span class="rank-num" id="fh-rank-album-n">100</span>（已确认）</div><div class="user-list" id="fh-rank-album"></div></div>
          </div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">③ 相册关键词检索（纯本地匹配）</div>
          <div class="row">
            <input id="fh-df-keywords" class="text-input" placeholder="关键词，逗号分隔">
            <label class="radio-label">取前 <input id="fh-df-pct" type="range" min="1" max="100" value="100" class="pct-range"> <span id="fh-df-pct-val">100</span>%</label>
            <button id="fh-df-search" class="btn primary">区间检索</button>
            <span id="fh-df-search-status" class="status-text"></span>
          </div>
          <div class="search-results" id="fh-df-results"></div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">④ 本地数据表（导出 / 导入合并）</div>
          <div class="row">
            <button id="fh-db-export" class="btn primary">导出数据表</button>
            <button id="fh-db-import" class="btn">导入合并</button>
            <input id="fh-db-import-file" type="file" accept=".json" style="display:none">
            <span id="fh-db-local-status" class="status-text"></span>
          </div>
        </div>
      </div>

      <!-- E 类群鉴别 -->
      <div id="sub-fh-producers" class="adapter-panel">
        <div class="diffuse-section">
          <div class="section-title">① 多轮扩散：每轮 = 探索页新页 → 属主提取 → 相册名线索</div>
          <div class="row">
            <span class="row-label">每轮页数</span>
            <input id="fh-pd-pages" class="num-input" value="2" type="number" min="1" max="5">
            <span class="row-label">每页采样</span>
            <input id="fh-pd-sample" class="num-input" value="12" type="number" min="1" max="36">
            <button id="fh-pd-round" class="btn primary">下一轮扩散</button>
            <span id="fh-pd-status" class="status-text"></span>
          </div>
          <div class="diffuse-log" id="fh-pd-log"></div>
          <div class="fh-candidates" id="fh-pd-candidates"></div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">② 类群库（手动标注：目标 / 排除非目标类群）</div>
          <div class="row">
            <span class="row-label">筛选</span>
            <button class="btn fh-db-filter active" data-fh-filter="all">全部</button>
            <button class="btn fh-db-filter" data-fh-filter="target">目标</button>
            <button class="btn fh-db-filter" data-fh-filter="excluded">已排除</button>
            <button id="fh-pd-export" class="btn primary">导出 JSON</button>
            <button id="fh-pd-import" class="btn">导入合并</button>
            <input id="fh-pd-import-file" type="file" accept=".json" style="display:none">
            <span id="fh-pd-db-status" class="status-text"></span>
          </div>
          <div class="fh-db-list" id="fh-pd-db"></div>
        </div>
      </div>
    </div>
  `

  // ---------- 工具 ----------
  function setStatus(el: Element | null, text: string, isError = false): void {
    if (!el) return
    el.textContent = text
    el.classList.toggle('error', isError)
  }

  function cleanFolderName(name: string): string {
    return name.replace(/[\\/:*?"<>|\n\r]/g, '_').trim().slice(0, 120) || '未命名'
  }

  async function openTab(url: string): Promise<void> {
    try {
      const current = await chrome.tabs.getCurrent()
      const index = current?.index ?? 0
      await chrome.tabs.create({ url, index: index + 1 })
    } catch (err) {
      logger.error('freeimage', '新开页签失败', String(err))
    }
  }

  async function ensureHostPermission(): Promise<boolean> {
    try {
      if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true
      return await chrome.permissions.request({ origins: ['<all_urls>'] })
    } catch {
      return false
    }
  }

  // ---------- 共享抓取视图（A 用户主页 / B 相册） ----------
  const homeGrabView: GrabViewHandle = createGrabView(root.querySelector('#fh-home-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => homeFolder,
    getAlbumName: () => homeFolder,
    showReparse: false,
    showLoadMore: false,
  })

  const albumGrabView: GrabViewHandle = createGrabView(root.querySelector('#fh-album-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => albumFolder,
    getAlbumName: () => albumFolder,
    showReparse: false,
    showLoadMore: false,
  })

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

  // ---------- A 用户主页 ----------
  const homeUrlInput = root.querySelector('#fh-home-url') as HTMLInputElement
  let homePageCursor = 0

  async function fetchHomePages(pageFrom: number, pageTo: number): Promise<void> {
    const url = homeUrlInput.value.trim()
    if (!url) {
      homeGrabView.setParseText('请填写用户名或主页 URL')
      return
    }
    if (!(await ensureHostPermission())) {
      homeGrabView.setParseText('需要授权访问 freeimage（<all_urls>）后才能抓取')
      return
    }
    const m = url.match(/freeimage\.host\/([a-zA-Z0-9_-]+)/) ?? url.match(/^([a-zA-Z0-9_-]+)$/)
    if (m) homeFolder = cleanFolderName(m[1])
    homeGrabView.setBusyParsing(true)
    homeGrabView.setParseText(`抓取中（page ${pageFrom}~${pageTo}）…`)
    const res = await sendMessage({ type: 'FH_FETCH_USER', srcTabId, url, pageFrom, pageTo })
    if (!res.ok) {
      homeGrabView.setBusyParsing(false)
      homeGrabView.setParseText(`请求失败：${res.error}`)
    }
  }

  root.querySelector('#fh-home-fetch')?.addEventListener('click', () => {
    homePageCursor = BATCH_PAGES
    void fetchHomePages(1, BATCH_PAGES)
  })
  root.querySelector('#fh-home-next')?.addEventListener('click', () => {
    const from = homePageCursor + 1
    homePageCursor += BATCH_PAGES
    void fetchHomePages(from, homePageCursor)
  })
  root.querySelector('#fh-home-pages')?.addEventListener('click', () => {
    const from = Math.max(1, Number((root.querySelector('#fh-home-from') as HTMLInputElement).value) || 1)
    const to = Math.max(from, Number((root.querySelector('#fh-home-to') as HTMLInputElement).value) || from)
    homePageCursor = to
    void fetchHomePages(from, to)
  })

  // ---------- B 相册抓取 ----------
  const albumUrlInput = root.querySelector('#fh-album-url') as HTMLInputElement
  root.querySelector('#fh-album-fetch')?.addEventListener('click', async () => {
    const url = albumUrlInput.value.trim()
    if (!url) {
      albumGrabView.setParseText('请填写相册 URL')
      return
    }
    if (!(await ensureHostPermission())) {
      albumGrabView.setParseText('需要授权访问 freeimage（<all_urls>）后才能抓取')
      return
    }
    albumGrabView.setBusyParsing(true)
    albumGrabView.setParseText('抓取相册中…')
    const res = await sendMessage<{ ok: true; name?: string } | { ok: false; error: string }>({
      type: 'FH_FETCH_ALBUM',
      srcTabId,
      albumUrl: url,
    })
    if (!res.ok) {
      albumGrabView.setBusyParsing(false)
      albumGrabView.setParseText(`请求失败：${res.error}`)
    } else if (res.name) {
      albumFolder = cleanFolderName(res.name)
    }
  })

  // ---------- C 相册分析 ----------
  const albumsGrid = root.querySelector('#fh-albums-grid') as HTMLElement
  const albumsStatus = root.querySelector('#fh-albums-status') as HTMLElement
  const albumsUserInput = root.querySelector('#fh-albums-user') as HTMLInputElement
  const albumsSort = root.querySelector('#fh-albums-sort') as HTMLSelectElement

  function renderAlbumGrid(items: FhAlbum[]): void {
    albumsGrid.innerHTML = ''
    if (items.length === 0) {
      albumsGrid.innerHTML = '<div class="empty-tip">暂无相册（用户不存在或没有公开相册）。</div>'
      return
    }
    for (const album of items) {
      const card = document.createElement('div')
      card.className = 'album-card'
      card.title = album.name
      const cover = document.createElement('img')
      cover.className = 'album-cover'
      cover.loading = 'lazy'
      cover.src = album.coverUrl || ''
      cover.draggable = false
      const name = document.createElement('div')
      name.className = 'album-name'
      name.textContent = album.name
      card.append(cover, name)
      card.addEventListener('click', () => void openTab(album.url))
      albumsGrid.appendChild(card)
    }
  }

  async function fetchAlbums(page: number): Promise<void> {
    const username = albumsUserInput.value.trim()
    if (!username) {
      setStatus(albumsStatus, '请填写用户名')
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(albumsStatus, '需要授权访问 freeimage 后才能分析', true)
      return
    }
    setStatus(albumsStatus, `抓取第 ${page} 页…`)
    const res = await sendMessage({ type: 'FH_FETCH_ALBUMS', srcTabId, username, sort: albumsSort.value, page })
    if (!res.ok) setStatus(albumsStatus, `请求失败：${res.error}`, true)
  }

  root.querySelector('#fh-albums-start')?.addEventListener('click', () => {
    albumsPage = 1
    void fetchAlbums(1)
  })
  root.querySelector('#fh-albums-next')?.addEventListener('click', () => {
    albumsPage++
    void fetchAlbums(albumsPage)
  })

  // ---------- D 探索检索 ----------
  const srLog = root.querySelector('#fh-sr-log') as HTMLElement
  const srStats = root.querySelector('#fh-sr-stats') as HTMLElement
  const srProgress = root.querySelector('#fh-sr-progress') as HTMLElement
  const srFill = root.querySelector('#fh-sr-fill') as HTMLElement
  const srHits = root.querySelector('#fh-sr-hits') as HTMLElement
  const srHit = root.querySelector('#fh-sr-hit') as HTMLElement
  const srPageEl = root.querySelector('#fh-sr-page') as HTMLElement
  const srTotalEl = root.querySelector('#fh-sr-total') as HTMLElement
  const srPrevBtn = root.querySelector('#fh-sr-prev') as HTMLButtonElement
  const srNextBtn = root.querySelector('#fh-sr-next') as HTMLButtonElement
  const btnStart = root.querySelector('#fh-sr-start') as HTMLButtonElement
  const btnNextBatch = root.querySelector('#fh-sr-next-batch') as HTMLButtonElement
  const btnStop = root.querySelector('#fh-sr-stop') as HTMLButtonElement
  // 关键词检索分页（对齐 imgbb 扩散检索 UI：每页 100 条）
  const SEARCH_PAGE_SIZE = 100
  let searchAll: { name: string; url: string; username?: string }[] = []
  let searchPage = 0

  function logSr(text: string): void {
    const div = document.createElement('div')
    div.textContent = text
    srLog.appendChild(div)
    while (srLog.childElementCount > 300) srLog.firstElementChild?.remove()
    srLog.scrollTop = srLog.scrollHeight
  }

  function renderIndexStats(): void {
    srStats.textContent = `已记录 ${Object.keys(fhAlbumIndex.entries).length} 条（已保存到记录库）`
  }

  function setSearchBusy(busy: boolean): void {
    searchBusy = busy
    btnStart.disabled = busy
    btnStop.disabled = !busy
    if (busy) btnNextBatch.disabled = true
  }

  function updateProgress(round: number): void {
    const pct = searchRounds > 0 ? Math.round((round / searchRounds) * 100) : 0
    srFill.style.width = `${Math.min(100, pct)}%`
    srProgress.textContent = `第 ${round} / ${searchRounds} 轮（${pct}%）`
  }

  // ---------- 关键词检索（imgbb 风格：分页 + 状态 + 结果列表） ----------
  function renderSearchPage(): void {
    const total = searchAll.length
    const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE))
    if (searchPage >= pages) searchPage = pages - 1
    const slice = searchAll.slice(searchPage * SEARCH_PAGE_SIZE, (searchPage + 1) * SEARCH_PAGE_SIZE)
    srHits.innerHTML = ''
    if (total === 0) {
      srHits.innerHTML = '<div class="empty-tip">无命中（先采集保存记录，或调整关键词）。</div>'
    }
    for (const hit of slice) {
      const block = document.createElement('div')
      block.className = 'search-hit'
      const user = document.createElement('div')
      user.className = 'search-user'
      const a = document.createElement('a')
      a.href = hit.url
      a.target = '_blank'
      a.textContent = hit.name
      user.appendChild(a)
      if (hit.username) {
        const deg = document.createElement('span')
        deg.className = 'user-degree'
        deg.textContent = `属主 ${hit.username}`
        user.appendChild(deg)
      }
      block.appendChild(user)
      srHits.appendChild(block)
    }
    srPageEl.textContent = total > 0 ? `第 ${searchPage + 1}/${pages} 页` : ''
    srTotalEl.textContent = total > 0 ? `共命中 ${total} 条` : ''
    srPrevBtn.disabled = searchPage <= 0
    srNextBtn.disabled = searchPage >= pages - 1
  }

  function runSearch(): void {
    const kw = (root.querySelector('#fh-sr-keywords') as HTMLInputElement).value
    const keywords = kw.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
    if (keywords.length === 0) {
      setStatus(srHit, '请输入关键词', true)
      return
    }
    const all = Object.values(fhAlbumIndex.entries).map((e) => ({ name: e.name, url: e.url, username: e.username }))
    searchAll = matchAlbumKeywords(all, keywords)
    searchPage = 0
    renderSearchPage()
    setStatus(srHit, `检索完成：命中 ${searchAll.length} 条`)
  }

  // 模式/类型选择
  root.querySelectorAll<HTMLElement>('.fh-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.fh-mode').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      searchMode = btn.dataset.fhMode ?? 'recent'
    })
  })
  root.querySelectorAll<HTMLElement>('.fh-type').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.fh-type').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      searchType = btn.dataset.fhType ?? 'albums'
    })
  })

  btnStart.addEventListener('click', async () => {
    if (searchBusy) return
    if (!(await ensureHostPermission())) {
      setStatus(srHit, '需要授权访问 freeimage 后才能检索', true)
      return
    }
    const rounds = Math.max(1, Math.min(200, Number((root.querySelector('#fh-sr-rounds') as HTMLInputElement).value) || 5))
    searchRounds = rounds
    srLog.innerHTML = ''
    updateProgress(0)
    setSearchBusy(true)
    logSr(`开始新会话：${searchModeLabel(searchMode)} - ${searchTypeLabel(searchType)}，每批 ${rounds} 轮，结果自动保存`)
    const res = await sendMessage({
      type: 'FH_EXPLORE_SEARCH_START',
      srcTabId,
      mode: searchMode as 'recent' | 'popular' | 'trending',
      list: searchType as 'albums' | 'images' | 'users',
      rounds,
      intervalMs: 150,
    })
    if (!res.ok) {
      setSearchBusy(false)
      logSr(`启动失败：${res.error}`)
    }
  })

  btnNextBatch.addEventListener('click', async () => {
    if (searchBusy) return
    const rounds = Math.max(1, Math.min(200, Number((root.querySelector('#fh-sr-rounds') as HTMLInputElement).value) || 5))
    searchRounds = rounds
    updateProgress(0)
    setSearchBusy(true)
    logSr(`下一批：继续 ${rounds} 轮（结果自动保存）…`)
    const res = await sendMessage({ type: 'FH_EXPLORE_SEARCH_NEXT', srcTabId, rounds, intervalMs: 150 })
    if (!res.ok) {
      setSearchBusy(false)
      logSr(`下一批失败：${res.error}`)
    }
  })

  btnStop.addEventListener('click', () => {
    void sendMessage({ type: 'FH_EXPLORE_STOP' })
    logSr('已请求终止…')
  })

  function searchModeLabel(mode: string): string {
    return mode === 'recent' ? '最新' : mode === 'popular' ? '热门' : '最多喜欢'
  }
  function searchTypeLabel(type: string): string {
    return type === 'albums' ? '相册' : type === 'images' ? '图片' : '用户'
  }

  // 记录库：导出 / 导入 / 清空
  root.querySelector('#fh-sr-export')?.addEventListener('click', async () => {
    const res = await sendMessage<{ ok: true; json: string } | { ok: false; error: string }>({ type: 'FH_ALBUM_INDEX_EXPORT' })
    if (!res.ok) {
      setStatus(srHit, `导出失败：${res.error}`, true)
      return
    }
    const blob = new Blob([res.json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'freeimage-album-index.json'
    a.click()
    URL.revokeObjectURL(a.href)
    logSr(`已导出记录库（${Object.keys(fhAlbumIndex.entries).length} 条）`)
  })

  root.querySelector('#fh-sr-import')?.addEventListener('click', () => {
    ;(root.querySelector('#fh-sr-import-file') as HTMLInputElement).click()
  })
  root.querySelector('#fh-sr-import-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const db = JSON.parse(text)
      const res = await sendMessage<{ ok: true; fhIndexImported: { before: number; after: number } } | { ok: false; error: string }>({
        type: 'FH_ALBUM_INDEX_IMPORT',
        db,
      })
      if (res.ok) {
        logSr(`导入合并：${res.fhIndexImported.before} → ${res.fhIndexImported.after} 条`)
        await refreshIndex()
      } else {
        setStatus(srHit, `导入失败：${res.error}`, true)
      }
    } catch (err) {
      setStatus(srHit, `导入失败：${String(err)}`, true)
    } finally {
      ;(e.target as HTMLInputElement).value = ''
    }
  })

  root.querySelector('#fh-sr-clear')?.addEventListener('click', async () => {
    if (!confirm('确认清空记录库？')) return
    const res = await sendMessage({ type: 'FH_ALBUM_INDEX_CLEAR' })
    if (res.ok) {
      await refreshIndex()
      logSr('记录库已清空')
    }
  })

  root.querySelector('#fh-sr-run')?.addEventListener('click', () => runSearch())
  srPrevBtn.addEventListener('click', () => {
    if (searchPage > 0) {
      searchPage--
      renderSearchPage()
    }
  })
  srNextBtn.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(searchAll.length / SEARCH_PAGE_SIZE))
    if (searchPage < pages - 1) {
      searchPage++
      renderSearchPage()
    }
  })

  async function refreshIndex(): Promise<void> {
    const res = await sendMessage<{ ok: true; fhIndex: FhAlbumIndexDb } | { ok: false; error: string }>({ type: 'FH_ALBUM_INDEX_GET' })
    if (res.ok) {
      fhAlbumIndex = res.fhIndex
      renderIndexStats()
    }
  }

  // ---------- F 关注墙（迁移 imgbb 关注墙） ----------
  const fwUserInput = root.querySelector('#fh-fw-user') as HTMLInputElement
  const fwStatus = root.querySelector('#fh-fw-status') as HTMLElement
  const fwList = root.querySelector('#fh-fw-list') as HTMLElement
  const btnFwStart = root.querySelector('#fh-fw-start') as HTMLButtonElement
  const btnFwNext = root.querySelector('#fh-fw-next') as HTMLButtonElement
  let fwUsers: FhOwner[] = []
  let fwBatchStart = 0
  let fwScanPending = false
  const FW_BATCH = 30

  function renderFollowingList(): void {
    fwList.innerHTML = ''
    if (fwUsers.length === 0) {
      fwList.innerHTML = '<div class="empty-tip">暂无用户。请先开始分析。</div>'
      return
    }
    for (const u of fwUsers) {
      const card = document.createElement('div')
      card.className = 'bd-link-card'
      const info = document.createElement('div')
      info.className = 'bd-link-info'
      const title = document.createElement('div')
      title.className = 'bd-link-title'
      title.textContent = u.username
      info.append(title)
      const btn = document.createElement('button')
      btn.className = 'btn'
      btn.textContent = '打开主页'
      btn.addEventListener('click', () => void openTab(u.url))
      card.append(info, btn)
      fwList.appendChild(card)
    }
  }

  /** 关注墙批次分析结果（相册线索） */
  function renderFwScan(entries: ScanAlbumEntry[]): void {
    fwList.innerHTML = ''
    if (entries.length === 0) {
      fwList.innerHTML = '<div class="empty-tip">本批无有效用户（无相册或内容为 0 的用户已跳过）。</div>'
    }
    for (const entry of entries) {
      const card = document.createElement('div')
      card.className = 'following-card'
      const head = document.createElement('div')
      head.className = 'following-head'
      const name = document.createElement('span')
      name.className = 'following-name'
      name.textContent = `${entry.username}（相册 ${entry.albumCount}）`
      head.append(name)
      card.appendChild(head)
      const links = document.createElement('div')
      links.className = 'following-covers'
      const preview = document.createElement('div')
      preview.className = 'bd-link-meta'
      preview.textContent = entry.albums.slice(0, 10).map((a) => a.name).join(' / ') || '（无相册）'
      links.appendChild(preview)
      card.appendChild(links)
      const btn = document.createElement('button')
      btn.className = 'btn'
      btn.textContent = '打开主页'
      btn.style.margin = '4px'
      btn.addEventListener('click', () => void openTab(`https://freeimage.host/${entry.username}`))
      card.appendChild(btn)
      fwList.appendChild(card)
    }
    const remaining = fwUsers.length - fwBatchStart
    setStatus(fwStatus, `已分析 ${fwBatchStart}/${fwUsers.length} 用户${remaining > 0 ? `，剩余 ${remaining}（可下一批）` : '，全部完成'}`)
    btnFwNext.disabled = remaining <= 0
  }

  async function runFwBatch(): Promise<void> {
    const batch = fwUsers.slice(fwBatchStart, fwBatchStart + FW_BATCH)
    if (batch.length === 0) {
      setStatus(fwStatus, '没有更多用户')
      return
    }
    fwBatchStart += FW_BATCH
    setStatus(fwStatus, `分析第 ${Math.ceil(fwBatchStart / FW_BATCH)} 批（${batch.length} 用户，逐个查相册）…`)
    fwScanPending = true
    const res = await sendMessage({
      type: 'FH_SCAN_PRODUCERS',
      srcTabId,
      usernames: batch.map((u) => u.username),
      intervalMs: 200,
    })
    if (!res.ok) {
      fwScanPending = false
      setStatus(fwStatus, `分析失败：${res.error}`, true)
    }
  }

  btnFwStart.addEventListener('click', async () => {
    const username = fwUserInput.value.trim()
    if (!username) {
      setStatus(fwStatus, '请填写用户名', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(fwStatus, '需要授权访问 freeimage 后才能分析', true)
      return
    }
    const side = (root.querySelector('input[name="fh-fw-side"]:checked') as HTMLInputElement)?.value ?? 'both'
    setStatus(fwStatus, `抓取关注关系（${username}）…`)
    fwUsers = []
    fwBatchStart = 0
    const side2 = (side === 'following' || side === 'followers' ? side : 'both') as 'following' | 'followers' | 'both'
    const res = await sendMessage({ type: 'FH_FETCH_FOLLOWING', srcTabId, username, side: side2 })
    if (!res.ok) setStatus(fwStatus, `抓取失败：${res.error}`, true)
  })

  btnFwNext.addEventListener('click', () => void runFwBatch())

  // ---------- G 扩散检索（迁移 imgbb FP-005） ----------
  const dfUserInput = root.querySelector('#fh-df-user') as HTMLInputElement
  const dfStatus = root.querySelector('#fh-df-status') as HTMLElement
  const dfProgress = root.querySelector('#fh-df-progress') as HTMLElement
  const df429 = root.querySelector('#fh-df-429') as HTMLElement
  const dfLogEl = root.querySelector('#fh-df-log') as HTMLElement
  const dfBatchFill = root.querySelector('#fh-df-batch-fill') as HTMLElement
  const dfBatchText = root.querySelector('#fh-df-batch-text') as HTMLElement
  const dfHistoryBody = root.querySelector('#fh-df-history tbody') as HTMLElement
  const btnDfStart = root.querySelector('#fh-df-start') as HTMLButtonElement
  const btnDfNext = root.querySelector('#fh-df-next') as HTMLButtonElement
  let dfHistoryCount = 0

  function logDf(text: string): void {
    const div = document.createElement('div')
    div.textContent = text
    dfLogEl.appendChild(div)
    while (dfLogEl.childElementCount > 200) dfLogEl.firstElementChild?.remove()
    dfLogEl.scrollTop = dfLogEl.scrollHeight
  }

  function renderDiffuseSnapshot(snap: { queueSize: number; visitedTotal: number; inDegreeSize: number; totalRequests: number; consecutive429: number; users: { username: string; inDegree: number }[]; userTotal: number }): void {
    setStatus(dfProgress, `队列 ${snap.queueSize} · 已访问 ${snap.visitedTotal} · 入度表 ${snap.inDegreeSize} · 请求 ${snap.totalRequests}`)
    setStatus(df429, snap.consecutive429 > 0 ? `连续 ${snap.consecutive429} 次` : '')
    dfBatchFill.style.width = '0%'
    dfBatchText.textContent = ''
  }

  async function runDiffuseBatch(): Promise<void> {
    setStatus(dfStatus, '扩散批次处理中…')
    const res = await sendMessage<
      { ok: true; result: import('../lib/types').DiffuseBatchResult; snapshot: import('../lib/types').DiffuseSnapshot } | { ok: false; error: string }
    >({ type: 'FH_DIFFUSE_BATCH', srcTabId, batchSize: 50, concurrency: 4, intervalMs: 500 })
    if (!res.ok) {
      setStatus(dfStatus, `批次失败：${res.error}`, true)
      return
    }
    const { result, snapshot } = res
    renderDiffuseSnapshot(snapshot)
    dfHistoryCount++
    const row = document.createElement('tr')
    const cells = [
      String(dfHistoryCount),
      String(result.processed),
      String(result.newUsers),
      String(result.failed),
      `${(result.durationMs / 1000).toFixed(1)}s`,
      `${result.avgRequestMs}ms`,
      String(Object.keys(result.inDegreeDelta).length),
    ]
    for (const c of cells) {
      const td = document.createElement('td')
      td.textContent = c
      row.appendChild(td)
    }
    dfHistoryBody.appendChild(row)
    logDf(`第 ${dfHistoryCount} 批：处理 ${result.processed} · 新增 ${result.newUsers} · 失败 ${result.failed} · 入度+${Object.keys(result.inDegreeDelta).length} · ${(result.durationMs / 1000).toFixed(1)}s`)
    setStatus(dfStatus, result.done ? '扩散完成（队列耗尽）' : `队列剩余 ${result.queueSize}，可继续下一批`)
  }

  btnDfStart.addEventListener('click', async () => {
    const user = dfUserInput.value.trim()
    if (!user) {
      setStatus(dfStatus, '请填写起点用户名', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(dfStatus, '需要授权访问 freeimage 后才能扩散', true)
      return
    }
    dfHistoryCount = 0
    dfHistoryBody.innerHTML = ''
    dfLogEl.innerHTML = ''
    const res = await sendMessage({ type: 'FH_DIFFUSE_START', srcTabId, startUser: user })
    if (!res.ok) {
      setStatus(dfStatus, `启动失败：${res.error}`, true)
      return
    }
    logDf(`▶ 扩散启动：起点 ${user}`)
    await runDiffuseBatch()
  })

  btnDfNext.addEventListener('click', () => void runDiffuseBatch())

  // 生产者库：保存 / 读取 / 重置 / 清空
  const dbStatus = root.querySelector('#fh-db-status') as HTMLElement
  const scoreStatus = root.querySelector('#fh-score-status') as HTMLElement
  const btnScoreStart = root.querySelector('#fh-score-start') as HTMLButtonElement
  const btnScoreNext = root.querySelector('#fh-score-next') as HTMLButtonElement
  const btnScoreStop = root.querySelector('#fh-score-stop') as HTMLButtonElement
  const rankScoreEl = root.querySelector('#fh-rank-score') as HTMLElement
  const rankDegreeEl = root.querySelector('#fh-rank-degree') as HTMLElement
  const rankAlbumEl = root.querySelector('#fh-rank-album') as HTMLElement
  let lastW1 = 0.6

  function renderRankList(el: HTMLElement, items: { username: string; inDegree: number; score?: number; albumCount?: number }[]): void {
    el.innerHTML = ''
    if (!items || items.length === 0) {
      el.innerHTML = '<div class="empty-tip">（空）</div>'
      return
    }
    for (const it of items.slice(0, 30)) {
      const row = document.createElement('div')
      row.className = 'user-row'
      const u = document.createElement('span')
      u.className = 'user-name'
      u.textContent = it.username
      const d = document.createElement('span')
      d.className = 'user-degree'
      d.textContent = `入度 ${it.inDegree}${it.albumCount !== undefined ? ` · 相册 ${it.albumCount}` : ''}${it.score !== undefined ? ` · 得分 ${it.score.toFixed(2)}` : ''}`
      row.append(u, d)
      el.appendChild(row)
    }
  }

  async function loadDiffuseDb(): Promise<void> {
    lastW1 = Math.max(0, Math.min(100, Number((root.querySelector('#fh-w1') as HTMLInputElement).value) || 60)) / 100
    const topN = Math.max(10, Math.min(500, Number((root.querySelector('#fh-rank-n') as HTMLInputElement).value) || 100))
    const res = await sendMessage({ type: 'FH_DIFFUSE_DB_GET', w1: lastW1, topN })
    if (!res.ok) {
      setStatus(dbStatus, `读取失败：${res.error}`, true)
      return
    }
    setStatus(dbStatus, `库：${res.total ?? 0} 用户（已确认 ${res.confirmed ?? 0}）`)
    renderRankList(rankScoreEl, (res.rankScore ?? []) as { username: string; inDegree: number; score?: number; albumCount?: number }[])
    renderRankList(rankDegreeEl, (res.rankDegree ?? []) as { username: string; inDegree: number; score?: number; albumCount?: number }[])
    renderRankList(rankAlbumEl, (res.rankAlbum ?? []) as { username: string; inDegree: number; score?: number; albumCount?: number }[])
    ;(root.querySelector('#fh-rank-score-n') as HTMLElement).textContent = String(topN)
    ;(root.querySelector('#fh-rank-degree-n') as HTMLElement).textContent = String(topN)
    ;(root.querySelector('#fh-rank-album-n') as HTMLElement).textContent = String(topN)
  }

  root.querySelector('#fh-db-save')?.addEventListener('click', async () => {
    const res = await sendMessage({ type: 'FH_DIFFUSE_DB_SAVE', source: 'grabber' })
    if (res.ok) {
      setStatus(dbStatus, `已合并入库：${res.total} 用户（确认 ${res.confirmed}）`)
      await loadDiffuseDb()
    } else setStatus(dbStatus, `保存失败：${res.error}`, true)
  })
  root.querySelector('#fh-db-load')?.addEventListener('click', () => void loadDiffuseDb())
  root.querySelector('#fh-db-reset')?.addEventListener('click', async () => {
    if (!confirm('重置所有确认状态（保留入度）？')) return
    const res = await sendMessage({ type: 'FH_DIFFUSE_DB_RESET_CONFIRM' })
    if (res.ok) {
      setStatus(dbStatus, `已重置确认状态（${res.total} 用户）`)
      await loadDiffuseDb()
    }
  })
  root.querySelector('#fh-db-clear')?.addEventListener('click', async () => {
    if (!confirm('确认清空 freeimage 生产者库？')) return
    const res = await sendMessage({ type: 'FH_DIFFUSE_DB_CLEAR' })
    if (res.ok) {
      setStatus(dbStatus, '已清空')
      await loadDiffuseDb()
    }
  })

  // 确认评分批次
  async function runScoreBatch(): Promise<void> {
    btnScoreStart.disabled = true
    btnScoreNext.disabled = true
    btnScoreStop.disabled = false
    const w1 = Math.max(0, Math.min(100, Number((root.querySelector('#fh-w1') as HTMLInputElement).value) || 60)) / 100
    setStatus(scoreStatus, '确认评分中…')
    const res = await sendMessage<
      { ok: true; score: import('../lib/types').ScoreBatchResult; unconfirmed?: number; cancelled?: boolean } | { ok: false; error: string }
    >({ type: 'FH_DIFFUSE_SCORE_BATCH', srcTabId, batchSize: 50, concurrency: 4, intervalMs: 800, order: 'inDegree', w1, w2: 1 - w1 })
    btnScoreStart.disabled = false
    btnScoreNext.disabled = false
    btnScoreStop.disabled = true
    if (!res.ok) {
      setStatus(scoreStatus, `确认失败：${res.error}`, true)
      return
    }
    const s = res.score
    setStatus(scoreStatus, `确认 ${s.processed} 人：有相册 ${s.withAlbums} · 零相册 ${s.zeroAlbums} · 失败 ${s.failed} · 剩余未确认 ${res.unconfirmed ?? 0}${s.done ? '（全部确认完毕）' : ''}`)
    await loadDiffuseDb()
  }

  btnScoreStart.addEventListener('click', () => void runScoreBatch())
  btnScoreNext.addEventListener('click', () => void runScoreBatch())
  btnScoreStop.addEventListener('click', () => {
    void sendMessage({ type: 'FH_DIFFUSE_SCORE_STOP' })
    setStatus(scoreStatus, '已请求停止…')
  })

  // 关键词检索
  const dfKeywordsInput = root.querySelector('#fh-df-keywords') as HTMLInputElement
  const dfPctInput = root.querySelector('#fh-df-pct') as HTMLInputElement
  const dfPctVal = root.querySelector('#fh-df-pct-val') as HTMLElement
  const dfSearchStatus = root.querySelector('#fh-df-search-status') as HTMLElement
  const dfResultsEl = root.querySelector('#fh-df-results') as HTMLElement
  dfPctInput?.addEventListener('input', () => {
    if (dfPctVal) dfPctVal.textContent = dfPctInput.value
  })
  root.querySelector('#fh-df-search')?.addEventListener('click', async () => {
    const keywords = (dfKeywordsInput.value || '').split(/[,，]/).map((k) => k.trim()).filter(Boolean)
    if (keywords.length === 0) {
      setStatus(dfSearchStatus, '请输入关键词', true)
      return
    }
    const pct = Number(dfPctInput?.value) || 100
    const w1 = Math.max(0, Math.min(100, Number((root.querySelector('#fh-w1') as HTMLInputElement).value) || 60)) / 100
    setStatus(dfSearchStatus, '检索中…')
    const res = await sendMessage<
      { ok: true; search: import('../lib/types').SearchBatchResult } | { ok: false; error: string }
    >({ type: 'FH_DIFFUSE_SEARCH_START', keywords, fromPct: 0, toPct: pct, w1, w2: 1 - w1 })
    if (!res.ok) {
      setStatus(dfSearchStatus, `检索失败：${res.error}`, true)
      return
    }
    const search = res.search
    dfResultsEl.innerHTML = ''
    if (search.matches.length === 0) {
      dfResultsEl.innerHTML = '<div class="empty-tip">无命中</div>'
    }
    for (const m of search.matches.slice(0, 50)) {
      const block = document.createElement('div')
      block.className = 'search-hit'
      const user = document.createElement('div')
      user.className = 'search-user'
      const a = document.createElement('a')
      a.href = `https://freeimage.host/${m.username}`
      a.target = '_blank'
      a.textContent = m.username
      const deg = document.createElement('span')
      deg.className = 'user-degree'
      deg.textContent = `入度 ${m.inDegree}`
      user.append(a, deg)
      block.appendChild(user)
      for (const alb of m.albums) {
        const line = document.createElement('div')
        line.className = 'search-album'
        const la = document.createElement('a')
        la.href = alb.url
        la.target = '_blank'
        la.textContent = alb.name
        line.appendChild(la)
        block.appendChild(line)
      }
      dfResultsEl.appendChild(block)
    }
    setStatus(dfSearchStatus, `命中 ${search.matches.length} 条`)
  })

  // 导出 / 导入数据表
  root.querySelector('#fh-db-export')?.addEventListener('click', async () => {
    const res = await sendMessage<{ ok: true; json: string } | { ok: false; error: string }>({ type: 'FH_DIFFUSE_DB_EXPORT' })
    if (!res.ok) {
      setStatus(root.querySelector('#fh-db-local-status') as HTMLElement, `导出失败：${res.error}`, true)
      return
    }
    const blob = new Blob([res.json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'freeimage-diffuse-db.json'
    a.click()
    URL.revokeObjectURL(a.href)
    setStatus(root.querySelector('#fh-db-local-status') as HTMLElement, '已导出 freeimage-diffuse-db.json')
  })
  root.querySelector('#fh-db-import')?.addEventListener('click', () => {
    ;(root.querySelector('#fh-db-import-file') as HTMLInputElement).click()
  })
  root.querySelector('#fh-db-import-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const db = JSON.parse(text)
      const res = await sendMessage({ type: 'FH_DIFFUSE_DB_IMPORT', db })
      if (res.ok) {
        setStatus(root.querySelector('#fh-db-local-status') as HTMLElement, `导入合并：${res.github?.message ?? '完成'}（库 ${res.total} 用户）`)
        await loadDiffuseDb()
      } else setStatus(root.querySelector('#fh-db-local-status') as HTMLElement, `导入失败：${res.error}`, true)
    } catch (err) {
      setStatus(root.querySelector('#fh-db-local-status') as HTMLElement, `导入失败：${String(err)}`, true)
    } finally {
      ;(e.target as HTMLInputElement).value = ''
    }
  })

  // ---------- E 类群鉴别 ----------
  const pdStatus = root.querySelector('#fh-pd-status') as HTMLElement
  const pdLog = root.querySelector('#fh-pd-log') as HTMLElement
  const pdCandidates = root.querySelector('#fh-pd-candidates') as HTMLElement
  const pdDb = root.querySelector('#fh-pd-db') as HTMLElement
  const pdDbStatus = root.querySelector('#fh-pd-db-status') as HTMLElement
  let currentFilter: 'all' | 'target' | 'excluded' = 'all'

  function logPd(text: string): void {
    const div = document.createElement('div')
    div.textContent = text
    pdLog.appendChild(div)
    while (pdLog.childElementCount > 200) pdLog.firstElementChild?.remove()
    pdLog.scrollTop = pdLog.scrollHeight
  }

  async function annotate(username: string, status: 'target' | 'excluded' | null, reason?: string): Promise<void> {
    if (status === null) {
      const res = await sendMessage({ type: 'FH_PRODUCER_CLEAR', username })
      if (res.ok) logPd(`已清除标注：${username}`)
    } else {
      const res = await sendMessage({ type: 'FH_PRODUCER_SAVE', username, status, reason })
      if (res.ok) logPd(`已标注「${status}」：${username}${reason ? `（${reason}）` : ''}`)
    }
    await refreshProducerDb()
  }

  async function refreshProducerDb(): Promise<void> {
    const res = await sendMessage<{ ok: true; fh: FhProducerDb } | { ok: false; error: string }>({ type: 'FH_PRODUCER_GET' })
    if (res.ok) {
      producerDb = res.fh
      renderDb()
    }
  }

  function renderCandidates(): void {
    pdCandidates.innerHTML = ''
    if (scanEntries.length === 0) {
      pdCandidates.innerHTML = '<div class="empty-tip">暂无候选用户。点「下一轮扩散」开始采集。</div>'
      return
    }
    for (const entry of scanEntries) {
      const marked = producerDb.entries[entry.username]
      const card = document.createElement('div')
      card.className = 'following-card'
      const head = document.createElement('div')
      head.className = 'following-head'
      const name = document.createElement('span')
      name.className = 'following-name'
      name.textContent = `${entry.username}（相册 ${entry.albumCount}）${marked ? ` [${marked.status === 'target' ? '目标' : '已排除'}]` : ''}`
      head.append(name)
      card.appendChild(head)
      const links = document.createElement('div')
      links.className = 'following-covers'
      const preview = document.createElement('div')
      preview.className = 'bd-link-meta'
      preview.textContent = entry.albums.slice(0, 12).map((a) => a.name).join(' / ') || '（无相册）'
      links.appendChild(preview)
      card.appendChild(links)
      const actions = document.createElement('div')
      actions.className = 'row'
      const reasonInput = document.createElement('input')
      reasonInput.className = 'text-input'
      reasonInput.placeholder = '理由（可选）'
      reasonInput.value = marked?.reason ?? ''
      const btnTarget = document.createElement('button')
      btnTarget.className = 'btn'
      btnTarget.textContent = '目标'
      btnTarget.addEventListener('click', () => void annotate(entry.username, 'target', reasonInput.value.trim() || undefined))
      const btnExclude = document.createElement('button')
      btnExclude.className = 'btn danger'
      btnExclude.textContent = '排除'
      btnExclude.addEventListener('click', () => void annotate(entry.username, 'excluded', reasonInput.value.trim() || undefined))
      const btnClear = document.createElement('button')
      btnClear.className = 'btn'
      btnClear.textContent = '清除标注'
      btnClear.addEventListener('click', () => void annotate(entry.username, null))
      const btnUser = document.createElement('button')
      btnUser.className = 'btn'
      btnUser.textContent = '打开主页'
      btnUser.addEventListener('click', () => void openTab(`https://freeimage.host/${entry.username}`))
      actions.append(reasonInput, btnTarget, btnExclude, btnClear, btnUser)
      card.appendChild(actions)
      pdCandidates.appendChild(card)
    }
  }

  function renderDb(): void {
    pdDb.innerHTML = ''
    const entries = Object.values(producerDb.entries)
      .filter((e) => (currentFilter === 'all' ? true : e.status === currentFilter))
      .sort((a, b) => (b.notedAt ?? b.seenAt) - (a.notedAt ?? a.seenAt))
    if (entries.length === 0) {
      pdDb.innerHTML = '<div class="empty-tip">类群库为空。扩散后对候选用户标注目标/排除。</div>'
      return
    }
    for (const e of entries) {
      const row = document.createElement('div')
      row.className = 'bd-link-card'
      const info = document.createElement('div')
      info.className = 'bd-link-info'
      const title = document.createElement('div')
      title.className = 'bd-link-title'
      title.textContent = `${e.username} [${e.status === 'target' ? '目标' : '已排除'}]${e.reason ? ` — ${e.reason}` : ''}`
      const meta = document.createElement('div')
      meta.className = 'bd-link-meta'
      meta.textContent = `相册 ${e.albumCount ?? '?'} 个 · ${e.albums?.slice(0, 5).map((a) => a.name).join(' / ') || '（无相册线索）'}`
      info.append(title, meta)
      const actions = document.createElement('div')
      actions.className = 'bd-batch-actions'
      const btnUser = document.createElement('button')
      btnUser.className = 'btn'
      btnUser.textContent = '打开主页'
      btnUser.addEventListener('click', () => void openTab(`https://freeimage.host/${e.username}`))
      const btnAlbums = document.createElement('button')
      btnAlbums.className = 'btn'
      btnAlbums.textContent = '打开相册'
      btnAlbums.addEventListener('click', () => void openTab(`https://freeimage.host/${e.username}/albums`))
      const btnClear = document.createElement('button')
      btnClear.className = 'btn'
      btnClear.textContent = '清除'
      btnClear.addEventListener('click', () => void annotate(e.username, null))
      actions.append(btnUser, btnAlbums, btnClear)
      row.append(info, actions)
      pdDb.appendChild(row)
    }
  }

  root.querySelector('#fh-pd-round')?.addEventListener('click', async () => {
    if (roundStage !== 'idle') {
      setStatus(pdStatus, '上一轮尚未完成，请稍候', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(pdStatus, '需要授权访问 freeimage 后才能扩散', true)
      return
    }
    roundPageSize = Math.max(1, Math.min(5, Number((root.querySelector('#fh-pd-pages') as HTMLInputElement).value) || 2))
    roundSample = Math.max(1, Math.min(36, Number((root.querySelector('#fh-pd-sample') as HTMLInputElement).value) || 12))
    const from = exploreCursor + 1
    exploreCursor += roundPageSize
    roundStage = 'explore'
    setStatus(pdStatus, `第 ${from}~${exploreCursor} 页探索页采集…`)
    logPd(`下一轮扩散：探索页 ${from}~${exploreCursor} 页，采样 ${roundSample} 张/页`)
    const res = await sendMessage({ type: 'FH_FETCH_EXPLORE', srcTabId, pageFrom: from, pageTo: exploreCursor })
    if (!res.ok) {
      roundStage = 'idle'
      setStatus(pdStatus, `探索页采集失败：${res.error}`, true)
    }
  })

  root.querySelector('#fh-pd-export')?.addEventListener('click', async () => {
    const res = await sendMessage<{ ok: true; json: string } | { ok: false; error: string }>({ type: 'FH_PRODUCER_EXPORT' })
    if (!res.ok) {
      setStatus(pdDbStatus, `导出失败：${res.error}`, true)
      return
    }
    const blob = new Blob([res.json], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'freeimage-producers.json'
    a.click()
    URL.revokeObjectURL(a.href)
    setStatus(pdDbStatus, '已导出 freeimage-producers.json')
  })

  root.querySelector('#fh-pd-import')?.addEventListener('click', () => {
    ;(root.querySelector('#fh-pd-import-file') as HTMLInputElement).click()
  })
  root.querySelector('#fh-pd-import-file')?.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const db = JSON.parse(text)
      const res = await sendMessage<{ ok: true; fhImported: { before: number; after: number } } | { ok: false; error: string }>({
        type: 'FH_PRODUCER_IMPORT',
        db,
      })
      if (res.ok) {
        setStatus(pdDbStatus, `导入合并：${res.fhImported.before} → ${res.fhImported.after} 用户`)
        await refreshProducerDb()
      } else {
        setStatus(pdDbStatus, `导入失败：${res.error}`, true)
      }
    } catch (err) {
      setStatus(pdDbStatus, `导入失败：${String(err)}`, true)
    } finally {
      ;(e.target as HTMLInputElement).value = ''
    }
  })

  root.querySelectorAll<HTMLElement>('.fh-db-filter').forEach((btn) => {
    btn.addEventListener('click', () => {
      root.querySelectorAll('.fh-db-filter').forEach((b) => b.classList.remove('active'))
      btn.classList.add('active')
      currentFilter = (btn.dataset.fhFilter as 'all' | 'target' | 'excluded') ?? 'all'
      renderDb()
    })
  })

  // ---------- FH_RESULT 处理 ----------
  const handle: FreeimageViewHandle = {
    onResult(kind, data, done, error) {
      switch (kind) {
        case 'user': {
          homeGrabView.setBusyParsing(false)
          if (error) {
            homeGrabView.setParseText(`抓取失败：${error}`)
          } else {
            homeGrabView.appendImages((data as FhImage[]).map(toGrabbed))
            homeGrabView.setParseText(done ? `完成：${(data as FhImage[]).length} 张` : '')
          }
          break
        }
        case 'album': {
          albumGrabView.setBusyParsing(false)
          if (error) {
            albumGrabView.setParseText(`抓取失败：${error}`)
          } else {
            albumGrabView.appendImages((data as FhImage[]).map(toGrabbed))
            albumGrabView.setParseText(done ? `完成：${(data as FhImage[]).length} 张` : '')
          }
          break
        }
        case 'albums': {
          if (error) setStatus(albumsStatus, `失败：${error}`, true)
          else {
            renderAlbumGrid(data as FhAlbum[])
            setStatus(albumsStatus, `第 ${albumsPage} 页：${(data as FhAlbum[]).length} 个相册`)
          }
          break
        }
        case 'explore-search': {
          const p = data as ExploreSearchProgress
          if (done) {
            setSearchBusy(false)
            updateProgress(searchRounds)
            if (error) {
              logSr(`批次失败：${error}`)
            } else if (p.more) {
              btnNextBatch.disabled = false
              logSr(`批次完成：记录库已保存 ${p.total} 条（可点「下一批」继续）`)
            } else {
              logSr(`已到最后一页：记录库共保存 ${p.total} 条（会话结束）`)
            }
            void refreshIndex()
          } else {
            updateProgress(p.round)
            logSr(`第 ${p.round} 轮：抓取第 ${p.pageFrom}~${p.pageTo} 页，新增 ${p.added} 条，累计 ${p.total} 条（已保存）`)
            for (const e of p.newEntries.slice(0, 8)) {
              logSr(`  → ${e.name}${e.username ? `（${e.username}）` : ''}`)
            }
            if (p.newEntries.length > 8) logSr(`  …等共 ${p.newEntries.length} 条`)
            void refreshIndex()
          }
          break
        }
        case 'explore': {
          const images = data as FhImage[]
          exploreImages.push(...images)
          if (roundStage === 'explore') {
            roundStage = 'owners'
            setStatus(pdStatus, `探索页 ${images.length} 张，提取属主中…`)
            void sendMessage({
              type: 'FH_EXTRACT_OWNER',
              srcTabId,
              imageViewerUrls: images.map((i) => i.viewerUrl).filter(Boolean),
              samplePerPage: roundSample,
              intervalMs: 150,
            })
          }
          break
        }
        case 'owners': {
          const list = data as FhOwner[]
          const seen = new Set(owners.map((o) => o.username))
          for (const o of list) {
            if (!seen.has(o.username)) {
              seen.add(o.username)
              owners.push(o)
            }
          }
          if (roundStage === 'owners') {
            roundStage = 'scan'
            setStatus(pdStatus, `属主 ${list.length} 个，采集相册名中…`)
            void sendMessage({
              type: 'FH_SCAN_PRODUCERS',
              srcTabId,
              usernames: list.map((o) => o.username),
              intervalMs: 150,
            })
          }
          break
        }
        case 'scan': {
          const entries = data as ScanAlbumEntry[]
          if (fwScanPending) {
            fwScanPending = false
            renderFwScan(entries)
            break
          }
          scanEntries.push(...entries)
          if (roundStage === 'scan') {
            roundStage = 'idle'
            renderCandidates()
            setStatus(pdStatus, `本轮扩散完成：候选 ${scanEntries.length} 个用户`)
            logPd(`本轮完成：新增用户 ${entries.length} 个`)
          }
          break
        }
        case 'following': {
          if (error) {
            setStatus(fwStatus, `抓取失败：${error}`, true)
            break
          }
          const users = data as FhOwner[]
          fwUsers = users
          fwBatchStart = 0
          setStatus(fwStatus, `关注关系：${users.length} 个用户`)
          if (users.length === 0) {
            fwList.innerHTML = '<div class="empty-tip">该用户无公开关注关系。</div>'
            btnFwNext.disabled = true
          } else {
            renderFollowingList()
            btnFwNext.disabled = users.length <= FW_BATCH
            void runFwBatch()
          }
          break
        }
      }
    },
    onScoreProgress(msg) {
      setStatus(scoreStatus, `确认 ${msg.done}/${msg.total}：${msg.username}（相册 ${msg.albumCount}）${msg.failed ? ` · 失败 ${msg.failed}` : ''}${msg.cancelled ? ' · 已停止' : ''}`)
      if (msg.done >= msg.total || msg.cancelled) {
        btnScoreStart.disabled = false
        btnScoreNext.disabled = false
        btnScoreStop.disabled = true
      }
    },
    onDownloadProgress(job) {
      homeGrabView.setDownloadJob(job)
      albumGrabView.setDownloadJob(job)
    },
    onDownloadDone(job) {
      homeGrabView.setDownloadJob(job)
      albumGrabView.setDownloadJob(job)
    },
  }

  // 初始加载
  void refreshIndex()
  void refreshProducerDb()

  return handle
}
