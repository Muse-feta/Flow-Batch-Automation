"use strict";

let DATA = null;
let QUEUE = [];
let CURRENT_JOB = null;
let CURRENT_INDEX = -1;
let CURRENT_MODE = "image"; // "image" | "video"
let DIRECTORY_HANDLE = null;
let SELECTED_FOLDER_NAME = "";

const $ = (id) => document.getElementById(id);

// --- IndexedDB for FileSystemDirectoryHandle Persistence --------------------
const DB_NAME = "FlowAutomatorDB";
const STORE_NAME = "handles";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveStoredHandle(handle) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(handle, "destinationFolder");
    return new Promise((res) => {
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    });
  } catch (e) {
    return false;
  }
}

async function getStoredHandle() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get("destinationFolder");
    return new Promise((res) => {
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    });
  } catch (e) {
    return null;
  }
}

// --- Folder Badge UI Controller ---------------------------------------------
function updateFolderBadge(name, isReady = true) {
  const badge = $("selectedFolderBadge");
  const btn = $("btnBrowseFolder");
  if (btn) {
    btn.style.borderColor = "#3f3f46";
  }
  if (!badge) return;
  badge.style.boxShadow = "none";
  if (name) {
    badge.textContent = "📁 " + name;
    badge.style.color = isReady ? "#34d399" : "#fbbf24";
    badge.style.borderColor = isReady ? "#10b981" : "#f59e0b";
    badge.style.borderStyle = "solid";
    badge.style.background = isReady ? "rgba(16, 185, 129, 0.08)" : "rgba(245, 158, 11, 0.08)";
    badge.title = name;
  } else {
    badge.textContent = "No folder selected";
    badge.style.color = "#71717a";
    badge.style.borderColor = "#3f3f46";
    badge.style.borderStyle = "dashed";
    badge.style.background = "#18181b";
    badge.title = "Click to browse folder";
  }
}

// Native File System Access Picker
async function chooseDestinationFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (handle) {
      DIRECTORY_HANDLE = handle;
      SELECTED_FOLDER_NAME = handle.name;
      updateFolderBadge(handle.name, true);
      await saveStoredHandle(handle);
      chrome.storage.local.set({ selectedFolderName: handle.name });
      logLine(`Selected destination folder: ${handle.name}`, "ok");
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      logLine("Folder selection error: " + err.message, "err");
    }
  }
}

// Direct File System Writer
async function saveToDirectory(handle, fileName, dataUrl) {
  if (!handle || !dataUrl) return false;
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const fileHandle = await handle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
    console.log(`[Flow Sidepanel] Saved ${fileName} directly to native folder: ${handle.name}`);
    return true;
  } catch (err) {
    console.warn(`[Flow Sidepanel] Failed writing ${fileName} to directory handle:`, err);
    return false;
  }
}

// --- Logging Helpers --------------------------------------------------------
function logLine(text, cls = "") {
  const logEl = $("log");
  if (!logEl) return;
  const d = document.createElement("div");
  d.className = "l " + cls;
  d.textContent = text;
  logEl.prepend(d);
}

function logStatus(text) {
  logLine(text, "warn");
}

