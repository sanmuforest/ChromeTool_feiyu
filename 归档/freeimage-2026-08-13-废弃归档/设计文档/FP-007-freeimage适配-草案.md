# FP-007 站点适配：freeimage.host（Chevereto 图床）设计草案 v5

- 状态：**DRAFT（待用户最终确认）**
- 前置调研：curl + 浏览器自动化实测（2026-08-12，详见《调研报告/2026-08-12-001-图床替代品评估.md》）
- 设计原则（用户定调）：**先理解 imgbb 5 项子功能的真实需求，再结合 freeimage 的特性实现类似功能**
- v5 修正（用户确认）：
  - 场景 D：**主要检索相册名**，命中可跳转相册页和用户主页
  - 场景 E：**多轮多层次扩散，用户手动激活**；标注体系**主要用于排除**（排除含大量图片/相册但非目标类群的用户）
  - **增加数据导出**；存储与入口确认（fh_producer_db + freeimage 子标签）

## 一、imgbb 5 项子功能的真实需求（需求理解）

| # | imgbb 子功能 | 真实需求 | 本质 |
|---|-------------|---------|------|
| 1 | 用户主页抓取和下载 | 已知用户名 → 抓其全部图片 → 下载 | **定向抓取**（目标明确） |
| 2 | 用户单相册抓取和下载 | 已知相册 URL → 抓相册全部图片 → 下载 | **定向抓取**（目标明确） |
| 3 | 快速检索用户相册 | 已知用户名 → 列出其相册目录快速浏览 | **定向浏览**（目标明确） |
| 4 | 变体相册搜索（关注墙） | imgbb 无官方搜索 → 借关注关系找新内容 | **内容发现**（无明确目标） |
| 5 | 强化版相册搜索（扩散+评分） | 4 的强化：多跳扩散 → 鉴别特定类群生产者 | **内容发现强化**（规模化鉴别） |

## 二、freeimage 实测能力（全部实测通过）

| 通道 | URL | 实测 |
|------|-----|------|
| 用户主页图片 | `/{user}?list=images&sort=date_desc&page={N}&ajax=1` | ✅ 36 图/页 |
| 相册列表 | `/{user}/albums?sort={sort}&page={N}`（views/date/likes/name） | ✅ 36 项/页，jzqgoodlife 72+ 相册 |
| 相册详情 | `/a/{slug}.{ID}` 或 `/album/{ID}` | ✅ 6 图/页 |
| 相册内翻页 | `?list=images&from=album&albumid={ID}&page={N}&ajax=1` | ✅ |
| 探索页 | `/explore?ajax=1&list=images&sort=date-added-desc&page={N}` | ✅ 36 张/页 |
| 图片页属主 | `/i/{id}` → user-link + 头像 | ✅ |
| 原图 CDN | `iili.io/{id}.jpg/.png` | ✅ 200 可下载 |

数据结构：图片 data-object 含原图/medium/thumb/宽高/原始文件名（name/title）；相册项含 `data-name`（中文名）+ 封面 + URL `/a/{slug}.{ID}`（**相册名 = 类群信号**）。

## 三、功能范围总表（5 场景，v5）

| 场景 | 输入 | 输出 | 对齐 imgbb |
|------|------|------|-----------|
| A 用户主页抓取 | 用户名/主页 URL | 图片网格 + 下载 | ① |
| B 相册抓取 | 相册 URL | 图片网格 + 下载 | ② |
| C 相册分析 | 用户名 | 相册卡片（点击新开页） | ③ |
| D 相册名检索 | 关键词 + 采集范围 | **命中相册列表**（可跳相册页/用户主页） | ④变体搜索 |
| E 类群鉴别 | 手动逐轮扩散 + 排除标注 | 候选/排除用户 + 类群库 + 导出 | ⑤强化搜索 |

## 四、场景 D：相册名检索（雷达，v5 修正）

**目的**：快速筛选关键词内容，**主要匹配相册名**（非文件名），发现目标相册

**采集**（与场景 E 共享索引）：
1. 探索页 N 页抓取（图片 + 原始文件名）
2. 对图片访问图片页提取属主（跳过匿名）
3. 对属主抓相册列表 → **相册名采集入索引**（本地索引，不持久化或可选持久化）
4. 手动「下一批」继续新探索页数据（人肉节流）

