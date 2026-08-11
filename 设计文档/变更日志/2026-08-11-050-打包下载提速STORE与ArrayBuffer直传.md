# 2026-08-11-050 打包下载提速：STORE 压缩 + ArrayBuffer 直传回替代 base64

## 背景（日志实测）

- 并发 48 下（049 生效后）：下载选中 106 张 ~3.2s（通用）/ ~3.4s（imgbb），几乎无差距
- 打包下载 106~112 张仍 5~7s+（首包含 base64 序列化峰值）→ 瓶颈在打包处理链路而非并发

## 根因

1. **base64 跨上下文回传**：grabber → background fetch → ArrayBuffer → `arrayBufferToBase64`（CPU）→ base64 字符串（体积 +33%）→ JSON 序列化过 chrome.runtime 消息通道 → grabber `atob` 解码（CPU）→ 逐字节循环拷贝（CPU）
2. **jszip DEFLATE 压缩**：jpg/png 已是压缩格式，再压缩零收益、纯吃 CPU

## 本次改动

### 1. `src/grabber/image-grab-view.ts`（打包）

- `zip.generateAsync({ type: 'blob' })` → `{ type: 'blob', compression: 'STORE' }`（跳过无效压缩）
- imgbb 分支：`atob + 逐字节拷贝` → 直接 `new Blob([res.data])`（ArrayBuffer 直用）

### 2. `src/background/background.ts`（GRAB_FETCH_IMAGE 响应）

- `arrayBufferToBase64(buf)` → 直接回传 `buf`（ArrayBuffer）
- 移除未再使用的 `arrayBufferToBase64` 导入

### 3. `src/lib/messages.ts`（消息协议，FROZEN 解锁）

- `MessageResponse.data` 类型 `string` → `string | ArrayBuffer`（structured clone 支持 ArrayBuffer 跨上下文传输，单张几 MB 远低于 64MB 上限）

## 生效范围

打包下载（imgbb/通用/buondua 共享组件）全部受益；下载选中路径（data URL 下载）不受影响。

## 风险与回退

- **ArrayBuffer 消息回传实测失败（已回退）**：chrome.runtime.sendMessage 内部为 JSON 序列化，ArrayBuffer 传输后变为空对象 `{}`，导致 zip 内全部条目为空文件（最大 15 字节）
- 已回退为 base64 字符串回传（恢复 `arrayBufferToBase64` + atob 解码），**STORE 压缩保留**

## 回归检查（红线 1 第 3 条）

- `MessageResponse.data` 恢复为 `string`（与 050 前一致）
- `arrayBufferToBase64` 恢复导入（background + downloader 双路径使用）
- 打包 STORE 不影响 zip 结构合法性（标准 ZIP 支持 STORE 方法）

## 验证方式

重新构建 → 重新加载 `dist/` → 同一相册打包：预期 5~7s → 3~4s（与下载选中接近），zip 可正常解压

## 状态

- **方案 2（ArrayBuffer 直传）实测失败已回退**：runtime message 为 JSON 序列化，ArrayBuffer 变空对象，zip 条目全为空文件（用户实测发现，日志 2026/8/11 10:02）
- **方案 1（STORE 压缩）保留有效**
- **回退后验证通过（用户实测）**：龙珠超1（99 张 48.5MB）/ 龙珠超2（112 张 56.4MB）/ 龙珠超4（106 张 47.5MB）zip 全部正常，无空文件、可解压
