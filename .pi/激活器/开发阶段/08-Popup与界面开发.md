# 🎨 Popup 与界面开发（pi 版）

**一句话：** 实现 popup / options / 侧边栏界面与设置。

## 激活方式

```
按 extension-popup-ui 规范，实现 popup 界面：展示数据、设置表单、深浅色适配、空状态
```

## 涉及资源

- **Skill**: `extension-popup-ui`（界面类型、数据流、可访问性）

## 产出

- popup 界面（数据展示 + 操作入口）
- options 设置页（表单 + 校验 + 数据导出/清除）
- 状态同步（storage.onChanged 多窗口同步）
- 空状态与错误提示

## 协作协议

UI 层不直接拼 chrome API 细节，统一走 lib 封装；先功能后美化。
