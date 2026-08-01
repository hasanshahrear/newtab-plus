/* New Tab+ — workspaces, tiles, folders.
   Vanilla JS, Manifest V3. State lives in chrome.storage.local. */

"use strict";

/* ---------------- environment ---------------- */

const IS_EXT = typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local);

const WS_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const WS_COLOR_HEX = {
  grey: "#8a9199", blue: "#4a7dd6", red: "#c9534f", yellow: "#d6a53c",
  green: "#4f9d69", pink: "#c96398", purple: "#8a63c9", cyan: "#3fa8b8", orange: "#d07b3d",
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
      await chrome.storage.local.set({ state });
      setTimeout(() => { suppressStorageEcho = false; }, 250);
    } else {
      localStorage.setItem("ntp-state", JSON.stringify(state));
    }
  }, 150);
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

/* ---------------- open behaviour ---------------- */

function openLink(item, newTab = false) {
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
  renderWsBar();
  renderCanvas();
  if (openFolderId) renderFolderOverlay();
}

function renderWsBar() {
  const bar = $("wsTabs");
  bar.innerHTML = "";
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
      state.activeWs = ws.id;
      saveState();
      renderAll();
    });
    tab.addEventListener("dblclick", () => startWsRename(tab, ws, label));
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showWsMenu(e, ws);
    });

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

    bar.appendChild(tab);
  });
}

function totalCount(ws) {
  return ws.items.reduce((n, it) => n + (it.kind === "folder" ? it.items.length : 1), 0);
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

  const gridItems = ws.items.filter((it) => it.kind === "folder" || it.type === "app");
  const docItems = ws.items.filter((it) => it.kind === "link" && it.type === "doc");

  gridItems.forEach((it) => grid.appendChild(it.kind === "folder" ? folderTile(it) : appTile(it)));
  grid.appendChild(addTile());

  docItems.forEach((it) => docs.appendChild(docCard(it)));

  $("docsSection").hidden = docItems.length === 0;
  $("empty").hidden = !(ws.items.length === 0);
  $("footHint").hidden = ws.items.length === 0;
}

function letterAvatar(text, cls = "tile-letter") {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = (text || "?").trim().charAt(0).toUpperCase();
  return el;
}

function faviconImg(url, cls, size = 64) {
  const src = faviconUrl(url, size);
  if (!src) return null;
  const img = document.createElement("img");
  img.className = cls;
  img.src = src;
  img.alt = "";
  img.addEventListener("error", () => img.replaceWith(letterAvatar(hostname(url))));
  return img;
}

