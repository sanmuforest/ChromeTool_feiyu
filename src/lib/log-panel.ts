// 日志面板组件：挂载到 grabber 日志页签（逻辑从原 popup 面板迁移，FP-002）
// 所有数据经消息从 background 获取（background 是日志唯一写入者）

import { initLogger } from './logger'
import { sendMessage } from './messages'
import type { LogEntry, LogLevel } from './types'

const logger = initLogger('grabber')

export function initLogPanel(root: HTMLElement): void {
  root.innerHTML = `
    <div class="log-panel">
      <div class="log-toolbar">
        <label>日志等级</label>
        <select id="level-select">
          <option value="debug">debug（详细）</option>
          <option value="info" selected>info（默认）</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </select>
        <button id="btn-refresh" class="btn">刷新</button>
        <button id="btn-clear" class="btn danger">清空</button>
        <button id="btn-copy" class="btn">复制</button>
        <button id="btn-export" class="btn">导出</button>
      </div>
      <div class="log-filter">
        <button data-filter="all" class="chip active">全部</button>
        <button data-filter="debug" class="chip">debug</button>
        <button data-filter="info" class="chip">info</button>
        <button data-filter="warn" class="chip warn">warn</button>
        <button data-filter="error" class="chip error">error</button>
      </div>
      <div id="log-list" class="log-list"></div>
      <div id="log-empty" class="log-empty">暂无日志。请操作插件后点「刷新」。</div>
      <div id="log-count" class="log-count"></div>
    </div>
  `

  const levelSelect = root.querySelector('#level-select') as HTMLSelectElement
  const logList = root.querySelector('#log-list') as HTMLElement
  const logEmpty = root.querySelector('#log-empty') as HTMLElement
  const logCount = root.querySelector('#log-count') as HTMLElement

  let allEntries: LogEntry[] = []
  let currentFilter: 'all' | LogLevel = 'all'

  function formatTime(ts: number): string {
    const d = new Date(ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
  }

  function safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  function render(): void {
    const shown = currentFilter === 'all' ? allEntries : allEntries.filter((e) => e.level === currentFilter)
    logList.innerHTML = ''

    for (const entry of shown) {
      const row = document.createElement('div')
      row.className = 'log-entry'

      const tsSpan = document.createElement('span')
      tsSpan.className = 'ts'
      tsSpan.textContent = formatTime(entry.ts)

      const levelSpan = document.createElement('span')
      levelSpan.className = `level ${entry.level}`
      levelSpan.textContent = entry.level

      const ctxSpan = document.createElement('span')
      ctxSpan.className = 'ctx'
      ctxSpan.textContent = `[${entry.context}/${entry.module}]`

      const msgSpan = document.createElement('span')
      msgSpan.className = 'msg'
      msgSpan.textContent = entry.message

      row.append(tsSpan, levelSpan, ctxSpan, msgSpan)

      if (entry.data !== undefined) {
        const dataDiv = document.createElement('div')
        dataDiv.className = 'data'
        dataDiv.textContent = safeStringify(entry.data)
        row.appendChild(dataDiv)
      }

      logList.appendChild(row)
    }

    logEmpty.classList.toggle('show', shown.length === 0)
    logCount.textContent = `${shown.length} / ${allEntries.length} 条`
  }

  async function loadLogs(): Promise<void> {
    const res = await sendMessage({ type: 'LOG_GET' })
    if (res.ok && res.entries) {
      allEntries = res.entries
      render()
    } else {
      logger.error('log-panel', '拉取日志失败', !res.ok ? res.error : undefined)
    }
  }

  async function loadLevel(): Promise<void> {
    const res = await sendMessage({ type: 'LOG_GET_LEVEL' })
    if (res.ok && res.level) {
      levelSelect.value = res.level
    }
  }

  function buildExportText(): string {
    const header = `# 插件日志导出\n# 时间: ${new Date().toLocaleString()}\n# 版本: ${chrome.runtime.getManifest().version}\n# 条数: ${allEntries.length}\n\n`
    const lines = allEntries.map((e) => {
      const time = new Date(e.ts).toLocaleString('zh-CN', { hour12: false })
      const data = e.data !== undefined ? ` ${safeStringify(e.data)}` : ''
      return `[${time}] [${e.level}] [${e.context}/${e.module}] ${e.message}${data}`
    })
    return header + lines.join('\n')
  }

  async function copyLogs(): Promise<void> {
    const text = buildExportText()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    logger.info('log-panel', '日志已复制到剪贴板')
  }

  function exportLogs(): void {
    const blob = new Blob([buildExportText()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `extension-log-${Date.now()}.log`
    a.click()
    URL.revokeObjectURL(url)
    logger.info('log-panel', '日志已导出为文件')
  }

  // ---- 事件绑定 ----
  levelSelect.addEventListener('change', async () => {
    const level = levelSelect.value as LogLevel
    const res = await sendMessage({ type: 'LOG_SET_LEVEL', level })
    if (res.ok) {
      logger.info('log-panel', `日志等级切换为 ${level}`)
      void loadLogs()
    }
  })

  root.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      root.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'))
      chip.classList.add('active')
      currentFilter = chip.dataset.filter as 'all' | LogLevel
      render()
    })
  })

  root.querySelector('#btn-refresh')?.addEventListener('click', () => void loadLogs())
  root.querySelector('#btn-clear')?.addEventListener('click', async () => {
    const res = await sendMessage({ type: 'LOG_CLEAR' })
    if (res.ok) {
      allEntries = []
      render()
      logger.info('log-panel', '日志已清空')
    }
  })
  root.querySelector('#btn-copy')?.addEventListener('click', () => void copyLogs())
  root.querySelector('#btn-export')?.addEventListener('click', () => exportLogs())

  void loadLevel().then(() => loadLogs())
  logger.info('log-panel', '日志面板已挂载')
}