// --- Text & Heading Cleaning ------------------------------------------------
function stripMjFlags(s) {
  return String(s || "")
    .replace(/\s--\w+(?:\s+[^\s-]\S*)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanHeading(h) {
  return String(h || "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^\d+[.)]\s*/, "")
    .trim();
}

function parseShots(spec) {
  const s = (spec || "").trim();
  if (!s) return null;
  const out = new Set();
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("-")) {
      const [a, b] = p.split("-").map((x) => parseInt(x, 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else out.add(parseInt(p, 10));
  }
  return out;
}

// Turn pasted text into [{prompt, label}]
function parsePasted(raw) {
  const text = (raw || "").replace(/\r/g, "");
  if (!text.trim()) return [];

  if (/```/.test(text)) {
    const out = [];
    const re = /```[a-z0-9]*[ \t]*\n?([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const body = stripMjFlags(m[1].replace(/\n+/g, " ").trim());
      if (!body) continue;
      const before = text.slice(0, m.index).split("\n").map((s) => s.trim()).filter(Boolean);
      const last = before[before.length - 1] || "";
      const label = /^#{1,6}\s|^\d+[.)]\s|^\*\*.*\*\*$/.test(last) ? cleanHeading(last) : "";
      out.push({ prompt: body, label });
    }
    if (out.length) return out;
  }

  const toItem = (p) => ({ prompt: stripMjFlags(cleanHeading(p)), label: "" });
  if (/\n\s*\n/.test(text.trim())) {
    return text.split(/\n\s*\n/).map((b) => toItem(b.replace(/\n/g, " ").trim())).filter((it) => it.prompt);
  }
  return text.split("\n").map((l) => toItem(l.trim())).filter((it) => it.prompt);
}

// Extract timestamp tag formatted like #2-06, 2-06, 0-00, 0-15, 1-05, etc.
function parseTimestampTag(text, fallbackIndex) {
  const raw = String(text || "").trim();
  const match = raw.match(/^(?:#?\s*)(\d+[-_]\d+)/);
  if (match) {
    const customTag = match[1];
    const promptText = raw.replace(/^(?:#?\s*)\d+[-_]\d+[\s\:\-\.]*/i, "").trim();
    return { customTag, promptText };
  }
  return {
    customTag: String(fallbackIndex).padStart(2, "0"),
    promptText: raw,
  };
}

// --- Build & Parse Queue ----------------------------------------------------
function buildQueue() {
  let rawList = [];
  if ($("source") && $("source").value === "paste") {
    const prefix = (($("prefix") && $("prefix").value) || "custom").trim() || "custom";
    rawList = parsePasted($("pasteText") ? $("pasteText").value : "").map((it, i) => ({
      collection: prefix,
      listing_id: null,
      n: i + 1,
      label: it.label || "",
      prompt: it.prompt,
    }));
  } else if (DATA && DATA.collections) {
    const col = $("collection") ? $("collection").value : "*";
    const shots = parseShots($("shots") ? $("shots").value : "");
    for (const c of DATA.collections) {
      if (col !== "*" && c.collection !== col) continue;
      for (const p of c.prompts) {
        if (shots && !shots.has(p.n)) continue;
        rawList.push({
          collection: c.collection,
          listing_id: c.listing_id,
          n: p.n,
          label: p.label,
          prompt: p.prompt,
        });
      }
    }
  }

  return rawList.map((it, i) => {
    let parsed = parseTimestampTag(it.prompt, i + 1);
    let customTag = parsed.customTag;
    let cleanPrompt = parsed.promptText;

    if ((!customTag || customTag === String(i + 1).padStart(2, "0")) && it.label) {
      const fromLabel = parseTimestampTag(it.label, i + 1);
      if (fromLabel.customTag && fromLabel.customTag !== String(i + 1).padStart(2, "0")) {
        customTag = fromLabel.customTag;
      }
    }

    return {
      index: i,
      collection: it.collection,
      listing_id: it.listing_id,
      n: i + 1,
      label: it.label || "",
      customTag,
      rawPrompt: it.prompt,
      prompt: cleanPrompt || it.prompt,
      promptText: cleanPrompt || it.prompt,
      status: "queued",
      dataUrl: null,
      filename: null,
      errorMsg: null,
    };
  });
}

function cfgFromUI() {
  return {
    mode: CURRENT_MODE,
    upscale: $("upscale") ? $("upscale").checked : false,
    waitMode: $("waitMode") ? $("waitMode").value : "fast",
    autoDownload: $("autoDownload") ? $("autoDownload").checked : true,
    subfolder: SELECTED_FOLDER_NAME || "Flow-Automation",
    delaySec: parseInt($("delaySec") ? $("delaySec").value : "45", 10) || 45,
    gapSec: $("waitMode") && $("waitMode").value === "fast" ? 1 : Math.min(8, Math.max(2, Math.round((parseInt($("delaySec") ? $("delaySec").value : "45", 10) || 45) / 12))),
  };
}

// --- DOM References ---------------------------------------------------------
const btnNext = $("btnNext");
const btnStop = $("btnStop");
const btnStart = $("start");
const btnPause = $("pause");
const promptQueueList = $("promptQueueList");
const queueCountEl = $("queueCount");
const queueProgressBadge = $("queueProgressBadge");
const btnBrowseFolder = $("btnBrowseFolder");
const selectedFolderBadge = $("selectedFolderBadge");

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Image Viewer Modal -----------------------------------------------------
let MODAL_ASSET_INDEX = -1;

function openImageModal(dataUrl, title, filename, index = -1) {
  const modal = $("imageModal");
  const modalImg = $("modalImg");
  const modalTitle = $("modalTitle");
  if (!modal || !modalImg) return;
  MODAL_ASSET_INDEX = index;
  modalImg.src = dataUrl;
  if (modalTitle) modalTitle.textContent = title || "Generated Asset";
  modal.style.display = "flex";
}

function closeImageModal() {
  const modal = $("imageModal");
  const modalImg = $("modalImg");
  if (modal) modal.style.display = "none";
  if (modalImg) modalImg.src = "";
  MODAL_ASSET_INDEX = -1;
}

const modalCloseBtn = $("modalCloseBtn");
const modalCloseActionBtn = $("modalCloseActionBtn");
const modalDownloadBtn = $("modalDownloadBtn");
const imageModal = $("imageModal");

if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeImageModal);
if (modalCloseActionBtn) modalCloseActionBtn.addEventListener("click", closeImageModal);
if (imageModal) {
  imageModal.addEventListener("click", (e) => {
    if (e.target === imageModal) closeImageModal();
  });
}
if (modalDownloadBtn) {
  modalDownloadBtn.addEventListener("click", () => {
    if (MODAL_ASSET_INDEX >= 0) {
      redownloadAsset(MODAL_ASSET_INDEX);
    } else {
      const modalImg = $("modalImg");
      if (modalImg && modalImg.src) {
        const a = document.createElement("a");
        a.href = modalImg.src;
        a.download = "generated_image.png";
        a.click();
      }
    }
  });
}

// --- Card Rendering ---------------------------------------------------------
function renderQueueCards() {
  if (!promptQueueList) return;
  promptQueueList.innerHTML = "";

  if (!QUEUE || QUEUE.length === 0) {
    promptQueueList.innerHTML = '<div class="empty-queue-msg">No prompts loaded. Paste your prompts above and click "Load Prompts".</div>';
    if (queueCountEl) queueCountEl.textContent = "0";
    if (queueProgressBadge) queueProgressBadge.textContent = "0 / 0";
    return;
  }

  if (queueCountEl) queueCountEl.textContent = String(QUEUE.length);
  if (queueProgressBadge) queueProgressBadge.textContent = `0 / ${QUEUE.length}`;

  QUEUE.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "prompt-card";
    card.id = `card-${index}`;
    card.dataset.index = index;

    card.innerHTML = `
      <div class="card-header-row">
        <div class="card-title-text">
          <span class="card-index">${index + 1}.</span>
          <span class="card-tag">#${escapeHtml(item.customTag)}</span>
          <span class="card-prompt-text">${escapeHtml(item.promptText || item.prompt)}</span>
        </div>
        <div class="card-header-actions">
          <button type="button" class="card-btn-icon card-copy-btn" title="Copy prompt text" data-index="${index}">📋</button>
          <button type="button" class="card-btn-icon card-retry-btn" title="Regenerate this prompt" data-index="${index}">↻</button>
        </div>
      </div>

      <div class="card-body-row">
        <div class="card-preview-box" id="preview-box-${index}" title="Click to view image" data-index="${index}">
          <span class="card-preview-placeholder">🖼️</span>
        </div>

        <div class="card-meta-col">
          <div class="card-status-row" id="status-row-${index}">
            <span class="status-badge status-queued">Queued</span>
          </div>

          <div class="card-actions-row" id="actions-row-${index}" style="display: none;">
            <button type="button" class="card-action-link btn-dl" data-index="${index}" title="Download asset">⬇ Download</button>
            <button type="button" class="card-action-link btn-view" data-index="${index}" title="View full image">👁️ View</button>
          </div>
        </div>
      </div>

      <div class="card-failed-box" id="failed-box-${index}" style="display: none;">
        <span class="failed-icon">⚠️</span>
        <span class="failed-msg" id="failed-msg-${index}">Generation failed</span>
        <button type="button" class="btn-card-retry" data-index="${index}">↻ Retry</button>
      </div>
    `;

    // Copy button
    const copyBtn = card.querySelector(".card-copy-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const text = item.promptText || item.prompt;
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = "✓";
          copyBtn.style.color = "#34d399";
          setTimeout(() => {
            copyBtn.textContent = "📋";
            copyBtn.style.color = "";
          }, 1200);
        } catch (_) {}
      });
    }

    // Retry button (top right)
    const retryBtn = card.querySelector(".card-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        retryCard(index);
      });
    }

    // Retry button in failed box
    const cardRetryBtn = card.querySelector(".btn-card-retry");
    if (cardRetryBtn) {
      cardRetryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        retryCard(index);
      });
    }

    // Preview thumbnail click => open modal if image ready
    const previewBox = card.querySelector(".card-preview-box");
    if (previewBox) {
      previewBox.addEventListener("click", () => {
        if (item.dataUrl) {
          openImageModal(item.dataUrl, `#${item.customTag} — Prompt ${index + 1}`, item.filename, index);
        }
      });
    }

    // Download action link
    const dlBtn = card.querySelector(".btn-dl");
    if (dlBtn) {
      dlBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        redownloadAsset(index);
      });
    }

    // View action link
    const viewBtn = card.querySelector(".btn-view");
    if (viewBtn) {
      viewBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (item.dataUrl) {
          openImageModal(item.dataUrl, `#${item.customTag} — Prompt ${index + 1}`, item.filename, index);
        }
      });
    }

    promptQueueList.appendChild(card);
  });
}

