---
name: extension-popup-ui
description: Popup 与 Options UI 开发 skill——popup/options/侧边栏界面、消息展示、设置表单、无框架或轻框架选型、主题一致。制作插件界面时使用。
---

# Popup 与 Options UI 开发

插件界面开发规范（popup / options / side panel）。

## 界面类型与取舍

| 界面 | 用途 | 注意 |
|------|------|------|
| **Popup** | 快速操作、即时反馈 | 空间小，单屏展示；默认宽度 ~320px |
| **Options** | 设置项、数据管理 | 空间大，适合表单与预览 |
| **Side Panel** | 常驻侧栏工具 | Chrome 114+，适合持续型工具 |
| **Badge / Context Menu** | 无界面交互 | 减少 UI 依赖，优先用 |

## 技术选型

- **首选**：原生 TS + 简单状态管理（无框架，包体小、加载快、无构建负担）
- 复杂交互（大列表、表单校验、可排序）再引入轻框架（Preact/Solid/Vue 或 React 按需）
- 样式：CSS 变量定义主题色，深浅色自适应 `prefers-color-scheme`
- 禁止内联脚本（CSP），事件绑定全部走 JS 文件

## 设计规范

- 与页面交互保持**即时反馈**：按钮 loading 态、成功/失败提示（toast）
- 所有 chrome API 调用异步化，popup 打开即拉取最新状态（`chrome.storage` + `onChanged` 监听）
- 空状态设计：无数据时给出引导文案与操作入口
- 文本对齐系统字体栈（`system-ui`），避免打包字体

## 状态与数据流

```
popup 打开 → lib/storage 读取设置 → 渲染
用户操作 → 更新 storage → 广播消息 → content/background 响应
storage.onChanged → popup 监听 → 局部刷新（多窗口同步）
```

- UI 层不直接拼 chrome API 细节，统一走 `lib/storage.ts` / `lib/messages.ts`
- 表单校验在提交前完成，错误提示内联展示

## 可访问性

- 按钮/输入框有 `label` 与 `aria-label`，键盘可操作（Tab/Enter/Escape）
- 颜色对比度达标（文字 4.5:1），不使用纯颜色传达状态
- popup 内滚动区域设置固定高度，避免超出屏幕

## 开发要点

- popup 保持轻量：打开延迟超过 300ms 即视为体验问题
- Options 页可承载数据导入/导出、重置默认值
- 界面文案集中管理（`lib/i18n.ts`），后续可接 `chrome.i18n` 多语言
