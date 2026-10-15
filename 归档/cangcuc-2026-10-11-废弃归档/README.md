# cangcuc 站点定义（已废弃归档）

- **废弃日期**：2026-10-11
- **废弃原因**：`cangcuc.com` 域名 DNS 长期失效（`getaddrinfo ENOTFOUND`），无新域名线索；用户决定放弃适配
- **处理方式**：定义文件从 `src/sites/defs/` 移入本归档目录，并从 `defs/index.ts` 注册表与抓取页站点列表中移除
- **原定义要点**（供将来若该站以新域名复活时参考）：
  - 容器 `post-single-body`；无分页（`pagination.kind: 'single'`）
  - 图片形如 `media01.cangcuc.com/size_large_v1/{相册}_{ts}/NNN.jpg`（带扩展名，无需 `imageHosts`）
  - 标题清理：去尾部 `| Căng Cực`
  - 站内搜索：WP 标准 `?s=`，分页 `/page/N/?s=`
- **相关历史**：FP-014（新站适配）、FP-021（站点可用性维护：DNS 失效 → 取消默认勾选）