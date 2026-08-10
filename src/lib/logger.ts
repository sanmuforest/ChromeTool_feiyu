// 统一日志系统
//
// 设计要点（对应宪法「日志纪律」）：
// 1. 唯一写入者 = background（直接写 storage 环形缓冲）
// 2. popup / content 通过消息转发给 background 记录，避免并发写冲突
// 3. 环形缓冲最多保留 MAX_LOG_ENTRIES 条，防 storage 无限膨胀
// 4. 等级过滤：低于当前等级的日志直接丢弃（默认 info，可在 popup 切 debug）
// 5. 每写一条同时输出到 console，方便 DevTools 直查

import { sendMessage } from './messages'
import { storageGet, storageSet } from './storage'
import { LEVEL_ORDER, type LogContext, type LogEntry, type LogLevel } from './types'

export const DEFAULT_LOG_LEVEL: LogLevel = 'info'
export const MAX_LOG_ENTRIES = 500

const KEY_LOGS = 'log_buffer'
const KEY_LEVEL = 'log_level'

export interface Logger {
  debug(module: string, message: string, data?: unknown): void
  info(module: string, message: string, data?: unknown): void
  warn(module: string, message: string, data?: unknown): void
  error(module: string, message: string, data?: unknown): void
}

// ---------- 存储层（仅 background 调用） ----------

export async function getLevel(): Promise<LogLevel> {
  return (await storageGet<LogLevel>(KEY_LEVEL)) ?? DEFAULT_LOG_LEVEL
}

export async function setLevel(level: LogLevel): Promise<void> {
  await storageSet(KEY_LEVEL, level)
  console.info(`[logger] 日志等级已切换为 ${level}`)
}

export async function getEntries(): Promise<LogEntry[]> {
  return (await storageGet<LogEntry[]>(KEY_LOGS)) ?? []
}

export async function clearEntries(): Promise<void> {
  await storageSet(KEY_LOGS, [])
}

export async function appendLog(
  context: LogContext,
  level: LogLevel,
  module: string,
  message: string,
  data?: unknown,
): Promise<void> {
  const currentLevel = await getLevel()
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) {
    return // 低于当前等级，丢弃
  }
  const entries = await getEntries()
  const nextId = entries.length > 0 ? Math.max(...entries.map((e) => e.id)) + 1 : 1
  const entry: LogEntry = { id: nextId, ts: Date.now(), context, level, module, message, data }
  entries.push(entry)
  while (entries.length > MAX_LOG_ENTRIES) {
    entries.shift()
  }
  await storageSet(KEY_LOGS, entries)
  // 同步输出到 console（DevTools 可直查）
  const tag = `[${context}/${module}]`
  const consoleFn = level === 'debug' ? console.debug : level === 'warn' ? console.warn : level === 'error' ? console.error : console.info
  consoleFn(tag, message, data ?? '')
}

// ---------- 远端转发（popup / content 调用） ----------

async function sendRemoteLog(
  context: LogContext,
  level: LogLevel,
  module: string,
  message: string,
  data?: unknown,
): Promise<void> {
  try {
    await sendMessage({ type: 'LOG_ADD', level, context, module, message, data })
  } catch (err) {
    // background 不可达时降级到 console，不抛出（日志失败不得影响业务）
    console.warn(`[logger] 日志转发失败 (${context}/${module}):`, err)
  }
}

// ---------- 对外入口 ----------

/** 初始化一个带上下文的 logger。background 直接写存储，popup/content 走消息转发。 */
export function initLogger(context: LogContext): Logger {
  const write =
    context === 'background'
      ? (level: LogLevel, module: string, message: string, data?: unknown) => {
          void appendLog(context, level, module, message, data)
        }
      : (level: LogLevel, module: string, message: string, data?: unknown) => {
          void sendRemoteLog(context, level, module, message, data)
        }

  return {
    debug: (module, message, data) => write('debug', module, message, data),
    info: (module, message, data) => write('info', module, message, data),
    warn: (module, message, data) => write('warn', module, message, data),
    error: (module, message, data) => write('error', module, message, data),
  }
}