**检索**：
- 关键词输入（逗号分隔，AND/OR）→ 本地匹配**相册名**（主要）+ 图片文件名（次要）
- 命中展示：相册卡片（相册名 + 属主用户名 + 封面 + 张数）
- **点击跳转**：相册页（`/a/{slug}.{ID}`）/ 用户主页（`/{username}`）双跳转
- 排除过滤：已标注「排除」的用户相册不显示（联动场景 E 标注库）

## 五、场景 E：类群鉴别（v5 修正：多轮多层手动扩散 + 排除标注）

**目的**：对齐 imgbb ⑤——多轮多层次扩散 + 手动标注排除，鉴别目标类群用户

**多轮多层次扩散（手动激活）**：

| 层 | 动作 | 产出 |
|----|------|------|
| L1 内容层 | 探索页采样 N 张图 → 图片页提取属主（跳过匿名） | 候选用户 |
| L2 相册层 | 对候选用户抓相册列表 → 相册名（类群信号） | 类群线索 + 相册索引 |
| L3 深入层（可选） | 对高价值候选的相册内图片 → 提取新属主（多上传者相册） | 更深扩散 |

- **手动激活**：每轮由用户点「下一轮扩散」触发（对齐 imgbb 扩散「下一批」人肉节流 + 429 保护）
- 多轮循环：每轮探索页新数据 → 新候选 → L2 相册名 → 用户标注 → 再扩散

**标注体系（v5 核心：排除为主）**：

| 标注 | 含义 | 作用 |
|------|------|------|
| **排除**（excluded） | 非目标类群（如广告号/AI 批量号/无关主题但图片量大的用户） | 从检索结果/候选展示**剔除**；可加排除理由标签 |
| **目标**（target） | 目标类群用户 | 保留收藏，类群库核心 |
| 未标注 | 未知 | 默认保留展示，等待判断 |

- 标注操作：候选列表每项 = 「目标 / 排除」按钮 + 备注（可选）
- 排除理由标签（可选）：如「广告」「AI图」「无关」——辅助回顾
- **排除联动**：场景 D 检索、场景 E 候选展示自动跳过已排除用户

**类群库**（`fh_producer_db`，持久化）：
```
Record<username, {
  username: string
  status: 'target' | 'excluded' | null  // 目标 / 排除 / 未标注
  reason?: string                        // 排除理由 / 目标备注
  avatarUrl?: string
  albums?: {name, url}[]                 // 相册名线索缓存
  albumCount?: number
  seenAt: number
  notedAt?: number
}>
```

**导出**（v5 新增）：类群库导出 JSON（对齐 imgbb producer-db 导出/导入合并），文件 `freeimage-producers.json`

## 六、消息协议（新增 + 模块边界登记）

| type | 发起方 | 处理方 | 说明 |
|------|--------|--------|------|
| `FH_FETCH_USER` | grabber | background | 用户主页分页抓取 |
| `FH_FETCH_ALBUM` | grabber | background | 相册全量抓取 |
| `FH_FETCH_ALBUMS` | grabber | background | 相册列表分页 |
| `FH_FETCH_EXPLORE` | grabber | background | 探索页分页抓取（D/E 采集源） |
| `FH_EXTRACT_OWNER` | grabber | background | 图片页属主提取（批量，D/E 用） |
| `FH_SCAN_PRODUCERS` | grabber | background | L2 相册名采集（候选 → 相册线索） |
| `FH_PRODUCER_GET` | grabber | background | 读类群库 |
| `FH_PRODUCER_SAVE` | grabber | background | 保存标注（status/reason） |
| `FH_PRODUCER_CLEAR` | grabber | background | 清除标注 |
| `FH_PRODUCER_EXPORT` | grabber | background | 导出类群库 JSON |
| `FH_PRODUCER_IMPORT` | grabber | background | 导入合并（可选） |
| `FH_RESULT` | background | grabber | 结果推送（kind/data/done/error） |

- 复用：下载/打包/日志/并发设置
- 存储键：`fh_producer_db`（owner = freeimage 适配器，FROZEN 级受保护）

## 七、解析器（src/lib/freeimage-parse.ts，纯函数）