// --- Card Status Updater ----------------------------------------------------
function updateCardStatus(index, status, dataUrl = null, filename = null, errorMsg = null) {
  if (index < 0 || index >= QUEUE.length) return;
  const item = QUEUE[index];
  item.status = status;
  if (dataUrl) item.dataUrl = dataUrl;
  if (filename) item.filename = filename;
  if (errorMsg) item.errorMsg = errorMsg;

  const card = $(`card-${index}`);
  if (!card) return;

  const statusRow = $(`status-row-${index}`);
  const previewBox = $(`preview-box-${index}`);
  const actionsRow = $(`actions-row-${index}`);
  const failedBox = $(`failed-box-${index}`);
  const failedMsg = $(`failed-msg-${index}`);

  card.classList.remove("active-generating", "status-done", "status-failed");

  switch (status) {
    case "generating":
      card.classList.add("active-generating");
      if (statusRow) {
        statusRow.innerHTML = '<span class="status-badge status-generating"><span class="spinner"></span> Generating...</span>';
      }
      if (previewBox) {
        previewBox.innerHTML = '<span class="spinner" style="width: 18px; height: 18px;"></span>';
        previewBox.style.cursor = "wait";
        previewBox.title = "Generating media...";
      }
      if (actionsRow) actionsRow.style.display = "none";
      if (failedBox) failedBox.style.display = "none";
      card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      break;

    case "done":
      card.classList.add("status-done");
      if (statusRow) {
        statusRow.innerHTML = '<span class="status-badge status-done">✓ Done — 1/1</span>';
      }
      if (previewBox) {
        const src = item.dataUrl || dataUrl;
        if (src) {
          previewBox.innerHTML = `<img class="card-preview-img" src="${src}" alt="Generated Media" title="Click to view full size" onerror="this.onerror=null;this.parentElement.innerHTML='<span class=card-preview-placeholder>🖼️</span>';" />`;
          previewBox.style.cursor = "pointer";
          previewBox.title = "Click to view full image";
        } else {
          previewBox.innerHTML = '<span class="card-preview-placeholder">🖼️</span>';
          previewBox.style.cursor = "default";
        }
      }
      if (actionsRow) actionsRow.style.display = "flex";
      if (failedBox) failedBox.style.display = "none";
      break;

    case "failed":
      card.classList.add("status-failed");
      if (statusRow) {
        statusRow.innerHTML = '<span class="status-badge status-failed">✗ Failed</span>';
      }
      if (previewBox) {
        previewBox.innerHTML = '<span class="card-preview-placeholder">⚠️</span>';
        previewBox.style.cursor = "default";
      }
      if (failedMsg) failedMsg.textContent = errorMsg || item.errorMsg || "Generation failed";
      if (actionsRow) actionsRow.style.display = "none";
      if (failedBox) failedBox.style.display = "flex";
      break;

    case "stopped":
      if (statusRow) {
        statusRow.innerHTML = '<span class="status-badge status-stopped">⏹ Stopped</span>';
      }
      if (actionsRow) actionsRow.style.display = "none";
      if (failedBox) failedBox.style.display = "none";
      break;

    default: // queued
      if (statusRow) {
        statusRow.innerHTML = '<span class="status-badge status-queued">Queued</span>';
      }
      if (previewBox) {
        previewBox.innerHTML = '<span class="card-preview-placeholder">🖼️</span>';
        previewBox.style.cursor = "default";
      }
      if (actionsRow) actionsRow.style.display = "none";
      if (failedBox) failedBox.style.display = "none";
      break;
  }

  // Update progress badge (done count / total)
  const doneCount = QUEUE.filter((q) => q.status === "done").length;
  if (queueProgressBadge) {
    queueProgressBadge.textContent = `${doneCount} / ${QUEUE.length}`;
  }
}

