// 标签云提取（FP-006）：多语言标签提取 + 统计（纯逻辑，无副作用）
//
// 分类：japanese 演员 / korean 韩语 / theme 主题 / clothes 服装 / brand 品牌 / english 英文 / at 引用
// 统计点 = 相册数；过滤：相册数≥MIN_ALBUMS 且 覆盖用户数≥MIN_USERS；排序：相册数降序
// 规则经真实数据预研验证（32501 相册）：
// - 中文/日文：汉字+假名连续段整段；韩语：谚文段；英文：Capitalized 词序列
// - 服装词：中文包含 + 英文独立词（防字母误匹配，如 ol/jk）
// - 品牌剥离、编号剥离、停用词、拼音合并、非中文注释

import type { ProducerEntry } from './types'

export type TagCategory = 'japanese' | 'korean' | 'theme' | 'clothes' | 'brand' | 'english' | 'at'

export interface TagStat {
  t: string
  c: TagCategory
  albums: number
  users: number
}

export const TAG_MIN_ALBUMS = 10
export const TAG_MIN_USERS = 2
export const TAG_DEFAULT_TOP = 100

// ---------- 词典 ----------

const BRANDS = [
  'tokyo hot', 'pornbox', 'jav', 'spermmania', 'pacific girls', 'pacificgirls', 'blacksonblondes',
  'fellatiojapan', 'dpdiva', '秀人网', 'ugirls', 'miko酱', 'little red', 'popdaily',
]

const THEMES = new Set([
  '蕾姆', '拉姆', '原神', '碧蓝航线', '雷电将军', '胡桃', '甘雨', '初音', '明日方舟', 'fgo', '赛马娘', '舰娘', 'fate',
  '萝莉', '御姐', '温泉', '浴衣', '居家', '健身', '运动', '圣诞', '新年', '生日', '情侣', '闺蜜', '双人', '姐妹',
  '海边', '沙滩', '泳池', '酒店', '教室', '办公室', '天台', '夜景', '雨天', '雪地',
])

const CLOTHES_CN = new Set([
  '黑丝', '白丝', '丝袜', '渔网袜', '过膝袜', '袜', '制服', '体操服', '水手服', '校服', '泳装', '比基尼', '死库水',
  '汉服', '旗袍', '婚纱', '兔女郎', '女仆', '护士装', '护士', '猫耳', '兔耳', '古装', '和服', '浴衣', '肚兜',
  '睡衣', '内衣', '蕾丝', '透明', '薄纱', '纱裙', '吊带', '紧身衣', '紧身', '连体', '胶衣', '皮衣', '皮裤', '皮裙',
  '渔网', '短裤', '热裤', '长裙', '短裙', '迷你裙', '百褶裙', '包臀裙', '衬衫', '白衬衫', '卫衣', '毛衣', '针织',
  '风衣', '大衣', '斗篷', '领带', '领结', '蝴蝶结', '长靴', '短靴', '马丁靴', '高跟鞋', '凉鞋', '裸足', '玉足',
  '手套', '贝雷帽', '棒球帽', '面具', '面纱', '头纱', '围巾', '丝巾', '裤袜', '连裤袜', '吊带袜', '长袜', '中筒袜',
  '短袜', '船袜', '分趾袜',
])

const CLOTHES_EN = new Set(['ol', 'jk', 'lolita', 'latex', 'cosplay', 't'])

