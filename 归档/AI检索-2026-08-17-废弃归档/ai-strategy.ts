// AI 策略生成（FP-013）：搜索变体 × 域名候选 × 排除词
// M1：纯规则种子策略（零 API 依赖）——内置种子域名 + 合规过滤 + 手动变体合并
// M3+：预留 expandStrategyWithLLM（OpenAI 兼容文本调用，成人写真站生态提示词）
//
// 合规红线（FP-013 〇）：未成年内容硬排除。任何来源（种子/自定义/LLM）的变体与
// 域名都必须经过 complianceFilter，命中黑名单立即丢弃并记录。

import type { AiStrategy } from './ai-types'

/** 未成年相关词黑名单（硬排除，命中即丢弃整个查询） */
export const MINOR_BLOCKLIST = [
  'teen', 'teens', 'teenage', 'young', 'minor', 'loli', 'lolita',
  'schoolgirl', 'school', 'child', 'children', 'kid', 'kids',
  'petite', 'jailbait', 'barelylegal', 'youngest', 'highschool',
]

/** 广告/无效域名黑名单（SERP 结果过滤用） */
export const SPAM_DOMAIN_BLOCKLIST = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', // 视频站（非写真相册，M1 排除）
  'adf.ly', 'shorturl', 'bit.ly', 'tinyurl', // 短链/广告
  'facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'reddit.com', 'tiktok.com', // 社交平台（非相册直链）
  'pinterest.com', 'flickr.com', 'tumblr.com', 'deviantart.com', 'behance.net', '500px.com', // 图片聚合站（非相册）
  'youtube.com', 'youtu.be', 'vimeo.com', 'dailymotion.com', // 视频平台
  'pixabay.com', 'pexels.com', 'unsplash.com', 'shutterstock.com', 'gettyimages.com', 'adobe.com', // 图库/素材站
  'wikipedia.org', 'imdb.com', 'amazon.com', 'ebay.com', 'aliexpress.com', 'taobao.com', 'jd.com', // 百科/电商
]

/** 内置种子域名（成人写真相册站生态，2026-08-16 固化；用户可在 UI 增删） */
export const SEED_DOMAINS = [
  'jrants.com',
  'pixibb.com',
  'rrwsh.uuss.uk',
  '4khd.com',
  'hitxhot.org',
  'kaizty.com',
]

/** 合规过滤：变体/域名是否允许 */
export function isCompliantText(text: string): boolean {
  const lower = text.toLowerCase()
  return !MINOR_BLOCKLIST.some((w) => lower.includes(w))
}

export function isCompliantDomain(domain: string): boolean {
  const lower = domain.toLowerCase()
  return !MINOR_BLOCKLIST.some((w) => lower.includes(w))
}

export function isSpamDomain(domain: string): boolean {
  const lower = domain.toLowerCase()
  return SPAM_DOMAIN_BLOCKLIST.some((w) => lower.includes(w))
}

/**
 * 构建种子策略（M1 纯规则降级路径）：
 * variants = [keyword, ...manualVariants]（合规过滤后）
 * domains  = SEED_DOMAINS ∪ customDomains（合规过滤后）
 */
export function buildSeedStrategy(
  keyword: string,
  manualVariants: string[] = [],
  customDomains: string[] = [],
): AiStrategy {
  const variants = [keyword, ...manualVariants].filter(isCompliantText)
  const domains = [...new Set([...SEED_DOMAINS, ...customDomains])].filter(isCompliantDomain)
  return {
    variants,
    domains,
    excludeWords: [...MINOR_BLOCKLIST],
    sources: domains.length > SEED_DOMAINS.length ? ['seed', 'custom'] : ['seed'],
  }
}

/**
 * LLM 词扩展接口（M3+ 接入，预留签名）：
 * 输入策略 → OpenAI 兼容 /chat/completions → 返回扩展后的变体/域名
 * 注意：题材敏感，端点须为宽松审核；输出必须再过 complianceFilter。
 */
export async function expandStrategyWithLLM(
  strategy: AiStrategy,
  _config: { baseUrl: string; apiKey: string; model: string },
): Promise<{ variants: string[]; domains: string[] }> {
  // TODO(M3)：调用文本模型生成成人写真站生态搜索变体与域名候选
  // 提示词要点：WordPress 相册站特征 / 标题 NNNphotos / 域名模式 / 合规硬约束
  void strategy
  void _config
  return { variants: [], domains: [] }
}
