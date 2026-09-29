// 站点适配页签：imgbb 4 子标签（FP-003）
//
// 架构：用户主页 / 相册抓取两个子场景复用共享抓取视图组件（image-grab-view），
//      下载/筛选/去重/选择/预览/进度与「抓取」页签完全一致，数据源为后台 imgbb fetch。
//      相册分析 / 关注墙为检索场景，保留独立展示。

import { initLogger } from '../lib/logger'
import { sendMessage, type ImgResultKind } from '../lib/messages'
import { extractAlbumId, extractUsername } from '../lib/imgbb-parse'
import {
  noteFor,
  TAG_CATEGORY_LABEL,
  TAG_CATEGORY_ORDER,
  type TagCategory,
  type TagStat,
  type TagCustomDict,
} from '../lib/tag-extract'
import type {
  DownloadJob,
  GrabbedImage,
  ImgbbAlbum,
  ImgbbFollowingUser,
  ImgbbImage,
  DiffuseBatchResult,
  DiffuseSnapshot,
  ScoreBatchResult,
  SearchBatchResult,
  SearchMatch,
} from '../lib/types'
import { createGrabView, type GrabViewHandle } from './image-grab-view'

const logger = initLogger('grabber')

const BATCH_PAGES = 3 // 每批页数（约 32 张/页 → 一批约 100 张）

export interface AdaptersViewHandle {
  onImgbbResult(kind: ImgResultKind, data: ImgbbImage[] | ImgbbAlbum[] | ImgbbFollowingUser[], done: boolean, error?: string): void
  onScoreProgress(msg: { done: number; total: number; username: string; albumCount: number; truncated?: boolean; failed: number; cancelled?: boolean }): void
  onDownloadProgress(job: DownloadJob): void
  onDownloadDone(job: DownloadJob): void
}

/** ImgbbImage → GrabbedImage（显示用展示图，下载用原图，缩略图用服务器 thumb） */
function toGrabbed(img: ImgbbImage): GrabbedImage {
  return {
    id: img.id,
    url: img.mediumUrl || img.originalUrl,
    downloadUrl: img.originalUrl,
    thumbUrl: img.thumbUrl,
    width: img.width,
    height: img.height,
    sizeStatus: img.width && img.height ? 'ok' : 'unknown',
  }
}

