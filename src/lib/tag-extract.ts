// 标签抽取与统计 v2（FP-016）：词典命中 + 自由文本双通道（纯逻辑，无副作用）
//
// 相比 FP-006 的改变：
// 1. 双通道：① 词典通道（中/英/日/韩同义归并到标准名，含成人向分类）② 自由通道（演员名/英文名/未收录词）
// 2. 停用词表不再吞掉成人向有效词（sexy/naked/无码/福利 等改为词典标签）
// 3. 分类从 7 类扩到 14 类（+ip 作品 / fetish 恋物 / act 行为 / prop 道具 / body 身材 / relation 关系 / scene 场景）
// 4. 阈值默认放量（相册≥5、用户≥1），且可由 UI 传入
// 5. 支持自定义词典与屏蔽词（storage tag_custom）
// 6. 性能：词典预编译为「CJK 包含正则 + 拉丁词边界正则」各一条，一次扫描；命中区间去重取最长

import type { ProducerEntry } from './types'
import {
  TAG_DICT,
  TAG_CATEGORY_LABEL,
  SYNONYM_TO_STANDARD,
  CATEGORY_OF_STANDARD,
  type DictEntry,
  type TagCategory,
} from './tag-dict'

export type { TagCategory, DictEntry } from './tag-dict'
export { TAG_CATEGORY_LABEL, TAG_CATEGORY_ORDER, TAG_DICT } from './tag-dict'

export interface TagStat {
  t: string
  c: TagCategory
  albums: number
  users: number
}

export const TAG_MIN_ALBUMS = 5
export const TAG_MIN_USERS = 1
export const TAG_DEFAULT_TOP = 200

// ---------- 自定义词典与屏蔽词（FP-016） ----------

export interface TagCustomDict {
  /** 自定义词条（补词典未收录的标签；syn 为同义词） */
  entries: { t: string; c: TagCategory; syn?: string[] }[]
  /** 屏蔽词（按标签名匹配，不区分大小写；命中则不参与统计） */
  blocked: string[]
}

export function emptyCustomDict(): TagCustomDict {
  return { entries: [], blocked: [] }
}

/** storage 读取容错（非法条目丢弃，分类非法则降级为 english） */
export function loadCustomDict(raw: unknown): TagCustomDict {
  const out = emptyCustomDict()
  if (!raw || typeof raw !== 'object') return out
  const obj = raw as Partial<TagCustomDict>
  if (Array.isArray(obj.entries)) {
    for (const e of obj.entries) {
      if (!e || typeof e.t !== 'string' || !e.t.trim()) continue
      const c = (typeof e.c === 'string' && e.c in TAG_CATEGORY_LABEL ? e.c : 'english') as TagCategory
      const syn = Array.isArray(e.syn) ? e.syn.filter((s): s is string => typeof s === 'string' && !!s.trim()) : []
      out.entries.push({ t: e.t.trim(), c, syn })
    }
  }
  if (Array.isArray(obj.blocked)) {
    out.blocked = obj.blocked.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim())
  }
  return out
}

// ---------- 停用词 ----------

/** 通用噪音词（原 STOP 中真正的噪音；成人向有效词已移入词典） */
const STOP = new Set([
  'model', 'models', 'original', 'premade', 'custom', 'latepost', 'goddess', 'goddes', 'feed', 'photo', 'photos',
  'pic', 'pics', 'set', 'sets', 'collection', 'vol', 'vols', 'part', 'full', 'hd', 'uhd', '4k', 'uncensored',
  'censored', 'preview', 'gallery', 'album', 'albums', 'video', 'videos', 'update', 'new', 'exclusive', 'bts',
  'cover', 'random', 'various', 'deleted', 'test', 'shoots', 'photoshoot', 'digital', 'series', 'official',
  'photography', 'media', 'expensive', 'delicious', 'overseas', 'last', 'first', 'best', 'good', 'nice', 'beautiful',
  'beauty', 'pretty', 'cute', 'style', 'pure', 'stop', 'love', 'like', 'studio', 'indoor', 'outdoor', 'amateur',
  '写真', '画像', '照片', '图片', '图集', '图包', '套图', '合集', '系列', '预览', '拍摄', '作品', '日常', '生活',
  '杂图', '美女', '壁纸', '自拍照', '定制', '紧急企划', '无水印', '模特', '图', '集',
  '섹시', '사진', '모음', '화보', '디지털', '하이퀄리티', '홈트레이닝', '빨래', '차원', '눈빛', '처음', '어젯밤',
  '서울', '밤', '매혹', '여자', '남자', '사진집', '디지털화보',
])

