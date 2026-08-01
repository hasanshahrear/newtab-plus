/* New Tab+ — workspaces, tiles, folders.
   Vanilla JS, Manifest V3, iOS 26 design language.
   State lives in chrome.storage.local. */

"use strict";

/* ---------------- environment ---------------- */

const IS_EXT = typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);

/* Keys are a Chrome API contract: chrome.tabGroups.update() only accepts these
   names. Hex values are the iOS system palette; never rename the keys. */
const WS_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const WS_COLOR_HEX = {
  grey: "#8E8E93", blue: "#007AFF", red: "#FF3B30", yellow: "#FFCC00",
  green: "#34C759", pink: "#FF2D55", purple: "#AF52DE", cyan: "#32ADE6", orange: "#FF9500",
};

const DOC_PATTERNS = [
  /docs\.google\.com/, /sheets\.google\.com/, /drive\.google\.com/,
  /onedrive\.live\.com/, /sharepoint\.com/, /office\.com/, /officeapps\.live\.com/,
  /notion\.so/, /notion\.site/, /paper\.dropbox\.com/, /dropbox\.com\/(scl|s|home)/,
  /airtable\.com/, /coda\.io/,
  /\.pdf($|\?)/i, /\.xlsx?($|\?)/i, /\.docx?($|\?)/i, /\.pptx?($|\?)/i,
];

/* ---------------- state ---------------- */

let state = null;
let saveTimer = null;
let openFolderId = null;      // folder currently shown in overlay
let pendingPaste = null;      // {url, title, type} while paste card is open
let filterQuery = "";
let suppressStorageEcho = false;
let editMode = false;         // Home Screen jiggle mode
let liftedEl = null;          // tile floating above the blurred backdrop
let longPressAt = 0;          // timestamp, suppresses the click that follows
let swipeAt = 0;              // timestamp, suppresses the click after a swipe
let openSwipe = null;         // the one row currently showing its actions

function uid() {
  return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function defaultState() {
  return {
    version: 1,
    activeWs: null,
    workspaces: [
      {
        id: uid(), name: "Daily", color: "green",
        items: [
          { id: uid(), kind: "link", type: "app", title: "daily.dev", url: "https://app.daily.dev", addedAt: Date.now(), lastOpenedAt: null },
        ],
      },
      { id: uid(), name: "RMA", color: "purple", items: [] },
      { id: uid(), name: "ATS", color: "blue", items: [] },
    ],
  };
}

async function loadState() {
  if (IS_EXT) {
    const data = await chrome.storage.local.get("state");
    state = data.state || defaultState();
  } else {
    try { state = JSON.parse(localStorage.getItem("ntp-state")) || defaultState(); }
    catch { state = defaultState(); }
  }
  if (!state.activeWs || !state.workspaces.some((w) => w.id === state.activeWs)) {
    state.activeWs = state.workspaces[0].id;
  }
}

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (IS_EXT) {
      suppressStorageEcho = true;
      const fresh = await chrome.storage.local.get("state");
      if (fresh.state) mergeExternalAdditions(fresh.state);
      await chrome.storage.local.set({ state });
      setTimeout(() => { suppressStorageEcho = false; }, 250);
    } else {
      localStorage.setItem("ntp-state", JSON.stringify(state));
    }
  }, 150);
}

/* Carry over items added elsewhere (e.g. background.js's "Pin page" handler)
   while this page had a debounced save pending, so they aren't clobbered. */
function mergeExternalAdditions(remote) {
  const localIds = new Set();
  state.workspaces.forEach((ws) => ws.items.forEach((it) => {
    localIds.add(it.id);
    if (it.kind === "folder") it.items.forEach((x) => localIds.add(x.id));
  }));
  remote.workspaces.forEach((rws) => {
    const lws = state.workspaces.find((w) => w.id === rws.id);
    if (!lws) { state.workspaces.push(rws); return; }
    rws.items.forEach((rit) => {
      if (!localIds.has(rit.id)) lws.items.push(rit);
      if (rit.kind === "folder") {
        rit.items.forEach((rin) => { if (!localIds.has(rin.id)) lws.items.push(rin); });
      }
    });
  });
}

/* React when the background worker pins a page from another tab */
if (IS_EXT && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.state && !suppressStorageEcho) {
      state = changes.state.newValue;
      renderAll();
    }
  });
}

/* ---------------- helpers ---------------- */

const $ = (id) => document.getElementById(id);

function activeWs() {
  return state.workspaces.find((w) => w.id === state.activeWs) || state.workspaces[0];
}

function detectType(url) {
  return DOC_PATTERNS.some((re) => re.test(url)) ? "doc" : "app";
}

function faviconUrl(pageUrl, size = 64) {
  if (IS_EXT && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(`_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`);
  }
  return ""; // preview mode: letter avatar fallback
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return url; }
}

function timeAgo(ts) {
  if (!ts) return null;
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(ts).toLocaleDateString();
}

function itemMeta(item) {
  const kind = item.type === "doc" ? "Doc" : hostname(item.url);
  const t = item.lastOpenedAt
    ? `opened ${timeAgo(item.lastOpenedAt)}`
    : `added ${timeAgo(item.addedAt)}`;
  return `${kind} · ${t}`;
}

function findItem(id, ws = activeWs()) {
  for (const it of ws.items) {
    if (it.id === id) return { item: it, parent: ws.items };
    if (it.kind === "folder") {
      const inner = it.items.find((x) => x.id === id);
      if (inner) return { item: inner, parent: it.items, folder: it };
    }
  }
  return null;
}

function removeItemById(id, ws = activeWs()) {
  const found = findItem(id, ws);
  if (!found) return null;
  const idx = found.parent.indexOf(found.item);
  found.parent.splice(idx, 1);
  // dissolve folders that drop to one item
  if (found.folder && found.folder.items.length === 1) {
    const last = found.folder.items[0];
    const fIdx = ws.items.indexOf(found.folder);
    ws.items.splice(fIdx, 1, last);
    if (openFolderId === found.folder.id) closeFolder();
  } else if (found.folder && found.folder.items.length === 0) {
    const fIdx = ws.items.indexOf(found.folder);
    ws.items.splice(fIdx, 1);
    if (openFolderId === found.folder.id) closeFolder();
  }
  return found.item;
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2200);
}

function matchesFilter(item) {
  if (!filterQuery) return true;
  const q = filterQuery.toLowerCase();
  if (item.kind === "folder") {
    return item.name.toLowerCase().includes(q) ||
      item.items.some((x) => x.title.toLowerCase().includes(q));
  }
  return item.title.toLowerCase().includes(q) || (item.url || "").toLowerCase().includes(q);
}

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/* just-happened guard for clicks that follow a gesture */
function gestureJustEnded() {
  return Date.now() - longPressAt < 600 || Date.now() - swipeAt < 400;
}

/* ---------------- SF-style glyphs ---------------- */

