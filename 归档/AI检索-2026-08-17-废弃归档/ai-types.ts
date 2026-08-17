// AI 检索代理（FP-013）独立类型文件
// 理由：types.ts 为 FROZEN 模块，AI 模块类型独立存放（freeimage-types 先例），避免触碰红区

/** AI 检索请求（grabber → background） */
export interface AiSearchRequest {
  /** 主关键词 */
  keyword: string
  /** 手动补充变体（无 LLM 密钥时的降级扩展手段） */
  manualVariants?: string[]
  /** 会话查询预算（SERP 请求数上限，防反爬/成本失控） */
  maxQueries?: number
  /** 是否启用广域图片通道（Google 标签页 + Yandex fetch；false 仅站内搜索） */
  useImages?: boolean
}

/** AI 策略：搜索变体 × 域名候选 × 排除词 */
export interface AiStrategy {
  variants: string[]
  domains: string[]
  excludeWords: string[]
  /** 来源说明（seed=内置种子 / custom=用户自定义 / llm=AI 生成） */
  sources: string[]
}

/** 统一相册候选（广域通道产出，对齐 BuonduaLinkItem 语义但独立定义） */
export interface AiAlbumItem {
  url: string
  title: string
  coverUrl?: string
  domain: string
  /** 命中域名（搜索时的限定域名，无则为空） */
  hitDomain?: string
  /** 来源通道：bing-web / bing-image / yandex-image / google-image / site-search / custom */
  source: string
  /** L0 规则分（M1：0~100，基于 URL/标题特征；M3 起并入视觉分） */
  score: number
  /** 陌生域名（不在种子域名候选列表，广域新发现）——UI 显示「新」徽标 */
  isNewDomain?: boolean
}

/** AI 检索阶段（进度推送） */
export type AiPhase = 'strategy' | 'search' | 'filter' | 'done'

/** 进度推送负载 */
export interface AiSearchProgress {
  phase: AiPhase
  /** 本轮查询序号 */
  queryIndex: number
  queryTotal: number
  /** 会话累计 SERP 请求数（预算计数） */
  requests: number
  /** 当前累计结果数 */
  results: number
  /** 策略摘要（首次推送携带，供 UI 展示） */
  variants?: string[]
  domains?: string[]
  /** 诊断备注（如空结果查询数） */
  note?: string
}

/** AI 检索结果推送（kind=items 时携带增量结果） */
export interface AiResultPayload {
  kind: 'progress' | 'items' | 'done' | 'error'
  progress?: AiSearchProgress
  items?: AiAlbumItem[]
  error?: string
}

/** 视觉 API 配置（M3 使用，M1 仅登记存储键） */
export interface AiVisionConfig {
  enabled: boolean
  baseUrl?: string
  apiKey?: string
  model?: string
  /** 会话调用预算上限 */
  budget?: number
}

/** 检索通道：yandex-image（宽容广域图）/ bing-image / bing-web */
export type AiChannel = 'yandex-image' | 'bing-image' | 'bing-web'

/** 单条检索查询（通道标记） */
export interface AiQuery {
  text: string
  channel: AiChannel
}

/** AI 检索会话快照（background 内存态 + 持久化恢复） */
export interface AiSearchSession {
  request: AiSearchRequest
  strategy: AiStrategy
  /** 查询队列（变体 × 域名 组合，含通道标记） */
  queries: AiQuery[]
  queryIndex: number
  /** 已推送结果（URL 去重） */
  results: AiAlbumItem[]
  /** 会话 SERP 请求计数 */
  requests: number
  cancelled: boolean
  /** 已结束（pushDone 后置位，防止取消/结束后重复推送） */
  finished?: boolean
  startedAt: number
}

/** 用户自定义域名候选（存储键 ai_custom_domains） */
export interface AiCustomDomains {
  domains: string[]
  updatedAt: number
}
