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

/** 在原标签页里逐页导航抓取（SPA 翻页专用）
 *
 *  2026-11-11 修正：原先用 `chrome.tabs.create({ active: false })` 开后台临时标签页，
 *  实测「循环几次后卡住」——后台标签页会被浏览器节流，`status: 'complete'` 迟迟不触发，
 *  每页都要等满超时，几页之后体感等同卡死。
 *  改为**复用传入的标签页**（通常是源页，处于激活态不会被节流）：
 *    记住原 URL → 逐页导航 → 每页等加载 + 渲染 → 读 DOM → 最后导航回原 URL。
 *  代价：会短暂占用用户当前标签页（这是可靠的代价，已与用户确认方向）。
 */
export async function extractPagesByTabNavigation(
  tabId: number,
  urls: string[],
  opts?: {
    selector?: string
    hosts?: string[]
    renderWaitMs?: number
    timeoutMs?: number
    /** 连续该数量的空页即停止（默认 3）—— SPA 读不到总页数，靠这个收敛 */
    stopAfterEmptyPages?: number
    /** 每抓完一页回调，用于上层打日志/上报进度 */
    onPage?: (index: number, url: string, count: number) => void
  },
): Promise<{ url: string; images: string[] }[]> {
  const renderWaitMs = opts?.renderWaitMs ?? 600
  const timeoutMs = opts?.timeoutMs ?? 15000
  const stopAfterEmpty = opts?.stopAfterEmptyPages ?? 3
  const results: { url: string; images: string[] }[] = []
  // 记住用户原本停留的页面，全部抓完后导航回去
  let originalUrl = ''
  try {
    const t = await chrome.tabs.get(tabId)
    originalUrl = t.url ?? ''
  } catch {
    /* ignore */
  }

  const waitComplete = async (): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const t = await chrome.tabs.get(tabId)
        if (t.status === 'complete') return
      } catch {
        return // 标签页被关闭等情况，直接放弃本页
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  try {
    let emptyStreak = 0
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]
      let images: string[] = []
      try {
        await chrome.tabs.update(tabId, { url })
        await waitComplete()
        // 额外等 JS 渲染（SPA 图片通常在 hydration 之后插入 DOM）
        await new Promise((r) => setTimeout(r, renderWaitMs))
        images = await extractDomImages(tabId, { selector: opts?.selector, hosts: opts?.hosts })
      } catch {
        images = []
      }
      results.push({ url, images })
      opts?.onPage?.(i, url, images.length)
      // 连续空页收敛：SPA 读不到总页数，不能靠 maxPage 决定何时停
      emptyStreak = images.length === 0 ? emptyStreak + 1 : 0
      if (emptyStreak >= stopAfterEmpty) break
    }
  } finally {
    if (originalUrl) {
      await chrome.tabs.update(tabId, { url: originalUrl }).catch(() => {})
    }
  }
  return results
}
