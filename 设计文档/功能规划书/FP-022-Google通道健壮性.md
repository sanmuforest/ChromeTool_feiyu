# FP-022 Google 搜索通道健壮性

> 立项日期：2026-10-07 ｜ 状态：**已交付（效果待用户实测确认）** ｜ 版本 v0.2.9
> 触发：用户实测聚合搜索时，浏览器标签页出现 Google 403 错误页

## 1. 现象与证据

用户贴出的页面内容：

```
403. 这是个错误。
您的客户端没有权限 /search?q=无痕丝袜&sitesearch=hitxhot.org&gbv=1 从此服务器获取 URL。
```

被拒的 URL 正是插件构造的 Google 站内搜索地址，说明 **Google 服务器拒绝了插件请求**（不是站点反爬、也不是网络不通）。

## 2. 根因

URL 中两个**已废弃参数**：

| 参数 | 问题 |
|------|------|
| `gbv=1` | Google 的「基础 HTML 版」参数，早期为让后台 fetch 可解析结果而使用；Google 现已直接对带该参数的请求返回 403 |
| `sitesearch={host}` | 老式站内搜索参数；现代 Google 只认 `q=关键词 site:域名` 语法 |

代码中三处都带 `gbv=1`，即**整条 Google 通道因此失效**：`engine.ts`（hitxhot / kaizty / jrants 的搜索 URL）、`buondua-service.ts` 的 `googleSearchConfig`（Google 全站模式）、`testGoogleConnection`（连接测试）。用户此前遇到的「人机验证」与本次 403 很可能同源。

## 3. 改动（用户确认的两项决策）

### 3.1 URL 现代化（去掉 gbv=1，改用 site: 语法）

统一为：`https://www.google.com/search?q={关键词} site:{域名}&hl=zh-CN&start=N`

| 位置 | 变化 |
|------|------|
| `src/sites/engine.ts` | `google-sitesearch` 分支改现代语法（覆盖 hitxhot / kaizty / jrants） |
| `src/background/buondua-service.ts` | `googleSearchConfig` 同步改造（覆盖 Google 全站模式与 Google 组站点） |
| 同上 | `testGoogleConnection` 测试 URL 去掉 `gbv=1` |

### 3.2 403 / 验证页识别 + 保留标签页

- `extractGoogleTabResults` 现在返回 `{ items, blocked }`：在页面标题与可见文本中识别 Google 的拒绝特征（`您的客户端没有权限`、`系统检测到异常流量`、`unusual traffic`、`not a robot`、`recaptcha`、`sorry/index` 等），且**仅在命中特征且确实没提取到结果时**判定被拒，避免正常页面误判
- 被拒时：停止翻页、**不再自动关闭该搜索标签页**（留给你手动完成验证）、聚合搜索返回明确提示：「Google 拒绝本次请求（403 / 人机验证）：已保留搜索标签页，请手动完成验证后重试」
- 被拒时**不再自动降级站内 fetch**（避免对已失效的站内接口做无效请求）
- 「测试 Google 连接」按钮的 `blocked` 字段由硬编码 `false` 改为真实判定，并单独记录 warn 日志

## 4. 效果限制（重要）

- 我**无法在外部环境验证 google.com**（本机环境将其解析到非公网 IP），因此修复效果必须由你实测确认
- 若现代语法仍被 Google 拒绝，则属**环境级限制**（IP / 代理 / 自动化指纹），后续只能走「手动完成验证后复用该标签页」的策略
- 站点间 Google 请求间隔（降频）本轮**未做**（未获确认），如需可后续追加

## 5. 验证

- `npm run typecheck`：EXIT=0
- `npm run build`：通过，**当前版本 v0.2.9**
- 实测：见 `变更日志/2026-10-07-005`

## 6. 不在本范围

- 不改站内搜索通道（buondua 等仍走原接口）
- 不引入 Google 官方 API（需 key 且配额受限）
- 不做代理 / 指纹伪装类手段