function appTile(item) {
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.id = item.id;
  tile.draggable = true;
  if (!matchesFilter(item)) tile.classList.add("hidden-by-filter");

  const box = document.createElement("div");
  box.className = "tile-box";
  box.appendChild(faviconImg(item.url, "tile-favicon") || letterAvatar(item.title));
  tile.appendChild(box);

  const label = document.createElement("p");
  label.className = "tile-label";
  label.textContent = item.title;
  label.title = item.title;
  tile.appendChild(label);

  tile.addEventListener("click", (e) => openLink(item, e.metaKey || e.ctrlKey));
  tile.addEventListener("contextmenu", (e) => { e.preventDefault(); showItemMenu(e, item); });
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
      const img = faviconImg(x.url, "", 32);
      if (img) cell.appendChild(img);
      else cell.textContent = (x.title || "?").charAt(0).toUpperCase();
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
  tile.appendChild(box);

  const label = document.createElement("p");
  label.className = "tile-label";
  label.textContent = folder.name;
  label.title = folder.name;
  tile.appendChild(label);

  tile.addEventListener("click", () => showFolder(folder.id));
  tile.addEventListener("contextmenu", (e) => { e.preventDefault(); showFolderMenu(e, folder); });
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
  tile.addEventListener("click", async () => {
    let url = "";
    try {
      const clip = await navigator.clipboard.readText();
      if (/^https?:\/\//i.test(clip.trim())) url = clip.trim();
    } catch { /* clipboard permission denied — fall through */ }
    if (!url) url = prompt("Paste or type a URL to add:") || "";
    url = url.trim();
    if (/^https?:\/\//i.test(url)) beginPasteFlow(url);
    else if (url) toast("That doesn't look like a link");
  });
  return tile;
}

function docCard(item) {
  const card = document.createElement("div");
  card.className = "doc-card";
  card.dataset.id = item.id;
  card.draggable = true;
  if (!matchesFilter(item)) card.classList.add("hidden-by-filter");

  const icon = document.createElement("div");
  icon.className = "doc-icon";
  const img = faviconImg(item.url, "", 32);
  if (img) icon.appendChild(img);
  else icon.appendChild(letterAvatar(item.title));
  card.appendChild(icon);

  const text = document.createElement("div");
  text.className = "doc-text";
  const title = document.createElement("p");
  title.className = "doc-title";
  title.textContent = item.title;
  title.title = item.title;
  const meta = document.createElement("p");
  meta.className = "doc-meta";
  meta.textContent = itemMeta(item);
  text.appendChild(title);
  text.appendChild(meta);
  card.appendChild(text);

  card.addEventListener("click", (e) => openLink(item, e.metaKey || e.ctrlKey));
  card.addEventListener("contextmenu", (e) => { e.preventDefault(); showItemMenu(e, item); });
  wireDrag(card, item);
  return card;
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
    if (x > 0.3 && x < 0.7) el.classList.add("merge-target");
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
  const dragged = removeItemById(draggedId);
  if (!dragged) return;

  if (mode === "merge") {
    if (target.kind === "folder") {
      if (dragged.kind === "folder") target.items.push(...dragged.items);
      else target.items.push(dragged);
      toast(`Added to “${target.name}”`);
    } else if (dragged.kind === "folder") {
      // dropping a folder onto a link: absorb the link into the folder
      const tIdx = ws.items.indexOf(target);
      ws.items.splice(tIdx, 1);
      dragged.items.push(target);
      ws.items.push(dragged);
      toast(`Added to “${dragged.name}”`);
    } else {
      // two links → new folder
      const tIdx = ws.items.indexOf(target);
      const folder = {
        id: uid(), kind: "folder",
        name: suggestFolderName(target, dragged),
        items: [target, dragged],
      };
      ws.items.splice(tIdx, 1, folder);
      toast(`Folder “${folder.name}” created — right-click to rename`);
    }
  } else {
    // reorder within top level
    let tIdx = ws.items.indexOf(target);
    if (tIdx === -1) { ws.items.push(dragged); }
    else {
      if (mode === "after") tIdx += 1;
      ws.items.splice(tIdx, 0, dragged);
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
    const row = document.createElement("div");
    row.className = "folder-row";

    const img = faviconImg(item.url, "", 32);
    row.appendChild(img || letterAvatar(item.title));

    const text = document.createElement("div");
    text.className = "fr-text";
    const t = document.createElement("p");
    t.className = "fr-title";
    t.textContent = item.title;
    const m = document.createElement("p");
    m.className = "fr-meta";
    m.textContent = itemMeta(item);
    text.appendChild(t);
    text.appendChild(m);
    row.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "fr-actions";

    const outBtn = document.createElement("button");
    outBtn.textContent = "Move out";
    outBtn.title = "Move back to the workspace grid";
    outBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const moved = removeItemById(item.id);
      if (moved) activeWs().items.push(moved);
      saveState();
      renderAll();
    });

    const delBtn = document.createElement("button");
    delBtn.textContent = "Remove";
    delBtn.title = "Delete this link";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeItemById(item.id);
      saveState();
      renderAll();
    });

    actions.appendChild(outBtn);
    actions.appendChild(delBtn);
    row.appendChild(actions);

    row.addEventListener("click", (e) => openLink(item, e.metaKey || e.ctrlKey));
    list.appendChild(row);
  });

  $("folderOpenAll").onclick = () => openFolderAsGroup(folder);
}

$("folderClose").addEventListener("click", closeFolder);
$("folderOverlay").addEventListener("click", (e) => {
  if (e.target === $("folderOverlay")) closeFolder();
});

/* ---------------- paste-to-add flow ---------------- */

document.addEventListener("paste", (e) => {
  if (!$("pasteOverlay").hidden) return;               // card already open
  if (e.target.tagName === "INPUT") return;            // typing in a field
  const text = (e.clipboardData || window.clipboardData).getData("text").trim();
  if (/^https?:\/\//i.test(text)) {
    e.preventDefault();
    beginPasteFlow(text);
  }
});

