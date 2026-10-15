// 图站模块（FP-018）—— 站点定义 schema（纯数据，可序列化）
//
// 设计约束（阶段 1：无行为变更重构）：
// 1. 域名只允许出现在 endpoints 与 searchBaseHost 两处；URL 一律由 host + 路径/参数声明拼装，
//    站点换域名时只改这一处（阶段 1B 起支持运行期覆盖，不必重新构建插件）。
// 2. 定义全部为数据（无函数），可供 UI 编辑 / 导入导出 / 探测生成。
// 3. engine.ts 将定义编译为运行期对象 GallerySiteConfig（形状与旧 lib/gallery-sites.ts 一致），
//    编译产物必须与旧实现行为等价（对比结论见 设计文档/变更日志/2026-10-07-001）。

/** 正则声明（source / flags 分离，便于序列化） */
export interface RegexSpec {
  source: string
  flags?: string
}

/** 站点端点（域名）：role 决定用途；换域名时改这里 */
export interface SiteEndpoint {
  host: string
  /** primary=主域（URL 基址 / 改写目标）；mirror=镜像；search=搜索专用子域 */
  role?: 'primary' | 'mirror' | 'search'
}

/** 分页方式 */
export type PaginationKind =
  /** 无条件 ?param=N（buondua / hitxhot / kaizty / phimvuspot） */
  | 'query'
  /** 无条件 /N（rrwsh） */
  | 'path'
  /** 第 1 页用基址，其后 /N（jrants） */
  | 'path-from-2'
  /** 第 1 页用基址，其后 /N/（pixibb） */
  | 'path-slash-from-2'
  /** 第 1 页用基址，其后 /page/N/（WP 标准分页；knit.bid） */
  | 'page-path-slash'
  /** 不分页（ilovexs） */
  | 'single'

export interface SitePagination {
  kind: PaginationKind
  /** kind=query 时的参数名 */
  param?: string
}

/** 相册基址提取规则（统一去 query/hash；stripPagePath 处理路径式分页） */
export interface SiteBaseUrl {
  /** none：仅去 query/hash；suffix：去尾部 /N；trailing-slash：去尾部 /N 或 /N/；
   *  page-segment（2026-10-10）：去尾部 /page/N 或 /page/N/（WP 标准分页） */
  stripPagePath?: 'none' | 'suffix' | 'trailing-slash' | 'page-segment'
}

/** 搜索通道声明 */
export type SiteSearch =
  /** 站内 query 搜索（buondua：?search=q 分页 &start=offset） */
  | { kind: 'query'; path?: string; param: string; pageParam?: string; pageStep?: number }
  /** 路径模板搜索，仅第 1 页（rrwsh：/search/{q}） */
  | { kind: 'path-template'; template: string }
  /** WP 站内搜索（?s=q 与 /page/N?s=q；trailingSlash 控制分页路径末尾斜杠，path 指定搜索页路径） */
  | { kind: 'wp-query-path-page'; param: string; trailingSlash?: boolean; path?: string }
  /** Google 站内搜索（www.{primaryHost}；分页 &start=） */
  | { kind: 'google-sitesearch' }

/** 搜索/推荐链接解析器名（注册表见 parsers.ts） */
export type LinkParserName =
  | 'buondua-items-row'
  | 'rrwsh-cards'
  | 'kaizty-photos'
  | 'jrants-wp'
  | 'pixibb-magezix'
  | 'google-serp'
  | 'generic-post-links'

/** 推荐/其他链接扫描解析器名（注册表见 parsers.ts） */
export type ScanParserName =
  | 'buondua-recommended'
  | 'buondua-others'
  | 'jrants-recommended'
  | 'jrants-others'
  | 'pixibb-recommended'
  | 'pixibb-others'

/** 搜索结果张数提取规则名（注册表见 parsers.ts） */
export type ImageCountRuleName = 'jrants-p' | 'pixibb-slug' | 'rrwsh-photos'

/** 文件夹名规则名（视图侧按此路由；FP-018 纪律：业务代码禁止判断 site.id） */
export type FolderNameRuleName = 'buondua' | 'jrants' | 'pixibb'

/** 站内列表页声明（FP-023 列表浏览）：不依赖搜索引擎，直接遍历站点分类/列表页 */
export interface SiteListPage {
  /** 界面显示名（如「相册列表」） */
  label: string
  /** 列表页路径（相对主域，如 /gallerys/） */
  path: string
  /** 分页 URL 方式（缺省按站点 pagination 派生） */
  pageKind?: 'query' | 'path' | 'path-slash'
  /** pageKind=query 时的参数名（默认 page） */
  param?: string
  /** 相册链接路径过滤（缺省用 searchAlbumPath） */
  albumPath?: string
}

