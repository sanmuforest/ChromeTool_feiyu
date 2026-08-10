---
name: extension-dev
description: Chrome 扩展开发主 skill——Manifest V3、TypeScript、Chrome API、项目架构、模块规范。写代码、搭架构、做技术决策时使用。
---

# Chrome 扩展开发主技能

Chrome 扩展（Manifest V3）项目开发规范。本项目的核心开发 skill。

## 项目基线

- **Manifest V3**（`manifest_version: 3`），Chrome 88+
- **TypeScript** 编写，编译产物为 ES2020 的 IIFE 模块（无 runtime 依赖，兼容 MV3 环境）
- **目标**：Chrome 桌面端（必要时兼容 Edge/Firefox 差异，用 feature detect）
- 构建工具：Vite / esbuild / tsup（任选一种，保持单一构建链）

## Manifest V3 关键约束

- 后台脚本用 **Service Worker**（`background.service_worker`），无 DOM，生命周期短，状态要持久化到 `chrome.storage`
- 页面脚本用 **content scripts**，与主世界隔离（isolated world），只能通过消息通信
- **CSP**：默认 `script-src 'self'`，禁止 `eval`、内联脚本
- 远程代码一律禁止（所有 JS 必须打包进包内）
- 权限最小化：按需声明 `permissions` / `host_permissions`，能用 activeTab 就不用 `<all_urls>`

## 项目结构

```
项目根/
├── manifest.json          # MV3 清单
├── src/                   # 源码
│   ├── background/        # Service Worker 逻辑
│   ├── content/           # 内容脚本（页面注入）
│   ├── popup/             # Popup 界面
│   ├── options/           # 设置页
│   ├── lib/               # 共享工具（消息、存储、类型）
│   └── assets/            # 图标（16/32/48/128）
├── dist/                  # 构建产物（Chrome 加载此目录）
├── tests/                 # 单元/集成测试
└── docs/ 或 设计文档/      # 设计文档
```

## 命名规范

- 文件/目录：小写连字符（`background-service.ts`、`content-scripts/`）
- TypeScript 类型/接口：`PascalCase`；函数/变量：`camelCase`；常量：`UPPER_SNAKE_CASE`
- Chrome 消息类型：`PascalCase` 的联合类型，配 `lib/messages.ts` 集中定义

## 模块划分原则

- **消息层**：所有跨上下文通信走统一 `lib/messages.ts`（类型安全的 sendMessage / onMessage 封装）
- **存储层**：所有状态读写集中到 `lib/storage.ts`（schema 单一来源，版本迁移函数）
- **UI 层**：popup/options 只做展示与事件，不直接碰 chrome API 细节
- **内容层**：content scripts 保持纯函数化（DOM 操作与数据提取分离，便于测试）

## 开发流程（每个 Feature）

1. 设计文档先行（`设计文档/`），确认权限与数据流
2. 定义消息类型与存储 schema
3. 实现后台逻辑 → 内容脚本 → UI
4. 本地加载 `dist/` 验证（chrome://extensions → 开发者模式 → 加载已解压）
5. 编写测试，review 后收尾
