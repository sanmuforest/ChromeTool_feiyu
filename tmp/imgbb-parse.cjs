"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/lib/imgbb-parse.ts
var imgbb_parse_exports = {};
__export(imgbb_parse_exports, {
  extractAlbumId: () => extractAlbumId,
  extractUsername: () => extractUsername,
  isLoginWall: () => isLoginWall,
  matchFilenameNumber: () => matchFilenameNumber,
  parseAlbumItems: () => parseAlbumItems,
  parseImageItems: () => parseImageItems,
  parseUserItems: () => parseUserItems
});
module.exports = __toCommonJS(imgbb_parse_exports);
function extractAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}="([^"]*)"`));
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
  const next = html.slice(start).search(/<div class="list-item[^"]*"/);
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
function extractAlbumId(url) {
  const m = url.match(/ibb\.co\/album\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}
function matchFilenameNumber(filename, prefix) {
  if (!prefix) return null;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = filename.match(new RegExp(`^${escaped}(\\d+)`));
  return m ? Number(m[1]) : null;
}
