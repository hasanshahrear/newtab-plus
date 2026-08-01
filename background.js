// New Tab+ background service worker
// Adds a right-click "Pin page to New Tab+" menu on any page.

const MENU_ID = "newtabplus-pin";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Pin page to New Tab+",
    contexts: ["page", "link"],
  });
});

const DOC_PATTERNS = [
  /docs\.google\.com/,
  /sheets\.google\.com/,
  /drive\.google\.com/,
  /onedrive\.live\.com/,
  /sharepoint\.com/,
  /office\.com/,
  /officeapps\.live\.com/,
  /notion\.so/,
  /notion\.site/,
  /dropbox\.com\/(scl|s|home)/,
  /paper\.dropbox\.com/,
  /airtable\.com/,
  /coda\.io/,
  /\.pdf($|\?)/i,
  /\.xlsx?($|\?)/i,
  /\.docx?($|\?)/i,
];

function detectType(url) {
  return DOC_PATTERNS.some((re) => re.test(url)) ? "doc" : "app";
}

function uid() {
  return "i" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return;

  const url = info.linkUrl || info.pageUrl || (tab && tab.url);
  if (!url || !/^https?:/i.test(url)) return;

  const title =
    info.linkUrl
      ? url.replace(/^https?:\/\/(www\.)?/, "").split(/[/?#]/)[0]
      : (tab && tab.title) || url.replace(/^https?:\/\/(www\.)?/, "").split(/[/?#]/)[0];

  const data = await chrome.storage.local.get("state");
  const state = data.state;
  if (!state || !Array.isArray(state.workspaces) || state.workspaces.length === 0) return;

  const ws =
    state.workspaces.find((w) => w.id === state.activeWs) || state.workspaces[0];

  ws.items.push({
    id: uid(),
    kind: "link",
    type: detectType(url),
    title: title.slice(0, 120),
    url,
    addedAt: Date.now(),
    lastOpenedAt: null,
  });

  await chrome.storage.local.set({ state });

  // Small confirmation via badge-less notification alternative: none needed.
});
