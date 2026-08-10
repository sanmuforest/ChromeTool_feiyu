# ⚙️ 后台服务与 API 集成（pi 版）

**一句话：** 实现 Service Worker 后台逻辑与外部 API 集成。

## 激活方式

```
实现后台逻辑：数据聚合、外部 API 调用（fetch 到服务端）、缓存与失败重试、定期任务
```

## 涉及资源

- **Skill**: `extension-dev`（MV3 约束、SW 生命周期）
- **Skill**: `extension-perf`（SW 效率、alarms）

## 产出

- Service Worker 逻辑（事件驱动，状态存 `chrome.storage.session`）
- 外部 API 集成（`host_permissions` 精确化、超时与重试）
- 定时任务（`chrome.alarms` 而非 setInterval）
- 缓存策略（内存 + storage 分级）

## 协作协议

SW 状态不假设常驻；所有异步有兜底；API 密钥等敏感信息不入包（走用户配置或服务端代理）。
