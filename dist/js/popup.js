"use strict";
(() => {
  // src/lib/messages.ts
  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
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
  async function getEntries() {
    return await storageGet(KEY_LOGS) ?? [];
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

  // src/popup/popup.ts
  var logger = initLogger("popup");
  var levelSelect = document.getElementById("level-select");
  var logList = document.getElementById("log-list");
  var emptyTip = document.getElementById("empty-tip");
  var logCount = document.getElementById("log-count");
  var btnRefresh = document.getElementById("btn-refresh");
  var btnClear = document.getElementById("btn-clear");
  var btnCopy = document.getElementById("btn-copy");
  var btnExport = document.getElementById("btn-export");
  var versionEl = document.getElementById("app-version");
  var allEntries = [];
  var currentFilter = "all";
  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }
  function render() {
    const shown = currentFilter === "all" ? allEntries : allEntries.filter((e) => e.level === currentFilter);
    logList.innerHTML = "";
    for (const entry of shown) {
      const row = document.createElement("div");
      row.className = "log-entry";
      const tsSpan = document.createElement("span");
      tsSpan.className = "ts";
      tsSpan.textContent = formatTime(entry.ts);
      const levelSpan = document.createElement("span");
      levelSpan.className = `level ${entry.level}`;
      levelSpan.textContent = entry.level;
      const ctxSpan = document.createElement("span");
      ctxSpan.className = "ctx";
      ctxSpan.textContent = `[${entry.context}/${entry.module}]`;
      const msgSpan = document.createElement("span");
      msgSpan.className = "msg";
      msgSpan.textContent = entry.message;
      row.append(tsSpan, levelSpan, ctxSpan, msgSpan);
      if (entry.data !== void 0) {
        const dataDiv = document.createElement("div");
        dataDiv.className = "data";
        dataDiv.textContent = safeStringify(entry.data);
        row.appendChild(dataDiv);
      }
      logList.appendChild(row);
    }
    emptyTip.classList.toggle("show", shown.length === 0);
    logCount.textContent = `${shown.length} / ${allEntries.length} \u6761`;
  }
  function safeStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  async function loadLogs() {
    const res = await sendMessage({ type: "LOG_GET" });
    if (res.ok) {
      allEntries = res.entries;
      render();
    } else {
      logger.error("popup", "\u62C9\u53D6\u65E5\u5FD7\u5931\u8D25", res.error);
    }
  }
  async function loadLevel() {
    const res = await sendMessage({ type: "LOG_GET_LEVEL" });
    if (res.ok) {
      levelSelect.value = res.level;
    }
  }
  function buildExportText() {
    const header = `# \u63D2\u4EF6\u65E5\u5FD7\u5BFC\u51FA
# \u65F6\u95F4: ${(/* @__PURE__ */ new Date()).toLocaleString()}
# \u7248\u672C: ${chrome.runtime.getManifest().version}
# \u6761\u6570: ${allEntries.length}

`;
    const lines = allEntries.map((e) => {
      const time = new Date(e.ts).toLocaleString("zh-CN", { hour12: false });
      const data = e.data !== void 0 ? ` ${safeStringify(e.data)}` : "";
      return `[${time}] [${e.level}] [${e.context}/${e.module}] ${e.message}${data}`;
    });
    return header + lines.join("\n");
  }
  async function copyLogs() {
    const text = buildExportText();
    try {
      await navigator.clipboard.writeText(text);
      logger.info("popup", "\u65E5\u5FD7\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      logger.info("popup", "\u65E5\u5FD7\u5DF2\u590D\u5236\u5230\u526A\u8D34\u677F\uFF08\u964D\u7EA7\u65B9\u5F0F\uFF09");
    }
  }
  function exportLogs() {
    const blob = new Blob([buildExportText()], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extension-log-${Date.now()}.log`;
    a.click();
    URL.revokeObjectURL(url);
    logger.info("popup", "\u65E5\u5FD7\u5DF2\u5BFC\u51FA\u4E3A\u6587\u4EF6");
  }
  levelSelect.addEventListener("change", async () => {
    const level = levelSelect.value;
    const res = await sendMessage({ type: "LOG_SET_LEVEL", level });
    if (res.ok) {
      logger.info("popup", `\u65E5\u5FD7\u7B49\u7EA7\u5207\u6362\u4E3A ${level}`);
      void loadLogs();
    }
  });
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      render();
    });
  });
  btnRefresh.addEventListener("click", () => {
    void loadLogs();
  });
  btnClear.addEventListener("click", async () => {
    const res = await sendMessage({ type: "LOG_CLEAR" });
    if (res.ok) {
      allEntries = [];
      render();
      logger.info("popup", "\u65E5\u5FD7\u5DF2\u6E05\u7A7A");
    }
  });
  btnCopy.addEventListener("click", () => {
    void copyLogs();
  });
  btnExport.addEventListener("click", () => {
    exportLogs();
  });
  void (async () => {
    versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
    await loadLevel();
    await loadLogs();
    logger.info("popup", "popup \u9762\u677F\u6253\u5F00");
  })();
})();
//# sourceMappingURL=popup.js.map
