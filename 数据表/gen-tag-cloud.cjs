// 生成标签云预览页 v2（FP-006 预研展示）
// 分类：japanese 演员 / theme 主题 / clothes 服装 / brand 品牌 / english 英文 / at 引用
// 服装词：中文包含匹配 + 英文独立词匹配（在原始相册名上做，防字母误匹配）
const fs = require('fs')

const db = JSON.parse(fs.readFileSync('数据表/imgbb-producers.json', 'utf-8'))
const entries = Object.values(db.entries || {}).filter((e) => Array.isArray(e.albums) && e.albums.length > 0)
const records = []
for (const e of entries) for (const a of e.albums) records.push({ user: e.username, name: a.name })

const BRANDS = ['tokyo hot', 'pornbox', 'jav', 'spermmania', 'pacific girls', 'pacificgirls', 'blacksonblondes', 'fellatiojapan', 'dpdiva', '秀人网', 'ugirls', 'miko酱', 'little red', 'popdaily']
// 主题词（非服装类，整段命中）
const THEMES = new Set(['蕾姆', '拉姆', '原神', '碧蓝航线', '雷电将军', '胡桃', '甘雨', '初音', '明日方舟', 'fgo', '赛马娘', '舰娘', 'fate', '萝莉', '御姐', '温泉', '浴衣', '居家', '健身', '运动', '圣诞', '新年', '生日', '情侣', '闺蜜', '双人', '姐妹', '海边', '沙滩', '泳池', '酒店', '教室', '办公室', '天台', '夜景', '雨天', '雪地'])
// 服装词（中文包含 + 英文独立词）
const CLOTHES_CN = new Set(['黑丝', '白丝', '丝袜', '渔网袜', '过膝袜', '袜', '制服', '体操服', '水手服', '校服', '泳装', '比基尼', '死库水', '汉服', '旗袍', '婚纱', '兔女郎', '女仆', '护士装', '护士', '猫耳', '兔耳', '古装', '和服', '浴衣', '肚兜', '睡衣', '内衣', '蕾丝', '透明', '薄纱', '纱裙', '吊带', '紧身衣', '紧身', '连体', '胶衣', '皮衣', '皮裤', '皮裙', '渔网', '短裤', '热裤', '长裙', '短裙', '迷你裙', '百褶裙', '包臀裙', '衬衫', '白衬衫', '卫衣', '毛衣', '针织', '风衣', '大衣', '斗篷', '领带', '领结', '蝴蝶结', '长靴', '短靴', '马丁靴', '高跟鞋', '凉鞋', '裸足', '玉足', '手套', '贝雷帽', '棒球帽', '面具', '面纱', '头纱', '围巾', '丝巾', '裤袜', '连裤袜', '吊带袜', '长袜', '中筒袜', '短袜', '船袜', '分趾袜'])
const CLOTHES_EN = new Set(['ol', 'jk', 'lolita', 'latex', 'cosplay', 't'])
const STOP = new Set(['model', 'models', 'original', 'premade', 'custom', 'latepost', 'goddess', 'goddes', 'feed', 'photo', 'photos', 'pic', 'pics', 'set', 'sets', 'collection', 'vol', 'vols', 'part', 'full', 'hd', 'uhd', '4k', 'uncensored', 'censored', 'preview', 'gallery', 'album', 'video', 'videos', 'update', 'new', 'exclusive', 'bts', 'cover', 'cos', 'irl', 'ootd', '写真', '画像', '照片', '图片', '图集', '图包', '套图', '合集', '系列', '预览', '无码', '有码', '拍摄', '作品', '福利', '日常', '生活', '杂图', '美女', '壁纸', '自拍', '定制', '紧急企划', '无水印', '福利姬', '模特', 'sexy', 'random', 'my', 'the', 'girl', 'asian', 'chinese', 'tits', 'feb', 'prompt', 'deleted', 'test shoots', 'may', 'various', 'onlyfans', 'amateur', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'photobook', 'pure', 'media', 'expensive', 'delicious', 'naked', 'overseas', 'last', 'stop', 'love', 'style', 'cute', 'pretty', 'beauty', 'beautiful', 'photoshoot', 'digital', 'series', 'official', 'hardcore', 'softcore', 'photography', '섹시', '사진', '모음', '화보', '디지털', '하이퀄리티', '홈트레이닝', '빨래', '샤워', '수영', '차원', '눈빛', '처음', '어젯밤', '서울', '밤', '매혹', '여자', '남자', '사진집'])

