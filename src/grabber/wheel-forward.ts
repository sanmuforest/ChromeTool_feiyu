// 空白区域滚轮转发（FP-020）
//
// 背景：抓取页 .app 限宽 1200px 居中（grabber.css），两侧留白属于 body；
// 而 .main / .panel 都是 overflow: hidden，真正的滚动发生在各面板内部容器。
// 鼠标停在留白或不可滚动区域时，浏览器找不到可滚动祖先 → 滚轮无反应。
//
// 做法：监听全局 wheel，若事件目标不在任何可滚动祖先内，则把滚动量转发给
// 当前激活页签内「可滚动余量最大」的可见容器。
// 守卫：交互控件（下拉/输入）与大图预览浮层内的滚轮不接管，避免破坏原生行为与预览缩放。

/** 元素可纵向滚动且当前有滚动余量 */
function isScrollable(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false
  const overflowY = getComputedStyle(el).overflowY
  if (overflowY !== 'auto' && overflowY !== 'scroll') return false
  return el.scrollHeight - el.clientHeight > 1
}

/** 事件目标向上最近的可滚动祖先 */
function scrollableAncestor(target: EventTarget | null): HTMLElement | null {
  let el: HTMLElement | null = target instanceof HTMLElement ? target : null
  while (el) {
    if (isScrollable(el)) return el
    el = el.parentElement
  }
  return null
}

let cachedScroller: HTMLElement | null = null
let cachedAt = 0
const CACHE_MS = 300

/** 当前激活页签内可滚动余量最大的可见容器（300ms 缓存，避免高频遍历 DOM） */
function primaryScroller(): HTMLElement | null {
  const now = Date.now()
  if (cachedScroller && now - cachedAt < CACHE_MS && cachedScroller.isConnected && isScrollable(cachedScroller)) {
    return cachedScroller
  }
  const panel = document.querySelector('.panel.active')
  if (!panel) {
    cachedScroller = null
    cachedAt = now
    return null
  }
  let best: HTMLElement | null = null
  let bestRange = 0
  panel.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (!isScrollable(el)) return
    const rect = el.getBoundingClientRect()
    if (rect.width < 60 || rect.height < 60) return // 忽略不可见 / 极小容器
    const range = el.scrollHeight - el.clientHeight
    if (range > bestRange) {
      bestRange = range
      best = el
    }
  })
  cachedScroller = best
  cachedAt = now
  return best
}

/** 注册空白区滚轮转发（页面加载时调用一次） */
export function initWheelForward(): void {
  document.addEventListener(
    'wheel',
    (ev) => {
      if (ev.defaultPrevented) return
      const target = ev.target instanceof HTMLElement ? ev.target : null
      // 交互控件的原生滚轮行为（下拉选项选择等）不接管
      if (target && (target.tagName === 'SELECT' || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
      // 大图预览浮层内的滚轮用于缩放，不接管
      if (target && target.closest('.preview-layer')) return
      // 目标已在可滚动容器内 → 交给浏览器默认行为
      if (scrollableAncestor(ev.target)) return
      const scroller = primaryScroller()
      if (!scroller) return
      const delta =
        ev.deltaMode === 1
          ? ev.deltaY * 16
          : ev.deltaMode === 2
            ? ev.deltaY * scroller.clientHeight
            : ev.deltaY
      scroller.scrollTop += delta
      ev.preventDefault()
    },
    { passive: false },
  )
}
