// freeimage.host 数据类型（FP-007）
// 独立文件：types.ts 为 FROZEN 模块（红线 1），freeimage 类型不并入，避免触碰冻结文件

// ========== 基础数据 ==========

/** freeimage 图片（图片 data-object 解析结果） */
export interface FhImage {
  id: string // id_encoded
  filename: string // 服务端文件名（hash.ext）
  name: string // 原始上传文件名（关键词筛选数据源）
  originalUrl: string // 原图（iili.io 直链）
  mediumUrl: string // 展示图（md 档）
  thumbUrl: string // 缩略图
  width?: number
  height?: number
  viewerUrl: string // 图片页（/i/{id}）
}

/** freeimage 相册（相册列表项，无 data-object，属性直读） */
export interface FhAlbum {
  id: string // 相册 ID（data-id）
  name: string // 相册名（data-name，中文名支持）
  url: string // 相册 URL（/a/{slug}.{ID}）
  coverUrl: string // 封面图
  thumbUrl: string // 封面缩略图
  description?: string
}

/** freeimage 用户（图片页属主） */
export interface FhOwner {
  username: string
  url: string // 用户主页（/username）
  avatarUrl: string
}

// ========== 类群标注库（fh_producer_db，FP-007 场景 E） ==========

export type FhProducerStatus = 'target' | 'excluded' | null

/** 类群标注库条目（username 为主键） */
export interface FhProducerEntry {
  username: string
  /** 目标 / 排除 / 未标注（null） */
  status: FhProducerStatus
  /** 排除理由 / 目标备注（用户填写） */
  reason?: string
  avatarUrl?: string
  /** 相册名线索缓存（类群判断依据，L2 扩散采集） */
  albums?: { name: string; url: string }[]
  albumCount?: number
  /** 首次发现时间 */
  seenAt: number
  /** 标注时间 */
  notedAt?: number
}

/** 类群标注库（导出/导入用） */
export interface FhProducerDb {
  entries: Record<string, FhProducerEntry>
  updatedAt: number
}

/** 空标注库 */
export function emptyFhProducerDb(): FhProducerDb {
  return { entries: {}, updatedAt: 0 }
}

/** 从任意对象加载标注库（防御脏数据） */
export function loadFhProducerDb(raw: unknown): FhProducerDb {
  if (!raw || typeof raw !== 'object') return emptyFhProducerDb()
  const r = raw as Partial<FhProducerDb>
  const entries: Record<string, FhProducerEntry> = {}
  if (r.entries && typeof r.entries === 'object') {
    for (const [username, e] of Object.entries(r.entries)) {
      if (!e || typeof e !== 'object') continue
      const en = e as Partial<FhProducerEntry>
      entries[username] = {
        username: String(en.username ?? username),
        status: en.status === 'target' || en.status === 'excluded' ? en.status : null,
        reason: typeof en.reason === 'string' ? en.reason : undefined,
        avatarUrl: typeof en.avatarUrl === 'string' ? en.avatarUrl : undefined,
        albums: Array.isArray(en.albums) ? en.albums.slice(0, 500) : undefined,
        albumCount: typeof en.albumCount === 'number' ? en.albumCount : undefined,
        seenAt: typeof en.seenAt === 'number' ? en.seenAt : Date.now(),
        notedAt: typeof en.notedAt === 'number' ? en.notedAt : undefined,
      }
    }
  }
  return { entries, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now() }
}

// ========== 相册索引记录库（fh_album_index，FP-007 场景 D） ==========

/** 相册索引条目（仅文字信息，检索用；不存图片，抓取阶段不加载图片资源） */
export interface FhAlbumIndexEntry {
  id: string // 相册 ID
  name: string // 相册名
  url: string // 相册地址（点击跳转）
  username?: string // 属主用户名（可选补充）
  imageCount?: number // 图片数（可选）
  source: string // 来源：模式/类型（如 recent-albums）/mine（深挖）
  collectedAt: number // 采集时间
  mined?: boolean // 是否已做过属主深挖（中文深挖用）
}

/** 相册索引库（导出/导入用） */
export interface FhAlbumIndexDb {
  entries: Record<string, FhAlbumIndexEntry> // key = 相册 ID
  updatedAt: number
}

/** 空索引库 */
export function emptyFhAlbumIndexDb(): FhAlbumIndexDb {
  return { entries: {}, updatedAt: 0 }
}

/** 从任意对象加载索引库（防御脏数据） */
export function loadFhAlbumIndexDb(raw: unknown): FhAlbumIndexDb {
  if (!raw || typeof raw !== 'object') return emptyFhAlbumIndexDb()
  const r = raw as Partial<FhAlbumIndexDb>
  const entries: Record<string, FhAlbumIndexEntry> = {}
  if (r.entries && typeof r.entries === 'object') {
    for (const [id, e] of Object.entries(r.entries)) {
      if (!e || typeof e !== 'object') continue
      const en = e as Partial<FhAlbumIndexEntry>
      if (!en.name) continue
      entries[id] = {
        id: String(en.id ?? id),
        name: String(en.name),
        url: String(en.url ?? ''),
        username: typeof en.username === 'string' ? en.username : undefined,
        imageCount: typeof en.imageCount === 'number' ? en.imageCount : undefined,
        source: String(en.source ?? ''),
        collectedAt: typeof en.collectedAt === 'number' ? en.collectedAt : Date.now(),
        mined: en.mined === true ? true : undefined,
      }
    }
  }
  return { entries, updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now() }
}
