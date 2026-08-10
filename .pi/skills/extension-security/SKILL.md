---
name: extension-security
description: 安全与隐私 skill——权限最小化、CSP、数据隔离、XSS 防护、Web Store 合规。审查安全或设计权限模型时使用。
---

# 插件安全与隐私

浏览器插件拥有高权限（可读任意匹配页面、访问存储），安全是底线。

## 权限最小化原则

- 权限清单按「**功能证明制**」审查：每个权限必须对应一个明确功能点
- 常用最小组合：`storage` + `activeTab` + 必要 `host_permissions`
- `host_permissions` 用具体域名（`https://example.com/*`），不用 `<all_urls>`
- 用 `optional_permissions` 延迟申请不常用的权限（如下载、剪贴板）

## 数据安全

- **存储分级**：
  - `chrome.storage.local`：普通设置与缓存
  - `chrome.storage.session`：临时会话数据（SW 重启不丢、关浏览器清）
  - 敏感数据（token、密钥）**不入 storage**，或加密后存储并提示风险
- 收集用户数据必须：明确告知 → 最小收集 → 可删除（设置页提供导出/清除）
- 隐私政策在 Web Store 如实声明

## 注入与 XSS 防护

- **禁止** `innerHTML` 拼接不可信数据；一律 `textContent` / `createElement`
- 数据来自页面（content script 提取的原始文本）时视为**不可信输入**：
  - 展示前转义；不把页面文本直接拼进 HTML 属性
  - 从页面取 URL 时校验协议（`https?`），防 `javascript:` 注入
- CSP 保持 `script-src 'self'`，不引入任何远程脚本

## 通信安全

- 消息校验：`onMessage` 处理器校验 `sender`（`sender.id === chrome.runtime.id`）
- 不用 `window.postMessage` 传递敏感数据（页面可见）
- external 连接（`onConnectExternal`）除非必要，一律不开放
- 处理页面传来的数据时做类型校验（运行时 guard），防畸形数据

## Web Store 合规要点

- 单用途原则：一个插件解决一类问题，不做全家桶
- 无隐藏行为：不收集与功能无关的数据，不偷偷改设置
- 代码可审查：压缩混淆会触发人工审核，保持可读
- 远程内容（配置文件、远程更新逻辑）属于高风险，审核可能被拒

## 安全自查清单

- [ ] manifest 权限无多余项
- [ ] 无 `eval` / `Function()` / 远程脚本
- [ ] 无 `innerHTML` 注入不可信数据
- [ ] 存储无明文敏感数据
- [ ] 消息处理器校验 sender 与消息类型
- [ ] 数据收集有告知、导出、删除途径
