---
name: extension-content-scripts
description: 内容脚本技能——页面注入、DOM 提取、隔离世界通信、MutationObserver、样式隔离。开发 content scripts 时使用。
---

# 内容脚本开发

content scripts 是插件与网页交互的桥梁，核心难点是**隔离世界**与**页面变化**。

## 隔离世界（Isolated World）

- content script 运行在隔离世界：可操作 DOM，但访问不到页面 JS 变量/函数
- 与页面主世界的通信方式：
  - **DOM 事件**（`window.postMessage` + 自定义事件）——需要页面脚本配合时
  - **消息通道**（`chrome.runtime.sendMessage`）——与 popup/background 通信
- 默认隔离即安全：不要为了访问页面变量而用 `world: "MAIN"`，除非万不得已

## DOM 提取规范

- 提取逻辑写成**纯函数**（输入 `Document`/`Element`，输出数据），便于单元测试
- 选择器集中定义在常量/配置里，页面改版只改一处
- 所有可选节点判空，缺失时返回缺省值而非抛错
- 数据清洗（去空白、转义、格式化）与 DOM 查询分离

## 页面变化监听

- 动态渲染页面用 `MutationObserver`：
  - 观察目标子树，`childList + subtree`
  - 回调内**节流/防抖**（如 200ms），避免高频触发
  - 处理完记得 `disconnect()`，避免永久占用
- 优先用稳定的锚点（如标题、固定 class），避免依赖无规律 id

## 样式隔离

- 注入样式统一加前缀（如 `.extx-` 或 scoped class）
- 不用全局 `*` 选择器，不覆盖页面关键布局
- 尽量用 shadow DOM（`attachShadow`）彻底隔离，但注意兼容性与可访问性

## 通信协议

```typescript
// content → background：异步请求数据
chrome.runtime.sendMessage({ type: "FETCH_DATA", url: location.href }, cb)
// background → content：广播（如设置变化）
chrome.tabs.sendMessage(tabId, { type: "SETTINGS_CHANGED", settings })
```

- 所有消息类型定义在 `lib/messages.ts`，禁止魔法字符串散落
- content script 发送前检查 `chrome.runtime.id` 是否存在（页面刷新/扩展重载后失效）

## 常见陷阱

- 扩展重载后旧 content script 失效，需刷新页面
- `chrome.tabs.sendMessage` 到无 listener 的 tab 会报错，需 `catch`/`lastError` 检查
- 页面 iframe 内默认不注入 content script（需 `all_frames`），按需求声明