/** 英文功能词（自由通道小写单词提取时排除） */
const EN_FUNCTION = new Set([
  'the', 'and', 'with', 'for', 'from', 'this', 'that', 'these', 'those', 'into', 'over', 'under', 'about', 'after',
  'before', 'very', 'just', 'only', 'also', 'more', 'most', 'some', 'such', 'than', 'then', 'them', 'they', 'their',
  'there', 'here', 'when', 'where', 'what', 'which', 'while', 'your', 'you', 'her', 'his', 'she', 'him', 'our',
  'are', 'was', 'were', 'been', 'being', 'have', 'has', 'had', 'will', 'would', 'could', 'should', 'can', 'may',
  'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
  'vol', 'no', 'yes', 'day', 'days', 'one', 'two', 'three', 'first', 'second', 'third', 'last', 'next', 'back',
  'top', 'new', 'old', 'big', 'small', 'long', 'short', 'high', 'low', 'hot', 'cold', 'white', 'black', 'red',
  'blue', 'green', 'pink', 'yellow', 'purple', 'brown', 'gray', 'grey', 'gold', 'silver', 'pink',
])

/** 非中文标签 → 中文注释（补充词典未收录的专名） */
const NOTE: Record<string, string> = {
  ol: '职业装', jk: '校服', lolita: '洛丽塔', latex: '胶衣', cosplay: '角色扮演', t: 'T恤',
  'petra verkaik': '佩特拉·韦尔凯克', bambi: '斑比', 'jinny rux land': '金妮·鲁克斯', 'wang yu chun': '王雨纯',
  'erica campbell': '艾丽卡·坎贝尔', 'xia mei jiang': '夏美酱', 'jenny suen': '珍妮·苏恩', 'stracy stone': '史黛西·斯通',
  'masked queen': '蒙面女王', hijaber: '希贾伯', kokuhui: '国辉', sira: '西拉',
  'けんけん': '健健', 'けん研': '健研', 'レム': '蕾姆', 'rissa may': '丽莎·梅', 'lexi lore': '莱克西·洛尔',
  'emily willis': '艾米丽·威利斯',
  '예하': '艺夏', '정미': '贞美', '보라': '宝拉', '손예은': '孙艺恩', '민하린': '闵夏琳', '박아람': '朴雅岚',
  '지영': '智英', '연우': '妍雨', '강인경': '姜仁京', '이하': '李夏', '아람': '雅岚',
}

/** 拼音 → 中文（合并重复标签） */
const PINYIN_MERGE: Record<string, string> = {
  'wang yu chun': '王雨纯', 'xia mei jiang': '夏美酱', 'huang le ran': '黄楽然', 'li ke ke': '李可可',
}

/** 非中文标签注释（分类优先，兜底按字形判断） */
export function noteFor(t: string, c?: TagCategory): string {
  const hit = NOTE[t.toLowerCase()]
  if (hit) return hit
  if (c && TAG_CATEGORY_LABEL[c]) return TAG_CATEGORY_LABEL[c]
  if (t.startsWith('@')) return '引用用户'
  if (/[\uac00-\ud7af]/.test(t)) return '韩语名'
  if (/[\u3040-\u30ff]/.test(t)) return '日文名'
  if (/[\u4e00-\u9fff]/.test(t)) return '中文名'
  return '英文名'
}

// ---------- 匹配器 ----------

const CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface Matcher {
  /** 含中日韩字符的词：直接包含匹配 */
  cjk: RegExp | null
  /** 纯拉丁词：词边界匹配（避免 ol 命中 gold） */
  latin: RegExp | null
  /** 命中原文（小写）→ 标准名 */
  map: Map<string, string>
  /** 词典全部字面（小写），供自由通道避让 */
  words: Set<string>
}