// --- Mandatory Subfolder Validation -----------------------------------------
function highlightFolderError() {
  const badge = $("selectedFolderBadge");
  if (badge) {
    badge.style.borderColor = "#ef4444";
    badge.style.boxShadow = "0 0 10px rgba(239, 68, 68, 0.4)";
    badge.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  const btn = $("btnBrowseFolder");
  if (btn) {
    btn.style.borderColor = "#ef4444";
  }
}

async function validateSubfolder() {
  if (!DIRECTORY_HANDLE && !SELECTED_FOLDER_NAME) {
    highlightFolderError();
    alert("Please select a destination folder first");
    return false;
  }

  if (DIRECTORY_HANDLE) {
    try {
      let perm = await DIRECTORY_HANDLE.queryPermission({ mode: "readwrite" });
      if (perm !== "granted") {
        perm = await DIRECTORY_HANDLE.requestPermission({ mode: "readwrite" });
      }
      if (perm === "granted") {
        updateFolderBadge(DIRECTORY_HANDLE.name, true);
        return true;
      }
    } catch (e) {
      console.warn("Handle permission verification:", e);
    }
  }

  // If handle missing or permission not granted, prompt user to select folder
  await chooseDestinationFolder();
  if (!DIRECTORY_HANDLE) {
    highlightFolderError();
    alert("Please select a destination folder first");
    return false;
  }
  return true;
}

if (btnBrowseFolder) {
  btnBrowseFolder.addEventListener("click", chooseDestinationFolder);
}
if (selectedFolderBadge) {
  selectedFolderBadge.addEventListener("click", chooseDestinationFolder);
}

// --- Individual Card Retry --------------------------------------------------
async function retryCard(index) {
  const item = QUEUE[index];
  if (!item) return;

  // Validate subfolder requirement first
  if (!await validateSubfolder()) return;

  logLine(`↻ Regenerating prompt #${item.n} (${item.customTag})...`, "ok");

  // Pause batch run if active so debugger won't conflict
  chrome.runtime.sendMessage({ cmd: "pause" }).catch(() => {});
  if (btnPause) btnPause.textContent = "Resume";

  updateCardStatus(index, "generating");

  const cfg = cfgFromUI();
  const resp = await chrome.runtime.sendMessage({
    type: "retryCard",
    cmd: "retryCard",
    job: item,
    index,
    cfg,
  });

  if (resp && resp.ok) {
    updateCardStatus(index, "done", resp.dataUrl, resp.filename);
    if (DIRECTORY_HANDLE && resp.dataUrl) {
      saveToDirectory(DIRECTORY_HANDLE, `${item.customTag}.png`, resp.dataUrl);
    }
    logLine(`✓ Card #${item.n} (${item.customTag}) regenerated successfully!`, "ok");
  } else {
    const err = (resp && resp.error) || "Generation failed";
    updateCardStatus(index, "failed", null, null, err);
    logLine(`✗ Retry failed for #${item.n}: ${err}`, "err");
  }
}

// --- Redownload Generated Asset ---------------------------------------------
function redownloadAsset(index) {
  const item = QUEUE[index];
  if (!item || !item.dataUrl) {
    logLine(`No image data available for card #${index + 1} yet.`, "warn");
    return;
  }
  const folder = SELECTED_FOLDER_NAME || cfgFromUI().subfolder || "Flow-Automation";
  const filename = item.filename || `${folder}/${item.customTag}.png`;
  logLine(`⬇ Redownloading: ${filename}...`, "ok");

  if (DIRECTORY_HANDLE) {
    saveToDirectory(DIRECTORY_HANDLE, `${item.customTag}.png`, item.dataUrl);
  }

  chrome.runtime.sendMessage({
    cmd: "redownload",
    dataUrl: item.dataUrl,
    filename,
  }).catch(() => {
    // Fallback: direct download link
    const a = document.createElement("a");
    a.href = item.dataUrl;
    a.download = `${item.customTag}.png`;
    a.click();
  });
}

// --- Running State Controller -----------------------------------------------
function setRunning(on) {
  if (btnStart) btnStart.disabled = on;
  if (btnPause) {
    btnPause.disabled = !on;
    btnPause.textContent = "⏸ Pause";
  }
  if (btnStop) btnStop.disabled = !on;
  if (btnNext) btnNext.disabled = !on;
  if (btnBrowseFolder) btnBrowseFolder.disabled = on;
  document.querySelectorAll("select, textarea").forEach((e) => {
    e.disabled = on;
  });
}

// --- Mode Switch Tabs ([Images] | [Videos]) ----------------------------------
const tabModeImages = $("tabModeImages");
const tabModeVideos = $("tabModeVideos");

function setMode(mode) {
  CURRENT_MODE = mode;
  if (tabModeImages && tabModeVideos) {
    if (mode === "video") {
      tabModeVideos.classList.add("active");
      tabModeImages.classList.remove("active");
    } else {
      tabModeImages.classList.add("active");
      tabModeVideos.classList.remove("active");
    }
  }
  chrome.storage.local.set({ flowBatchMode: mode });
  logLine(`Mode switched to: ${mode === "video" ? "Videos" : "Images"}`, "ok");
}

if (tabModeImages) {
  tabModeImages.addEventListener("click", () => setMode("image"));
}
if (tabModeVideos) {
  tabModeVideos.addEventListener("click", () => setMode("video"));
}

// --- Queue Loading Logic ----------------------------------------------------
function loadPromptsIntoQueue() {
  QUEUE = buildQueue();
  renderQueueCards();
  logLine(`Loaded ${QUEUE.length} prompt cards into queue.`, "ok");
}

const btnLoadPrompts = $("btnLoadPrompts");
if (btnLoadPrompts) {
  btnLoadPrompts.addEventListener("click", loadPromptsIntoQueue);
}

const pasteTextEl = $("pasteText");
if (pasteTextEl) {
  let debounceTimer = null;
  pasteTextEl.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      QUEUE = buildQueue();
      if (queueCountEl) queueCountEl.textContent = String(QUEUE.length);
      if (queueProgressBadge) queueProgressBadge.textContent = `0 / ${QUEUE.length}`;
    }, 300);
  });
}

