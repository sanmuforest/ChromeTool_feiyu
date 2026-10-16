# 2026-10-15-014 新站适配：xchina.co（小黄书 xChina）+ 修正 maxPagePattern 约定注释

> 版本：**v0.2.48** ｜ 类型：新增站点 + 文档错误修正
> 触发：用户提供相册页与第 2 页 URL、探测输出

## 一、站点定位：与 se8.me / jliji.com 同源

```
og:image : https://img.xchina.io/photos/63872e17c02a1/0002.jpg        ← 原图
样本     : https://img.xchina.io/photos/63872e17c02a1/0001_600x0.webp ← 600 宽预览
```

同一图床、同一条「`_600x0.webp` → `.jpg`」还原规则 → **直接复用 se8.me 验证过的方案**。

| 项 | 实测 |
|----|------|
| 相册 | `/photo/{id}`（第 1 页）与 `/photo/{id}/{N}`（路径式） |
| **总页数** | **直接写在标题**：`潼潼 (2/34) - 小黄书 xChina` |
| 正文容器 | Tailwind 类名（`div.relative.flex.h-[calc(100svh-84px)]…`），长且易变 → **整页容器 + `imageOnlyHosts`** |
| 图床 | `img.xchina.io`（广告位另有 `*.bkcdn.net`，由白名单排除） |
| 标注 | 该站主站与图床对服务端请求 403（与 se8.me 相同），无法离线抓取，依赖浏览器内探测 |

## 二、离线验证抓出的两个 bug（关键）

### bug 1：漏配 `baseUrl.stripPagePath` → 分页 URL 全错

```
验证输出：pageUrl 1/2/3 → …/photo/xxx/2 | …/photo/xxx/2/2 | …/photo/xxx/2/3
```

`path-from-2` 要求基址**不含页码**，但默认 `stripPagePath: 'none'` 会保留 `/2`。
**修复**：加 `baseUrl: { stripPagePath: 'suffix' }` → `…/photo/{id}/2` → `…/photo/{id}`。
（相册 id 为十六进制串，不会被 `/\/\d+$/` 误伤。）

### bug 2：`maxPagePattern` 的**注释与实现长期不一致** ⚠️ 潜在坑

`schema.ts` 原注释写：

> 标题分页标记：**捕获组 2 = 总页数**

而引擎实现是：

```ts
const m = html.match(site.pagePattern)
const n = Number(m[1] ?? m[2])      // ← 取的是组 1
```

且**全部既有站点都按「组 1 = 总页数」配置**：

```
buondua   : \(\s*Page\s+\d+\s*\/\s*(\d+)\s*\)
phimvuspot: \|\s*Page\s+\d+\s*\/\s*(\d+)
rrwsh     : Page\s+\d+\s+of\s+(\d+)
```

我照注释写成两组 `\((\d+)/(\d+)\)` → 引擎取组 1 = 当前页 `2` → **最大页数算成 2**（实际 34）。

**修复**：
1. `defs/xchina.ts`：正则改为只捕获总页数 `\(\d+/(\d+)\)`
2. `schema.ts`：注释修正为「**捕获组 1 = 总页数**」，并注明本次修正原因

> 这条注释误导性很强：任何按注释新写定义的站点都会踩中，且症状隐蔽（页数被算成当前页号，抓取只跑 2 页也不报错）。

## 三、验证（离线跑编译后引擎）

```
匹配站点 : xchina | 小黄书 xChina                          ✓
baseUrlOf: https://xchina.co/photo/63872e17c02a1           ✓（/2 已剥离）
pageUrl  : base | /2 | /3                                  ✓
标题清理 : "潼潼"                                           ✓
最大页数 : 34                                               ✓
解析结果 : 2 张（已还原 .jpg；广告 bkcdn.net 与站点图标排除）✓
回归     : buondua 15 / phimvuspot 9 / rrwsh 12             ✓（未受影响）
```

- `npm run typecheck`：EXIT=0；`npm run build`：通过（v0.2.48）
- 站点总数：**12**

## 四、用户实测清单

1. 刷新扩展 → 从 **xchina.co 页面**点开插件 → 多页图站 → 抓 `https://xchina.co/photo/63872e17c02a1`
2. 预期：日志 `pages: 34`（标题给了总页数，无需顺序翻页）、`unique` 为全相册张数
3. **下载请用「下载选中」**：该站图床与 se8.me 相同，`img.xchina.io` 对服务端 403 且页面内 fetch 受 CORS 限制
   → 「打包下载」与「网格缩略图」不可用属**预期**（不是 bug）
4. 抽一张确认下载到的是 `…/000NN.jpg` 原图（不是 `_600x0.webp` 预览、也不是 `bkcdn.net` 广告图）
