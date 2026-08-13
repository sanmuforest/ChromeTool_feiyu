// jrants.com（青年美图，WordPress）专用解析（FP-008）
// 实测结构（2026-08-13，agent-browser）：
// - 文章页正文：.entry-content 内 <img class="wp-image-*" src="m2.jrants.com/wp-content/uploads/YYYY/MM/DD/{name}.jpg">（由 gallery-sites 通用解析）
// - 文章内分页：路径式 /N（<a href=".../2" class="post-page-numbers">，page-links 导航）
// - 相关文章：<section class="wp-show-posts"> 内 <article class="wp-show-posts-single">
//     封面 <a href="https://jrants.com/20xxxx.html" title="标题 (73P)"><img src=".../xxx-270x400.jpg"></a>
//     标题 <p class="wp-show-posts-entry-title"><a href="...">标题</a></p>
// - 列表页：普通 article 卡片（h2 标题 a + 封面 img）

import type { BuonduaLinkItem } from './types'

/** 解析 jrants 文章链接：
 *  - onlyRecommended=true：仅解析 wp-show-posts 相关文章卡片（推荐链接）
 *  - 否则：解析全页所有文章链接，excludeUrls 排除推荐区/自身 */
export function parseJrantsPostLinks(
  html: string,
  _baseUrl: string,
  opts: { onlyRecommended?: boolean; excludeUrls?: Set<string> } = {},
): BuonduaLinkItem[] {
  const { onlyRecommended = false, excludeUrls } = opts
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()

  const collect = (block: string): void => {
    const re = /<a[^>]*href="(https?:\/\/jrants\.com\/20\d+\.html)"[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(block)) !== null) {
      const url = m[1]
      if (seen.has(url)) continue
      seen.add(url)
      if (excludeUrls?.has(url)) continue
      // 标题：a 的 title 属性（封面 a）→ a 内文本（entry-title a）→ 附近文本兜底
      let title = (m[0].match(/title="([^"]*)"/)?.[1] || '').trim()
      if (!title) {
        title = m[0].replace(/<[^>]*>/g, '').trim()
      }
      if (!title) {
        const tm = block.slice(m.index, m.index + 600).match(/>([^<>]{2,})</)
        if (tm) title = tm[1].trim()
      }
      // 封面：该 a 前后 2000 字符内首个 jrants 图片（搜索/列表页封面在 post-thumb，位于标题 a 之前）
      const around = block.slice(Math.max(0, m.index - 2000), m.index + 2000)
      const coverMatch = around.match(/src="(https?:\/\/(?:m2\.)?jrants\.com\/[^"]*)"/)
      // 图数：标题内 (73P) / [99P] / 81P（无括号）
      const countMatch =
        title.match(/\((\d+)\s*P\)/i) ?? title.match(/\[(\d+)\s*P\]/i) ?? title.match(/(?:^|\s)(\d+)\s*P\b/i)
      items.push({
        url,
        title: title || url,
        coverUrl: coverMatch ? coverMatch[1] : '',
        imageCount: countMatch ? Number(countMatch[1]) : undefined,
      })
    }
  }

  if (onlyRecommended) {
    // 相关文章：逐卡片解析
    const blockRe = /<article class="\s*wp-show-posts-single[^"]*"[^>]*>([\s\S]*?)<\/article>/g
    let bm: RegExpExecArray | null
    while ((bm = blockRe.exec(html)) !== null) collect(bm[1])
  } else {
    collect(html)
  }
  return items
}

/** jrants 文件夹名：标题直接清洗（h1 无分页标记），去站点后缀与非法字符 */
export function extractJrantsFolderName(title: string): string {
  return (
    title
      .replace(/\s*[-–—]\s*青年美图\s*$/i, '')
      .replace(/[\\/:*?"<>|\n\r]/g, '_')
      .trim()
      .slice(0, 120) || 'jrants'
  )
}
