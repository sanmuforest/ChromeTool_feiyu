// 图站模块（FP-018）—— 运行期注册表
//
// 对外接口（保持与原 lib/gallery-sites.ts 一致，调用方只需改 import 路径）：
// - GALLERY_SITES / matchGallerySite / siteById
// - parseGalleryImages / parseGalleryMaxPage / parseGalleryPageTitle
// - GallerySiteConfig 类型
//
// 搜索/推荐链接解析器与张数规则见 parsers.ts。

import { COMPILED_SITES, listPageUrl, parseGalleryImages, parseGalleryMaxPage, parseGalleryPageTitle } from './engine'
import type { GallerySiteConfig } from './schema'

export { listPageUrl, parseGalleryImages, parseGalleryMaxPage, parseGalleryPageTitle }
export type { GallerySiteConfig, SiteDef } from './schema'

/** 全部运行期站点（顺序 = SITE_DEFS 顺序） */
export const GALLERY_SITES: GallerySiteConfig[] = COMPILED_SITES

/** 按 URL hostname 匹配站点配置 */
export function matchGallerySite(url: string): GallerySiteConfig | null {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    for (const site of GALLERY_SITES) {
      if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site
    }
  } catch {
    // 非法 URL
  }
  return null
}

/** 按站点 id 取配置 */
export function siteById(id: string): GallerySiteConfig | undefined {
  return GALLERY_SITES.find((s) => s.id === id)
}