- `parseImageItems(html)` → `FhImage`（图片 data-object）
- `parseAlbumItems(html)` → `FhAlbum`（相册列表，中文名）
- `extractOwner(html)` → `FhOwner`（图片页属主）
- `isGuestOwner(html)` → 匿名判断
- `extractAlbumName(html)` → 相册页标题
- `matchAlbumKeywords(albums, keywords)` → 相册名过滤纯函数（可单测）

## 八、后台服务（src/background/freeimage-service.ts）

- `fetchHtml(url)`：fetch + 20s 超时
- `fetchUserPages` / `fetchExplorePages` / `fetchAlbumsPages` / `fetchAlbumImages`
- `extractOwners(imageIds[], samplePerPage)`：批量图片页属主提取（串行 + 间隔 + 429 暂停）
- `scanAlbumsForUsers(users)`：候选用户相册名采集（L2）
- 类群库 CRUD + 导出/导入（JSON）
- 节流：批内串行、429 连续 3 次暂停提示

## 九、UI 设计（src/grabber/view-freeimage.ts）

站点适配页新增「freeimage」子标签，内部 5 个子场景：

- **用户主页**：输入框 + 抓第一批/下一批/页码范围（共享抓取视图）
- **相册抓取**：输入框 + 抓取（共享抓取视图）
- **相册分析**：用户名 + 排序 + 开始/下一批 → 相册卡片
- **相册名检索**：关键词输入 + 「采集探索页」/「下一批」→ 命中相册列表（相册名/用户/封面 + 双跳转按钮）
- **类群鉴别**：
  - 扩散区：「下一轮扩散」按钮 + 进度 → 候选用户列表（用户名/头像/相册名线索）
  - 标注区：每候选 = 「目标」「排除」按钮 + 理由备注
  - 类群库：按状态筛选（目标/排除/全部）→ 用户列表 + 一键抓主页/相册 + 导出/导入

## 十、权限与合规

- host 权限：`freeimage.host`、`iili.io` 纳入 `<all_urls>` 按需申请（复用 ensureHostPermission）
- 新增存储键 `fh_producer_db`（chrome.storage.local，仅标注数据）
- 无远程代码；导出 JSON 为用户主动操作

## 十一、数据流

```
场景A/B: grabber → FH_FETCH_* → background fetch → data-object 解析 → FH_RESULT → 共享抓取视图 → 下载
场景C: grabber → FH_FETCH_ALBUMS → background → FH_RESULT(albums) → 卡片网格
场景D: FH_FETCH_EXPLORE（采集）→ FH_EXTRACT_OWNER（属主）→ FH_SCAN_PRODUCERS（相册名索引）
      → 本地关键词匹配相册名 → 命中列表 → 跳转相册/用户（排除用户已剔除）
场景E: FH_FETCH_EXPLORE → FH_EXTRACT_OWNER → 候选 → FH_SCAN_PRODUCERS（L2 相册名）
      → 用户标注（FH_PRODUCER_SAVE → fh_producer_db）→ 排除剔除/目标保留 → 手动下一轮
      → 导出（FH_PRODUCER_EXPORT）→ 目标用户 → FH_FETCH_USER/ALBUM 抓取
```

## 十二、实测验证方案（红线 3）

1. 场景 A/B/C：jzqgoodlife 用户/芭比相册/72+ 相册列表（已验证链路）
2. 场景 D：采集探索页 2 页 → 属主 → 相册名 → 关键词「电影」类命中 → 跳转
3. 场景 E：手动扩散 2 轮 → 候选（filelu/ironmikesusa/jzqgoodlife 等）→ 标注排除广告类 → 排除项不再出现 → 导出 JSON
4. 标注持久化：刷新保留；排除联动生效
5. tsc 类型检查通过

## 十三、回归检查（红线 1）

- 新增文件：`freeimage-parse.ts` / `freeimage-service.ts` / `view-freeimage.ts`（独立新模块）
- 触及：`messages.ts`（新增消息）、`view-adapters.ts` 或 grabber 入口（新增子标签）、`模块边界.md`（新增模块 + 存储键 + 消息登记）——**跨模块改动，编码前先更新文档**
- `imgbb-parse.ts` 保持 FROZEN 不动
- 改动后自查相邻模块，结论记入变更日志