// --- Global Queue Controls --------------------------------------------------
if (btnStart) {
  btnStart.addEventListener("click", async () => {
    // 1. Mandatory Subfolder check
    if (!await validateSubfolder()) return;

    // 2. Ensure queue is populated
    if (!QUEUE || !QUEUE.length) {
      QUEUE = buildQueue();
      renderQueueCards();
    }
    if (!QUEUE.length) {
      logLine("Nothing to queue. Please paste prompts first.", "warn");
      return;
    }

    // Reset card statuses for a fresh start
    QUEUE.forEach((q, i) => updateCardStatus(i, "queued"));

    const cfg = cfgFromUI();
    const resp = await chrome.runtime.sendMessage({
      type: "start",
      queue: QUEUE,
      cfg,
      startIndex: 0,
    });

    if (!resp || !resp.ok) {
      logLine("Cannot start: " + ((resp && resp.error) || "unknown error"), "err");
      return;
    }

    const bar = $("bar");
    if (bar) bar.max = QUEUE.length;
    setRunning(true);
    $("now").textContent = `▶ 1/${QUEUE.length}`;
    logLine(`Started batch: ${QUEUE.length} prompts into '${cfg.subfolder}'.`, "ok");
  });
}

if (btnPause) {
  btnPause.addEventListener("click", async () => {
    const isPaused = btnPause.textContent.includes("Resume");
    await chrome.runtime.sendMessage({ type: isPaused ? "resume" : "pause" });
    btnPause.textContent = isPaused ? "⏸ Pause" : "▶ Resume";
    $("now").textContent = isPaused ? `▶ Resumed` : `⏸ Paused`;
    logLine(isPaused ? "Resumed queue." : "Paused queue.", "warn");
  });
}

