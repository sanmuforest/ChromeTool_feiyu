# 2026-11-04-001 tuzac（图宅网）适配 + chottie 判定为 SPA

> 版本：**v0.2.58** ｜ 类型：新增站点 + 站点可行性判定
> 触发：用户提供两个「比较优质的多图备选网站」

## 一、两个站的判定结果

| URL | 判定 | 依据 |
|-----|------|------|
| `www.tuzac.com/file/{slug}/{id}/?at=2` | **✓ 可适配，已完成** | 服务器 HTML 有内容：`file-detail` 容器、每页 5 张 `image.tuzac.com` 原图、分页 `?at=N` |
| `chottie.org/blog/archives/51156/2` | **✗ 是 Nuxt SSR 单页应用** | 445KB 页面里 `<img>` **0 个**、`<body>` 内只有 `data-server-rendered` 的 `__nuxt`/`__layout` 空壳、数据全在 `window.__NUXT__` 里 → 服务器 HTML 无图片，**只能靠浏览器内探测** |

## 二、tuzac（图宅网）适配要点

| 项 | 实测 |
|----|------|
| 正文容器 | `div.file-detail`（**块长 ~30KB**，含全部正文图） |
| 正文图 | `https://image.tuzac.com/jw-photos/…/{NNN}-{hash}.jpg`；`src` 与 `data-src` **相同**（都是原图） |
| 每页张数 | **5 张**（`?at=2` 页为 `006`~`010`，编号连续） |
| 分页 | `?at=N`（第 1 页不带参数）→ `query` 式 |
| 总页数 | 页面只给相邻页码 → `followPagesUntilEmpty` 顺序翻页 + 1.2s 节流 |
| 噪声 | `img.tuzac.com` 是 teaser 推荐缩略图（`teaser-*` 区块）→ `imageOnlyHosts: ['image.tuzac.com']` 排除 |
| 标题 | `{相册名} \| 图宅网 \| 高清美女无圣光图集` → 剥 `\|` 之后 |

### ⚠️ 踩到的坑：容器选错导致只解析 1 张

首版把容器写成 `div.image-loading-box`，理由是第一轮启发统计显示它「块内有 26 张图」。真实深度匹配后发现：

```
image-loading-box : 块长 301 字符、img 1     ← 每个图一个空壳
file-detail       : 块长 29831 字符、img 38  ← 真正的正文容器
```

那个「26 张」是**字符窗口统计的假象**（把后续内容也算进去了）。**教训**：候选容器的图片数必须用**真实深度匹配**核对，不能只看字符窗口内的计数。

## 三、验证（真实 HTML）

```
容器命中 : true
解析图片 : 5 张（纯 image.tuzac.com；teaser 的 img.tuzac.com 已排除）
           006-515a3.jpg / 007-abb91.jpg / 008-fdf7e.jpg / 009-b9b62.jpg / 010-301cd.jpg
标题清理 : "Potato-Godzilla-OnlyFans-Nude-Oct-2025"        ✓
分页 URL : …/49661/?at=2                                    ✓
chottie  : 不被任何现有站点匹配 → 需新增定义（且需浏览器内探测）
```

- `npm run typecheck`：EXIT=0；`npm run build`：通过（v0.2.58）
- 站点总数：**15**

## 四、chottie 需要你做一次探测

该站是 SPA，服务器抓不到内容。请：

1. 浏览器打开 `https://chottie.org/blog/archives/51156/2`
2. **等图片全部显示出来**（SPA 需要时间渲染）
3. 点插件 → 多页图站 → 粘贴该 URL → 「探测结构」
4. 把输出贴我（我要看：按图床分组的父级链、分页链接、`img` 上的 `data-*` 属性名）

## 五、用户实测清单

1. 刷新扩展 → 从 tuzac.com 页面开插件 → 多页图站 → 抓 `/file/potato-godzilla-onlyfans-nude-oct-2025/49661/`
2. 预期：每页 5 张、`unique` 为全相册张数（顺序翻页决定页数）
3. 抽一张确认是 `image.tuzac.com/…006-515a3.jpg` 这类原图（不是 `img.tuzac.com` 的推荐缩略图）