const GLYPHS = {
  open:     "M5.5 11.5 L11.5 5.5 M11.5 5.5 H7.2 M11.5 5.5 V9.8",
  rename:   "M3.5 13.5 L4.6 10.4 L11.1 3.9 L13.1 5.9 L6.6 12.4 Z",
  app:      "M3 3 H8 V8 H3 Z M9.5 3 H14 V8 H9.5 Z M3 9.5 H8 V14 H3 Z M9.5 9.5 H14 V14 H9.5 Z",
  doc:      "M4.5 2.5 H10 L13.5 6 V14.5 H4.5 Z M10 2.5 V6 H13.5",
  move:     "M3.5 8.5 H12.5 M9 5 L12.5 8.5 L9 12",
  trash:    "M3.5 5.5 H13.5 M5.8 5.5 V13.5 H11.2 V5.5 M7 3.5 H10 V5.5 H7 Z",
  group:    "M2.5 5 H7 L8.5 7 H14.5 V13.5 H2.5 Z",
  edit:     "M8.5 2.5 L9.9 6.1 L13.5 7.5 L9.9 8.9 L8.5 12.5 L7.1 8.9 L3.5 7.5 L7.1 6.1 Z",
  sparkle:  "M6.5 2.5 L7.5 5.2 L10.2 6.2 L7.5 7.2 L6.5 9.9 L5.5 7.2 L2.8 6.2 L5.5 5.2 Z M12 8.5 L12.8 10.7 L15 11.5 L12.8 12.3 L12 14.5 L11.2 12.3 L9 11.5 L11.2 10.7 Z",
  ungroup:  "M2.5 8.5 H14.5 M8.5 2.5 V6 M8.5 11 V14.5",
  plus:     "M8.5 3.5 V13.5 M3.5 8.5 H13.5",
  grip:     "M6 4.5 H6.01 M6 8.5 H6.01 M6 12.5 H6.01 M11 4.5 H11.01 M11 8.5 H11.01 M11 12.5 H11.01",
};

/* Icon library offered in the Add / Customize card. Stroke paths on a 24² grid. */
const ICON_LIBRARY = {
  mail:     "M3 6.5h18v11H3z M3.4 7l8.6 5.8L20.6 7",
  calendar: "M4 6h16v14H4z M4 10.5h16 M8 3.2v4 M16 3.2v4",
  chat:     "M4 5h16v11h-8l-4 4v-4H4z",
  code:     "M9.5 8L5.5 12l4 4 M14.5 8l4 4-4 4",
  terminal: "M4 5h16v14H4z M7.5 10l2.8 2-2.8 2 M13 14h3.6",
  doc:      "M7 3h7l4 4v14H7z M14 3v4h4",
  folder:   "M3 6h6l2 2.5h10V19H3z",
  cloud:    "M7.5 18h9a3.5 3.5 0 10-1-6.9A5.2 5.2 0 007 18z",
  chart:    "M5 20v-6 M10 20V8 M15 20v-9.5 M20 20V5",
  bug:      "M9 9.5a3 3 0 016 0v4a3 3 0 01-6 0z M6 11H3.2 M20.8 11H18 M6 16H3.2 M20.8 16H18 M9.5 7L7.8 4.6 M14.5 7l1.7-2.4",
  rocket:   "M12 3.2c3 2 4.8 5.8 4.8 9.8L12 16.6l-4.8-3.6c0-4 1.8-7.8 4.8-9.8z M9 17l-1.8 3.8L12 19l4.8 1.8L15 17",
  star:     "M12 3.4l2.6 6.2 6.4.5-4.9 4.2 1.5 6.3L12 17.2l-5.6 3.4 1.5-6.3L3 10.1l6.4-.5z",
  heart:    "M12 20.2S4.8 15.6 4.8 10.6A3.7 3.7 0 0112 8a3.7 3.7 0 017.2 2.6c0 5-7.2 9.6-7.2 9.6z",
  bookmark: "M6.5 3h11v18l-5.5-4-5.5 4z",
  camera:   "M3 7.5h4L9 5.5h6l2 2h4v11H3z M12 16.2a3.4 3.4 0 100-6.8 3.4 3.4 0 000 6.8z",
  music:    "M9 18V6l10-2.2v12 M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z M19 15.8a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z",
  video:    "M3 6.5h12v11H3z M15 10.4l6-2.9v9l-6-2.9z",
  cart:     "M3 4.2h2.2l2.4 11h10l1.9-8H6 M9.4 19.4a1.1 1.1 0 100 2.2 1.1 1.1 0 000-2.2z M16.8 19.4a1.1 1.1 0 100 2.2 1.1 1.1 0 000-2.2z",
  card:     "M2.5 6h19v12h-19z M2.5 10.2h19",
  lock:     "M6 11h12v9.5H6z M9 11V8.2a3 3 0 016 0V11",
  gear:     "M12 9.4a2.6 2.6 0 100 5.2 2.6 2.6 0 000-5.2z M12 3v2.6 M12 18.4V21 M21 12h-2.6 M5.6 12H3 M18.4 5.6l-1.9 1.9 M7.5 16.5l-1.9 1.9 M18.4 18.4l-1.9-1.9 M7.5 7.5L5.6 5.6",
  search:   "M11 18.2a7.1 7.1 0 100-14.2 7.1 7.1 0 000 14.2z M16.2 16.2L21 21",
  globe:    "M12 21a9 9 0 100-18 9 9 0 000 18z M3.2 12h17.6 M12 3a14.5 14.5 0 000 18 14.5 14.5 0 000-18z",
  database: "M12 7.4c4.4 0 8-1.2 8-2.7S16.4 2 12 2 4 3.2 4 4.7s3.6 2.7 8 2.7z M4 4.7v14.6c0 1.5 3.6 2.7 8 2.7s8-1.2 8-2.7V4.7 M4 12c0 1.5 3.6 2.7 8 2.7s8-1.2 8-2.7",
  bell:     "M18 15.2V10a6 6 0 10-12 0v5.2L4.2 18h15.6z M10 21h4",
  clock:    "M12 21a9 9 0 100-18 9 9 0 000 18z M12 6.8V12l3.2 2.2",
  map:      "M9 4L3 6.2v14L9 18l6 2.2 6-2.2v-14L15 6.2z M9 4v14 M15 6.2v14",
  flag:     "M5 21V3.6 M5 4.8h13l-2.6 4.1 2.6 4.1H5",
  shield:   "M12 3l8 3v6.2c0 4.5-3.3 8.4-8 9.6-4.7-1.2-8-5.1-8-9.6V6z",
  box:      "M3 8l9-4.2L21 8v9l-9 4.2L3 17z M3.4 8.2l8.6 4 8.6-4 M12 12.2V21",
  users:    "M9.2 12.4a3.6 3.6 0 100-7.2 3.6 3.6 0 000 7.2z M2.4 20.4a6.8 6.8 0 0113.6 0 M16.8 5.6a3.4 3.4 0 010 6.8 M17.4 14.2a6.2 6.2 0 014.2 6.2",
  link:     "M10.2 13.8a4.2 4.2 0 006 0l3-3a4.2 4.2 0 00-6-6l-1 1 M13.8 10.2a4.2 4.2 0 00-6 0l-3 3a4.2 4.2 0 006 6l1-1",
};
const ICON_NAMES = Object.keys(ICON_LIBRARY);

/* An icon-library glyph sized for a tile / row plate. */
function libGlyph(name, cls = "tile-glyph") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", ICON_LIBRARY[name] || "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "1.7");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  return svg;
}

function glyph(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 17 17");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", GLYPHS[name] || "");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", name === "grip" ? "2.4" : "1.5");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  return svg;
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 9 15");
  svg.setAttribute("class", "row-chevron");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", "M1.6 1.6 L7 7.5 L1.6 13.4");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linecap", "round");
  p.setAttribute("stroke-linejoin", "round");
  svg.appendChild(p);
  return svg;
}

/* ---------------- long press ---------------- */