if (btnNext) {
  btnNext.addEventListener("click", async () => {
    logLine("Skipping to next prompt ⏭...", "ok");
    await chrome.runtime.sendMessage({ type: "skipNext", cmd: "manualNext" });
  });
}

if (btnStop) {
  btnStop.addEventListener("click", () => {
    chrome.runtime.sendMessage({ cmd: "stopBatch", type: "stopBatch" });
    setRunning(false);
    if (CURRENT_INDEX >= 0 && CURRENT_INDEX < QUEUE.length) {
      if (QUEUE[CURRENT_INDEX].status === "generating") {
        updateCardStatus(CURRENT_INDEX, "stopped");
      }
    }
    $("now").textContent = "⏹ Stopped";
    logStatus("⏹ Stopped by user.");
  });
}

// --- Manual Download Actions ------------------------------------------------
const btnDownloadLatest = $("btnDownloadLatest");
if (btnDownloadLatest) {
  btnDownloadLatest.addEventListener("click", async () => {
    logLine("Requesting latest generated image...", "ok");
    const customTag = (CURRENT_JOB && CURRENT_JOB.customTag) || "";
    const resp = await chrome.runtime.sendMessage({
      type: "downloadLatestManual",
      cmd: "downloadLatestManual",
      customTag,
    });
    if (resp && resp.ok) {
      const name = resp.filename ? resp.filename.split("/").pop() : "image.png";
      logLine(`✓ Downloaded latest image: ${name}`, "ok");
      if (DIRECTORY_HANDLE && resp.dataUrl) {
        saveToDirectory(DIRECTORY_HANDLE, name, resp.dataUrl);
      }
    } else {
      logLine("Download failed: " + ((resp && resp.error) || "no media found"), "err");
    }
  });
}