/** 预编译匹配器（内置词典 + 自定义词典；长词优先） */
export function buildMatcher(custom?: TagCustomDict): Matcher {
  const entries: DictEntry[] = [
    ...TAG_DICT,
    ...(custom?.entries ?? []).map((e) => ({ t: e.t, c: e.c, syn: e.syn ?? [] })),
  ]
  const map = new Map<string, string>(SYNONYM_TO_STANDARD)
  const cjkKeys = new Set<string>()
  const latinKeys = new Set<string>()
  for (const e of entries) {
    const keys = [e.t, ...e.syn]
    for (const k of keys) {
      const raw = k.trim()
      if (!raw) continue
      const lower = raw.toLowerCase()
      map.set(lower, e.t)
      if (CJK_RE.test(raw)) cjkKeys.add(raw)
      else latinKeys.add(lower)
    }
  }
  const byLenDesc = (a: string, b: string): number => b.length - a.length || a.localeCompare(b)
  const cjkList = [...cjkKeys].sort(byLenDesc)
  const latinList = [...latinKeys].sort(byLenDesc)
  const words = new Set<string>([...cjkKeys, ...latinKeys].map((k) => k.toLowerCase()))
  return {
    cjk: cjkList.length ? new RegExp(cjkList.map(escapeRe).join('|'), 'g') : null,
    latin: latinList.length
      ? new RegExp(`(?<![a-z0-9])(?:${latinList.map(escapeRe).join('|')})(?![a-z0-9])`, 'gi')
      : null,
    map,
    words,
  }
}

interface Hit {
  s: number
  e: number
  raw: string
  std: string
}

interface DictScan {
  tags: Map<string, TagCategory>
  /** 词典命中的原文（小写），供自由通道避让防重复 */
  literals: Set<string>
}

/** 扫描一个相册名：词典命中（区间去重取最长，长词优先） */
function matchDict(name: string, m: Matcher): DictScan {
  const hits: Hit[] = []
  for (const re of [m.cjk, m.latin]) {
    if (!re) continue
    re.lastIndex = 0
    let mt: RegExpExecArray | null
    while ((mt = re.exec(name)) !== null) {
      const std = m.map.get(mt[0].toLowerCase())
      if (std) hits.push({ s: mt.index, e: mt.index + mt[0].length, raw: mt[0], std })
      if (mt[0].length === 0) re.lastIndex++
    }
  }
  // 长命中优先，避免「黑丝袜」同时计入「黑丝」与「丝袜」
  hits.sort((a, b) => b.e - b.s - (a.e - a.s) || a.s - b.s)
  const used: [number, number][] = []
  const tags = new Map<string, TagCategory>()
  const literals = new Set<string>()
  for (const h of hits) {
    if (used.some(([s, e]) => h.s < e && s < h.e)) continue
    used.push([h.s, h.e])
    tags.set(h.std, CATEGORY_OF_STANDARD.get(h.std) ?? 'english')
    literals.add(h.raw.toLowerCase())
  }
  return { tags, literals }
}

function cleanEmoji(s: string): string {
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}\u{2B06}\u{2B07}\u{25B6}\u{25C0}]/gu, ' ')
}

/** 自由通道：演员名 / 韩语名 / 英文名 / 未收录小写词
 * 避让：词典已命中的字面（dictLiterals）与词典词表（dictWords）不再重复产出 */
function matchFree(
  name: string,
  dictLiterals: Set<string>,
  dictWords: Set<string>,
  out: Map<string, TagCategory>,
): void {
  let s = cleanEmoji(name).replace(/&amp;/g, '&')
  // @引用 → at 标签
  for (const m of s.match(/@[a-zA-Z0-9_]+/g) ?? []) out.set(m, 'at')
  s = s.replace(/@([a-zA-Z0-9_]+)/g, ' ')
  // 编号剥离（E123 / -123 / 纯数字）
  s = s.replace(/\bE\d{2,4}\b/gi, ' ').replace(/-\d{2,4}/g, ' ').replace(/\d+/g, ' ')
  /** 该段是否已被词典覆盖（本身是词典词，或包含/被包含于某条命中原文） */
  const coveredByDict = (seg: string): boolean => {
    const low = seg.toLowerCase()
    if (dictWords.has(low)) return true
    for (const lit of dictLiterals) {
      if (low.includes(lit) || lit.includes(low)) return true
    }
    return false
  }
  const parts = s.split(/[,&;()|·•\-_/\\、。！？!?【】\[\]「」『』<>~～+]+/).map((p) => p.trim()).filter(Boolean)
  const usedWords = new Set<string>()
  for (const part of parts) {
    // 韩语名
    for (const k of part.match(/[\uac00-\ud7af]{2,}/g) ?? []) {
      if (!STOP.has(k) && !coveredByDict(k)) out.set(k, 'korean')
    }
    // 中文/日文名（整段，≥2 字）
    for (const j of part.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g) ?? []) {
      if (j.length >= 2 && !STOP.has(j) && !coveredByDict(j)) out.set(PINYIN_MERGE[j] ?? j, 'japanese')
    }
    const words = part.split(/[\s\-]+/).filter(Boolean)
    // 英文演员名：连续 Capitalized 词序列（≤3 词，且不含意大利词典词堆）
    const cap = words.filter(
      (w) =>
        /^[A-Z][a-z']{1,}$/.test(w) &&
        !STOP.has(w.toLowerCase()) &&
        !EN_FUNCTION.has(w.toLowerCase()) &&
        !dictWords.has(w.toLowerCase()),
    )
    if (cap.length >= 1 && cap.length <= 3) {
      const phrase = cap.join(' ').toLowerCase()
      if (phrase.length >= 3 && phrase.length <= 40) {
        out.set(PINYIN_MERGE[phrase] ?? phrase, 'english')
        for (const w of cap) usedWords.add(w.toLowerCase())
      }
    }
    // 英文小写独立词（≥4 字母，补词典盲区）
    for (const w of words) {
      const lw = w.toLowerCase().replace(/[^a-z]/g, '')
      if (lw.length < 4 || STOP.has(lw) || EN_FUNCTION.has(lw) || dictWords.has(lw) || usedWords.has(lw)) continue
      if (!out.has(lw)) out.set(lw, 'english')
    }
  }
}