function wireLongPress(el, fn, delay = 450) {
  let timer = null, sx = 0, sy = 0;
  const clear = () => { clearTimeout(timer); timer = null; };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    sx = e.clientX; sy = e.clientY;
    const target = e.target;
    clear();
    timer = setTimeout(() => {
      timer = null;
      longPressAt = Date.now();
      fn({ clientX: sx, clientY: sy, target });
    }, delay);
  });
  el.addEventListener("pointermove", (e) => {
    if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) clear();
  });
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener("dragstart", clear);
}

function liftFor(el) {
  clearLift();
  liftedEl = el;
  el.classList.add("lifted");
  $("liftBackdrop").hidden = false;
}

function clearLift() {
  if (liftedEl) liftedEl.classList.remove("lifted");
  liftedEl = null;
  $("liftBackdrop").hidden = true;
}

/* ---------------- swipe actions ---------------- */

/* Builds the row scaffold: an overflow-clipped wrapper, the reveal areas, and a
   translating content div. Returns the pieces so callers fill in the content. */
function swipeScaffold(rowClass, leading, trailing) {
  const wrap = document.createElement("div");
  wrap.className = `swipe ${rowClass}`;

  const mk = (side, action) => {
    if (!action) return null;
    const box = document.createElement("div");
    box.className = `swipe-actions ${side}`;
    const btn = document.createElement("button");
    btn.className = `swipe-action ${action.danger ? "destructive" : "neutral"}`;
    btn.textContent = action.label;
    btn.addEventListener("click", (e) => { e.stopPropagation(); action.fn(); });
    box.appendChild(btn);
    wrap.appendChild(box);
    return box;
  };
  const leadBox = mk("leading", leading);
  const trailBox = mk("trailing", trailing);

  const content = document.createElement("div");
  content.className = "swipe-content";
  wrap.appendChild(content);

  wireSwipe(wrap, content, { leadBox, trailBox, leading, trailing });
  return { wrap, content };
}

function wireSwipe(wrap, content, cfg) {
  let sx = 0, sy = 0, dx = 0, axis = null, dragging = false, open = 0;
  let leadW = 0, trailW = 0;

  const setX = (x, animate) => {
    content.style.transition = animate && !reducedMotion()
      ? "transform .3s cubic-bezier(.32,.72,0,1)" : "none";
    content.style.transform = `translateX(${x}px)`;
    // reveal only the side being pulled open
    if (x < 0) wrap.dataset.dir = "trail";
    else if (x > 0) wrap.dataset.dir = "lead";
    else delete wrap.dataset.dir;
  };
  const api = {
    close() {
      open = 0; dx = 0;
      setX(0, true);
      wrap.classList.remove("swiping", "open");
      if (openSwipe === api) openSwipe = null;
    },
    isOpen: () => open !== 0,
  };

  content.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (openSwipe && openSwipe !== api) openSwipe.close();
    sx = e.clientX; sy = e.clientY; axis = null; dragging = true;
    leadW = cfg.leadBox ? cfg.leadBox.offsetWidth : 0;
    trailW = cfg.trailBox ? cfg.trailBox.offsetWidth : 0;
  });

  content.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const ddx = e.clientX - sx, ddy = e.clientY - sy;
    if (!axis) {
      if (Math.abs(ddx) > 8 && Math.abs(ddx) > Math.abs(ddy)) {
        axis = "x";
        wrap.classList.add("swiping");
      } else if (Math.abs(ddy) > 8) axis = "y";
      else return;
    }
    if (axis !== "x") return;
    let x = open + ddx;
    if (x > 0) x = leadW ? (x > leadW ? leadW + (x - leadW) * 0.3 : x) : x * 0.15;
    if (x < 0) x = trailW ? (x < -trailW ? -trailW + (x + trailW) * 0.3 : x) : x * 0.15;
    dx = x;
    setX(x, false);
  });

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (axis !== "x") return;
    swipeAt = Date.now();
    const full = wrap.offsetWidth * 0.4;
    if (dx <= -full && cfg.trailing) { api.close(); cfg.trailing.fn(); return; }
    if (dx >= full && cfg.leading) { api.close(); cfg.leading.fn(); return; }
    if (trailW && dx < -trailW * 0.5) open = -trailW;
    else if (leadW && dx > leadW * 0.5) open = leadW;
    else open = 0;
    setX(open, true);
    wrap.classList.toggle("open", open !== 0);
    wrap.classList.remove("swiping");
    openSwipe = open ? api : (openSwipe === api ? null : openSwipe);
  };
  content.addEventListener("pointerup", finish);
  content.addEventListener("pointercancel", finish);
  content.addEventListener("pointerleave", (e) => { if (dragging && e.pointerType === "mouse") finish(); });

  return api;
}

/* Reordering lives on an explicit grip so a horizontal drag is unambiguously a
   swipe. Native HTML5 drag is enabled only while the grip is held. */
function addGrip(rowEl, content) {
  const grip = document.createElement("button");
  grip.className = "row-grip";
  grip.setAttribute("aria-label", "Reorder");
  grip.appendChild(glyph("grip"));
  grip.addEventListener("click", (e) => e.stopPropagation());
  grip.addEventListener("pointerdown", (e) => { e.stopPropagation(); rowEl.draggable = true; });
  grip.addEventListener("pointerup", () => { setTimeout(() => { rowEl.draggable = false; }, 0); });
  rowEl.addEventListener("dragend", () => { rowEl.draggable = false; });
  content.appendChild(grip);
  return grip;
}

/* ---------------- open behaviour ---------------- */

function openLink(item, newTab = false) {
  if (editMode) return;
  item.lastOpenedAt = Date.now();
  saveState();
  if (newTab) window.open(item.url, "_blank");
  else window.location.href = item.url;
}

async function openFolderAsGroup(folder) {
  const links = folder.items.filter((x) => x.kind === "link");
  if (links.length === 0) return;
  links.forEach((l) => { l.lastOpenedAt = Date.now(); });
  saveState();

  if (IS_EXT && chrome.tabs && chrome.tabs.group) {
    const created = [];
    for (const l of links) {
      const t = await chrome.tabs.create({ url: l.url, active: false });
      created.push(t.id);
    }
    const groupId = await chrome.tabs.group({ tabIds: created });
    const color = activeWs().color || "grey";
    try {
      await chrome.tabGroups.update(groupId, { title: folder.name, color });
    } catch { /* color name mismatch fallback */ }
    toast(`Opened ${links.length} tabs as “${folder.name}”`);
  } else {
    links.forEach((l) => window.open(l.url, "_blank"));
  }
}

/* ---------------- rendering ---------------- */

function renderAll() {
  renderHeader();
  renderSwitcher();
  renderDots();
  renderCanvas();
  if (openFolderId) renderFolderOverlay();
}

function renderHeader() {
  const ws = activeWs();
  // don't destroy an in-progress rename if a background save echoes a re-render
  if (!$("wsTitle").querySelector("input")) $("wsTitle").textContent = ws.name;
  const n = totalCount(ws);
  $("wsSub").textContent = n === 0 ? "No items yet" : `${n} item${n === 1 ? "" : "s"}`;
  document.documentElement.style.setProperty("--ws-tint", WS_COLOR_HEX[ws.color] || WS_COLOR_HEX.grey);
}

/* Rename the workspace straight from the big title: double-click (or Enter
   when focused) swaps the heading for an input, keeping the h1 semantics. */
function startTitleRename() {
  if (!state) return;
  const h1 = $("wsTitle");
  if (h1.querySelector("input")) return;
  const ws = activeWs();
  const input = document.createElement("input");
  input.className = "large-title-input";
  input.value = ws.name;
  input.setAttribute("aria-label", "Workspace name");
  h1.textContent = "";
  h1.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    ws.name = input.value.trim().slice(0, 40) || ws.name;
    saveState();
    renderAll();
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = ws.name; input.blur(); }
    e.stopPropagation();
  });
}

