// 标星悬浮窗内容脚本（FP-017）
//
// 由 background 按需注册注入（用户点「启用标星悬浮窗」并授权 imgbb 域后
// chrome.scripting.registerContentScripts 动态注入），**不是** manifest 静态声明。
//
// 页面识别：
// - https://{username}.imgbb.com/...   → 子域名即用户名（用户主页 / 关注墙 / 粉丝墙）
// - https://ibb.co/album/{id}          → 后台解析相册属主（IMG_RESOLVE_USER）
// 功能：给当前页面对应的用户评星（1~5，再点同一颗取消），显示入度/相册数，可拖拽/折叠/位置记忆。
// 样式用 Shadow DOM + CSSStyleSheet（CSSOM 不受页面 CSP 限制），避免污染页面。

import { storageGet, storageSet } from '../lib/storage'

const HOST_ID = 'feiyu-star-overlay-host'
const POS_KEY = 'star_overlay_pos'
const MAX_STARS = 5

interface StarInfo {
  username: string
  starRating: number
  inDegree: number
  albumCount?: number
  albumsChecked: boolean
  inLibrary: boolean
}

interface OverlayPos {
  x: number
  y: number
  collapsed?: boolean
}

declare global {
  interface Window {
    __feiyuStarOverlayInjected?: boolean
  }
}

if (!window.__feiyuStarOverlayInjected) {
  window.__feiyuStarOverlayInjected = true
  void initStarOverlay()
}

async function sendMsg<T>(msg: unknown): Promise<T | null> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as T
  } catch {
    return null
  }
}

/** 当前页面对应的 imgbb 用户名（识别不到则不显示悬浮窗） */
async function resolveUsername(): Promise<string | null> {
  const host = location.hostname.toLowerCase()
  if (host.endsWith('.imgbb.com') && host !== 'www.imgbb.com') {
    const sub = host.slice(0, -'.imgbb.com'.length)
    if (sub && !sub.includes('.')) return sub
  }
  if (/(^|\.)ibb\.co$/.test(host) && /^\/album\//i.test(location.pathname)) {
    const res = await sendMsg<{ ok: boolean; username?: string | null }>({
      type: 'IMG_RESOLVE_USER',
      srcTabId: -1,
      albumUrl: location.href,
    })
    if (res?.ok && res.username) return res.username
  }
  return null
}

function starSheet(): CSSStyleSheet {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(`
    :host { all: initial; }
    .box {
      font: 12px/1.5 system-ui, "Microsoft YaHei", sans-serif;
      color: #e6e8ea;
      background: rgba(20, 22, 26, 0.94);
      border: 1px solid #3a3f46;
      border-radius: 8px;
      padding: 6px 8px;
      min-width: 132px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    }
    .head { display: flex; align-items: center; gap: 6px; cursor: move; user-select: none; }
    .user { color: #4a9eff; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; }
    .spacer { flex: 1; }
    .icon { cursor: pointer; color: #8a8f97; padding: 0 2px; }
    .icon:hover { color: #e6e8ea; }
    .stars { display: flex; gap: 2px; margin-top: 4px; font-size: 16px; line-height: 1; }
    .star { cursor: pointer; color: #4a4f57; }
    .star.on { color: #e8c06a; }
    .star:hover { color: #ffc46b; }
    .meta { margin-top: 3px; color: #8a8f97; font-size: 11px; }
    .status { margin-top: 2px; color: #7bc47f; font-size: 11px; min-height: 14px; }
    .status.err { color: #e5646b; }
    .body.hidden { display: none; }
  `)
  return sheet
}

async function initStarOverlay(): Promise<void> {
  if (document.getElementById(HOST_ID)) return
  const username = await resolveUsername()
  if (!username) return
  const res = await sendMsg<{ ok: boolean; starInfo?: StarInfo }>({ type: 'IMG_DB_GET_STAR', username })
  if (!res?.ok || !res.starInfo) return
  mount(username, res.starInfo)
}

