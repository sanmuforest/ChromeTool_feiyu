// GitHub 同步器（FP-005）：生产者库 ↔ GitHub Contents API（手动触发，非实时）
//
// 仓库：用户配置（如 sanmuforest/imgbb_ex），单文件 imgbb-producers.json
// 策略：拉取 → 本地合并入度（mergeDb 累加）→ 推回（天然可合并，冲突不丢数据）
// 认证：Fine-grained PAT，仅授权该仓库 contents 读写（最小权限）
// 注意：chrome.runtime message 为 JSON 序列化，此处全走 JSON/base64 字符串，无二进制

import type { ProducerDb } from './producer-db'

export interface GithubConfig {
  /** 仓库，格式 owner/repo */
  repo: string
  /** Fine-grained PAT */
  token: string
  branch: string
  /** 存储文件名 */
  file: string
}

export const DEFAULT_GITHUB_FILE = 'imgbb-producers.json'
export const GITHUB_CONFIG_KEY = 'github_config'

export function normalizeConfig(raw: Partial<GithubConfig> | undefined): GithubConfig | null {
  if (!raw?.repo || !raw?.token) return null
  return {
    repo: raw.repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
    token: raw.token.trim(),
    branch: raw.branch?.trim() || 'main',
    file: raw.file?.trim() || DEFAULT_GITHUB_FILE,
  }
}

export class GithubSyncError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GithubSyncError'
  }
}

async function ghFetch(config: GithubConfig, url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
  })
}

/** 拉取远程库：GET contents（文件不存在返回 null） */
export async function pullDb(config: GithubConfig): Promise<{ db: ProducerDb | null; sha: string | null; message: string }> {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.file}?ref=${encodeURIComponent(config.branch)}`
  const resp = await ghFetch(config, url)
  if (resp.status === 404) {
    return { db: null, sha: null, message: '远程文件不存在（首次推送将创建）' }
  }
  if (!resp.ok) {
    throw new GithubSyncError(`拉取失败 HTTP ${resp.status}：${(await resp.text()).slice(0, 200)}`)
  }
  const json = (await resp.json()) as { content?: string; sha: string; encoding?: string }
  if (!json.content) {
    return { db: null, sha: json.sha, message: '远程文件为空' }
  }
  const raw = json.encoding === 'base64' ? decodeUtf8Base64(json.content) : json.content
  let db: ProducerDb
  try {
    db = JSON.parse(raw) as ProducerDb
  } catch {
    throw new GithubSyncError('远程文件不是合法 JSON')
  }
  return { db, sha: json.sha, message: '拉取成功' }
}

/** 推送本地库：PUT contents（有 sha 则覆盖，无则创建） */
export async function pushDb(
  config: GithubConfig,
  db: ProducerDb,
  sha: string | null,
): Promise<{ sha: string | null; message: string }> {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.file}`
  const body = {
    message: `producer-db sync ${new Date().toISOString().slice(0, 19)}`,
    content: encodeUtf8Base64(JSON.stringify(db, null, 1)),
    branch: config.branch,
    ...(sha ? { sha } : {}),
  }
  const resp = await ghFetch(config, url, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const text = await resp.text()
    // 409 = sha 冲突（远程被改），提示重新拉取合并
    if (resp.status === 409) {
      throw new GithubSyncError('推送冲突（远程已更新），请先「拉取合并」再推送')
    }
    throw new GithubSyncError(`推送失败 HTTP ${resp.status}：${text.slice(0, 200)}`)
  }
  const json = (await resp.json()) as { content?: { sha?: string } }
  return { sha: json.content?.sha ?? null, message: '推送成功' }
}

/** base64 编码 UTF-8 安全版 */
export function encodeUtf8Base64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
}

/** base64 解码 UTF-8 */
export function decodeUtf8Base64(b64: string): string {
  return decodeURIComponent(escape(atob(b64)))
}
