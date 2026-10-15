// ilovexs（FP-014 新站）：image-gallery / gallery-item 正文 + 无分页
// 卡片 album-card 为相关推荐（必须隔离，用 image-gallery 容器）；标题后缀 "| Nongmo.Zone"
// 内容图在跨域图床 neoobox.top（带扩展名，无需白名单）
// 2026-10-11 修复：容器标签实测为 <section class="image-gallery">（原定义写 div → 容器匹配失败 → 抓取 0 张）
import type { SiteDef } from '../schema'

export const ilovexs: SiteDef = {
  id: 'ilovexs',
  label: 'iLoveXS',
  uiOrder: 90,
  channels: ['google'],
  defaultChecked: false,
  folderTag: 'buondua',
  endpoints: [{ host: 'ilovexs.com', role: 'primary' }],
  container: { tag: 'section', className: 'image-gallery' },
  pagination: { kind: 'single' },
  // maxPagePattern 缺省 = 无标题标记
  titleStrip: [{ source: '\\s*\\|\\s*Nongmo\\.Zone\\s*$', flags: 'i' }],
  linkParser: 'generic-post-links',
}