/** 单个相册名 → Map<标签, 分类>（词典通道优先，自由通道避让已覆盖字面） */
export function extractFromName(name: string, matcher: Matcher): Map<string, TagCategory> {
  const dict = matchDict(name, matcher)
  matchFree(name, dict.literals, matcher.words, dict.tags)
  return dict.tags
}

// ---------- 统计 ----------

export interface ComputeTagsOptions {
  topN?: number
  minAlbums?: number
  minUsers?: number
  /** 自定义词典与屏蔽词 */
  custom?: TagCustomDict
  /** 是否统计相册 URL slug（部分站点 slug 含关键词） */
  includeSlug?: boolean
}

/** 统计标签：遍历已确认用户的相册名 → 双通道提取 → 归并/过滤 → 排序 Top N */
export function computeTags(entries: ProducerEntry[], opts: ComputeTagsOptions | number = {}): TagStat[] {
  const o: ComputeTagsOptions = typeof opts === 'number' ? { topN: opts } : opts
  const topN = o.topN ?? TAG_DEFAULT_TOP
  const minAlbums = Math.max(1, o.minAlbums ?? TAG_MIN_ALBUMS)
  const minUsers = Math.max(1, o.minUsers ?? TAG_MIN_USERS)
  const matcher = buildMatcher(o.custom)
  const blocked = new Set((o.custom?.blocked ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean))

  const total = new Map<string, number>()
  const users = new Map<string, Set<string>>()
  const catOf = new Map<string, TagCategory>()

  for (const e of entries) {
    if (!e.albums) continue
    for (const a of e.albums) {
      const names = o.includeSlug && a.url ? [a.name, slugOf(a.url)] : [a.name]
      for (const nm of names) {
        if (!nm) continue
        for (const [t, c] of extractFromName(nm, matcher)) {
          if (blocked.has(t.toLowerCase())) continue
          total.set(t, (total.get(t) ?? 0) + 1)
          if (!users.has(t)) users.set(t, new Set())
          users.get(t)!.add(e.username)
          if (!catOf.has(t)) catOf.set(t, c)
        }
      }
    }
  }

  const merged = new Map<string, TagStat>()
  for (const [t, c] of catOf) {
    const albums = total.get(t) ?? 0
    const uc = users.get(t)?.size ?? 0
    if (albums < minAlbums || uc < minUsers) continue
    const cn = PINYIN_MERGE[t]
    const k = cn && merged.has(cn) ? cn : t
    const prev = merged.get(k)
    if (prev) {
      prev.albums += albums
      prev.users = Math.max(prev.users, uc)
    } else {
      merged.set(k, { t: k, c, albums, users: uc })
    }
  }
  return [...merged.values()].sort((a, b) => b.albums - a.albums || a.t.localeCompare(b.t)).slice(0, Math.max(0, topN))
}

/** 从相册 URL 取 slug（末段去扩展名，连字符转空格） */
function slugOf(url: string): string {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ')
  } catch {
    return ''
  }
}
