// 标签词典（FP-016）：四语分类词条 + 同义归并（纯数据，无副作用）
//
// 设计：
// - 每条 = 标准名 t（统计/展示/检索统一用它）+ 分类 c + 同义词 syn（中/英/日/韩）
// - 匹配：对相册名做「中文/日文/韩文包含匹配」与「英文词边界匹配」，命中后一律归并到标准名计数
// - 同义归并解决 FP-006 的结构性问题：黑丝/白丝/pantyhose 各自计数谁都到不了阈值 → 合并为「丝袜」
// - 一次相册名内同一标准名只计一次（在 tag-extract 用 Set 去重）
//
// 分类（14 类）：
//   ip 作品角色 / theme 主题 / scene 场景 / clothes 服装 / fetish 恋物 / act 行为玩法 /
//   prop 道具 / body 身材特征 / relation 关系人数 / japanese 演员 / korean 韩语 /
//   brand 品牌 / english 英文 / at 引用

export type TagCategory =
  | 'ip'
  | 'theme'
  | 'scene'
  | 'clothes'
  | 'fetish'
  | 'act'
  | 'prop'
  | 'body'
  | 'relation'
  | 'japanese'
  | 'korean'
  | 'brand'
  | 'english'
  | 'at'

export interface DictEntry {
  /** 标准名（归并后的统计与展示名） */
  t: string
  c: TagCategory
  /** 同义词（英文一律小写；中文/日文/韩文照写） */
  syn: string[]
}

/** 分类中文标签（UI 图例与分组标题用） */
export const TAG_CATEGORY_LABEL: Record<TagCategory, string> = {
  ip: '作品角色',
  theme: '主题',
  scene: '场景',
  clothes: '服装',
  fetish: '恋物',
  act: '行为玩法',
  prop: '道具',
  body: '身材特征',
  relation: '关系人数',
  japanese: '演员',
  korean: '韩语',
  brand: '品牌',
  english: '英文',
  at: '引用',
}

/** 分类展示顺序（分组卡片按此排列） */
export const TAG_CATEGORY_ORDER: TagCategory[] = [
  'japanese', 'korean', 'ip', 'theme', 'scene', 'clothes', 'fetish', 'act', 'prop', 'body',
  'relation', 'brand', 'english', 'at',
]

/**
 * 主词典（服装 / 恋物 / 行为 / 道具 / 身材 / 关系 / 场景 / 主题 / 作品角色）
 * 说明：成人向分类（fetish / act / body / relation）为检索服务，词条仅作匹配关键字使用
 */
