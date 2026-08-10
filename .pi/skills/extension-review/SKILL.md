---
name: extension-review
description: 代码审查 skill——检查 TypeScript 类型安全、消息协议一致性、权限最小化、异步错误处理、MV3 规范合规。审查指定文件或目录时使用。
---

# Chrome 扩展代码审查

审查扩展代码时的检查清单与标准。

## 审查范围

- `manifest.json` 配置
- `src/` 全部源码（background / content / popup / options / lib）
- 构建配置与依赖

## 检查清单

### Manifest 与权限

- [ ] 权限是否最小化？（`activeTab` 优先于 `<all_urls>`，按需声明）
- [ ] `host_permissions` 是否限定到实际需要的主机？
- [ ] CSP 无 `unsafe-eval`、无远程代码引用
- [ ] 图标齐全（16/32/48/128），名称合法

### 类型与消息协议

- [ ] 消息类型集中定义，收发两端类型一致
- [ ] `sendMessage` 返回值错误处理（`chrome.runtime.lastError` / promise reject）
- [ ] 无 `any` 泄漏（尤其跨上下文序列化边界）
- [ ] 存储 schema 有版本号与迁移逻辑

### 异步与生命周期

- [ ] Service Worker 内所有异步操作有兜底（`finally` / 超时）
- [ ] 无泄漏的 `setInterval`（SW 会休眠，需重新注册）
- [ ] 事件监听器在不再需要时移除
- [ ] 长连接（`Port`）有断开清理

### 内容脚本

- [ ] DOM 操作有容错（页面结构变化、元素不存在）
- [ ] 注入的样式带唯一前缀，避免污染页面
- [ ] 不直接访问主世界变量（除非声明式注入必要）
- [ ] `MutationObserver` 有节流/断开逻辑

### 通用

- [ ] 错误信息对用户可读（popup 内展示，不静默）
- [ ] 无 console 调试残留、无 TODO 遗留
- [ ] 无第三方 CDN 依赖（必须打包）
- [ ] 测试覆盖核心逻辑（消息、存储、提取函数）

## 审查输出

按严重级别列出：**阻断**（安全/数据泄漏/崩溃）→ **建议**（性能/可维护性）→ **风格**。每项给出文件与行号、问题说明、修复建议。
