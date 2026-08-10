// 站点适配模板页签（空模板，FP-003 预留）
// 用途：未来新增其他站点适配器时的模板入口（当前为空占位）
// 新增站点适配的步骤见下方说明

import { initLogger } from '../lib/logger'

const logger = initLogger('grabber')

export function initTemplateView(root: HTMLElement): void {
  root.innerHTML = `
    <div class="adapters-view">
      <div class="adapter-head">
        <h3>站点适配模板</h3>
        <span class="adapter-hint">空模板 · 为未来站点预留</span>
      </div>
      <div class="empty-tip" style="padding: 40px 20px; text-align: center; color: var(--text-dim); line-height: 1.8;">
        <p>当前没有已注册的站点适配器。</p>
        <p>新增一个站点适配需完成：</p>
        <p style="color: var(--text); font-size: 12px;">
          1. 在 <b>src/lib/imgbb-parse.ts</b> 同类文件中编写该站点的 HTML 解析器<br>
          2. 在 <b>src/background/imgbb-service.ts</b> 同类文件中编写后台抓取服务<br>
          3. 在本页签下新增对应的子标签 UI（参照 imgbb 页签）<br>
          4. 更新 <b>设计文档/模块边界.md</b> 注册新适配器
        </p>
      </div>
    </div>
  `
  logger.info('view', '站点适配模板页已挂载（空模板）')
}
