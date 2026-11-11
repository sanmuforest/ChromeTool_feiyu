// 浏览器 DOM 图片提取（2026-11-11）
//
// 用途：SPA 站点（rrwsh 改版后等）的服务端 HTML 是空壳 —— 约 1991 字节、0 个 <img>、
// title 为站点默认标题。fetch 无论走后台还是页面内都拿不到图片，只有真实渲染后的 DOM 里有。
//
// 本模块通过 chrome.scripting.executeScript 注入到页面，读取 img 的实际地址。
// 注意：注入函数会被序列化，不能引用外部变量。

/** 在指定标签页提取图片 URL（绝对地址、已去重）
 *  2026-11-11 修正：必须按站点定义取图，不能整页扫 ——
 *  整页扫会把推荐位、广告、相关文章缩略图全部混进来，且无法剔除。
 *  这里接受与 HTML 解析完全相同的两个判据：
 *    - selector：正文容器（由 site.def.container 拼成，如 `div.entry-content`）
 *    - hosts：图床白名单（site.def.imageOnlyHosts）
 *  这样 DOM 通道与 HTML 通道的取图口径保持一致。 */
export async function extractDomImages(
  tabId: number,
  opts?: { selector?: string; hosts?: string[] },
): Promise<string[]> {
  const selector = opts?.selector ?? ''
  const hosts = opts?.hosts ?? []
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel: string, hostList: string[]) => {
      const out: string[] = []
      const seen = new Set<string>()
      // 有正文容器就只扫它；没有才退化为整页（与 HTML 解析的 container 语义一致）
      const root = (sel ? document.querySelector(sel) : null) ?? document.body
      if (!root) return out
      const pick = (el: Element): string => {
        const img = el as HTMLImageElement
        const cand =
          img.getAttribute('data-src') ||
          img.getAttribute('data-original') ||
          img.getAttribute('data-lazy-src') ||
          img.currentSrc ||
          img.src ||
          ''
        return cand
      }
      const allowHost = (u: string): boolean => {
        if (hostList.length === 0) return true
        try {
          const h = new URL(u).hostname
          return hostList.some((x) => h === x || h.endsWith('.' + x))
        } catch {
          return false
        }
      }
      root.querySelectorAll('img').forEach((el) => {
        const raw = pick(el)
        if (!raw || !/^https?:\/\//i.test(raw)) return
        if (/\/(?:logo|favicon|icon|avatar|sprite|placeholder)[^/]*\.(?:svg|png|gif|webp|jpe?g)/i.test(raw)) return
        if (!allowHost(raw)) return
        if (seen.has(raw)) return
        seen.add(raw)
        out.push(raw)
      })
      return out
    },
    args: [selector, hosts],
  })
  return (res[0]?.result as string[] | undefined) ?? []
}

/** 打开临时标签页加载 URL，等渲染完成后提取图片，随后关闭标签页
 *  用于 SPA 站点的翻页：必须真实导航 + 等 JS 渲染，fetch 拿不到内容。
 *  使用独立标签页，避免打断用户当前浏览。
 *  selector/hosts 与 extractDomImages 相同 —— 逐页都要用同一套取图判据。 */
export async function extractImagesByNavigation(
  url: string,
  opts?: { selector?: string; hosts?: string[]; renderWaitMs?: number; timeoutMs?: number },
): Promise<string[]> {
  const renderWaitMs = opts?.renderWaitMs ?? 800
  const timeoutMs = opts?.timeoutMs ?? 25000
  const tab = await chrome.tabs.create({ url, active: false })
  try {
    const tabId = tab.id
    if (!tabId) throw new Error('无法创建标签页')
    // 等待加载完成
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const t = await chrome.tabs.get(tabId)
      if (t.status === 'complete') break
      await new Promise((r) => setTimeout(r, 300))
    }
    // 额外等待 JS 渲染（SPA 的图片通常在 hydration 之后才插入 DOM）
    await new Promise((r) => setTimeout(r, renderWaitMs))
    return await extractDomImages(tabId, { selector: opts?.selector, hosts: opts?.hosts })
  } finally {
    if (tab.id) await chrome.tabs.remove(tab.id).catch(() => {})
  }
}
