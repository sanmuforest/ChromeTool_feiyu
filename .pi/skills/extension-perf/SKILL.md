---
name: extension-perf
description: 性能优化 skill——启动延迟、DOM 操作成本、消息频率、存储读写、Service Worker 效率、Chrome DevTools 用法。优化卡顿或审查性能时使用。
---

# 插件性能优化

插件性能目标：**不拖慢用户浏览体验**，任何页面注入都应是轻量的。

## 性能基线

- popup 打开到可交互 < 300ms
- content script 注入执行 < 50ms（不阻塞页面主线程）
- 后台事件处理 < 100ms（SW 内短任务）
- 包体积：完整加载 < 500KB（gzip），首屏 < 100KB

## 注入成本控制

- content script 只做**必要工作**：先用轻量检查（URL 匹配、元素存在性）短路退出
- 大模块按需注入：用 `chrome.scripting.executeScript` 惰性注入，而非 manifest 静态全量注入
- DOM 批量操作：用 `DocumentFragment` / 一次性 `textContent` 赋值，避免逐节点回流
- `MutationObserver` 回调内做最小处理，高频变化用 rAF/防抖合并

## 消息与存储效率

- **消息节流**：页面变化频繁时，合并发送（如每 500ms 聚合一次），不做逐条 `sendMessage`
- 数据量大时传输用压缩/摘要，content → background 传递原始 DOM 文本是常见瓶颈
- `chrome.storage` 读写异步且慢（序列化），高频访问做内存缓存；写操作防抖合并
- 存储内容瘦身：不存冗余字段，必要时存压缩 JSON

## Service Worker 效率

- SW 空闲即休眠：不要期望常驻状态，用 `chrome.storage.session` 缓存中间状态
- 避免在顶层做重计算，事件到达再干活
- 长任务拆段：大文件处理用分片 + 进度回调，防超时被杀
- 定时任务用 `chrome.alarms`（最小间隔 30s），不用 `setInterval`（SW 休眠即失效）

## 测量方法

- **Chrome DevTools**：
  - Performance 面板录制 content script 执行段
  - Memory 面板检查 content 注入是否内存泄漏（多次导航后对比）
  - popup/options 用 Performance 看 FCP 与交互延迟
- `chrome://extensions` → 检查错误页：定位未捕获异常与消息失败
- 真机场景：用目标站点的真实长页面（如 1000+ 节点）做基准

## 常见性能反模式

- 每个 tab 都注入重型脚本（应改为按需）
- 每帧调用 `sendMessage`（节流缺失）
- 高频 `chrome.storage.get`（应缓存）
- `MutationObserver` 无节流持续触发重算
- 未清理的监听器/观察器（内存泄漏，tab 越开越卡）