export function initAdaptersView(root: HTMLElement, srcTabId: number, sourceUrl?: string): AdaptersViewHandle {
  // ---------- 状态 ----------
  let homeImagesTotal = 0
  let albums: ImgbbAlbum[] = []
  let albumsPage = 0
  let following: ImgbbFollowingUser[] = []
  let followingBatchStart = 0
  let followingDone = false
  let homeFolder = '用户主页' // 用户主页抓取文件夹名（识别用户名后更新）
  let albumFolder = '相册' // 相册抓取文件夹名（解析标题后更新）

  // ---------- DOM 构建 ----------
  root.innerHTML = `
    <div class="adapters-view">
      <div class="adapter-head">
        <h3>imgbb 图床</h3>
        <span class="adapter-hint">子标签均手动触发，不自动解析</span>
      </div>
      <div class="adapter-tabs">
        <button data-sub="home" class="adapter-tab active">用户主页</button>
        <button data-sub="album" class="adapter-tab">相册抓取</button>
        <button data-sub="albums" class="adapter-tab">相册分析</button>
        <button data-sub="following" class="adapter-tab">关注墙</button>
        <button data-sub="diffuse" class="adapter-tab">扩散检索</button>
      </div>

      <div id="sub-home" class="adapter-panel active">
        <div class="row">
          <input id="home-url" class="text-input" placeholder="用户主页 URL，如 https://xxx.imgbb.com/">
          <button id="home-fetch" class="btn primary">抓第一批（约100）</button>
          <button id="home-next" class="btn">下一批</button>
        </div>
        <div class="row">
          <span class="row-label">分页范围</span>
          <input id="home-page-from" class="num-input" value="1" type="number" min="1">
          <span>~</span>
          <input id="home-page-to" class="num-input" value="3" type="number" min="1">
          <button id="home-fetch-pages" class="btn">按页抓取</button>
          <span class="row-label">编号范围</span>
          <input id="home-prefix" class="text-input small" placeholder="前缀如 IMG_">
          <input id="home-from" class="num-input" type="number" min="0" placeholder="起">
          <span>~</span>
          <input id="home-to" class="num-input" type="number" min="0" placeholder="止">
          <button id="home-fetch-range" class="btn">按编号抓取</button>
        </div>
        <div id="home-grab-view" class="grab-view-host"></div>
      </div>

      <div id="sub-album" class="adapter-panel">
        <div class="row">
          <input id="album-url" class="text-input" placeholder="相册 URL，如 https://ibb.co/album/XXXX">
          <button id="album-fetch" class="btn primary">抓取全部图片</button>
        </div>
        <div id="album-grab-view" class="grab-view-host"></div>
      </div>

      <div id="sub-albums" class="adapter-panel">
        <div class="row">
          <input id="albums-user" class="text-input" placeholder="imgbb 用户名，如 u351622">
          <button id="albums-start" class="btn primary">开始分析</button>
          <button id="albums-next" class="btn">下一批</button>
          <span id="albums-status" class="status-text"></span>
        </div>
        <div class="album-grid" id="albums-grid"></div>
      </div>

      <div id="sub-following" class="adapter-panel">
        <div class="row">
          <input id="following-user" class="text-input" placeholder="imgbb 用户名，如 u351622">
          <label class="radio-label"><input type="radio" name="following-side" value="both" checked>全部</label>
          <label class="radio-label"><input type="radio" name="following-side" value="following">关注者</label>
          <label class="radio-label"><input type="radio" name="following-side" value="followers">被关注者</label>
          <button id="following-start" class="btn primary">开始分析</button>
          <button id="following-next" class="btn">下一批</button>
          <span id="following-status" class="status-text"></span>
        </div>
        <div class="following-list" id="following-list"></div>
      </div>

      <div id="sub-diffuse" class="adapter-panel">
        <div class="diffuse-section">
          <div class="section-title">① 广域筛选：following 扩散 → 入度统计</div>
          <div class="row">
            <input id="diffuse-user" class="text-input diffuse-user-input" placeholder="起点用户名">
            <button id="diffuse-start" class="btn primary">开始扩散</button>
            <button id="diffuse-next" class="btn">下一批(50)</button>
            <span id="diffuse-status" class="status-text"></span>
          </div>
          <div class="row">
            <span class="row-label">实时</span>
            <span id="diffuse-progress" class="status-text"></span>
            <span class="row-label">429</span>
            <span id="diffuse-429" class="status-text"></span>
          </div>
          <div class="batch-progress-row">
            <div class="progress-bar thin"><div id="diffuse-batch-fill" class="progress-fill"></div></div>
            <span id="diffuse-batch-text" class="progress-text"></span>
          </div>
          <div class="diffuse-log" id="diffuse-log"></div>
          <table class="batch-history" id="diffuse-history">
            <thead><tr><th>批</th><th>处理</th><th>新增</th><th>失败</th><th>耗时</th><th>均请求</th><th>入度+</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <div class="diffuse-section">
          <div class="section-title">② 生产者库：用户相册统计与评分</div>
          <div class="row">
            <button id="db-save" class="btn">合并入库</button>
            <button id="db-load" class="btn">读取</button>
            <button id="db-reset-confirm" class="btn primary">重新确认</button>
            <button id="db-clear" class="btn danger">清空</button>
            <span id="db-status" class="status-text"></span>
          </div>
          <div class="row">
            <span class="row-label">相册统计</span>
            <button id="score-start" class="btn">确认评分</button>
            <button id="score-next" class="btn">下一批确认</button>
            <button id="score-stop" class="btn danger" disabled>停止</button>
            <label class="radio-label"><input type="radio" name="score-order" value="inDegree" checked>入度优先</label>
            <label class="radio-label"><input type="radio" name="score-order" value="newest">最新优先</label>
            <label class="radio-label"><input type="radio" name="score-order" value="score">评分优先</label>
            <label class="radio-label">每批 <select id="score-batch" class="num-input"><option value="50" selected>50</option><option value="100">100</option><option value="200">200</option></select></label>
            <label class="radio-label">入度权重 <input id="search-w1" class="num-input" value="60" type="number" min="0" max="100" style="width:48px">%</label>
            <span id="score-status" class="status-text"></span>
          </div>
          <div class="row">
            <span class="row-label">排行数量</span>
            <input id="rank-n" class="num-input" value="100" type="number" min="10" max="500" style="width:60px">
          </div>
          <div class="row">
            <span class="row-label">标星悬浮窗</span>
            <button id="star-overlay-toggle" class="btn">启用</button>
            <span id="star-overlay-status" class="status-text"></span>
          </div>
          <div id="db-composition" class="db-composition"></div>
          <div class="rank-groups">
            <div class="rank-group"><div class="rank-title">得分 Top <span class="rank-num" id="rank-score-n">100</span></div><div class="user-list" id="rank-score"></div></div>
            <div class="rank-group"><div class="rank-title">入度 Top <span class="rank-num" id="rank-degree-n">100</span>（第 5 列点击评星）</div><div class="user-list degree-list" id="rank-degree"></div></div>
            <div class="rank-group"><div class="rank-title">相册数 Top <span class="rank-num" id="rank-album-n">100</span>（已确认）</div><div class="user-list" id="rank-album"></div></div>
          </div>
          <div class="row">
            <span class="row-label">会话</span>
            <span id="diffuse-users-total" class="status-text"></span>
          </div>
          <div class="user-list" id="diffuse-users"></div>
          <div class="diffuse-section tag-cloud-section">
            <div class="section-title">⑤ 标签云 v2（词典命中 + 同义归并，点击标签自动检索相册）</div>
            <div class="row">
              <span class="row-label">Top</span>
              <input id="tag-n" class="num-input" value="200" type="number" min="20" max="1000" style="width:64px">
              <span class="row-label">最少相册</span>
              <input id="tag-min-albums" class="num-input" value="5" type="number" min="1" max="100" style="width:52px">
              <span class="row-label">最少用户</span>
              <input id="tag-min-users" class="num-input" value="1" type="number" min="1" max="50" style="width:48px">
              <label class="radio-label"><input type="checkbox" id="tag-slug">含 URL slug</label>
              <button id="tag-refresh" class="btn primary">生成标签云</button>
              <span id="tag-status" class="status-text"></span>
            </div>
            <div class="row">
              <span class="row-label">自定义词</span>
              <input id="tag-custom-word" class="text-input" placeholder="标签名，如 蕾丝手套" style="width:140px">
              <select id="tag-custom-cat" class="num-input"></select>
              <button id="tag-custom-add" class="btn">添加</button>
              <span class="row-label">屏蔽词</span>
              <input id="tag-block-word" class="text-input" placeholder="不想看到的标签" style="width:130px">
              <button id="tag-block-add" class="btn">屏蔽</button>
              <button id="tag-dict-export" class="btn">导出词典</button>
              <button id="tag-dict-import" class="btn">导入词典</button>
              <input id="tag-dict-file" type="file" accept=".json" style="display:none">
            </div>
            <div class="tag-legend" id="tag-legend"></div>
            <div class="tag-blocked-list" id="tag-blocked-list"></div>
            <div class="tag-groups" id="tag-groups"></div>
          </div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">③ 相册关键词检索（纯本地匹配）</div>
          <div class="row">
            <input id="search-keywords" class="text-input" placeholder="关键词，逗号分隔">
            <label class="radio-label">取前 <input id="search-pct" type="range" min="1" max="100" value="100" class="pct-range"> <span id="search-pct-val">100</span>%</label>
            <button id="search-start" class="btn primary">区间检索</button>
            <span id="search-status" class="status-text"></span>
          </div>
          <div class="row">
            <button id="search-prev" class="btn" disabled>上一页</button>
            <span id="search-page" class="status-text"></span>
            <button id="search-next" class="btn" disabled>下一页</button>
            <span id="search-total" class="status-text"></span>
          </div>
          <div class="search-results" id="search-results"></div>
        </div>
        <div class="diffuse-section">
          <div class="section-title">④ 本地数据表（导出 / 导入合并 JSON）</div>
          <div class="row">
            <button id="db-export" class="btn primary">导出数据表</button>
            <button id="db-import" class="btn">导入合并</button>
            <input id="db-import-file" type="file" accept=".json" style="display:none">
            <span class="row-label">提示</span>
            <span class="status-text">导出为 imgbb-producers.json，可保存到本工程目录</span>
            <span id="local-status" class="status-text"></span>
          </div>
        </div>
      </div>
    </div>
  `

  // ---------- 共享抓取视图组件（用户主页 / 相册） ----------
  const homeGrabView: GrabViewHandle = createGrabView(root.querySelector('#home-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => homeFolder,
    getAlbumName: () => homeFolder,
    showReparse: false,
    showLoadMore: false,
  })

  const albumGrabView: GrabViewHandle = createGrabView(root.querySelector('#album-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => albumFolder,
    getAlbumName: () => albumFolder,
    showReparse: false,
    showLoadMore: false,
  })

  // ---------- 工具 ----------
  /** 确保 <all_urls> host 权限（imgbb 后台 fetch 必需；按钮点击手势内申请） */
  async function ensureHostPermission(): Promise<boolean> {
    try {
      if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true
      const ok = await chrome.permissions.request({ origins: ['<all_urls>'] })
      if (ok) {
        void autoFill() // 授权成功后补全自动填充
      }
      return ok
    } catch {
      return false
    }
  }

  /** 文件夹名 = 页面名（清洗非法字符直接使用，无前缀无时间戳） */
  function cleanFolderName(name: string): string {
    return name.replace(/[\\/:*?"<>|\n\r]/g, '_').trim().slice(0, 120) || '未命名'
  }

  function setStatus(el: Element | null, text: string, isError = false): void {
    if (!el) return
    el.textContent = text
    el.classList.toggle('error', isError)
  }

  /** 新开页签：紧贴当前页签右侧（统一新开页逻辑） */
  async function openTab(url: string): Promise<void> {
    try {
      const current = await chrome.tabs.getCurrent()
      const index = current?.index ?? 0
      await chrome.tabs.create({ url, index: index + 1 })
    } catch (err) {
      logger.error('adapters', '新开页签失败', String(err))
    }
  }

  // ---------- 渲染：相册封面 ----------
  function renderAlbums(grid: HTMLElement, items: ImgbbAlbum[]): void {
    grid.innerHTML = ''
    if (items.length === 0) {
      grid.innerHTML = '<div class="empty-tip">暂无相册。请先开始分析。</div>'
      return
    }
    for (const album of items) {
      const card = document.createElement('div')
      card.className = 'album-card'
      card.title = `${album.name}（${album.imageCount !== undefined ? album.imageCount : '?'} 张）`

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
      grid.appendChild(card)
    }
  }

  // ---------- 渲染：关注墙用户 ----------
  function renderFollowing(list: HTMLElement, items: ImgbbFollowingUser[]): void {
    list.innerHTML = ''
    if (items.length === 0) {
      list.innerHTML = '<div class="empty-tip">暂无有效用户（无相册或内容为 0 的用户已跳过）。</div>'
      return
    }
    for (const entry of items) {
      const card = document.createElement('div')
      card.className = 'following-card'

      const head = document.createElement('div')
      head.className = 'following-head'
      head.addEventListener('click', () => void openTab(entry.user.url))

      const avatar = document.createElement('img')
      avatar.className = 'following-avatar'
      avatar.src = entry.user.avatarUrl || ''
      avatar.draggable = false

      const name = document.createElement('span')
      name.className = 'following-name'
      name.textContent = entry.user.username

      head.append(avatar, name)
      card.appendChild(head)

      const covers = document.createElement('div')
      covers.className = 'following-covers'
      // 单用户封面展示上限 50 张
      for (const album of entry.albums.slice(0, 50)) {
        const cover = document.createElement('img')
        cover.className = 'following-cover'
        cover.loading = 'lazy'
        cover.src = album.coverUrl || ''
        cover.draggable = false
        cover.title = album.name
        cover.addEventListener('click', (e) => {
          e.stopPropagation()
          void openTab(album.url)
        })
        covers.appendChild(cover)
      }
      card.appendChild(covers)
      list.appendChild(card)
    }
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

  // ---------- 事件：用户主页 ----------
  const homeUrlInput = root.querySelector('#home-url') as HTMLInputElement
  let homePageCursor = 0

  async function fetchHomePages(pageFrom: number, pageTo: number): Promise<void> {
    const url = homeUrlInput.value.trim()
    if (!url) {
      homeGrabView.setParseText('请填写用户主页 URL')
      return
    }
    if (!(await ensureHostPermission())) {
      homeGrabView.setParseText('需要授权访问 imgbb（<all_urls>）后才能抓取')
      return
    }
    // 文件夹名 = 用户名（页面名）
    const username = extractUsername(url)
    if (username) homeFolder = cleanFolderName(username)
    homeGrabView.setBusyParsing(true)
    homeGrabView.setParseText(`抓取中（page ${pageFrom}~${pageTo}）…`)
    const res = await sendMessage({ type: 'IMG_FETCH_GALLERY', srcTabId, url, pageFrom, pageTo })
    if (!res.ok) {
      homeGrabView.setBusyParsing(false)
      homeGrabView.setParseText(`请求失败：${res.error}`)
    }
  }

  root.querySelector('#home-fetch')?.addEventListener('click', () => {
    homePageCursor = BATCH_PAGES
    void fetchHomePages(1, BATCH_PAGES)
  })
  root.querySelector('#home-next')?.addEventListener('click', () => {
    const from = homePageCursor + 1
    homePageCursor += BATCH_PAGES
    void fetchHomePages(from, homePageCursor)
  })
  root.querySelector('#home-fetch-pages')?.addEventListener('click', () => {
    const from = Number((root.querySelector('#home-page-from') as HTMLInputElement).value) || 1
    const to = Number((root.querySelector('#home-page-to') as HTMLInputElement).value) || from
    homePageCursor = to
    void fetchHomePages(from, to)
  })
  root.querySelector('#home-fetch-range')?.addEventListener('click', () => {
    const url = homeUrlInput.value.trim()
    const prefix = (root.querySelector('#home-prefix') as HTMLInputElement).value.trim()
    const from = Number((root.querySelector('#home-from') as HTMLInputElement).value) || 0
    const to = Number((root.querySelector('#home-to') as HTMLInputElement).value) || 0
    if (!url || !prefix || !from || !to) {
      homeGrabView.setParseText('编号范围需要：URL + 前缀 + 起止编号')
      return
    }
    homeGrabView.setBusyParsing(true)
    homeGrabView.setParseText(`按编号抓取中（${prefix}${from}~${prefix}${to}）…`)
    void sendMessage({ type: 'IMG_FETCH_GALLERY_RANGE', srcTabId, url, prefix, from, to }).then((res) => {
      if (!res.ok) {
        homeGrabView.setBusyParsing(false)
        homeGrabView.setParseText(`请求失败：${res.error}`)
      }
    })
  })

  // ---------- 事件：相册抓取 ----------
  const albumUrlInput = root.querySelector('#album-url') as HTMLInputElement

  root.querySelector('#album-fetch')?.addEventListener('click', async () => {
    const url = albumUrlInput.value.trim()
    if (!url) {
      albumGrabView.setParseText('请填写相册 URL')
      return
    }
    if (!(await ensureHostPermission())) {
      albumGrabView.setParseText('需要授权访问 imgbb（<all_urls>）后才能抓取')
      return
    }
    homeGrabView.setBusyParsing(true)
    homeGrabView.setParseText('抓取中…')
    const res = await sendMessage<{ ok: true; name?: string } | { ok: false; error: string }>({
      type: 'IMG_GET_ALBUM_IMAGES',
      srcTabId,
      albumUrl: url,
    })
    if (res.ok && res.name) albumFolder = cleanFolderName(res.name) // 文件夹名 = 相册页标题
    if (!res.ok) {
      albumGrabView.setBusyParsing(false)
      albumGrabView.setParseText(`请求失败：${res.error}`)
    }
  })

  // ---------- 事件：相册分析 ----------
  const albumsStatus = root.querySelector('#albums-status')
  const albumsUserInput = root.querySelector('#albums-user') as HTMLInputElement
  const albumsGrid = root.querySelector('#albums-grid') as HTMLElement

  async function fetchAlbumsPage(page: number): Promise<void> {
    const username = albumsUserInput.value.trim().toLowerCase()
    if (!username) {
      setStatus(albumsStatus, '请填写 imgbb 用户名', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(albumsStatus, '需要授权访问 imgbb（<all_urls>）后才能分析', true)
      return
    }
    setStatus(albumsStatus, `分析中（第 ${page} 批）…`)
    const res = await sendMessage({ type: 'IMG_ANALYZE_ALBUMS', srcTabId, username, page })
    if (res.ok) {
      // 请求成功即推进页码（IMG_RESULT 推送先于本响应到达，albums 已追加）
      albumsPage = page
    } else {
      setStatus(albumsStatus, `请求失败：${res.error}`, true)
    }
  }

  root.querySelector('#albums-start')?.addEventListener('click', () => {
    albums = []
    albumsPage = 0
    renderAlbums(albumsGrid, [])
    void fetchAlbumsPage(1)
  })
  root.querySelector('#albums-next')?.addEventListener('click', () => {
    void fetchAlbumsPage(albumsPage + 1)
  })

  // ---------- 事件：关注墙 ----------
  const followingStatus = root.querySelector('#following-status')
  const followingUserInput = root.querySelector('#following-user') as HTMLInputElement
  const followingList = root.querySelector('#following-list') as HTMLElement

  async function fetchFollowingBatch(batchStart: number): Promise<void> {
    const username = followingUserInput.value.trim().toLowerCase()
    if (!username) {
      setStatus(followingStatus, '请填写 imgbb 用户名', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(followingStatus, '需要授权访问 imgbb（<all_urls>）后才能分析', true)
      return
    }
    const sideEl = root.querySelector<HTMLInputElement>('input[name="following-side"]:checked')
    const side = (sideEl ? sideEl.value : 'both') as 'following' | 'followers' | 'both'
    const sideLabel = side === 'both' ? '关注+被关注' : side === 'following' ? '关注者' : '被关注者'
    setStatus(followingStatus, `分析中（${sideLabel}，用户 ${batchStart + 1} 起，单批 30）…`)
    const res = await sendMessage({ type: 'IMG_ANALYZE_FOLLOWING', srcTabId, username, side, batchStart, batchSize: 30 })
    if (!res.ok) setStatus(followingStatus, `请求失败：${res.error}`, true)
  }

  root.querySelector('#following-start')?.addEventListener('click', () => {
    following = []
    followingBatchStart = 0
    followingDone = false
    renderFollowing(followingList, [])
    void fetchFollowingBatch(0)
  })
  root.querySelector('#following-next')?.addEventListener('click', () => {
    if (followingDone) {
      setStatus(followingStatus, '已无更多用户')
      return
    }
    followingBatchStart += 30
    void fetchFollowingBatch(followingBatchStart)
  })

  // 方向切换：清空结果并提示重新分析
  root.querySelectorAll<HTMLInputElement>('input[name="following-side"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      following = []
      followingBatchStart = 0
      followingDone = false
      renderFollowing(followingList, [])
      setStatus(followingStatus, '方向已切换，请点击「开始分析」')
    })
  })

  // ---------- 事件：扩散检索（FP-005） ----------
  const diffuseStatus = root.querySelector('#diffuse-status')
  const diffuseProgress = root.querySelector('#diffuse-progress')
  const diffuse429El = root.querySelector('#diffuse-429')
  const diffuseUserInput = root.querySelector('#diffuse-user') as HTMLInputElement
  const diffuseNextBtn = root.querySelector('#diffuse-next') as HTMLButtonElement | null
  const diffuseBatchFill = root.querySelector('#diffuse-batch-fill') as HTMLElement | null
  const diffuseBatchText = root.querySelector('#diffuse-batch-text') as HTMLElement | null
  const diffuseHistoryBody = root.querySelector('#diffuse-history tbody') as HTMLElement | null
  const diffuseLogEl = root.querySelector('#diffuse-log') as HTMLElement | null
  const diffuseUsersEl = root.querySelector('#diffuse-users') as HTMLElement | null
  const diffuseUsersTotal = root.querySelector('#diffuse-users-total') as HTMLElement | null
  const rankScoreEl = root.querySelector('#rank-score') as HTMLElement | null
  const rankDegreeEl = root.querySelector('#rank-degree') as HTMLElement | null
  const rankAlbumEl = root.querySelector('#rank-album') as HTMLElement | null
  const rankScoreN = root.querySelector('#rank-score-n') as HTMLElement | null
  const rankDegreeN = root.querySelector('#rank-degree-n') as HTMLElement | null
  const rankAlbumN = root.querySelector('#rank-album-n') as HTMLElement | null
  const rankNInput = root.querySelector('#rank-n') as HTMLInputElement | null
  const dbStatus = root.querySelector('#db-status')

  const DIFFUSE_BATCH_SIZE = 50
  const DIFFUSE_CONCURRENCY = 4
  const DIFFUSE_INTERVAL_MS = 1000
  const POLL_MS = 2000
  const USER_LIST_LIMIT = 100 // 用户列表显示上限（避免 2s 全量重渲染卡顿）

  // 前端会话状态
  let batchCounter = 0
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let lastLogLen = 0
  const batchHistory: {
    batch: number
    processed: number
    newUsers: number
    failed: number
    durationMs: number
    avgRequestMs: number
    inDegreeUsers: number
  }[] = []

  function stopPoll(): void {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function renderBatchProgress(snapshot: DiffuseSnapshot): void {
    const total = snapshot.inBatchSize
    const done = snapshot.inBatchProcessed
    if (diffuseBatchFill && diffuseBatchText) {
      const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
      diffuseBatchFill.style.width = `${pct}%`
      diffuseBatchText.textContent =
        total > 0 ? `本批 ${done}/${total}（失败 ${snapshot.inBatchFailed}）` : '空闲'
    }
  }

  /** 运行日志：增量追加 + 自动滚动（判断是否卡住） */
  function renderDiffuseLog(logs: string[]): void {
    if (!diffuseLogEl) return
    for (let i = lastLogLen; i < logs.length; i++) {
      const div = document.createElement('div')
      div.textContent = logs[i]
      if (logs[i].startsWith('✗')) div.className = 'log-fail'
      else if (logs[i].startsWith('✓')) div.className = 'log-ok'
      else div.className = 'log-info'
      diffuseLogEl.appendChild(div)
    }
    lastLogLen = logs.length
    // 保留最近 100 条 DOM
    while (diffuseLogEl.children.length > 100) diffuseLogEl.removeChild(diffuseLogEl.firstChild!)
    diffuseLogEl.scrollTop = diffuseLogEl.scrollHeight
  }

  /** 会话检索到的用户列表（实时，三栏：得分- / 入度 / 相册数待确认） */
  function renderSessionUsers(snapshot: DiffuseSnapshot): void {
    if (diffuseUsersTotal) {
      diffuseUsersTotal.textContent = `会话 ${snapshot.userTotal} 人（显示前 ${USER_LIST_LIMIT}）`
    }
    if (!diffuseUsersEl) return
    const list = snapshot.users.slice(0, USER_LIST_LIMIT)
    diffuseUsersEl.innerHTML = list
      .map(
        (u, i) =>
          `<div class="user-row"><span class="user-rank">${i + 1}</span><a href="https://${u.username}.imgbb.com" target="_blank">${u.username}</a><span class="user-score">-</span><span class="user-degree">${u.inDegree}</span><span class="user-albums">待确认</span></div>`,
      )
      .join('')
  }

  /** 库内三组排行（得分 / 入度 / 相册数） */
  function renderRanks(res: {
    rankScore?: { username: string; url: string; inDegree: number; albumCount?: number; score: number; truncated?: boolean }[]
    rankDegree?: { username: string; url: string; inDegree: number; starRating: number }[]
    rankAlbum?: { username: string; url: string; albumCount: number; inDegree: number; truncated?: boolean }[]
    total: number
  }): void {
    const n = res.total
    if (rankScoreN) rankScoreN.textContent = String(n)
    if (rankDegreeN) rankDegreeN.textContent = String(n)
    if (rankAlbumN) rankAlbumN.textContent = String(n)
    const albumCell = (count: number | undefined, truncated: boolean | undefined, username: string): string => {
      const val = count ?? '-'
      const plus = truncated ? '+' : ''
      return truncated
        ? `<span class="user-albums truncated" data-full="${username}" title="未遍历完，点击彻底遍历">${val}${plus}</span>`
        : `<span class="user-albums">${val}</span>`
    }
    // 手动星级（FP-015）：5 颗星，点击第 N 颗 = N 星，再点同一颗 = 取消评星
    const starCell = (username: string, stars: number): string => {
      const cur = Math.max(0, Math.min(5, Math.round(Number(stars)) || 0))
      const starsHtml = [1, 2, 3, 4, 5]
        .map((s) => `<span class="star${s <= cur ? ' on' : ''}" data-v="${s}">${s <= cur ? '★' : '☆'}</span>`)
        .join('')
      return `<span class="star-rate" data-user="${username}" data-stars="${cur}" title="点击评星（1~5 星），再点同一颗取消">${starsHtml}</span>`
    }
    if (rankScoreEl) {
      rankScoreEl.innerHTML = (res.rankScore ?? [])
        .map(
          (u, i) =>
            `<div class="user-row"><span class="user-rank">${i + 1}</span><a href="${u.url}" target="_blank">${u.username}</a><span class="user-score">${u.score.toFixed(2)}</span><span class="user-degree">${u.inDegree}</span>${albumCell(u.albumCount, u.truncated, u.username)}</div>`,
        )
        .join('')
    }
    if (rankDegreeEl) {
      rankDegreeEl.innerHTML = (res.rankDegree ?? [])
        .map(
          (u, i) =>
            `<div class="user-row"><span class="user-rank">${i + 1}</span><a href="${u.url}" target="_blank">${u.username}</a><span class="user-score">-</span><span class="user-degree">${u.inDegree}</span>${starCell(u.username, u.starRating)}</div>`,
        )
        .join('')
    }
    if (rankAlbumEl) {
      rankAlbumEl.innerHTML = (res.rankAlbum ?? [])
        .map(
          (u, i) =>
            `<div class="user-row"><span class="user-rank">${i + 1}</span><a href="${u.url}" target="_blank">${u.username}</a><span class="user-score">-</span><span class="user-degree">${u.inDegree}</span>${albumCell(u.albumCount, u.truncated, u.username)}</div>`,
        )
        .join('')
    }
  }

  // 点击截断相册数 → 单用户彻底遍历
  const onTruncatedClick = async (ev: Event): Promise<void> => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.truncated')
    if (!el) return
    const username = el.dataset.full
    if (!username) return
    if (!window.confirm(`彻底遍历 ${username} 的全部相册（最多 300 页，耗时较长）？`)) return
    setStatus(dbStatus, `彻底遍历 ${username} 中…`)
    const res = await sendMessage<
      { ok: true; full?: { username: string; albumCount: number; truncated: boolean } } | { ok: false; error: string }
    >({ type: 'IMG_SCORE_FULL', username })
    if (!res.ok) {
      setStatus(dbStatus, `彻底遍历失败：${res.error}`, true)
      return
    }
    setStatus(dbStatus, `${username} 相册数更新为 ${res.full?.albumCount}${res.full?.truncated ? '（仍超 300 页上限）' : ''}`)
    void loadDbStats()
  }
  rankScoreEl?.addEventListener('click', onTruncatedClick)
  rankAlbumEl?.addEventListener('click', onTruncatedClick)

  // 手动星级（FP-015）：入度 Top 第 5 列点击评星（事件委托，列表 innerHTML 重建无需重绑）
  const onStarClick = async (ev: Event): Promise<void> => {
    const starEl = (ev.target as HTMLElement).closest<HTMLElement>('.star')
    if (!starEl) return
    const box = starEl.closest<HTMLElement>('.star-rate')
    const username = box?.dataset.user
    const clicked = Number(starEl.dataset.v) || 0
    if (!box || !username || clicked <= 0) return
    const current = Number(box.dataset.stars) || 0
    const next = current === clicked ? 0 : clicked // 再点同一颗 = 取消评星
    // 本地即时点亮/熄灭（不等后台往返）
    box.dataset.stars = String(next)
    box.querySelectorAll<HTMLElement>('.star').forEach((el) => {
      const v = Number(el.dataset.v) || 0
      const on = v <= next
      el.classList.toggle('on', on)
      el.textContent = on ? '★' : '☆'
    })
    const res = await sendMessage<{ ok: true; starRating?: number } | { ok: false; error: string }>({
      type: 'IMG_DB_SET_STAR',
      username,
      stars: next,
    })
    if (!res.ok) {
      setStatus(dbStatus, `星级保存失败：${res.error}`, true)
      return
    }
    logger.info('adapters', '手动星级已设置', { username, stars: next })
    setStatus(dbStatus, `${username} 星级：${next} 星（已计入评分）`)
    void loadDbStats() // 星级进入综合评分 → 刷新得分 Top
  }
  rankDegreeEl?.addEventListener('click', (ev) => void onStarClick(ev))

  function renderDiffuse(snapshot?: DiffuseSnapshot, result?: DiffuseBatchResult): void {
    if (diffuseProgress && snapshot) {
      diffuseProgress.textContent = `已探索 ${snapshot.visitedTotal} · 队列 ${snapshot.queueSize} · 累计请求 ${snapshot.totalRequests}`
    }
    if (diffuse429El && snapshot) {
      diffuse429El.textContent = snapshot.consecutive429 > 0 ? `×${snapshot.consecutive429}（限流中）` : '正常'
      diffuse429El.classList.toggle('error', snapshot.consecutive429 >= 3)
    }
    if (snapshot) {
      renderBatchProgress(snapshot)
      renderDiffuseLog(snapshot.recentLog)
      renderSessionUsers(snapshot)
    }
    if (diffuseStatus && result) {
      const tail = result.done ? ' · 队列已耗尽' : ''
      setStatus(
        diffuseStatus,
        `本批 ${result.processed} 人 · 新增 ${result.newUsers} · 失败 ${result.failed} · 耗时 ${(result.durationMs / 1000).toFixed(1)}s · 均请求 ${result.avgRequestMs}ms · 入度+${Object.keys(result.inDegreeDelta).length}${tail}`,
      )
    }
  }

  function pushBatchHistory(result: DiffuseBatchResult): void {
    batchCounter++
    batchHistory.push({
      batch: batchCounter,
      processed: result.processed,
      newUsers: result.newUsers,
      failed: result.failed,
      durationMs: result.durationMs,
      avgRequestMs: result.avgRequestMs,
      inDegreeUsers: Object.keys(result.inDegreeDelta).length,
    })
    if (!diffuseHistoryBody) return
    // 只保留最近 20 批
    while (diffuseHistoryBody.children.length > 20) diffuseHistoryBody.removeChild(diffuseHistoryBody.firstChild!)
    const tr = document.createElement('tr')
    const h = batchHistory[batchHistory.length - 1]
    tr.innerHTML = `<td>${h.batch}</td><td>${h.processed}</td><td>${h.newUsers}</td><td>${h.failed}</td><td>${(h.durationMs / 1000).toFixed(1)}s</td><td>${h.avgRequestMs}ms</td><td>${h.inDegreeUsers}</td>`
    diffuseHistoryBody.appendChild(tr)
  }

  async function runDiffuseBatch(): Promise<void> {
    if (!diffuseNextBtn) return
    diffuseNextBtn.disabled = true
    setStatus(diffuseStatus, '扩散中（并发 4 · 间隔 1s）…')
    // 批内轮询：实时刷新本批进度 + 运行日志 + 用户列表
    stopPoll()
    pollTimer = setInterval(() => {
      void sendMessage<{ ok: true; snapshot: DiffuseSnapshot } | { ok: false; error: string }>({ type: 'IMG_DIFFUSE_PROGRESS' }).then((res) => {
        if (res.ok) {
          renderBatchProgress(res.snapshot)
          renderDiffuseLog(res.snapshot.recentLog)
          renderSessionUsers(res.snapshot)
        }
      })
    }, POLL_MS)
    const res = await sendMessage<
      { ok: true; result: DiffuseBatchResult; snapshot: DiffuseSnapshot } | { ok: false; error: string }
    >({
      type: 'IMG_DIFFUSE_BATCH',
      srcTabId,
      batchSize: DIFFUSE_BATCH_SIZE,
      concurrency: DIFFUSE_CONCURRENCY,
      intervalMs: DIFFUSE_INTERVAL_MS,
    })
    stopPoll()
    diffuseNextBtn.disabled = false
    if (!res.ok) {
      setStatus(diffuseStatus, `扩散失败：${res.error}`, true)
      return
    }
    pushBatchHistory(res.result)
    renderDiffuse(res.snapshot, res.result)
    if (res.result.done) setStatus(diffuseStatus, '队列已耗尽，扩散完成（可点「合并入库」保存）')
  }

  root.querySelector('#diffuse-start')?.addEventListener('click', async () => {
    const user = diffuseUserInput.value.trim().toLowerCase()
    if (!user) {
      setStatus(diffuseStatus, '请填写起点用户名', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus(diffuseStatus, '需要授权访问 imgbb（<all_urls>）后才能扩散', true)
      return
    }
    // 重置前端会话状态
    batchCounter = 0
    batchHistory.length = 0
    lastLogLen = 0
    if (diffuseHistoryBody) diffuseHistoryBody.innerHTML = ''
    if (diffuseLogEl) diffuseLogEl.innerHTML = ''
    if (diffuseUsersEl) diffuseUsersEl.innerHTML = ''
    setStatus(diffuseStatus, '已重置扩散状态机，开始第一批…')
    const res = await sendMessage<{ ok: true; snapshot: DiffuseSnapshot } | { ok: false; error: string }>({
      type: 'IMG_DIFFUSE_START',
      srcTabId,
      startUser: user,
    })
    if (!res.ok) {
      setStatus(diffuseStatus, `启动失败：${res.error}`, true)
      return
    }
    renderDiffuse(res.snapshot)
    void runDiffuseBatch()
  })

  diffuseNextBtn?.addEventListener('click', () => void runDiffuseBatch())

  root.querySelector('#db-save')?.addEventListener('click', async () => {
    const source = diffuseUserInput.value.trim().toLowerCase() || 'manual'
    const res = await sendMessage<
      { ok: true; total: number; confirmed: number; producers: number; maxInDegree: number } | { ok: false; error: string }
    >({ type: 'IMG_DB_SAVE', source })
    if (!res.ok) {
      setStatus(dbStatus, `保存失败：${res.error}`, true)
      return
    }
    setStatus(dbStatus, `已保存入库（起点 ${source}），库内 ${res.total} 用户`)
    // 保存后刷新统计面板
    void loadDbStats()
  })

  async function loadDbStats(): Promise<void> {
    const w1 = Math.max(0, Math.min(100, Number(searchW1Input.value) || 60)) / 100
    const topN = Math.max(10, Math.min(500, Number(rankNInput?.value) || 100))
    const res = await sendMessage<
      {
        ok: true
        db: import('../lib/producer-db').ProducerDb
        total: number
        confirmed: number
        producers: number
        maxInDegree: number
        rankScore?: { username: string; url: string; inDegree: number; albumCount?: number; score: number }[]
        rankDegree?: { username: string; url: string; inDegree: number; starRating: number }[]
        rankAlbum?: { username: string; url: string; albumCount: number; inDegree: number }[]
      } | { ok: false; error: string }
    >({ type: 'IMG_DB_GET', w1, topN })
    if (!res.ok) {
      setStatus(dbStatus, `读取失败：${res.error}`, true)
      return
    }
    renderRanks(res)
    // 库构成：可检索 = 库 − 未确认 − 零相册
    const unconfirmed = res.total - res.confirmed
    const zeroAlbums = res.confirmed - res.producers
    const compEl = root.querySelector('#db-composition')
    if (compEl) {
      compEl.textContent = `可检索 ${res.producers} = 库 ${res.total} − 未确认 ${unconfirmed} − 零相册 ${zeroAlbums}`
    }
    setStatus(dbStatus, `已读取本地库，库内 ${res.total} 用户`)
  }

  // 排行数量变化 → 刷新
  rankNInput?.addEventListener('change', () => void loadDbStats())

  // ---------- 标星悬浮窗开关（FP-017：在 imgbb 用户页/相册页注入评星浮窗） ----------
  const STAR_OVERLAY_ORIGINS = ['*://*.imgbb.com/*', '*://ibb.co/*']
  const starOverlayBtn = root.querySelector('#star-overlay-toggle') as HTMLButtonElement | null
  const starOverlayStatus = root.querySelector('#star-overlay-status')
  let starOverlayEnabled = false

  async function refreshOverlayStatus(): Promise<void> {
    const res = await sendMessage<
      { ok: true; overlay?: { enabled: boolean; registered: boolean } } | { ok: false; error: string }
    >({ type: 'STAR_OVERLAY_STATUS' })
    if (!res.ok) {
      setStatus(starOverlayStatus, `状态读取失败：${res.error}`, true)
      return
    }
    starOverlayEnabled = !!res.overlay?.enabled
    if (starOverlayBtn) starOverlayBtn.textContent = starOverlayEnabled ? '关闭' : '启用'
    setStatus(
      starOverlayStatus,
      starOverlayEnabled ? '已启用：imgbb 用户页 / 相册详情页右下角显示评星浮窗' : '未启用',
    )
  }

  async function toggleStarOverlay(): Promise<void> {
    if (starOverlayEnabled) {
      const res = await sendMessage<{ ok: true; overlay?: { enabled: boolean; registered: boolean } } | { ok: false; error: string }>({
        type: 'STAR_OVERLAY_SET',
        enabled: false,
      })
      if (!res.ok) {
        setStatus(starOverlayStatus, `关闭失败：${res.error}`, true)
        return
      }
      logger.info('adapters', '标星悬浮窗已关闭')
      setStatus(starOverlayStatus, '已关闭标星悬浮窗')
      void refreshOverlayStatus()
      return
    }
    // 权限申请必须发生在用户手势内（此处是点击后的第一个 await）
    const granted = await chrome.permissions.request({ origins: STAR_OVERLAY_ORIGINS })
    if (!granted) {
      setStatus(starOverlayStatus, '未授权 imgbb 域访问，悬浮窗未启用', true)
      return
    }
    const res = await sendMessage<{ ok: true; overlay?: { enabled: boolean; registered: boolean } } | { ok: false; error: string }>({
      type: 'STAR_OVERLAY_SET',
      enabled: true,
    })
    if (!res.ok) {
      setStatus(starOverlayStatus, `启用失败：${res.error}`, true)
      return
    }
    logger.info('adapters', '标星悬浮窗已启用')
    setStatus(starOverlayStatus, '已启用：打开 imgbb 用户页 / 相册页即可看到评星浮窗')
    void refreshOverlayStatus()
  }

  starOverlayBtn?.addEventListener('click', () => void toggleStarOverlay())
  void refreshOverlayStatus()

  root.querySelector('#db-load')?.addEventListener('click', () => void loadDbStats())

  root.querySelector('#db-reset-confirm')?.addEventListener('click', async () => {
    const ok = window.confirm('重置所有用户的相册确认状态（保留入度）并立即开始重新确认？')
    if (!ok) return
    const res = await sendMessage<{ ok: true; total?: number } | { ok: false; error: string }>({ type: 'IMG_DB_RESET_CONFIRM' })
    if (!res.ok) {
      setStatus(dbStatus, `重置失败：${res.error}`, true)
      return
    }
    setStatus(dbStatus, `已重置确认状态（${res.total} 用户保留），开始重新确认…`)
    void loadDbStats()
    void runScoreBatch() // 自动开始重新确认第一批
  })

  root.querySelector('#db-clear')?.addEventListener('click', async () => {
    const res = await sendMessage<{ ok: true } | { ok: false; error: string }>({ type: 'IMG_DB_CLEAR' })
    if (!res.ok) {
      setStatus(dbStatus, `清空失败：${res.error}`, true)
      return
    }
    if (rankScoreEl) rankScoreEl.innerHTML = ''
    if (rankDegreeEl) rankDegreeEl.innerHTML = ''
    if (rankAlbumEl) rankAlbumEl.innerHTML = ''
    const compEl = root.querySelector('#db-composition')
    if (compEl) compEl.textContent = ''
    setStatus(dbStatus, '生产者库已清空')
  })

  // ---------- 事件：确认评分（② 区）+ 区间检索（③ 区） ----------
  const scoreStatus = root.querySelector('#score-status')
  const searchStatus = root.querySelector('#search-status')
  const searchResultsEl = root.querySelector('#search-results') as HTMLElement | null
  const searchKeywordsInput = root.querySelector('#search-keywords') as HTMLInputElement
  const searchPctInput = root.querySelector('#search-pct') as HTMLInputElement
  const searchPctVal = root.querySelector('#search-pct-val') as HTMLElement | null
  const searchW1Input = root.querySelector('#search-w1') as HTMLInputElement
  const searchPrevBtn = root.querySelector('#search-prev') as HTMLButtonElement | null
  const searchNextBtn = root.querySelector('#search-next') as HTMLButtonElement | null
  const searchPageEl = root.querySelector('#search-page') as HTMLElement | null
  const searchTotalEl = root.querySelector('#search-total') as HTMLElement | null
  const scoreNextBtn = root.querySelector('#score-next') as HTMLButtonElement | null
  const scoreStopBtn = root.querySelector('#score-stop') as HTMLButtonElement | null
  // 进度刷新节流（2s 内最多一次 loadDbStats）
  let lastScoreRefresh = 0
  // 检索结果分页（每页 100 条）
  const SEARCH_PAGE_SIZE = 100
  let searchAll: SearchMatch[] = []
  let searchPage = 0

  searchPctInput?.addEventListener('input', () => {
    if (searchPctVal) searchPctVal.textContent = searchPctInput.value
  })

  // 权重调整 → 立即刷新得分列表（得分随权重变化）
  searchW1Input?.addEventListener('input', () => void loadDbStats())

  function renderScoreResult(score: ScoreBatchResult, unconfirmed: number): void {
    setStatus(
      scoreStatus,
      `确认 ${score.processed} 人：有相册 ${score.withAlbums} · 零相册 ${score.zeroAlbums} · 失败 ${score.failed} · 剩余未确认 ${unconfirmed}${score.done ? '（全部确认完毕）' : ''}`,
    )
  }

  function renderSearchPage(): void {
    if (!searchResultsEl) return
    const total = searchAll.length
    const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE))
    if (searchPage >= pages) searchPage = pages - 1
    const slice = searchAll.slice(searchPage * SEARCH_PAGE_SIZE, (searchPage + 1) * SEARCH_PAGE_SIZE)
    searchResultsEl.innerHTML = ''
    if (total === 0) {
      searchResultsEl.innerHTML = '<div class="empty-tip">无命中</div>'
    }
    for (const m of slice) {
      const block = document.createElement('div')
      block.className = 'search-hit'
      block.innerHTML = `<div class="search-user"><a href="https://${m.username}.imgbb.com" target="_blank">${m.username}</a><span class="user-degree">入度 ${m.inDegree}</span></div>`
      for (const a of m.albums) {
        const line = document.createElement('div')
        line.className = 'search-album'
        line.innerHTML = `<a href="${a.url}" target="_blank">${a.name}</a>`
        block.appendChild(line)
      }
      searchResultsEl.appendChild(block)
    }
    if (searchPageEl) searchPageEl.textContent = total > 0 ? `第 ${searchPage + 1}/${pages} 页` : ''
    if (searchTotalEl) searchTotalEl.textContent = total > 0 ? `共命中 ${total} 条` : ''
    if (searchPrevBtn) searchPrevBtn.disabled = searchPage <= 0
    if (searchNextBtn) searchNextBtn.disabled = searchPage >= pages - 1
  }

  async function runScoreBatch(): Promise<void> {
    if (scoreNextBtn) scoreNextBtn.disabled = true
    if (scoreStopBtn) scoreStopBtn.disabled = false
    const orderEl = root.querySelector<HTMLInputElement>('input[name="score-order"]:checked')
    const order = (orderEl?.value as 'inDegree' | 'newest' | 'score') || 'inDegree'
    const batchSize = Number((root.querySelector('#score-batch') as HTMLSelectElement)?.value) || 50
    const w1 = Math.max(0, Math.min(100, Number(searchW1Input.value) || 60)) / 100
    const orderLabel = order === 'newest' ? '最新优先' : order === 'score' ? '评分优先' : '入度优先'
    setStatus(scoreStatus, `确认评分中（${orderLabel} · 每批 ${batchSize} · 并发 4）…`)
    const res = await sendMessage<
      { ok: true; score: ScoreBatchResult; unconfirmed?: number; cancelled?: boolean } | { ok: false; error: string }
    >({ type: 'IMG_SCORE_BATCH', srcTabId, batchSize, concurrency: 4, intervalMs: 1000, order, w1, w2: 1 - w1 })
    if (scoreNextBtn) scoreNextBtn.disabled = false
    if (scoreStopBtn) scoreStopBtn.disabled = true
    if (!res.ok) {
      setStatus(scoreStatus, `确认失败：${res.error}`, true)
      return
    }
    if (res.cancelled) {
      setStatus(scoreStatus, `已停止：本批确认 ${res.score.processed} 人（保留已确认部分）`)
    } else {
      renderScoreResult(res.score, res.unconfirmed ?? 0)
    }
    void loadDbStats() // 刷新库统计
  }

  root.querySelector('#score-start')?.addEventListener('click', async () => {
    if (!(await ensureHostPermission())) {
      setStatus(scoreStatus, '需要授权访问 imgbb（<all_urls>）后才能确认评分', true)
      return
    }
    void runScoreBatch()
  })
  scoreNextBtn?.addEventListener('click', () => void runScoreBatch())

  scoreStopBtn?.addEventListener('click', () => {
    void sendMessage<{ ok: true } | { ok: false; error: string }>({ type: 'IMG_SCORE_STOP' })
    setStatus(scoreStatus, '停止请求已发送，等待当前用户完成…')
  })

  async function runSearch(): Promise<void> {
    const keywords = searchKeywordsInput.value.split(/[,，]/).map((k) => k.trim()).filter(Boolean)
    if (keywords.length === 0) {
      setStatus(searchStatus, '请填写关键词', true)
      return
    }
    const toPct = Math.max(1, Math.min(100, Number(searchPctInput?.value) || 100))
    const w1 = Math.max(0, Math.min(100, Number(searchW1Input.value) || 60)) / 100
    setStatus(searchStatus, `检索中（取前 ${toPct}% · 权重 ${Math.round(w1 * 100)}/${100 - Math.round(w1 * 100)}）…`)
    const res = await sendMessage<
      { ok: true; search: SearchBatchResult; unconfirmed?: number } | { ok: false; error: string }
    >({ type: 'IMG_SEARCH_START', keywords, fromPct: 0, toPct, w1, w2: 1 - w1, batchSize: SEARCH_PAGE_SIZE })
    if (!res.ok) {
      setStatus(searchStatus, `检索失败：${res.error}`, true)
      return
    }
    if (res.search.total === 0) {
      const un = res.unconfirmed ?? 0
      setStatus(
        searchStatus,
        un > 0
          ? `无可检索用户：库内还有 ${un} 个未确认，请先在②区点「确认评分」补相册数`
          : '无可检索用户：库内已确认用户均无相册，请先扩散更多起点',
        true,
      )
      searchAll = []
      searchPage = 0
      renderSearchPage()
      return
    }
    searchAll = res.search.matches
    searchPage = 0
    renderSearchPage()
    setStatus(searchStatus, `检索完成：命中 ${res.search.total} 条（前 ${toPct}% 候选）`)
  }

  root.querySelector('#search-start')?.addEventListener('click', () => void runSearch())
  searchPrevBtn?.addEventListener('click', () => {
    if (searchPage > 0) {
      searchPage--
      renderSearchPage()
    }
  })
  searchNextBtn?.addEventListener('click', () => {
    if (searchPage < Math.ceil(searchAll.length / SEARCH_PAGE_SIZE) - 1) {
      searchPage++
      renderSearchPage()
    }
  })

  // ---------- 事件：标签云 v2（FP-016：双通道提取 + 同义归并 + 分组筛选 + 自定义词典） ----------
  const tagStatus = root.querySelector('#tag-status')
  const tagGroupsEl = root.querySelector('#tag-groups') as HTMLElement | null
  const tagLegendEl = root.querySelector('#tag-legend') as HTMLElement | null
  const tagNInput = root.querySelector('#tag-n') as HTMLInputElement | null
  const tagMinAlbumsInput = root.querySelector('#tag-min-albums') as HTMLInputElement | null
  const tagMinUsersInput = root.querySelector('#tag-min-users') as HTMLInputElement | null
  const tagSlugCheck = root.querySelector('#tag-slug') as HTMLInputElement | null
  const tagCustomWordInput = root.querySelector('#tag-custom-word') as HTMLInputElement | null
  const tagCustomCatSelect = root.querySelector('#tag-custom-cat') as HTMLSelectElement | null
  const tagBlockWordInput = root.querySelector('#tag-block-word') as HTMLInputElement | null
  const tagBlockedListEl = root.querySelector('#tag-blocked-list') as HTMLElement | null
  const tagDictFileInput = root.querySelector('#tag-dict-file') as HTMLInputElement | null

  const TAG_COLOR: Record<string, string> = {
    japanese: '#4a9eff', korean: '#c792ea', ip: '#f2a65a', theme: '#7bc47f', scene: '#5ac8d8',
    clothes: '#e07ab5', fetish: '#d16ba5', act: '#e5646b', prop: '#b0a06a', body: '#8fbc5a',
    relation: '#c0a0e0', brand: '#e8a03a', english: '#9aa5b1', at: '#5ac8d8',
  }

  let tagStats: TagStat[] = []
  let tagFilter = 'all'
  let tagDict: TagCustomDict = { entries: [], blocked: [] }

  const tagColor = (c: string): string => TAG_COLOR[c] ?? '#999'

  if (tagCustomCatSelect) {
    tagCustomCatSelect.innerHTML = TAG_CATEGORY_ORDER.map(
      (c) => `<option value="${c}">${TAG_CATEGORY_LABEL[c]}</option>`,
    ).join('')
  }

  function renderBlockedList(): void {
    if (!tagBlockedListEl) return
    if (tagDict.blocked.length === 0) {
      tagBlockedListEl.textContent = ''
      return
    }
    tagBlockedListEl.innerHTML =
      `<span class="row-label">已屏蔽 ${tagDict.blocked.length}</span>` +
      tagDict.blocked
        .map((b) => `<span class="blocked-tag" data-block="${b}" title="点击取消屏蔽">${b} ×</span>`)
        .join('')
  }

  async function loadTagDict(): Promise<void> {
    const res = await sendMessage<{ ok: true; tagDict?: TagCustomDict } | { ok: false; error: string }>({
      type: 'IMG_TAG_DICT_GET',
    })
    if (res.ok && res.tagDict) {
      tagDict = res.tagDict
      renderBlockedList()
    }
  }

  async function saveTagDict(): Promise<void> {
    const res = await sendMessage<{ ok: true; tagDict?: TagCustomDict } | { ok: false; error: string }>({
      type: 'IMG_TAG_DICT_SAVE',
      tagDict,
    })
    if (!res.ok) {
      setStatus(tagStatus, `词典保存失败：${res.error}`, true)
      return
    }
    if (res.tagDict) tagDict = res.tagDict
    renderBlockedList()
    logger.info('adapters', '标签词典已保存', { entries: tagDict.entries.length, blocked: tagDict.blocked.length })
    void refreshTagCloud()
  }

  function renderTagLegend(): void {
    if (!tagLegendEl) return
    const catCount: Record<string, number> = {}
    for (const t of tagStats) catCount[t.c] = (catCount[t.c] ?? 0) + 1
    const chip = (key: string, label: string, n: number, color: string): string =>
      `<span class="tag-chip${tagFilter === key ? ' on' : ''}" data-cat="${key}" style="--chip:${color}">${label} ${n}</span>`
    let html = chip('all', '全部', tagStats.length, '#9aa5b1')
    for (const c of TAG_CATEGORY_ORDER) {
      const n = catCount[c] ?? 0
      if (n === 0) continue
      html += chip(c, TAG_CATEGORY_LABEL[c], n, tagColor(c))
    }
    tagLegendEl.innerHTML = html
  }

  function renderTagGroups(): void {
    if (!tagGroupsEl) return
    const list = tagFilter === 'all' ? tagStats : tagStats.filter((t) => t.c === tagFilter)
    if (list.length === 0) {
      tagGroupsEl.innerHTML = '<div class="tag-empty">该分类暂无标签（可下调阈值或添加自定义词）</div>'
      return
    }
    const maxAlbums = list.reduce((m, x) => Math.max(m, x.albums), 1)
    const byCat = new Map<string, TagStat[]>()
    for (const t of list) {
      if (!byCat.has(t.c)) byCat.set(t.c, [])
      byCat.get(t.c)!.push(t)
    }
    tagGroupsEl.innerHTML = TAG_CATEGORY_ORDER.filter((c) => byCat.has(c))
      .map((c) => {
        const items = byCat.get(c)!
        const tags = items
          .map((x) => {
            const isCjk = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(x.t)
            const label = isCjk ? x.t : `${x.t}（${noteFor(x.t, x.c)}）`
            const size = 12 + Math.round((x.albums / maxAlbums) * 8)
            return `<span class="tag" data-tag="${x.t}" style="font-size:${size}px;color:${tagColor(x.c)}" title="${x.t} · ${TAG_CATEGORY_LABEL[x.c]} · ${x.albums} 相册 · ${x.users} 人"><span class="tag-t">${label}</span><b class="tag-x" data-block="${x.t}" title="屏蔽该标签">×</b></span>`
          })
          .join('')
        return `<div class="tag-group" style="--group:${tagColor(c)}"><div class="tag-group-head">${TAG_CATEGORY_LABEL[c]} <span class="tag-group-n">${items.length}</span></div><div class="tag-group-body">${tags}</div></div>`
      })
      .join('')
  }

  async function refreshTagCloud(): Promise<void> {
    const topN = Math.max(20, Math.min(1000, Number(tagNInput?.value) || 200))
    const minAlbums = Math.max(1, Math.min(100, Number(tagMinAlbumsInput?.value) || 5))
    const minUsers = Math.max(1, Math.min(50, Number(tagMinUsersInput?.value) || 1))
    setStatus(tagStatus, '统计中…')
    const res = await sendMessage<{ ok: true; tags?: TagStat[] } | { ok: false; error: string }>({
      type: 'IMG_TAG_GET',
      topN,
      minAlbums,
      minUsers,
      includeSlug: !!tagSlugCheck?.checked,
    })
    if (!res.ok) {
      setStatus(tagStatus, `标签云失败：${res.error}`, true)
      return
    }
    tagStats = res.tags ?? []
    if (tagStats.length === 0) {
      setStatus(tagStatus, '暂无标签（需先确认评分补相册名，或下调阈值）', true)
      if (tagGroupsEl) tagGroupsEl.innerHTML = ''
      if (tagLegendEl) tagLegendEl.innerHTML = ''
      return
    }
    renderTagLegend()
    renderTagGroups()
    setStatus(tagStatus, `已生成 ${tagStats.length} 个标签（相册≥${minAlbums} 且 用户≥${minUsers}）`)
  }

  root.querySelector('#tag-refresh')?.addEventListener('click', () => void refreshTagCloud())
  tagNInput?.addEventListener('change', () => void refreshTagCloud())
  tagMinAlbumsInput?.addEventListener('change', () => void refreshTagCloud())
  tagMinUsersInput?.addEventListener('change', () => void refreshTagCloud())
  tagSlugCheck?.addEventListener('change', () => void refreshTagCloud())

  // 分类 chip 筛选
  tagLegendEl?.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.tag-chip')
    if (!el) return
    tagFilter = el.dataset.cat || 'all'
    renderTagLegend()
    renderTagGroups()
  })

  // 点击标签 → 填关键词触发③区检索；点标签上的 × → 屏蔽该标签
  tagGroupsEl?.addEventListener('click', (ev) => {
    const xEl = (ev.target as HTMLElement).closest<HTMLElement>('.tag-x')
    if (xEl) {
      ev.stopPropagation()
      const word = xEl.dataset.block
      if (!word) return
      if (!tagDict.blocked.some((b) => b.toLowerCase() === word.toLowerCase())) tagDict.blocked.push(word)
      void saveTagDict()
      return
    }
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.tag')
    if (!el) return
    const tag = el.dataset.tag
    if (!tag) return
    searchKeywordsInput.value = tag
    setStatus(tagStatus, `已填入关键词「${tag}」，检索中…`)
    void runSearch()
    // 滚动到③区
    searchResultsEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  // 点击已屏蔽标签 → 取消屏蔽
  tagBlockedListEl?.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.blocked-tag')
    if (!el) return
    const word = el.dataset.block
    if (!word) return
    tagDict.blocked = tagDict.blocked.filter((b) => b.toLowerCase() !== word.toLowerCase())
    void saveTagDict()
  })

  // 添加自定义标签
  root.querySelector('#tag-custom-add')?.addEventListener('click', () => {
    const word = tagCustomWordInput?.value.trim()
    if (!word) {
      setStatus(tagStatus, '请先填写标签名', true)
      return
    }
    const c = (tagCustomCatSelect?.value || 'english') as TagCategory
    if (!tagDict.entries.some((e) => e.t.toLowerCase() === word.toLowerCase())) tagDict.entries.push({ t: word, c })
    if (tagCustomWordInput) tagCustomWordInput.value = ''
    void saveTagDict()
  })

  // 添加屏蔽词
  root.querySelector('#tag-block-add')?.addEventListener('click', () => {
    const word = tagBlockWordInput?.value.trim()
    if (!word) {
      setStatus(tagStatus, '请先填写要屏蔽的词', true)
      return
    }
    if (!tagDict.blocked.some((b) => b.toLowerCase() === word.toLowerCase())) tagDict.blocked.push(word)
    if (tagBlockWordInput) tagBlockWordInput.value = ''
    void saveTagDict()
  })

  // 词典导出 / 导入
  root.querySelector('#tag-dict-export')?.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(tagDict, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tag-dict-${Date.now()}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setStatus(tagStatus, `已导出词典（自定义 ${tagDict.entries.length} 条 · 屏蔽 ${tagDict.blocked.length} 条）`)
  })
  root.querySelector('#tag-dict-import')?.addEventListener('click', () => tagDictFileInput?.click())
  tagDictFileInput?.addEventListener('change', async () => {
    const file = tagDictFileInput.files?.[0]
    if (!file) return
    try {
      const data = JSON.parse(await file.text()) as TagCustomDict
      tagDict = {
        entries: Array.isArray(data.entries) ? data.entries : tagDict.entries,
        blocked: Array.isArray(data.blocked) ? data.blocked : tagDict.blocked,
      }
      void saveTagDict()
    } catch (err) {
      setStatus(tagStatus, `词典文件解析失败：${String(err)}`, true)
    } finally {
      tagDictFileInput.value = ''
    }
  })

  // 启动时载入自定义词典
  void loadTagDict()

  // ---------- 事件：本地数据表导出/导入（FP-005） ----------
  const localStatus = root.querySelector('#local-status')
  const dbImportFile = root.querySelector('#db-import-file') as HTMLInputElement | null

  root.querySelector('#db-export')?.addEventListener('click', async () => {
    setStatus(localStatus, '导出中…')
    const res = await sendMessage<{ ok: true; json?: string } | { ok: false; error: string }>({ type: 'IMG_DB_EXPORT' })
    if (!res.ok) {
      setStatus(localStatus, `导出失败：${res.error}`, true)
      return
    }
    if (!res.json) {
      setStatus(localStatus, '导出失败：无数据', true)
      return
    }
    const blob = new Blob([res.json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    try {
      await chrome.downloads.download({ url, filename: 'imgbb-producers.json' })
      setStatus(localStatus, '已导出 imgbb-producers.json（在下载目录，可移到工程内保存）')
      logger.info('adapters', '数据表已导出', { bytes: blob.size })
    } catch (err) {
      setStatus(localStatus, `导出失败：${String(err)}`, true)
    } finally {
      URL.revokeObjectURL(url)
    }
  })

  root.querySelector('#db-import')?.addEventListener('click', () => {
    dbImportFile?.click()
  })

  dbImportFile?.addEventListener('change', async () => {
    const file = dbImportFile.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const data = JSON.parse(text) as unknown
      const res = await sendMessage<
        { ok: true; github?: { message: string }; total?: number } | { ok: false; error: string }
      >({ type: 'IMG_DB_IMPORT', db: data })
      if (!res.ok) {
        setStatus(localStatus, `导入失败：${res.error}`, true)
        return
      }
      setStatus(localStatus, res.github?.message ?? `导入成功，库内 ${res.total} 用户`)
      void loadDbStats() // 刷新库统计
    } catch (err) {
      setStatus(localStatus, `文件解析失败：${String(err)}`, true)
    } finally {
      dbImportFile.value = ''
    }
  })

  // ---------- 自动填充：从源网页 URL 识别 imgbb 场景（可重试） ----------
  async function autoFill(): Promise<void> {
    if (!sourceUrl) return
    const usernameFromUrl = extractUsername(sourceUrl)
    const albumId = extractAlbumId(sourceUrl)
    let username = usernameFromUrl
    if (!username && albumId) {
      // 相册页（ibb.co 无用户名子域）：后台 fetch 相册页 HTML 解析属主（需 <all_urls> 权限）
      try {
        const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] })
        if (granted) {
          const res = await sendMessage<{ ok: true; username: string | null } | { ok: false; error: string }>({
            type: 'IMG_RESOLVE_USER',
            srcTabId,
            albumUrl: sourceUrl,
          })
          if (res.ok && res.username) {
            username = res.username
          }
        }
      } catch (err) {
        logger.warn('adapters', '相册属主解析失败', String(err))
      }
    }
    if (username) {
      // 用户主页 URL + 分析/关注墙用户名
      homeUrlInput.value = `https://${username}.imgbb.com/`
      albumsUserInput.value = username
      followingUserInput.value = username
    }
    if (albumId) {
      // 相册详情页 → 填相册 URL，并切到「相册抓取」子标签
      albumUrlInput.value = sourceUrl
      root.querySelectorAll<HTMLElement>('.adapter-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.sub === 'album')
      })
      root.querySelectorAll('.adapter-panel').forEach((p) => {
        p.classList.toggle('active', p.id === 'sub-album')
      })
      homeGrabView.setParseText(`已自动识别相册页：${albumId}（属主 ${username ?? '需授权' }）`)
    } else if (username) {
      homeGrabView.setParseText(`已自动识别用户：${username}（可开始抓取）`)
    }
    if (username || albumId) {
      logger.info('adapters', '已自动填充 imgbb 网址', { sourceUrl, username, albumId })
    }
  }

  void autoFill()

  // ---------- 对外句柄 ----------
  /** 按下载文件夹名路由下载进度到对应子场景视图 */
  function routeDownloadJob(job: DownloadJob): void {
    if (job.folderName.includes('用户主页')) {
      homeGrabView.setDownloadJob(job)
    } else if (job.folderName.includes('相册')) {
      albumGrabView.setDownloadJob(job)
    }
  }

  return {
    onImgbbResult: (kind, data, done, error) => {
      if (kind === 'gallery' || kind === 'gallery-range') {
        const images = data as ImgbbImage[]
        homeImagesTotal += images.length
        homeGrabView.appendImages(images.map(toGrabbed))
        homeGrabView.selectAll() // 解析完成默认全选（与抓取页签一致）
        homeGrabView.setBusyParsing(false)
        if (error) {
          homeGrabView.setParseText(`抓取失败：${error}`)
        } else {
          homeGrabView.setParseText(`已抓取 ${homeImagesTotal} 张（本批 ${images.length}）`)
        }
        logger.info('adapters', '用户主页抓取结果', { kind, count: images.length, total: homeImagesTotal })
      } else if (kind === 'album-images') {
        const images = data as ImgbbImage[]
        albumGrabView.appendImages(images.map(toGrabbed))
        albumGrabView.selectAll() // 解析完成默认全选（与抓取页签一致）
        albumGrabView.setBusyParsing(false)
        if (error) {
          albumGrabView.setParseText(`抓取失败：${error}`)
        } else {
          albumGrabView.setParseText(`相册「${albumFolder}」共 ${images.length} 张`)
        }
      } else if (kind === 'albums') {
        const items = data as ImgbbAlbum[]
        // 按 url 去重追加（imgbb 分页页间可能重复，避免反复出现前 32 条）
        const seen = new Set(albums.map((a) => a.url))
        const fresh = items.filter((a) => !seen.has(a.url))
        albums = albums.concat(fresh)
        renderAlbums(albumsGrid, albums)
        if (error) {
          setStatus(albumsStatus, `分析失败：${error}`, true)
        } else {
          setStatus(albumsStatus, `已分析 ${albums.length} 个相册（本批新增 ${fresh.length}）`)
        }
        logger.info('adapters', '相册分析结果', { count: albums.length })
      } else if (kind === 'following') {
        const items = data as ImgbbFollowingUser[]
        following = following.concat(items)
        followingDone = done
        renderFollowing(followingList, following)
        if (error) {
          setStatus(followingStatus, error, true)
        } else {
          const nextBtn = root.querySelector('#following-next') as HTMLButtonElement | null
          if (nextBtn) nextBtn.disabled = done
          setStatus(followingStatus, `已分析 ${following.length} 个有效用户（本批 ${items.length}）${done ? '，全部完成' : ''}`)
        }
        logger.info('adapters', '关注墙分析结果', { count: following.length, done })
      }
    },
    onScoreProgress: (msg) => {
      // 确认一个更新一个：状态文本实时 + 排行节流刷新
      const stop = msg.cancelled ? ' · 已请求停止' : ''
      setStatus(
        scoreStatus,
        `确认中 ${msg.done}/${msg.total} · ${msg.username}（相册 ${msg.albumCount}${msg.truncated ? '+' : ''}）· 失败 ${msg.failed}${stop}`,
      )
      const now = Date.now()
      if (now - lastScoreRefresh >= 2000) {
        lastScoreRefresh = now
        void loadDbStats()
      }
    },
    onDownloadProgress: (job) => {
      routeDownloadJob(job)
    },
    onDownloadDone: (job) => {
      routeDownloadJob(job)
      logger.info('adapters', '下载任务结束', { jobId: job.id, done: job.done, failed: job.failed })
    },
  }
}
