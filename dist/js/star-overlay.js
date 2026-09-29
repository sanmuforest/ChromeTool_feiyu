"use strict";
(() => {
  // src/lib/storage.ts
  async function storageGet(key) {
    const result = await chrome.storage.local.get(key);
    return result[key];
  }
  async function storageSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  // src/content/star-overlay.ts
  var HOST_ID = "feiyu-star-overlay-host";
  var POS_KEY = "star_overlay_pos";
  var MAX_STARS = 5;
  if (!window.__feiyuStarOverlayInjected) {
    window.__feiyuStarOverlayInjected = true;
    void initStarOverlay();
  }
  async function sendMsg(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      return null;
    }
  }
  async function resolveUsername() {
    const host = location.hostname.toLowerCase();
    if (host.endsWith(".imgbb.com") && host !== "www.imgbb.com") {
      const sub = host.slice(0, -".imgbb.com".length);
      if (sub && !sub.includes(".")) return sub;
    }
    if (/(^|\.)ibb\.co$/.test(host) && /^\/album\//i.test(location.pathname)) {
      const res = await sendMsg({
        type: "IMG_RESOLVE_USER",
        srcTabId: -1,
        albumUrl: location.href
      });
      if (res?.ok && res.username) return res.username;
    }
    return null;
  }
  function starSheet() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
    :host { all: initial; }
    .box {
      font: 12px/1.5 system-ui, "Microsoft YaHei", sans-serif;
      color: #e6e8ea;
      background: rgba(20, 22, 26, 0.94);
      border: 1px solid #3a3f46;
      border-radius: 8px;
      padding: 6px 8px;
      min-width: 132px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.45);
    }
    .head { display: flex; align-items: center; gap: 6px; cursor: move; user-select: none; }
    .user { color: #4a9eff; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 110px; }
    .spacer { flex: 1; }
    .icon { cursor: pointer; color: #8a8f97; padding: 0 2px; }
    .icon:hover { color: #e6e8ea; }
    .stars { display: flex; gap: 2px; margin-top: 4px; font-size: 16px; line-height: 1; }
    .star { cursor: pointer; color: #4a4f57; }
    .star.on { color: #e8c06a; }
    .star:hover { color: #ffc46b; }
    .meta { margin-top: 3px; color: #8a8f97; font-size: 11px; }
    .status { margin-top: 2px; color: #7bc47f; font-size: 11px; min-height: 14px; }
    .status.err { color: #e5646b; }
    .body.hidden { display: none; }
  `);
    return sheet;
  }
  async function initStarOverlay() {
    if (document.getElementById(HOST_ID)) return;
    const username = await resolveUsername();
    if (!username) return;
    const res = await sendMsg({ type: "IMG_DB_GET_STAR", username });
    if (!res?.ok || !res.starInfo) return;
    mount(username, res.starInfo);
  }
  function mount(username, info) {
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    try {
      shadow.adoptedStyleSheets = [starSheet()];
    } catch {
      const style = document.createElement("style");
      style.textContent = Array.from(starSheet().cssRules).map((r) => r.cssText).join("\n");
      shadow.appendChild(style);
    }
    const box = document.createElement("div");
    box.className = "box";
    const head = document.createElement("div");
    head.className = "head";
    const userEl = document.createElement("span");
    userEl.className = "user";
    userEl.textContent = `@${username}`;
    userEl.title = username;
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const foldEl = document.createElement("span");
    foldEl.className = "icon";
    foldEl.textContent = "\u2013";
    foldEl.title = "\u6298\u53E0 / \u5C55\u5F00";
    const closeEl = document.createElement("span");
    closeEl.className = "icon";
    closeEl.textContent = "\xD7";
    closeEl.title = "\u5173\u95ED\uFF08\u53EF\u5728\u6293\u53D6\u9875\u300C\u6807\u661F\u60AC\u6D6E\u7A97\u300D\u91CD\u65B0\u542F\u7528\uFF09";
    head.append(userEl, spacer, foldEl, closeEl);
    const body = document.createElement("div");
    body.className = "body";
    const starsEl = document.createElement("div");
    starsEl.className = "stars";
    const starEls = [];
    for (let i = 1; i <= MAX_STARS; i++) {
      const s = document.createElement("span");
      s.className = "star";
      s.dataset.v = String(i);
      s.title = `${i} \u661F`;
      starEls.push(s);
      starsEl.appendChild(s);
    }
    const metaEl = document.createElement("div");
    metaEl.className = "meta";
    const statusEl = document.createElement("div");
    statusEl.className = "status";
    body.append(starsEl, metaEl, statusEl);
    box.append(head, body);
    shadow.appendChild(box);
    document.documentElement.appendChild(host);
    let current = 0;
    let statusTimer = 0;
    function setStatus(text, isError = false) {
      statusEl.textContent = text;
      statusEl.classList.toggle("err", isError);
      window.clearTimeout(statusTimer);
      if (text) statusTimer = window.setTimeout(() => statusEl.textContent = "", 2500);
    }
    function render(next) {
      current = next.starRating;
      starEls.forEach((el) => {
        const v = Number(el.dataset.v) || 0;
        const on = v <= current;
        el.classList.toggle("on", on);
        el.textContent = on ? "\u2605" : "\u2606";
      });
      const parts = [`\u5165\u5EA6 ${next.inDegree}`];
      if (next.albumsChecked && next.albumCount !== void 0) parts.push(`\u76F8\u518C ${next.albumCount}`);
      if (!next.inLibrary) parts.push("\u672A\u5165\u5E93\uFF08\u6807\u661F\u81EA\u52A8\u5165\u5E93\uFF09");
      metaEl.textContent = parts.join(" \xB7 ");
    }
    render(info);
    async function apply(stars) {
      const res = await sendMsg({
        type: "IMG_DB_SET_STAR",
        username,
        stars,
        autoCreate: true
      });
      if (!res?.ok) {
        setStatus(`\u4FDD\u5B58\u5931\u8D25${res?.error ? "\uFF1A" + res.error : ""}`, true);
        return;
      }
      if (res.starInfo) render(res.starInfo);
      setStatus(stars > 0 ? `\u5DF2\u6807 ${stars} \u661F` : "\u5DF2\u53D6\u6D88\u661F\u7EA7");
    }
    starsEl.addEventListener("click", (ev) => {
      const el = ev.target.closest(".star");
      if (!el) return;
      const v = Number(el.dataset.v) || 0;
      if (v <= 0) return;
      void apply(current === v ? 0 : v);
    });
    const setCollapsed = (collapsed) => {
      body.classList.toggle("hidden", collapsed);
      foldEl.textContent = collapsed ? "+" : "\u2013";
    };
    foldEl.addEventListener("click", () => {
      const collapsed = !body.classList.contains("hidden");
      setCollapsed(collapsed);
      persist(collapsed);
    });
    closeEl.addEventListener("click", () => host.remove());
    function persist(collapsed) {
      const r = host.getBoundingClientRect();
      const payload = { x: Math.round(r.left), y: Math.round(r.top), collapsed };
      void storageSet(POS_KEY, payload);
    }
    let dragging = false;
    let offX = 0;
    let offY = 0;
    head.addEventListener("mousedown", (ev) => {
      const r = host.getBoundingClientRect();
      dragging = true;
      offX = ev.clientX - r.left;
      offY = ev.clientY - r.top;
      ev.preventDefault();
    });
    window.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - offX));
      const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY));
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      host.style.right = "auto";
      host.style.bottom = "auto";
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      persist(body.classList.contains("hidden"));
    });
    void storageGet(POS_KEY).then((pos) => {
      if (!pos) return;
      if (typeof pos.x === "number" && pos.x >= 0 && typeof pos.y === "number" && pos.y >= 0) {
        host.style.left = `${pos.x}px`;
        host.style.top = `${pos.y}px`;
        host.style.right = "auto";
        host.style.bottom = "auto";
      }
      if (pos.collapsed) setCollapsed(true);
    });
  }
})();
//# sourceMappingURL=star-overlay.js.map