$("wsTitle").addEventListener("dblclick", startTitleRename);
$("wsTitle").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.target.closest("input")) {
    e.preventDefault();
    startTitleRename();
  }
});

/* The documents section heading is per-workspace and renameable in place. */
$("docsLabel").addEventListener("change", () => {
  if (!state) return;
  const v = $("docsLabel").value.trim().slice(0, 40);
  activeWs().docsLabel = v || "Documents";
  $("docsLabel").value = activeWs().docsLabel;
  saveState();
});
$("docsLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") e.target.blur();
  if (e.key === "Escape") { e.target.value = activeWs().docsLabel || "Documents"; e.target.blur(); }
  e.stopPropagation();
});

function totalCount(ws) {
  return ws.items.reduce((n, it) => n + (it.kind === "folder" ? it.items.length : 1), 0);
}

function renderSwitcher() {
  const bar = $("wsTabs");
  bar.innerHTML = "";
  let activeTab = null;
  state.workspaces.forEach((ws, i) => {
    const tab = document.createElement("button");
    tab.className = "ws-tab" + (ws.id === state.activeWs ? " active" : "");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", ws.id === state.activeWs ? "true" : "false");
    tab.dataset.ws = ws.id;
    tab.title = `${ws.name} — press ${i + 1}`;

    const dot = document.createElement("span");
    dot.className = "ws-dot";
    dot.style.background = WS_COLOR_HEX[ws.color] || WS_COLOR_HEX.grey;
    tab.appendChild(dot);

    const label = document.createElement("span");
    label.textContent = ws.name;
    tab.appendChild(label);

    const count = totalCount(ws);
    if (count > 0) {
      const badge = document.createElement("span");
      badge.className = "ws-count";
      badge.textContent = count;
      tab.appendChild(badge);
    }

    tab.addEventListener("click", () => {
      if (gestureJustEnded()) return;
      switchWorkspace(ws.id, 0);
    });
    tab.addEventListener("dblclick", () => startWsRename(tab, ws, label));
    tab.addEventListener("contextmenu", (e) => { e.preventDefault(); showWsMenu(e, ws); });
    wireLongPress(tab, (pt) => showWsMenu(pt, ws));

    // drop target: move item into this workspace
    tab.addEventListener("dragover", (e) => {
      e.preventDefault();
      tab.classList.add("droptarget");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("droptarget"));
    tab.addEventListener("drop", (e) => {
      e.preventDefault();
      tab.classList.remove("droptarget");
      const id = e.dataTransfer.getData("text/ntp-item");
      if (!id || ws.id === state.activeWs) return;
      const moved = removeItemById(id);
      if (moved) {
        ws.items.push(moved);
        saveState();
        renderAll();
        toast(`Moved to ${ws.name}`);
      }
    });

    if (ws.id === state.activeWs) activeTab = tab;
    bar.appendChild(tab);
  });

  // keep the selected workspace visible when switching by key, dot or swipe
  if (activeTab && bar.scrollWidth > bar.clientWidth) {
    activeTab.scrollIntoView({
      inline: "center",
      block: "nearest",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
  }
}

function renderDots() {
  const dots = $("wsDots");
  dots.innerHTML = "";
  if (state.workspaces.length < 2) return;
  state.workspaces.forEach((ws) => {
    const dot = document.createElement("button");
    dot.className = "dot" + (ws.id === state.activeWs ? " active" : "");
    dot.setAttribute("role", "tab");
    dot.setAttribute("aria-label", ws.name);
    dot.setAttribute("aria-selected", ws.id === state.activeWs ? "true" : "false");
    dot.addEventListener("click", () => switchWorkspace(ws.id, 0));
    dots.appendChild(dot);
  });
}

function startWsRename(tab, ws, label) {
  const input = document.createElement("input");
  input.className = "ws-rename";
  input.value = ws.name;
  label.replaceWith(input);
  input.focus();
  input.select();
  const done = () => {
    ws.name = input.value.trim() || ws.name;
    saveState();
    renderAll();
  };
  input.addEventListener("blur", done);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
    if (e.key === "Escape") { input.value = ws.name; input.blur(); }
    e.stopPropagation();
  });
}

function renderCanvas() {
  const ws = activeWs();
  const grid = $("grid");
  const docs = $("docs");
  grid.innerHTML = "";
  docs.innerHTML = "";
  grid.classList.toggle("editing", editMode);
  $("editDone").hidden = !editMode;

  const gridItems = ws.items.filter((it) => it.kind === "folder" || it.type === "app");
  const docItems = ws.items.filter((it) => it.kind === "link" && it.type === "doc");

  gridItems.forEach((it, i) => {
    const tile = it.kind === "folder" ? folderTile(it) : appTile(it);
    tile.style.setProperty("--i", i);
    grid.appendChild(tile);
  });
  grid.appendChild(addTile());

  docItems.forEach((it) => docs.appendChild(docRow(it)));

  if (document.activeElement !== $("docsLabel")) {
    $("docsLabel").value = ws.docsLabel || "Documents";
  }
  $("docsSection").hidden = docItems.length === 0;
  $("empty").hidden = ws.items.length !== 0;
  $("footHint").hidden = ws.items.length === 0;
}

function letterAvatar(text, cls = "tile-letter") {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = (text || "?").trim().charAt(0).toUpperCase();
  return el;
}

/* Real site logos, cheapest and most private source first:
   1. the browser's own favicon cache (local, no network, extension only)
   2. the site's own /apple-touch-icon.png, then /favicon.ico — a request to a
      site the user deliberately saved, never a third-party favicon service
   3. a letter avatar
   Each step is wired to the previous one's error event. */
function siteIconSources(pageUrl) {
  const list = [];
  const ext = faviconUrl(pageUrl, 64);
  if (ext) list.push(ext);
  try {
    const { origin } = new URL(pageUrl);
    list.push(`${origin}/apple-touch-icon.png`, `${origin}/favicon.ico`);
  } catch { /* not a parseable URL — letter avatar will cover it */ }
  return list;
}

function faviconImg(url, cls, size = 64, fallbackLabel) {
  const sources = siteIconSources(url);
  if (!sources.length) return null;
  const img = document.createElement("img");
  if (cls) img.className = cls;
  img.alt = "";
  img.loading = "lazy";
  let i = 0;
  img.src = sources[0];
  img.addEventListener("error", () => {
    i += 1;
    if (i < sources.length) img.src = sources[i];
    // fall back to the item's own name, not the hostname: "Gmail" → G, not M
    else img.replaceWith(letterAvatar(fallbackLabel || hostname(url)));
  });
  return img;
}

/* The visual for an item: custom library icon > site logo > letter. */
function itemVisual(item, cls = "tile-favicon") {
  if (item.icon && ICON_LIBRARY[item.icon]) return libGlyph(item.icon);
  return faviconImg(item.url, cls, 64, item.title) || letterAvatar(item.title);
}

/* Paints a plate in the item's chosen colour, if it has one. */
function applyTint(plate, item) {
  const hex = item.tint && WS_COLOR_HEX[item.tint];
  if (!hex) return;
  plate.classList.add("tinted");
  plate.style.setProperty("--tile-tint", hex);
}

function wirePress(tile) {
  const off = () => tile.classList.remove("pressed");
  tile.addEventListener("pointerdown", () => tile.classList.add("pressed"));
  tile.addEventListener("pointerup", off);
  tile.addEventListener("pointerleave", off);
  tile.addEventListener("pointercancel", off);
  tile.addEventListener("dragstart", off);
}

function deleteBadge(item, isFolder) {
  const badge = document.createElement("button");
  badge.className = "tile-badge";
  badge.textContent = "−";
  badge.setAttribute("aria-label", `Remove ${isFolder ? item.name : item.title}`);
  badge.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isFolder) {
      const n = item.items.length;
      if (n > 0 && !confirm(`Delete “${item.name}” and its ${n} item${n === 1 ? "" : "s"}?`)) return;
      const ws = activeWs();
      const idx = ws.items.indexOf(item);
      if (idx > -1) ws.items.splice(idx, 1);
    } else {
      removeItemById(item.id);
    }
    saveState();
    renderAll();
  });
  return badge;
}

