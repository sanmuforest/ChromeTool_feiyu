"use strict";
(() => {
  // src/content/image-scanner.ts
  var BATCH_SIZE = 20;
  var REPORT_INTERVAL_MS = 300;
  var CONCURRENCY = 4;
  var SIZE_TIMEOUT_MS = 5e3;
  var MAX_PER_PARSE = 200;
  var SCROLL_STEPS = 3;
  var SCROLL_DELAY_MS = 800;
  var MIN_IMAGE_SIZE = 100;
  if (!window.__grabberContentInjected) {
    window.__grabberContentInjected = true;
    initScanner();
  }
  function initScanner() {
    let scanning = false;
    let cancelled = false;
    let seenUrls = /* @__PURE__ */ new Set();
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "GRAB_PARSE_START") {
        if (!scanning) {
          seenUrls.clear();
          void parse();
        }
        sendResponse({ ok: true });
      } else if (msg?.type === "GRAB_PARSE_CANCEL") {
        if (scanning) {
          cancelled = true;
        }
        sendResponse({ ok: true });
      } else if (msg?.type === "GRAB_LOAD_MORE") {
        if (!scanning) {
          void loadMore();
        }
        sendResponse({ ok: true });
      } else if (msg?.type === "BD_FETCH_HTML") {
        void (async () => {
          try {
            const resp = await fetch(msg.url, { credentials: "include", headers: { Referer: location.href } });
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            sendResponse({ ok: true, data: await resp.text() });
          } catch (err) {
            sendResponse({ ok: false, error: String(err) });
          }
        })();
        return true;
      }
    });
    async function loadMore() {
      scanning = true;
      cancelled = false;
      for (let i = 0; i < SCROLL_STEPS; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise((resolve) => setTimeout(resolve, SCROLL_DELAY_MS));
      }
      await parse();
    }
    async function parse() {
      if (!scanning) scanning = true;
      cancelled = false;
      const imgbb = isImgbbPage();
      const rawCandidates = imgbb ? collectImgbbCandidates() : collectCandidates();
      const candidates = rawCandidates.filter((c) => !seenUrls.has(c.url)).slice(0, MAX_PER_PARSE);
      const total = candidates.length;
      let scanned = 0;
      let batch = [];
      let lastReport = 0;
      const flush = () => {
        if (batch.length === 0) return;
        void chrome.runtime.sendMessage({ type: "GRAB_PARSE_BATCH", images: batch, total, scanned });
        batch = [];
        lastReport = Date.now();
      };
      const timer = setInterval(() => {
        if (batch.length > 0 && Date.now() - lastReport >= REPORT_INTERVAL_MS) {
          flush();
        }
      }, 100);
      let cursor = 0;
      async function worker() {
        while (cursor < candidates.length) {
          if (cancelled) return;
          const candidate = candidates[cursor];
          cursor++;
          seenUrls.add(candidate.url);
          const item = {
            id: candidate.url,
            url: candidate.url,
            thumbUrl: candidate.thumbUrl || void 0,
            width: candidate.width,
            height: candidate.height,
            sizeStatus: candidate.width && candidate.height ? "ok" : "loading"
          };
          batch.push(item);
          if (!candidate.width || !candidate.height) {
            const size = await measureSize(candidate.url);
            if (size.ok) {
              item.width = size.w;
              item.height = size.h;
              item.sizeStatus = "ok";
            } else {
              item.sizeStatus = "unknown";
            }
          }
          scanned++;
          if (batch.length >= BATCH_SIZE) {
            flush();
          }
        }
      }
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      clearInterval(timer);
      flush();
      scanning = false;
      const reachedLimit = !cancelled && total >= MAX_PER_PARSE;
      void chrome.runtime.sendMessage({
        type: "GRAB_PARSE_DONE",
        cancelled: cancelled || void 0,
        reachedLimit: reachedLimit || void 0
      });
    }
  }
  function isImgbbPage() {
    const host = location.hostname;
    return host.endsWith("imgbb.com") || host.endsWith("ibb.co") || host.endsWith("i.ibb.co");
  }
  function collectImgbbCandidates() {
    const results = [];
    const items = Array.from(document.querySelectorAll('.list-item[data-type="image"]'));
    for (const item of items) {
      const raw = item.getAttribute("data-object");
      if (!raw) continue;
      let obj;
      try {
        obj = JSON.parse(decodeURIComponent(raw));
      } catch {
        continue;
      }
      const imgObj = obj.image ?? obj;
      const url = imgObj?.url || obj.url || "";
      if (!/^https?:\/\//i.test(url)) continue;
      const width = obj.width ? Number(obj.width) : void 0;
      const height = obj.height ? Number(obj.height) : void 0;
      if (width && height && (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE)) {
        continue;
      }
      const thumbObj = obj.thumb;
      results.push({ url, thumbUrl: thumbObj?.url || "", width, height });
    }
    return results;
  }
  function collectCandidates() {
    const map = /* @__PURE__ */ new Map();
    const add = (url, thumbUrl = "", dim = {}) => {
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) return;
      const existing = map.get(url);
      map.set(url, {
        url,
        thumbUrl: existing?.thumbUrl || thumbUrl,
        width: existing?.width ?? dim.width,
        height: existing?.height ?? dim.height
      });
    };
    document.querySelectorAll("img").forEach((img) => {
      const current = img.currentSrc || "";
      const src = img.getAttribute("src") || "";
      const w = img.naturalWidth || parseInt(img.getAttribute("width") || "", 10) || 0;
      const h = img.naturalHeight || parseInt(img.getAttribute("height") || "", 10) || 0;
      const dim = w && h ? { width: w, height: h } : {};
      add(current, current || src, dim);
      add(src, current || src, dim);
      add(img.getAttribute("data-src") || "", current || src, dim);
      add(img.getAttribute("data-original") || "", current || src, dim);
      add(img.getAttribute("data-lazy-src") || "", current || src, dim);
      const srcset = img.getAttribute("srcset") || img.getAttribute("data-srcset");
      if (srcset) add(pickLargestSrcset(srcset), current || src, dim);
    });
    document.querySelectorAll("picture source").forEach((source) => {
      const srcset = source.getAttribute("srcset");
      if (srcset) add(pickLargestSrcset(srcset));
    });
    return [...map.values()];
  }
  function pickLargestSrcset(srcset) {
    let best = "";
    let bestScore = -1;
    for (const part of srcset.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const segments = trimmed.split(/\s+/);
      const url = segments[0];
      const descriptor = segments[1] || "1x";
      const score = descriptor.endsWith("w") ? parseInt(descriptor, 10) : parseFloat(descriptor);
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    }
    return best;
  }
  function measureSize(url) {
    return new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => resolve({ ok: false }), SIZE_TIMEOUT_MS);
      img.onload = () => {
        clearTimeout(timer);
        resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
      };
      img.onerror = () => {
        clearTimeout(timer);
        resolve({ ok: false });
      };
      img.src = url;
    });
  }
})();
//# sourceMappingURL=content.js.map
