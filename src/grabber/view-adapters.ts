// 站点适配页签：imgbb 4 子标签（FP-003）
//
// 架构：用户主页 / 相册抓取两个子场景复用共享抓取视图组件（image-grab-view），
//      下载/筛选/去重/选择/预览/进度与「抓取」页签完全一致，数据源为后台 imgbb fetch。
//      相册分析 / 关注墙为检索场景，保留独立展示。

import { initLogger } from '../lib/logger'
import { sendMessage, type ImgResultKind } from '../lib/messages'
import { extractAlbumId, extractUsername } from '../lib/imgbb-parse'
import type {
  DownloadJob,
  GrabbedImage,
  ImgbbAlbum,
  ImgbbFollowingUser,
  ImgbbImage,
} from '../lib/types'
import { createGrabView, type GrabViewHandle } from './image-grab-view'

const logger = initLogger('grabber')

const BATCH_PAGES = 3 // 每批页数（约 32 张/页 → 一批约 100 张）

export interface AdaptersViewHandle {
  onImgbbResult(kind: ImgResultKind, data: ImgbbImage[] | ImgbbAlbum[] | ImgbbFollowingUser[], done: boolean, error?: string): void
  onDownloadProgress(job: DownloadJob): void
  onDownloadDone(job: DownloadJob): void
}

/** ImgbbImage → GrabbedImage（显示用展示图，下载用原图） */
function toGrabbed(img: ImgbbImage): GrabbedImage {
  return {
    id: img.id,
    url: img.mediumUrl || img.originalUrl,
    downloadUrl: img.originalUrl,
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
    </div>
  `

  // ---------- 共享抓取视图组件（用户主页 / 相册） ----------
  const homeGrabView: GrabViewHandle = createGrabView(root.querySelector('#home-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => buildFolderName('用户主页'),
    showReparse: false,
    showLoadMore: false,
  })

  const albumGrabView: GrabViewHandle = createGrabView(root.querySelector('#album-grab-view') as HTMLElement, {
    srcTabId,
    getFolderName: () => buildFolderName('相册'),
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

  function setStatus(el: Element | null, text: string, isError = false): void {
    if (!el) return
    el.textContent = text
    el.classList.toggle('error', isError)
  }

  function buildFolderName(label: string): string {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `imgbb-${label}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
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
      for (const album of entry.albums) {
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
    albumGrabView.setBusyParsing(true)
    albumGrabView.setParseText('抓取中…')
    const res = await sendMessage({ type: 'IMG_GET_ALBUM_IMAGES', srcTabId, albumUrl: url })
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
    if (!res.ok) setStatus(albumsStatus, `请求失败：${res.error}`, true)
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
          albumGrabView.setParseText(`相册共 ${images.length} 张`)
        }
      } else if (kind === 'albums') {
        const items = data as ImgbbAlbum[]
        albums = albums.concat(items)
        albumsPage = Math.max(albumsPage, 1)
        renderAlbums(albumsGrid, albums)
        if (error) {
          setStatus(albumsStatus, `分析失败：${error}`, true)
        } else {
          setStatus(albumsStatus, `已分析 ${albums.length} 个相册（本批 ${items.length}）`)
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
    onDownloadProgress: (job) => {
      routeDownloadJob(job)
    },
    onDownloadDone: (job) => {
      routeDownloadJob(job)
      logger.info('adapters', '下载任务结束', { jobId: job.id, done: job.done, failed: job.failed })
    },
  }
}
