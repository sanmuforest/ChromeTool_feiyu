---
name: extension-testing
description: 测试 skill——单元测试（提取/存储/消息纯逻辑）、集成测试、Playwright 浏览器自动化、MV3 环境模拟、CI 接入。编写测试或质量把关时使用。
---

# 插件测试

插件测试分三层：**纯逻辑单测**、**浏览器集成测试**、**真实页面 E2E**。

## 测试金字塔

```
        E2E（Playwright，少量）
       ┌──────────┐
      │ 集成测试  │  ← 模拟 chrome API + 真实 DOM
     │ ┌────────┐ │
    │  │ 单元测试 │  ← 纯函数：提取/解析/存储/schema
    │ └────────┘ │
     └──────────┘
        └────────┘
```

## 单元测试（占比最大）

- **对象**：DOM 提取纯函数、数据清洗、消息类型校验、存储 schema 迁移、设置合并逻辑
- **工具**：Vitest / Jest
- **要点**：DOM 提取函数用 jsdom 或注入真实 HTML 片段（fixture）测试，不依赖真实网络
- 覆盖边界：空 DOM、结构变化、畸形输入、权限缺失

## chrome API 模拟

- 用 `sinon` / 手写 stub 模拟 `chrome.storage`、`chrome.runtime`、`chrome.tabs`
- 提供一个测试用 `chrome-mock` 模块：`setMockChrome(globalThis)`，各测试独立重置
- 消息协议测试：定义消息 schema，单测收发两端类型一致性（可用 `tsd` 做类型断言）

## 集成测试

- **工具**：Vitest + jsdom 或 happy-dom，模拟完整流程：content 提取 → 消息 → popup 渲染
- 验证消息通路与状态流转（设置修改 → onChanged → UI 更新）
- MV3 Service Worker 逻辑用 `@crxjs` 或手写轻量模拟测试（重点是事件处理与状态恢复）

## E2E（真实浏览器）

- **工具**：Playwright（支持扩展加载：`launchPersistentContext` + `--load-extension`）
- 覆盖场景：
  - 加载已解压扩展并打开 popup
  - 访问真实目标页面，验证 content script 注入与提取
  - 完整用户流：安装 → 操作 → 设置 → 重启浏览器状态保留
- 浏览器矩阵：至少 Chromium 主版本；Firefox 差异单独标注（可选）

## CI 接入

- GitHub Actions / 本地脚本：`lint → typecheck → unit → integration → build`
- E2E 单独 job（耗时），可手动触发
- 构建产物完整性检查：`manifest.json` 字段、图标存在、无远程 URL

## 测试规范

- 测试文件与被测模块同构（`src/lib/storage.ts` → `tests/storage.test.ts`）
- 每个 bug 修复附带回归测试
- 测试命名描述行为而非实现（`should merge default settings with partial input`）
- 覆盖报告：核心逻辑覆盖率 ≥ 80%
