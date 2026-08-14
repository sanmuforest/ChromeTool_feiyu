"use strict";
(() => {
  // src/lib/messages.ts
  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }
  async function sendToTab(tabId, message) {
    try {
      await chrome.tabs.sendMessage(tabId, message);
    } catch {
    }
  }

  // src/lib/storage.ts
  async function storageGet(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  }
  async function storageSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  // src/lib/types.ts
  var LEVEL_ORDER = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40
  };

  // src/lib/logger.ts
  var DEFAULT_LOG_LEVEL = "info";
  var MAX_LOG_ENTRIES = 500;
  var KEY_LOGS = "log_buffer";
  var KEY_LEVEL = "log_level";
  async function getLevel() {
    return await storageGet(KEY_LEVEL) ?? DEFAULT_LOG_LEVEL;
  }
  async function setLevel(level) {
    await storageSet(KEY_LEVEL, level);
    console.info(`[logger] \u65E5\u5FD7\u7B49\u7EA7\u5DF2\u5207\u6362\u4E3A ${level}`);
  }
  async function getEntries() {
    return await storageGet(KEY_LOGS) ?? [];
  }
  async function clearEntries() {
    await storageSet(KEY_LOGS, []);
  }
  async function appendLog(context, level, module, message, data) {
    const currentLevel = await getLevel();
    if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) {
      return;
    }
    const entries = await getEntries();
    const nextId = entries.length > 0 ? Math.max(...entries.map((e) => e.id)) + 1 : 1;
    const entry = { id: nextId, ts: Date.now(), context, level, module, message, data };
    entries.push(entry);
    while (entries.length > MAX_LOG_ENTRIES) {
      entries.shift();
    }
    await storageSet(KEY_LOGS, entries);
    const tag = `[${context}/${module}]`;
    const consoleFn = level === "debug" ? console.debug : level === "warn" ? console.warn : level === "error" ? console.error : console.info;
    consoleFn(tag, message, data ?? "");
  }
  async function sendRemoteLog(context, level, module, message, data) {
    try {
      await sendMessage({ type: "LOG_ADD", level, context, module, message, data });
    } catch (err) {
      console.warn(`[logger] \u65E5\u5FD7\u8F6C\u53D1\u5931\u8D25 (${context}/${module}):`, err);
    }
  }
  function initLogger(context) {
    const write = context === "background" ? (level, module, message, data) => {
      void appendLog(context, level, module, message, data);
    } : (level, module, message, data) => {
      void sendRemoteLog(context, level, module, message, data);
    };
    return {
      debug: (module, message, data) => write("debug", module, message, data),
      info: (module, message, data) => write("info", module, message, data),
      warn: (module, message, data) => write("warn", module, message, data),
      error: (module, message, data) => write("error", module, message, data)
    };
  }

  // src/lib/downloader.ts
  var logger = initLogger("background");
  var DEFAULT_CONCURRENCY = 12;
  var MAX_RETRY = 1;
  var FETCH_TIMEOUT_MS = 4e4;
  async function fetchImageBytes(url, signal) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
          Referer: "https://imgbb.com/"
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = await resp.arrayBuffer();
      logger.debug("download", "imgbb \u5B57\u8282\u6293\u53D6\u5B8C\u6210", { ms: Date.now() - t0, bytes: buf.byteLength });
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const CHUNK = 32768;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }
  async function fetchImgbbViaSrcTab(srcTabId, url) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: srcTabId },
      world: "MAIN",
      func: (imgUrl) => (async () => {
        const resp = await fetch(imgUrl, {
          headers: {
            Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
          }
        });
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const buf = await resp.arrayBuffer();
        return Array.from(new Uint8Array(buf));
      })(),
      args: [url]
    });
    const arr = results?.[0]?.result;
    if (!arr || arr.length === 0) throw new Error("\u9875\u9762\u672A\u8FD4\u56DE\u5B57\u8282");
    return new Uint8Array(arr).buffer;
  }
  var DownloadManager = class {
    constructor(callbacks) {
      this.callbacks = callbacks;
      this.jobs = /* @__PURE__ */ new Map();
      this.active = /* @__PURE__ */ new Map();
      // downloadId → active（下载中）
      this.queue = [];
      this.pendingFetches = /* @__PURE__ */ new Set();
      // jobId → 正在 background fetch（占并发槽）
      this.fetchControllers = /* @__PURE__ */ new Map();
      // jobId → imgbb 字节抓取 controller
      this.jobStartedAt = /* @__PURE__ */ new Map();
      // jobId → 任务启动时刻（汇总统计用）
      this.nextJobId = 1;
      this.maxConcurrent = DEFAULT_CONCURRENCY;
    }
    /** 设置下载并发（1~128），由 background 经 GRAB_SET_CONCURRENCY 调用 */
    setConcurrency(n) {
      this.maxConcurrent = Math.max(1, Math.min(128, Math.round(n) || DEFAULT_CONCURRENCY));
      logger.info("download", "\u4E0B\u8F7D\u5E76\u53D1\u5DF2\u8BBE\u7F6E", { concurrency: this.maxConcurrent });
      this.pump();
    }
    getConcurrency() {
      return this.maxConcurrent;
    }
    start(srcTabId, folderName, items) {
      const job = {
        id: this.nextJobId++,
        srcTabId,
        folderName,
        total: items.length,
        done: 0,
        failed: 0,
        status: "running",
        failedItems: []
      };
      this.jobs.set(job.id, job);
      this.jobStartedAt.set(job.id, Date.now());
      for (const item of items) {
        this.queue.push({ jobId: job.id, item, enqueuedAt: Date.now() });
      }
      this.pump();
      return job;
    }
    get(jobId) {
      return this.jobs.get(jobId);
    }
    cancel(jobId) {
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "running") return;
      job.status = "cancelled";
      this.queue = this.queue.filter((q) => q.jobId !== jobId);
      this.fetchControllers.get(jobId)?.abort();
      this.fetchControllers.delete(jobId);
      for (const [downloadId, a] of this.active) {
        if (a.jobId === jobId) {
          this.active.delete(downloadId);
          void chrome.downloads.cancel(downloadId).catch(() => {
          });
        }
      }
      logger.info("download", "\u4E0B\u8F7D\u5DF2\u53D6\u6D88", { jobId });
      this.emit(job, true);
      this.pump();
    }
    retry(jobId) {
      const job = this.jobs.get(jobId);
      if (!job || job.failedItems.length === 0) return;
      const items = [...job.failedItems];
      job.failedItems = [];
      job.done = 0;
      job.failed = 0;
      job.status = "running";
      for (const item of items) {
        this.queue.push({ jobId, item, enqueuedAt: Date.now() });
      }
      this.emit(job, false);
      this.pump();
    }
    /** 由 chrome.downloads.onChanged 驱动 */
    handleChanged(delta) {
      const state = delta.state?.current;
      if (state !== "complete" && state !== "interrupted") return;
      const active = this.active.get(delta.id);
      if (!active) return;
      this.active.delete(delta.id);
      const job = this.jobs.get(active.jobId);
      if (!job) return;
      if (state === "complete") {
        job.done++;
        logger.debug("download", "\u5355\u9879\u4E0B\u8F7D\u5B8C\u6210", {
          jobId: active.jobId,
          downloadId: delta.id,
          ms: Date.now() - active.startedAt,
          fileSize: delta.fileSize?.current
        });
      } else if (active.attempts < MAX_RETRY) {
        logger.warn("download", "\u4E0B\u8F7D\u4E2D\u65AD\uFF0C\u81EA\u52A8\u91CD\u8BD5", { url: active.item.url, attempt: active.attempts + 1 });
        this.queue.push({ jobId: active.jobId, item: active.item, enqueuedAt: Date.now() });
      } else {
        job.failed++;
        job.failedItems.push({ url: active.item.url, filename: active.item.filename, error: "\u4E0B\u8F7D\u4E2D\u65AD" });
        logger.warn("download", "\u4E0B\u8F7D\u5931\u8D25\uFF08\u91CD\u8BD5\u540E\uFF09", { url: active.item.url });
      }
      this.emit(job, false);
      this.pump();
    }
    pump() {
      while (this.active.size + this.pendingFetches.size < this.maxConcurrent && this.queue.length > 0) {
        const next = this.queue.shift();
        if (!next) break;
        const job = this.jobs.get(next.jobId);
        if (!job || job.status !== "running") continue;
        this.pendingFetches.add(next.jobId);
        void this.startOne(job, next.item, next.enqueuedAt).finally(() => {
          this.pendingFetches.delete(next.jobId);
          this.pump();
        });
      }
      for (const job of this.jobs.values()) {
        if (job.status !== "running") continue;
        const hasQueued = this.queue.some((q) => q.jobId === job.id);
        const hasActive = [...this.active.values()].some((a) => a.jobId === job.id);
        const hasFetch = this.pendingFetches.has(job.id);
        if (!hasQueued && !hasActive && !hasFetch) {
          job.status = "done";
          const totalMs = Date.now() - (this.jobStartedAt.get(job.id) ?? Date.now());
          const avgMs = job.done > 0 ? Math.round(totalMs / job.done) : 0;
          logger.info("download", "\u4E0B\u8F7D\u4EFB\u52A1\u5B8C\u6210", {
            jobId: job.id,
            done: job.done,
            failed: job.failed,
            totalMs,
            avgMsPerItem: avgMs,
            concurrency: this.maxConcurrent
          });
          this.jobStartedAt.delete(job.id);
          this.emit(job, true);
        }
      }
    }
    async startOne(job, item, enqueuedAt) {
      const filename = `${job.folderName}/${item.filename}`;
      logger.debug("download", "\u6D3E\u53D1\u4E0B\u8F7D\u9879", { jobId: job.id, filename: item.filename, queueWaitMs: Date.now() - enqueuedAt });
      try {
        let url = item.url;
        if (/(i\.ibb\.co|ibb\.co)/.test(url)) {
          const tFetch = Date.now();
          const controller = new AbortController();
          this.fetchControllers.set(job.id, controller);
          try {
            const buf = await fetchImgbbViaSrcTab(job.srcTabId, item.url);
            this.fetchControllers.delete(job.id);
            if (job.status !== "running") return;
            url = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
            logger.debug("download", "imgbb \u6E90\u9875\u6CE8\u5165\u8F6C data URL", { jobId: job.id, fetchMs: Date.now() - tFetch, bytes: buf.byteLength });
          } catch (err) {
            this.fetchControllers.delete(job.id);
            if (job.status !== "running") return;
            logger.warn("download", "imgbb \u6E90\u9875\u6CE8\u5165\u5931\u8D25\uFF0C\u964D\u7EA7 background fetch", { url: item.url, error: String(err) });
            try {
              const buf = await fetchImageBytes(item.url, controller.signal);
              this.fetchControllers.delete(job.id);
              if (job.status !== "running") return;
              const tB64 = Date.now();
              url = `data:image/jpeg;base64,${arrayBufferToBase64(buf)}`;
              logger.debug("download", "imgbb \u539F\u56FE\u8F6C data URL", {
                jobId: job.id,
                fetchMs: tB64 - tFetch,
                b64Ms: Date.now() - tB64,
                bytes: buf.byteLength
              });
            } catch (err2) {
              this.fetchControllers.delete(job.id);
              if (job.status !== "running") return;
              logger.warn("download", "imgbb background \u6293\u53D6\u5931\u8D25\uFF0C\u964D\u7EA7\u76F4\u8FDE", { url: item.url, error: String(err2) });
            }
          }
        }
        const tDl = Date.now();
        const downloadId = await chrome.downloads.download({ url, filename });
        this.active.set(downloadId, { jobId: job.id, downloadId, item, attempts: 0, startedAt: Date.now() });
        logger.debug("download", "downloads.download \u5DF2\u53D1\u8D77", { jobId: job.id, downloadId, setupMs: Date.now() - tDl });
      } catch (err) {
        job.failed++;
        job.failedItems.push({ url: item.url, filename: item.filename, error: String(err) });
        this.emit(job, false);
        this.pump();
      }
    }
    emit(job, done) {
      this.callbacks.onUpdate(job, done);
    }
  };

  // src/lib/imgbb-parse.ts
  function extractAttr(tag, name) {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`)) ?? tag.match(new RegExp(`${name}='([^']*)'`));
    return m ? m[1] : null;
  }
  function parseDataObject(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(decodeURIComponent(raw));
    } catch {
      return null;
    }
  }
  function objUrl(obj) {
    if (obj && typeof obj === "object" && "url" in obj) {
      return String(obj.url);
    }
    return "";
  }
  function listItemTags(html, type) {
    const re = new RegExp(`<div class="list-item[^"]*"[^>]*data-type="${type}"[^>]*>`, "g");
    const result = [];
    let m;
    while ((m = re.exec(html)) !== null) {
      result.push({ tag: m[0], end: re.lastIndex });
    }
    return result;
  }
  function blockAfter(html, start) {
    const next = html.slice(start).search(/<div class="list-item(?:\s|")/);
    return next === -1 ? html.slice(start, start + 6e3) : html.slice(start, start + next);
  }
  function parseImageItems(html) {
    const items = [];
    for (const { tag } of listItemTags(html, "image")) {
      const obj = parseDataObject(extractAttr(tag, "data-object"));
      if (!obj) continue;
      const imgObj = obj.image ?? obj;
      if (!imgObj) continue;
      const originalUrl = objUrl(imgObj);
      const mediumUrl = objUrl(obj.medium);
      const thumbUrl = objUrl(obj.thumb);
      if (!originalUrl) continue;
      const user = obj.user;
      items.push({
        id: String(obj.id_encoded ?? extractAttr(tag, "data-id") ?? ""),
        filename: String(imgObj.filename ?? extractAttr(tag, "data-title") ?? ""),
        name: String(imgObj.name ?? extractAttr(tag, "data-title") ?? ""),
        originalUrl,
        mediumUrl: mediumUrl || originalUrl,
        thumbUrl: thumbUrl || mediumUrl || originalUrl,
        width: obj.width ? Number(obj.width) : void 0,
        height: obj.height ? Number(obj.height) : void 0,
        viewerUrl: String(obj.url_viewer ?? ""),
        username: String(user?.username ?? "")
      });
    }
    return items;
  }
  function parseAlbumItems(html) {
    const items = [];
    for (const { tag, end } of listItemTags(html, "album")) {
      const id = extractAttr(tag, "data-id");
      if (!id) continue;
      const name = extractAttr(tag, "data-name") ?? id;
      const block = blockAfter(html, end);
      const coverMatch = block.match(/src="(https?:\/\/i\.ibb\.co\/[^"]*)"/);
      const countMatch = block.match(/data-count="(\d+)"/) ?? block.match(/(\d+)\s*(?:张|张图片|images?)/i);
      items.push({
        id,
        name,
        coverUrl: coverMatch ? coverMatch[1] : "",
        url: `https://ibb.co/album/${id}`,
        imageCount: countMatch ? Number(countMatch[1]) : void 0
      });
    }
    return items;
  }
  function parseUserItems(html) {
    const items = [];
    for (const { end } of listItemTags(html, "user")) {
      const block = blockAfter(html, end);
      const linkMatch = block.match(/href="(https?:\/\/[^"]+?\.imgbb\.com\/)"/);
      const avatarMatch = block.match(/src="(\/\/simgbb\.com\/avatar\/[^"]*)"|src="(https?:\/\/simgbb\.com\/avatar\/[^"]*)"/);
      if (!linkMatch) continue;
      const url = linkMatch[1];
      const usernameMatch = url.match(/https?:\/\/([^.\/]+)\.imgbb\.com/);
      if (!usernameMatch) continue;
      const avatar = avatarMatch ? avatarMatch[1] || avatarMatch[2] : "";
      items.push({
        username: usernameMatch[1],
        url,
        avatarUrl: avatar.startsWith("//") ? `https:${avatar}` : avatar
      });
    }
    return items;
  }
  function isLoginWall(html) {
    return html.includes("<title>Sign in") || html.includes("Sign in \u2014 ImgBB");
  }
  function extractUsername(url) {
    const m = url.match(/https?:\/\/([^.\/]+)\.imgbb\.com/);
    return m ? m[1] : null;
  }
  function parseUsernameFromHtml(html) {
    const m1 = html.match(/"parent_url"%3A%22https%3A%5C%2F%5C%2F([^%]+?)%5C%2F%5C%2F[^"]*\.imgbb\.com%5C%2F/) ?? html.match(/"parent_url":"https:\\\/\\\/([a-zA-Z0-9][\w-]*)\.imgbb\.com\\\//);
    if (m1) return m1[1];
    const m2 = html.match(/breadcrum[^>]*>[\s\S]{0,300}?href="https?:\/\/([a-zA-Z0-9][\w-]*)\.imgbb\.com\//);
    if (m2) return m2[1];
    const m3 = html.match(/"username"%3A%22([^%"]+)%22/) ?? html.match(/"username":"([^"]+)"/);
    if (m3) return m3[1];
    return null;
  }
  function parseAlbumPageTitle(html) {
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    if (h1 && h1[1].trim()) return h1[1].trim();
    const og = html.match(/<meta property="og:title" content="([^"]*)"/);
    if (og && og[1].trim()) return og[1].trim();
    const title = html.match(/<title>([^<]+)<\/title>/);
    if (!title) return null;
    return title[1].replace(/\s*[-—–]\s*ImgBB\s*[-—–]\s*Page\s*\d+\s*$/i, "").replace(/\s*[-—–]\s*ImgBB\s*$/i, "").trim() || null;
  }
  function parseAlbumNextPage(html, baseUrl) {
    const re = /href="([^"]*\?[^"]*page=\d+[^"]*seek=[^"]*)"/g;
    let best = null;
    let bestPage = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      const pageMatch = href.match(/page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 0;
      if (page > bestPage) {
        bestPage = page;
        best = href;
      }
    }
    if (!best) return null;
    try {
      return new URL(best, baseUrl).href;
    } catch {
      return null;
    }
  }

  // src/background/imgbb-diffuse.ts
  var logger2 = initLogger("background");
  var FETCH_TIMEOUT_MS2 = 2e4;
  var DiffuseEngine = class _DiffuseEngine {
    constructor() {
      this.queue = [];
      this.queueSet = /* @__PURE__ */ new Set();
      // 队列内去重（防重复入队）
      this.visited = /* @__PURE__ */ new Set();
      this.inDegree = /* @__PURE__ */ new Map();
      this.startUser = "";
      this.started = false;
      this.totalRequests = 0;
      this.consecutive429 = 0;
      this.inBatchProcessed = 0;
      this.inBatchSize = 0;
      this.inBatchFailed = 0;
      this.recentLog = [];
    }
    static {
      this.LOG_MAX = 200;
    }
    /** 序列化当前状态（storage.session 保存用） */
    save() {
      return {
        queue: [...this.queue],
        visited: [...this.visited],
        inDegree: Object.fromEntries(this.inDegree),
        startUser: this.startUser,
        totalRequests: this.totalRequests,
        consecutive429: this.consecutive429,
        recentLog: [...this.recentLog]
      };
    }
    /** 从持久化状态恢复（SW 重启后续跑） */
    restore(state) {
      this.queue = [...state.queue];
      this.queueSet = new Set(state.queue);
      this.visited = new Set(state.visited);
      this.inDegree = new Map(Object.entries(state.inDegree ?? {}));
      this.startUser = state.startUser;
      this.started = true;
      this.totalRequests = state.totalRequests ?? 0;
      this.consecutive429 = state.consecutive429 ?? 0;
      this.recentLog = [...state.recentLog ?? []];
      this.inBatchProcessed = 0;
      this.inBatchSize = 0;
      this.inBatchFailed = 0;
    }
    /** 是否已有活动扩散（started 且有状态） */
    isActive() {
      return this.started;
    }
    log(text) {
      this.recentLog.push(text);
      if (this.recentLog.length > _DiffuseEngine.LOG_MAX) this.recentLog.shift();
    }
    /** 开始新扩散：重置状态机 */
    start(startUser) {
      const user = startUser.trim().toLowerCase();
      this.queue = [user];
      this.queueSet = /* @__PURE__ */ new Set([user]);
      this.visited = /* @__PURE__ */ new Set();
      this.inDegree = /* @__PURE__ */ new Map();
      this.startUser = user;
      this.started = true;
      this.totalRequests = 0;
      this.consecutive429 = 0;
      this.inBatchProcessed = 0;
      this.inBatchSize = 0;
      this.inBatchFailed = 0;
      this.recentLog = [];
      this.log(`\u25B6 \u6269\u6563\u542F\u52A8\uFF1A\u8D77\u70B9 ${user}`);
      logger2.info("diffuse", "\u6269\u6563\u5DF2\u542F\u52A8", { startUser: user });
    }
    /** 处理一批（取队列前 batchSize，批内并发 + 间隔） */
    async processBatch(batchSize, concurrency, intervalMs) {
      if (!this.started || this.queue.length === 0) {
        return this.result(0, 0, true);
      }
      const batch = this.queue.splice(0, batchSize);
      for (const u of batch) this.queueSet.delete(u);
      this.inBatchProcessed = 0;
      this.inBatchSize = batch.length;
      this.inBatchFailed = 0;
      const tStart = Date.now();
      const requestTimes = [];
      let cursor = 0;
      let failed = 0;
      let newUsers = 0;
      const inDegreeDelta = {};
      const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= batch.length) return;
          const user = batch[idx];
          this.totalRequests++;
          await sleep2(intervalMs);
          const tReq = Date.now();
          try {
            const html = await this.fetchFollowingPage(user);
            const targets = parseUserItems(html);
            for (const t of targets) {
              const name = t.username.toLowerCase();
              this.inDegree.set(name, (this.inDegree.get(name) ?? 0) + 1);
              inDegreeDelta[name] = (inDegreeDelta[name] ?? 0) + 1;
              if (!this.visited.has(name) && !this.queueSet.has(name)) {
                this.queue.push(name);
                this.queueSet.add(name);
                newUsers++;
              }
            }
            this.consecutive429 = 0;
            this.log(`\u2713 ${user}\uFF1A\u53D1\u73B0 ${targets.length} \u4E2A\u5173\u6CE8\uFF08\u65B0 ${newUsers}\uFF09`);
          } catch (err) {
            failed++;
            this.inBatchFailed++;
            const msg = String(err);
            if (msg.includes("429")) {
              this.consecutive429++;
              if (this.consecutive429 >= 3) {
                logger2.warn("diffuse", "\u8FDE\u7EED 429\uFF0C\u5EFA\u8BAE\u6682\u505C 30s \u518D\u7EE7\u7EED", { count: this.consecutive429 });
              }
            }
            this.log(`\u2717 ${user}\uFF1A\u5931\u8D25\uFF08${msg.slice(0, 60)}\uFF09`);
            logger2.warn("diffuse", "\u7528\u6237 following \u6293\u53D6\u5931\u8D25\uFF08\u8DF3\u8FC7\uFF09", { user, error: msg });
          } finally {
            this.visited.add(user);
            this.inBatchProcessed++;
            requestTimes.push(Date.now() - tReq);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, () => worker()));
      const durationMs = Date.now() - tStart;
      const avgRequestMs = requestTimes.length > 0 ? Math.round(requestTimes.reduce((a, b) => a + b, 0) / requestTimes.length) : 0;
      const done = this.queue.length === 0;
      const result = this.result(batch.length, failed, done);
      result.newUsers = newUsers;
      result.inDegreeDelta = inDegreeDelta;
      result.durationMs = durationMs;
      result.avgRequestMs = avgRequestMs;
      logger2.info("diffuse", "\u6279\u6B21\u5B8C\u6210", {
        processed: result.processed,
        newUsers,
        queueSize: result.queueSize,
        failed,
        durationMs,
        avgRequestMs,
        totalRequests: this.totalRequests
      });
      return result;
    }
    /** 会话快照（进度展示） */
    snapshot() {
      const top = [...this.inDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([username, inDegree]) => ({ username, inDegree }));
      const users = [...this.inDegree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200).map(([username, inDegree]) => ({ username, inDegree }));
      return {
        startUser: this.startUser,
        queueSize: this.queue.length,
        visitedTotal: this.visited.size,
        inDegreeSize: this.inDegree.size,
        totalRequests: this.totalRequests,
        inBatchProcessed: this.inBatchProcessed,
        inBatchSize: this.inBatchSize,
        inBatchFailed: this.inBatchFailed,
        consecutive429: this.consecutive429,
        recentLog: [...this.recentLog],
        users,
        userTotal: this.inDegree.size,
        top
      };
    }
    get totalRequestCount() {
      return this.totalRequests;
    }
    get is429Throttled() {
      return this.consecutive429 >= 3;
    }
    result(processed, failed, done) {
      return {
        processed,
        newUsers: 0,
        queueSize: this.queue.length,
        inDegreeDelta: {},
        failed,
        visitedTotal: this.visited.size,
        done,
        durationMs: 0,
        avgRequestMs: 0
      };
    }
    async fetchFollowingPage(username) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS2);
      try {
        const resp = await fetch(`https://${username}.imgbb.com/following`, {
          credentials: "include",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            Referer: "https://imgbb.com/"
          },
          signal: controller.signal
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}\uFF08${username}\uFF09`);
        return await resp.text();
      } finally {
        clearTimeout(timer);
      }
    }
  };

  // src/lib/producer-db.ts
  var PRODUCER_DB_KEY = "producer_db";
  var PRODUCER_DB_VERSION = 1;
  var DEFAULT_SCORE_W1 = 0.6;
  var DEFAULT_SCORE_W2 = 0.4;
  function emptyDb() {
    return { version: PRODUCER_DB_VERSION, updatedAt: Date.now(), entries: {} };
  }
  function loadDb(raw) {
    if (raw && typeof raw === "object" && typeof raw.entries === "object") {
      const entries = raw.entries;
      const cleaned = {};
      for (const [k, v] of Object.entries(entries)) {
        if (v && typeof v.username === "string" && typeof v.inDegree === "number") {
          cleaned[k] = v;
        }
      }
      return { version: PRODUCER_DB_VERSION, updatedAt: Date.now(), entries: cleaned };
    }
    return emptyDb();
  }
  function mergeInDegree(db, delta, source, now = Date.now()) {
    const entries = { ...db.entries };
    for (const [username, inc] of Object.entries(delta)) {
      const prev = entries[username];
      if (prev) {
        entries[username] = {
          ...prev,
          inDegree: prev.inDegree + inc,
          lastSeenAt: now,
          sources: prev.sources.includes(source) ? prev.sources : [...prev.sources, source].slice(-20)
        };
      } else {
        entries[username] = { username, inDegree: inc, firstSeenAt: now, lastSeenAt: now, sources: [source] };
      }
    }
    return { ...db, updatedAt: now, entries };
  }
  function mergeDb(target, incoming) {
    const merged = { ...target.entries };
    for (const [username, entry] of Object.entries(incoming.entries)) {
      const prev = merged[username];
      if (prev) {
        merged[username] = {
          username,
          inDegree: prev.inDegree + entry.inDegree,
          firstSeenAt: Math.min(prev.firstSeenAt, entry.firstSeenAt),
          lastSeenAt: Math.max(prev.lastSeenAt, entry.lastSeenAt),
          sources: Array.from(/* @__PURE__ */ new Set([...prev.sources, ...entry.sources])).slice(-20),
          albumCount: entry.albumCount ?? prev.albumCount,
          albumsChecked: prev.albumsChecked || entry.albumsChecked || void 0,
          albums: entry.albums ?? prev.albums
        };
      } else {
        merged[username] = { ...entry };
      }
    }
    return { ...target, updatedAt: Date.now(), entries: merged };
  }
  function logNorm(x, max) {
    if (max <= 0 || x <= 0) return 0;
    return Math.log(1 + x) / Math.log(1 + max);
  }
  function computeScore(entry, maxInDegree, maxAlbumCount, w1 = DEFAULT_SCORE_W1, w2 = DEFAULT_SCORE_W2) {
    const albumCount = entry.albumsChecked ? entry.albumCount ?? 0 : 0;
    return w1 * logNorm(entry.inDegree, maxInDegree) + w2 * logNorm(albumCount, maxAlbumCount);
  }
  function collectStats(db) {
    let maxInDegree = 0;
    let maxAlbumCount = 0;
    for (const e of Object.values(db.entries)) {
      if (e.inDegree > maxInDegree) maxInDegree = e.inDegree;
      if ((e.albumCount ?? 0) > maxAlbumCount) maxAlbumCount = e.albumCount ?? 0;
    }
    return { maxInDegree, maxAlbumCount };
  }
  function dbSummary(db) {
    let producers = 0;
    let confirmed = 0;
    let maxInDegree = 0;
    for (const e of Object.values(db.entries)) {
      if (e.inDegree > maxInDegree) maxInDegree = e.inDegree;
      if (e.albumCount && e.albumCount > 0) producers++;
      if (e.albumsChecked) confirmed++;
    }
    return { total: Object.keys(db.entries).length, producers, confirmed, maxInDegree };
  }
  function inDegreeDist(db) {
    const buckets = [
      { label: "1", min: 1, max: 1 },
      { label: "2~5", min: 2, max: 5 },
      { label: "6~10", min: 6, max: 10 },
      { label: "11~50", min: 11, max: 50 },
      { label: "51~200", min: 51, max: 200 },
      { label: "200+", min: 201, max: Infinity }
    ];
    const counts = buckets.map(() => 0);
    for (const e of Object.values(db.entries)) {
      const idx = buckets.findIndex((b) => e.inDegree >= b.min && e.inDegree <= b.max);
      if (idx >= 0) counts[idx]++;
    }
    return buckets.map((b, i) => ({ label: b.label, count: counts[i] }));
  }
  function scoreTop(db, n, w1, w2) {
    const { maxInDegree, maxAlbumCount } = collectStats(db);
    return Object.values(db.entries).map((e) => ({
      username: e.username,
      url: `https://${e.username}.imgbb.com`,
      inDegree: e.inDegree,
      albumCount: e.albumsChecked ? e.albumCount : void 0,
      score: computeScore(e, maxInDegree, maxAlbumCount, w1, w2),
      truncated: e.albumsTruncated
    })).sort((a, b) => b.score - a.score).slice(0, Math.max(0, n));
  }
  function degreeTop(db, n) {
    return Object.values(db.entries).sort((a, b) => b.inDegree - a.inDegree).slice(0, Math.max(0, n)).map((e) => ({ username: e.username, url: `https://${e.username}.imgbb.com`, inDegree: e.inDegree }));
  }
  function albumTop(db, n) {
    return Object.values(db.entries).filter((e) => e.albumsChecked && (e.albumCount ?? 0) > 0).sort((a, b) => (b.albumCount ?? 0) - (a.albumCount ?? 0)).slice(0, Math.max(0, n)).map((e) => ({ username: e.username, url: `https://${e.username}.imgbb.com`, albumCount: e.albumCount ?? 0, inDegree: e.inDegree, truncated: e.albumsTruncated }));
  }
  function unconfirmedCandidates(db, n, order = "inDegree", w1 = DEFAULT_SCORE_W1, w2 = DEFAULT_SCORE_W2) {
    const list = Object.values(db.entries).filter((e) => !e.albumsChecked);
    if (order === "newest") {
      list.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    } else if (order === "score") {
      const { maxInDegree, maxAlbumCount } = collectStats(db);
      list.sort(
        (a, b) => computeScore(b, maxInDegree, maxAlbumCount, w1, w2) - computeScore(a, maxInDegree, maxAlbumCount, w1, w2)
      );
    } else {
      list.sort((a, b) => b.inDegree - a.inDegree);
    }
    return list.slice(0, Math.max(0, n));
  }
  function unconfirmedCount(db) {
    let n = 0;
    for (const e of Object.values(db.entries)) if (!e.albumsChecked) n++;
    return n;
  }
  function confirmedScored(db, w1, w2) {
    const { maxInDegree, maxAlbumCount } = collectStats(db);
    return Object.values(db.entries).filter((e) => e.albumsChecked && (e.albumCount ?? 0) > 0).map((e) => ({ ...e, score: computeScore(e, maxInDegree, maxAlbumCount, w1, w2) })).sort((a, b) => b.score - a.score);
  }
  function resetConfirmations(db) {
    const entries = {};
    for (const [k, e] of Object.entries(db.entries)) {
      const { albumsChecked, albumCount, albums, albumsTruncated, ...rest } = e;
      entries[k] = rest;
    }
    return { ...db, updatedAt: Date.now(), entries };
  }
  function matchAlbums(entry, keywords) {
    if (keywords.length === 0 || !entry.albums) return [];
    return entry.albums.filter((a) => keywords.some((k) => a.name.toLowerCase().includes(k)));
  }

  // src/lib/github-sync.ts
  var DEFAULT_GITHUB_FILE = "imgbb-producers.json";
  var GITHUB_CONFIG_KEY = "github_config";
  function normalizeConfig(raw) {
    if (!raw?.repo || !raw?.token) return null;
    return {
      repo: raw.repo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""),
      token: raw.token.trim(),
      branch: raw.branch?.trim() || "main",
      file: raw.file?.trim() || DEFAULT_GITHUB_FILE
    };
  }
  var GithubSyncError = class extends Error {
    constructor(message) {
      super(message);
      this.name = "GithubSyncError";
    }
  };
  async function ghFetch(config, url, init) {
    return fetch(url, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...init?.headers
      }
    });
  }
  async function pullDb(config) {
    const url = `https://api.github.com/repos/${config.repo}/contents/${config.file}?ref=${encodeURIComponent(config.branch)}`;
    const resp = await ghFetch(config, url);
    if (resp.status === 404) {
      return { db: null, sha: null, message: "\u8FDC\u7A0B\u6587\u4EF6\u4E0D\u5B58\u5728\uFF08\u9996\u6B21\u63A8\u9001\u5C06\u521B\u5EFA\uFF09" };
    }
    if (!resp.ok) {
      throw new GithubSyncError(`\u62C9\u53D6\u5931\u8D25 HTTP ${resp.status}\uFF1A${(await resp.text()).slice(0, 200)}`);
    }
    const json = await resp.json();
    if (!json.content) {
      return { db: null, sha: json.sha, message: "\u8FDC\u7A0B\u6587\u4EF6\u4E3A\u7A7A" };
    }
    const raw = json.encoding === "base64" ? decodeUtf8Base64(json.content) : json.content;
    let db;
    try {
      db = JSON.parse(raw);
    } catch {
      throw new GithubSyncError("\u8FDC\u7A0B\u6587\u4EF6\u4E0D\u662F\u5408\u6CD5 JSON");
    }
    return { db, sha: json.sha, message: "\u62C9\u53D6\u6210\u529F" };
  }
  async function pushDb(config, db, sha) {
    const url = `https://api.github.com/repos/${config.repo}/contents/${config.file}`;
    const body = {
      message: `producer-db sync ${(/* @__PURE__ */ new Date()).toISOString().slice(0, 19)}`,
      content: encodeUtf8Base64(JSON.stringify(db, null, 1)),
      branch: config.branch,
      ...sha ? { sha } : {}
    };
    const resp = await ghFetch(config, url, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 409) {
        throw new GithubSyncError("\u63A8\u9001\u51B2\u7A81\uFF08\u8FDC\u7A0B\u5DF2\u66F4\u65B0\uFF09\uFF0C\u8BF7\u5148\u300C\u62C9\u53D6\u5408\u5E76\u300D\u518D\u63A8\u9001");
      }
      throw new GithubSyncError(`\u63A8\u9001\u5931\u8D25 HTTP ${resp.status}\uFF1A${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    return { sha: json.content?.sha ?? null, message: "\u63A8\u9001\u6210\u529F" };
  }
  function encodeUtf8Base64(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }
  function decodeUtf8Base64(b64) {
    return decodeURIComponent(escape(atob(b64)));
  }

  // src/lib/tag-extract.ts
  var TAG_MIN_ALBUMS = 10;
  var TAG_MIN_USERS = 2;
  var TAG_DEFAULT_TOP = 100;
  var BRANDS = [
    "tokyo hot",
    "pornbox",
    "jav",
    "spermmania",
    "pacific girls",
    "pacificgirls",
    "blacksonblondes",
    "fellatiojapan",
    "dpdiva",
    "\u79C0\u4EBA\u7F51",
    "ugirls",
    "miko\u9171",
    "little red",
    "popdaily"
  ];
  var THEMES = /* @__PURE__ */ new Set([
    "\u857E\u59C6",
    "\u62C9\u59C6",
    "\u539F\u795E",
    "\u78A7\u84DD\u822A\u7EBF",
    "\u96F7\u7535\u5C06\u519B",
    "\u80E1\u6843",
    "\u7518\u96E8",
    "\u521D\u97F3",
    "\u660E\u65E5\u65B9\u821F",
    "fgo",
    "\u8D5B\u9A6C\u5A18",
    "\u8230\u5A18",
    "fate",
    "\u841D\u8389",
    "\u5FA1\u59D0",
    "\u6E29\u6CC9",
    "\u6D74\u8863",
    "\u5C45\u5BB6",
    "\u5065\u8EAB",
    "\u8FD0\u52A8",
    "\u5723\u8BDE",
    "\u65B0\u5E74",
    "\u751F\u65E5",
    "\u60C5\u4FA3",
    "\u95FA\u871C",
    "\u53CC\u4EBA",
    "\u59D0\u59B9",
    "\u6D77\u8FB9",
    "\u6C99\u6EE9",
    "\u6CF3\u6C60",
    "\u9152\u5E97",
    "\u6559\u5BA4",
    "\u529E\u516C\u5BA4",
    "\u5929\u53F0",
    "\u591C\u666F",
    "\u96E8\u5929",
    "\u96EA\u5730"
  ]);
  var CLOTHES_CN = /* @__PURE__ */ new Set([
    "\u9ED1\u4E1D",
    "\u767D\u4E1D",
    "\u4E1D\u889C",
    "\u6E14\u7F51\u889C",
    "\u8FC7\u819D\u889C",
    "\u889C",
    "\u5236\u670D",
    "\u4F53\u64CD\u670D",
    "\u6C34\u624B\u670D",
    "\u6821\u670D",
    "\u6CF3\u88C5",
    "\u6BD4\u57FA\u5C3C",
    "\u6B7B\u5E93\u6C34",
    "\u6C49\u670D",
    "\u65D7\u888D",
    "\u5A5A\u7EB1",
    "\u5154\u5973\u90CE",
    "\u5973\u4EC6",
    "\u62A4\u58EB\u88C5",
    "\u62A4\u58EB",
    "\u732B\u8033",
    "\u5154\u8033",
    "\u53E4\u88C5",
    "\u548C\u670D",
    "\u6D74\u8863",
    "\u809A\u515C",
    "\u7761\u8863",
    "\u5185\u8863",
    "\u857E\u4E1D",
    "\u900F\u660E",
    "\u8584\u7EB1",
    "\u7EB1\u88D9",
    "\u540A\u5E26",
    "\u7D27\u8EAB\u8863",
    "\u7D27\u8EAB",
    "\u8FDE\u4F53",
    "\u80F6\u8863",
    "\u76AE\u8863",
    "\u76AE\u88E4",
    "\u76AE\u88D9",
    "\u6E14\u7F51",
    "\u77ED\u88E4",
    "\u70ED\u88E4",
    "\u957F\u88D9",
    "\u77ED\u88D9",
    "\u8FF7\u4F60\u88D9",
    "\u767E\u8936\u88D9",
    "\u5305\u81C0\u88D9",
    "\u886C\u886B",
    "\u767D\u886C\u886B",
    "\u536B\u8863",
    "\u6BDB\u8863",
    "\u9488\u7EC7",
    "\u98CE\u8863",
    "\u5927\u8863",
    "\u6597\u7BF7",
    "\u9886\u5E26",
    "\u9886\u7ED3",
    "\u8774\u8776\u7ED3",
    "\u957F\u9774",
    "\u77ED\u9774",
    "\u9A6C\u4E01\u9774",
    "\u9AD8\u8DDF\u978B",
    "\u51C9\u978B",
    "\u88F8\u8DB3",
    "\u7389\u8DB3",
    "\u624B\u5957",
    "\u8D1D\u96F7\u5E3D",
    "\u68D2\u7403\u5E3D",
    "\u9762\u5177",
    "\u9762\u7EB1",
    "\u5934\u7EB1",
    "\u56F4\u5DFE",
    "\u4E1D\u5DFE",
    "\u88E4\u889C",
    "\u8FDE\u88E4\u889C",
    "\u540A\u5E26\u889C",
    "\u957F\u889C",
    "\u4E2D\u7B52\u889C",
    "\u77ED\u889C",
    "\u8239\u889C",
    "\u5206\u8DBE\u889C"
  ]);
  var CLOTHES_EN = /* @__PURE__ */ new Set(["ol", "jk", "lolita", "latex", "cosplay", "t"]);
  var STOP = /* @__PURE__ */ new Set([
    "model",
    "models",
    "original",
    "premade",
    "custom",
    "latepost",
    "goddess",
    "goddes",
    "feed",
    "photo",
    "photos",
    "pic",
    "pics",
    "set",
    "sets",
    "collection",
    "vol",
    "vols",
    "part",
    "full",
    "hd",
    "uhd",
    "4k",
    "uncensored",
    "censored",
    "preview",
    "gallery",
    "album",
    "video",
    "videos",
    "update",
    "new",
    "exclusive",
    "bts",
    "cover",
    "cos",
    "irl",
    "ootd",
    "\u5199\u771F",
    "\u753B\u50CF",
    "\u7167\u7247",
    "\u56FE\u7247",
    "\u56FE\u96C6",
    "\u56FE\u5305",
    "\u5957\u56FE",
    "\u5408\u96C6",
    "\u7CFB\u5217",
    "\u9884\u89C8",
    "\u65E0\u7801",
    "\u6709\u7801",
    "\u62CD\u6444",
    "\u4F5C\u54C1",
    "\u798F\u5229",
    "\u65E5\u5E38",
    "\u751F\u6D3B",
    "\u6742\u56FE",
    "\u7F8E\u5973",
    "\u58C1\u7EB8",
    "\u81EA\u62CD",
    "\u5B9A\u5236",
    "\u7D27\u6025\u4F01\u5212",
    "\u65E0\u6C34\u5370",
    "\u798F\u5229\u59EC",
    "\u6A21\u7279",
    "sexy",
    "random",
    "my",
    "the",
    "girl",
    "asian",
    "chinese",
    "tits",
    "feb",
    "prompt",
    "deleted",
    "test shoots",
    "may",
    "various",
    "onlyfans",
    "amateur",
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
    "photobook",
    "pure",
    "media",
    "expensive",
    "delicious",
    "naked",
    "overseas",
    "last",
    "stop",
    "love",
    "style",
    "cute",
    "pretty",
    "beauty",
    "beautiful",
    "photoshoot",
    "digital",
    "series",
    "official",
    "hardcore",
    "softcore",
    "photography",
    "\uC139\uC2DC",
    "\uC0AC\uC9C4",
    "\uBAA8\uC74C",
    "\uD654\uBCF4",
    "\uB514\uC9C0\uD138",
    "\uD558\uC774\uD004\uB9AC\uD2F0",
    "\uD648\uD2B8\uB808\uC774\uB2DD",
    "\uBE68\uB798",
    "\uC0E4\uC6CC",
    "\uC218\uC601",
    "\uCC28\uC6D0",
    "\uB208\uBE5B",
    "\uCC98\uC74C",
    "\uC5B4\uC82F\uBC24",
    "\uC11C\uC6B8",
    "\uBC24",
    "\uB9E4\uD639",
    "\uC5EC\uC790",
    "\uB0A8\uC790",
    "\uC0AC\uC9C4\uC9D1",
    "\uB514\uC9C0\uD138\uD654\uBCF4"
  ]);
  var PINYIN_MERGE = {
    "wang yu chun": "\u738B\u96E8\u7EAF",
    "xia mei jiang": "\u590F\u7F8E\u9171",
    "huang le ran": "\u9EC4\u697D\u7136",
    "li ke ke": "\u674E\u53EF\u53EF"
  };
  function cleanEmoji(s) {
    return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}\u{2B06}\u{2B07}\u{25B6}\u{25C0}]/gu, " ");
  }
  function extractTags(raw) {
    let s = cleanEmoji(raw).replace(/&amp;/g, "&");
    const tags = [];
    s = s.replace(/@([a-zA-Z0-9_]+)/g, (_m, u) => {
      tags.push({ t: "@" + u, c: "at" });
      return " ";
    });
    for (const b of BRANDS) {
      if (s.toLowerCase().startsWith(b.toLowerCase())) {
        tags.push({ t: b.toLowerCase(), c: "brand" });
        s = s.slice(b.length);
        break;
      }
    }
    s = s.replace(/E\d{2,4}/gi, " ").replace(/-\d{2,4}/g, " ").replace(/\d+/g, " ");
    for (const b of BRANDS) s = s.replace(new RegExp(b, "ig"), " ");
    for (const part of s.split(/[,&;()]|[(（)]/).map((p) => p.trim()).filter(Boolean)) {
      for (const m of part.match(/[\uac00-\ud7af]{2,}/g) ?? []) {
        if (!STOP.has(m)) tags.push({ t: m, c: "korean" });
      }
      const jap = part.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g);
      if (jap) {
        for (const j of jap) if (j.length >= 2 && !STOP.has(j)) tags.push({ t: j, c: THEMES.has(j) ? "theme" : "japanese" });
      }
      const en = part.split(/[\s\-]+/).filter((w) => /^[A-Z][a-z']{1,}$/.test(w) && !STOP.has(w.toLowerCase()));
      if (en.length >= 1) {
        const name = en.join(" ").toLowerCase();
        if (name.length >= 2 && name.length <= 40) {
          tags.push({ t: name, c: THEMES.has(en.length === 1 ? en[0].toLowerCase() : "") ? "theme" : "english" });
        }
      }
    }
    return tags;
  }
  function extractClothes(raw) {
    const lower = raw.toLowerCase();
    const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
    const hit = /* @__PURE__ */ new Set();
    for (const c of CLOTHES_CN) if (raw.includes(c)) hit.add(c);
    for (const c of CLOTHES_EN) if (tokens.has(c)) hit.add(c);
    return [...hit].map((c) => ({ t: c, c: "clothes" }));
  }
  function computeTags(entries, topN = TAG_DEFAULT_TOP) {
    const total = /* @__PURE__ */ new Map();
    const users = /* @__PURE__ */ new Map();
    const catOf = /* @__PURE__ */ new Map();
    for (const e of entries) {
      if (!e.albums) continue;
      for (const a of e.albums) {
        const tags = [...extractTags(a.name), ...extractClothes(a.name)];
        for (const { t, c } of tags) {
          total.set(t, (total.get(t) ?? 0) + 1);
          if (!users.has(t)) users.set(t, /* @__PURE__ */ new Set());
          users.get(t).add(e.username);
          if (!catOf.has(t)) catOf.set(t, c);
        }
      }
    }
    const merged = /* @__PURE__ */ new Map();
    for (const [t, c] of catOf) {
      const albums = total.get(t) ?? 0;
      const uc = users.get(t)?.size ?? 0;
      if (albums < TAG_MIN_ALBUMS || uc < TAG_MIN_USERS) continue;
      const cn = PINYIN_MERGE[t];
      const k = cn && merged.has(cn) ? cn : t;
      const prev = merged.get(k);
      if (prev) {
        prev.albums += albums;
        prev.users = Math.max(prev.users, uc);
      } else {
        merged.set(k, { t: k, c, albums, users: uc });
      }
    }
    return [...merged.values()].sort((a, b) => b.albums - a.albums).slice(0, Math.max(0, topN));
  }

  // src/background/imgbb-service.ts
  var logger3 = initLogger("background");
  var LoginWallError = class extends Error {
    constructor() {
      super("\u9875\u9762\u9700\u8981\u767B\u5F55\uFF08imgbb \u767B\u5F55\u5899\uFF09");
      this.name = "LoginWallError";
    }
  };
  var FETCH_TIMEOUT_MS3 = 2e4;
  var CONCURRENCY = 6;
  var ImgbbService = class {
    /** fetch 单个页面 HTML，检测登录墙 */
    async fetchHtml(url) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS3);
        const resp = await fetch(url, {
          credentials: "include",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            Referer: "https://imgbb.com/"
          },
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}\uFF08${url}\uFF09`);
        }
        const html = await resp.text();
        if (isLoginWall(html)) {
          throw new LoginWallError();
        }
        return html;
      } catch (err) {
        if (err instanceof LoginWallError) throw err;
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${url}\uFF09`);
        }
        throw err;
      }
    }
    /** 相册详情：跟随 seek 游标翻页抓取相册内全部图片（imgbb 无尽滚动，每页返回累计内容）+ 相册名 */
    async fetchAlbumImages(albumUrl) {
      const base = albumUrl.split("?")[0];
      let currentUrl = base;
      const seen = /* @__PURE__ */ new Map();
      let name = "";
      let page = 0;
      const MAX_PAGES = 20;
      while (currentUrl && page < MAX_PAGES) {
        const html = await this.fetchHtml(currentUrl);
        if (!name) name = parseAlbumPageTitle(html) ?? "";
        const images2 = parseImageItems(html);
        let added = 0;
        for (const img of images2) {
          if (!seen.has(img.originalUrl)) {
            seen.set(img.originalUrl, img);
            added++;
          }
        }
        logger3.info("imgbb", "\u76F8\u518C\u5206\u9875\u6293\u53D6", { page: page + 1, url: currentUrl, pageImages: images2.length, unique: seen.size, added });
        const next = parseAlbumNextPage(html, base);
        if (!next || next === currentUrl) break;
        if (page + 1 >= MAX_PAGES || images2.length > 0 && added === 0 && seen.size >= images2.length) break;
        currentUrl = next;
        page++;
      }
      const images = [...seen.values()];
      logger3.info("imgbb", "\u76F8\u518C\u5168\u91CF\u6293\u53D6\u5B8C\u6210", { url: albumUrl, pages: page + 1, count: images.length, name });
      return { images, name };
    }
    /** 用户主页/相册页：按页抓取图片
     * imgbb 无尽滚动：裸 ?page=N 不可靠（每页返回累计内容），必须跟随 seek 游标逐页翻
     * 因 seek 为连续游标无法直接跳页，pageFrom>1 时仍从首页跟随翻页，仅收集 pageFrom~pageTo 区间增量
     * 去重键：原图 URL（对齐 fetchAlbumImages） */
    async fetchGalleryPages(url, pageFrom, pageTo) {
      const base = url.split("?")[0];
      let currentUrl = base;
      const seen = /* @__PURE__ */ new Set();
      const all = [];
      let page = 1;
      while (currentUrl && page <= pageTo) {
        const html = await this.fetchHtml(currentUrl);
        const images = parseImageItems(html);
        if (page >= pageFrom) {
          for (const img of images) {
            if (!seen.has(img.originalUrl)) {
              seen.add(img.originalUrl);
              all.push(img);
            }
          }
        } else {
          for (const img of images) seen.add(img.originalUrl);
        }
        if (images.length === 0) break;
        const next = parseAlbumNextPage(html, base);
        if (!next || next === currentUrl) break;
        currentUrl = next;
        page++;
      }
      logger3.info("imgbb", "\u7528\u6237\u4E3B\u9875\u5206\u9875\u6293\u53D6\u5B8C\u6210", { url, pageFrom, pageTo, count: all.length, pages: page });
      return all;
    }
    /** 相册列表：抓某页相册 */
    async fetchAlbumsPage(username, page) {
      const html = await this.fetchHtml(`https://${username}.imgbb.com/albums?page=${page}`);
      const albums = parseAlbumItems(html);
      logger3.info("imgbb", "\u76F8\u518C\u5217\u8868\u6293\u53D6\u5B8C\u6210", { username, page, count: albums.length });
      return albums;
    }
    /** 关注墙：抓关注/被关注用户列表（可按方向） */
    async fetchFollowingUsers(username, side) {
      const urls = [];
      if (side === "following" || side === "both") {
        urls.push(`https://${username}.imgbb.com/following`);
      }
      if (side === "followers" || side === "both") {
        urls.push(`https://${username}.imgbb.com/followers`);
      }
      const htmls = await Promise.all(urls.map((u) => this.fetchHtml(u)));
      const users = htmls.flatMap((h) => parseUserItems(h));
      const seen = /* @__PURE__ */ new Set();
      const unique = users.filter((u) => {
        if (seen.has(u.username)) return false;
        seen.add(u.username);
        return true;
      });
      logger3.info("imgbb", "\u5173\u6CE8\u5899\u7528\u6237\u6293\u53D6\u5B8C\u6210", { username, side, total: unique.length });
      return unique;
    }
    /** 分析单个用户的相册（公开 /albums） */
    async analyzeUserAlbums(user) {
      const html = await this.fetchHtml(`${user.url}albums`);
      return parseAlbumItems(html);
    }
    /** 关注墙分析：一批用户逐个检索相册（并发受限），跳过无相册用户 */
    async analyzeFollowingBatch(users, batchSize) {
      const batch = users.slice(0, batchSize);
      const results = new Array(batch.length).fill(null);
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= batch.length) return;
          const user = batch[idx];
          try {
            const albums = await this.analyzeUserAlbums(user);
            if (albums.length > 0) {
              results[idx] = { user, albums };
            }
          } catch (err) {
            logger3.warn("imgbb", "\u7528\u6237\u76F8\u518C\u68C0\u7D22\u5931\u8D25\uFF08\u8DF3\u8FC7\uFF09", { user: user.username, error: String(err) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()));
      const valid = results.filter((r) => r !== null);
      logger3.info("imgbb", "\u5173\u6CE8\u5899\u6279\u6B21\u5206\u6790\u5B8C\u6210", { requested: batch.length, valid: valid.length });
      return valid;
    }
    /** 从任意 imgbb URL 提取用户名（相册分析/关注墙输入框辅助） */
    extractUsernameFromUrl(url) {
      return extractUsername(url);
    }
    /** 相册页无用户名子域：fetch 相册页 HTML 解析用户名 */
    async resolveUsernameFromAlbum(albumUrl) {
      const html = await this.fetchHtml(albumUrl);
      return parseUsernameFromHtml(html);
    }
  };

  // src/lib/buondua-parse.ts
  function extractAttr2(tag, name) {
    const m = tag.match(new RegExp(`${name}="([^"]*)"`)) ?? tag.match(new RegExp(`${name}='([^']*)'`));
    return m ? m[1] : null;
  }
  function parseRecommendedLinks(html, baseUrl) {
    const items = [];
    const re = /<div class="items-row[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const block = m[1];
      const hrefMatch = block.match(/href="(\/[^"]*)"[^>]*>/);
      if (!hrefMatch) continue;
      const url = new URL(hrefMatch[1], baseUrl).href;
      const cover = block.match(/src="(https?:\/\/[^"]*\.buondua\.com\/[^"]*)"/);
      const titleMatch = block.match(/<a class="item-link"[^>]*>\s*([^<]+?)\s*<\/a>/);
      const title = titleMatch ? titleMatch[1].trim() : url;
      const countMatch = title.match(/\((\d+)\s*photos?\)/i);
      items.push({
        url,
        title,
        coverUrl: cover ? cover[1] : "",
        imageCount: countMatch ? Number(countMatch[1]) : void 0
      });
    }
    return dedupeLinks(items);
  }
  function dedupeLinks(items) {
    const seen = /* @__PURE__ */ new Set();
    return items.filter((item) => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }
  function parseAllPostLinks(html, baseUrl, excludeUrls) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const re = /<a[^>]*href="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const u = new URL(m[1], baseUrl);
        if (u.hostname !== "buondua.com") continue;
        const path = u.pathname;
        if (path === "/" || /^\/?(tag|search|category|author)\//i.test(path)) continue;
        if (/page=\d+/.test(u.search)) continue;
        if (!/\/[^\/]+-\d+$/.test(path)) continue;
        const url = u.origin + path;
        if (seen.has(url)) continue;
        seen.add(url);
        if (excludeUrls?.has(url)) continue;
        let title = (extractAttr2(m[0], "title") || "").trim();
        if (!title) {
          title = m[0].replace(/<[^>]*>/g, "").trim();
        }
        if (!title) {
          const block = html.slice(m.index, m.index + 800);
          const tr = />([^<>]*)</g;
          let tm;
          while ((tm = tr.exec(block)) !== null) {
            const t = tm[1].trim();
            if (t.length >= 2 && !/^\d+$/.test(t)) {
              title = t;
              break;
            }
          }
        }
        const countMatch = title.match(/\((\d+)\s*photos?\)/i);
        items.push({
          url,
          title: title || url,
          coverUrl: "",
          imageCount: countMatch ? Number(countMatch[1]) : void 0
        });
      } catch {
      }
    }
    return dedupeLinks(items);
  }
  function extractBuonduaAlbumName(title, url) {
    let name = title.trim();
    name = name.replace(/\s*[-–—]\s*\(\s*Page \d+\s*\/\s*\d+\s*\)\s*$/i, "");
    if (!name) {
      try {
        const slug = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
        const m = slug.match(/^([a-z0-9-]+)-\d+$/);
        name = m ? m[1] : slug;
      } catch {
        name = "album";
      }
    }
    name = name.replace(/[\\/:*?"<>|\n\r]/g, "_").trim().slice(0, 120);
    return name || "album";
  }

  // src/lib/gallery-sites.ts
  var GALLERY_SITES = [
    {
      id: "buondua",
      hosts: ["buondua.com"],
      containerOpen: /<div[^>]*class="[^"]*article-fulltext[^"]*"[^>]*>/,
      pagePattern: /\(\s*Page\s+\d+\s*\/\s*(\d+)\s*\)/i,
      pageUrl: (base, page) => `${base}?page=${page}`,
      baseUrlOf: (url) => {
        try {
          const u = new URL(url);
          u.search = "";
          u.hash = "";
          return u.href;
        } catch {
          return url;
        }
      },
      cleanTitle: (title) => title.replace(/\s*[-–—]\s*\(\s*Page\s+\d+\s*\/\s*\d+\s*\)\s*$/i, "").trim(),
      // buondua 站点当前不可达且搜索入口未验证，暂不支持聚合搜索
      searchUrl: () => null
    },
    {
      id: "rrwsh",
      hosts: ["rrwsh.uuss.uk", "4khd.com"],
      containerOpen: /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/,
      pagePattern: /Page\s+\d+\s+of\s+(\d+)/i,
      pageUrl: (base, page) => `${base}/${page}`,
      baseUrlOf: (url) => {
        try {
          const u = new URL(url);
          u.search = "";
          u.hash = "";
          const path = u.pathname.replace(/\/\d+$/, "");
          return `${u.origin}${path}`;
        } catch {
          return url;
        }
      },
      cleanTitle: (title) => title.replace(/\s*[-–—]\s*Page\s+\d+\s+of\s+\d+\s*[-–—]\s*[^-]*$/i, "").replace(/\s*[-–—]\s*4KHD\s*$/i, "").trim(),
      // rrwsh 为 4khd 镜像：搜索页可达（curl 200，实测 2026-08-14），结果链接指向 4khd.com
      // 4khd.com 相册页被反爬网关拦截（302 → y5gx.uuss.uk/4khd.php），但 rrwsh.uuss.uk 同路径直接可达
      // → 结果 URL 改写为 rrwsh 域（rewriteUrl），抓取/分页（/content/N/slug.html/2）均正常
      // 搜索无分页（实测 2026-08-14：/search/{q}/2 为空白页，页面无分页链接），每页固定 4 条
      searchUrl: (q, page) => page > 1 ? null : `https://rrwsh.uuss.uk/search/${encodeURIComponent(q)}`,
      rewriteUrl: (url) => url.replace(/https?:\/\/(?:www\.)?4khd\.com/i, "https://rrwsh.uuss.uk")
    },
    {
      id: "hitxhot",
      hosts: ["hitxhot.org"],
      containerOpen: /<div[^>]*class="[^"]*contentme[^"]*"[^>]*>/,
      // 兼容英文 "| Page 2/3" 与中文 "| 第1/6页"（组2 = 总页数）
      pagePattern: /\|\s*(?:Page\s+\d+\s*\/\s*(\d+)|第\s*\d+\s*\/\s*(\d+)\s*页)/i,
      pageUrl: (base, page) => `${base}?page=${page}`,
      baseUrlOf: (url) => {
        try {
          const u = new URL(url);
          u.search = "";
          u.hash = "";
          return u.href;
        } catch {
          return url;
        }
      },
      cleanTitle: (title) => title.replace(/\s*\|\s*(?:Page\s+\d+\s*\/\s*\d+|第\s*\d+\s*\/\s*\d+\s*页)\s*$/i, "").trim(),
      // hitxhot 无站内搜索：官方搜索表单即 Google sitesearch（FP-012 预研 004）；gbv=1 强制基础 HTML 版
      searchUrl: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}&sitesearch=www.hitxhot.org&gbv=1${page > 1 ? `&start=${(page - 1) * 10}` : ""}`,
      searchAlbumPath: "/gallerys/"
    },
    {
      id: "kaizty",
      hosts: ["kaizty.com"],
      containerOpen: /<div[^>]*class="[^"]*contentme[^"]*"[^>]*>/,
      // 与 hitxhot 同模板：标题含 "| Page X/Y"（组2 = 总页数）
      pagePattern: /\|\s*(?:Page\s+\d+\s*\/\s*(\d+)|第\s*\d+\s*\/\s*(\d+)\s*页)/i,
      pageUrl: (base, page) => `${base}?page=${page}`,
      baseUrlOf: (url) => {
        try {
          const u = new URL(url);
          u.search = "";
          u.hash = "";
          return u.href;
        } catch {
          return url;
        }
      },
      cleanTitle: (title) => title.replace(/^Kaizty Photos:\s*/i, "").replace(/^Kaizty 照片：\s*/i, "").replace(/\s*\|\s*(?:Page\s+\d+\s*\/\s*\d+|第?\s*\d+\s*\/\s*\d+\s*页)\s*$/i, "").trim(),
      // kaizty 无站内搜索：官方搜索表单即 Google sitesearch（FP-012 预研 004，用户代理环境实测可用）
      // gbv=1 强制 Google 基础 HTML 版（无 JS 服务端渲染，h3.r > a 直链结构，插件 fetch 可解析）
      searchUrl: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(q)}&sitesearch=www.kaizty.com&gbv=1${page > 1 ? `&start=${(page - 1) * 10}` : ""}`,
      searchAlbumPath: "/photos/"
    },
    {
      id: "jrants",
      hosts: ["jrants.com"],
      containerOpen: /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/,
      // WP 多页文章：标题无 Page 标记（h1 不分页），总页数靠分页链接兜底（见 parseGalleryMaxPage 兜底3）
      pagePattern: /(?!)0/,
      pageUrl: (base, page) => page <= 1 ? base : `${base}/${page}`,
      baseUrlOf: (url) => {
        try {
          const u = new URL(url);
          u.search = "";
          u.hash = "";
          const path = u.pathname.replace(/\/\d+$/, "");
          return `${u.origin}${path}`;
        } catch {
          return url;
        }
      },
      cleanTitle: (title) => title.trim(),
      // WP 搜索：路径式分页（实测 2026-08-14：/page/2?s={q}，&paged= 无效）
      searchUrl: (q, page) => page <= 1 ? `https://jrants.com/?s=${encodeURIComponent(q)}` : `https://jrants.com/page/${page}?s=${encodeURIComponent(q)}`
    },
    {
      id: "pixibb",
      hosts: ["pixibb.com"],
      containerOpen: /<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>/,
      // WP 多页文章（magezix 主题）：标题无 Page 标记，总页数靠分页链接兜底（post-page-numbers，尾斜杠 /N/）
      pagePattern: /(?!)0/,
      pageUrl: (base, page) => page <= 1 ? base : `${base.replace(/\/?$/, "/")}${page}/`,
      baseUrlOf: (url) => {
        try {
          const u = new URL(url);
          u.search = "";
          u.hash = "";
          const path = u.pathname.replace(/\/\d+\/$/, "").replace(/\/\d+$/, "");
          return `${u.origin}${path}`;
        } catch {
          return url;
        }
      },
      cleanTitle: (title) => title.trim(),
      // WP 搜索：路径式分页（实测 2026-08-14：/page/N/?s={q}，&paged= 无效；主内容子域 sexy）
      searchUrl: (q, page) => page <= 1 ? `https://sexy.pixibb.com/?s=${encodeURIComponent(q)}` : `https://sexy.pixibb.com/page/${page}/?s=${encodeURIComponent(q)}`
    }
  ];
  function matchGallerySite(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      for (const site of GALLERY_SITES) {
        if (site.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return site;
      }
    } catch {
    }
    return null;
  }
  function extractContainerBlock(html, openTag) {
    const re = new RegExp(openTag.source, openTag.flags.replace("g", ""));
    const m = re.exec(html);
    if (!m) return "";
    let i = m.index + m[0].length;
    let depth = 1;
    const scan = /<div[\s>]|<\/div>/g;
    scan.lastIndex = i;
    let mm;
    while ((mm = scan.exec(html)) !== null) {
      if (mm[0] === "</div>") depth--;
      else depth++;
      if (depth === 0) return html.slice(i, mm.index);
    }
    return html.slice(i);
  }
  var IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)(\?|$)/i;
  var IMG_HOST = /(buondua\.com|wp\.com|jrants\.com|pixibb\.com|thismore\.fun)/i;
  function parseGalleryImages(html, _baseUrl, site) {
    const block = extractContainerBlock(html, site.containerOpen);
    if (!block) return [];
    const seen = /* @__PURE__ */ new Set();
    const urls = [];
    const collect = (u) => {
      if (!u || !/^https?:\/\//i.test(u)) return;
      if (/\.(js|css|svg|ico)(\?|$)/i.test(u)) return;
      let host = "";
      try {
        host = new URL(u).hostname;
      } catch {
        return;
      }
      if (!IMG_EXT.test(u) && !IMG_HOST.test(host)) return;
      if (/\.html?($|[\/?#])/i.test(u)) return;
      try {
        if (/\/\d+\/?$/.test(new URL(u).pathname)) return;
      } catch {
        return;
      }
      if (seen.has(u)) return;
      seen.add(u);
      urls.push(u);
    };
    const re = /href="(https?:\/\/[^"]+)"|src="(https?:\/\/[^"]+)"/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      collect(m[1] || m[2]);
    }
    return urls.map((url) => {
      let filename = "";
      try {
        filename = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
      } catch {
        filename = url.split("/").pop() || "";
      }
      filename = filename.replace(/[\\/:*?"<>|]/g, "_");
      return { url, filename };
    });
  }
  function parseGalleryMaxPage(html, site) {
    const m = html.match(site.pagePattern);
    if (m) {
      const n = Number(m[1] ?? m[2]);
      if (n > 0) return n;
    }
    let max = 1;
    const re = /<a[^>]*class="[^"]*page-numbers[^"]*"[^>]*href="[^"]*(\d+)"[^>]*>/g;
    let mm;
    while ((mm = re.exec(html)) !== null) {
      max = Math.max(max, Number(mm[1]) || 1);
    }
    const re2 = /href="[^"]*page=(\d+)[^"]*"/g;
    while ((mm = re2.exec(html)) !== null) {
      max = Math.max(max, Number(mm[1]) || 1);
    }
    const re3 = /<a[^>]*href="([^"]*)"[^>]*class="[^"]*page-numbers[^"]*"[^>]*>/g;
    while ((mm = re3.exec(html)) !== null) {
      const n = Number(mm[1].match(/(\d+)\/?$/)?.[1] || 0);
      if (n > 0) max = Math.max(max, n);
    }
    return max;
  }
  function parseGalleryPageTitle(html, site) {
    let raw = "";
    const h1 = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
    if (h1 && h1[1].trim()) raw = h1[1].trim();
    if (!raw) {
      const og = html.match(/<meta property="og:title" content="([^"]*)"/);
      if (og && og[1].trim()) raw = og[1].trim();
    }
    if (!raw) {
      const title = html.match(/<title>([^<]+)<\/title>/);
      if (title) raw = title[1].trim();
    }
    if (!raw) {
      const h2s = [...html.matchAll(/<h2[^>]*>([^<]{16,})<\/h2>/g)];
      if (h2s.length > 0) raw = h2s[0][1].trim();
    }
    return site.cleanTitle(raw);
  }
  function parseKaiztyPostLinks(html, _baseUrl) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const re = /<a[^>]*href="([^"]*\/photos\/[A-Za-z0-9+/=_-]+\.html)"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const url = m[1];
      const abs = /^https?:\/\//i.test(url) ? url : `https:${url}`;
      if (seen.has(abs)) continue;
      seen.add(abs);
      let title = (m[0].match(/title="([^"]*)"/)?.[1] || "").trim();
      if (!title) {
        title = m[0].replace(/<[^>]*>/g, "").trim();
      }
      if (!title) {
        const block = html.slice(m.index, m.index + 600);
        const tm = block.match(/>([^<>]{6,})</);
        if (tm) title = tm[1].trim();
      }
      const countMatch = title.match(/Page\s+(\d+)\s*\/\s*(\d+)/i);
      items.push({ url: abs, title: title || abs, coverUrl: "", imageCount: void 0 });
    }
    return items;
  }
  function parseRrwshSearchLinks(html, _baseUrl) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const cardRe = /<li\b[^>]*class="[^"]*wp-block-post[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    let m;
    while ((m = cardRe.exec(html)) !== null) {
      const card = m[1];
      const lm = card.match(/<a[^>]*href="(https?:\/\/(?:www\.)?(?:4khd\.com|rrwsh\.uuss\.uk)[^"]*\/content\/[^"]+)"[^>]*>/i);
      if (!lm) continue;
      const url = lm[1];
      if (seen.has(url)) continue;
      let title = "";
      const tm = card.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
      if (tm) title = tm[1].replace(/<[^>]*>/g, "").trim();
      let cover = "";
      const im = card.match(/<img[^>]+src="(https?:\/\/[^"]+)"/i);
      if (im) cover = im[1];
      items.push({ url, title: title || url, coverUrl: cover, imageCount: void 0 });
      seen.add(url);
    }
    return items;
  }
  function parseSitePostLinks(html, baseUrl, hosts) {
    const byUrl = /* @__PURE__ */ new Map();
    const re = /<a[^>]*href="([^"]*)"[^>]*>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      try {
        const u = new URL(m[1], baseUrl);
        const host = u.hostname.replace(/^www\./, "");
        const hostOk = hosts.some((h) => host === h || host.endsWith(`.${h}`));
        if (!hostOk) continue;
        const path = u.pathname;
        if (path === "/" || path === "/index.php") continue;
        if (/^\/?(tag|category|search|author|page|pages|wp-|feed|comments|premium|videos|albums|home\d?|signup|login|recovery)\//i.test(path)) continue;
        if (/\/\d+\/?$/.test(path)) continue;
        const url = u.origin + path;
        let title = (m[0].match(/title="([^"]*)"/)?.[1] || "").trim();
        if (!title) {
          title = m[0].replace(/<[^>]*>/g, "").trim();
        }
        if (!title) {
          const tm = html.slice(m.index, m.index + 600).match(/>([^<>]{2,})</);
          if (tm) {
            const t = tm[1].trim();
            if (t.length >= 2 && t.length < 200 && !/^[.#@]/.test(t) && !/[{;}]/.test(t)) title = t;
          }
        }
        const existing = byUrl.get(url);
        if (existing) {
          if (existing.title === url && title && title !== url) {
            byUrl.set(url, { ...existing, title });
          }
          continue;
        }
        byUrl.set(url, { url, title: title || url, coverUrl: "", imageCount: void 0 });
      } catch {
      }
    }
    return [...byUrl.values()];
  }

  // src/lib/jrants-parse.ts
  function parseJrantsPostLinks(html, _baseUrl, opts = {}) {
    const { onlyRecommended = false, excludeUrls } = opts;
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const collect = (block) => {
      const re = /<a[^>]*href="(https?:\/\/jrants\.com\/20\d+\.html)"[^>]*>/g;
      let m;
      while ((m = re.exec(block)) !== null) {
        const url = m[1];
        if (seen.has(url)) continue;
        seen.add(url);
        if (excludeUrls?.has(url)) continue;
        let title = (m[0].match(/title="([^"]*)"/)?.[1] || "").trim();
        if (!title) {
          title = m[0].replace(/<[^>]*>/g, "").trim();
        }
        if (!title) {
          const tm = block.slice(m.index, m.index + 600).match(/>([^<>]{2,})</);
          if (tm) title = tm[1].trim();
        }
        const around = block.slice(Math.max(0, m.index - 2e3), m.index + 2e3);
        const coverMatch = around.match(/src="(https?:\/\/(?:m2\.)?jrants\.com\/[^"]*)"/);
        const countMatch = title.match(/\((\d+)\s*P\)/i) ?? title.match(/\[(\d+)\s*P\]/i) ?? title.match(/(?:^|\s)(\d+)\s*P\b/i);
        items.push({
          url,
          title: title || url,
          coverUrl: coverMatch ? coverMatch[1] : "",
          imageCount: countMatch ? Number(countMatch[1]) : void 0
        });
      }
    };
    if (onlyRecommended) {
      const blockRe = /<article class="\s*wp-show-posts-single[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
      let bm;
      while ((bm = blockRe.exec(html)) !== null) collect(bm[1]);
    } else {
      collect(html);
    }
    return items;
  }

  // src/lib/pixibb-parse.ts
  function parsePixibbPostLinks(html, _baseUrl, opts = {}) {
    const { onlyRecommended = false, excludeUrls } = opts;
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const collect = (block) => {
      const re = /<a[^>]*href="(https:\/\/[a-z0-9-]+\.pixibb\.com\/[a-z0-9-]+-\d+-photos(?:-\d+-videos?)?\/)"[^>]*>/g;
      let m;
      while ((m = re.exec(block)) !== null) {
        const url = m[1];
        if (seen.has(url)) continue;
        seen.add(url);
        if (excludeUrls?.has(url)) continue;
        let title = (m[0].match(/title="([^"]*)"/)?.[1] || "").trim();
        if (!title) {
          title = m[0].replace(/<[^>]*>/g, "").trim();
        }
        if (!title) {
          const tm2 = block.slice(m.index, m.index + 3e3).match(/<h[234][^>]*class="[^"]*post-title[^"]*"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
          if (tm2) title = tm2[1].trim();
        }
        if (!title) {
          const tm = block.slice(m.index, m.index + 600).match(/>([^<>]{2,})</);
          if (tm) title = tm[1].trim();
        }
        const around = block.slice(Math.max(0, m.index - 2e3), m.index + 2e3);
        const coverMatch = around.match(/src="(https:\/\/[a-z0-9]+\.pixibb\.com\/[^"]*)"/);
        const countMatch = title.match(/\((\d+)\s*photos?/i);
        items.push({
          url,
          title: title || url,
          coverUrl: coverMatch ? coverMatch[1] : "",
          imageCount: countMatch ? Number(countMatch[1]) : void 0
        });
      }
    };
    if (onlyRecommended) {
      const re = /<h2[^>]*class="[^"]*post-title[^"]*"[^>]*>\s*<a[^>]*href="(https:\/\/[a-z0-9-]+\.pixibb\.com\/[a-z0-9-]+-\d+-photos(?:-\d+-videos?)?\/)"[^>]*>([^<]+)<\/a>/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        const url = m[1];
        const title = m[2].trim();
        if (seen.has(url)) continue;
        seen.add(url);
        if (excludeUrls?.has(url)) continue;
        const before = html.slice(Math.max(0, m.index - 2e3), m.index);
        const coverMatch = before.match(/src="(https:\/\/[a-z0-9]+\.pixibb\.com\/[^"]*)"/);
        const countMatch = title.match(/\((\d+)\s*photos?/i);
        items.push({
          url,
          title: title || url,
          coverUrl: coverMatch ? coverMatch[1] : "",
          imageCount: countMatch ? Number(countMatch[1]) : void 0
        });
      }
      return items;
    } else {
      collect(html);
    }
    return items;
  }

  // src/background/buondua-service.ts
  var logger4 = initLogger("background");
  var FETCH_TIMEOUT_MS4 = 4e4;
  var FETCH_ATTEMPTS = 2;
  var CONCURRENCY2 = 3;
  var BuonduaService = class {
    /** fetch 单个页面 HTML（带 UA + 超时 + 重试 1 次） */
    async fetchHtml(url) {
      let lastErr;
      for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
        try {
          return await this.fetchOnce(url);
        } catch (err) {
          lastErr = err;
          logger4.warn("buondua", `\u9875\u9762\u6293\u53D6\u7B2C ${attempt} \u6B21\u5931\u8D25`, { url, error: String(err) });
        }
      }
      throw lastErr;
    }
    async fetchOnce(url) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS4);
      try {
        const resp = await fetch(url, {
          credentials: "include",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            Referer: new URL(url).origin + "/"
          },
          signal: controller.signal
        });
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}\uFF08${url}\uFF09`);
        }
        return await resp.text();
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error(`\u8BF7\u6C42\u8D85\u65F6\uFF08${url}\uFF09`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    /** 单相册全子页抓取（buondua / rrwsh / hitxhot 通用）：按最大页数遍历全部子页 → 合并去重
     *  fetchHtmlFn：可选，降级用（content 页面内 fetch 带 Cookie 穿透反爬） */
    async fetchAlbumAllPages(url, fetchHtmlFn) {
      const getHtml = fetchHtmlFn ?? ((u) => this.fetchHtml(u));
      const site = matchGallerySite(url);
      if (!site) {
        throw new Error(`\u6682\u4E0D\u652F\u6301\u8BE5\u7AD9\u70B9\uFF08${url}\uFF09`);
      }
      const base = site.baseUrlOf(url);
      const firstHtml = await getHtml(base);
      const title = parseGalleryPageTitle(firstHtml, site);
      const maxPage = parseGalleryMaxPage(firstHtml, site);
      const all = [];
      for (let p = 1; p <= maxPage; p++) {
        all.push(site.pageUrl(base, p));
      }
      const imagesMap = /* @__PURE__ */ new Map();
      let scanned = 0;
      let emptyStreak = 0;
      for (const pageUrl of all) {
        const html = await getHtml(pageUrl);
        const imgs = parseGalleryImages(html, pageUrl, site);
        scanned += imgs.length;
        emptyStreak = imgs.length === 0 ? emptyStreak + 1 : 0;
        for (const img of imgs) {
          const key = `${img.url.split("?")[0]}`;
          if (!imagesMap.has(key)) imagesMap.set(key, img);
        }
        if (emptyStreak >= 3) break;
      }
      const images = [...imagesMap.values()];
      logger4.info("buondua", "\u76F8\u518C\u5168\u5B50\u9875\u6293\u53D6\u5B8C\u6210", {
        site: site.id,
        url,
        pages: all.length,
        scanned,
        unique: images.length,
        title,
        maxPage
      });
      return { images, pages: all, title };
    }
    /** 解析推荐/其他相册链接（按站点路由：buondua 用 buondua-parse，jrants 用 jrants-parse） */
    async scanLinks(url, kind) {
      const html = await this.fetchHtml(url);
      const base = url;
      const site = matchGallerySite(url);
      let items;
      if (site?.id === "jrants") {
        const rec = parseJrantsPostLinks(html, base, { onlyRecommended: true });
        if (kind === "recommended") {
          items = rec;
        } else {
          const recUrls = new Set(rec.map((i) => i.url));
          items = parseJrantsPostLinks(html, base, { excludeUrls: recUrls });
        }
      } else if (site?.id === "pixibb") {
        const rec = parsePixibbPostLinks(html, base, { onlyRecommended: true });
        if (kind === "recommended") {
          items = rec;
        } else {
          const recUrls = new Set(rec.map((i) => i.url));
          items = parsePixibbPostLinks(html, base, { excludeUrls: recUrls });
        }
      } else if (kind === "recommended") {
        items = parseRecommendedLinks(html, base);
      } else {
        const recUrls = new Set(parseRecommendedLinks(html, base).map((i) => i.url));
        items = parseAllPostLinks(html, base, recUrls);
      }
      logger4.info("buondua", "\u94FE\u63A5\u626B\u63CF\u5B8C\u6210", { kind, count: items.length, site: site?.id ?? "buondua" });
      return items;
    }
    /** 批量抓取：targets 逐个全子页抓取（并发受限），返回每个目标的图片 */
    async fetchAlbumsBatch(targets, onItem) {
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= targets.length) return;
          const target = targets[idx];
          try {
            const { images } = await this.fetchAlbumAllPages(target.url);
            onItem(idx, target, images);
          } catch (err) {
            logger4.warn("buondua", "\u6279\u91CF\u76F8\u518C\u6293\u53D6\u5931\u8D25", { url: target.url, error: String(err) });
            onItem(idx, target, []);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY2, targets.length) }, () => worker()));
    }
    /** 聚合搜索：多站点逐页搜索 → 按站点路由解析 → 合并去重
     *  onSite：每站完成后回调（推送该站结果，增量展示）；返回全部合并去重结果 */
    async searchSites(query, sites, pagesPerSite, onSite) {
      const mergedMap = /* @__PURE__ */ new Map();
      for (const siteId of sites) {
        const site = GALLERY_SITES.find((s) => s.id === siteId);
        if (!site || !site.searchUrl) {
          await onSite(siteId, [], "\u8BE5\u7AD9\u4E0D\u652F\u6301\u641C\u7D22");
          continue;
        }
        const items = [];
        let error;
        try {
          for (let page = 1; page <= pagesPerSite; page++) {
            const url = site.searchUrl(query, page);
            if (!url) break;
            if (siteId === "jrants" && page > 1) await sleep(2e3);
            const html = await this.fetchHtml(url);
            if (isBlockedPage(html)) {
              error = "\u641C\u7D22\u88AB\u53CD\u722C\u62E6\u622A\uFF08\u9650\u6D41\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
              logger4.warn("buondua", "\u7AD9\u70B9\u641C\u7D22\u88AB\u53CD\u722C\u62E6\u622A", { site: siteId });
              break;
            }
            const parsed = parseLinksForSite(siteId, html, url);
            if (parsed.length === 0) {
              if (page === 1 && site.searchAlbumPath) {
                error = "Google \u672A\u8FD4\u56DE\u53EF\u89E3\u6790\u7684\u76F8\u518C\u7ED3\u679C\uFF08\u53EF\u80FD\u88AB\u9A8C\u8BC1\u9875/\u540C\u610F\u9875\u62E6\u622A\uFF0C\u8BF7\u7528\u300C\u6D4B\u8BD5 Google \u8FDE\u63A5\u300D\u786E\u8BA4\uFF09";
                logger4.warn("buondua", "Google \u641C\u7D22\u65E0\u7ED3\u679C", { site: siteId });
              }
              break;
            }
            items.push(...parsed);
          }
        } catch (err) {
          error = String(err);
          logger4.warn("buondua", "\u7AD9\u70B9\u641C\u7D22\u5931\u8D25", { site: siteId, error });
        }
        const unique = dedupeLinks2(items.map((item) => enrichSearchItem(siteId, site, item)));
        for (const item of unique) {
          if (!mergedMap.has(item.url)) mergedMap.set(item.url, item);
        }
        await onSite(siteId, unique, error);
      }
      logger4.info("buondua", "\u805A\u5408\u641C\u7D22\u5B8C\u6210", { query, sites: sites.length, merged: mergedMap.size });
      return [...mergedMap.values()];
    }
    /** 相册文件夹名：ID-buondua-{相册名}-{时间戳} */
    buildFolderName(title, url) {
      const name = extractBuonduaAlbumName(title, url);
      const d = /* @__PURE__ */ new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      return `ID-buondua-${name}-${ts}`;
    }
    /** Google 连接测试（聚合搜索 Google 通道，FP-012/090）：请求 google 搜索（gbv=1 基础版），
     *  报告可达性/拦截/耗时 + 返回页诊断（长度/标题/是否含 h3/是否同意页/可见文本预览） */
    async testGoogleConnection() {
      const start = Date.now();
      try {
        const resp = await fetch("https://www.google.com/search?q=test&gbv=1", {
          credentials: "include",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
          }
        });
        const html = await resp.text();
        const blocked = isBlockedPage(html);
        const title = (html.match(/<title>([^<]*)<\/title>/) ?? [null, ""])[1].slice(0, 100);
        const hasH3 = /<h3[^>]*class="[^"]*\br\b[^"]*"/.test(html) || /zReHs/.test(html);
        const isConsent = /consent\.google\.com|google\.com\/consent/i.test(html);
        const body = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return {
          ok: true,
          status: resp.status,
          blocked,
          ms: Date.now() - start,
          diag: { len: html.length, title, hasH3, isConsent, bodyPreview: body.slice(0, 220) }
        };
      } catch (err) {
        return { ok: false, blocked: false, ms: Date.now() - start, error: String(err) };
      }
    }
  };
  function parseLinksForSite(siteId, html, base) {
    if (siteId === "jrants") return parseJrantsPostLinks(html, base, {});
    if (siteId === "pixibb") return parsePixibbPostLinks(html, base, {});
    if (siteId === "kaizty") return parseKaiztyPostLinks(html, base);
    if (siteId === "rrwsh") return parseRrwshSearchLinks(html, base);
    const site = GALLERY_SITES.find((s) => s.id === siteId);
    if (site && site.searchAlbumPath) return parseGoogleResults(html, site);
    return parseSitePostLinks(html, base, site?.hosts ?? [siteId]);
  }
  function parseGoogleResults(html, site) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (rawUrl, rawTitle) => {
      try {
        const url = rawUrl.replace(/&amp;/g, "&");
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, "");
        const hostOk = site.hosts.some((h) => host === h || host.endsWith(`.${h}`));
        if (!hostOk) return;
        if (site.searchAlbumPath && !u.pathname.startsWith(site.searchAlbumPath)) return;
        u.search = "";
        u.hash = "";
        const cleanUrl = u.href;
        if (seen.has(cleanUrl)) return;
        seen.add(cleanUrl);
        const title = site.cleanTitle(rawTitle.replace(/<[^>]*>/g, "").trim()) || cleanUrl;
        items.push({ url: cleanUrl, title, coverUrl: "", imageCount: void 0 });
      } catch {
      }
    };
    const re1 = /<a[^>]*class="[^"]*zReHs[^"]*"[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
    let m;
    while ((m = re1.exec(html)) !== null) add(m[1], m[2]);
    const re2 = /<h3[^>]*class="[^"]*\br\b[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re2.exec(html)) !== null) add(m[1], m[2]);
    return items;
  }
  function enrichSearchItem(siteId, site, item) {
    const url = site.rewriteUrl ? site.rewriteUrl(item.url) : item.url;
    return { ...item, url, imageCount: item.imageCount ?? extractSearchImageCount(siteId, item, url) };
  }
  function extractSearchImageCount(siteId, item, finalUrl) {
    if (siteId === "jrants") {
      const m = item.title.match(/[(\[]\s*(\d+)\s*P\s*[)\]]/i);
      return m ? Number(m[1]) : void 0;
    }
    if (siteId === "pixibb") {
      const m = finalUrl.match(/-(\d+)-photos/i);
      return m ? Number(m[1]) : void 0;
    }
    if (siteId === "rrwsh") {
      const m = item.title.match(/[\[(][^\]()]*?(\d+)\s*photos/i);
      return m ? Number(m[1]) : void 0;
    }
    return void 0;
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function isBlockedPage(html) {
    return /search request blocked|正在进行安全验证|just a moment|cf-chl|cloudflare|turnstile|attention required|unusual traffic|enable JavaScript and cookies|recaptcha|our systems have detected/i.test(html);
  }
  function dedupeLinks2(items) {
    const seen = /* @__PURE__ */ new Set();
    return items.filter((i) => {
      if (seen.has(i.url)) return false;
      seen.add(i.url);
      return true;
    });
  }

  // src/background/background.ts
  var logger5 = initLogger("background");
  var sessions = /* @__PURE__ */ new Map();
  function buildFolderName(title) {
    const cleanTitle = cleanPageTitle(title).replace(/[\\/:*?"<>|\n\r]/g, "_").trim().slice(0, 120) || "\u9875\u9762";
    return cleanTitle;
  }
  function cleanPageTitle(title) {
    return title.replace(/\s*[-—–]\s*ImgBB\s*$/i, "").replace(/\s*[-–—]\s*Buondua\s*$/i, "").replace(/\s*\|\s*(?:Page\s+\d+\s*\/\s*\d+|第\s*\d+\s*\/\s*\d+\s*页)\s*$/i, "").trim();
  }
  var downloadManager = new DownloadManager({
    onUpdate: (job, done) => {
      const session = sessions.get(job.srcTabId);
      const grabTabId = session?.grabTabId;
      if (!grabTabId) return;
      void sendToTab(grabTabId, done ? { type: "GRAB_DOWNLOAD_DONE", job } : { type: "GRAB_DOWNLOAD_PROGRESS", job });
    }
  });
  void storageGet("dl_concurrency").then((n) => {
    if (typeof n === "number" && n > 0) downloadManager.setConcurrency(n);
  });
  chrome.downloads.onChanged.addListener((delta) => {
    downloadManager.handleChanged(delta);
  });
  var imgbb = new ImgbbService();
  var followingUsersCache = /* @__PURE__ */ new Map();
  async function fetchUserAlbums(username, maxPages) {
    const all = [];
    const seen = /* @__PURE__ */ new Set();
    let url = `https://${username}.imgbb.com/albums`;
    let page = 0;
    while (url && page < maxPages) {
      const html = await imgbb.fetchHtml(url);
      const items = parseAlbumItems(html);
      for (const a of items) {
        if (!seen.has(a.id)) {
          seen.add(a.id);
          all.push(a);
        }
      }
      const next = parseAlbumNextPage(html, `https://${username}.imgbb.com/albums`);
      if (!next || next === url || items.length === 0) break;
      url = next;
      page++;
    }
    return { albums: all, truncated: url !== null && page >= maxPages };
  }
  var SCORE_MAX_PAGES = 20;
  var SCORE_FULL_MAX_PAGES = 300;
  var scoreBatchCancelled = false;
  var diffuse = new DiffuseEngine();
  var producerDb = emptyDb();
  var producerDbReady = (async () => {
    const raw = await storageGet(PRODUCER_DB_KEY);
    producerDb = loadDb(raw);
    logger5.info("diffuse", "\u751F\u4EA7\u8005\u5E93\u5DF2\u6062\u590D", { total: Object.keys(producerDb.entries).length });
  })();
  var DIFFUSE_STATE_KEY = "diffuse_state";
  async function ensureDiffuseRestored() {
    try {
      const r = await chrome.storage.session.get(DIFFUSE_STATE_KEY);
      const state = r[DIFFUSE_STATE_KEY];
      if (state && Array.isArray(state.queue) && !diffuse.isActive()) {
        diffuse.restore(state);
        logger5.info("diffuse", "\u6269\u6563\u72B6\u6001\u5DF2\u4ECE session \u6062\u590D", { queueSize: state.queue.length, visited: state.visited.length });
      }
    } catch {
    }
  }
  async function saveDiffuseState() {
    try {
      await chrome.storage.session.set({ [DIFFUSE_STATE_KEY]: diffuse.save() });
    } catch {
    }
  }
  var buondua = new BuonduaService();
  async function pushImgbbResult(srcTabId, kind, data, done, error) {
    const session = sessions.get(srcTabId);
    if (!session) return;
    await sendToTab(session.grabTabId, { type: "IMG_RESULT", kind, data, done, error });
  }
  function sessionOf(srcTabId) {
    return sessions.get(srcTabId)?.grabTabId ?? 0;
  }
  async function sendToTabAndGet(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch {
      return void 0;
    }
  }
  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab.id || !tab.url || !/^https?:\/\//.test(tab.url)) {
      logger5.warn("action", "\u65E0\u6CD5\u6293\u53D6\u8BE5\u9875\u9762\uFF08\u975E http(s) \u9875\u9762\uFF09", { url: tab.url });
      return;
    }
    try {
      const grabTab = await chrome.tabs.create({
        url: `grabber.html?srcTabId=${tab.id}`,
        index: (tab.index ?? 0) + 1
      });
      logger5.info("action", "\u5DF2\u521B\u5EFA\u6293\u53D6\u9875", { srcTabId: tab.id, grabTabId: grabTab.id });
    } catch (err) {
      logger5.error("action", "\u521B\u5EFA\u6293\u53D6\u9875\u5931\u8D25", { error: String(err) });
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = sessions.get(tabId);
    if (session) {
      sessions.delete(tabId);
      logger5.info("session", "\u6E90\u7F51\u9875\u5173\u95ED\uFF0C\u6E05\u7406\u4F1A\u8BDD", { srcTabId: tabId });
      if (session.grabTabId && session.grabTabId !== tabId) {
        void sendToTab(session.grabTabId, { type: "GRAB_SESSION_END_FWD", srcTabId: tabId });
      }
    }
    for (const [srcTabId, s] of sessions) {
      if (s.grabTabId === tabId) {
        sessions.delete(srcTabId);
        logger5.info("session", "\u6293\u53D6\u9875\u5173\u95ED\uFF0C\u6E05\u7406\u4F1A\u8BDD", { srcTabId, grabTabId: tabId });
      }
    }
  });
  chrome.runtime.onInstalled.addListener((details) => {
    logger5.info("runtime", "\u63D2\u4EF6\u5DF2\u5B89\u88C5/\u66F4\u65B0", { reason: details.reason, version: chrome.runtime.getManifest().version });
  });
  chrome.runtime.onStartup.addListener(() => {
    logger5.info("runtime", "\u6D4F\u89C8\u5668\u542F\u52A8\uFF0CSW \u5524\u9192");
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void handleMessage(message, sender).then(sendResponse).catch((err) => {
      logger5.error("msg-handler", "\u6D88\u606F\u5904\u7406\u5931\u8D25", { type: message.type, error: String(err) });
      sendResponse({ ok: false, error: String(err) });
    });
    return true;
  });
  async function handleMessage(message, sender) {
    switch (message.type) {
      case "LOG_ADD":
        await appendLog(message.context, message.level, message.module, message.message, message.data);
        return { ok: true };
      case "LOG_GET":
        return { ok: true, entries: await getEntries() };
      case "LOG_CLEAR":
        await clearEntries();
        return { ok: true };
      case "LOG_SET_LEVEL":
        await setLevel(message.level);
        return { ok: true, level: message.level };
      case "LOG_GET_LEVEL":
        return { ok: true, level: await getLevel() };
      case "GRAB_SESSION_CREATE": {
        const srcTab = await chrome.tabs.get(message.srcTabId).catch(() => void 0);
        if (!srcTab?.url || !/^https?:\/\//.test(srcTab.url)) {
          return { ok: false, error: "\u6E90\u7F51\u9875\u4E0D\u53EF\u7528\uFF08\u5DF2\u5173\u95ED\u6216\u975E http \u9875\u9762\uFF09" };
        }
        const url = new URL(srcTab.url);
        const existing = sessions.get(message.srcTabId);
        const session = existing ?? {
          srcTabId: message.srcTabId,
          grabTabId: message.grabTabId,
          title: cleanPageTitle(srcTab.title || url.host),
          host: url.host,
          url: srcTab.url,
          folderName: "",
          status: "idle"
        };
        session.grabTabId = message.grabTabId;
        session.url = srcTab.url;
        if (!session.folderName) {
          session.folderName = buildFolderName(session.title);
        }
        sessions.set(message.srcTabId, session);
        logger5.info("session", "\u4F1A\u8BDD\u5DF2\u6CE8\u518C", { srcTabId: session.srcTabId, grabTabId: session.grabTabId, folderName: session.folderName });
        return { ok: true, session };
      }
      case "GRAB_PARSE_START": {
        const srcTabId = message.srcTabId;
        if (srcTabId === void 0) return { ok: false, error: "\u7F3A\u5C11 srcTabId" };
        const session = sessions.get(srcTabId);
        if (!session) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
        session.status = "parsing";
        try {
          await chrome.scripting.executeScript({
            target: { tabId: srcTabId },
            files: ["js/content.js"]
          });
          await sendToTab(srcTabId, { type: "GRAB_PARSE_START" });
          logger5.info("parse", "\u89E3\u6790\u5DF2\u542F\u52A8", { srcTabId });
        } catch (err) {
          session.status = "error";
          logger5.error("parse", "\u6CE8\u5165\u89E3\u6790\u5668\u5931\u8D25", { srcTabId, error: String(err) });
          await sendToTab(session.grabTabId, {
            type: "GRAB_PARSE_ERROR_FWD",
            srcTabId,
            error: String(err)
          });
        }
        return { ok: true };
      }
      case "GRAB_PARSE_CANCEL": {
        const srcTabId = message.srcTabId;
        if (srcTabId === void 0) return { ok: false, error: "\u7F3A\u5C11 srcTabId" };
        const session = sessions.get(srcTabId);
        if (session) {
          session.status = "idle";
        }
        await sendToTab(srcTabId, { type: "GRAB_PARSE_CANCEL" });
        logger5.info("parse", "\u8BF7\u6C42\u53D6\u6D88\u89E3\u6790", { srcTabId });
        return { ok: true };
      }
      case "GRAB_LOAD_MORE": {
        const srcTabId = message.srcTabId;
        if (srcTabId === void 0) return { ok: false, error: "\u7F3A\u5C11 srcTabId" };
        const session = sessions.get(srcTabId);
        if (!session) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
        session.status = "parsing";
        await sendToTab(srcTabId, { type: "GRAB_LOAD_MORE" });
        logger5.info("parse", "\u8BF7\u6C42\u52A0\u8F7D\u4E0B\u4E00\u6279", { srcTabId });
        return { ok: true };
      }
      case "GRAB_PARSE_BATCH": {
        const srcTabId = sender.tab?.id;
        if (srcTabId === void 0) return { ok: false, error: "\u65E0\u6CD5\u8BC6\u522B\u6D88\u606F\u6765\u6E90" };
        const session = sessions.get(srcTabId);
        if (!session) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
        await sendToTab(session.grabTabId, {
          type: "GRAB_PARSE_BATCH_FWD",
          srcTabId,
          images: message.images,
          total: message.total,
          scanned: message.scanned
        });
        return { ok: true };
      }
      case "GRAB_PARSE_DONE": {
        const srcTabId = sender.tab?.id;
        if (srcTabId === void 0) return { ok: false, error: "\u65E0\u6CD5\u8BC6\u522B\u6D88\u606F\u6765\u6E90" };
        const session = sessions.get(srcTabId);
        if (!session) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
        session.status = message.cancelled ? "idle" : "idle";
        await sendToTab(session.grabTabId, {
          type: "GRAB_PARSE_DONE_FWD",
          srcTabId,
          cancelled: message.cancelled,
          reachedLimit: message.reachedLimit
        });
        return { ok: true };
      }
      case "GRAB_PARSE_ERROR": {
        const srcTabId = sender.tab?.id;
        if (srcTabId === void 0) return { ok: false, error: "\u65E0\u6CD5\u8BC6\u522B\u6D88\u606F\u6765\u6E90" };
        const session = sessions.get(srcTabId);
        if (!session) return { ok: false, error: "\u4F1A\u8BDD\u4E0D\u5B58\u5728" };
        session.status = "error";
        await sendToTab(session.grabTabId, { type: "GRAB_PARSE_ERROR_FWD", srcTabId, error: message.error });
        return { ok: true };
      }
      case "GRAB_DOWNLOAD_START": {
        const job = downloadManager.start(message.srcTabId, message.folderName, message.items);
        logger5.info("download", "\u4E0B\u8F7D\u4EFB\u52A1\u542F\u52A8", { jobId: job.id, total: job.total, folderName: job.folderName });
        return { ok: true, job };
      }
      case "GRAB_DOWNLOAD_CANCEL":
        downloadManager.cancel(message.jobId);
        return { ok: true };
      case "GRAB_DOWNLOAD_RETRY":
        downloadManager.retry(message.jobId);
        return { ok: true };
      case "GRAB_DOWNLOAD_GET": {
        const job = downloadManager.get(message.jobId);
        return job ? { ok: true, job } : { ok: false, error: "\u4EFB\u52A1\u4E0D\u5B58\u5728" };
      }
      case "GRAB_OPEN_FOLDER":
        chrome.downloads.showDefaultFolder();
        return { ok: true };
      case "GRAB_FETCH_IMAGE": {
        try {
          let buf;
          if (message.srcTabId) {
            try {
              buf = await fetchImgbbViaSrcTab(message.srcTabId, message.url);
              logger5.debug("download", "GRAB_FETCH_IMAGE \u6E90\u9875\u6CE8\u5165\u6293\u53D6\u5B8C\u6210", { bytes: buf.byteLength, url: message.url });
            } catch (err) {
              logger5.warn("download", "GRAB_FETCH_IMAGE \u6E90\u9875\u6CE8\u5165\u5931\u8D25\uFF0C\u964D\u7EA7 background", { url: message.url, error: String(err) });
              buf = await fetchImageBytes(message.url);
            }
          } else {
            buf = await fetchImageBytes(message.url);
          }
          return { ok: true, data: arrayBufferToBase64(buf) };
        } catch (err) {
          logger5.warn("download", "GRAB_FETCH_IMAGE \u6293\u53D6\u5931\u8D25", { url: message.url, error: String(err) });
          return { ok: false, error: String(err) };
        }
      }
      case "GRAB_SET_CONCURRENCY": {
        downloadManager.setConcurrency(message.concurrency);
        await storageSet("dl_concurrency", downloadManager.getConcurrency());
        return { ok: true, concurrency: downloadManager.getConcurrency() };
      }
      case "GRAB_GET_CONCURRENCY":
        return { ok: true, concurrency: downloadManager.getConcurrency() };
      case "IMG_RESOLVE_USER": {
        try {
          const username = await imgbb.resolveUsernameFromAlbum(message.albumUrl);
          logger5.info("imgbb", "\u76F8\u518C\u7528\u6237\u540D\u89E3\u6790\u5B8C\u6210", { albumUrl: message.albumUrl, username });
          return { ok: true, username };
        } catch (err) {
          logger5.error("imgbb", "\u76F8\u518C\u7528\u6237\u540D\u89E3\u6790\u5931\u8D25", String(err));
          return { ok: false, error: String(err) };
        }
      }
      case "IMG_GET_ALBUM_IMAGES": {
        try {
          const { images, name } = await imgbb.fetchAlbumImages(message.albumUrl);
          await pushImgbbResult(message.srcTabId, "album-images", images, true);
          return { ok: true, name: name || void 0 };
        } catch (err) {
          logger5.error("imgbb", "\u76F8\u518C\u6293\u53D6\u5931\u8D25", String(err));
          await pushImgbbResult(message.srcTabId, "album-images", [], true, String(err));
          return { ok: false, error: String(err) };
        }
      }
      case "IMG_FETCH_GALLERY": {
        try {
          const images = await imgbb.fetchGalleryPages(message.url, message.pageFrom, message.pageTo);
          await pushImgbbResult(message.srcTabId, "gallery", images, true);
        } catch (err) {
          logger5.error("imgbb", "\u7528\u6237\u4E3B\u9875\u6293\u53D6\u5931\u8D25", String(err));
          await pushImgbbResult(message.srcTabId, "gallery", [], true, String(err));
        }
        return { ok: true };
      }
      case "IMG_FETCH_GALLERY_RANGE": {
        try {
          const all = await imgbb.fetchGalleryPages(message.url, 1, 60);
          const filtered = all.filter((img) => {
            const m = img.filename.match(new RegExp(`^${message.prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)`));
            if (!m) return false;
            const n = Number(m[1]);
            return n >= message.from && n <= message.to;
          });
          logger5.info("imgbb", "\u7F16\u53F7\u8303\u56F4\u6293\u53D6\u5B8C\u6210", { prefix: message.prefix, from: message.from, to: message.to, count: filtered.length, scanned: all.length });
          await pushImgbbResult(message.srcTabId, "gallery-range", filtered, true);
        } catch (err) {
          logger5.error("imgbb", "\u7F16\u53F7\u8303\u56F4\u6293\u53D6\u5931\u8D25", String(err));
          await pushImgbbResult(message.srcTabId, "gallery-range", [], true, String(err));
        }
        return { ok: true };
      }
      case "IMG_ANALYZE_ALBUMS": {
        try {
          const albums = await imgbb.fetchAlbumsPage(message.username, message.page);
          await pushImgbbResult(message.srcTabId, "albums", albums, true);
        } catch (err) {
          logger5.error("imgbb", "\u76F8\u518C\u5206\u6790\u5931\u8D25", String(err));
          await pushImgbbResult(message.srcTabId, "albums", [], true, String(err));
        }
        return { ok: true };
      }
      case "IMG_ANALYZE_FOLLOWING": {
        try {
          const cacheKey = `${message.username}|${message.side}`;
          if (message.batchStart === 0 || !followingUsersCache.has(cacheKey)) {
            followingUsersCache.set(cacheKey, await imgbb.fetchFollowingUsers(message.username, message.side));
          }
          const allUsers = followingUsersCache.get(cacheKey) ?? [];
          const batch = allUsers.slice(message.batchStart, message.batchStart + message.batchSize);
          const results = await imgbb.analyzeFollowingBatch(batch, message.batchSize);
          const done = message.batchStart + message.batchSize >= allUsers.length;
          await pushImgbbResult(
            message.srcTabId,
            "following",
            results,
            done,
            done && results.length === 0 ? "\u65E0\u66F4\u591A\u6709\u6548\u7528\u6237" : void 0
          );
        } catch (err) {
          logger5.error("imgbb", "\u5173\u6CE8\u5899\u5206\u6790\u5931\u8D25", String(err));
          await pushImgbbResult(message.srcTabId, "following", [], true, String(err));
        }
        return { ok: true };
      }
      case "IMG_DIFFUSE_START": {
        diffuse.start(message.startUser);
        await saveDiffuseState();
        return { ok: true, snapshot: diffuse.snapshot() };
      }
      case "IMG_DIFFUSE_BATCH": {
        await ensureDiffuseRestored();
        await producerDbReady;
        if (diffuse.is429Throttled) {
          logger5.warn("diffuse", "\u8FDE\u7EED 429\uFF0C\u5DF2\u963B\u6B62\u7EE7\u7EED\u6269\u6563\uFF0C\u8BF7\u7A0D\u540E\u518D\u8BD5");
          return { ok: false, error: "\u8FDE\u7EED 429 \u9650\u6D41\uFF0C\u8BF7\u7B49\u5F85 30 \u79D2\u540E\u518D\u7EE7\u7EED" };
        }
        const result = await diffuse.processBatch(message.batchSize, message.concurrency, message.intervalMs);
        await saveDiffuseState();
        const snapshot = diffuse.snapshot();
        if (Object.keys(result.inDegreeDelta).length > 0) {
          producerDb = mergeInDegree(producerDb, result.inDegreeDelta, snapshot.startUser);
          await storageSet(PRODUCER_DB_KEY, producerDb);
        }
        return { ok: true, result, snapshot };
      }
      case "IMG_DIFFUSE_PROGRESS": {
        await ensureDiffuseRestored();
        return { ok: true, snapshot: diffuse.snapshot() };
      }
      case "IMG_DB_GET": {
        await producerDbReady;
        const sum = dbSummary(producerDb);
        const dist = inDegreeDist(producerDb);
        const w1 = message.w1 ?? 0.6;
        const topN = message.topN ?? 100;
        const rankScore = scoreTop(producerDb, topN, w1, 1 - w1);
        const rankDegree = degreeTop(producerDb, topN);
        const rankAlbum = albumTop(producerDb, topN);
        return {
          ok: true,
          db: producerDb,
          total: sum.total,
          confirmed: sum.confirmed,
          producers: sum.producers,
          maxInDegree: sum.maxInDegree,
          dist,
          rankScore,
          rankDegree,
          rankAlbum
        };
      }
      case "IMG_DB_SAVE": {
        await producerDbReady;
        await storageSet(PRODUCER_DB_KEY, producerDb);
        const sum = dbSummary(producerDb);
        logger5.info("diffuse", "\u751F\u4EA7\u8005\u5E93\u5DF2\u4FDD\u5B58", { total: sum.total, source: message.source });
        return { ok: true, total: sum.total, confirmed: sum.confirmed, producers: sum.producers, maxInDegree: sum.maxInDegree };
      }
      case "IMG_DB_CLEAR": {
        await producerDbReady;
        producerDb = emptyDb();
        await storageSet(PRODUCER_DB_KEY, producerDb);
        logger5.info("diffuse", "\u751F\u4EA7\u8005\u5E93\u5DF2\u6E05\u7A7A");
        return { ok: true, total: 0 };
      }
      case "IMG_DB_EXPORT": {
        await producerDbReady;
        return { ok: true, json: JSON.stringify(producerDb, null, 1) };
      }
      case "IMG_DB_RESET_CONFIRM": {
        await producerDbReady;
        producerDb = resetConfirmations(producerDb);
        await storageSet(PRODUCER_DB_KEY, producerDb);
        logger5.info("diffuse", "\u786E\u8BA4\u72B6\u6001\u5DF2\u91CD\u7F6E\uFF08\u4FDD\u7559\u5165\u5EA6\uFF09\uFF0C\u9700\u91CD\u65B0\u786E\u8BA4\u8BC4\u5206");
        return { ok: true, total: Object.keys(producerDb.entries).length };
      }
      case "IMG_TAG_GET": {
        await producerDbReady;
        const tags = computeTags(Object.values(producerDb.entries), message.topN ?? 100);
        logger5.info("tag", "\u6807\u7B7E\u4E91\u7EDF\u8BA1\u5B8C\u6210", { tags: tags.length, topN: message.topN ?? 100 });
        return { ok: true, tags };
      }
      case "IMG_DB_IMPORT": {
        await producerDbReady;
        const imported = loadDb(message.db);
        const before = Object.keys(producerDb.entries).length;
        producerDb = mergeDb(producerDb, imported);
        await storageSet(PRODUCER_DB_KEY, producerDb);
        const after = Object.keys(producerDb.entries).length;
        const sum = dbSummary(producerDb);
        logger5.info("diffuse", "\u6570\u636E\u8868\u5DF2\u5BFC\u5165\u5408\u5E76", { before, after, imported: Object.keys(imported.entries).length });
        return {
          ok: true,
          total: after,
          confirmed: sum.confirmed,
          producers: sum.producers,
          maxInDegree: sum.maxInDegree,
          github: { message: `\u5BFC\u5165\u5408\u5E76\uFF1A${before} \u2192 ${after}` }
        };
      }
      case "IMG_SCORE_BATCH": {
        await producerDbReady;
        scoreBatchCancelled = false;
        const candidates = unconfirmedCandidates(producerDb, message.batchSize, message.order ?? "inDegree", message.w1, message.w2);
        if (candidates.length === 0) {
          return { ok: true, score: { processed: 0, withAlbums: 0, zeroAlbums: 0, failed: 0, done: true } };
        }
        let withAlbums = 0;
        let zeroAlbums = 0;
        let failed = 0;
        let cursor = 0;
        const updated = {};
        const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));
        const worker = async () => {
          while (true) {
            const idx = cursor++;
            if (idx >= candidates.length) return;
            const c = candidates[idx];
            await sleep2(message.intervalMs);
            try {
              const { albums: userAlbums, truncated } = await fetchUserAlbums(c.username, SCORE_MAX_PAGES);
              updated[c.username] = {
                ...c,
                albumCount: userAlbums.length,
                albumsChecked: true,
                albumsTruncated: truncated || void 0,
                albums: userAlbums.map((a) => ({ name: a.name, url: a.url }))
              };
              if (userAlbums.length > 0) withAlbums++;
              else zeroAlbums++;
              const session = sessions.get(message.srcTabId);
              if (session) {
                await sendToTab(session.grabTabId, {
                  type: "IMG_SCORE_PROGRESS_FWD",
                  done: withAlbums + zeroAlbums + failed,
                  total: candidates.length,
                  username: c.username,
                  albumCount: userAlbums.length,
                  truncated: truncated || void 0,
                  failed,
                  cancelled: scoreBatchCancelled || void 0
                });
              }
            } catch (err) {
              failed++;
              logger5.warn("score", "albums \u786E\u8BA4\u5931\u8D25\uFF08\u8DF3\u8FC7\uFF09", { user: c.username, error: String(err) });
            }
            if (scoreBatchCancelled) return;
          }
        };
        await Promise.all(Array.from({ length: Math.min(message.concurrency, candidates.length) }, () => worker()));
        const entries = { ...producerDb.entries };
        for (const [u, e] of Object.entries(updated)) entries[u] = e;
        producerDb = { ...producerDb, updatedAt: Date.now(), entries };
        await storageSet(PRODUCER_DB_KEY, producerDb);
        const unconfirmed = unconfirmedCount(producerDb);
        const truncatedCount = Object.values(updated).filter((u) => u.albumsTruncated).length;
        logger5.info("score", "\u786E\u8BA4\u6279\u6B21\u5B8C\u6210", { processed: Object.keys(updated).length, withAlbums, zeroAlbums, failed, unconfirmed, truncated: truncatedCount, cancelled: scoreBatchCancelled });
        return {
          ok: true,
          score: {
            processed: Object.keys(updated).length,
            withAlbums,
            zeroAlbums,
            failed,
            done: !scoreBatchCancelled && unconfirmed === 0
          },
          unconfirmed,
          cancelled: scoreBatchCancelled || void 0
        };
      }
      case "IMG_SCORE_STOP": {
        scoreBatchCancelled = true;
        logger5.info("score", "\u786E\u8BA4\u5DF2\u8BF7\u6C42\u505C\u6B62");
        return { ok: true };
      }
      case "IMG_SCORE_FULL": {
        await producerDbReady;
        const username = (message.username || "").toLowerCase();
        const entry = producerDb.entries[username];
        if (!entry) return { ok: false, error: "\u5E93\u4E2D\u65E0\u6B64\u7528\u6237" };
        logger5.info("score", "\u5F7B\u5E95\u904D\u5386\u5F00\u59CB", { user: username, maxPages: SCORE_FULL_MAX_PAGES });
        try {
          const { albums: userAlbums, truncated } = await fetchUserAlbums(username, SCORE_FULL_MAX_PAGES);
          producerDb.entries[username] = {
            ...entry,
            albumCount: userAlbums.length,
            albumsChecked: true,
            albumsTruncated: truncated || void 0,
            albums: userAlbums.map((a) => ({ name: a.name, url: a.url }))
          };
          await storageSet(PRODUCER_DB_KEY, producerDb);
          logger5.info("score", "\u5F7B\u5E95\u904D\u5386\u5B8C\u6210", { user: username, albums: userAlbums.length, truncated });
          return {
            ok: true,
            full: { username, albumCount: userAlbums.length, truncated }
          };
        } catch (err) {
          logger5.error("score", "\u5F7B\u5E95\u904D\u5386\u5931\u8D25", { user: username, error: String(err) });
          return { ok: false, error: String(err) };
        }
      }
      case "IMG_SEARCH_START": {
        await producerDbReady;
        const scored = confirmedScored(producerDb, message.w1, message.w2);
        const from = Math.min(scored.length, Math.floor(scored.length * message.fromPct / 100));
        const to = Math.min(scored.length, Math.floor(scored.length * message.toPct / 100));
        const keywords = message.keywords.map((k) => k.toLowerCase()).filter(Boolean);
        const matches = scored.slice(from, to).map((c) => ({ username: c.username, inDegree: c.inDegree, albums: matchAlbums(c, keywords) })).filter((m) => m.albums.length > 0);
        logger5.info("search", "\u68C0\u7D22\u5B8C\u6210\uFF08\u5168\u91CF\uFF09", {
          keywords,
          range: `0~${message.toPct}%`,
          candidates: to - from,
          hits: matches.length
        });
        return {
          ok: true,
          search: { total: matches.length, processed: matches.length, matches, done: true },
          unconfirmed: unconfirmedCount(producerDb)
        };
      }
      case "IMG_SEARCH_BATCH": {
        return { ok: true, search: { total: 0, processed: 0, matches: [], done: true } };
      }
      case "IMG_GITHUB_GET_CONFIG": {
        const cfg = normalizeConfig(await storageGet(GITHUB_CONFIG_KEY));
        return {
          ok: true,
          config: cfg ? { repo: cfg.repo, branch: cfg.branch, configured: true } : { repo: "", branch: "main", configured: false }
        };
      }
      case "IMG_GITHUB_SAVE_CONFIG": {
        const cfg = normalizeConfig({ repo: message.repo, token: message.token, branch: message.branch });
        if (!cfg) return { ok: false, error: "\u4ED3\u5E93\u4E0E token \u4E0D\u80FD\u4E3A\u7A7A" };
        await storageSet(GITHUB_CONFIG_KEY, cfg);
        logger5.info("github", "\u540C\u6B65\u914D\u7F6E\u5DF2\u4FDD\u5B58", { repo: cfg.repo, branch: cfg.branch });
        return { ok: true };
      }
      case "IMG_GITHUB_PUSH": {
        try {
          await producerDbReady;
          const cfg = normalizeConfig(await storageGet(GITHUB_CONFIG_KEY));
          if (!cfg) return { ok: false, error: "\u672A\u914D\u7F6E GitHub\uFF0C\u8BF7\u5148\u4FDD\u5B58\u4ED3\u5E93\u4E0E token" };
          const remote = await pullDb(cfg);
          const res = await pushDb(cfg, producerDb, remote.sha);
          logger5.info("github", "\u751F\u4EA7\u8005\u5E93\u5DF2\u63A8\u9001", { repo: cfg.repo, total: Object.keys(producerDb.entries).length });
          return { ok: true, github: { message: `${res.message}\uFF08\u5E93 ${Object.keys(producerDb.entries).length} \u7528\u6237\uFF09` } };
        } catch (err) {
          logger5.error("github", "\u63A8\u9001\u5931\u8D25", String(err));
          return { ok: false, error: String(err) };
        }
      }
      case "IMG_GITHUB_PULL": {
        try {
          await producerDbReady;
          const cfg = normalizeConfig(await storageGet(GITHUB_CONFIG_KEY));
          if (!cfg) return { ok: false, error: "\u672A\u914D\u7F6E GitHub\uFF0C\u8BF7\u5148\u4FDD\u5B58\u4ED3\u5E93\u4E0E token" };
          const remote = await pullDb(cfg);
          if (remote.db) {
            producerDb = mergeDb(producerDb, remote.db);
            await storageSet(PRODUCER_DB_KEY, producerDb);
            logger5.info("github", "\u751F\u4EA7\u8005\u5E93\u5DF2\u62C9\u53D6\u5408\u5E76", { total: Object.keys(producerDb.entries).length });
          }
          return { ok: true, github: { message: `${remote.message}\uFF08\u5E93 ${Object.keys(producerDb.entries).length} \u7528\u6237\uFF09` } };
        } catch (err) {
          logger5.error("github", "\u62C9\u53D6\u5931\u8D25", String(err));
          return { ok: false, error: String(err) };
        }
      }
      case "BD_FETCH_ALBUM": {
        try {
          const { images, pages, title } = await buondua.fetchAlbumAllPages(message.url);
          await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "album", data: images, done: true });
          logger5.info("buondua", "\u5168\u5B50\u9875\u6293\u53D6\u5B8C\u6210", { url: message.url, pages: pages.length, count: images.length, title });
          return { ok: true, name: title || void 0 };
        } catch (err) {
          logger5.warn("buondua", "\u540E\u53F0\u6293\u53D6\u5931\u8D25\uFF0C\u5C1D\u8BD5\u9875\u9762\u5185 fetch \u964D\u7EA7", String(err));
          try {
            const contentFetch = async (u) => {
              const res = await sendToTabAndGet(
                message.srcTabId,
                { type: "BD_FETCH_HTML", url: u }
              );
              if (!res || !res.ok || !res.data) throw new Error(res && !res.ok ? res.error : "\u9875\u9762\u5185 fetch \u65E0\u54CD\u5E94");
              return res.data;
            };
            const { images, pages, title } = await buondua.fetchAlbumAllPages(message.url, contentFetch);
            await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "album", data: images, done: true });
            logger5.info("buondua", "\u5168\u5B50\u9875\u6293\u53D6\u5B8C\u6210\uFF08\u9875\u9762\u5185 fetch \u964D\u7EA7\uFF09", { url: message.url, pages: pages.length, count: images.length, title });
            return { ok: true, name: title || void 0 };
          } catch (err2) {
            logger5.error("buondua", "\u5168\u5B50\u9875\u6293\u53D6\u5931\u8D25\uFF08\u542B\u964D\u7EA7\uFF09", String(err2));
            await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "album", data: [], done: true, error: String(err2) });
            return { ok: false, error: String(err2) };
          }
        }
      }
      case "BD_SCAN_LINKS": {
        try {
          const items = await buondua.scanLinks(message.url, message.kind);
          await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "scan", data: items, done: true });
          logger5.info("buondua", "\u94FE\u63A5\u626B\u63CF\u5B8C\u6210", { kind: message.kind, count: items.length });
        } catch (err) {
          logger5.error("buondua", "\u94FE\u63A5\u626B\u63CF\u5931\u8D25", String(err));
          await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "scan", data: [], done: true, error: String(err) });
        }
        return { ok: true };
      }
      case "BD_TEST_GOOGLE": {
        try {
          return { ok: true, google: await buondua.testGoogleConnection() };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }
      case "BD_SEARCH": {
        try {
          await buondua.searchSites(
            message.query,
            message.sites,
            message.pagesPerSite,
            async (siteId, items, error) => {
              await sendToTab(sessionOf(message.srcTabId), {
                type: "BD_RESULT",
                kind: "search-site",
                data: { siteId, items },
                done: false,
                error
              });
            }
          );
          await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "search", data: [], done: true });
        } catch (err) {
          logger5.error("buondua", "\u805A\u5408\u641C\u7D22\u5931\u8D25", String(err));
          await sendToTab(sessionOf(message.srcTabId), {
            type: "BD_RESULT",
            kind: "search-site",
            data: [],
            done: false,
            error: String(err)
          });
        }
        return { ok: true };
      }
      case "BD_FETCH_ALBUMS": {
        try {
          const targets = message.targets;
          let completed = 0;
          await buondua.fetchAlbumsBatch(
            targets.map((t) => ({ url: t.url, title: t.folderName })),
            (index, _target, images) => {
              completed++;
              void sendToTab(sessionOf(message.srcTabId), {
                type: "BD_RESULT",
                kind: "batch-item",
                data: { index, target: targets[index], images, pages: [] },
                done: completed >= targets.length
              });
            }
          );
          logger5.info("buondua", "\u6279\u91CF\u6293\u53D6\u5B8C\u6210", { total: targets.length });
        } catch (err) {
          logger5.error("buondua", "\u6279\u91CF\u6293\u53D6\u5931\u8D25", String(err));
          await sendToTab(sessionOf(message.srcTabId), {
            type: "BD_RESULT",
            kind: "batch-item",
            data: { index: -1, target: { url: "", folderName: "" }, images: [], pages: [] },
            done: true,
            error: String(err)
          });
        }
        return { ok: true };
      }
    }
    return { ok: false, error: "\u672A\u77E5\u6D88\u606F\u7C7B\u578B" };
  }
  logger5.info("runtime", "background \u521D\u59CB\u5316\u5B8C\u6210");
})();
//# sourceMappingURL=background.js.map
