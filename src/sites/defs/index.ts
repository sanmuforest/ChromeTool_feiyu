// 图站定义注册表（FP-018）：聚合全部站点定义
//
// 新增站点 = 新增一个 defs/*.ts 文件 + 在此加一行 import 与数组项（阶段 1）；
// 废弃站点（2026-10-11 起）：定义文件移入 `归档/<站点>-<日期>-废弃归档/` 并从本表移除
//   （cangcuc —— 域名 DNS 长期失效；xiuzhai5 —— 大部分链接跳转付费。
//     见变更日志 2026-10-11-005 / 2026-10-15-013）
// 数组顺序 = 编译后 GALLERY_SITES 顺序，参与聚合搜索「Google 全站」的站点遍历顺序，
// 保持与旧 lib/gallery-sites.ts 的声明顺序一致（行为等价要求）。

import type { SiteDef } from '../schema'
import { buondua } from './buondua'
import { rrwsh } from './rrwsh'
import { hitxhot } from './hitxhot'
import { kaizty } from './kaizty'
import { jrants } from './jrants'
import { pixibb } from './pixibb'
import { phimvuspot } from './phimvuspot'
import { ilovexs } from './ilovexs'
import { knitbid } from './knitbid'
import { se8 } from './se8'
import { jliji } from './jliji'

/** 全部站点定义（顺序敏感，勿随意调整） */
export const SITE_DEFS: SiteDef[] = [
  buondua,
  rrwsh,
  hitxhot,
  kaizty,
  jrants,
  pixibb,
  phimvuspot,
  ilovexs,
  knitbid,
  se8,
  jliji,
]
