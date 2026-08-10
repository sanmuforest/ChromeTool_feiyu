# 🏗️ Manifest 与核心架构搭建（pi 版）

**一句话：** 搭建项目骨架：manifest、构建链、消息层与存储层。

## 激活方式

```
按 extension-dev 的规范，初始化项目：manifest.json + Vite/TS 构建 + lib 消息与存储骨架
```

## 涉及资源

- **Skill**: `extension-dev`（MV3 约束、项目结构）
- **Skill**: `extension-security`（权限基线）

## 产出

- `manifest.json`（最小权限版）
- 构建链（Vite/esbuild → `dist/` 可加载）
- `src/lib/messages.ts`、`src/lib/storage.ts`（类型安全骨架）
- 空壳 background / content / popup 入口
- 可 `chrome://extensions` 加载的空插件

## 协作协议

骨架阶段先保证「能加载、能收发消息、能读写存储」，再谈功能。