const STOP = new Set([
  'model', 'models', 'original', 'premade', 'custom', 'latepost', 'goddess', 'goddes', 'feed', 'photo', 'photos',
  'pic', 'pics', 'set', 'sets', 'collection', 'vol', 'vols', 'part', 'full', 'hd', 'uhd', '4k', 'uncensored',
  'censored', 'preview', 'gallery', 'album', 'video', 'videos', 'update', 'new', 'exclusive', 'bts', 'cover', 'cos',
  'irl', 'ootd', '写真', '画像', '照片', '图片', '图集', '图包', '套图', '合集', '系列', '预览', '无码', '有码',
  '拍摄', '作品', '福利', '日常', '生活', '杂图', '美女', '壁纸', '自拍', '定制', '紧急企划', '无水印', '福利姬',
  '模特', 'sexy', 'random', 'my', 'the', 'girl', 'asian', 'chinese', 'tits', 'feb', 'prompt', 'deleted',
  'test shoots', 'may', 'various', 'onlyfans', 'amateur', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug',
  'sep', 'oct', 'nov', 'dec', 'photobook', 'pure', 'media', 'expensive', 'delicious', 'naked', 'overseas', 'last',
  'stop', 'love', 'style', 'cute', 'pretty', 'beauty', 'beautiful', 'photoshoot', 'digital', 'series', 'official',
  'hardcore', 'softcore', 'photography',
  '섹시', '사진', '모음', '화보', '디지털', '하이퀄리티', '홈트레이닝', '빨래', '샤워', '수영', '차원', '눈빛',
  '처음', '어젯밤', '서울', '밤', '매혹', '여자', '남자', '사진집', '디지털화보',
])

/** 非中文标签 → 中文注释 */
const NOTE: Record<string, string> = {
  'tokyo hot': '东京热', jav: '日式成人', pornbox: '成人平台', spermmania: '成人品牌', 'pacific girls': '太平洋女孩',
  blacksonblondes: '品牌', fellatiojapan: '品牌', ugirls: '成人平台', dpdiva: '品牌', 'miko酱': '品牌',
  'little red': '品牌', popdaily: '品牌',
  ol: '职业装', jk: '校服', lolita: '洛丽塔', latex: '胶衣', cosplay: '角色扮演', t: 'T恤',
  'petra verkaik': '佩特拉·韦尔凯克', bambi: '斑比', 'jinny rux land': '金妮·鲁克斯', 'wang yu chun': '王雨纯',
  'erica campbell': '艾丽卡·坎贝尔', 'xia mei jiang': '夏美酱', 'jenny suen': '珍妮·苏恩', 'stracy stone': '史黛西·斯通',
  'masked queen': '蒙面女王', hijaber: '希贾伯', kokuhui: '国辉', sira: '西拉', cherry: '樱桃', maya: '玛雅',
  anna: '安娜', mia: '米娅', rose: '玫瑰', luna: '露娜', zoe: '佐伊', alice: '爱丽丝', sarah: '莎拉',
  laura: '劳拉', fiona: '菲奥娜', maria: '玛丽亚', isabella: '伊莎贝拉', eva: '伊娃', mina: '米娜',
  angela: '安吉拉', jenny: '珍妮', tina: '蒂娜', chloe: '克洛伊', bella: '贝拉', samantha: '萨曼莎',
  sofia: '索菲亚', karen: '凯伦', nina: '妮娜', mary: '玛丽', yuna: '由奈', sara: '莎拉', yuria: '尤里亚',
  'huang le ran': '黄楽然', 'li ke ke': '李可可', 'gloria sol': '格洛丽亚', july: '七月', apr: '四月',
  'けんけん': '健健', 'けん研': '健研', 'レム': '蕾姆', 'rissa may': '丽莎·梅', 'lexi lore': '莱克西·洛尔',
  'emily willis': '艾米丽·威利斯',
  '예하': '艺夏', '정미': '贞美', '보라': '宝拉', '손예은': '孙艺恩', '민하린': '闵夏琳', '박아람': '朴雅岚',
  '지영': '智英', '연우': '妍雨', '강인경': '姜仁京', '이하': '李夏', '아람': '雅岚',
}

/** 拼音 → 中文（合并重复标签） */
const PINYIN_MERGE: Record<string, string> = {
  'wang yu chun': '王雨纯', 'xia mei jiang': '夏美酱', 'huang le ran': '黄楽然', 'li ke ke': '李可可',
}

/** 非中文标签注释 */
export function noteFor(t: string): string {
  return NOTE[t] ?? (t.startsWith('@') ? '引用用户' : /[a-z]/i.test(t) ? '英文名' : /[\uac00-\ud7af]/.test(t) ? '韩语名' : '日文名')
}