function appTile(item) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.id = item.id;
  tile.draggable = true;
  if (!matchesFilter(item)) tile.classList.add("hidden-by-filter");

  const box = document.createElement("div");
  box.className = "tile-box";
  applyTint(box, item);
  box.appendChild(itemVisual(item));
  if (editMode) box.appendChild(deleteBadge(item, false));
  tile.appendChild(box);

  const label = document.createElement("p");
  label.className = "tile-label";
  label.textContent = item.title;
  label.title = item.title;
  tile.appendChild(label);

  tile.addEventListener("click", (e) => {
    if (gestureJustEnded()) return;
    openLink(item, e.metaKey || e.ctrlKey);
  });
  tile.addEventListener("contextmenu", (e) => { e.preventDefault(); showItemMenu(e, item); });
  wireLongPress(tile, (pt) => { liftFor(tile); showItemMenu(pt, item); });
  wirePress(tile);
  wireDrag(tile, item);
  return tile;
}

function folderTile(folder) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.id = folder.id;
  tile.dataset.folder = "1";
  tile.draggable = true;
  if (!matchesFilter(folder)) tile.classList.add("hidden-by-filter");

  const box = document.createElement("div");
  box.className = "tile-box";

  const docCount = folder.items.filter((x) => x.type === "doc").length;
  const listMode = docCount > folder.items.length / 2;

  if (listMode) {
    const list = document.createElement("div");
    list.className = "folder-preview-list";
    folder.items.slice(0, 3).forEach((x) => {
      const line = document.createElement("div");
      line.className = "fp-line";
      line.textContent = x.title;
      list.appendChild(line);
    });
    if (folder.items.length > 3) {
      const more = document.createElement("div");
      more.className = "fp-more";
      more.textContent = `+${folder.items.length - 3} more`;
      list.appendChild(more);
    }
    box.appendChild(list);
  } else {
    const gridPrev = document.createElement("div");
    gridPrev.className = "folder-preview-grid";
    folder.items.slice(0, 3).forEach((x) => {
      const cell = document.createElement("div");
      cell.className = "fp-cell";
      applyTint(cell, x);
      if (x.icon && ICON_LIBRARY[x.icon]) cell.appendChild(libGlyph(x.icon, "fp-glyph"));
      else {
        const img = faviconImg(x.url, "", 32, x.title);
        if (img) cell.appendChild(img);
        else cell.textContent = (x.title || "?").charAt(0).toUpperCase();
      }
      gridPrev.appendChild(cell);
    });
    if (folder.items.length > 3) {
      const cell = document.createElement("div");
      cell.className = "fp-cell";
      cell.textContent = `+${folder.items.length - 3}`;
      gridPrev.appendChild(cell);
    }
    box.appendChild(gridPrev);
  }
  if (editMode) box.appendChild(deleteBadge(folder, true));
  tile.appendChild(box);

  const label = document.createElement("p");
  label.className = "tile-label";
  label.textContent = folder.name;
  label.title = folder.name;
  tile.appendChild(label);

  tile.addEventListener("click", () => {
    if (gestureJustEnded() || editMode) return;
    showFolder(folder.id);
  });
  tile.addEventListener("contextmenu", (e) => { e.preventDefault(); showFolderMenu(e, folder); });
  wireLongPress(tile, (pt) => { liftFor(tile); showFolderMenu(pt, folder); });
  wirePress(tile);
  wireDrag(tile, folder);
  return tile;
}

function addTile() {
  const tile = document.createElement("div");
  tile.className = "tile add";
  const box = document.createElement("div");
  box.className = "tile-box";
  box.textContent = "+";
  tile.appendChild(box);
  const label = document.createElement("p");
  label.className = "tile-label";
  label.textContent = "Add";
  tile.appendChild(label);
  tile.addEventListener("click", promptForLink);
  wirePress(tile);
  return tile;
}

async function promptForLink() {
  let url = "";
  try {
    const clip = await navigator.clipboard.readText();
    if (/^https?:\/\//i.test(clip.trim())) url = clip.trim();
  } catch { /* clipboard permission denied — fall through */ }
  if (!url) url = prompt("Paste or type a URL to add:") || "";
  url = url.trim();
  if (/^https?:\/\//i.test(url)) beginPasteFlow(url);
  else if (url) toast("That doesn't look like a link");
}

/* A document row in the inset grouped list. Swipe left to remove. */
function docRow(item) {
  const { wrap, content } = swipeScaffold("doc-row", null, {
    label: "Remove", danger: true,
    fn: () => { removeItemById(item.id); saveState(); renderAll(); },
  });
  wrap.dataset.id = item.id;
  if (!matchesFilter(item)) wrap.classList.add("hidden-by-filter");

  const icon = document.createElement("div");
  icon.className = "row-icon";
  applyTint(icon, item);
  icon.appendChild(itemVisual(item, ""));
  content.appendChild(icon);

  const text = document.createElement("div");
  text.className = "row-text";
  const title = document.createElement("p");
  title.className = "row-title";
  title.textContent = item.title;
  title.title = item.title;
  const meta = document.createElement("p");
  meta.className = "row-meta";
  meta.textContent = itemMeta(item);
  text.appendChild(title);
  text.appendChild(meta);
  content.appendChild(text);

  addGrip(wrap, content);
  content.appendChild(chevron());

  content.addEventListener("click", (e) => {
    if (gestureJustEnded()) return;
    if (openSwipe) { openSwipe.close(); return; }
    openLink(item, e.metaKey || e.ctrlKey);
  });
  wrap.addEventListener("contextmenu", (e) => { e.preventDefault(); showItemMenu(e, item); });
  wireLongPress(content, (pt) => showItemMenu(pt, item));
  wireDrag(wrap, item);
  return wrap;
}

/* ---------------- drag & drop ---------------- */

function wireDrag(el, item) {
  el.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/ntp-item", item.id);
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  el.addEventListener("dragend", () => {
    el.classList.remove("dragging");
    clearDropHints();
  });

  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    clearDropHints();
    // inside an open folder, items can only be reordered — folders can't nest
    if (el.classList.contains("folder-row")) {
      el.classList.add(x <= 0.5 ? "reorder-before" : "reorder-after");
    } else if (x > 0.3 && x < 0.7) el.classList.add("merge-target");
    else if (x <= 0.3) el.classList.add("reorder-before");
    else el.classList.add("reorder-after");
  });
  el.addEventListener("dragleave", () => {
    el.classList.remove("merge-target", "reorder-before", "reorder-after");
  });

  el.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const draggedId = e.dataTransfer.getData("text/ntp-item");
    const mode = el.classList.contains("merge-target")
      ? "merge"
      : el.classList.contains("reorder-before") ? "before" : "after";
    clearDropHints();
    if (!draggedId || draggedId === item.id) return;
    handleDrop(draggedId, item, mode);
  });
}