const btnDownloadAll = $("btnDownloadAll");
if (btnDownloadAll) {
  btnDownloadAll.addEventListener("click", async () => {
    logLine("Requesting download of all visible media...", "ok");
    const resp = await chrome.runtime.sendMessage({
      type: "downloadAllManual",
      cmd: "downloadAllManual",
    });
    if (resp && resp.ok) {
      logLine(`✓ Downloaded all visible media (${resp.count || 0} items)`, "ok");
    } else {
      logLine("Download all failed: " + ((resp && resp.error) || "no media found"), "err");
    }
  });
}

// --- Chrome Runtime Message Listener ----------------------------------------
chrome.runtime.onMessage.addListener((m) => {
  if (m.type !== "progress") return;

  switch (m.kind) {
    case "start":
      CURRENT_INDEX = m.index;
      CURRENT_JOB = m.job;
      updateCardStatus(m.index, "generating");
      const tag = m.job && m.job.customTag ? `[#${m.job.customTag}] ` : "";
      $("now").textContent = `▶ ${m.index + 1}/${m.total} ${tag}`;
      const bar = $("bar");
      if (bar) bar.value = m.index;
      if (btnNext) btnNext.disabled = false;
      break;

    case "done":
      updateCardStatus(m.index, "done", m.dataUrl, m.filename);
      const doneTag = m.job ? (m.job.customTag || m.job.n) : "done";
      logLine(`✓ Completed #${doneTag}`, "ok");
      if (DIRECTORY_HANDLE && m.dataUrl) {
        const item = QUEUE[m.index];
        const t = (item && item.customTag) || String(m.index + 1).padStart(2, "0");
        const fileName = `${t}.png`;
        saveToDirectory(DIRECTORY_HANDLE, fileName, m.dataUrl);
      }
      const b = $("bar");
      if (b) b.value = m.index + 1;
      if (btnNext) btnNext.disabled = false;
      break;

    case "card-status":
      updateCardStatus(m.index, m.status, null, null, m.error);
      break;

    case "card-done":
      updateCardStatus(m.index, "done", m.dataUrl, m.filename);
      if (DIRECTORY_HANDLE && m.dataUrl) {
        const item = QUEUE[m.index];
        const t = (item && item.customTag) || String(m.index + 1).padStart(2, "0");
        const fileName = `${t}.png`;
        saveToDirectory(DIRECTORY_HANDLE, fileName, m.dataUrl);
      }
      break;

    case "error":
      updateCardStatus(m.index, "failed", null, null, m.message);
      logLine(`✗ Card #${m.index + 1}: ${m.message}`, "err");
      break;

    case "await-manual":
      if (btnNext) btnNext.disabled = false;
      $("now").textContent += " — waiting for Next";
      break;

    case "info":
      logLine(m.message, "ok");
      break;

    case "warn":
      logLine("⚠ " + m.message, "warn");
      break;

    case "finished":
      CURRENT_JOB = null;
      CURRENT_INDEX = -1;
      $("now").textContent = "✅ Finished";
      setRunning(false);
      logLine("Batch run completed!", "ok");
      break;

    case "stopped":
      CURRENT_JOB = null;
      if (CURRENT_INDEX >= 0 && CURRENT_INDEX < QUEUE.length) {
        if (QUEUE[CURRENT_INDEX].status === "generating") {
          updateCardStatus(CURRENT_INDEX, "stopped");
        }
      }
      CURRENT_INDEX = -1;
      $("now").textContent = "⏹ Stopped";
      setRunning(false);
      break;
  }
});