const NOTE = {
  'tokyo hot': '东京热', 'jav': '日式成人', 'pornbox': '成人平台', 'spermmania': '成人品牌', 'pacific girls': '太平洋女孩', 'blacksonblondes': '品牌', 'fellatiojapan': '品牌', 'ugirls': '成人平台', 'dpdiva': '品牌', 'miko酱': '品牌', 'little red': '品牌', 'popdaily': '品牌',
  'ol': '职业装', 'jk': '校服', 'lolita': '洛丽塔', 'latex': '胶衣', 'cosplay': '角色扮演', 't': 'T恤',
  'petra verkaik': '佩特拉·韦尔凯克', 'bambi': '斑比', 'jinny rux land': '金妮·鲁克斯', 'wang yu chun': '王雨纯', 'erica campbell': '艾丽卡·坎贝尔', 'xia mei jiang': '夏美酱', 'jenny suen': '珍妮·苏恩', 'stracy stone': '史黛西·斯通', 'masked queen': '蒙面女王', 'hijaber': '希贾伯', 'kokuhui': '国辉', 'sira': '西拉', 'cherry': '樱桃', 'maya': '玛雅', 'anna': '安娜', 'mia': '米娅', 'rose': '玫瑰', 'luna': '露娜', 'zoe': '佐伊', 'alice': '爱丽丝', 'sarah': '莎拉', 'laura': '劳拉', 'fiona': '菲奥娜', 'maria': '玛丽亚', 'isabella': '伊莎贝拉', 'eva': '伊娃', 'mina': '米娜', 'angela': '安吉拉', 'jenny': '珍妮', 'tina': '蒂娜', 'chloe': '克洛伊', 'bella': '贝拉', 'samantha': '萨曼莎', 'sofia': '索菲亚', 'karen': '凯伦', 'nina': '妮娜', 'mary': '玛丽', 'yuna': '由奈', 'sara': '莎拉', 'yuria': '尤里亚', 'huang le ran': '黄楽然', 'li ke ke': '李可可', 'gloria sol': '格洛丽亚', 'july': '七月', 'apr': '四月',
  'けんけん': '健健', 'けん研': '健研', 'レム': '蕾姆', 'rissa may': '丽莎·梅', 'lexi lore': '莱克西·洛尔', 'emily willis': '艾米丽·威利斯',
  '예하': '艺夏', '정미': '贞美', '보라': '宝拉', '손예은': '孙艺恩', '민하린': '闵夏琳', '박아람': '朴雅岚', '지영': '智英', '연우': '妍雨', '강인경': '姜仁京', '이하': '李夏', '아람': '雅岚',
}
const note = (t) => NOTE[t] || (t.startsWith('@') ? '引用用户' : (/[a-z]/i.test(t) ? '英文名' : '日文名'))

function cleanEmoji(s) { return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}\u{2B06}\u{2B07}\u{25B6}\u{25C0}]/gu, ' ') }

// 整段标签提取（演员名/品牌/主题/英文名）
function extractTags(raw) {
  let s = cleanEmoji(raw).replace(/&amp;/g, '&'); const tags = []
  s = s.replace(/@([a-zA-Z0-9_]+)/g, (m, u) => { tags.push({ t: '@' + u, c: 'at' }); return ' ' })
  for (const b of BRANDS) if (s.toLowerCase().startsWith(b.toLowerCase())) { tags.push({ t: b.toLowerCase(), c: 'brand' }); s = s.slice(b.length); break }
  s = s.replace(/E\d{2,4}/gi, ' ').replace(/-\d{2,4}/g, ' ').replace(/\d+/g, ' ')
  for (const b of BRANDS) s = s.replace(new RegExp(b, 'ig'), ' ')
  for (const part of s.split(/[,&;()]|[(（)]/).map((p) => p.trim()).filter(Boolean)) {
    // 谚文段 → 韩语名
    for (const m of part.match(/[\uac00-\ud7af]{2,}/g) || []) if (!STOP.has(m)) tags.push({ t: m, c: 'korean' })
    const jap = part.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g)
    if (jap) for (const j of jap) if (j.length >= 2 && !STOP.has(j)) tags.push({ t: j, c: THEMES.has(j) ? 'theme' : 'japanese' })
    const en = part.split(/[\s\-]+/).filter((w) => /^[A-Z][a-z']{1,}$/.test(w) && !STOP.has(w.toLowerCase()))
    if (en.length >= 1) { const name = en.join(' ').toLowerCase(); if (name.length >= 2 && name.length <= 40) tags.push({ t: name, c: THEMES.has(en.length === 1 ? en[0].toLowerCase() : '') ? 'theme' : 'english' }) }
  }
  return tags
}

// 服装词：原始相册名上 中文包含 + 英文独立词
function extractClothes(raw) {
  const lower = raw.toLowerCase()
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean))
  const hit = new Set()
  for (const c of CLOTHES_CN) if (raw.includes(c)) hit.add(c)
  for (const c of CLOTHES_EN) if (tokens.has(c)) hit.add(c)
  return [...hit].map((c) => ({ t: c, c: 'clothes' }))
}

const total = new Map(), users = new Map(), catOf = new Map()
for (const r of records) {
  const tags = [...extractTags(r.name), ...extractClothes(r.name)]
  for (const { t, c } of tags) {
    total.set(t, (total.get(t) || 0) + 1)
    if (!users.has(t)) users.set(t, new Set())
    users.get(t).add(r.user)
    if (!catOf.has(t)) catOf.set(t, c)
  }
}