/** 站点定义（纯数据；新增站点只需新增一份定义） */
export interface SiteDef {
  id: string
  /** UI 显示名（阶段 1B 起用于站点分组渲染） */
  label: string
  /** UI 排列顺序（阶段 1B 起用于站点分组渲染） */
  uiOrder: number
  endpoints: SiteEndpoint[]
  /** 正文容器（编译为开标签正则） */
  container: { tag: string; className: string }
  pagination: SitePagination
  baseUrl?: SiteBaseUrl
  /** 顺序翻页直到连续空页（2026-10-10）：页面无 Page X/Y 标记、且分页导航推不出总页数时使用
   *  （如 knit.bid 的分页链接不在 <a> 中）→ 抓取流程按上限顺序翻页，靠「连续 3 页无图」停止 */
  followPagesUntilEmpty?: boolean
  /** 标题分页标记：捕获组 2 = 总页数；缺省 = 无标题标记（仅分页链接兜底） */
  maxPagePattern?: RegexSpec
  /** 标题清理：按序 replace（正则源），最后统一 trim */
  titleStrip?: RegexSpec[]
  /** 本站图床域名（与其它站合并为「无扩展名图片」的判定白名单） */
  imageHosts?: string[]
  /** 图片 URL query 修正（如 Photon ?w=640 → ?w=1920） */
  imageQueryFix?: { param: string; value: string }[]
  /** 搜索通道；缺省 = 不支持站内搜索 */
  search?: SiteSearch
  /** 搜索基址 host（默认主域；pixibb 用 sexy 子域） */
  searchBaseHost?: string
  /** Google/搜索结果的相册路径过滤前缀（如 /photos/） */
  searchAlbumPath?: string
  /** 搜索结果的相册路径正则过滤（2026-10-08 体检 P1-2：相册 URL 无固定前缀时使用，
   *  如 pixibb 的 `-photos`；与 searchAlbumPath 同时设置时为「且」关系） */
  searchAlbumPattern?: RegexSpec
  /** 站内列表页（分类/列表页遍历，FP-023）；缺省时界面按根路径 + 站点分页方式 */
  listPages?: SiteListPage[]
  /** 搜索结果 URL 改写：来自 fromHost 的链接改写到本站主域（rrwsh 绕过反爬网关） */
  urlRewrite?: { fromHost: string }[]
  linkParser: LinkParserName
  /** 推荐/其他链接扫描解析器（缺省 = buondua 那对） */
  scan?: { recommended: ScanParserName; others: ScanParserName }
  imageCountRule?: ImageCountRuleName
  /** 站内搜索页间节流（jrants 反爬） */
  throttle?: { fromPage: number; delayMs: number }
  /** 聚合搜索分组（阶段 1B 起为 UI 分组依据） */
  channels?: ('site' | 'google')[]
  /** 聚合搜索默认勾选（阶段 1B 起生效） */
  defaultChecked?: boolean
  /** 站点说明（UI 提示，阶段 1B 起生效） */
  hint?: string
  /** 文件夹名前缀 ID-{folderTag}-*
   *  约定（阶段 1）：全部保持 'buondua' 以维持现状命名；语义化改名属行为变更，另行申请 */
  folderTag?: string
  /** 文件夹/相册名清洗规则（缺省 = buondua 通用规则；2026-10-08 体检 P0-2：
   *  原先由视图侧判断 site.id 路由，改为读本字段） */
  folderNameRule?: FolderNameRuleName
}

/** 运行期站点对象（编译产物；形状与旧 GallerySiteConfig 一致，额外携带来源定义 def） */
export interface GallerySiteConfig {
  id: string
  hosts: string[]
  containerOpen: RegExp
  pagePattern: RegExp
  pageUrl: (base: string, page: number) => string
  baseUrlOf: (url: string) => string
  cleanTitle: (title: string) => string
  searchUrl?: (q: string, page: number) => string | null
  rewriteUrl?: (url: string) => string
  searchAlbumPath?: string
  /** 编译后的搜索结果路径正则（见 SiteDef.searchAlbumPattern） */
  searchAlbumPattern?: RegExp
  imageUrlClean?: (url: string) => string
  /** 编译来源定义（parsers / service 读取 linkParser、imageCountRule、throttle、folderTag） */
  def: SiteDef
}