function mount(username: string, info: StarInfo): void {
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;'
  const shadow = host.attachShadow({ mode: 'open' })
  try {
    shadow.adoptedStyleSheets = [starSheet()]
  } catch {
    const style = document.createElement('style')
    style.textContent = Array.from(starSheet().cssRules)
      .map((r) => r.cssText)
      .join('\n')
    shadow.appendChild(style)
  }

  const box = document.createElement('div')
  box.className = 'box'
  const head = document.createElement('div')
  head.className = 'head'
  const userEl = document.createElement('span')
  userEl.className = 'user'
  userEl.textContent = `@${username}`
  userEl.title = username
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  const foldEl = document.createElement('span')
  foldEl.className = 'icon'
  foldEl.textContent = '–'
  foldEl.title = '折叠 / 展开'
  const closeEl = document.createElement('span')
  closeEl.className = 'icon'
  closeEl.textContent = '×'
  closeEl.title = '关闭（可在抓取页「标星悬浮窗」重新启用）'
  head.append(userEl, spacer, foldEl, closeEl)

  const body = document.createElement('div')
  body.className = 'body'
  const starsEl = document.createElement('div')
  starsEl.className = 'stars'
  const starEls: HTMLElement[] = []
  for (let i = 1; i <= MAX_STARS; i++) {
    const s = document.createElement('span')
    s.className = 'star'
    s.dataset.v = String(i)
    s.title = `${i} 星`
    starEls.push(s)
    starsEl.appendChild(s)
  }
  const metaEl = document.createElement('div')
  metaEl.className = 'meta'
  const statusEl = document.createElement('div')
  statusEl.className = 'status'
  body.append(starsEl, metaEl, statusEl)
  box.append(head, body)
  shadow.appendChild(box)
  document.documentElement.appendChild(host)

  let current = 0
  let statusTimer = 0

  function setStatus(text: string, isError = false): void {
    statusEl.textContent = text
    statusEl.classList.toggle('err', isError)
    window.clearTimeout(statusTimer)
    if (text) statusTimer = window.setTimeout(() => (statusEl.textContent = ''), 2500)
  }

  function render(next: StarInfo): void {
    current = next.starRating
    starEls.forEach((el) => {
      const v = Number(el.dataset.v) || 0
      const on = v <= current
      el.classList.toggle('on', on)
      el.textContent = on ? '★' : '☆'
    })
    const parts: string[] = [`入度 ${next.inDegree}`]
    if (next.albumsChecked && next.albumCount !== undefined) parts.push(`相册 ${next.albumCount}`)
    if (!next.inLibrary) parts.push('未入库（标星自动入库）')
    metaEl.textContent = parts.join(' · ')
  }
  render(info)

  async function apply(stars: number): Promise<void> {
    const res = await sendMsg<{ ok: boolean; starInfo?: StarInfo; error?: string }>({
      type: 'IMG_DB_SET_STAR',
      username,
      stars,
      autoCreate: true,
    })
    if (!res?.ok) {
      setStatus(`保存失败${res?.error ? '：' + res.error : ''}`, true)
      return
    }
    if (res.starInfo) render(res.starInfo)
    setStatus(stars > 0 ? `已标 ${stars} 星` : '已取消星级')
  }

  starsEl.addEventListener('click', (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>('.star')
    if (!el) return
    const v = Number(el.dataset.v) || 0
    if (v <= 0) return
    void apply(current === v ? 0 : v)
  })

  const setCollapsed = (collapsed: boolean): void => {
    body.classList.toggle('hidden', collapsed)
    foldEl.textContent = collapsed ? '+' : '–'
  }
  foldEl.addEventListener('click', () => {
    const collapsed = !body.classList.contains('hidden')
    setCollapsed(collapsed)
    persist(collapsed)
  })
  closeEl.addEventListener('click', () => host.remove())

  // ---------- 拖拽 + 位置记忆 ----------
  function persist(collapsed: boolean): void {
    const r = host.getBoundingClientRect()
    const payload: OverlayPos = { x: Math.round(r.left), y: Math.round(r.top), collapsed }
    void storageSet(POS_KEY, payload)
  }

  let dragging = false
  let offX = 0
  let offY = 0
  head.addEventListener('mousedown', (ev) => {
    const r = host.getBoundingClientRect()
    dragging = true
    offX = ev.clientX - r.left
    offY = ev.clientY - r.top
    ev.preventDefault()
  })
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return
    const x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - offX))
    const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY))
    host.style.left = `${x}px`
    host.style.top = `${y}px`
    host.style.right = 'auto'
    host.style.bottom = 'auto'
  })
  window.addEventListener('mouseup', () => {
    if (!dragging) return
    dragging = false
    persist(body.classList.contains('hidden'))
  })

  // 恢复上次位置与折叠状态
  void storageGet<OverlayPos>(POS_KEY).then((pos) => {
    if (!pos) return
    if (typeof pos.x === 'number' && pos.x >= 0 && typeof pos.y === 'number' && pos.y >= 0) {
      host.style.left = `${pos.x}px`
      host.style.top = `${pos.y}px`
      host.style.right = 'auto'
      host.style.bottom = 'auto'
    }
    if (pos.collapsed) setCollapsed(true)
  })
}