export const TAG_DICT: DictEntry[] = [
  // ---------- 服装 clothes ----------
  { t: '丝袜', c: 'clothes', syn: ['黑丝', '白丝', '网袜', '渔网袜', '连裤袜', '裤袜', '吊带袜', '长袜', 'stockings', 'pantyhose', 'tights', 'pantyhose', '網タイツ', 'ストッキング'] },
  { t: '内衣', c: 'clothes', syn: ['文胸', '胸罩', '内裤', 'underwear', 'lingerie', 'bra', 'panties', 'knickers', '下着', 'ランジェリー', '브라'] },
  { t: '蕾丝', c: 'clothes', syn: ['lace', 'レース', '레이스'] },
  { t: '泳装', c: 'clothes', syn: ['泳衣', '比基尼', '死库水', '水着', 'swimsuit', 'bikini', 'swimwear', 'one-piece swimsuit', 'スク水', '비키니'] },
  { t: '制服', c: 'clothes', syn: ['校服', '水手服', 'uniform', 'school uniform', 'sailor uniform', 'seifuku', '制服', 'セーラー服', '교복'] },
  { t: 'OL装', c: 'clothes', syn: ['ol', 'office lady', '职业装', 'ol制服', '包臀裙', '铅笔裙', 'pencil skirt'] },
  { t: '护士装', c: 'clothes', syn: ['护士', 'nurse', 'nurse outfit', 'ナース', '간호사'] },
  { t: '女仆装', c: 'clothes', syn: ['女仆', 'maid', 'maid outfit', 'メイド', '메이드'] },
  { t: '兔女郎', c: 'clothes', syn: ['bunny', 'bunny girl', 'playboy bunny', 'バニーガール'] },
  { t: '旗袍', c: 'clothes', syn: ['qipao', 'cheongsam', 'チャイナドレス', '치파오'] },
  { t: '和服', c: 'clothes', syn: ['浴衣', 'kimono', 'yukata', '着物', '浴衣'] },
  { t: '婚纱', c: 'clothes', syn: ['花嫁', 'wedding dress', 'bridal', 'ウェディングドレス', '웨딩드레스'] },
  { t: '睡衣', c: 'clothes', syn: ['睡衣裤', 'pajamas', 'pyjamas', 'nightwear', 'nightgown', 'パジャマ', '잠옷'] },
  { t: '紧身衣', c: 'clothes', syn: ['连体衣', 'bodysuit', 'leotard', 'body stocking', 'ボディスーツ'] },
  { t: '体操服', c: 'clothes', syn: ['体育服', 'gym uniform', 'gym suit', 'ブルマ', '체육복'] },
  { t: '皮衣', c: 'clothes', syn: ['皮裙', '皮裤', 'leather jacket', 'leather skirt', 'leather pants'] },
  { t: '短裙', c: 'clothes', syn: ['迷你裙', '百褶裙', 'miniskirt', 'pleated skirt', 'マイクロミニ'] },
  { t: '热裤', c: 'clothes', syn: ['短裤', '牛仔短裤', 'shorts', 'hot pants', 'denim shorts'] },
  { t: '长裙', c: 'clothes', syn: ['连衣裙', '裙子', 'dress', 'long skirt', 'ワンピース'] },
  { t: '高跟鞋', c: 'clothes', syn: ['高跟', '细跟', 'heels', 'high heels', 'stilettos', 'ハイヒール', '하이힐'] },
  { t: '长靴', c: 'clothes', syn: ['短靴', '过膝靴', '马丁靴', 'boots', 'knee boots', 'thigh boots', 'ブーツ'] },
  { t: '凉鞋', c: 'clothes', syn: ['sandals', 'サンダル'] },
  { t: '裸足', c: 'clothes', syn: ['玉足', '足裏', '美足', 'barefoot', 'bare feet', '足コキ', '素足', '맨발'] },
  { t: '手套', c: 'clothes', syn: ['gloves', '手袋', '장갑'] },
  { t: '帽子', c: 'clothes', syn: ['贝雷帽', '棒球帽', 'hat', 'cap', 'beret', '帽子', '모자'] },
  { t: '围巾', c: 'clothes', syn: ['丝巾', 'scarf', 'マフラー'] },
  { t: '毛衣', c: 'clothes', syn: ['针织衫', 'sweater', 'knitwear', 'cardigan', 'ニット'] },
  { t: '衬衫', c: 'clothes', syn: ['白衬衫', 'shirt', 'blouse', 'ワイシャツ', '셔츠'] },
  { t: '卫衣', c: 'clothes', syn: ['hoodie', 'sweatshirt', 'パーカー'] },
  { t: '风衣', c: 'clothes', syn: ['大衣', '外套', 'coat', 'trench coat', 'jacket', 'コート'] },
  { t: '斗篷', c: 'clothes', syn: ['披风', 'cloak', 'cape', 'マント'] },
  { t: '领带', c: 'clothes', syn: ['领结', '蝴蝶结', 'necktie', 'necktie', 'bow tie', 'ribbon tie', 'ネクタイ'] },
  { t: '吊带', c: 'clothes', syn: ['背心', 'camisole', 'tank top', 'キャミソール'] },
  { t: '汉服', c: 'clothes', syn: ['古装', 'hanfu', 'ancient costume', '中華服'] },
  { t: '运动装', c: 'clothes', syn: ['瑜伽裤', 'sportswear', 'yoga pants', 'leggings', 'track suit', 'スポーツウェア'] },
  { t: '牛仔裤', c: 'clothes', syn: ['牛仔', 'jeans', 'denim', 'ジーンズ'] },
  { t: '丁字裤', c: 'clothes', syn: ['thong', 'g-string', 'g string', 't-back', 'Tバック'] },
  { t: '连体袜', c: 'clothes', syn: ['bodystocking', 'body stocking', '全身タイツ'] },
  { t: '白大褂', c: 'clothes', syn: ['医生', 'lab coat', 'doctor', '白衣'] },
  { t: '空姐装', c: 'clothes', syn: ['空姐', 'flight attendant', 'cabin crew', 'ca uniform'] },
  { t: '警察装', c: 'clothes', syn: ['警官', '警察', 'police', 'police uniform', '警官服'] },
  { t: '军装', c: 'clothes', syn: ['军服', 'military uniform', 'army', 'army uniform', 'ミリタリー'] },
  { t: '修女服', c: 'clothes', syn: ['修女', 'nun', 'nun outfit', 'シスター'] },
  { t: '巫女服', c: 'clothes', syn: ['巫女', 'miko', 'shrine maiden', '巫女装束'] },
  { t: '短袜', c: 'clothes', syn: ['中筒袜', '船袜', '分趾袜', 'ankle socks', 'socks', 'ソックス', '양말'] },
  { t: '肚兜', c: 'clothes', syn: ['dudou', 'belly cover'] },
  { t: '头纱', c: 'clothes', syn: ['面纱', 'veil', 'head veil', 'ベール'] },
  { t: '束腰', c: 'clothes', syn: ['corset', 'waist cincher', 'コルセット'] },
  { t: '芭蕾舞裙', c: 'clothes', syn: ['芭蕾', 'ballet', 'tutu', 'バレエ'] },
  { t: '潜水服', c: 'clothes', syn: ['wetsuit', 'diving suit', 'ウェットスーツ'] },

  // ---------- 恋物 fetish ----------
  { t: '胶衣', c: 'fetish', syn: ['乳胶', '橡胶', 'latex', 'rubber', 'pvc', 'ラバー'] },
  { t: '束缚', c: 'fetish', syn: ['捆绑', '绳艺', '绳缚', '紧缚', 'bondage', 'kinbaku', 'shibari', 'rope bondage', '緊縛'] },
  { t: '项圈', c: 'fetish', syn: ['颈圈', 'choker', 'collar', 'チョーカー', '목걸이'] },
  { t: '口球', c: 'fetish', syn: ['口塞', '口枷', 'ball gag', 'gag', 'ボールギャグ'] },
  { t: '手铐', c: 'fetish', syn: ['镣铐', '手拷', 'handcuffs', 'cuffs', '手錠'] },
  { t: '眼罩', c: 'fetish', syn: ['blindfold', 'eye mask', 'アイマスク'] },
  { t: '皮鞭', c: 'fetish', syn: ['鞭子', 'whip', 'flogger', '鞭'] },
  { t: '锁链', c: 'fetish', syn: ['铁链', 'chain', 'chains', '鎖'] },
  { t: '透明装', c: 'fetish', syn: ['薄纱', '透视', 'transparent', 'see-through', 'sheer', 'シースルー'] },
  { t: '湿身', c: 'fetish', syn: ['wetlook', 'wet look', 'wet body', '濡れ', 'wet shirt'] },
  { t: '裸围裙', c: 'fetish', syn: ['naked apron', '裸エプロン'] },
  { t: '眼镜', c: 'fetish', syn: ['眼鏡', 'glasses', 'megane', 'メガネ', '안경'] },
  { t: '猫耳', c: 'fetish', syn: ['猫娘', '兔耳', '犬耳', 'cat ears', 'catgirl', 'bunny ears', 'nekomimi', '猫耳'] },
  { t: '尾巴', c: 'fetish', syn: ['tail', '尻尾', 'テール'] },
  { t: '翅膀', c: 'fetish', syn: ['wings', 'wing', '翼'] },
  { t: '精灵耳', c: 'fetish', syn: ['elf ears', 'elf', 'エルフ耳'] },
  { t: '纹身', c: 'fetish', syn: ['刺青', 'tattoo', 'tattoos', 'タトゥー', '문신'] },
  { t: '穿孔', c: 'fetish', syn: ['舌钉', '耳环', 'piercing', 'piercings', 'ピアス'] },
  { t: '丝带', c: 'fetish', syn: ['缎带', 'ribbon', 'ribbons', 'リボン'] },
  { t: '乳贴', c: 'fetish', syn: ['pasties', 'pasties', 'ニプレス'] },
  { t: '绷带', c: 'fetish', syn: ['包带', 'bandage', 'bandages', '包帯'] },
  { t: '蜡烛', c: 'fetish', syn: ['滴蜡', 'candle', 'wax play', '蠟燭'] },
  { t: '冰块', c: 'fetish', syn: ['ice', 'ice cubes', '氷'] },
  { t: '假发', c: 'fetish', syn: ['wig', 'wigs', 'ウィッグ'] },
  { t: '口罩', c: 'fetish', syn: ['面罩', 'mouth mask', 'face mask', 'マスク'] },
  { t: '宠物装', c: 'fetish', syn: ['宠物', 'pet play', 'puppy play', 'ケモナー'] },

  // ---------- 行为玩法 act ----------
  { t: '自拍', c: 'act', syn: ['selfie', 'self shot', '自拍照', '셀카'] },
  { t: '露出', c: 'act', syn: ['野外露出', '户外露出', 'exhibitionism', 'outdoor exposure', 'public nudity', '露出プレイ'] },
  { t: '沐浴', c: 'act', syn: ['淋浴', '洗澡', 'shower', 'シャワー', '샤워'] },
  { t: '泡澡', c: 'act', syn: ['浴缸', '入浴', 'bath', 'bathtub', 'お風呂', '욕조'] },
  { t: '按摩', c: 'act', syn: ['massage', 'oil massage', 'マッサージ', '마사지'] },
  { t: '瑜伽', c: 'act', syn: ['yoga', 'ヨガ', '요가'] },
  { t: '健身', c: 'act', syn: ['运动', 'workout', 'fitness', 'training', 'gym workout', '筋トレ'] },
  { t: '跳舞', c: 'act', syn: ['舞蹈', 'dance', 'dancing', 'ダンス', '댄스'] },
  { t: '睡姿', c: 'act', syn: ['睡颜', '睡眠', 'sleeping', 'sleep', '寝顔', '수면'] },
  { t: '伸展', c: 'act', syn: ['拉伸', 'stretching', 'stretch', 'ストレッチ'] },
  { t: '换衣', c: 'act', syn: ['换装', 'changing clothes', 'undressing', '着替え'] },
  { t: '更衣室', c: 'act', syn: ['locker room', 'changing room', '脱衣所'] },
  { t: '舔', c: 'act', syn: ['舔足', 'licking', 'lick', '舐め'] },
  { t: '亲吻', c: 'act', syn: ['接吻', '湿吻', 'kiss', 'kissing', 'deep kiss', 'キス'] },
  { t: '拥抱', c: 'act', syn: ['hug', 'hugging', 'embrace', 'ハグ'] },
  { t: '跪姿', c: 'act', syn: ['跪', 'kneeling', 'kneel', '土下座', 'ひざまずく'] },
  { t: '卧姿', c: 'act', syn: ['趴姿', 'lying', 'lying down', 'on all fours', '寝そべり'] },
  { t: '抚摸', c: 'act', syn: ['互摸', 'touching', 'caress', 'fondling', '愛撫'] },
  { t: '自慰', c: 'act', syn: ['masturbation', 'masturbating', 'オナニー', '자위'] },
  { t: '口交', c: 'act', syn: ['深喉', 'oral', 'fellatio', 'blowjob', 'deepthroat', 'フェラ', '구강'] },
  { t: '足交', c: 'act', syn: ['footjob', '足コキ'] },
  { t: '乳交', c: 'act', syn: ['paizuri', 'titjob', 'パイズリ'] },
  { t: '手交', c: 'act', syn: ['handjob', '手コキ'] },
  { t: '69式', c: 'act', syn: ['69', 'sixty nine', 'シックスナイン'] },
  { t: '性交', c: 'act', syn: ['做爱', 'sex', 'sexual intercourse', 'セックス', '섹스'] },
  { t: '后入', c: 'act', syn: ['doggystyle', 'doggy style', 'バック'] },
  { t: '骑乘', c: 'act', syn: ['cowgirl', 'riding', '騎乗位'] },
  { t: '群交', c: 'act', syn: ['乱交', 'orgy', 'gangbang', 'group sex', '乱交パーティ'] },
  { t: '百合', c: 'act', syn: ['lesbian', 'lesbians', 'girls love', 'レズ', '백합'] },
  { t: '调教', c: 'act', syn: ['bdsm', 'training', 'domination', 'sm', '調教'] },
  { t: '灌肠', c: 'act', syn: ['enema', '浣腸'] },
  { t: '排尿', c: 'act', syn: ['放尿', 'peeing', 'urination', 'おしっこ', '방뇨'] },
  { t: '颜射', c: 'act', syn: ['facial', 'cum on face', '顔射'] },
  { t: '中出', c: 'act', syn: ['creampie', 'internal cumshot', '中出し'] },
  { t: '避孕套', c: 'act', syn: ['condom', 'ゴム'] },
  { t: '裸体', c: 'act', syn: ['全裸', 'nude', 'naked', 'full nude', 'ヌード', '누드'] },
  { t: '半裸', c: 'act', syn: ['topless', 'half naked', '半裸', 'セミヌード'] },

  // ---------- 道具 prop ----------
  { t: '玩具', c: 'prop', syn: ['假阳具', 'toy', 'sex toy', 'dildo', 'おもちゃ'] },
  { t: '按摩棒', c: 'prop', syn: ['vibrator', 'wand', 'バイブ'] },
  { t: '跳蛋', c: 'prop', syn: ['egg vibrator', 'love egg', 'ローター'] },
  { t: '绳子', c: 'prop', syn: ['rope', 'ropes', '縄'] },
  { t: '镜子', c: 'prop', syn: ['mirror', '鏡', '거울'] },
  { t: '椅子', c: 'prop', syn: ['chair', 'stool', '椅子', 'チェア'] },
  { t: '沙发', c: 'prop', syn: ['sofa', 'couch', 'ソファ'] },
  { t: '床', c: 'prop', syn: ['bed', 'bedroom bed', 'ベッド', '침대'] },
  { t: '气球', c: 'prop', syn: ['balloon', 'balloons', '風船'] },
  { t: '花束', c: 'prop', syn: ['花', 'flower', 'flowers', 'bouquet', '花束'] },
  { t: '书本', c: 'prop', syn: ['book', 'books', '本'] },
  { t: '食物', c: 'prop', syn: ['food', 'snack', '料理', '음식'] },
  { t: '冰淇淋', c: 'prop', syn: ['ice cream', 'アイスクリーム'] },
  { t: '酒杯', c: 'prop', syn: ['酒', 'wine', 'cocktail', 'グラス'] },
  { t: '香烟', c: 'prop', syn: ['cigarette', 'smoking', 'タバコ', '담배'] },
  { t: '麦克风', c: 'prop', syn: ['microphone', 'mic', 'マイク'] },
  { t: '游戏手柄', c: 'prop', syn: ['game controller', 'controller', 'ゲームパッド'] },
  { t: '摄像机', c: 'prop', syn: ['camera', 'camcorder', 'カメラ'] },
  { t: '毛巾', c: 'prop', syn: ['浴巾', 'towel', 'タオル', '수건'] },
  { t: '枕头', c: 'prop', syn: ['pillow', '枕'] },

  // ---------- 身材特征 body ----------
  { t: '巨乳', c: 'body', syn: ['爆乳', '大胸', '丰满', 'big breasts', 'big boobs', 'large breasts', '巨乳', '거유'] },
  { t: '贫乳', c: 'body', syn: ['微乳', '平胸', 'small breasts', 'flat chest', '貧乳', '빈유'] },
  { t: '长腿', c: 'body', syn: ['美腿', '大长腿', 'long legs', 'legs', '美脚', '롱다리'] },
  { t: '翘臀', c: 'body', syn: ['美臀', '臀部', 'big ass', 'big butt', 'ass', 'お尻', '힙'] },
  { t: '细腰', c: 'body', syn: ['小蛮腰', 'slim waist', 'narrow waist', 'くびれ'] },
  { t: '腹肌', c: 'body', syn: ['马甲线', 'abs', 'six pack', '腹筋'] },
  { t: '短发', c: 'body', syn: ['short hair', 'ショートヘア', '단발'] },
  { t: '长发', c: 'body', syn: ['long hair', 'ロングヘア', '장발'] },
  { t: '双马尾', c: 'body', syn: ['twintails', 'twin tails', 'ツインテール'] },
  { t: '马尾', c: 'body', syn: ['ponytail', 'ポニーテール'] },
  { t: '丸子头', c: 'body', syn: ['团子头', 'bun hair', 'hair bun', 'お団子'] },
  { t: '卷发', c: 'body', syn: ['curly hair', 'wavy hair', 'パーマ'] },
  { t: '金发', c: 'body', syn: ['blonde', 'blond', 'golden hair', 'ブロンド', '금발'] },
  { t: '黑发', c: 'body', syn: ['brunette', 'black hair', '黒髪', '흑발'] },
  { t: '染发', c: 'body', syn: ['彩发', 'colored hair', 'dyed hair', 'カラー髪'] },
  { t: '雀斑', c: 'body', syn: ['freckles', 'そばかす'] },
  { t: '酒窝', c: 'body', syn: ['dimples', 'えくぼ'] },
  { t: '白皙', c: 'body', syn: ['白肌', '美白', 'pale skin', 'fair skin', '白肌', '백피부'] },
  { t: '小麦色', c: 'body', syn: ['日烧', 'tan', 'tanned', 'suntan', '日焼け'] },
  { t: '肌肉', c: 'body', syn: ['muscular', 'muscle', '筋肉'] },
  { t: '孕妇', c: 'body', syn: ['pregnant', 'pregnancy', '妊婦', '임산부'] },
  { t: '成熟', c: 'body', syn: ['熟女', 'mature', 'milf', 'mature woman', '熟女'] },
  { t: '娇小', c: 'body', syn: ['小只', 'petite', 'small body', 'ミニ'] },
  { t: '高个', c: 'body', syn: ['长身', 'tall', 'tall girl', '長身'] },
  { t: '清纯', c: 'body', syn: ['素颜', 'innocent', 'pure face', 'no makeup', 'すっぴん'] },
  { t: '泪痣', c: 'body', syn: ['美人痣', 'mole under eye', '泣きぼくろ'] },
  { t: '虎牙', c: 'body', syn: ['八重齿', 'fang tooth', 'yaeba', '八重歯'] },
  { t: '萝莉', c: 'body', syn: ['loli', 'lolita', 'ロリ', '로리'] },
  { t: '御姐', c: 'body', syn: ['onee-san', 'oneesan', 'お姉さん', '누나'] },

  // ---------- 关系人数 relation ----------
  { t: '双人', c: 'relation', syn: ['二人', 'two girls', 'pair', '2 girls', 'ペア'] },
  { t: '三人', c: 'relation', syn: ['3p', 'threesome', 'three girls', 'スリー'] },
  { t: '多人', c: 'relation', syn: ['群体', 'group', 'multiple girls', 'several girls', '集団'] },
  { t: '情侣', c: 'relation', syn: ['恋人', 'couple', 'couples', 'カップル', '커플'] },
  { t: '闺蜜', c: 'relation', syn: ['好友', 'besties', 'best friends', 'friends', '親友'] },
  { t: '姐妹', c: 'relation', syn: ['姉妹', 'sisters', 'sister', '姉妹'] },
  { t: '母女', c: 'relation', syn: ['親子', 'mother daughter', 'mom and daughter'] },
  { t: '师生', c: 'relation', syn: ['teacher student', 'teacher and student', '師弟'] },
  { t: '男女', c: 'relation', syn: ['hetero', 'male and female', 'couple man woman', '男女'] },
  { t: '单人', c: 'relation', syn: ['一人', 'solo', 'single girl', '1girl', 'ソロ'] },
  { t: '露脸', c: 'relation', syn: ['正脸', 'face visible', 'face shot', '顔出し'] },
  { t: '蒙面', c: 'relation', syn: ['masked', 'mask', 'face covered', '覆面'] },
  { t: '夫妻', c: 'relation', syn: ['husband wife', 'married couple', '夫婦'] },

  // ---------- 场景 scene ----------
  { t: '海边', c: 'scene', syn: ['沙滩', '海滩', 'beach', 'seaside', 'ビーチ', '해변'] },
  { t: '泳池', c: 'scene', syn: ['游泳池', 'pool', 'swimming pool', 'プール', '수영장'] },
  { t: '温泉', c: 'scene', syn: ['浴场', 'onsen', 'hot spring', '温泉', '온천'] },
  { t: '浴室', c: 'scene', syn: ['卫生间', 'bathroom', 'bath room', 'お風呂場', '욕실'] },
  { t: '卧室', c: 'scene', syn: ['寝室', 'bedroom', 'ベッドルーム', '침실'] },
  { t: '厨房', c: 'scene', syn: ['kitchen', 'キッチン', '주방'] },
  { t: '客厅', c: 'scene', syn: ['living room', 'lounge', 'リビング'] },
  { t: '教室', c: 'scene', syn: ['classroom', 'school room', '教室', '교실'] },
  { t: '办公室', c: 'scene', syn: ['office', 'オフィス', '사무실'] },
  { t: '图书馆', c: 'scene', syn: ['library', '図書館', '도서관'] },
  { t: '健身房', c: 'scene', syn: ['gym', '体育館', 'ジム', '헬스장'] },
  { t: '天台', c: 'scene', syn: ['屋顶', 'rooftop', 'roof', '屋上'] },
  { t: '楼梯', c: 'scene', syn: ['stairs', 'staircase', '階段'] },
  { t: '走廊', c: 'scene', syn: ['corridor', 'hallway', '廊下'] },
  { t: '阳台', c: 'scene', syn: ['balcony', 'ベランダ', '발코니'] },
  { t: '酒店', c: 'scene', syn: ['宾馆', 'hotel', 'motel', 'ホテル', '호텔'] },
  { t: '车内', c: 'scene', syn: ['车里', 'car', 'in car', 'car interior', '車内'] },
  { t: '地铁', c: 'scene', syn: ['电车', 'subway', 'train', '電車', '지하철'] },
  { t: '街头', c: 'scene', syn: ['街道', 'street', 'street shot', '路上', '거리'] },
  { t: '公园', c: 'scene', syn: ['park', '公園', '공원'] },
  { t: '森林', c: 'scene', syn: ['forest', 'woods', '森', '숲'] },
  { t: '雪地', c: 'scene', syn: ['雪景', 'snow', 'snowy', '雪', '설원'] },
  { t: '雨天', c: 'scene', syn: ['雨景', 'rain', 'rainy', '雨'] },
  { t: '夜景', c: 'scene', syn: ['夜晚', 'night', 'night view', '夜', '야경'] },
  { t: '日落', c: 'scene', syn: ['夕阳', 'sunset', '夕日', '석양'] },
  { t: '日出', c: 'scene', syn: ['朝', 'sunrise', 'morning light', '日の出'] },
  { t: '摄影棚', c: 'scene', syn: ['studio', 'photography studio', 'スタジオ', '스튜디오'] },
  { t: '洗衣房', c: 'scene', syn: ['laundry', 'laundry room', 'ランドリー'] },
  { t: '医院', c: 'scene', syn: ['hospital', 'clinic', '病院', '병원'] },
  { t: '花园', c: 'scene', syn: ['庭', 'garden', '庭園'] },
  { t: '咖啡馆', c: 'scene', syn: ['cafe', 'coffee shop', 'カフェ', '카페'] },
  { t: '酒吧', c: 'scene', syn: ['bar', 'pub', 'バー'] },

  // ---------- 主题 theme ----------
  { t: '圣诞', c: 'theme', syn: ['christmas', 'xmas', 'クリスマス', '크리스마스'] },
  { t: '新年', c: 'theme', syn: ['正月', 'new year', 'lunar new year', '新年', '설날'] },
  { t: '万圣节', c: 'theme', syn: ['halloween', 'ハロウィン', '핼러윈'] },
  { t: '情人节', c: 'theme', syn: ['valentine', "valentine's day", 'バレンタイン', '밸런타인'] },
  { t: '生日', c: 'theme', syn: ['誕生日', 'birthday', 'birthday party', '생일'] },
  { t: '夏日', c: 'theme', syn: ['夏天', 'summer', '夏', '여름'] },
  { t: '冬日', c: 'theme', syn: ['冬天', 'winter', '冬', '겨울'] },
  { t: '春日', c: 'theme', syn: ['春天', 'spring', '春', '봄'] },
  { t: '秋日', c: 'theme', syn: ['秋天', 'autumn', 'fall', '秋', '가을'] },
  { t: '睡衣派对', c: 'theme', syn: ['pajama party', 'pyjama party', 'パジャマパーティー'] },
  { t: '祭典', c: 'theme', syn: ['夏日祭', 'festival', 'matsuri', 'お祭り', '축제'] },
  { t: '婚礼', c: 'theme', syn: ['wedding', 'bride', '結婚式', '결혼식'] },
  { t: '校园', c: 'theme', syn: ['学校', 'school', 'campus', '学園', '학교'] },
  { t: '居家', c: 'theme', syn: ['宅家', 'home', 'at home', 'stay home', 'おうち'] },
  { t: '旅行', c: 'theme', syn: ['旅', 'travel', 'trip', 'vacation', '旅行'] },
  { t: '露营', c: 'theme', syn: ['camping', 'camp', 'キャンプ'] },
  { t: '角色扮演', c: 'theme', syn: ['cosplay', 'cos', 'role play', 'コスプレ', '코스프레'] },
  { t: '樱花', c: 'theme', syn: ['sakura', 'cherry blossom', '桜', '벚꽃'] },
  { t: '红叶', c: 'theme', syn: ['autumn leaves', 'momiji', '紅葉'] },
  { t: '花开', c: 'theme', syn: ['flower field', 'bloom', '花畑'] },
  { t: '田园', c: 'theme', syn: ['countryside', 'farm', '田園'] },
  { t: '咖啡馆主题', c: 'theme', syn: ['cafe date', 'cafe theme'] },

  // ---------- 作品角色 ip ----------
  { t: '原神', c: 'ip', syn: ['genshin', 'genshin impact', '原神'] },
  { t: '碧蓝航线', c: 'ip', syn: ['azur lane', 'アズールレーン', '碧蓝航线'] },
  { t: '明日方舟', c: 'ip', syn: ['arknights', 'アークナイツ', '明日方舟'] },
  { t: 'FGO', c: 'ip', syn: ['fate grand order', 'fate', 'fgo', 'フェイト'] },
  { t: '赛马娘', c: 'ip', syn: ['uma musume', 'ウマ娘', '赛马娘'] },
  { t: '舰娘', c: 'ip', syn: ['kancolle', 'kan colle', '艦これ', '舰娘'] },
  { t: '初音未来', c: 'ip', syn: ['hatsune miku', '初音ミク', 'miku', '初音'] },
  { t: '蕾姆', c: 'ip', syn: ['rem', 'レム', '蕾姆'] },
  { t: '拉姆', c: 'ip', syn: ['ram', 'ラム', '拉姆'] },
  { t: '雷电将军', c: 'ip', syn: ['raiden shogun', 'raiden', '雷電将軍', '雷电将军'] },
  { t: '胡桃', c: 'ip', syn: ['hutao', 'hu tao', '胡桃'] },
  { t: '甘雨', c: 'ip', syn: ['ganyu', '甘雨'] },
  { t: '八重神子', c: 'ip', syn: ['yae miko', 'yae', '八重神子'] },
  { t: '刻晴', c: 'ip', syn: ['keqing', '刻晴'] },
  { t: '神里绫华', c: 'ip', syn: ['ayaka', 'kamisato ayaka', '神里綾華', '神里绫华'] },
  { t: '2B', c: 'ip', syn: ['2b', 'nier automata', 'ヨルハ二号B型', '尼尔'] },
  { t: '蒂法', c: 'ip', syn: ['tifa', 'tifa lockhart', 'ティファ', '蒂法'] },
  { t: '艾达王', c: 'ip', syn: ['ada wong', 'ada', 'エイダ', '艾达王'] },
  { t: '不知火舞', c: 'ip', syn: ['mai shiranui', 'shiranui mai', '不知火舞'] },
  { t: '春丽', c: 'ip', syn: ['chun li', 'chun-li', '春麗', '春丽'] },
  { t: 'D.Va', c: 'ip', syn: ['dva', 'd.va', 'ディーヴァ'] },
  { t: '劳拉', c: 'ip', syn: ['lara croft', 'tomb raider', 'ララ', '古墓丽影'] },
  { t: 'Love Live', c: 'ip', syn: ['lovelive', 'love live', 'ラブライブ'] },
  { t: '偶像大师', c: 'ip', syn: ['idolmaster', 'idol master', 'アイマス', 'デレステ'] },
  { t: 'VTuber', c: 'ip', syn: ['vtuber', 'virtual youtuber', 'バーチャルyoutuber', '버튜버'] },
  { t: '海贼王', c: 'ip', syn: ['one piece', 'ワンピース', '海贼王'] },
  { t: '火影忍者', c: 'ip', syn: ['naruto', 'ナルト', '火影'] },
  { t: '美少女战士', c: 'ip', syn: ['sailor moon', 'セーラームーン', '美少女戦士'] },
  { t: 'EVA', c: 'ip', syn: ['evangelion', 'eva', 'エヴァ', '新世纪福音战士'] },
  { t: '塞尔达', c: 'ip', syn: ['zelda', 'ゼルダ'] },
  { t: '马里奥', c: 'ip', syn: ['mario', 'マリオ'] },
  { t: '街头霸王', c: 'ip', syn: ['street fighter', 'ストリートファイター'] },
  { t: '拳皇', c: 'ip', syn: ['king of fighters', 'kof', 'kof', 'ザ・キング・オブ・ファイターズ'] },
  { t: '弹丸论破', c: 'ip', syn: ['danganronpa', 'ダンガンロンパ'] },
  { t: '尼尔机械纪元', c: 'ip', syn: ['nier', 'ニーア'] },

  // ---------- 品牌 brand（原 BRANDS，保留并归并） ----------
  { t: 'tokyo hot', c: 'brand', syn: ['tokyo hot', 'tokyohot'] },
  { t: 'pornbox', c: 'brand', syn: ['pornbox'] },
  { t: 'jav', c: 'brand', syn: ['jav'] },
  { t: 'spermmania', c: 'brand', syn: ['spermmania'] },
  { t: 'pacific girls', c: 'brand', syn: ['pacific girls', 'pacificgirls'] },
  { t: 'blacksonblondes', c: 'brand', syn: ['blacksonblondes'] },
  { t: 'fellatiojapan', c: 'brand', syn: ['fellatiojapan'] },
  { t: 'dpdiva', c: 'brand', syn: ['dpdiva'] },
  { t: '秀人网', c: 'brand', syn: ['秀人网', 'xiuren'] },
  { t: 'ugirls', c: 'brand', syn: ['ugirls'] },
  { t: 'miko酱', c: 'brand', syn: ['miko酱'] },
  { t: 'little red', c: 'brand', syn: ['little red'] },
  { t: 'popdaily', c: 'brand', syn: ['popdaily'] },
]

/** 标准名 → 词条（同义归并时查表用） */
export const DICT_BY_STANDARD: Map<string, DictEntry> = new Map(TAG_DICT.map((e) => [e.t, e]))

/** 同义词（含标准名自身）→ 标准名 */
export const SYNONYM_TO_STANDARD: Map<string, string> = (() => {
  const m = new Map<string, string>()
  for (const e of TAG_DICT) {
    m.set(e.t.toLowerCase(), e.t)
    for (const s of e.syn) {
      const key = s.toLowerCase()
      if (!m.has(key)) m.set(key, e.t)
    }
  }
  return m
})()

/** 标准名 → 分类 */
export const CATEGORY_OF_STANDARD: Map<string, TagCategory> = new Map(TAG_DICT.map((e) => [e.t, e.c]))