function beginPasteFlow(url) {
  pendingPaste = { url, title: hostname(url), type: detectType(url) };
  const fav = $("pasteFavicon");
  const src = faviconUrl(url);
  if (src) { fav.src = src; fav.style.display = ""; }
  else fav.style.display = "none";

  $("pasteUrl").textContent = url;
  $("pasteTitle").value = pendingPaste.title;
  setSeg(pendingPaste.type);
  $("pasteOverlay").hidden = false;
  $("pasteTitle").focus();
  $("pasteTitle").select();

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

function setSeg(type) {
  pendingPaste.type = type;
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
  const item = {
    id: uid(),
    kind: "link",
    type: pendingPaste.type,
    title: ($("pasteTitle").value.trim() || pendingPaste.title).slice(0, 120),
    url: pendingPaste.url,
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
    btn.textContent = entry.label;
    if (entry.danger) btn.className = "danger";
    btn.addEventListener("click", () => {
      hideMenu();
      entry.fn();
    });
    ctx.appendChild(btn);
  });
  ctx.hidden = false;
  const pad = 8;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = Math.min(e.clientX, window.innerWidth - w - pad) + "px";
  ctx.style.top = Math.min(e.clientY, window.innerHeight - h - pad) + "px";
}

function hideMenu() { $("ctx").hidden = true; }
document.addEventListener("click", hideMenu);
window.addEventListener("blur", hideMenu);

function showItemMenu(e, item) {
  const moveEntries = state.workspaces
    .filter((w) => w.id !== state.activeWs)
    .map((w) => ({
      label: `Move to ${w.name}`,
      fn: () => {
        const moved = removeItemById(item.id);
        if (moved) w.items.push(moved);
        saveState();
        renderAll();
        toast(`Moved to ${w.name}`);
      },
    }));

  showMenu(e, [
    { label: "Open in new tab", fn: () => openLink(item, true) },
    {
      label: "Rename",
      fn: () => {
        const name = prompt("Rename:", item.title);
        if (name && name.trim()) { item.title = name.trim().slice(0, 120); saveState(); renderAll(); }
      },
    },
    {
      label: item.type === "doc" ? "Show as app tile" : "Show as document card",
      fn: () => { item.type = item.type === "doc" ? "app" : "doc"; saveState(); renderAll(); },
    },
    "-",
    ...moveEntries,
    ...(moveEntries.length ? ["-"] : []),
    {
      label: "Remove", danger: true,
      fn: () => { removeItemById(item.id); saveState(); renderAll(); },
    },
  ]);
}

function showFolderMenu(e, folder) {
  showMenu(e, [
    { label: "Open all as group", fn: () => openFolderAsGroup(folder) },
    {
      label: "Rename",
      fn: () => {
        const name = prompt("Rename folder:", folder.name);
        if (name && name.trim()) { folder.name = name.trim().slice(0, 60); saveState(); renderAll(); }
      },
    },
    "-",
    {
      label: "Ungroup (keep items)",
      fn: () => {
        const ws = activeWs();
        const idx = ws.items.indexOf(folder);
        ws.items.splice(idx, 1, ...folder.items);
        saveState();
        renderAll();
      },
    },
    {
      label: "Delete folder and items", danger: true,
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
    fn: () => { ws.color = c; saveState(); renderAll(); },
  }));

  showMenu(e, [
    {
      label: "Rename",
      fn: () => {
        const name = prompt("Rename workspace:", ws.name);
        if (name && name.trim()) { ws.name = name.trim().slice(0, 40); saveState(); renderAll(); }
      },
    },
    "-",
    ...colorEntries,
    "-",
    {
      label: "Delete workspace", danger: true,
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

/* ---------------- new workspace ---------------- */

$("wsAdd").addEventListener("click", () => {
  const name = prompt("Workspace name:");
  if (!name || !name.trim()) return;
  const used = new Set(state.workspaces.map((w) => w.color));
  const color = WS_COLORS.find((c) => !used.has(c)) || WS_COLORS[state.workspaces.length % WS_COLORS.length];
  const ws = { id: uid(), name: name.trim().slice(0, 40), color, items: [] };
  state.workspaces.push(ws);
  state.activeWs = ws.id;
  saveState();
  renderAll();
});

/* ---------------- keyboard ---------------- */

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;

  if (e.key === "Escape") {
    if (!$("pasteOverlay").hidden) { cancelPaste(); return; }
    if (openFolderId) { closeFolder(); return; }
    if (filterQuery) { filterQuery = ""; updateFilter(); return; }
    hideMenu();
    return;
  }

  // 1–9 → switch workspace
  if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !filterQuery) {
    const idx = Number(e.key) - 1;
    if (state.workspaces[idx]) {
      state.activeWs = state.workspaces[idx].id;
      saveState();
      renderAll();
    }
    return;
  }

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

/* ---------------- boot ---------------- */

(async function init() {
  await loadState();
  renderAll();
})();
