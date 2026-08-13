# freeimage 功能废弃归档

> 归档时间：2026-08-13
> 归档原因：**freeimage.host 图片质量不佳**，用户决定停止该站点适配

## 废弃范围

- 设计文档：`设计文档/功能规划书/FP-007-freeimage适配-草案.md`（原档已标注废弃）
- 插件功能：grabber「freeimage」页签、后台 FH_* 消息分支、存储键 `fh_producer_db` / `fh_album_index` / `fh_diffuse_db` / `fh_cn_album_index`
- 关联变更日志：`设计文档/变更日志/2026-08-13-060` ～ `066`（历史记录，保留原样）

## 归档文件清单

| 原路径 | 归档位置 | 说明 |
|--------|---------|------|
| `src/grabber/view-freeimage.ts` | `src/grabber/view-freeimage.ts` | freeimage 适配页 UI（1701 行） |
| `src/background/freeimage-service.ts` | `src/background/freeimage-service.ts` | 后台 fetch 编排服务 |
| `src/background/freeimage-diffuse.ts` | `src/background/freeimage-diffuse.ts` | 关注链 BFS 扩散引擎 |
| `src/lib/freeimage-parse.ts` | `src/lib/freeimage-parse.ts` | HTML 纯函数解析器 |
| `src/lib/freeimage-types.ts` | `src/lib/freeimage-types.ts` | 数据类型定义 |
| `设计文档/功能规划书/FP-007-freeimage适配-草案.md` | `设计文档/FP-007-freeimage适配-草案.md` | 功能规划书（v10 最终版） |

## 恢复方法

1. **从 git 历史恢复**：当前（删除前）HEAD 提交为 `bc97c21`，`git checkout bc97c21 -- <文件>` 可恢复任意文件
2. **从归档恢复**：将本目录 `src/` 下文件复制回原路径，并从归档的 FP-007 草案对照恢复 `messages.ts` / `background.ts` / `grabber.ts` / `grabber.html` / `grabber.css` 中的 FH_* 改动
3. 恢复后需在 `设计文档/模块边界.md` 重新登记模块、存储键、消息

## 删除清单（共享文件中的改动点）

- `src/grabber/grabber.html`：freeimage 页签按钮 + `panel-freeimage`
- `src/grabber/grabber.ts`：freeimage 导入/挂载/消息分支/下载转发
- `src/background/background.ts`：freeimage 导入、服务实例、存储恢复、`pushFhResult`、FH_* case
- `src/lib/messages.ts`：freeimage 类型导入、FH_* 消息、`FhResultKind`、`ScanAlbumEntry`、`ExploreSearchProgress`
- `src/grabber/grabber.css`：`fh-*` 样式

（以上共享文件在删除前的最新完整版本均可从 git 提交 `bc97c21` 检出）