function clearDropHints() {
  document.querySelectorAll(".merge-target, .reorder-before, .reorder-after")
    .forEach((n) => n.classList.remove("merge-target", "reorder-before", "reorder-after"));
}

function handleDrop(draggedId, target, mode) {
  const ws = activeWs();

  // Find the list the target currently lives in: the workspace's top level,
  // or an open folder's items (folder rows reorder in place).
  let targetList = ws.items;
  if (!targetList.includes(target)) {
    const parentFolder = ws.items.find((it) => it.kind === "folder" && it.items.includes(target));
    if (parentFolder) targetList = parentFolder.items;
  }

  // Reordering within that same list: splice in place. Routing this through
  // removeItemById (below) would trip its folder-dissolve-at-1-item cleanup
  // when the dragged item and target are the only two links left in a folder.
  const sameListIdx = targetList.findIndex((x) => x.id === draggedId);
  if (sameListIdx !== -1 && mode !== "merge") {
    const [dragged] = targetList.splice(sameListIdx, 1);
    let tIdx = targetList.indexOf(target);
    if (mode === "after") tIdx += 1;
    targetList.splice(tIdx, 0, dragged);
    saveState();
    renderAll();
    return;
  }

  const dragged = removeItemById(draggedId);
  if (!dragged) return;

  if (mode === "merge") {
    if (target.kind === "folder") {
      if (dragged.kind === "folder") target.items.push(...dragged.items);
      else target.items.push(dragged);
      toast(`Added to “${target.name}”`);
    } else if (dragged.kind === "folder") {
      // dropping a folder onto a link: absorb the link into the folder, in place
      const tIdx = targetList.indexOf(target);
      targetList.splice(tIdx, 1);
      dragged.items.push(target);
      targetList.splice(tIdx, 0, dragged);
      toast(`Added to “${dragged.name}”`);
    } else {
      // two links → new folder
      const tIdx = targetList.indexOf(target);
      const folder = {
        id: uid(), kind: "folder",
        name: suggestFolderName(target, dragged),
        items: [target, dragged],
      };
      targetList.splice(tIdx, 1, folder);
      toast(`Folder “${folder.name}” created — long-press to rename`);
    }
  } else {
    // moving into a different list (e.g. out of/into a folder), reordered in place
    let tIdx = targetList.indexOf(target);
    if (tIdx === -1) { targetList.push(dragged); }
    else {
      if (mode === "after") tIdx += 1;
      targetList.splice(tIdx, 0, dragged);
    }
  }
  saveState();
  renderAll();
}

function suggestFolderName(a, b) {
  const ha = hostname(a.url || ""), hb = hostname(b.url || "");
  if (ha && ha === hb) {
    const base = ha.split(".")[0];
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
  if (a.type === "doc" && b.type === "doc") return "Documents";
  return "New folder";
}

/* ---------------- workspace switching ---------------- */

function switchWorkspace(id, dir = 0) {
  if (!state || id === state.activeWs) return;
  state.activeWs = id;
  saveState();
  const c = $("canvas");
  if (dir && !reducedMotion()) {
    c.style.transition = "none";
    c.style.transform = `translateX(${dir * 26}px)`;
    c.style.opacity = "0";
    renderAll();
    requestAnimationFrame(() => {
      c.style.transition = "";
      c.style.transform = "";
      c.style.opacity = "";
    });
  } else {
    renderAll();
  }
}

function stepWorkspace(delta) {
  const i = state.workspaces.findIndex((w) => w.id === state.activeWs);
  const next = state.workspaces[i + delta];
  if (next) switchWorkspace(next.id, delta);
}

function isEmptyCanvasTarget(t) {
  return t === $("canvas") || t === $("grid") || t === $("empty") ||
    t === $("docsSection") || (t && t.classList && t.classList.contains("empty-sub"));
}

/* trackpad / wheel horizontal swipe */
let wheelLock = 0;
$("canvas").addEventListener("wheel", (e) => {
  if (!state || editMode || openFolderId) return;
  if (Math.abs(e.deltaX) < 24 || Math.abs(e.deltaX) < Math.abs(e.deltaY)) return;
  if (Date.now() < wheelLock) return;
  wheelLock = Date.now() + 420;
  stepWorkspace(e.deltaX > 0 ? 1 : -1);
}, { passive: true });

/* pointer swipe across empty canvas space */
let canvasDrag = null;
$("canvas").addEventListener("pointerdown", (e) => {
  if (!state || editMode || !isEmptyCanvasTarget(e.target)) { canvasDrag = null; return; }
  canvasDrag = { x: e.clientX, y: e.clientY };
});
document.addEventListener("pointerup", (e) => {
  if (!canvasDrag) return;
  const dx = e.clientX - canvasDrag.x, dy = e.clientY - canvasDrag.y;
  canvasDrag = null;
  if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) stepWorkspace(dx < 0 ? 1 : -1);
});

/* long-press empty space → Home Screen menu */
wireLongPress($("canvas"), (pt) => {
  if (!state || !isEmptyCanvasTarget(pt.target)) return;
  showCanvasMenu(pt);
});

/* ---------------- edit mode ---------------- */

function enterEditMode() {
  editMode = true;
  renderCanvas();
}

function exitEditMode() {
  editMode = false;
  renderCanvas();
}

$("editDone").addEventListener("click", exitEditMode);

/* ---------------- folder overlay ---------------- */

function showFolder(id) {
  openFolderId = id;
  renderFolderOverlay();
  $("folderOverlay").hidden = false;
}

function closeFolder() {
  openFolderId = null;
  $("folderOverlay").hidden = true;
}

function currentFolder() {
  return activeWs().items.find((x) => x.id === openFolderId && x.kind === "folder") || null;
}

function renderFolderOverlay() {
  const folder = currentFolder();
  if (!folder) { closeFolder(); return; }

  const nameInput = $("folderName");
  nameInput.value = folder.name;
  nameInput.onchange = () => {
    folder.name = nameInput.value.trim() || folder.name;
    saveState();
    renderAll();
  };
  $("folderCount").textContent = `${folder.items.length} item${folder.items.length === 1 ? "" : "s"}`;

  const list = $("folderList");
  list.innerHTML = "";
  folder.items.forEach((item) => {
    const moveOut = () => {
      const moved = removeItemById(item.id);
      if (moved) activeWs().items.push(moved);
      saveState();
      renderAll();
      toast(`Moved to ${activeWs().name}`);
    };
    const remove = () => { removeItemById(item.id); saveState(); renderAll(); };

    const { wrap, content } = swipeScaffold(
      "folder-row",
      { label: "Move out", fn: moveOut },
      { label: "Remove", danger: true, fn: remove },
    );
    wrap.dataset.id = item.id;

    const icon = document.createElement("div");
    icon.className = "row-icon";
    applyTint(icon, item);
    icon.appendChild(itemVisual(item, ""));
    content.appendChild(icon);

    const text = document.createElement("div");
    text.className = "row-text";
    const t = document.createElement("p");
    t.className = "row-title";
    t.textContent = item.title;
    const m = document.createElement("p");
    m.className = "row-meta";
    m.textContent = itemMeta(item);
    text.appendChild(t);
    text.appendChild(m);
    content.appendChild(text);

    addGrip(wrap, content);
    content.appendChild(chevron());

    content.addEventListener("click", (e) => {
      if (gestureJustEnded()) return;
      if (openSwipe) { openSwipe.close(); return; }
      openLink(item, e.metaKey || e.ctrlKey);
    });

    // keyboard/mouse parity for the swipe actions
    const rowMenu = (e) => {
      e.preventDefault?.();
      showMenu(e, [
        { label: "Open in new tab", glyph: "open", fn: () => openLink(item, true) },
        { label: "Move out of folder", glyph: "move", fn: moveOut },
        "-",
        { label: "Remove", glyph: "trash", danger: true, fn: remove },
      ]);
    };
    wrap.addEventListener("contextmenu", rowMenu);
    wireLongPress(content, rowMenu);

    wireDrag(wrap, item);
    list.appendChild(wrap);
  });

  $("folderOpenAll").onclick = () => openFolderAsGroup(folder);
}

