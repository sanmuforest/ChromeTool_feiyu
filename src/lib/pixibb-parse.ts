// pixibb.com（PixiBB，WordPress magezix 主题）专用解析（FP-009）
// 实测结构（2026-08-13，curl 直连）：
// - 文章页正文：.entry-content 内 <div class="wp-block-image"><figure><img src="imgx{NNN}.pixibb.com/{YYYY}/{MM}/{DD}/{ID}/{name}-{NNN}.jpg"></figure></div>
// - 文章内分页：路径式带尾斜杠 /N/（<a href=".../2/" class="post-page-numbers">，page-links 导航）
// - 前后文章导航：<a class="post-nav__link" href="https://{sub}.pixibb.com/{slug}-{N}-photos-{M}-videos/">（上一篇/下一篇）
// - 列表页：/albums/ + /albums/page/N/（WP 标准 page-numbers 分页，共 916 页）
// - 文章 URL 格式：/{slug}-{N}-photos-{M}-videos/

import type { BuonduaLinkItem } from './types'

/** 解析 pixibb 文章链接：
 *  - onlyRecommended=true：仅解析 post-nav 前后文章（2 条）
 *  - 否则：解析全页所有文章链接，excludeUrls 排除推荐区/自身 */
export function parsePixibbPostLinks(
  html: string,
  _baseUrl: string,
  opts: { onlyRecommended?: boolean; excludeUrls?: Set<string> } = {},
): BuonduaLinkItem[] {
  const { onlyRecommended = false, excludeUrls } = opts
  const items: BuonduaLinkItem[] = []
  const seen = new Set<string>()

  const collect = (block: string): void => {
    const re = /<a[^>]*href="(https:\/\/[a-z0-9-]+\.pixibb\.com\/[a-z0-9-]+-\d+-photos-\d+-videos\/)"[^>]*>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(block)) !== null) {
      const url = m[1]
      if (seen.has(url)) continue
      seen.add(url)
      if (excludeUrls?.has(url)) continue
      // 标题：a 的 title 属性 → a 内文本 → post-title（post-nav 标题在相邻卡片）→ 附近文本兜底
      let title = (m[0].match(/title="([^"]*)"/)?.[1] || '').trim()
      if (!title) {
        title = m[0].replace(/<[^>]*>/g, '').trim()
      }
      if (!title) {
        const tm2 = block.slice(m.index, m.index + 3000).match(/<h[234][^>]*class="[^"]*post-title[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/)
        if (tm2) title = tm2[1].trim()
      }
      if (!title) {
        const tm = block.slice(m.index, m.index + 600).match(/>([^<>]{2,})</)
        if (tm) title = tm[1].trim()
      }
      // 封面：该 a 前后 2000 字符内首个 pixibb 图片（搜索/列表页封面在 post-thumb，位于标题 a 之前）
      const around = block.slice(Math.max(0, m.index - 2000), m.index + 2000)
      const coverMatch = around.match(/src="(https:\/\/[a-z0-9]+\.pixibb\.com\/[^"]*)"/)
      // 图数：标题内 (55 photos) / (N photos + M videos)
      const countMatch = title.match(/\((\d+)\s*photos?/i)
      items.push({
        url,
        title: title || url,
        coverUrl: coverMatch ? coverMatch[1] : '',
        imageCount: countMatch ? Number(countMatch[1]) : undefined,
      })
    }
  }

  if (onlyRecommended) {
    // 前后文章导航：post-title 区块（URL + 标题），封面向前 2000 字符内取（post-thumb 在其前）
    const re = /<h2[^>]*class="[^"]*post-title[^"]*"[^>]*>\s*<a[^>]*href="(https:\/\/[a-z0-9-]+\.pixibb\.com\/[a-z0-9-]+-\d+-photos-\d+-videos\/)"[^>]*>([^<]+)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) {
      const url = m[1]
      const title = m[2].trim()
      if (seen.has(url)) continue
      seen.add(url)
      if (excludeUrls?.has(url)) continue
      const before = html.slice(Math.max(0, m.index - 2000), m.index)
      const coverMatch = before.match(/src="(https:\/\/[a-z0-9]+\.pixibb\.com\/[^"]*)"/)
      const countMatch = title.match(/\((\d+)\s*photos?/i)
      items.push({
        url,
        title: title || url,
        coverUrl: coverMatch ? coverMatch[1] : '',
        imageCount: countMatch ? Number(countMatch[1]) : undefined,
      })
    }
    return items
  } else {
    collect(html)
  }
  return items
}

/** pixibb 文件夹名：标题直接清洗（h1 无分页标记），去站点后缀与非法字符 */
export function extractPixibbFolderName(title: string): string {
  return (
    title
      .replace(/\s*[-–—]\s*PixiBB\s*$/i, '')
      .replace(/[\\/:*?"<>|\n\r]/g, '_')
      .trim()
      .slice(0, 120) || 'pixibb'
  )
}