const pinyinMerge = { 'wang yu chun': '王雨纯', 'xia mei jiang': '夏美酱', 'huang le ran': '黄楽然', 'li ke ke': '李可可' }
const rawList = [...total.entries()]
  .map(([t]) => ({ t, c: catOf.get(t), albums: total.get(t), users: users.get(t).size }))
  .filter((x) => x.albums >= 10 && x.users >= 2)
const dedup = new Map()
for (const x of rawList) {
  const cn = pinyinMerge[x.t]
  const k = cn && dedup.has(cn) ? cn : x.t
  const prev = dedup.get(k)
  if (prev) { prev.albums += x.albums; prev.users = Math.max(prev.users, x.users) } else dedup.set(k, { ...x, t: k })
}
const finalList = [...dedup.values()].sort((a, b) => b.albums - a.albums).slice(0, 100)

const CAT_COLOR = { japanese: '#4a9eff', korean: '#c792ea', theme: '#7bc47f', clothes: '#e07ab5', brand: '#e8a03a', english: '#9aa5b1', at: '#5ac8d8' }
const CAT_LABEL = { japanese: '演员', korean: '韩语', theme: '主题', clothes: '服装', brand: '品牌', english: '英文', at: '引用' }
const maxAlbums = finalList[0]?.albums ?? 1
const items = finalList.map((x) => {
  const isCjk = /[\u4e00-\u9fff\u3040-\u30ff]/.test(x.t)
  const label = isCjk ? x.t : `${x.t}（${note(x.t)}）`
  const size = 13 + Math.round((x.albums / maxAlbums) * 26)
  return `<span class="tag" style="font-size:${size}px;color:${CAT_COLOR[x.c] || '#999'}" title="${x.t} · ${x.albums}相册 · ${x.users}人">${label}</span>`
}).join('\n      ')
const catStats = {}
for (const x of finalList) catStats[x.c] = (catStats[x.c] || 0) + 1

const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>imgbb 标签云预览 v2（FP-006 预研）</title>
<style>
  body { background: #101216; color: #ddd; font-family: "Microsoft YaHei", sans-serif; padding: 24px; }
  h1 { font-size: 18px; color: #e8c06a; }
  .meta { color: #888; font-size: 12px; margin-bottom: 16px; }
  .legend span { margin-right: 14px; font-size: 12px; }
  .cloud { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; justify-content: center; max-width: 1000px; margin: 20px auto; padding: 24px; background: #17191d; border: 1px solid #2a2e33; border-radius: 10px; }
  .tag { cursor: default; transition: transform .1s; line-height: 1.5; }
  .tag:hover { transform: scale(1.12); text-shadow: 0 0 8px currentColor; }
  .list { max-width: 1000px; margin: 20px auto; }
  .list table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .list th, .list td { border: 1px solid #2a2e33; padding: 3px 8px; text-align: left; }
  .list th { background: #24292e; color: #e8c06a; }
</style>
</head>
<body>
  <h1>imgbb 标签云预览 v2（含服装分类）</h1>
  <div class="meta">数据：${records.length} 个相册 · 过滤：相册数≥10 且 用户≥2 · 排序：相册数 · Top 100 · 服装词=中文包含/英文独立词匹配</div>
  <div class="legend">
    <span style="color:#4a9eff">■ 演员 ${catStats.japanese || 0}</span>
    <span style="color:#7bc47f">■ 主题 ${catStats.theme || 0}</span>
    <span style="color:#e07ab5">■ 服装 ${catStats.clothes || 0}</span>
    <span style="color:#e8a03a">■ 品牌 ${catStats.brand || 0}</span>
    <span style="color:#9aa5b1">■ 英文 ${catStats.english || 0}</span>
    <span style="color:#c792ea">■ 韩语 ${catStats.korean || 0}</span>
    <span style="color:#5ac8d8">■ 引用 ${catStats.at || 0}</span>
  </div>
  <div class="cloud">
      ${items}
  </div>
  <div class="list">
    <table>
      <tr><th>#</th><th>标签</th><th>分类</th><th>相册</th><th>用户</th></tr>
      ${finalList.map((x, i) => {
        const isCjk = /[\u4e00-\u9fff\u3040-\u30ff]/.test(x.t)
        const label = isCjk ? x.t : `${x.t}（${note(x.t)}）`
        return `<tr><td>${i + 1}</td><td>${label}</td><td>${CAT_LABEL[x.c]}</td><td>${x.albums}</td><td>${x.users}</td></tr>`
      }).join('')}
    </table>
  </div>
</body>
</html>`
fs.writeFileSync('数据表/tag-cloud-preview.html', html)
console.log('已生成 数据表/tag-cloud-preview.html（Top', finalList.length, '标签，含服装分类）')
console.log('分类构成:', JSON.stringify(catStats))
