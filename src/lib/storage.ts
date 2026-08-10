// chrome.storage.local 的薄封装（所有状态读写必须经过这里，schema 单一来源）

export async function storageGet<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key)
  return result[key] as T | undefined
}

export async function storageSet(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value })
}

export async function storageRemove(key: string): Promise<void> {
  await chrome.storage.local.remove(key)
}
