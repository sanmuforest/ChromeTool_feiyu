// FP-006 标签云预研脚本 v2（主题词分类版）
// 分类：japanese 演员名 / theme 主题词 / english 英文名 / brand 品牌 / at 引用
const fs = require('fs')

const db = JSON.parse(fs.readFileSync('数据表/imgbb-producers.json', 'utf-8'))
const entries = Object.values(db.entries || {}).filter((e) => Array.isArray(e.albums) && e.albums.length > 0)
const records = []
for (const e of entries) for (const a of e.albums) records.push({ user: e.username, name: a.name })

const BRANDS = ['tokyo hot', 'pornbox', 'jav', 'spermmania', 'pacific girls', 'pacificgirls', 'blacksonblondes', 'fellatiojapan', 'dpdiva', '秀人网', 'ugirls', 'miko酱', 'little red', 'popdaily']
// 主题词词典（精简版：服装/题材/角色——与演员名区分）
const THEMES = new Set([
  '黑丝', '白丝', '丝袜', '制服', '体操服', '泳装', '比基尼', '汉服', '婚纱', '旗袍', 'jk', 'ol',
  '蕾姆', '拉姆', '原神', '碧蓝航线', '雷电将军', '胡桃', '甘雨', '初音', '明日方舟', 'fgo', '赛马娘', '舰娘', 'fate',
  '萝莉', '御姐', '兔女郎', '女仆', '护士', '老师', '学生', '温泉', '浴衣', '居家', '健身', '运动',
  'cosplay', 'lolita', '洛丽塔', '猫耳', '兔耳', '圣诞', '新年', '生日', '情侣', '闺蜜', '双人', '姐妹',
  '紧身', '透视', '短裙', '吊带', '蕾丝', '薄纱', '婚纱', '西装', '衬衫', '牛仔', '皮裤',
  '海边', '沙滩', '泳池', '酒店', '教室', '办公室', '天台', '夜景', '雨天', '雪地',
  '杂图', '美女', '图集', '套图',
])
const STOP = new Set([
  'model', 'models', 'original', 'premade', 'custom', 'latepost', 'goddess', 'goddes', 'feed', 'photo', 'photos', 'pic', 'pics', 'set', 'sets', 'collection', 'vol', 'vols', 'part', 'full', 'hd', 'uhd', '4k', 'uncensored', 'censored', 'preview', 'gallery', 'album', 'video', 'videos', 'update', 'new', 'exclusive', 'bts', 'cover', 'cos', 'irl', 'ootd',
  '写真', '画像', '照片', '图片', '图集', '图包', '套图', '合集', '系列', '预览', '无码', '有码', '拍摄', '作品', '福利', '日常', '生活',
])

function cleanEmoji(s) {
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}\u{2B06}\u{2B07}\u{25B6}\u{25C0}]/gu, ' ')
}

// 标签提取：返回 { t, c }[]
function extractTags(raw) {
  let s = cleanEmoji(raw).replace(/&amp;/g, '&')
  const tags = []
  s = s.replace(/@([a-zA-Z0-9_]+)/g, (m, u) => { tags.push({ t: '@' + u, c: 'at' }); return ' ' })
  for (const b of BRANDS) if (s.toLowerCase().startsWith(b.toLowerCase())) { tags.push({ t: b.toLowerCase(), c: 'brand' }); s = s.slice(b.length); break }
  s = s.replace(/E\d{2,4}/gi, ' ').replace(/-\d{2,4}/g, ' ').replace(/\d+/g, ' ')
  for (const b of BRANDS) s = s.replace(new RegExp(b, 'ig'), ' ')
  const parts = s.split(/[,&;()]|\(|\)/).map((p) => p.trim()).filter(Boolean)
  for (const part of parts) {
    const japSegs = part.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g)
    if (japSegs) {
      for (const j of japSegs) {
        if (j.length < 2) continue
        // 整段命中主题词典 → theme；否则演员名
        tags.push({ t: j, c: THEMES.has(j) ? 'theme' : 'japanese' })
      }
    }
    const enWords = part.split(/[\s\-]+/).filter((w) => /^[A-Z][a-z']{1,}$/.test(w) && !STOP.has(w.toLowerCase()))
    if (enWords.length >= 1) {
      const name = enWords.join(' ').toLowerCase()
      const single = enWords.length === 1 ? enWords[0].toLowerCase() : ''
      if (name.length >= 2 && name.length <= 40) {
        tags.push({ t: name, c: THEMES.has(single) ? 'theme' : 'english' })
      }
    }
  }
  return tags
}

// 统计：total=相册数, users=覆盖用户数
const total = new Map()
const users = new Map()
const catOf = new Map()
let extracted = 0
for (const r of records) {
  const tags = extractTags(r.name)
  if (tags.length) extracted++
  for (const { t, c } of tags) {
    total.set(t, (total.get(t) || 0) + 1)
    if (!users.has(t)) users.set(t, new Set())
    users.get(t).add(r.user)
    if (!catOf.has(t)) catOf.set(t, c)
  }
}

const fmt = (n) => String(n).padStart(5)
const output = (title, list) => {
  console.log('\n=== ' + title + ' ===')
  for (const { t, c, total: tc, users: uc } of list) console.log(`${fmt(tc)} 相册 ${fmt(uc)} 用户 [${c}] ${t}`)
}

// 方案 A：纯频次（被铁粉灌水参考）
const byTotal = [...total.entries()]
  .filter(([t]) => total.get(t) >= 3)
  .map(([t]) => ({ t, c: catOf.get(t), total: total.get(t), users: users.get(t).size }))
  .sort((a, b) => b.total - a.total)
  .slice(0, 25)
output('方案 A：按相册频次 Top 25（阈值≥3，看铁粉灌水）', byTotal)

// 方案 B：覆盖用户数（真热度）
const byUsers = [...total.entries()]
  .filter(([t]) => users.get(t).size >= 2)
  .map(([t]) => ({ t, c: catOf.get(t), total: total.get(t), users: users.get(t).size }))
  .sort((a, b) => b.users - a.users)
  .slice(0, 25)
output('方案 B：按覆盖用户数 Top 25（阈值≥2人）', byUsers)

// 方案 C：分类分组（japanese 演员 / theme 主题 / english / brand / at）
for (const cat of ['japanese', 'theme', 'english', 'brand', 'at']) {
  const list = [...total.entries()]
    .filter(([t]) => catOf.get(t) === cat)
    .map(([t]) => ({ t, c: cat, total: total.get(t), users: users.get(t).size }))
    .sort((a, b) => b.users - a.users)
    .slice(0, 15)
  output(`分类「${cat}」按覆盖用户 Top 15`, list)
}

console.log(`\n相册总数: ${records.length}，成功提取: ${extracted} (${(extracted / records.length * 100).toFixed(1)}%)，标签种类: ${total.size}`)