$("folderClose").addEventListener("click", closeFolder);
$("folderOverlay").addEventListener("click", (e) => {
  if (e.target === $("folderOverlay")) closeFolder();
});

/* ---------------- paste-to-add flow ---------------- */

document.addEventListener("paste", (e) => {
  if (!state) return;                                  // still loading
  if (!$("pasteOverlay").hidden) return;               // card already open
  if (e.target.tagName === "INPUT") return;            // typing in a field
  const text = (e.clipboardData || window.clipboardData).getData("text").trim();
  if (/^https?:\/\//i.test(text)) {
    e.preventDefault();
    beginPasteFlow(text);
  }
});

function beginPasteFlow(url) {
  pendingPaste = { url, title: hostname(url), type: detectType(url), tint: null, icon: null };
  openCard(url);

  fetchTitle(url).then((title) => {
    if (!pendingPaste || pendingPaste.url !== url || !title) return;
    // Only overwrite if the user hasn't typed a custom title yet
    if ($("pasteTitle").value === pendingPaste.title) {
      $("pasteTitle").value = title;
      $("pasteTitle").select();
    }
    pendingPaste.fetchedTitle = title;
  });
}

async function fetchTitle(url) {
  if (!IS_EXT) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit" });
    clearTimeout(t);
    const html = await res.text();
    const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (m && m[1]) {
      const el = document.createElement("textarea");
      el.innerHTML = m[1];
      return el.value.trim().slice(0, 120) || null;
    }
  } catch { /* private docs, CORS-free fetch failed, or timeout */ }
  return null;
}

/* Opens the Add / Customize card and builds its colour + icon pickers. */
function openCard(url) {
  $("pasteUrl").textContent = url;
  $("pasteTitle").value = pendingPaste.title;
  setSeg(pendingPaste.type);
  buildTintRow();
  buildIconRow();
  renderCardPreview();
  $("pasteAdd").textContent = pendingPaste.editId ? "Save" : "Add";
  $("pasteOverlay").hidden = false;
  $("pasteTitle").focus();
  $("pasteTitle").select();
}

/* Live preview of exactly what the tile will look like. */
function renderCardPreview() {
  const box = $("pastePreview");
  box.innerHTML = "";
  box.className = "paste-preview tile-box";
  box.style.removeProperty("--tile-tint");
  applyTint(box, pendingPaste);
  box.appendChild(itemVisual(pendingPaste, "tile-favicon"));
}

function buildTintRow() {
  const row = $("tintRow");
  row.innerHTML = "";
  const mk = (key, label) => {
    const b = document.createElement("button");
    b.className = "swatch" + (pendingPaste.tint === key ? " active" : "") + (key ? "" : " auto");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", pendingPaste.tint === key ? "true" : "false");
    b.setAttribute("aria-label", label);
    b.title = label;
    if (key) b.style.background = WS_COLOR_HEX[key];
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingPaste.tint = key;
      buildTintRow();
      renderCardPreview();
    });
    row.appendChild(b);
  };
  mk(null, "Automatic");
  WS_COLORS.forEach((c) => mk(c, c.charAt(0).toUpperCase() + c.slice(1)));
}

function buildIconRow() {
  const row = $("iconRow");
  row.innerHTML = "";
  const mk = (name, label, node) => {
    const b = document.createElement("button");
    b.className = "icon-opt" + (pendingPaste.icon === name ? " active" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", pendingPaste.icon === name ? "true" : "false");
    b.setAttribute("aria-label", label);
    b.title = label;
    b.appendChild(node);
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      pendingPaste.icon = name;
      buildIconRow();
      renderCardPreview();
    });
    row.appendChild(b);
  };
  // default: whatever the site's own logo resolves to
  const site = faviconImg(pendingPaste.url, "", 32, pendingPaste.title) || letterAvatar(pendingPaste.title);
  mk(null, "Site logo", site);
  ICON_NAMES.forEach((n) => mk(n, n.charAt(0).toUpperCase() + n.slice(1), libGlyph(n, "icon-opt-glyph")));
}

function setSeg(type) {
  pendingPaste.type = type;
  $("seg").dataset.sel = type;
  $("segApp").classList.toggle("active", type === "app");
  $("segDoc").classList.toggle("active", type === "doc");
  $("segApp").setAttribute("aria-checked", type === "app");
  $("segDoc").setAttribute("aria-checked", type === "doc");
}

$("segApp").addEventListener("click", () => setSeg("app"));
$("segDoc").addEventListener("click", () => setSeg("doc"));
$("pasteCancel").addEventListener("click", cancelPaste);
$("pasteOverlay").addEventListener("click", (e) => {
  if (e.target === $("pasteOverlay")) cancelPaste();
});
$("pasteAdd").addEventListener("click", confirmPaste);
$("pasteTitle").addEventListener("keydown", (e) => {
  if (e.key === "Enter") confirmPaste();
  if (e.key === "Escape") cancelPaste();
  e.stopPropagation();
});

function cancelPaste() {
  pendingPaste = null;
  $("pasteOverlay").hidden = true;
}

function confirmPaste() {
  if (!pendingPaste) return;
  const title = ($("pasteTitle").value.trim() || pendingPaste.title).slice(0, 120);

  // editing an existing item rather than adding a new one
  if (pendingPaste.editId) {
    const found = findItem(pendingPaste.editId);
    if (found) {
      found.item.title = title;
      found.item.type = pendingPaste.type;
      found.item.tint = pendingPaste.tint || undefined;
      found.item.icon = pendingPaste.icon || undefined;
    }
    cancelPaste();
    saveState();
    renderAll();
    toast("Updated");
    return;
  }

  const item = {
    id: uid(),
    kind: "link",
    type: pendingPaste.type,
    title,
    url: pendingPaste.url,
    tint: pendingPaste.tint || undefined,
    icon: pendingPaste.icon || undefined,
    addedAt: Date.now(),
    lastOpenedAt: null,
  };

  const folder = openFolderId ? currentFolder() : null;
  if (folder) folder.items.push(item);
  else activeWs().items.push(item);

  cancelPaste();
  saveState();
  renderAll();
  toast(folder ? `Added to “${folder.name}”` : `Added to ${activeWs().name}`);
}

/* Reopens the card for an existing item so its icon/colour can be changed. */
function customizeItem(item) {
  pendingPaste = {
    editId: item.id,
    url: item.url,
    title: item.title,
    type: item.type,
    tint: item.tint || null,
    icon: item.icon || null,
  };
  openCard(item.url);
}

/* ---------------- context menus ---------------- */