// --- State Persistence & Initialization -------------------------------------
const PERSIST = ["source", "pasteText", "prefix", "collection", "shots", "waitMode", "delaySec"];
const PERSIST_CHK = ["autoDownload", "upscale"];

function saveState() {
  const s = {};
  PERSIST.forEach((id) => { if ($(id)) s[id] = $(id).value; });
  PERSIST_CHK.forEach((id) => { if ($(id)) s[id] = $(id).checked; });
  s.flowBatchMode = CURRENT_MODE;
  chrome.storage.local.set({ flowBatchState: s });
}

function restoreState() {
  return new Promise((res) => {
    chrome.storage.local.get(["flowBatchState", "flowBatchMode", "selectedFolderName"], (r) => {
      const s = r && r.flowBatchState;
      if (s) {
        PERSIST.forEach((id) => { if ($(id) && s[id] != null) $(id).value = s[id]; });
        PERSIST_CHK.forEach((id) => { if ($(id) && s[id] != null) $(id).checked = s[id]; });
      }
      const savedMode = (r && r.flowBatchMode) || (s && s.flowBatchMode) || "image";
      setMode(savedMode);
      if (r && r.selectedFolderName) {
        SELECTED_FOLDER_NAME = r.selectedFolderName;
        updateFolderBadge(r.selectedFolderName, false);
      }
      res();
    });
  });
}

document.querySelectorAll("select, input, textarea").forEach((e) => {
  e.addEventListener("change", saveState);
});

async function init() {
  try {
    const res = await fetch(chrome.runtime.getURL("prompts.json"));
    DATA = await res.json();
    $("loaded").textContent = `${DATA.meta.collections} collections · ${DATA.meta.total_prompts} prompts`;
    const sel = $("collection");
    if (sel) {
      for (const c of DATA.collections) {
        const o = document.createElement("option");
        o.value = c.collection;
        o.textContent = `${c.collection} (${c.listing_id})`;
        sel.appendChild(o);
      }
    }
  } catch (e) {
    DATA = null;
    $("loaded").textContent = "Paste your prompts to start";
    const bundled = $("source") ? $("source").querySelector('option[value="bundled"]') : null;
    if (bundled) bundled.remove();
  }

  await restoreState();

  // Restore stored directory handle from IndexedDB
  try {
    const storedHandle = await getStoredHandle();
    if (storedHandle) {
      DIRECTORY_HANDLE = storedHandle;
      SELECTED_FOLDER_NAME = storedHandle.name;
      try {
        const perm = await storedHandle.queryPermission({ mode: "readwrite" });
        updateFolderBadge(storedHandle.name, perm === "granted");
      } catch (_) {
        updateFolderBadge(storedHandle.name, true);
      }
    }
  } catch (_) {}

  const srcEl = $("source");
  if (srcEl) {
    srcEl.addEventListener("change", () => {
      const isPaste = srcEl.value === "paste";
      if ($("pasteBlock")) $("pasteBlock").style.display = isPaste ? "" : "none";
      if ($("bundledBlock")) $("bundledBlock").style.display = isPaste ? "none" : "";
      loadPromptsIntoQueue();
    });
  }

  loadPromptsIntoQueue();
}

init();
