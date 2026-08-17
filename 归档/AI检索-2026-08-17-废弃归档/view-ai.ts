// AI 检索场景（FP-013）：多页图站第 5 子标签
// 输入关键词/变体 → AI_SEARCH_START → 站内搜索 + 广域 site: 查询（自动连续跑完）→ AI_RESULT 推送 → 结果列表
// 交互：AI 检索（开始）→ 自动跑完队列 → 停止（随时中断）；无「下一批」批次概念（修复记录 10）

import { initLogger } from '../lib/logger'
import { sendMessage } from '../lib/messages'
import type { AiResultPayload, AiAlbumItem } from '../lib/ai-types'

const logger = initLogger('grabber')

export interface AiViewHandle {
  onResult(payload: AiResultPayload): void
}

export function initAiView(root: HTMLElement, srcTabId: number): AiViewHandle {
  root.innerHTML = `
    <div class="ai-view">
      <div class="row">
        <input id="ai-q" class="text-input" placeholder="关键词（AI 广域检索，可含风格/题材词）">
        <label class="ai-check"><input type="checkbox" id="ai-bing-images" checked> 广域图片通道（Google+Yandex，成人内容宽容）</label>
        <button id="ai-go" class="btn primary">AI 检索</button>
      </div>
      <div class="row">
        <textarea id="ai-variants" class="text-input ai-variants" rows="2"
          placeholder="手动补充搜索变体（逗号分隔，如 amateur, glamour, cosplay）。无 AI 密钥时以此扩展检索面"></textarea>
      </div>
      <div class="row">
        <button id="ai-cancel" class="btn">停止</button>
        <span id="ai-status" class="status-text"></span>
      </div>
      <div id="ai-strategy" class="ai-strategy"></div>
      <div id="ai-list" class="bd-link-list"></div>
    </div>
  `

  const qInput = root.querySelector('#ai-q') as HTMLInputElement
  const variantsInput = root.querySelector('#ai-variants') as HTMLTextAreaElement
  const bingImagesCheck = root.querySelector('#ai-bing-images') as HTMLInputElement
  const statusEl = root.querySelector('#ai-status') as HTMLElement
  const strategyEl = root.querySelector('#ai-strategy') as HTMLElement
  const listEl = root.querySelector('#ai-list') as HTMLElement

  let lastKeyword = ''
  let lastManualVariants: string[] = []
  let useBingImages = true
  let started = false

  /** 申请 <all_urls> 主机权限（background fetch 跨域必需；optional 权限在扩展重载后会被撤销，须主动再申请） */
  async function ensureHostPermission(): Promise<boolean> {
    try {
      if (await chrome.permissions.contains({ origins: ['<all_urls>'] })) return true
      return await chrome.permissions.request({ origins: ['<all_urls>'] })
    } catch {
      return false
    }
  }

  function setStatus(text: string, isError = false): void {
    statusEl.textContent = text
    statusEl.classList.toggle('error', isError)
  }

  function showStrategy(keyword: string, variants: string[], domains: string[]): void {
    strategyEl.innerHTML = `
      <div class="ai-strategy-line"><b>变体：</b>${escapeHtml([keyword, ...variants].join(' ｜ '))}</div>
      <div class="ai-strategy-line"><b>域名候选：</b>${escapeHtml(domains.join(' ｜ '))}</div>
    `
  }

  function renderItem(item: AiAlbumItem): HTMLElement {
    const row = document.createElement('div')
    row.className = 'bd-link-item ai-item'
    const cover = item.coverUrl
      ? `<img class="ai-cover" src="${escapeAttr(item.coverUrl)}" loading="lazy" referrerpolicy="no-referrer">`
      : ''
    row.innerHTML = `
      ${cover}
      <div class="ai-item-main">
        <a class="ai-item-title" href="#" title="${escapeAttr(item.url)}">${escapeHtml(item.title.slice(0, 80))}</a>
        <div class="ai-item-meta">
          <span class="ai-domain">${escapeHtml(item.domain)}</span>
          <span class="ai-source">${escapeHtml(item.source)}</span>
          <span class="ai-score">L0 ${item.score}</span>
          ${item.isNewDomain ? '<span class="ai-new">新站</span>' : ''}
          ${item.hitDomain ? `<span class="ai-hit">限 ${escapeHtml(item.hitDomain)}</span>` : ''}
        </div>
      </div>
      <button class="btn ai-open" title="新标签打开相册页">打开</button>
    `
    // MV3 CSP 禁止内联事件处理器，一律 addEventListener
    const img = row.querySelector('.ai-cover') as HTMLImageElement | null
    img?.addEventListener('error', () => {
      img.style.display = 'none'
    })
    row.querySelector('.ai-item-title')?.addEventListener('click', (e) => {
      e.preventDefault()
      void chrome.tabs.create({ url: item.url })
    })
    row.querySelector('.ai-open')?.addEventListener('click', () => {
      void chrome.tabs.create({ url: item.url })
    })
    return row
  }

  function appendItems(items: AiAlbumItem[]): void {
    const frag = document.createDocumentFragment()
    for (const item of items) frag.appendChild(renderItem(item))
    listEl.appendChild(frag)
    logger.info('view', 'AI 检索结果追加', { count: items.length, listChildren: listEl.children.length })
  }

  function onResult(payload: AiResultPayload): void {
    if (payload.kind === 'items' && payload.items) {
      appendItems(payload.items)
      return
    }
    if (payload.kind === 'progress' && payload.progress) {
      const p = payload.progress
      if (p.variants || p.domains) {
        showStrategy(lastKeyword, p.variants || [], p.domains || [])
      }
      const note = p.note ? ` · ${p.note}` : ''
      setStatus(
        `检索中：查询 ${Math.min(p.queryIndex, p.queryTotal)}/${p.queryTotal} · 请求 ${p.requests} · 结果 ${p.results}${note}`,
      )
      return
    }
    if (payload.kind === 'done') {
      started = false // 队列已结束
      if (listEl.children.length === 0) {
        listEl.innerHTML = `<div class="empty-tip">无结果。可能原因：搜索引擎对无 cookie 请求的成人敏感词会过滤；建议换英文题材词（amateur/glamour/cosplay）、等待几分钟后再试，或改用「聚合搜索」直接搜 5 个写真站站内。</div>`
      }
      setStatus('检索完成（可重新点击「AI 检索」开始新检索）')
      return
    }
    if (payload.kind === 'error') {
      setStatus(`错误：${payload.error}`, true)
    }
  }

  root.querySelector('#ai-go')?.addEventListener('click', async () => {
    const keyword = qInput.value.trim()
    if (!keyword) {
      setStatus('请填写关键词', true)
      return
    }
    if (!(await ensureHostPermission())) {
      setStatus('需要授权访问 <all_urls> 后才能执行 AI 检索（跨域 fetch 必需）', true)
      return
    }
    lastKeyword = keyword
    lastManualVariants = variantsInput.value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
    useBingImages = bingImagesCheck.checked
    started = true
    listEl.innerHTML = ''
    strategyEl.innerHTML = ''
    setStatus('启动中…')
    void sendMessage({
      type: 'AI_SEARCH_START',
      srcTabId,
      request: { keyword, manualVariants: lastManualVariants, useImages: useBingImages },
    }).then((res) => {
      if (!res.ok) {
        setStatus(`启动失败：${res.error}`, true)
      } else {
        showStrategy(lastKeyword, lastManualVariants, [])
      }
    })
  })

  root.querySelector('#ai-cancel')?.addEventListener('click', () => {
    if (!started) return
    void sendMessage({ type: 'AI_SEARCH_CANCEL', srcTabId })
    setStatus('已发送停止请求')
  })

  return { onResult }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function escapeAttr(s: string): string {
  return escapeHtml(s)
}