function showMenu(e, entries) {
  const ctx = $("ctx");
  ctx.innerHTML = "";
  entries.forEach((entry) => {
    if (entry === "-") {
      ctx.appendChild(document.createElement("hr"));
      return;
    }
    const btn = document.createElement("button");
    const label = document.createElement("span");
    label.textContent = entry.label;
    btn.appendChild(label);
    if (entry.swatch) {
      const s = document.createElement("span");
      s.className = "ctx-swatch";
      s.style.background = entry.swatch;
      btn.appendChild(s);
    } else if (entry.glyph) {
      btn.appendChild(glyph(entry.glyph));
    }
    if (entry.danger) btn.className = "danger";
    btn.addEventListener("click", () => {
      hideMenu();
      entry.fn();
    });
    ctx.appendChild(btn);
  });
  ctx.hidden = false;
  const pad = 10;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.max(pad, Math.min(e.clientX, window.innerWidth - w - pad)) + "px";
  ctx.style.top = Math.max(pad, Math.min(e.clientY, window.innerHeight - h - pad)) + "px";
}

function hideMenu() {
  $("ctx").hidden = true;
  clearLift();
}
document.addEventListener("click", () => {
  hideMenu();
  if (openSwipe) openSwipe.close();
});
window.addEventListener("blur", hideMenu);

function showItemMenu(e, item) {
  const moveEntries = state.workspaces
    .filter((w) => w.id !== state.activeWs)
    .map((w) => ({
      label: `Move to ${w.name}`,
      swatch: WS_COLOR_HEX[w.color] || WS_COLOR_HEX.grey,
      fn: () => {
        const moved = removeItemById(item.id);
        if (moved) w.items.push(moved);
        saveState();
        renderAll();
        toast(`Moved to ${w.name}`);
      },
    }));

  showMenu(e, [
    { label: "Open in new tab", glyph: "open", fn: () => openLink(item, true) },
    {
      label: "Rename", glyph: "rename",
      fn: () => {
        const name = prompt("Rename:", item.title);
        if (name && name.trim()) { item.title = name.trim().slice(0, 120); saveState(); renderAll(); }
      },
    },
    { label: "Customize icon…", glyph: "sparkle", fn: () => customizeItem(item) },
    {
      label: item.type === "doc" ? "Show as app tile" : "Show as document",
      glyph: item.type === "doc" ? "app" : "doc",
      fn: () => { item.type = item.type === "doc" ? "app" : "doc"; saveState(); renderAll(); },
    },
    { label: "Edit Home Screen", glyph: "edit", fn: enterEditMode },
    ...(moveEntries.length ? ["-", ...moveEntries] : []),
    "-",
    {
      label: "Remove", glyph: "trash", danger: true,
      fn: () => { removeItemById(item.id); saveState(); renderAll(); },
    },
  ]);
}

function showFolderMenu(e, folder) {
  showMenu(e, [
    { label: "Open all as group", glyph: "group", fn: () => openFolderAsGroup(folder) },
    {
      label: "Rename", glyph: "rename",
      fn: () => {
        const name = prompt("Rename folder:", folder.name);
        if (name && name.trim()) { folder.name = name.trim().slice(0, 60); saveState(); renderAll(); }
      },
    },
    { label: "Edit Home Screen", glyph: "edit", fn: enterEditMode },
    "-",
    {
      label: "Ungroup (keep items)", glyph: "ungroup",
      fn: () => {
        const ws = activeWs();
        const idx = ws.items.indexOf(folder);
        ws.items.splice(idx, 1, ...folder.items);
        saveState();
        renderAll();
      },
    },
    {
      label: "Delete folder and items", glyph: "trash", danger: true,
      fn: () => {
        const ws = activeWs();
        const idx = ws.items.indexOf(folder);
        if (idx > -1) ws.items.splice(idx, 1);
        saveState();
        renderAll();
      },
    },
  ]);
}

function showWsMenu(e, ws) {
  const colorEntries = WS_COLORS.map((c) => ({
    label: `Color: ${c}` + (ws.color === c ? " ✓" : ""),
    swatch: WS_COLOR_HEX[c],
    fn: () => { ws.color = c; saveState(); renderAll(); },
  }));

  showMenu(e, [
    {
      label: "Rename", glyph: "rename",
      fn: () => {
        const name = prompt("Rename workspace:", ws.name);
        if (name && name.trim()) { ws.name = name.trim().slice(0, 40); saveState(); renderAll(); }
      },
    },
    "-",
    ...colorEntries,
    "-",
    {
      label: "Delete workspace", glyph: "trash", danger: true,
      fn: () => {
        if (state.workspaces.length === 1) { toast("You need at least one workspace"); return; }
        const count = totalCount(ws);
        if (count > 0 && !confirm(`Delete “${ws.name}” and its ${count} item${count === 1 ? "" : "s"}?`)) return;
        state.workspaces = state.workspaces.filter((w) => w.id !== ws.id);
        if (state.activeWs === ws.id) state.activeWs = state.workspaces[0].id;
        saveState();
        renderAll();
      },
    },
  ]);
}

function showCanvasMenu(e) {
  showMenu(e, [
    { label: "Add link…", glyph: "plus", fn: promptForLink },
    { label: editMode ? "Done editing" : "Edit Home Screen", glyph: "edit", fn: () => (editMode ? exitEditMode() : enterEditMode()) },
    "-",
    { label: "New workspace", glyph: "plus", fn: newWorkspace },
  ]);
}

/* ---------------- new workspace ---------------- */

function newWorkspace() {
  const name = prompt("Workspace name:");
  if (!name || !name.trim()) return;
  const used = new Set(state.workspaces.map((w) => w.color));
  const color = WS_COLORS.find((c) => !used.has(c)) || WS_COLORS[state.workspaces.length % WS_COLORS.length];
  const ws = { id: uid(), name: name.trim().slice(0, 40), color, items: [] };
  state.workspaces.push(ws);
  state.activeWs = ws.id;
  saveState();
  renderAll();
}

$("wsAdd").addEventListener("click", () => {
  if (!state) return;                                  // still loading
  newWorkspace();
});

/* ---------------- keyboard ---------------- */

document.addEventListener("keydown", (e) => {
  if (!state) return;                                  // still loading
  if (e.target.tagName === "INPUT") return;

  if (e.key === "Escape") {
    if (!$("pasteOverlay").hidden) { cancelPaste(); return; }
    if (openFolderId) { closeFolder(); return; }
    if (openSwipe) { openSwipe.close(); return; }
    if (editMode) { exitEditMode(); return; }
    if (filterQuery) { filterQuery = ""; updateFilter(); return; }
    hideMenu();
    return;
  }

  // arrows → previous / next workspace
  if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.metaKey && !e.ctrlKey) {
    stepWorkspace(e.key === "ArrowRight" ? 1 : -1);
    return;
  }

  // 1–9 → switch workspace
  if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !filterQuery) {
    const idx = Number(e.key) - 1;
    if (state.workspaces[idx]) switchWorkspace(state.workspaces[idx].id, 0);
    return;
  }

  if (editMode) return;                                // no type-to-filter while editing

  // type-to-filter
  if (e.key === "Backspace" && filterQuery) {
    filterQuery = filterQuery.slice(0, -1);
    updateFilter();
    return;
  }
  if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && /[\w\s.-]/.test(e.key)) {
    filterQuery += e.key;
    updateFilter();
  }
});

function updateFilter() {
  const chip = $("filterChip");
  if (filterQuery) {
    chip.hidden = false;
    $("filterText").textContent = filterQuery;
  } else {
    chip.hidden = true;
  }
  renderCanvas();
}

$("filterClear").addEventListener("click", (e) => {
  e.stopPropagation();
  filterQuery = "";
  updateFilter();
});

/* ---------------- boot ---------------- */

(async function init() {
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  $("emptyArt").textContent = isMac ? "⌘V" : "Ctrl+V";
  await loadState();
  renderAll();
})();