// ---------- 提取 ----------

function cleanEmoji(s: string): string {
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}\u{2B06}\u{2B07}\u{25B6}\u{25C0}]/gu, ' ')
}

/** 整段标签提取（演员名/品牌/主题/英文名） */
function extractTags(raw: string): { t: string; c: TagCategory }[] {
  let s = cleanEmoji(raw).replace(/&amp;/g, '&')
  const tags: { t: string; c: TagCategory }[] = []
  s = s.replace(/@([a-zA-Z0-9_]+)/g, (_m, u: string) => { tags.push({ t: '@' + u, c: 'at' }); return ' ' })
  for (const b of BRANDS) {
    if (s.toLowerCase().startsWith(b.toLowerCase())) { tags.push({ t: b.toLowerCase(), c: 'brand' }); s = s.slice(b.length); break }
  }
  s = s.replace(/E\d{2,4}/gi, ' ').replace(/-\d{2,4}/g, ' ').replace(/\d+/g, ' ')
  for (const b of BRANDS) s = s.replace(new RegExp(b, 'ig'), ' ')
  for (const part of s.split(/[,&;()]|[(（)]/).map((p) => p.trim()).filter(Boolean)) {
    // 谚文段 → 韩语名
    for (const m of part.match(/[\uac00-\ud7af]{2,}/g) ?? []) {
      if (!STOP.has(m)) tags.push({ t: m, c: 'korean' })
    }
    // 汉字+假名连续段 → 中文/日文演员名 或 主题
    const jap = part.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g)
    if (jap) for (const j of jap) if (j.length >= 2 && !STOP.has(j)) tags.push({ t: j, c: THEMES.has(j) ? 'theme' : 'japanese' })
    // 英文 Capitalized 词序列
    const en = part.split(/[\s\-]+/).filter((w) => /^[A-Z][a-z']{1,}$/.test(w) && !STOP.has(w.toLowerCase()))
    if (en.length >= 1) {
      const name = en.join(' ').toLowerCase()
      if (name.length >= 2 && name.length <= 40) {
        tags.push({ t: name, c: THEMES.has(en.length === 1 ? en[0].toLowerCase() : '') ? 'theme' : 'english' })
      }
    }
  }
  return tags
}

/** 服装词：原始相册名上 中文包含 + 英文独立词匹配 */
function extractClothes(raw: string): { t: string; c: TagCategory }[] {
  const lower = raw.toLowerCase()
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean))
  const hit = new Set<string>()
  for (const c of CLOTHES_CN) if (raw.includes(c)) hit.add(c)
  for (const c of CLOTHES_EN) if (tokens.has(c)) hit.add(c)
  return [...hit].map((c) => ({ t: c, c: 'clothes' as TagCategory }))
}

/** 统计标签：遍历已确认用户的相册名 → 提取 → 过滤 → 排序 Top N */
export function computeTags(entries: ProducerEntry[], topN = TAG_DEFAULT_TOP): TagStat[] {
  const total = new Map<string, number>()
  const users = new Map<string, Set<string>>()
  const catOf = new Map<string, TagCategory>()

  for (const e of entries) {
    if (!e.albums) continue
    for (const a of e.albums) {
      const tags = [...extractTags(a.name), ...extractClothes(a.name)]
      for (const { t, c } of tags) {
        total.set(t, (total.get(t) ?? 0) + 1)
        if (!users.has(t)) users.set(t, new Set())
        users.get(t)!.add(e.username)
        if (!catOf.has(t)) catOf.set(t, c)
      }
    }
  }

  // 过滤 + 拼音合并
  const merged = new Map<string, { t: string; c: TagCategory; albums: number; users: number }>()
  for (const [t, c] of catOf) {
    const albums = total.get(t) ?? 0
    const uc = users.get(t)?.size ?? 0
    if (albums < TAG_MIN_ALBUMS || uc < TAG_MIN_USERS) continue
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
  return [...merged.values()].sort((a, b) => b.albums - a.albums).slice(0, Math.max(0, topN))
}
