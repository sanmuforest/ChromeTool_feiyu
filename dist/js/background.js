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
  var STAR_WEIGHT = 0.5;
  var MAX_STARS = 5;
  function emptyDb() {
    return { version: PRODUCER_DB_VERSION, updatedAt: Date.now(), entries: {} };
  }
  function clampStars(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(MAX_STARS, v));
  }
  function loadDb(raw) {
    if (raw && typeof raw === "object" && typeof raw.entries === "object") {
      const entries = raw.entries;
      const cleaned = {};
      for (const [k, v] of Object.entries(entries)) {
        if (v && typeof v.username === "string" && typeof v.inDegree === "number") {
          const copy = { ...v };
          if (copy.starRating !== void 0) {
            const stars = clampStars(copy.starRating);
            if (stars > 0) copy.starRating = stars;
            else delete copy.starRating;
          }
          cleaned[k] = copy;
        }
      }
      return { version: PRODUCER_DB_VERSION, updatedAt: Date.now(), entries: cleaned };
    }
    return emptyDb();
  }
  function ensureEntry(db, username, source = "star", now = Date.now()) {
    if (db.entries[username]) return db;
    return {
      ...db,
      updatedAt: now,
      entries: {
        ...db.entries,
        [username]: { username, inDegree: 0, firstSeenAt: now, lastSeenAt: now, sources: [source] }
      }
    };
  }
  function starInfo(db, username) {
    const e = db.entries[username];
    return {
      username,
      starRating: e ? clampStars(e.starRating) : 0,
      inDegree: e?.inDegree ?? 0,
      albumCount: e?.albumsChecked ? e.albumCount : void 0,
      albumsChecked: !!e?.albumsChecked,
      inLibrary: !!e
    };
  }
  function setStarRating(db, username, stars) {
    const prev = db.entries[username];
    if (!prev) return db;
    const value = clampStars(stars);
    const entries = { ...db.entries };
    if (value > 0) entries[username] = { ...prev, starRating: value };
    else {
      const { starRating: _drop, ...rest } = prev;
      entries[username] = rest;
    }
    return { ...db, updatedAt: Date.now(), entries };
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
          albums: entry.albums ?? prev.albums,
          // 星级为人工评定：本地已评则保留本地，本地未评才采纳外部
          starRating: prev.starRating ?? entry.starRating
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
    const base = w1 * logNorm(entry.inDegree, maxInDegree) + w2 * logNorm(albumCount, maxAlbumCount);
    const star = clampStars(entry.starRating) / MAX_STARS;
    return STAR_WEIGHT * star + (1 - STAR_WEIGHT) * base;
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
    return Object.values(db.entries).sort((a, b) => b.inDegree - a.inDegree).slice(0, Math.max(0, n)).map((e) => ({
      username: e.username,
      url: `https://${e.username}.imgbb.com`,
      inDegree: e.inDegree,
      starRating: clampStars(e.starRating)
    }));
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

  // src/lib/tag-dict.ts
  var TAG_CATEGORY_LABEL = {
    ip: "\u4F5C\u54C1\u89D2\u8272",
    theme: "\u4E3B\u9898",
    scene: "\u573A\u666F",
    clothes: "\u670D\u88C5",
    fetish: "\u604B\u7269",
    act: "\u884C\u4E3A\u73A9\u6CD5",
    prop: "\u9053\u5177",
    body: "\u8EAB\u6750\u7279\u5F81",
    relation: "\u5173\u7CFB\u4EBA\u6570",
    japanese: "\u6F14\u5458",
    korean: "\u97E9\u8BED",
    brand: "\u54C1\u724C",
    english: "\u82F1\u6587",
    at: "\u5F15\u7528"
  };
  var TAG_DICT = [
    // ---------- 服装 clothes ----------
    { t: "\u4E1D\u889C", c: "clothes", syn: ["\u9ED1\u4E1D", "\u767D\u4E1D", "\u7F51\u889C", "\u6E14\u7F51\u889C", "\u8FDE\u88E4\u889C", "\u88E4\u889C", "\u540A\u5E26\u889C", "\u957F\u889C", "stockings", "pantyhose", "tights", "pantyhose", "\u7DB2\u30BF\u30A4\u30C4", "\u30B9\u30C8\u30C3\u30AD\u30F3\u30B0"] },
    { t: "\u5185\u8863", c: "clothes", syn: ["\u6587\u80F8", "\u80F8\u7F69", "\u5185\u88E4", "underwear", "lingerie", "bra", "panties", "knickers", "\u4E0B\u7740", "\u30E9\u30F3\u30B8\u30A7\u30EA\u30FC", "\uBE0C\uB77C"] },
    { t: "\u857E\u4E1D", c: "clothes", syn: ["lace", "\u30EC\u30FC\u30B9", "\uB808\uC774\uC2A4"] },
    { t: "\u6CF3\u88C5", c: "clothes", syn: ["\u6CF3\u8863", "\u6BD4\u57FA\u5C3C", "\u6B7B\u5E93\u6C34", "\u6C34\u7740", "swimsuit", "bikini", "swimwear", "one-piece swimsuit", "\u30B9\u30AF\u6C34", "\uBE44\uD0A4\uB2C8"] },
    { t: "\u5236\u670D", c: "clothes", syn: ["\u6821\u670D", "\u6C34\u624B\u670D", "uniform", "school uniform", "sailor uniform", "seifuku", "\u5236\u670D", "\u30BB\u30FC\u30E9\u30FC\u670D", "\uAD50\uBCF5"] },
    { t: "OL\u88C5", c: "clothes", syn: ["ol", "office lady", "\u804C\u4E1A\u88C5", "ol\u5236\u670D", "\u5305\u81C0\u88D9", "\u94C5\u7B14\u88D9", "pencil skirt"] },
    { t: "\u62A4\u58EB\u88C5", c: "clothes", syn: ["\u62A4\u58EB", "nurse", "nurse outfit", "\u30CA\u30FC\u30B9", "\uAC04\uD638\uC0AC"] },
    { t: "\u5973\u4EC6\u88C5", c: "clothes", syn: ["\u5973\u4EC6", "maid", "maid outfit", "\u30E1\u30A4\u30C9", "\uBA54\uC774\uB4DC"] },
    { t: "\u5154\u5973\u90CE", c: "clothes", syn: ["bunny", "bunny girl", "playboy bunny", "\u30D0\u30CB\u30FC\u30AC\u30FC\u30EB"] },
    { t: "\u65D7\u888D", c: "clothes", syn: ["qipao", "cheongsam", "\u30C1\u30E3\u30A4\u30CA\u30C9\u30EC\u30B9", "\uCE58\uD30C\uC624"] },
    { t: "\u548C\u670D", c: "clothes", syn: ["\u6D74\u8863", "kimono", "yukata", "\u7740\u7269", "\u6D74\u8863"] },
    { t: "\u5A5A\u7EB1", c: "clothes", syn: ["\u82B1\u5AC1", "wedding dress", "bridal", "\u30A6\u30A7\u30C7\u30A3\u30F3\u30B0\u30C9\u30EC\u30B9", "\uC6E8\uB529\uB4DC\uB808\uC2A4"] },
    { t: "\u7761\u8863", c: "clothes", syn: ["\u7761\u8863\u88E4", "pajamas", "pyjamas", "nightwear", "nightgown", "\u30D1\u30B8\u30E3\u30DE", "\uC7A0\uC637"] },
    { t: "\u7D27\u8EAB\u8863", c: "clothes", syn: ["\u8FDE\u4F53\u8863", "bodysuit", "leotard", "body stocking", "\u30DC\u30C7\u30A3\u30B9\u30FC\u30C4"] },
    { t: "\u4F53\u64CD\u670D", c: "clothes", syn: ["\u4F53\u80B2\u670D", "gym uniform", "gym suit", "\u30D6\u30EB\u30DE", "\uCCB4\uC721\uBCF5"] },
    { t: "\u76AE\u8863", c: "clothes", syn: ["\u76AE\u88D9", "\u76AE\u88E4", "leather jacket", "leather skirt", "leather pants"] },
    { t: "\u77ED\u88D9", c: "clothes", syn: ["\u8FF7\u4F60\u88D9", "\u767E\u8936\u88D9", "miniskirt", "pleated skirt", "\u30DE\u30A4\u30AF\u30ED\u30DF\u30CB"] },
    { t: "\u70ED\u88E4", c: "clothes", syn: ["\u77ED\u88E4", "\u725B\u4ED4\u77ED\u88E4", "shorts", "hot pants", "denim shorts"] },
    { t: "\u957F\u88D9", c: "clothes", syn: ["\u8FDE\u8863\u88D9", "\u88D9\u5B50", "dress", "long skirt", "\u30EF\u30F3\u30D4\u30FC\u30B9"] },
    { t: "\u9AD8\u8DDF\u978B", c: "clothes", syn: ["\u9AD8\u8DDF", "\u7EC6\u8DDF", "heels", "high heels", "stilettos", "\u30CF\u30A4\u30D2\u30FC\u30EB", "\uD558\uC774\uD790"] },
    { t: "\u957F\u9774", c: "clothes", syn: ["\u77ED\u9774", "\u8FC7\u819D\u9774", "\u9A6C\u4E01\u9774", "boots", "knee boots", "thigh boots", "\u30D6\u30FC\u30C4"] },
    { t: "\u51C9\u978B", c: "clothes", syn: ["sandals", "\u30B5\u30F3\u30C0\u30EB"] },
    { t: "\u88F8\u8DB3", c: "clothes", syn: ["\u7389\u8DB3", "\u8DB3\u88CF", "\u7F8E\u8DB3", "barefoot", "bare feet", "\u8DB3\u30B3\u30AD", "\u7D20\u8DB3", "\uB9E8\uBC1C"] },
    { t: "\u624B\u5957", c: "clothes", syn: ["gloves", "\u624B\u888B", "\uC7A5\uAC11"] },
    { t: "\u5E3D\u5B50", c: "clothes", syn: ["\u8D1D\u96F7\u5E3D", "\u68D2\u7403\u5E3D", "hat", "cap", "beret", "\u5E3D\u5B50", "\uBAA8\uC790"] },
    { t: "\u56F4\u5DFE", c: "clothes", syn: ["\u4E1D\u5DFE", "scarf", "\u30DE\u30D5\u30E9\u30FC"] },
    { t: "\u6BDB\u8863", c: "clothes", syn: ["\u9488\u7EC7\u886B", "sweater", "knitwear", "cardigan", "\u30CB\u30C3\u30C8"] },
    { t: "\u886C\u886B", c: "clothes", syn: ["\u767D\u886C\u886B", "shirt", "blouse", "\u30EF\u30A4\u30B7\u30E3\u30C4", "\uC154\uCE20"] },
    { t: "\u536B\u8863", c: "clothes", syn: ["hoodie", "sweatshirt", "\u30D1\u30FC\u30AB\u30FC"] },
    { t: "\u98CE\u8863", c: "clothes", syn: ["\u5927\u8863", "\u5916\u5957", "coat", "trench coat", "jacket", "\u30B3\u30FC\u30C8"] },
    { t: "\u6597\u7BF7", c: "clothes", syn: ["\u62AB\u98CE", "cloak", "cape", "\u30DE\u30F3\u30C8"] },
    { t: "\u9886\u5E26", c: "clothes", syn: ["\u9886\u7ED3", "\u8774\u8776\u7ED3", "necktie", "necktie", "bow tie", "ribbon tie", "\u30CD\u30AF\u30BF\u30A4"] },
    { t: "\u540A\u5E26", c: "clothes", syn: ["\u80CC\u5FC3", "camisole", "tank top", "\u30AD\u30E3\u30DF\u30BD\u30FC\u30EB"] },
    { t: "\u6C49\u670D", c: "clothes", syn: ["\u53E4\u88C5", "hanfu", "ancient costume", "\u4E2D\u83EF\u670D"] },
    { t: "\u8FD0\u52A8\u88C5", c: "clothes", syn: ["\u745C\u4F3D\u88E4", "sportswear", "yoga pants", "leggings", "track suit", "\u30B9\u30DD\u30FC\u30C4\u30A6\u30A7\u30A2"] },
    { t: "\u725B\u4ED4\u88E4", c: "clothes", syn: ["\u725B\u4ED4", "jeans", "denim", "\u30B8\u30FC\u30F3\u30BA"] },
    { t: "\u4E01\u5B57\u88E4", c: "clothes", syn: ["thong", "g-string", "g string", "t-back", "T\u30D0\u30C3\u30AF"] },
    { t: "\u8FDE\u4F53\u889C", c: "clothes", syn: ["bodystocking", "body stocking", "\u5168\u8EAB\u30BF\u30A4\u30C4"] },
    { t: "\u767D\u5927\u8902", c: "clothes", syn: ["\u533B\u751F", "lab coat", "doctor", "\u767D\u8863"] },
    { t: "\u7A7A\u59D0\u88C5", c: "clothes", syn: ["\u7A7A\u59D0", "flight attendant", "cabin crew", "ca uniform"] },
    { t: "\u8B66\u5BDF\u88C5", c: "clothes", syn: ["\u8B66\u5B98", "\u8B66\u5BDF", "police", "police uniform", "\u8B66\u5B98\u670D"] },
    { t: "\u519B\u88C5", c: "clothes", syn: ["\u519B\u670D", "military uniform", "army", "army uniform", "\u30DF\u30EA\u30BF\u30EA\u30FC"] },
    { t: "\u4FEE\u5973\u670D", c: "clothes", syn: ["\u4FEE\u5973", "nun", "nun outfit", "\u30B7\u30B9\u30BF\u30FC"] },
    { t: "\u5DEB\u5973\u670D", c: "clothes", syn: ["\u5DEB\u5973", "miko", "shrine maiden", "\u5DEB\u5973\u88C5\u675F"] },
    { t: "\u77ED\u889C", c: "clothes", syn: ["\u4E2D\u7B52\u889C", "\u8239\u889C", "\u5206\u8DBE\u889C", "ankle socks", "socks", "\u30BD\u30C3\u30AF\u30B9", "\uC591\uB9D0"] },
    { t: "\u809A\u515C", c: "clothes", syn: ["dudou", "belly cover"] },
    { t: "\u5934\u7EB1", c: "clothes", syn: ["\u9762\u7EB1", "veil", "head veil", "\u30D9\u30FC\u30EB"] },
    { t: "\u675F\u8170", c: "clothes", syn: ["corset", "waist cincher", "\u30B3\u30EB\u30BB\u30C3\u30C8"] },
    { t: "\u82AD\u857E\u821E\u88D9", c: "clothes", syn: ["\u82AD\u857E", "ballet", "tutu", "\u30D0\u30EC\u30A8"] },
    { t: "\u6F5C\u6C34\u670D", c: "clothes", syn: ["wetsuit", "diving suit", "\u30A6\u30A7\u30C3\u30C8\u30B9\u30FC\u30C4"] },
    // ---------- 恋物 fetish ----------
    { t: "\u80F6\u8863", c: "fetish", syn: ["\u4E73\u80F6", "\u6A61\u80F6", "latex", "rubber", "pvc", "\u30E9\u30D0\u30FC"] },
    { t: "\u675F\u7F1A", c: "fetish", syn: ["\u6346\u7ED1", "\u7EF3\u827A", "\u7EF3\u7F1A", "\u7D27\u7F1A", "bondage", "kinbaku", "shibari", "rope bondage", "\u7DCA\u7E1B"] },
    { t: "\u9879\u5708", c: "fetish", syn: ["\u9888\u5708", "choker", "collar", "\u30C1\u30E7\u30FC\u30AB\u30FC", "\uBAA9\uAC78\uC774"] },
    { t: "\u53E3\u7403", c: "fetish", syn: ["\u53E3\u585E", "\u53E3\u67B7", "ball gag", "gag", "\u30DC\u30FC\u30EB\u30AE\u30E3\u30B0"] },
    { t: "\u624B\u94D0", c: "fetish", syn: ["\u9563\u94D0", "\u624B\u62F7", "handcuffs", "cuffs", "\u624B\u9320"] },
    { t: "\u773C\u7F69", c: "fetish", syn: ["blindfold", "eye mask", "\u30A2\u30A4\u30DE\u30B9\u30AF"] },
    { t: "\u76AE\u97AD", c: "fetish", syn: ["\u97AD\u5B50", "whip", "flogger", "\u97AD"] },
    { t: "\u9501\u94FE", c: "fetish", syn: ["\u94C1\u94FE", "chain", "chains", "\u9396"] },
    { t: "\u900F\u660E\u88C5", c: "fetish", syn: ["\u8584\u7EB1", "\u900F\u89C6", "transparent", "see-through", "sheer", "\u30B7\u30FC\u30B9\u30EB\u30FC"] },
    { t: "\u6E7F\u8EAB", c: "fetish", syn: ["wetlook", "wet look", "wet body", "\u6FE1\u308C", "wet shirt"] },
    { t: "\u88F8\u56F4\u88D9", c: "fetish", syn: ["naked apron", "\u88F8\u30A8\u30D7\u30ED\u30F3"] },
    { t: "\u773C\u955C", c: "fetish", syn: ["\u773C\u93E1", "glasses", "megane", "\u30E1\u30AC\u30CD", "\uC548\uACBD"] },
    { t: "\u732B\u8033", c: "fetish", syn: ["\u732B\u5A18", "\u5154\u8033", "\u72AC\u8033", "cat ears", "catgirl", "bunny ears", "nekomimi", "\u732B\u8033"] },
    { t: "\u5C3E\u5DF4", c: "fetish", syn: ["tail", "\u5C3B\u5C3E", "\u30C6\u30FC\u30EB"] },
    { t: "\u7FC5\u8180", c: "fetish", syn: ["wings", "wing", "\u7FFC"] },
    { t: "\u7CBE\u7075\u8033", c: "fetish", syn: ["elf ears", "elf", "\u30A8\u30EB\u30D5\u8033"] },
    { t: "\u7EB9\u8EAB", c: "fetish", syn: ["\u523A\u9752", "tattoo", "tattoos", "\u30BF\u30C8\u30A5\u30FC", "\uBB38\uC2E0"] },
    { t: "\u7A7F\u5B54", c: "fetish", syn: ["\u820C\u9489", "\u8033\u73AF", "piercing", "piercings", "\u30D4\u30A2\u30B9"] },
    { t: "\u4E1D\u5E26", c: "fetish", syn: ["\u7F0E\u5E26", "ribbon", "ribbons", "\u30EA\u30DC\u30F3"] },
    { t: "\u4E73\u8D34", c: "fetish", syn: ["pasties", "pasties", "\u30CB\u30D7\u30EC\u30B9"] },
    { t: "\u7EF7\u5E26", c: "fetish", syn: ["\u5305\u5E26", "bandage", "bandages", "\u5305\u5E2F"] },
    { t: "\u8721\u70DB", c: "fetish", syn: ["\u6EF4\u8721", "candle", "wax play", "\u881F\u71ED"] },
    { t: "\u51B0\u5757", c: "fetish", syn: ["ice", "ice cubes", "\u6C37"] },
    { t: "\u5047\u53D1", c: "fetish", syn: ["wig", "wigs", "\u30A6\u30A3\u30C3\u30B0"] },
    { t: "\u53E3\u7F69", c: "fetish", syn: ["\u9762\u7F69", "mouth mask", "face mask", "\u30DE\u30B9\u30AF"] },
    { t: "\u5BA0\u7269\u88C5", c: "fetish", syn: ["\u5BA0\u7269", "pet play", "puppy play", "\u30B1\u30E2\u30CA\u30FC"] },
    // ---------- 行为玩法 act ----------
    { t: "\u81EA\u62CD", c: "act", syn: ["selfie", "self shot", "\u81EA\u62CD\u7167", "\uC140\uCE74"] },
    { t: "\u9732\u51FA", c: "act", syn: ["\u91CE\u5916\u9732\u51FA", "\u6237\u5916\u9732\u51FA", "exhibitionism", "outdoor exposure", "public nudity", "\u9732\u51FA\u30D7\u30EC\u30A4"] },
    { t: "\u6C90\u6D74", c: "act", syn: ["\u6DCB\u6D74", "\u6D17\u6FA1", "shower", "\u30B7\u30E3\u30EF\u30FC", "\uC0E4\uC6CC"] },
    { t: "\u6CE1\u6FA1", c: "act", syn: ["\u6D74\u7F38", "\u5165\u6D74", "bath", "bathtub", "\u304A\u98A8\u5442", "\uC695\uC870"] },
    { t: "\u6309\u6469", c: "act", syn: ["massage", "oil massage", "\u30DE\u30C3\u30B5\u30FC\u30B8", "\uB9C8\uC0AC\uC9C0"] },
    { t: "\u745C\u4F3D", c: "act", syn: ["yoga", "\u30E8\u30AC", "\uC694\uAC00"] },
    { t: "\u5065\u8EAB", c: "act", syn: ["\u8FD0\u52A8", "workout", "fitness", "training", "gym workout", "\u7B4B\u30C8\u30EC"] },
    { t: "\u8DF3\u821E", c: "act", syn: ["\u821E\u8E48", "dance", "dancing", "\u30C0\u30F3\u30B9", "\uB304\uC2A4"] },
    { t: "\u7761\u59FF", c: "act", syn: ["\u7761\u989C", "\u7761\u7720", "sleeping", "sleep", "\u5BDD\u9854", "\uC218\uBA74"] },
    { t: "\u4F38\u5C55", c: "act", syn: ["\u62C9\u4F38", "stretching", "stretch", "\u30B9\u30C8\u30EC\u30C3\u30C1"] },
    { t: "\u6362\u8863", c: "act", syn: ["\u6362\u88C5", "changing clothes", "undressing", "\u7740\u66FF\u3048"] },
    { t: "\u66F4\u8863\u5BA4", c: "act", syn: ["locker room", "changing room", "\u8131\u8863\u6240"] },
    { t: "\u8214", c: "act", syn: ["\u8214\u8DB3", "licking", "lick", "\u8210\u3081"] },
    { t: "\u4EB2\u543B", c: "act", syn: ["\u63A5\u543B", "\u6E7F\u543B", "kiss", "kissing", "deep kiss", "\u30AD\u30B9"] },
    { t: "\u62E5\u62B1", c: "act", syn: ["hug", "hugging", "embrace", "\u30CF\u30B0"] },
    { t: "\u8DEA\u59FF", c: "act", syn: ["\u8DEA", "kneeling", "kneel", "\u571F\u4E0B\u5EA7", "\u3072\u3056\u307E\u305A\u304F"] },
    { t: "\u5367\u59FF", c: "act", syn: ["\u8DB4\u59FF", "lying", "lying down", "on all fours", "\u5BDD\u305D\u3079\u308A"] },
    { t: "\u629A\u6478", c: "act", syn: ["\u4E92\u6478", "touching", "caress", "fondling", "\u611B\u64AB"] },
    { t: "\u81EA\u6170", c: "act", syn: ["masturbation", "masturbating", "\u30AA\u30CA\u30CB\u30FC", "\uC790\uC704"] },
    { t: "\u53E3\u4EA4", c: "act", syn: ["\u6DF1\u5589", "oral", "fellatio", "blowjob", "deepthroat", "\u30D5\u30A7\u30E9", "\uAD6C\uAC15"] },
    { t: "\u8DB3\u4EA4", c: "act", syn: ["footjob", "\u8DB3\u30B3\u30AD"] },
    { t: "\u4E73\u4EA4", c: "act", syn: ["paizuri", "titjob", "\u30D1\u30A4\u30BA\u30EA"] },
    { t: "\u624B\u4EA4", c: "act", syn: ["handjob", "\u624B\u30B3\u30AD"] },
    { t: "69\u5F0F", c: "act", syn: ["69", "sixty nine", "\u30B7\u30C3\u30AF\u30B9\u30CA\u30A4\u30F3"] },
    { t: "\u6027\u4EA4", c: "act", syn: ["\u505A\u7231", "sex", "sexual intercourse", "\u30BB\u30C3\u30AF\u30B9", "\uC139\uC2A4"] },
    { t: "\u540E\u5165", c: "act", syn: ["doggystyle", "doggy style", "\u30D0\u30C3\u30AF"] },
    { t: "\u9A91\u4E58", c: "act", syn: ["cowgirl", "riding", "\u9A0E\u4E57\u4F4D"] },
    { t: "\u7FA4\u4EA4", c: "act", syn: ["\u4E71\u4EA4", "orgy", "gangbang", "group sex", "\u4E71\u4EA4\u30D1\u30FC\u30C6\u30A3"] },
    { t: "\u767E\u5408", c: "act", syn: ["lesbian", "lesbians", "girls love", "\u30EC\u30BA", "\uBC31\uD569"] },
    { t: "\u8C03\u6559", c: "act", syn: ["bdsm", "training", "domination", "sm", "\u8ABF\u6559"] },
    { t: "\u704C\u80A0", c: "act", syn: ["enema", "\u6D63\u8178"] },
    { t: "\u6392\u5C3F", c: "act", syn: ["\u653E\u5C3F", "peeing", "urination", "\u304A\u3057\u3063\u3053", "\uBC29\uB1E8"] },
    { t: "\u989C\u5C04", c: "act", syn: ["facial", "cum on face", "\u9854\u5C04"] },
    { t: "\u4E2D\u51FA", c: "act", syn: ["creampie", "internal cumshot", "\u4E2D\u51FA\u3057"] },
    { t: "\u907F\u5B55\u5957", c: "act", syn: ["condom", "\u30B4\u30E0"] },
    { t: "\u88F8\u4F53", c: "act", syn: ["\u5168\u88F8", "nude", "naked", "full nude", "\u30CC\u30FC\u30C9", "\uB204\uB4DC"] },
    { t: "\u534A\u88F8", c: "act", syn: ["topless", "half naked", "\u534A\u88F8", "\u30BB\u30DF\u30CC\u30FC\u30C9"] },
    // ---------- 道具 prop ----------
    { t: "\u73A9\u5177", c: "prop", syn: ["\u5047\u9633\u5177", "toy", "sex toy", "dildo", "\u304A\u3082\u3061\u3083"] },
    { t: "\u6309\u6469\u68D2", c: "prop", syn: ["vibrator", "wand", "\u30D0\u30A4\u30D6"] },
    { t: "\u8DF3\u86CB", c: "prop", syn: ["egg vibrator", "love egg", "\u30ED\u30FC\u30BF\u30FC"] },
    { t: "\u7EF3\u5B50", c: "prop", syn: ["rope", "ropes", "\u7E04"] },
    { t: "\u955C\u5B50", c: "prop", syn: ["mirror", "\u93E1", "\uAC70\uC6B8"] },
    { t: "\u6905\u5B50", c: "prop", syn: ["chair", "stool", "\u6905\u5B50", "\u30C1\u30A7\u30A2"] },
    { t: "\u6C99\u53D1", c: "prop", syn: ["sofa", "couch", "\u30BD\u30D5\u30A1"] },
    { t: "\u5E8A", c: "prop", syn: ["bed", "bedroom bed", "\u30D9\u30C3\u30C9", "\uCE68\uB300"] },
    { t: "\u6C14\u7403", c: "prop", syn: ["balloon", "balloons", "\u98A8\u8239"] },
    { t: "\u82B1\u675F", c: "prop", syn: ["\u82B1", "flower", "flowers", "bouquet", "\u82B1\u675F"] },
    { t: "\u4E66\u672C", c: "prop", syn: ["book", "books", "\u672C"] },
    { t: "\u98DF\u7269", c: "prop", syn: ["food", "snack", "\u6599\u7406", "\uC74C\uC2DD"] },
    { t: "\u51B0\u6DC7\u6DCB", c: "prop", syn: ["ice cream", "\u30A2\u30A4\u30B9\u30AF\u30EA\u30FC\u30E0"] },
    { t: "\u9152\u676F", c: "prop", syn: ["\u9152", "wine", "cocktail", "\u30B0\u30E9\u30B9"] },
    { t: "\u9999\u70DF", c: "prop", syn: ["cigarette", "smoking", "\u30BF\u30D0\u30B3", "\uB2F4\uBC30"] },
    { t: "\u9EA6\u514B\u98CE", c: "prop", syn: ["microphone", "mic", "\u30DE\u30A4\u30AF"] },
    { t: "\u6E38\u620F\u624B\u67C4", c: "prop", syn: ["game controller", "controller", "\u30B2\u30FC\u30E0\u30D1\u30C3\u30C9"] },
    { t: "\u6444\u50CF\u673A", c: "prop", syn: ["camera", "camcorder", "\u30AB\u30E1\u30E9"] },
    { t: "\u6BDB\u5DFE", c: "prop", syn: ["\u6D74\u5DFE", "towel", "\u30BF\u30AA\u30EB", "\uC218\uAC74"] },
    { t: "\u6795\u5934", c: "prop", syn: ["pillow", "\u6795"] },
    // ---------- 身材特征 body ----------
    { t: "\u5DE8\u4E73", c: "body", syn: ["\u7206\u4E73", "\u5927\u80F8", "\u4E30\u6EE1", "big breasts", "big boobs", "large breasts", "\u5DE8\u4E73", "\uAC70\uC720"] },
    { t: "\u8D2B\u4E73", c: "body", syn: ["\u5FAE\u4E73", "\u5E73\u80F8", "small breasts", "flat chest", "\u8CA7\u4E73", "\uBE48\uC720"] },
    { t: "\u957F\u817F", c: "body", syn: ["\u7F8E\u817F", "\u5927\u957F\u817F", "long legs", "legs", "\u7F8E\u811A", "\uB871\uB2E4\uB9AC"] },
    { t: "\u7FD8\u81C0", c: "body", syn: ["\u7F8E\u81C0", "\u81C0\u90E8", "big ass", "big butt", "ass", "\u304A\u5C3B", "\uD799"] },
    { t: "\u7EC6\u8170", c: "body", syn: ["\u5C0F\u86EE\u8170", "slim waist", "narrow waist", "\u304F\u3073\u308C"] },
    { t: "\u8179\u808C", c: "body", syn: ["\u9A6C\u7532\u7EBF", "abs", "six pack", "\u8179\u7B4B"] },
    { t: "\u77ED\u53D1", c: "body", syn: ["short hair", "\u30B7\u30E7\u30FC\u30C8\u30D8\u30A2", "\uB2E8\uBC1C"] },
    { t: "\u957F\u53D1", c: "body", syn: ["long hair", "\u30ED\u30F3\u30B0\u30D8\u30A2", "\uC7A5\uBC1C"] },
    { t: "\u53CC\u9A6C\u5C3E", c: "body", syn: ["twintails", "twin tails", "\u30C4\u30A4\u30F3\u30C6\u30FC\u30EB"] },
    { t: "\u9A6C\u5C3E", c: "body", syn: ["ponytail", "\u30DD\u30CB\u30FC\u30C6\u30FC\u30EB"] },
    { t: "\u4E38\u5B50\u5934", c: "body", syn: ["\u56E2\u5B50\u5934", "bun hair", "hair bun", "\u304A\u56E3\u5B50"] },
    { t: "\u5377\u53D1", c: "body", syn: ["curly hair", "wavy hair", "\u30D1\u30FC\u30DE"] },
    { t: "\u91D1\u53D1", c: "body", syn: ["blonde", "blond", "golden hair", "\u30D6\u30ED\u30F3\u30C9", "\uAE08\uBC1C"] },
    { t: "\u9ED1\u53D1", c: "body", syn: ["brunette", "black hair", "\u9ED2\u9AEA", "\uD751\uBC1C"] },
    { t: "\u67D3\u53D1", c: "body", syn: ["\u5F69\u53D1", "colored hair", "dyed hair", "\u30AB\u30E9\u30FC\u9AEA"] },
    { t: "\u96C0\u6591", c: "body", syn: ["freckles", "\u305D\u3070\u304B\u3059"] },
    { t: "\u9152\u7A9D", c: "body", syn: ["dimples", "\u3048\u304F\u307C"] },
    { t: "\u767D\u7699", c: "body", syn: ["\u767D\u808C", "\u7F8E\u767D", "pale skin", "fair skin", "\u767D\u808C", "\uBC31\uD53C\uBD80"] },
    { t: "\u5C0F\u9EA6\u8272", c: "body", syn: ["\u65E5\u70E7", "tan", "tanned", "suntan", "\u65E5\u713C\u3051"] },
    { t: "\u808C\u8089", c: "body", syn: ["muscular", "muscle", "\u7B4B\u8089"] },
    { t: "\u5B55\u5987", c: "body", syn: ["pregnant", "pregnancy", "\u598A\u5A66", "\uC784\uC0B0\uBD80"] },
    { t: "\u6210\u719F", c: "body", syn: ["\u719F\u5973", "mature", "milf", "mature woman", "\u719F\u5973"] },
    { t: "\u5A07\u5C0F", c: "body", syn: ["\u5C0F\u53EA", "petite", "small body", "\u30DF\u30CB"] },
    { t: "\u9AD8\u4E2A", c: "body", syn: ["\u957F\u8EAB", "tall", "tall girl", "\u9577\u8EAB"] },
    { t: "\u6E05\u7EAF", c: "body", syn: ["\u7D20\u989C", "innocent", "pure face", "no makeup", "\u3059\u3063\u3074\u3093"] },
    { t: "\u6CEA\u75E3", c: "body", syn: ["\u7F8E\u4EBA\u75E3", "mole under eye", "\u6CE3\u304D\u307C\u304F\u308D"] },
    { t: "\u864E\u7259", c: "body", syn: ["\u516B\u91CD\u9F7F", "fang tooth", "yaeba", "\u516B\u91CD\u6B6F"] },
    { t: "\u841D\u8389", c: "body", syn: ["loli", "lolita", "\u30ED\u30EA", "\uB85C\uB9AC"] },
    { t: "\u5FA1\u59D0", c: "body", syn: ["onee-san", "oneesan", "\u304A\u59C9\u3055\u3093", "\uB204\uB098"] },
    // ---------- 关系人数 relation ----------
    { t: "\u53CC\u4EBA", c: "relation", syn: ["\u4E8C\u4EBA", "two girls", "pair", "2 girls", "\u30DA\u30A2"] },
    { t: "\u4E09\u4EBA", c: "relation", syn: ["3p", "threesome", "three girls", "\u30B9\u30EA\u30FC"] },
    { t: "\u591A\u4EBA", c: "relation", syn: ["\u7FA4\u4F53", "group", "multiple girls", "several girls", "\u96C6\u56E3"] },
    { t: "\u60C5\u4FA3", c: "relation", syn: ["\u604B\u4EBA", "couple", "couples", "\u30AB\u30C3\u30D7\u30EB", "\uCEE4\uD50C"] },
    { t: "\u95FA\u871C", c: "relation", syn: ["\u597D\u53CB", "besties", "best friends", "friends", "\u89AA\u53CB"] },
    { t: "\u59D0\u59B9", c: "relation", syn: ["\u59C9\u59B9", "sisters", "sister", "\u59C9\u59B9"] },
    { t: "\u6BCD\u5973", c: "relation", syn: ["\u89AA\u5B50", "mother daughter", "mom and daughter"] },
    { t: "\u5E08\u751F", c: "relation", syn: ["teacher student", "teacher and student", "\u5E2B\u5F1F"] },
    { t: "\u7537\u5973", c: "relation", syn: ["hetero", "male and female", "couple man woman", "\u7537\u5973"] },
    { t: "\u5355\u4EBA", c: "relation", syn: ["\u4E00\u4EBA", "solo", "single girl", "1girl", "\u30BD\u30ED"] },
    { t: "\u9732\u8138", c: "relation", syn: ["\u6B63\u8138", "face visible", "face shot", "\u9854\u51FA\u3057"] },
    { t: "\u8499\u9762", c: "relation", syn: ["masked", "mask", "face covered", "\u8986\u9762"] },
    { t: "\u592B\u59BB", c: "relation", syn: ["husband wife", "married couple", "\u592B\u5A66"] },
    // ---------- 场景 scene ----------
    { t: "\u6D77\u8FB9", c: "scene", syn: ["\u6C99\u6EE9", "\u6D77\u6EE9", "beach", "seaside", "\u30D3\u30FC\u30C1", "\uD574\uBCC0"] },
    { t: "\u6CF3\u6C60", c: "scene", syn: ["\u6E38\u6CF3\u6C60", "pool", "swimming pool", "\u30D7\u30FC\u30EB", "\uC218\uC601\uC7A5"] },
    { t: "\u6E29\u6CC9", c: "scene", syn: ["\u6D74\u573A", "onsen", "hot spring", "\u6E29\u6CC9", "\uC628\uCC9C"] },
    { t: "\u6D74\u5BA4", c: "scene", syn: ["\u536B\u751F\u95F4", "bathroom", "bath room", "\u304A\u98A8\u5442\u5834", "\uC695\uC2E4"] },
    { t: "\u5367\u5BA4", c: "scene", syn: ["\u5BDD\u5BA4", "bedroom", "\u30D9\u30C3\u30C9\u30EB\u30FC\u30E0", "\uCE68\uC2E4"] },
    { t: "\u53A8\u623F", c: "scene", syn: ["kitchen", "\u30AD\u30C3\u30C1\u30F3", "\uC8FC\uBC29"] },
    { t: "\u5BA2\u5385", c: "scene", syn: ["living room", "lounge", "\u30EA\u30D3\u30F3\u30B0"] },
    { t: "\u6559\u5BA4", c: "scene", syn: ["classroom", "school room", "\u6559\u5BA4", "\uAD50\uC2E4"] },
    { t: "\u529E\u516C\u5BA4", c: "scene", syn: ["office", "\u30AA\u30D5\u30A3\u30B9", "\uC0AC\uBB34\uC2E4"] },
    { t: "\u56FE\u4E66\u9986", c: "scene", syn: ["library", "\u56F3\u66F8\u9928", "\uB3C4\uC11C\uAD00"] },
    { t: "\u5065\u8EAB\u623F", c: "scene", syn: ["gym", "\u4F53\u80B2\u9928", "\u30B8\u30E0", "\uD5EC\uC2A4\uC7A5"] },
    { t: "\u5929\u53F0", c: "scene", syn: ["\u5C4B\u9876", "rooftop", "roof", "\u5C4B\u4E0A"] },
    { t: "\u697C\u68AF", c: "scene", syn: ["stairs", "staircase", "\u968E\u6BB5"] },
    { t: "\u8D70\u5ECA", c: "scene", syn: ["corridor", "hallway", "\u5ECA\u4E0B"] },
    { t: "\u9633\u53F0", c: "scene", syn: ["balcony", "\u30D9\u30E9\u30F3\u30C0", "\uBC1C\uCF54\uB2C8"] },
    { t: "\u9152\u5E97", c: "scene", syn: ["\u5BBE\u9986", "hotel", "motel", "\u30DB\u30C6\u30EB", "\uD638\uD154"] },
    { t: "\u8F66\u5185", c: "scene", syn: ["\u8F66\u91CC", "car", "in car", "car interior", "\u8ECA\u5185"] },
    { t: "\u5730\u94C1", c: "scene", syn: ["\u7535\u8F66", "subway", "train", "\u96FB\u8ECA", "\uC9C0\uD558\uCCA0"] },
    { t: "\u8857\u5934", c: "scene", syn: ["\u8857\u9053", "street", "street shot", "\u8DEF\u4E0A", "\uAC70\uB9AC"] },
    { t: "\u516C\u56ED", c: "scene", syn: ["park", "\u516C\u5712", "\uACF5\uC6D0"] },
    { t: "\u68EE\u6797", c: "scene", syn: ["forest", "woods", "\u68EE", "\uC232"] },
    { t: "\u96EA\u5730", c: "scene", syn: ["\u96EA\u666F", "snow", "snowy", "\u96EA", "\uC124\uC6D0"] },
    { t: "\u96E8\u5929", c: "scene", syn: ["\u96E8\u666F", "rain", "rainy", "\u96E8"] },
    { t: "\u591C\u666F", c: "scene", syn: ["\u591C\u665A", "night", "night view", "\u591C", "\uC57C\uACBD"] },
    { t: "\u65E5\u843D", c: "scene", syn: ["\u5915\u9633", "sunset", "\u5915\u65E5", "\uC11D\uC591"] },
    { t: "\u65E5\u51FA", c: "scene", syn: ["\u671D", "sunrise", "morning light", "\u65E5\u306E\u51FA"] },
    { t: "\u6444\u5F71\u68DA", c: "scene", syn: ["studio", "photography studio", "\u30B9\u30BF\u30B8\u30AA", "\uC2A4\uD29C\uB514\uC624"] },
    { t: "\u6D17\u8863\u623F", c: "scene", syn: ["laundry", "laundry room", "\u30E9\u30F3\u30C9\u30EA\u30FC"] },
    { t: "\u533B\u9662", c: "scene", syn: ["hospital", "clinic", "\u75C5\u9662", "\uBCD1\uC6D0"] },
    { t: "\u82B1\u56ED", c: "scene", syn: ["\u5EAD", "garden", "\u5EAD\u5712"] },
    { t: "\u5496\u5561\u9986", c: "scene", syn: ["cafe", "coffee shop", "\u30AB\u30D5\u30A7", "\uCE74\uD398"] },
    { t: "\u9152\u5427", c: "scene", syn: ["bar", "pub", "\u30D0\u30FC"] },
    // ---------- 主题 theme ----------
    { t: "\u5723\u8BDE", c: "theme", syn: ["christmas", "xmas", "\u30AF\u30EA\u30B9\u30DE\u30B9", "\uD06C\uB9AC\uC2A4\uB9C8\uC2A4"] },
    { t: "\u65B0\u5E74", c: "theme", syn: ["\u6B63\u6708", "new year", "lunar new year", "\u65B0\u5E74", "\uC124\uB0A0"] },
    { t: "\u4E07\u5723\u8282", c: "theme", syn: ["halloween", "\u30CF\u30ED\u30A6\u30A3\u30F3", "\uD57C\uB7EC\uC708"] },
    { t: "\u60C5\u4EBA\u8282", c: "theme", syn: ["valentine", "valentine's day", "\u30D0\u30EC\u30F3\u30BF\u30A4\u30F3", "\uBC38\uB7F0\uD0C0\uC778"] },
    { t: "\u751F\u65E5", c: "theme", syn: ["\u8A95\u751F\u65E5", "birthday", "birthday party", "\uC0DD\uC77C"] },
    { t: "\u590F\u65E5", c: "theme", syn: ["\u590F\u5929", "summer", "\u590F", "\uC5EC\uB984"] },
    { t: "\u51AC\u65E5", c: "theme", syn: ["\u51AC\u5929", "winter", "\u51AC", "\uACA8\uC6B8"] },
    { t: "\u6625\u65E5", c: "theme", syn: ["\u6625\u5929", "spring", "\u6625", "\uBD04"] },
    { t: "\u79CB\u65E5", c: "theme", syn: ["\u79CB\u5929", "autumn", "fall", "\u79CB", "\uAC00\uC744"] },
    { t: "\u7761\u8863\u6D3E\u5BF9", c: "theme", syn: ["pajama party", "pyjama party", "\u30D1\u30B8\u30E3\u30DE\u30D1\u30FC\u30C6\u30A3\u30FC"] },
    { t: "\u796D\u5178", c: "theme", syn: ["\u590F\u65E5\u796D", "festival", "matsuri", "\u304A\u796D\u308A", "\uCD95\uC81C"] },
    { t: "\u5A5A\u793C", c: "theme", syn: ["wedding", "bride", "\u7D50\u5A5A\u5F0F", "\uACB0\uD63C\uC2DD"] },
    { t: "\u6821\u56ED", c: "theme", syn: ["\u5B66\u6821", "school", "campus", "\u5B66\u5712", "\uD559\uAD50"] },
    { t: "\u5C45\u5BB6", c: "theme", syn: ["\u5B85\u5BB6", "home", "at home", "stay home", "\u304A\u3046\u3061"] },
    { t: "\u65C5\u884C", c: "theme", syn: ["\u65C5", "travel", "trip", "vacation", "\u65C5\u884C"] },
    { t: "\u9732\u8425", c: "theme", syn: ["camping", "camp", "\u30AD\u30E3\u30F3\u30D7"] },
    { t: "\u89D2\u8272\u626E\u6F14", c: "theme", syn: ["cosplay", "cos", "role play", "\u30B3\u30B9\u30D7\u30EC", "\uCF54\uC2A4\uD504\uB808"] },
    { t: "\u6A31\u82B1", c: "theme", syn: ["sakura", "cherry blossom", "\u685C", "\uBC9A\uAF43"] },
    { t: "\u7EA2\u53F6", c: "theme", syn: ["autumn leaves", "momiji", "\u7D05\u8449"] },
    { t: "\u82B1\u5F00", c: "theme", syn: ["flower field", "bloom", "\u82B1\u7551"] },
    { t: "\u7530\u56ED", c: "theme", syn: ["countryside", "farm", "\u7530\u5712"] },
    { t: "\u5496\u5561\u9986\u4E3B\u9898", c: "theme", syn: ["cafe date", "cafe theme"] },
    // ---------- 作品角色 ip ----------
    { t: "\u539F\u795E", c: "ip", syn: ["genshin", "genshin impact", "\u539F\u795E"] },
    { t: "\u78A7\u84DD\u822A\u7EBF", c: "ip", syn: ["azur lane", "\u30A2\u30BA\u30FC\u30EB\u30EC\u30FC\u30F3", "\u78A7\u84DD\u822A\u7EBF"] },
    { t: "\u660E\u65E5\u65B9\u821F", c: "ip", syn: ["arknights", "\u30A2\u30FC\u30AF\u30CA\u30A4\u30C4", "\u660E\u65E5\u65B9\u821F"] },
    { t: "FGO", c: "ip", syn: ["fate grand order", "fate", "fgo", "\u30D5\u30A7\u30A4\u30C8"] },
    { t: "\u8D5B\u9A6C\u5A18", c: "ip", syn: ["uma musume", "\u30A6\u30DE\u5A18", "\u8D5B\u9A6C\u5A18"] },
    { t: "\u8230\u5A18", c: "ip", syn: ["kancolle", "kan colle", "\u8266\u3053\u308C", "\u8230\u5A18"] },
    { t: "\u521D\u97F3\u672A\u6765", c: "ip", syn: ["hatsune miku", "\u521D\u97F3\u30DF\u30AF", "miku", "\u521D\u97F3"] },
    { t: "\u857E\u59C6", c: "ip", syn: ["rem", "\u30EC\u30E0", "\u857E\u59C6"] },
    { t: "\u62C9\u59C6", c: "ip", syn: ["ram", "\u30E9\u30E0", "\u62C9\u59C6"] },
    { t: "\u96F7\u7535\u5C06\u519B", c: "ip", syn: ["raiden shogun", "raiden", "\u96F7\u96FB\u5C06\u8ECD", "\u96F7\u7535\u5C06\u519B"] },
    { t: "\u80E1\u6843", c: "ip", syn: ["hutao", "hu tao", "\u80E1\u6843"] },
    { t: "\u7518\u96E8", c: "ip", syn: ["ganyu", "\u7518\u96E8"] },
    { t: "\u516B\u91CD\u795E\u5B50", c: "ip", syn: ["yae miko", "yae", "\u516B\u91CD\u795E\u5B50"] },
    { t: "\u523B\u6674", c: "ip", syn: ["keqing", "\u523B\u6674"] },
    { t: "\u795E\u91CC\u7EEB\u534E", c: "ip", syn: ["ayaka", "kamisato ayaka", "\u795E\u91CC\u7DBE\u83EF", "\u795E\u91CC\u7EEB\u534E"] },
    { t: "2B", c: "ip", syn: ["2b", "nier automata", "\u30E8\u30EB\u30CF\u4E8C\u53F7B\u578B", "\u5C3C\u5C14"] },
    { t: "\u8482\u6CD5", c: "ip", syn: ["tifa", "tifa lockhart", "\u30C6\u30A3\u30D5\u30A1", "\u8482\u6CD5"] },
    { t: "\u827E\u8FBE\u738B", c: "ip", syn: ["ada wong", "ada", "\u30A8\u30A4\u30C0", "\u827E\u8FBE\u738B"] },
    { t: "\u4E0D\u77E5\u706B\u821E", c: "ip", syn: ["mai shiranui", "shiranui mai", "\u4E0D\u77E5\u706B\u821E"] },
    { t: "\u6625\u4E3D", c: "ip", syn: ["chun li", "chun-li", "\u6625\u9E97", "\u6625\u4E3D"] },
    { t: "D.Va", c: "ip", syn: ["dva", "d.va", "\u30C7\u30A3\u30FC\u30F4\u30A1"] },
    { t: "\u52B3\u62C9", c: "ip", syn: ["lara croft", "tomb raider", "\u30E9\u30E9", "\u53E4\u5893\u4E3D\u5F71"] },
    { t: "Love Live", c: "ip", syn: ["lovelive", "love live", "\u30E9\u30D6\u30E9\u30A4\u30D6"] },
    { t: "\u5076\u50CF\u5927\u5E08", c: "ip", syn: ["idolmaster", "idol master", "\u30A2\u30A4\u30DE\u30B9", "\u30C7\u30EC\u30B9\u30C6"] },
    { t: "VTuber", c: "ip", syn: ["vtuber", "virtual youtuber", "\u30D0\u30FC\u30C1\u30E3\u30EByoutuber", "\uBC84\uD29C\uBC84"] },
    { t: "\u6D77\u8D3C\u738B", c: "ip", syn: ["one piece", "\u30EF\u30F3\u30D4\u30FC\u30B9", "\u6D77\u8D3C\u738B"] },
    { t: "\u706B\u5F71\u5FCD\u8005", c: "ip", syn: ["naruto", "\u30CA\u30EB\u30C8", "\u706B\u5F71"] },
    { t: "\u7F8E\u5C11\u5973\u6218\u58EB", c: "ip", syn: ["sailor moon", "\u30BB\u30FC\u30E9\u30FC\u30E0\u30FC\u30F3", "\u7F8E\u5C11\u5973\u6226\u58EB"] },
    { t: "EVA", c: "ip", syn: ["evangelion", "eva", "\u30A8\u30F4\u30A1", "\u65B0\u4E16\u7EAA\u798F\u97F3\u6218\u58EB"] },
    { t: "\u585E\u5C14\u8FBE", c: "ip", syn: ["zelda", "\u30BC\u30EB\u30C0"] },
    { t: "\u9A6C\u91CC\u5965", c: "ip", syn: ["mario", "\u30DE\u30EA\u30AA"] },
    { t: "\u8857\u5934\u9738\u738B", c: "ip", syn: ["street fighter", "\u30B9\u30C8\u30EA\u30FC\u30C8\u30D5\u30A1\u30A4\u30BF\u30FC"] },
    { t: "\u62F3\u7687", c: "ip", syn: ["king of fighters", "kof", "kof", "\u30B6\u30FB\u30AD\u30F3\u30B0\u30FB\u30AA\u30D6\u30FB\u30D5\u30A1\u30A4\u30BF\u30FC\u30BA"] },
    { t: "\u5F39\u4E38\u8BBA\u7834", c: "ip", syn: ["danganronpa", "\u30C0\u30F3\u30AC\u30F3\u30ED\u30F3\u30D1"] },
    { t: "\u5C3C\u5C14\u673A\u68B0\u7EAA\u5143", c: "ip", syn: ["nier", "\u30CB\u30FC\u30A2"] },
    // ---------- 品牌 brand（原 BRANDS，保留并归并） ----------
    { t: "tokyo hot", c: "brand", syn: ["tokyo hot", "tokyohot"] },
    { t: "pornbox", c: "brand", syn: ["pornbox"] },
    { t: "jav", c: "brand", syn: ["jav"] },
    { t: "spermmania", c: "brand", syn: ["spermmania"] },
    { t: "pacific girls", c: "brand", syn: ["pacific girls", "pacificgirls"] },
    { t: "blacksonblondes", c: "brand", syn: ["blacksonblondes"] },
    { t: "fellatiojapan", c: "brand", syn: ["fellatiojapan"] },
    { t: "dpdiva", c: "brand", syn: ["dpdiva"] },
    { t: "\u79C0\u4EBA\u7F51", c: "brand", syn: ["\u79C0\u4EBA\u7F51", "xiuren"] },
    { t: "ugirls", c: "brand", syn: ["ugirls"] },
    { t: "miko\u9171", c: "brand", syn: ["miko\u9171"] },
    { t: "little red", c: "brand", syn: ["little red"] },
    { t: "popdaily", c: "brand", syn: ["popdaily"] }
  ];
  var DICT_BY_STANDARD = new Map(TAG_DICT.map((e) => [e.t, e]));
  var SYNONYM_TO_STANDARD = (() => {
    const m = /* @__PURE__ */ new Map();
    for (const e of TAG_DICT) {
      m.set(e.t.toLowerCase(), e.t);
      for (const s of e.syn) {
        const key = s.toLowerCase();
        if (!m.has(key)) m.set(key, e.t);
      }
    }
    return m;
  })();
  var CATEGORY_OF_STANDARD = new Map(TAG_DICT.map((e) => [e.t, e.c]));

  // src/lib/tag-extract.ts
  var TAG_MIN_ALBUMS = 5;
  var TAG_MIN_USERS = 1;
  var TAG_DEFAULT_TOP = 200;
  function emptyCustomDict() {
    return { entries: [], blocked: [] };
  }
  function loadCustomDict(raw) {
    const out = emptyCustomDict();
    if (!raw || typeof raw !== "object") return out;
    const obj = raw;
    if (Array.isArray(obj.entries)) {
      for (const e of obj.entries) {
        if (!e || typeof e.t !== "string" || !e.t.trim()) continue;
        const c = typeof e.c === "string" && e.c in TAG_CATEGORY_LABEL ? e.c : "english";
        const syn = Array.isArray(e.syn) ? e.syn.filter((s) => typeof s === "string" && !!s.trim()) : [];
        out.entries.push({ t: e.t.trim(), c, syn });
      }
    }
    if (Array.isArray(obj.blocked)) {
      out.blocked = obj.blocked.filter((s) => typeof s === "string" && !!s.trim()).map((s) => s.trim());
    }
    return out;
  }
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
    "albums",
    "video",
    "videos",
    "update",
    "new",
    "exclusive",
    "bts",
    "cover",
    "random",
    "various",
    "deleted",
    "test",
    "shoots",
    "photoshoot",
    "digital",
    "series",
    "official",
    "photography",
    "media",
    "expensive",
    "delicious",
    "overseas",
    "last",
    "first",
    "best",
    "good",
    "nice",
    "beautiful",
    "beauty",
    "pretty",
    "cute",
    "style",
    "pure",
    "stop",
    "love",
    "like",
    "studio",
    "indoor",
    "outdoor",
    "amateur",
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
    "\u62CD\u6444",
    "\u4F5C\u54C1",
    "\u65E5\u5E38",
    "\u751F\u6D3B",
    "\u6742\u56FE",
    "\u7F8E\u5973",
    "\u58C1\u7EB8",
    "\u81EA\u62CD\u7167",
    "\u5B9A\u5236",
    "\u7D27\u6025\u4F01\u5212",
    "\u65E0\u6C34\u5370",
    "\u6A21\u7279",
    "\u56FE",
    "\u96C6",
    "\uC139\uC2DC",
    "\uC0AC\uC9C4",
    "\uBAA8\uC74C",
    "\uD654\uBCF4",
    "\uB514\uC9C0\uD138",
    "\uD558\uC774\uD004\uB9AC\uD2F0",
    "\uD648\uD2B8\uB808\uC774\uB2DD",
    "\uBE68\uB798",
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
  var EN_FUNCTION = /* @__PURE__ */ new Set([
    "the",
    "and",
    "with",
    "for",
    "from",
    "this",
    "that",
    "these",
    "those",
    "into",
    "over",
    "under",
    "about",
    "after",
    "before",
    "very",
    "just",
    "only",
    "also",
    "more",
    "most",
    "some",
    "such",
    "than",
    "then",
    "them",
    "they",
    "their",
    "there",
    "here",
    "when",
    "where",
    "what",
    "which",
    "while",
    "your",
    "you",
    "her",
    "his",
    "she",
    "him",
    "our",
    "are",
    "was",
    "were",
    "been",
    "being",
    "have",
    "has",
    "had",
    "will",
    "would",
    "could",
    "should",
    "can",
    "may",
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
    "vol",
    "no",
    "yes",
    "day",
    "days",
    "one",
    "two",
    "three",
    "first",
    "second",
    "third",
    "last",
    "next",
    "back",
    "top",
    "new",
    "old",
    "big",
    "small",
    "long",
    "short",
    "high",
    "low",
    "hot",
    "cold",
    "white",
    "black",
    "red",
    "blue",
    "green",
    "pink",
    "yellow",
    "purple",
    "brown",
    "gray",
    "grey",
    "gold",
    "silver",
    "pink"
  ]);
  var PINYIN_MERGE = {
    "wang yu chun": "\u738B\u96E8\u7EAF",
    "xia mei jiang": "\u590F\u7F8E\u9171",
    "huang le ran": "\u9EC4\u697D\u7136",
    "li ke ke": "\u674E\u53EF\u53EF"
  };
  var CJK_RE = /[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/;
  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function buildMatcher(custom) {
    const entries = [
      ...TAG_DICT,
      ...(custom?.entries ?? []).map((e) => ({ t: e.t, c: e.c, syn: e.syn ?? [] }))
    ];
    const map = new Map(SYNONYM_TO_STANDARD);
    const cjkKeys = /* @__PURE__ */ new Set();
    const latinKeys = /* @__PURE__ */ new Set();
    for (const e of entries) {
      const keys = [e.t, ...e.syn];
      for (const k of keys) {
        const raw = k.trim();
        if (!raw) continue;
        const lower = raw.toLowerCase();
        map.set(lower, e.t);
        if (CJK_RE.test(raw)) cjkKeys.add(raw);
        else latinKeys.add(lower);
      }
    }
    const byLenDesc = (a, b) => b.length - a.length || a.localeCompare(b);
    const cjkList = [...cjkKeys].sort(byLenDesc);
    const latinList = [...latinKeys].sort(byLenDesc);
    const words = new Set([...cjkKeys, ...latinKeys].map((k) => k.toLowerCase()));
    return {
      cjk: cjkList.length ? new RegExp(cjkList.map(escapeRe).join("|"), "g") : null,
      latin: latinList.length ? new RegExp(`(?<![a-z0-9])(?:${latinList.map(escapeRe).join("|")})(?![a-z0-9])`, "gi") : null,
      map,
      words
    };
  }
  function matchDict(name, m) {
    const hits = [];
    for (const re of [m.cjk, m.latin]) {
      if (!re) continue;
      re.lastIndex = 0;
      let mt;
      while ((mt = re.exec(name)) !== null) {
        const std = m.map.get(mt[0].toLowerCase());
        if (std) hits.push({ s: mt.index, e: mt.index + mt[0].length, raw: mt[0], std });
        if (mt[0].length === 0) re.lastIndex++;
      }
    }
    hits.sort((a, b) => b.e - b.s - (a.e - a.s) || a.s - b.s);
    const used = [];
    const tags = /* @__PURE__ */ new Map();
    const literals = /* @__PURE__ */ new Set();
    for (const h of hits) {
      if (used.some(([s, e]) => h.s < e && s < h.e)) continue;
      used.push([h.s, h.e]);
      tags.set(h.std, CATEGORY_OF_STANDARD.get(h.std) ?? "english");
      literals.add(h.raw.toLowerCase());
    }
    return { tags, literals };
  }
  function cleanEmoji(s) {
    return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2B50}\u{2B06}\u{2B07}\u{25B6}\u{25C0}]/gu, " ");
  }
  function matchFree(name, dictLiterals, dictWords, out) {
    let s = cleanEmoji(name).replace(/&amp;/g, "&");
    for (const m of s.match(/@[a-zA-Z0-9_]+/g) ?? []) out.set(m, "at");
    s = s.replace(/@([a-zA-Z0-9_]+)/g, " ");
    s = s.replace(/\bE\d{2,4}\b/gi, " ").replace(/-\d{2,4}/g, " ").replace(/\d+/g, " ");
    const coveredByDict = (seg) => {
      const low = seg.toLowerCase();
      if (dictWords.has(low)) return true;
      for (const lit of dictLiterals) {
        if (low.includes(lit) || lit.includes(low)) return true;
      }
      return false;
    };
    const parts = s.split(/[,&;()|·•\-_/\\、。！？!?【】\[\]「」『』<>~～+]+/).map((p) => p.trim()).filter(Boolean);
    const usedWords = /* @__PURE__ */ new Set();
    for (const part of parts) {
      for (const k of part.match(/[\uac00-\ud7af]{2,}/g) ?? []) {
        if (!STOP.has(k) && !coveredByDict(k)) out.set(k, "korean");
      }
      for (const j of part.match(/[\u3040-\u30ff\u4e00-\u9fff]+/g) ?? []) {
        if (j.length >= 2 && !STOP.has(j) && !coveredByDict(j)) out.set(PINYIN_MERGE[j] ?? j, "japanese");
      }
      const words = part.split(/[\s\-]+/).filter(Boolean);
      const cap = words.filter(
        (w) => /^[A-Z][a-z']{1,}$/.test(w) && !STOP.has(w.toLowerCase()) && !EN_FUNCTION.has(w.toLowerCase()) && !dictWords.has(w.toLowerCase())
      );
      if (cap.length >= 1 && cap.length <= 3) {
        const phrase = cap.join(" ").toLowerCase();
        if (phrase.length >= 3 && phrase.length <= 40) {
          out.set(PINYIN_MERGE[phrase] ?? phrase, "english");
          for (const w of cap) usedWords.add(w.toLowerCase());
        }
      }
      for (const w of words) {
        const lw = w.toLowerCase().replace(/[^a-z]/g, "");
        if (lw.length < 4 || STOP.has(lw) || EN_FUNCTION.has(lw) || dictWords.has(lw) || usedWords.has(lw)) continue;
        if (!out.has(lw)) out.set(lw, "english");
      }
    }
  }
  function extractFromName(name, matcher) {
    const dict = matchDict(name, matcher);
    matchFree(name, dict.literals, matcher.words, dict.tags);
    return dict.tags;
  }
  function computeTags(entries, opts = {}) {
    const o = typeof opts === "number" ? { topN: opts } : opts;
    const topN = o.topN ?? TAG_DEFAULT_TOP;
    const minAlbums = Math.max(1, o.minAlbums ?? TAG_MIN_ALBUMS);
    const minUsers = Math.max(1, o.minUsers ?? TAG_MIN_USERS);
    const matcher = buildMatcher(o.custom);
    const blocked = new Set((o.custom?.blocked ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean));
    const total = /* @__PURE__ */ new Map();
    const users = /* @__PURE__ */ new Map();
    const catOf = /* @__PURE__ */ new Map();
    for (const e of entries) {
      if (!e.albums) continue;
      for (const a of e.albums) {
        const names = o.includeSlug && a.url ? [a.name, slugOf(a.url)] : [a.name];
        for (const nm of names) {
          if (!nm) continue;
          for (const [t, c] of extractFromName(nm, matcher)) {
            if (blocked.has(t.toLowerCase())) continue;
            total.set(t, (total.get(t) ?? 0) + 1);
            if (!users.has(t)) users.set(t, /* @__PURE__ */ new Set());
            users.get(t).add(e.username);
            if (!catOf.has(t)) catOf.set(t, c);
          }
        }
      }
    }
    const merged = /* @__PURE__ */ new Map();
    for (const [t, c] of catOf) {
      const albums = total.get(t) ?? 0;
      const uc = users.get(t)?.size ?? 0;
      if (albums < minAlbums || uc < minUsers) continue;
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
    return [...merged.values()].sort((a, b) => b.albums - a.albums || a.t.localeCompare(b.t)).slice(0, Math.max(0, topN));
  }
  function slugOf(url) {
    try {
      const seg = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
      return decodeURIComponent(seg).replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ");
    } catch {
      return "";
    }
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

  // src/sites/defs/buondua.ts
  var buondua = {
    id: "buondua",
    label: "Buondua",
    uiOrder: 10,
    channels: ["site"],
    defaultChecked: true,
    folderTag: "buondua",
    endpoints: [{ host: "buondua.com", role: "primary" }],
    container: { tag: "div", className: "article-fulltext" },
    pagination: { kind: "query", param: "page" },
    maxPagePattern: { source: "\\(\\s*Page\\s+\\d+\\s*\\/\\s*(\\d+)\\s*\\)", flags: "i" },
    titleStrip: [{ source: "\\s*[-\u2013\u2014]\\s*\\(\\s*Page\\s+\\d+\\s*\\/\\s*\\d+\\s*\\)\\s*$", flags: "i" }],
    imageHosts: ["buondua.com"],
    // 站内搜索（2026-08-14 实测恢复可用）：GET ?search={q}，分页 &start={offset}（每页 20 条）
    search: { kind: "query", path: "/", param: "search", pageParam: "start", pageStep: 20 },
    linkParser: "buondua-items-row"
  };

  // src/sites/defs/rrwsh.ts
  var rrwsh = {
    id: "rrwsh",
    label: "RRWSH (4KHD)",
    uiOrder: 20,
    channels: ["site"],
    // 2026-10-07 实测：rrwsh.uuss.uk 背后已换成「豆豆」视频站（iozl.uuss.uk），
    // 原 4KHD 图集站不在该域，解析器依赖的 li.wp-block-post 结构也已消失 → 暂不默认勾选（避免聚合搜索白跑）
    defaultChecked: false,
    folderTag: "buondua",
    endpoints: [
      { host: "rrwsh.uuss.uk", role: "primary" },
      { host: "4khd.com", role: "mirror" },
      { host: "iftye.uuss.uk", role: "mirror" }
    ],
    container: { tag: "div", className: "entry-content" },
    pagination: { kind: "path" },
    baseUrl: { stripPagePath: "suffix" },
    maxPagePattern: { source: "Page\\s+\\d+\\s+of\\s+(\\d+)", flags: "i" },
    titleStrip: [
      { source: "\\s*[-\u2013\u2014]\\s*Page\\s+\\d+\\s+of\\s+\\d+\\s*[-\u2013\u2014]\\s*[^-]*$", flags: "i" },
      { source: "\\s*[-\u2013\u2014]\\s*4KHD\\s*$", flags: "i" }
    ],
    imageHosts: ["wp.com"],
    // 搜索无分页（实测 2026-08-14：/search/{q}/2 为空白页），每页固定 4 条
    search: { kind: "path-template", template: "/search/{q}" },
    // 4khd.com 结果链接改写回 rrwsh 域（primary）
    urlRewrite: [{ fromHost: "4khd.com" }],
    linkParser: "rrwsh-cards",
    imageCountRule: "rrwsh-photos"
  };

  // src/sites/defs/hitxhot.ts
  var hitxhot = {
    id: "hitxhot",
    label: "Hitxhot",
    uiOrder: 30,
    channels: ["google"],
    defaultChecked: false,
    folderTag: "buondua",
    endpoints: [{ host: "hitxhot.org", role: "primary" }],
    container: { tag: "div", className: "contentme" },
    pagination: { kind: "query", param: "page" },
    maxPagePattern: {
      source: "\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*(\\d+)|\u7B2C\\s*\\d+\\s*\\/\\s*(\\d+)\\s*\u9875)",
      flags: "i"
    },
    titleStrip: [{ source: "\\s*\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*\\d+|\u7B2C\\s*\\d+\\s*\\/\\s*\\d+\\s*\u9875)\\s*$", flags: "i" }],
    search: { kind: "google-sitesearch" },
    searchAlbumPath: "/gallerys/",
    // FP-023 列表浏览：站内相册列表页（不依赖搜索引擎，Google 通道被拒时的替代通道）
    listPages: [{ label: "\u76F8\u518C\u5217\u8868 /gallerys/", path: "/gallerys/", pageKind: "query", param: "page" }],
    linkParser: "google-serp",
    hint: "\u65E0\u7AD9\u5185\u641C\u7D22\uFF1A\u8D70 Google \u7AD9\u5185\u641C\u7D22\uFF08sitesearch\uFF09"
  };

  // src/sites/defs/kaizty.ts
  var kaizty = {
    id: "kaizty",
    label: "Kaizty",
    uiOrder: 40,
    channels: ["google"],
    defaultChecked: false,
    folderTag: "buondua",
    endpoints: [{ host: "kaizty.com", role: "primary" }],
    container: { tag: "div", className: "contentme" },
    pagination: { kind: "query", param: "page" },
    maxPagePattern: {
      source: "\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*(\\d+)|\u7B2C\\s*\\d+\\s*\\/\\s*(\\d+)\\s*\u9875)",
      flags: "i"
    },
    titleStrip: [
      { source: "^Kaizty Photos:\\s*", flags: "i" },
      { source: "^Kaizty \u7167\u7247\uFF1A\\s*", flags: "i" },
      { source: "\\s*\\|\\s*(?:Page\\s+\\d+\\s*\\/\\s*\\d+|\u7B2C?\\s*\\d+\\s*\\/\\s*\\d+\\s*\u9875)\\s*$", flags: "i" }
    ],
    search: { kind: "google-sitesearch" },
    searchAlbumPath: "/photos/",
    // FP-023 列表浏览：站内相册列表页（不依赖搜索引擎，Google 通道被拒时的替代通道）
    listPages: [{ label: "\u76F8\u518C\u5217\u8868 /photos/", path: "/photos/", pageKind: "query", param: "page" }],
    linkParser: "kaizty-photos",
    hint: "\u65E0\u7AD9\u5185\u641C\u7D22\uFF1A\u8D70 Google \u7AD9\u5185\u641C\u7D22\uFF08sitesearch\uFF09"
  };

  // src/sites/defs/jrants.ts
  var jrants = {
    id: "jrants",
    label: "Jrants",
    uiOrder: 50,
    // 2026-10-07：站内搜索被反爬拒绝（HTTP 403，首页亦不可后台直接访问）→ 改走 Google 站内搜索通道
    channels: ["google"],
    defaultChecked: false,
    folderTag: "buondua",
    // 2026-10-08 体检 P0-2：命名规则由定义声明（视图侧不再判断 site.id）
    folderNameRule: "jrants",
    endpoints: [{ host: "jrants.com", role: "primary" }],
    container: { tag: "div", className: "entry-content" },
    pagination: { kind: "path-from-2" },
    baseUrl: { stripPagePath: "suffix" },
    // maxPagePattern 缺省 = 无标题标记
    imageHosts: ["jrants.com"],
    search: { kind: "google-sitesearch" },
    linkParser: "google-serp",
    scan: { recommended: "jrants-recommended", others: "jrants-others" },
    imageCountRule: "jrants-p",
    // jrants 连续快速搜索触发反爬限流（实测 2026-08-13/14），页间强制间隔
    throttle: { fromPage: 2, delayMs: 2e3 }
  };

  // src/sites/defs/pixibb.ts
  var pixibb = {
    id: "pixibb",
    label: "PixiBB",
    uiOrder: 60,
    channels: ["google"],
    defaultChecked: false,
    folderTag: "buondua",
    // 2026-10-08 体检 P0-2：命名规则由定义声明（视图侧不再判断 site.id）
    folderNameRule: "pixibb",
    endpoints: [{ host: "pixibb.com", role: "primary" }],
    container: { tag: "div", className: "entry-content" },
    pagination: { kind: "path-slash-from-2" },
    baseUrl: { stripPagePath: "trailing-slash" },
    // maxPagePattern 缺省 = 无标题标记
    imageHosts: ["pixibb.com"],
    search: { kind: "wp-query-path-page", param: "s", trailingSlash: true },
    searchBaseHost: "sexy.pixibb.com",
    linkParser: "pixibb-magezix",
    // 2026-10-08 体检 P1-2：pixibb 相册 URL 无固定路径前缀（形如 /{slug}-{N}-photos/），
    // 而 Google 结果会混入 /model/xxx/（模特聚合页）等非相册页 → 用正则只保留 -photos 链接
    searchAlbumPattern: { source: "-photos", flags: "i" },
    scan: { recommended: "pixibb-recommended", others: "pixibb-others" },
    imageCountRule: "pixibb-slug",
    hint: "\u7AD9\u5185\u641C\u7D22\u65E0\u7ED3\u679C\uFF1A\u8D70 Google \u901A\u9053"
  };

  // src/sites/defs/cangcuc.ts
  var cangcuc = {
    id: "cangcuc",
    label: "Cangcuc",
    uiOrder: 70,
    channels: ["site"],
    // 2026-10-07 实测：cangcuc.com DNS 已失效（getaddrinfo ENOTFOUND），暂无新域名 → 暂不默认勾选
    defaultChecked: false,
    folderTag: "buondua",
    endpoints: [{ host: "cangcuc.com", role: "primary" }],
    container: { tag: "div", className: "post-single-body" },
    pagination: { kind: "single" },
    // maxPagePattern 缺省 = 无标题标记
    titleStrip: [{ source: "\\s*\\|\\s*C\u0103ng\\s*C\u1EF1c\\s*$", flags: "i" }],
    // WP 站内搜索（标准 ?s= + 路径式分页 /page/N/?s=）
    search: { kind: "wp-query-path-page", param: "s", trailingSlash: true },
    linkParser: "generic-post-links"
  };

  // src/sites/defs/phimvuspot.ts
  var phimvuspot = {
    id: "phimvuspot",
    label: "PhimVuSpot",
    uiOrder: 80,
    channels: ["google"],
    defaultChecked: false,
    folderTag: "buondua",
    // 主域优先：m. 子域 Google 索引差（FP-014）
    endpoints: [{ host: "m.phimvuspot.com", role: "mirror" }, { host: "phimvuspot.com", role: "primary" }],
    container: { tag: "div", className: "contentme" },
    pagination: { kind: "query", param: "page" },
    maxPagePattern: { source: "\\|\\s*Page\\s+\\d+\\s*\\/\\s*(\\d+)", flags: "i" },
    titleStrip: [
      { source: "^PhimVu\\s*Blog:\\s*", flags: "i" },
      { source: "\\s*\\|\\s*Page\\s+\\d+\\s*\\/\\s*\\d+\\s*$", flags: "i" }
    ],
    imageHosts: ["wp.com", "thismore.fun"],
    // Photon 缩放参数放大：?w=640 → ?w=1920（高清原图级）
    imageQueryFix: [{ param: "w", value: "1920" }],
    linkParser: "generic-post-links"
  };

  // src/sites/defs/ilovexs.ts
  var ilovexs = {
    id: "ilovexs",
    label: "iLoveXS",
    uiOrder: 90,
    channels: ["google"],
    defaultChecked: false,
    folderTag: "buondua",
    endpoints: [{ host: "ilovexs.com", role: "primary" }],
    container: { tag: "div", className: "image-gallery" },
    pagination: { kind: "single" },
    // maxPagePattern 缺省 = 无标题标记
    titleStrip: [{ source: "\\s*\\|\\s*Nongmo\\.Zone\\s*$", flags: "i" }],
    linkParser: "generic-post-links"
  };

  // src/sites/defs/knitbid.ts
  var knitbid = {
    id: "knitbid",
    label: "Knit.bid",
    uiOrder: 100,
    // 站内搜索（2026-10-10 探测：表单 action=/ja/search/ + input name=s → /ja/search/?s=…；分页 /ja/search/page/N/）
    channels: ["site"],
    defaultChecked: false,
    folderTag: "buondua",
    // 站点实际部署在 xx. 子域（用户给出与实测的 URL 均为 xx.knit.bid）→ primary 用子域，
    // 裸域作为 mirror 仅在用户直接访问裸域时匹配（搜索 URL 由 primary 生成，必须指向可用的子域）
    endpoints: [{ host: "xx.knit.bid", role: "primary" }, { host: "knit.bid", role: "mirror" }],
    container: { tag: "div", className: "image-container" },
    pagination: { kind: "page-path-slash" },
    baseUrl: { stripPagePath: "page-segment" },
    // maxPagePattern 缺省：页面无 Page X/Y 标记（由 followPagesUntilEmpty 兜底）
    titleStrip: [{ source: "\\s*-\\s*\u59B9\u3092\u611B\u3059\u308B\\s*$" }],
    followPagesUntilEmpty: true,
    // 顺序翻页请求较多（实测一次抓取即触发站点 429 限流）→ 第 2 页起页间等待 1.2s
    throttle: { fromPage: 2, delayMs: 1200 },
    // 站内搜索：/ja/search/?s={q}，分页 /ja/search/page/N/?s={q}（实测均 HTTP 200）
    search: { kind: "wp-query-path-page", param: "s", path: "/ja/search/", trailingSlash: true },
    // 结果只保留相册页（/ja/article/{id}/），排除 /ja/type/N/ 等分类页
    searchAlbumPattern: { source: "^/ja/article/\\d+/?$" },
    linkParser: "generic-post-links"
  };

  // src/sites/defs/index.ts
  var SITE_DEFS = [
    buondua,
    rrwsh,
    hitxhot,
    kaizty,
    jrants,
    pixibb,
    cangcuc,
    phimvuspot,
    ilovexs,
    knitbid
  ];

  // src/sites/engine.ts
  function escapeRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function toRegExp(spec) {
    return new RegExp(spec.source, spec.flags ?? "");
  }
  function primaryHostOf(def) {
    const explicit = def.endpoints.find((e) => e.role === "primary");
    if (explicit) return explicit.host;
    const bare = def.endpoints.find((e) => !/^(m|www|mobile)\./i.test(e.host));
    return (bare ?? def.endpoints[0]).host;
  }
  function searchHostOf(def) {
    if (def.searchBaseHost) return def.searchBaseHost;
    const search = def.endpoints.find((e) => e.role === "search");
    return search ? search.host : primaryHostOf(def);
  }
  function buildPageUrl(def, base, page) {
    switch (def.pagination.kind) {
      case "query":
        return `${base}?${def.pagination.param ?? "page"}=${page}`;
      case "path":
        return `${base}/${page}`;
      case "path-from-2":
        return page <= 1 ? base : `${base}/${page}`;
      case "path-slash-from-2":
        return page <= 1 ? base : `${base.replace(/\/?$/, "/")}${page}/`;
      case "page-path-slash":
        return page <= 1 ? base : `${base.replace(/\/?$/, "/")}page/${page}/`;
      case "single":
        return base;
      default:
        return base;
    }
  }
  function buildBaseUrl(def, url) {
    try {
      const u = new URL(url);
      u.search = "";
      u.hash = "";
      const strip = def.baseUrl?.stripPagePath ?? "none";
      if (strip === "none") return u.href;
      let path;
      if (strip === "suffix") {
        path = u.pathname.replace(/\/\d+$/, "");
      } else if (strip === "page-segment") {
        path = u.pathname.replace(/\/page\/\d+\/?$/, "/");
      } else {
        path = u.pathname.replace(/\/\d+\/$/, "").replace(/\/\d+$/, "");
      }
      return `${u.origin}${path}`;
    } catch {
      return url;
    }
  }
  function buildCleanTitle(def, title) {
    let out = title;
    for (const spec of def.titleStrip ?? []) out = out.replace(toRegExp(spec), "");
    return out.trim();
  }
  function buildSearchUrl(def, q, page) {
    const search = def.search;
    if (!search) return null;
    const host = searchHostOf(def);
    const query = encodeURIComponent(q);
    switch (search.kind) {
      case "query": {
        const base = `https://${host}${search.path ?? "/"}?${search.param}=${query}`;
        if (page > 1 && search.pageParam) {
          return `${base}&${search.pageParam}=${(page - 1) * (search.pageStep ?? 10)}`;
        }
        return base;
      }
      case "path-template": {
        if (page > 1) return null;
        return `https://${host}${search.template.replace("{q}", query)}`;
      }
      case "wp-query-path-page": {
        const basePath = (search.path ?? "/").replace(/\/?$/, "/");
        if (page <= 1) return `https://${host}${basePath}?${search.param}=${query}`;
        return `https://${host}${basePath}page/${page}${search.trailingSlash ? "/" : ""}?${search.param}=${query}`;
      }
      case "google-sitesearch": {
        const siteQuery = encodeURIComponent(`${q} site:${primaryHostOf(def)}`);
        return `https://www.google.com/search?q=${siteQuery}&hl=zh-CN${page > 1 ? `&start=${(page - 1) * 10}` : ""}`;
      }
      default:
        return null;
    }
  }
  function buildRewriteUrl(def, url) {
    let out = url;
    for (const rule of def.urlRewrite ?? []) {
      out = out.replace(
        new RegExp(`https?://(?:www\\.)?${escapeRegex(rule.fromHost)}`, "i"),
        `https://${primaryHostOf(def)}`
      );
    }
    return out;
  }
  function buildImageUrlClean(def, url) {
    let out = url;
    for (const fix of def.imageQueryFix ?? []) {
      out = out.replace(new RegExp(`[?&]${escapeRegex(fix.param)}=\\d+`), `?${fix.param}=${fix.value}`);
    }
    return out;
  }
  function deriveListPageKind(def) {
    switch (def.pagination.kind) {
      case "query":
        return "query";
      case "path-slash-from-2":
        return "path-slash";
      default:
        return "path";
    }
  }
  function listPageUrl(site, base, page, pageKindOverride) {
    if (page <= 1) return base;
    const cfg = site.def.listPages?.[0];
    const kind = pageKindOverride ?? cfg?.pageKind ?? deriveListPageKind(site.def);
    if (kind === "query") {
      const param = cfg?.param ?? "page";
      return `${base}${base.includes("?") ? "&" : "?"}${param}=${page}`;
    }
    const trimmed = base.replace(/\/$/, "");
    return kind === "path-slash" ? `${trimmed}/page/${page}/` : `${trimmed}/page/${page}`;
  }
  function compileSite(def) {
    const site = {
      id: def.id,
      hosts: def.endpoints.map((e) => e.host),
      containerOpen: new RegExp(
        `<${def.container.tag}[^>]*class="[^"]*${escapeRegex(def.container.className)}[^"]*"[^>]*>`
      ),
      pagePattern: def.maxPagePattern ? toRegExp(def.maxPagePattern) : /(?!)0/,
      pageUrl: (base, page) => buildPageUrl(def, base, page),
      baseUrlOf: (url) => buildBaseUrl(def, url),
      cleanTitle: (title) => buildCleanTitle(def, title),
      searchAlbumPath: def.searchAlbumPath,
      def
    };
    if (def.search) site.searchUrl = (q, page) => buildSearchUrl(def, q, page);
    if (def.searchAlbumPattern) site.searchAlbumPattern = toRegExp(def.searchAlbumPattern);
    if (def.urlRewrite?.length) site.rewriteUrl = (url) => buildRewriteUrl(def, url);
    if (def.imageQueryFix?.length) site.imageUrlClean = (url) => buildImageUrlClean(def, url);
    return site;
  }
  var COMPILED_SITES = SITE_DEFS.map(compileSite);
  var IMAGE_HOSTS = [...new Set(SITE_DEFS.flatMap((d) => d.imageHosts ?? []))];
  var IMG_HOST = IMAGE_HOSTS.length > 0 ? new RegExp(IMAGE_HOSTS.map(escapeRegex).join("|"), "i") : /(?!)/;
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
  function parseGalleryImages(html, baseUrl, site) {
    const block = extractContainerBlock(html, site.containerOpen);
    if (!block) return [];
    const seen = /* @__PURE__ */ new Set();
    const urls = [];
    const toAbsolute = (raw) => {
      if (!raw) return null;
      if (/^https?:\/\//i.test(raw)) return raw;
      if (/^\/\//.test(raw)) return `https:${raw}`;
      if (/^(data|blob|javascript):/i.test(raw)) return null;
      try {
        return new URL(raw, baseUrl).href;
      } catch {
        return null;
      }
    };
    const collect = (raw) => {
      const u = toAbsolute(raw);
      if (!u) return;
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
    const re = /(?:href|src)="([^"]+)"/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      collect(m[1]);
    }
    const clean = site.imageUrlClean;
    return urls.map((url) => {
      const finalUrl = clean ? clean(url) : url;
      let filename = "";
      try {
        filename = decodeURIComponent(new URL(finalUrl).pathname.split("/").pop() || "");
      } catch {
        filename = finalUrl.split("/").pop() || "";
      }
      filename = filename.replace(/[\\/:*?"<>|]/g, "_");
      return { url: finalUrl, filename };
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
    const re4 = /\/page\/(\d+)\/?/g;
    while ((mm = re4.exec(html)) !== null) {
      const n = Number(mm[1]) || 0;
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

  // src/sites/registry.ts
  var GALLERY_SITES = COMPILED_SITES;
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
  function siteById(id) {
    return GALLERY_SITES.find((s) => s.id === id);
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

  // src/sites/parsers.ts
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
  function parseSitePostLinks(html, baseUrl, hosts, opts) {
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
        if (!opts?.skipNumericFilter && /\/\d+\/?$/.test(path)) continue;
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
        let cover = "";
        const after = html.slice(m.index, m.index + 1500);
        const im = after.match(/<img[^>]+(?:data-src|data-lazy-src|src)="([^"]+)"/i);
        if (im) {
          try {
            const cu = new URL(im[1], baseUrl).href;
            const isAsset = /\.(js|css|svg|ico)(\?|$)/i.test(cu);
            const isChrome = /(favicon|logo|avatar|sprite|placeholder|blank|loading)/i.test(cu);
            if (!isAsset && !isChrome) cover = cu;
          } catch {
            cover = "";
          }
        }
        const existing = byUrl.get(url);
        if (existing) {
          const next = { ...existing };
          if (existing.title === url && title && title !== url) next.title = title;
          if (!existing.coverUrl && cover) next.coverUrl = cover;
          if (next.title !== existing.title || next.coverUrl !== existing.coverUrl) byUrl.set(url, next);
          continue;
        }
        byUrl.set(url, { url, title: title || url, coverUrl: cover, imageCount: void 0 });
      } catch {
      }
    }
    return [...byUrl.values()];
  }
  function parseListPageLinks(html, baseUrl, site) {
    const cfg = site.def.listPages?.[0];
    const albumPath = cfg?.albumPath ?? site.searchAlbumPath;
    const albumPattern = cfg?.albumPath ? void 0 : site.searchAlbumPattern;
    const items = parseSitePostLinks(html, baseUrl, site.hosts, {
      skipNumericFilter: !!(albumPath || albumPattern)
    });
    return items.filter((item) => {
      try {
        const pathname = new URL(item.url).pathname;
        if (albumPath && !pathname.startsWith(albumPath)) return false;
        if (albumPattern && !albumPattern.test(pathname)) return false;
        return true;
      } catch {
        return false;
      }
    });
  }
  function cleanGoogleResult(site, rawUrl, rawTitle) {
    try {
      const url = rawUrl.replace(/&amp;/g, "&");
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, "");
      const hostOk = site.hosts.some((h) => host === h || host.endsWith(`.${h}`));
      if (!hostOk) return null;
      if (site.searchAlbumPath && !u.pathname.startsWith(site.searchAlbumPath)) return null;
      if (site.searchAlbumPattern && !site.searchAlbumPattern.test(u.pathname)) return null;
      u.search = "";
      u.hash = "";
      const cleanUrl = u.href;
      const title = site.cleanTitle(rawTitle.replace(/<[^>]*>/g, "").trim()) || cleanUrl;
      return { url: cleanUrl, title, coverUrl: "", imageCount: void 0 };
    } catch {
      return null;
    }
  }
  function parseGoogleResults(html, site) {
    const items = [];
    const seen = /* @__PURE__ */ new Set();
    const add = (rawUrl, rawTitle) => {
      const clean = cleanGoogleResult(site, rawUrl, rawTitle);
      if (!clean || seen.has(clean.url)) return;
      seen.add(clean.url);
      items.push(clean);
    };
    const re1 = /<a[^>]*class="[^"]*zReHs[^"]*"[^>]*href="([^"]+)"[^>]*>(?:(?!<\/a>)[\s\S])*?<h3[^>]*>([\s\S]*?)<\/h3>/g;
    let m;
    while ((m = re1.exec(html)) !== null) add(m[1], m[2]);
    const re2 = /<h3[^>]*class="[^"]*\br\b[^"]*"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = re2.exec(html)) !== null) add(m[1], m[2]);
    return items;
  }
  var LINK_PARSERS = {
    "buondua-items-row": (html, base) => parseRecommendedLinks(html, base),
    "rrwsh-cards": (html, base) => parseRrwshSearchLinks(html, base),
    "kaizty-photos": (html, base) => parseKaiztyPostLinks(html, base),
    "jrants-wp": (html, base) => parseJrantsPostLinks(html, base, {}),
    "pixibb-magezix": (html, base) => parsePixibbPostLinks(html, base, {}),
    "google-serp": (html, _base, site) => parseGoogleResults(html, site),
    "generic-post-links": (html, base, site) => parseSitePostLinks(html, base, site.hosts, {
      skipNumericFilter: !!(site.searchAlbumPath || site.searchAlbumPattern)
    })
  };
  var SCAN_PARSERS = {
    "buondua-recommended": (html, base) => parseRecommendedLinks(html, base),
    "buondua-others": (html, base, ctx) => parseAllPostLinks(html, base, ctx.recUrls),
    "jrants-recommended": (html, base) => parseJrantsPostLinks(html, base, { onlyRecommended: true }),
    "jrants-others": (html, base, ctx) => parseJrantsPostLinks(html, base, { excludeUrls: ctx.recUrls }),
    "pixibb-recommended": (html, base) => parsePixibbPostLinks(html, base, { onlyRecommended: true }),
    "pixibb-others": (html, base, ctx) => parsePixibbPostLinks(html, base, { excludeUrls: ctx.recUrls })
  };
  var IMAGE_COUNT_RULES = {
    "jrants-p": (item) => {
      const m = item.title.match(/[(\[]\s*(\d+)\s*P\s*[)\]]/i);
      return m ? Number(m[1]) : void 0;
    },
    "pixibb-slug": (_item, finalUrl) => {
      const m = finalUrl.match(/-(\d+)-photos/i);
      return m ? Number(m[1]) : void 0;
    },
    "rrwsh-photos": (item) => {
      const m = item.title.match(/[\[(][^\]()]*?(\d+)\s*photos/i);
      return m ? Number(m[1]) : void 0;
    }
  };
  function filterAlbumLinks(site, items) {
    const albumPath = site.searchAlbumPath;
    const albumPattern = site.searchAlbumPattern;
    if (!albumPath && !albumPattern) return items;
    return items.filter((item) => {
      try {
        const pathname = new URL(item.url).pathname;
        if (albumPath && !pathname.startsWith(albumPath)) return false;
        if (albumPattern && !albumPattern.test(pathname)) return false;
        return true;
      } catch {
        return false;
      }
    });
  }
  function parseLinksForSite(siteId, html, base) {
    const site = COMPILED_SITES.find((s) => s.id === siteId);
    const parser = site ? LINK_PARSERS[site.def.linkParser] : void 0;
    if (site && parser) return filterAlbumLinks(site, parser(html, base, site));
    if (site && site.searchAlbumPath) return parseGoogleResults(html, site);
    return parseSitePostLinks(html, base, site ? site.hosts : [siteId]);
  }
  function extractSearchImageCount(siteId, item, finalUrl) {
    const rule = COMPILED_SITES.find((s) => s.id === siteId)?.def.imageCountRule;
    if (!rule) return void 0;
    return IMAGE_COUNT_RULES[rule](item, finalUrl);
  }
  function scanSiteLinks(site, html, base, kind) {
    const scan = site?.def.scan ?? { recommended: "buondua-recommended", others: "buondua-others" };
    const recommended = SCAN_PARSERS[scan.recommended](html, base, { recUrls: /* @__PURE__ */ new Set() });
    if (kind === "recommended") return recommended;
    const recUrls = new Set(recommended.map((i) => i.url));
    return SCAN_PARSERS[scan.others](html, base, { recUrls });
  }

  // src/background/buondua-service.ts
  var logger4 = initLogger("background");
  var FETCH_TIMEOUT_MS4 = 4e4;
  var FETCH_ATTEMPTS = 2;
  var CONCURRENCY2 = 3;
  var FOLLOW_PAGES_CAP = 40;
  var KEY_GOOGLE_COOLDOWN = "google_cooldown_until";
  var GOOGLE_TAB_INTERVAL_MS = 4e3;
  var GOOGLE_MAX_REQUESTS_PER_RUN = 8;
  var GOOGLE_COOLDOWN_MS = 15 * 60 * 1e3;
  var BuonduaService = class {
    /** Google 全站模式：为无 sitesearch 配置的站点构造 Google 搜索配置（FP-013 调整）
     *  2026-10-07（FP-022）：Google 已拒绝 gbv=1 / sitesearch= 老参数（实测 403），改用现行 site: 语法；
     *  结果提取走 searchGoogleViaTab（标签页 + executeScript，仅标题+链接）
     *  FP-014：优先主域（m./www./mobile. 子域 Google 索引差，如 phimvuspot 用 phimvuspot.com 而非 m. 版） */
    googleSearchConfig(site) {
      const host = site.hosts.find((h) => !/^(m|www|mobile)\./i.test(h)) ?? site.hosts[0] ?? site.id;
      return {
        ...site,
        searchUrl: (q, page) => `https://www.google.com/search?q=${encodeURIComponent(`${q} site:${host}`)}&hl=zh-CN${page > 1 ? `&start=${(page - 1) * 10}` : ""}`
      };
    }
    /** 站内搜索接口 fetch（FP-014 抽取：Google 降级与普通站内分支共用）：
     *  jrants 页间强制间隔防限流；反爬拦截页跳过；无结果提前 break */
    async fetchSiteSearch(site, query, pagesPerSite, startPage) {
      const items = [];
      let pages = 0;
      let error;
      for (let page = startPage; page < startPage + pagesPerSite; page++) {
        const url = site.searchUrl?.(query, page);
        if (!url) break;
        const throttle = site.def.throttle;
        if (throttle && page >= throttle.fromPage) await sleep(throttle.delayMs);
        const html = await this.fetchHtml(url);
        pages++;
        if (isBlockedPage(html)) {
          error = "\u641C\u7D22\u88AB\u53CD\u722C\u62E6\u622A\uFF08\u9650\u6D41\uFF09\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
          logger4.warn("buondua", "\u7AD9\u70B9\u641C\u7D22\u88AB\u53CD\u722C\u62E6\u622A", { site: site.id, len: html.length });
          break;
        }
        const parsed = parseLinksForSite(site.id, html, url);
        if (parsed.length === 0) {
          break;
        }
        items.push(...parsed);
      }
      return { items, pages, error };
    }
    /** Google 通道冷却剩余毫秒（FP-024；0 表示可用） */
    async googleCooldownRemainMs() {
      const until = await storageGet(KEY_GOOGLE_COOLDOWN) ?? 0;
      return Math.max(0, until - Date.now());
    }
    /** Google 通道：页面降级搜索（FP-012/093）——后台静默打开 Google 搜索标签（真实浏览器 JS 渲染），
     *  提取渲染后结果（a.zReHs + h3 / h3.r > a），逐页进行，完成后关闭标签。
     *  后台 fetch 拿不到新版 Google 结果（JS 渲染壳），此通道与用户手动搜索等效。
     *
     *  FP-024 限频（用户实测结论：密集高频请求会触发 Google 反爬，必须极力避免）：
     *  ① 冷却检查：被拒后 GOOGLE_COOLDOWN_MS 内不再发起任何 Google 请求
     *  ② 请求间隔：相邻请求（含跨站）至少 GOOGLE_TAB_INTERVAL_MS
     *  ③ 单轮预算：整轮聚合搜索共享 GOOGLE_MAX_REQUESTS_PER_RUN 次上限
     *  ④ 标签页复用：同站多页在同一标签页内导航，避免反复新建标签页的自动化特征 */
    async searchGoogleViaTab(site, query, pagesPerSite, startPage = 1, budget = { used: 0 }) {
      const cooldown = await this.googleCooldownRemainMs();
      if (cooldown > 0) {
        logger4.warn("buondua", "Google \u901A\u9053\u51B7\u5374\u4E2D\uFF0C\u8DF3\u8FC7", {
          site: site.id,
          remainMin: Math.ceil(cooldown / 6e4)
        });
        return { items: [], pages: 0, blocked: true, cooldownRemainMs: cooldown };
      }
      const items = [];
      const seen = /* @__PURE__ */ new Set();
      let pagesFetched = 0;
      let blocked = false;
      let cooldownRemainMs;
      let budgetExhausted = false;
      let tabId;
      try {
        for (let page = startPage; page < startPage + pagesPerSite; page++) {
          const url = site.searchUrl?.(query, page);
          if (!url) break;
          if (budget.used >= GOOGLE_MAX_REQUESTS_PER_RUN) {
            budgetExhausted = true;
            logger4.warn("buondua", "\u672C\u8F6E Google \u8BF7\u6C42\u5DF2\u8FBE\u4E0A\u9650\uFF0C\u505C\u6B62", {
              site: site.id,
              used: budget.used,
              limit: GOOGLE_MAX_REQUESTS_PER_RUN
            });
            break;
          }
          if (budget.used > 0) await sleep(GOOGLE_TAB_INTERVAL_MS);
          budget.used++;
          if (tabId === void 0) {
            const tab = await chrome.tabs.create({ url, active: false });
            tabId = tab.id;
          } else {
            await chrome.tabs.update(tabId, { url });
            await sleep(600);
          }
          if (tabId === void 0) break;
          const ok = await this.waitForTabComplete(tabId, 12e3);
          if (!ok) {
            logger4.warn("buondua", "Google \u6807\u7B7E\u9875\u52A0\u8F7D\u8D85\u65F6", { site: site.id, page });
            break;
          }
          const extracted = await this.extractGoogleTabResults(tabId);
          logger4.info("buondua", "Google \u6807\u7B7E\u9875\u63D0\u53D6", {
            site: site.id,
            page,
            count: extracted.items.length,
            blocked: extracted.blocked,
            requestsUsed: budget.used
          });
          if (extracted.blocked) {
            blocked = true;
            cooldownRemainMs = GOOGLE_COOLDOWN_MS;
            await storageSet(KEY_GOOGLE_COOLDOWN, Date.now() + GOOGLE_COOLDOWN_MS);
            logger4.warn("buondua", "Google \u62D2\u7EDD\u8BF7\u6C42\uFF0C\u8FDB\u5165\u51B7\u5374\u671F", {
              site: site.id,
              cooldownMin: GOOGLE_COOLDOWN_MS / 6e4
            });
            break;
          }
          if (extracted.items.length === 0) break;
          pagesFetched++;
          for (const { url: rawUrl, title } of extracted.items) {
            const clean = cleanGoogleResult(site, rawUrl, title);
            if (clean && !seen.has(clean.url)) {
              seen.add(clean.url);
              items.push(clean);
            }
          }
        }
      } finally {
        if (tabId !== void 0 && !blocked) await chrome.tabs.remove(tabId).catch(() => {
        });
      }
      return { items, pages: pagesFetched, blocked, cooldownRemainMs, budgetExhausted };
    }
    /** 等待标签页加载完成（tabs.create 后页面加载是异步的，未加载完 executeScript 会失败） */
    async waitForTabComplete(tabId, timeoutMs = 2e4) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === "complete" && (tab.url ?? "").startsWith("http")) return true;
        } catch {
          return false;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      return false;
    }
    /** 在 Google 搜索标签内等待 JS 渲染并提取结果；同时识别 403 / 人机验证页（FP-022）
     *  被拒时返回 blocked=true（调用方据此保留标签页供用户手动完成验证） */
    extractGoogleTabResults(tabId) {
      return chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          for (let i = 0; i < 16; i++) {
            if (document.querySelector("a.zReHs, h3.r")) break;
            if (document.title.includes("\u672A\u627E\u5230") || /did not match|No results found/i.test(document.body?.innerText ?? "")) break;
            await new Promise((r) => setTimeout(r, 500));
          }
          const head = `${document.title} ${(document.body?.innerText ?? "").slice(0, 1500)}`;
          const isBlocked = /您的客户端没有权限|没有权限.{0,10}获取 URL|系统检测到异常流量|unusual traffic|not a robot|recaptcha|sorry\/index|自动化查询/i.test(
            head
          );
          const out = [];
          const seen = /* @__PURE__ */ new Set();
          const push = (u, t) => {
            if (seen.has(u)) return;
            seen.add(u);
            out.push({ url: u, title: t });
          };
          document.querySelectorAll("a.zReHs").forEach((a) => {
            const h3 = a.querySelector("h3");
            if (h3) push(a.href, h3.textContent ?? "");
          });
          if (out.length === 0) {
            document.querySelectorAll("h3.r > a").forEach((a) => {
              const anchor = a;
              push(anchor.href, a.textContent ?? "");
            });
          }
          return { items: out, blocked: isBlocked && out.length === 0 };
        }
      }).then((res) => res[0]?.result ?? { items: [], blocked: false }).catch((err) => {
        logger4.warn("buondua", "Google \u6807\u7B7E\u9875\u6CE8\u5165\u5931\u8D25", { tabId, error: String(err) });
        return { items: [], blocked: false };
      });
    }
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
          if (resp.status === 429 || resp.status === 503) {
            logger4.warn("buondua", `HTTP ${resp.status} \u88AB\u9650\u6D41\uFF0C\u7B49\u5F85 2500ms \u540E\u91CD\u8BD5`, { url });
            await sleep(2500);
          }
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
      const detectedMax = parseGalleryMaxPage(firstHtml, site);
      const maxPage = site.def.followPagesUntilEmpty ? Math.max(detectedMax, FOLLOW_PAGES_CAP) : detectedMax;
      if (site.def.followPagesUntilEmpty) {
        logger4.info("buondua", "\u542F\u7528\u987A\u5E8F\u7FFB\u9875\uFF08\u5206\u9875\u603B\u6570\u4E0D\u53EF\u6D4B\uFF09", {
          site: site.id,
          detected: detectedMax,
          cap: FOLLOW_PAGES_CAP
        });
      }
      const all = [];
      for (let p = 1; p <= maxPage; p++) {
        all.push(site.pageUrl(base, p));
      }
      const imagesMap = /* @__PURE__ */ new Map();
      let scanned = 0;
      let emptyStreak = 0;
      let repeatStreak = 0;
      const pageThrottle = site.def.throttle;
      for (let pageIndex = 0; pageIndex < all.length; pageIndex++) {
        const pageUrl = all[pageIndex];
        let html;
        if (pageIndex === 0) {
          html = firstHtml;
        } else {
          if (pageThrottle && pageIndex + 1 >= pageThrottle.fromPage) await sleep(pageThrottle.delayMs);
          html = await getHtml(pageUrl);
        }
        const imgs = parseGalleryImages(html, pageUrl, site);
        if (imgs.length === 0 && imagesMap.size === 0 && pageUrl === all[0]) {
          logger4.warn("buondua", "\u9996\u9875\u89E3\u6790 0 \u5F20\uFF0C\u8BCA\u65AD\u4FE1\u606F", {
            site: site.id,
            url: pageUrl,
            hasContainer: site.containerOpen.test(html),
            htmlLen: html.length,
            imgTags: (html.match(/<img\b/gi) ?? []).length
          });
        }
        scanned += imgs.length;
        emptyStreak = imgs.length === 0 ? emptyStreak + 1 : 0;
        const beforeSize = imagesMap.size;
        for (const img of imgs) {
          const key = `${img.url.split("?")[0]}`;
          if (!imagesMap.has(key)) imagesMap.set(key, img);
        }
        repeatStreak = imagesMap.size === beforeSize ? repeatStreak + 1 : 0;
        if (emptyStreak >= 3 || repeatStreak >= 3) break;
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
    /** 解析推荐/其他相册链接（按站点定义 scan 字段路由，解析器注册表见 sites/parsers.ts） */
    async scanLinks(url, kind) {
      const html = await this.fetchHtml(url);
      const base = url;
      const site = matchGallerySite(url);
      const items = scanSiteLinks(site, html, base, kind);
      logger4.info("buondua", "\u94FE\u63A5\u626B\u63CF\u5B8C\u6210", { kind, count: items.length, site: site?.id ?? "buondua" });
      return items;
    }
    /** 站内列表页遍历（FP-023 列表浏览）：逐页 fetch + 解析相册链接，不依赖搜索引擎
     *  pageKind：界面手动指定的分页方式（2026-10-08 体检 P0-3）
     *  fetchHtmlFn：可选，降级用（content 页面内 fetch 带 Cookie 穿透反爬） */
    async fetchSiteList(siteId, listUrl, pages, pageKind, fetchHtmlFn) {
      const getHtml = fetchHtmlFn ?? ((u) => this.fetchHtml(u));
      const site = siteById(siteId);
      if (!site) throw new Error(`\u672A\u77E5\u7AD9\u70B9\uFF08${siteId}\uFF09`);
      const urls = [];
      for (let p = 1; p <= Math.max(1, pages); p++) urls.push(listPageUrl(site, listUrl, p, pageKind));
      const byUrl = /* @__PURE__ */ new Map();
      for (const pageUrl of urls) {
        const html = await getHtml(pageUrl);
        if (isBlockedPage(html)) {
          logger4.warn("buondua", "\u5217\u8868\u9875\u88AB\u53CD\u722C\u62E6\u622A", { site: siteId, url: pageUrl });
          break;
        }
        for (const item of parseListPageLinks(html, pageUrl, site)) {
          if (!byUrl.has(item.url)) byUrl.set(item.url, item);
        }
      }
      logger4.info("buondua", "\u5217\u8868\u9875\u6293\u53D6\u5B8C\u6210", {
        site: siteId,
        listUrl,
        pages: urls.length,
        unique: byUrl.size
      });
      return { items: [...byUrl.values()], pages: urls };
    }
    /** 批量抓取：targets 逐个全子页抓取（并发受限），返回每个目标的图片（失败带 error，096） */
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
            const error = String(err);
            logger4.warn("buondua", "\u6279\u91CF\u76F8\u518C\u6293\u53D6\u5931\u8D25", { url: target.url, error });
            onItem(idx, target, [], error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY2, targets.length) }, () => worker()));
    }
    /** 聚合搜索：多站点逐页搜索 → 按站点路由解析 → 合并去重
     *  startPage：每站起始页（「下一批」续搜传上次结束页 +1，096）
     *  onSite：每站完成后回调（推送该站结果，增量展示）；返回全部合并去重结果
     *  useGoogleAll：Google 全站搜索开关（FP-013 调整）——开启后全部站点走 Google sitesearch
     *  网页通道（标签页渲染，仅标题+链接，同站去重，速度快）；不读站内搜索接口
     *  googleSites：Google 组站点（FP-014）——这些站优先走 Google，失败自动降级站内 */
    async searchSites(query, sites, pagesPerSite, onSite, startPage = 1, useGoogleAll = false, googleSites = []) {
      const mergedMap = /* @__PURE__ */ new Map();
      const siteStats = {};
      const googleBudget = { used: 0 };
      for (const siteId of sites) {
        const site = siteById(siteId);
        const useGoogleChannel = useGoogleAll || googleSites.includes(siteId);
        if (!site || !site.searchUrl && !useGoogleChannel) {
          await onSite(siteId, [], "\u8BE5\u7AD9\u4E0D\u652F\u6301\u641C\u7D22");
          continue;
        }
        const items = [];
        let error;
        let pagesFetched = 0;
        try {
          const isGoogleOnly = !site.searchUrl && !site.searchAlbumPath;
          if (site.searchAlbumPath || useGoogleAll || isGoogleOnly || googleSites.includes(siteId)) {
            const googleSite = useGoogleAll || isGoogleOnly || googleSites.includes(siteId) ? this.googleSearchConfig(site) : site;
            const tabRes = await this.searchGoogleViaTab(googleSite, query, pagesPerSite, startPage, googleBudget);
            pagesFetched = tabRes.pages;
            for (const item of tabRes.items) items.push(item);
            if (tabRes.blocked) {
              const remainMin = tabRes.cooldownRemainMs ? Math.ceil(tabRes.cooldownRemainMs / 6e4) : 0;
              error = remainMin > 0 ? `Google \u62D2\u7EDD\u672C\u6B21\u8BF7\u6C42\uFF08403 / \u4EBA\u673A\u9A8C\u8BC1\uFF09\uFF1AGoogle \u901A\u9053\u5DF2\u6682\u505C ${remainMin} \u5206\u949F\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u6216\u6539\u7528\u7AD9\u5185\u901A\u9053` : "Google \u62D2\u7EDD\u672C\u6B21\u8BF7\u6C42\uFF08403 / \u4EBA\u673A\u9A8C\u8BC1\uFF09\uFF1A\u5DF2\u4FDD\u7559\u641C\u7D22\u6807\u7B7E\u9875\uFF0C\u8BF7\u624B\u52A8\u5B8C\u6210\u9A8C\u8BC1\u540E\u91CD\u8BD5";
            } else if (tabRes.budgetExhausted) {
              error = `\u672C\u8F6E Google \u8BF7\u6C42\u5DF2\u8FBE\u4E0A\u9650\uFF08${GOOGLE_MAX_REQUESTS_PER_RUN} \u6B21\uFF09\uFF0C\u5DF2\u505C\u6B62\u4EE5\u907F\u514D\u89E6\u53D1\u53CD\u722C\uFF0C\u8BF7\u7A0D\u540E\u518D\u641C\u6216\u6539\u7528\u7AD9\u5185\u901A\u9053`;
            } else if (tabRes.items.length === 0 && site.searchUrl) {
              logger4.info("buondua", "Google \u901A\u9053\u65E0\u7ED3\u679C\uFF0C\u964D\u7EA7\u7AD9\u5185\u641C\u7D22", { site: siteId, query });
              const fallback = await this.fetchSiteSearch(site, query, pagesPerSite, startPage);
              pagesFetched = Math.max(pagesFetched, fallback.pages);
              for (const item of fallback.items) items.push(item);
              if (fallback.items.length > 0) {
                error = void 0;
              } else if (fallback.error) {
                error = fallback.error;
              }
            }
            if (tabRes.items.length === 0 && items.length === 0 && !error) {
              error = "Google \u6807\u7B7E\u9875\u672A\u63D0\u53D6\u5230\u76F8\u518C\u7ED3\u679C\uFF08\u53EF\u80FD\u9A8C\u8BC1\u9875/\u65E0\u5339\u914D\uFF0C\u65E5\u5FD7\u542B\u8BCA\u65AD\uFF09";
            }
          } else {
            const fallback = await this.fetchSiteSearch(site, query, pagesPerSite, startPage);
            pagesFetched = fallback.pages;
            for (const item of fallback.items) items.push(item);
            if (fallback.error) error = fallback.error;
          }
        } catch (err) {
          error = humanizeFetchError(String(err));
          logger4.warn("buondua", "\u7AD9\u70B9\u641C\u7D22\u5931\u8D25", { site: siteId, error: String(err), hint: error });
        }
        const unique = dedupeLinks2(items.map((item) => enrichSearchItem(siteId, site, item)));
        for (const item of unique) {
          if (!mergedMap.has(item.url)) mergedMap.set(item.url, item);
        }
        siteStats[siteId] = { count: unique.length, pages: pagesFetched, ...error ? { error } : {} };
        await onSite(siteId, unique, error);
      }
      logger4.info("buondua", "\u805A\u5408\u641C\u7D22\u5B8C\u6210", {
        query,
        sites: sites.length,
        merged: mergedMap.size,
        perSite: siteStats
      });
      return [...mergedMap.values()];
    }
    /** 相册文件夹名：ID-{站点 folderTag}-{相册名}-{时间戳}
     *  阶段 1：全部站点 folderTag='buondua'，命名与旧版逐字一致（语义化改名属行为变更，另行申请） */
    buildFolderName(title, url) {
      const tag = matchGallerySite(url)?.def.folderTag ?? "buondua";
      const name = extractBuonduaAlbumName(title, url);
      const d = /* @__PURE__ */ new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      return `ID-${tag}-${name}-${ts}`;
    }
    /** Google 连接测试（FP-012/093）：页面降级通道验证——后台开 Google 搜索标签（真实渲染），
     *  等待渲染后报告结果条数/标题/可见文本；结果写日志 */
    async testGoogleConnection() {
      const start = Date.now();
      try {
        const tab = await chrome.tabs.create({ url: "https://www.google.com/search?q=test", active: false });
        try {
          await this.waitForTabComplete(tab.id);
          const info = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
              for (let i = 0; i < 24; i++) {
                if (document.querySelector("a.zReHs, h3.r") || /did not match|No results found|未找到/i.test(document.body?.innerText ?? "")) break;
                await new Promise((r) => setTimeout(r, 500));
              }
              const count = document.querySelectorAll("a.zReHs, h3.r").length;
              return { count, title: document.title, body: (document.body?.innerText ?? "").slice(0, 200) };
            }
          }).then((res) => res[0]?.result ?? { count: 0, title: "", body: "" });
          const diag = {
            len: info.body.length,
            title: info.title.slice(0, 100),
            hasH3: info.count > 0,
            isConsent: false,
            hasMetaRefresh: false,
            hasNoResultText: /did not match|No results found|未找到/i.test(info.body),
            hops: 0,
            bodyPreview: info.body
          };
          const ms = Date.now() - start;
          const blocked = /403|您的客户端没有权限|系统检测到异常流量|unusual traffic|not a robot|recaptcha/i.test(
            `${info.title} ${info.body}`
          );
          if (blocked) logger4.warn("buondua", "Google \u6D4B\u8BD5\uFF1A\u88AB\u62D2\u7EDD\uFF08403 / \u4EBA\u673A\u9A8C\u8BC1\uFF09", { ...diag, ms });
          else if (diag.hasH3) logger4.info("buondua", "Google \u6807\u7B7E\u9875\u6D4B\u8BD5\uFF1A\u6B63\u5E38", { ...diag, ms });
          else logger4.warn("buondua", "Google \u6807\u7B7E\u9875\u6D4B\u8BD5\uFF1A\u65E0\u7ED3\u679C", { ...diag, ms });
          return { ok: true, status: 200, blocked, ms, diag };
        } finally {
          await chrome.tabs.remove(tab.id).catch(() => {
          });
        }
      } catch (err) {
        logger4.warn("buondua", "Google \u6807\u7B7E\u9875\u6D4B\u8BD5\u5931\u8D25", { error: String(err), ms: Date.now() - start });
        return { ok: false, blocked: false, ms: Date.now() - start, error: String(err) };
      }
    }
  };
  function enrichSearchItem(siteId, site, item) {
    const url = site.rewriteUrl ? site.rewriteUrl(item.url) : item.url;
    return { ...item, url, imageCount: item.imageCount ?? extractSearchImageCount(siteId, item, url) };
  }
  function humanizeFetchError(raw) {
    if (/Failed to fetch|NetworkError|ERR_/i.test(raw)) return "\u7AD9\u70B9\u4E0D\u53EF\u8FBE\uFF08\u57DF\u540D\u53EF\u80FD\u5DF2\u53D8\u66F4\u6216\u7F51\u7EDC\u53D7\u9650\uFF09";
    if (/HTTP 403/.test(raw)) return "\u88AB\u7AD9\u70B9\u62D2\u7EDD\uFF08\u53CD\u722C\u62E6\u622A\uFF0C\u53EF\u7A0D\u540E\u91CD\u8BD5\uFF09";
    if (/HTTP 429/.test(raw)) return "\u88AB\u7AD9\u70B9\u9650\u6D41\uFF08429\uFF0C\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF09\uFF1A\u8BF7\u7B49\u5F85\u51E0\u5206\u949F\u540E\u518D\u8BD5";
    if (/HTTP 404/.test(raw)) return "\u9875\u9762\u4E0D\u5B58\u5728\uFF08\u94FE\u63A5\u53EF\u80FD\u5DF2\u5931\u6548\uFF09";
    if (/HTTP 5\d\d/.test(raw)) return "\u7AD9\u70B9\u670D\u52A1\u5668\u9519\u8BEF";
    if (/请求超时|AbortError/i.test(raw)) return "\u8BF7\u6C42\u8D85\u65F6";
    return raw;
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function isBlockedPage(html) {
    return /search request blocked|正在进行安全验证|just a moment|cf-chl|turnstile|attention required|unusual traffic|enable JavaScript and cookies|recaptcha|our systems have detected/i.test(html);
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
  var TAG_CUSTOM_KEY = "tag_custom";
  var tagCustomDict = emptyCustomDict();
  var tagCustomReady = (async () => {
    tagCustomDict = loadCustomDict(await storageGet(TAG_CUSTOM_KEY));
  })();
  var STAR_OVERLAY_KEY = "star_overlay_enabled";
  var STAR_OVERLAY_ID = "star-overlay";
  var STAR_OVERLAY_ORIGINS = ["*://*.imgbb.com/*", "*://ibb.co/*"];
  async function registerStarOverlay() {
    try {
      const granted = await chrome.permissions.contains({ origins: STAR_OVERLAY_ORIGINS });
      if (!granted) return false;
      const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [STAR_OVERLAY_ID] });
      if (existing.length === 0) {
        await chrome.scripting.registerContentScripts([
          {
            id: STAR_OVERLAY_ID,
            matches: STAR_OVERLAY_ORIGINS,
            js: ["js/star-overlay.js"],
            runAt: "document_idle",
            allFrames: false,
            persistAcrossSessions: true
          }
        ]);
        logger5.info("star", "\u6807\u661F\u60AC\u6D6E\u7A97\u5DF2\u6CE8\u518C", { matches: STAR_OVERLAY_ORIGINS });
      }
      return true;
    } catch (err) {
      logger5.error("star", "\u6807\u661F\u60AC\u6D6E\u7A97\u6CE8\u518C\u5931\u8D25", String(err));
      return false;
    }
  }
  async function unregisterStarOverlay() {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [STAR_OVERLAY_ID] });
      logger5.info("star", "\u6807\u661F\u60AC\u6D6E\u7A97\u5DF2\u6CE8\u9500");
    } catch {
    }
  }
  void (async () => {
    const enabled = await storageGet(STAR_OVERLAY_KEY);
    if (!enabled) return;
    const ok = await registerStarOverlay();
    if (!ok) {
      await storageSet(STAR_OVERLAY_KEY, false);
      logger5.warn("star", "\u6807\u661F\u60AC\u6D6E\u7A97\u6743\u9650\u5DF2\u5931\u6548\uFF0C\u5F00\u5173\u7F6E\u4E3A\u5173\u95ED");
    }
  })();
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
  var buondua2 = new BuonduaService();
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
  function extractProbeData() {
    const out = {
      title: document.title,
      url: location.href,
      ogImage: "",
      imgSrcs: [],
      containerCandidates: [],
      pagination: []
    };
    out.ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute("content") ?? "";
    const seenImg = /* @__PURE__ */ new Set();
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const s = img.getAttribute("data-src") || img.src || img.getAttribute("data-original") || "";
      if (!s || seenImg.has(s)) continue;
      seenImg.add(s);
      out.imgSrcs.push(s);
      if (out.imgSrcs.length >= 40) break;
    }
    const counter = {};
    for (const img of Array.from(document.querySelectorAll("img"))) {
      let el = img.parentElement;
      for (let d = 0; d < 4 && el; d++) {
        const cls = typeof el.className === "string" ? el.className : "";
        for (const c of cls.split(/\s+/)) {
          if (c && c.length > 3) counter[c] = (counter[c] ?? 0) + 1;
        }
        el = el.parentElement;
      }
    }
    out.containerCandidates = Object.entries(counter).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([cls, n]) => ({ cls, n }));
    const pageSeen = /* @__PURE__ */ new Set();
    for (const a of Array.from(document.querySelectorAll("a[href]"))) {
      const href = a.href;
      if (/[?&]page=\d+|page\/\d+|(?<![a-z])\/\d+\/?$/i.test(href) && !pageSeen.has(href)) {
        pageSeen.add(href);
        out.pagination.push({ href, text: (a.textContent ?? "").trim().slice(0, 20) });
        if (out.pagination.length >= 10) break;
      }
    }
    return out;
  }
  async function probePageStructure(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    try {
      const deadline = Date.now() + 25e3;
      while (Date.now() < deadline) {
        const t = await chrome.tabs.get(tab.id);
        if (t.status === "complete" && (t.url ?? "").startsWith("http")) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractProbeData
      });
      return res[0]?.result ?? null;
    } finally {
      await chrome.tabs.remove(tab.id).catch(() => {
      });
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
      case "IMG_DB_SET_STAR": {
        await producerDbReady;
        if (message.autoCreate) producerDb = ensureEntry(producerDb, message.username, "star");
        producerDb = setStarRating(producerDb, message.username, message.stars);
        await storageSet(PRODUCER_DB_KEY, producerDb);
        const stars = producerDb.entries[message.username]?.starRating ?? 0;
        logger5.info("score", "\u624B\u52A8\u661F\u7EA7\u5DF2\u8BBE\u7F6E", { username: message.username, stars, autoCreate: !!message.autoCreate });
        return { ok: true, starRating: stars, starInfo: starInfo(producerDb, message.username) };
      }
      case "IMG_DB_GET_STAR": {
        await producerDbReady;
        return { ok: true, starInfo: starInfo(producerDb, message.username) };
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
        await tagCustomReady;
        const tags = computeTags(Object.values(producerDb.entries), {
          topN: message.topN ?? 200,
          minAlbums: message.minAlbums ?? 5,
          minUsers: message.minUsers ?? 1,
          custom: tagCustomDict,
          includeSlug: !!message.includeSlug
        });
        logger5.info("tag", "\u6807\u7B7E\u4E91\u7EDF\u8BA1\u5B8C\u6210", {
          tags: tags.length,
          topN: message.topN ?? 200,
          minAlbums: message.minAlbums ?? 5,
          minUsers: message.minUsers ?? 1,
          custom: tagCustomDict.entries.length,
          blocked: tagCustomDict.blocked.length
        });
        return { ok: true, tags };
      }
      case "IMG_TAG_DICT_GET": {
        await tagCustomReady;
        return { ok: true, tagDict: tagCustomDict };
      }
      case "IMG_TAG_DICT_SAVE": {
        tagCustomDict = loadCustomDict(message.tagDict);
        await storageSet(TAG_CUSTOM_KEY, tagCustomDict);
        logger5.info("tag", "\u81EA\u5B9A\u4E49\u6807\u7B7E\u8BCD\u5178\u5DF2\u4FDD\u5B58", {
          entries: tagCustomDict.entries.length,
          blocked: tagCustomDict.blocked.length
        });
        return { ok: true, tagDict: tagCustomDict };
      }
      case "STAR_OVERLAY_STATUS": {
        const enabled = await storageGet(STAR_OVERLAY_KEY) === true;
        const regs = await chrome.scripting.getRegisteredContentScripts({ ids: [STAR_OVERLAY_ID] }).catch(() => []);
        return { ok: true, overlay: { enabled, registered: regs.length > 0 } };
      }
      case "STAR_OVERLAY_SET": {
        if (message.enabled) {
          const ok = await registerStarOverlay();
          await storageSet(STAR_OVERLAY_KEY, ok);
          const regs = await chrome.scripting.getRegisteredContentScripts({ ids: [STAR_OVERLAY_ID] }).catch(() => []);
          return { ok: true, overlay: { enabled: ok, registered: regs.length > 0 } };
        }
        await unregisterStarOverlay();
        await storageSet(STAR_OVERLAY_KEY, false);
        return { ok: true, overlay: { enabled: false, registered: false } };
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
          const { images, pages, title } = await buondua2.fetchAlbumAllPages(message.url);
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
            const { images, pages, title } = await buondua2.fetchAlbumAllPages(message.url, contentFetch);
            await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "album", data: images, done: true });
            logger5.info("buondua", "\u5168\u5B50\u9875\u6293\u53D6\u5B8C\u6210\uFF08\u9875\u9762\u5185 fetch \u964D\u7EA7\uFF09", { url: message.url, pages: pages.length, count: images.length, title });
            return { ok: true, name: title || void 0 };
          } catch (err2) {
            const hint = humanizeFetchError(String(err2));
            logger5.error("buondua", "\u5168\u5B50\u9875\u6293\u53D6\u5931\u8D25\uFF08\u542B\u964D\u7EA7\uFF09", { error: String(err2), hint });
            await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "album", data: [], done: true, error: hint });
            return { ok: false, error: hint };
          }
        }
      }
      case "BD_SCAN_LINKS": {
        try {
          const items = await buondua2.scanLinks(message.url, message.kind);
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
          return { ok: true, google: await buondua2.testGoogleConnection() };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }
      case "BD_SEARCH": {
        try {
          await buondua2.searchSites(
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
            },
            message.startPage ?? 1,
            message.useGoogleAll === true,
            message.googleSites ?? []
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
          await buondua2.fetchAlbumsBatch(
            targets.map((t) => ({ url: t.url, title: t.folderName })),
            (index, _target, images, error) => {
              completed++;
              void sendToTab(sessionOf(message.srcTabId), {
                type: "BD_RESULT",
                kind: "batch-item",
                data: { index, target: targets[index], images, pages: [], error },
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
      case "BD_FETCH_LIST": {
        const contentFetch = async (u) => {
          const res = await sendToTabAndGet(
            message.srcTabId,
            { type: "BD_FETCH_HTML", url: u }
          );
          if (!res || !res.ok || !res.data) throw new Error(res && !res.ok ? res.error : "\u9875\u9762\u5185 fetch \u65E0\u54CD\u5E94");
          return res.data;
        };
        try {
          const direct = await buondua2.fetchSiteList(message.siteId, message.listUrl, message.pages, message.pageKind).catch((err) => {
            logger5.warn("buondua", "\u540E\u53F0\u5217\u8868\u6293\u53D6\u5931\u8D25\uFF0C\u5C1D\u8BD5\u9875\u9762\u5185 fetch \u964D\u7EA7", String(err));
            return null;
          });
          let items = direct ? direct.items : [];
          if (items.length === 0) {
            const fallback = await buondua2.fetchSiteList(
              message.siteId,
              message.listUrl,
              message.pages,
              message.pageKind,
              contentFetch
            );
            items = fallback.items;
          }
          await sendToTab(sessionOf(message.srcTabId), { type: "BD_RESULT", kind: "list", data: items, done: true });
          logger5.info("buondua", "\u5217\u8868\u9875\u6293\u53D6\u5B8C\u6210", { site: message.siteId, count: items.length });
        } catch (err) {
          logger5.error("buondua", "\u5217\u8868\u9875\u6293\u53D6\u5931\u8D25\uFF08\u542B\u964D\u7EA7\uFF09", String(err));
          await sendToTab(sessionOf(message.srcTabId), {
            type: "BD_RESULT",
            kind: "list",
            data: [],
            done: true,
            error: humanizeFetchError(String(err))
          });
        }
        return { ok: true };
      }
      case "BD_PROBE_PAGE": {
        try {
          const probe = await probePageStructure(message.url);
          if (!probe) throw new Error("\u9875\u9762\u7ED3\u6784\u63D0\u53D6\u5931\u8D25\uFF08\u53EF\u80FD\u52A0\u8F7D\u8D85\u65F6/\u88AB\u62E6\u622A\uFF09");
          logger5.info("buondua", "\u9875\u9762\u7ED3\u6784\u63A2\u6D4B", {
            url: message.url,
            title: probe.title,
            imgs: probe.imgSrcs.length,
            containers: probe.containerCandidates.slice(0, 3),
            pages: probe.pagination.length
          });
          return { ok: true, probe };
        } catch (err) {
          logger5.warn("buondua", "\u9875\u9762\u7ED3\u6784\u63A2\u6D4B\u5931\u8D25", { url: message.url, error: String(err) });
          return { ok: false, error: String(err) };
        }
      }
    }
    return { ok: false, error: "\u672A\u77E5\u6D88\u606F\u7C7B\u578B" };
  }
  logger5.info("runtime", "background \u521D\u59CB\u5316\u5B8C\u6210");
})();
//# sourceMappingURL=background.js.map
