---
name: extension-prototype
description: 快速原型 skill——用最小代码验证插件核心价值（注入→取数→展示→存储闭环），快速出可手动加载的版本。验证核心机制时使用。
---

# 快速原型

用最小代价验证插件核心价值，先跑通闭环再谈完善。

## 原型目标

验证「**用户痛点 → 功能 → 价值**」是否成立，通常是一个最小闭环：

```
content 脚本取页面数据 → 消息传给 popup → 展示结果 → 存入 chrome.storage → 设置生效
```

## 原型步骤

1. **手工清单优先**：先写 `manifest.json`（最小权限）+ 一个 content script + 一个 popup HTML，直接 `chrome://extensions` 加载验证
2. **数据先于 UI**：先用 `console.log` / `chrome.storage` 打印验证数据提取正确性，再做界面
3. **真实页面测试**：用目标网站真实 DOM 结构测试（临时规则即可，不追求健壮）
4. **权限验证**：确认最小权限能否完成功能，不能则明确需要增加的权限

## 原型模板（最小 MV3）

```json
{
  "manifest_version": 3,
  "name": "原型名",
  "version": "0.1.0",
  "action": { "default_popup": "popup.html" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"]
  }],
  "permissions": ["storage"]
}
```

## 可跳过 / 不可跳过

- **可跳过**：设置页、主题、动画、多语言、图标精修、完整错误处理
- **不可跳过**：核心数据提取、最小权限、消息通路、存储读写、基本错误提示

## 验收标准

- 新用户加载 zip 后 3 分钟内能手动加载并看到核心价值
- 核心函数可脱离浏览器用单测验证（提取/解析函数保持纯函数）
- 明确记录「原型阶段已知缺口」清单，作为正式开发的输入
