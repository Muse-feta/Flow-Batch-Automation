/* ZIPCushions Flow Automation — service worker / queue orchestrator. */
"use strict";

// Mode / aspect / outputs / model are chosen by the user in Flow's own UI — the
// extension no longer sets them. Only run/wait/download behaviour lives here.
const DEFAULTS = {
  waitMode: "fast",     // "fast"/"auto": wait for each prompt to finish; "fixed"; "manual"
  delaySec: 45,         // used when waitMode === "fixed"
  pollTimeoutSec: 240,  // max wait for one prompt to finish before moving on
  gapSec: 2,            // pause between prompts
  autoDownload: true,   // download each result into the run folder
  upscale: false,       // images only: upscale to 2048px (interpolated) before saving
  folder: "Flow-Automation",
};

// Download one media URL with the given filename; optionally upscale images first.
// Handles http/https directly, converts blob: URLs in page context, and retries with
// page-context dataURL if network/CORS fails.
async function downloadOne(tabId, url, filename, upscale) {
  let dlUrl = url;
  if (upscale) {
    const up = await send(tabId, { cmd: "upscale", url, size: 2048 });
    if (up && up.ok && up.dataUrl) dlUrl = up.dataUrl;
  }

  // If the URL is a blob: URL (Chrome downloads API cannot download foreign blobs),
  // convert it to a data URL inside the page context first:
  if (dlUrl.startsWith("blob:")) {
    const bres = await send(tabId, { cmd: "fetchBlobAsDataUrl", url: dlUrl });
    if (bres && bres.ok && bres.dataUrl) {
      dlUrl = bres.dataUrl;
    }
  }

  const doDownload = (targetUrl) => {
    return new Promise((res) => {
      PENDING_NAMES.push(filename);
      try {
        chrome.downloads.download(
          { url: targetUrl, filename, conflictAction: "uniquify", saveAs: false },
          (id) => {
            if (chrome.runtime.lastError || id == null) {
              const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : "Download ID is null";
              console.warn("[Flow Batch] chrome.downloads.download failed:", err, "targetUrl:", targetUrl ? targetUrl.slice(0, 100) : "empty");
              const idx = PENDING_NAMES.indexOf(filename);
              if (idx !== -1) PENDING_NAMES.splice(idx, 1);
              res(false);
            } else {
              res(true);
            }
          }
        );
      } catch (e) {
        console.warn("[Flow Batch] chrome.downloads.download exception:", e);
        const idx = PENDING_NAMES.indexOf(filename);
        if (idx !== -1) PENDING_NAMES.splice(idx, 1);
        res(false);
      }
    });
  };

  let ok = await doDownload(dlUrl);

  // If download failed (e.g. auth/CORS restriction on http/https URL),
  // fetch as data URL within the tab session and retry:
  if (!ok && !dlUrl.startsWith("data:")) {
    console.log("[Flow Batch] Direct download failed, attempting fetchBlobAsDataUrl retry...");
    const bres = await send(tabId, { cmd: "fetchBlobAsDataUrl", url });
    if (bres && bres.ok && bres.dataUrl) {
      ok = await doDownload(bres.dataUrl);
    }
  }

  return ok;
}

// Save one result robustly: direct download first, then page context dataURL, then UI menu fallback.
async function saveMedia(tabId, tileIndex, url, filename, upscale, isVideo) {
  let ok = false;
  if (url) {
    try {
      ok = await downloadOne(tabId, url, filename, upscale);
    } catch (e) {
      console.warn("[Flow Batch] direct download error:", e);
    }
  }
  if (!ok && !isVideo && tileIndex >= 0) {
    try {
      ok = await cdpDownloadTile(tabId, tileIndex, filename);
    } catch (e) {
      console.warn("[Flow Batch] cdpDownloadTile error:", e);
    }
  }
  return ok;
}

// ---- Phase 2: rename downloads as they fire -------------------------------
let PENDING_NAMES = []; // FIFO of suggested filenames for upcoming Flow downloads

function sanitize(s) {
  let clean = String(s || "")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[._]+|[._]+$/g, "");
  if (clean.length > 60) clean = clean.slice(0, 60).trim();
  return clean;
}
// A filesystem-safe timestamp, e.g. "2026-07-16_1606-42" — used to give every
// run its own download folder so results never mix with a previous run's images.
function stampNow() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (PENDING_NAMES.length) {
    const filename = PENDING_NAMES.shift(); // full "folder/.../name.ext"
    suggest({ filename, conflictAction: "uniquify" });
    return true;
  }
  return false;
});

let RUN = null; // { queue:[{collection,listing_id,n,label,prompt}], i, tabId, paused, stopped, cfg, log:[] }

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Trusted typing via the Debugger (CDP) --------------------------------
// Flow's prompt editor ignores synthetic key events; only TRUSTED input works.
// chrome.debugger lets us send real keystrokes (this is what triggers Chrome's
// "extension is debugging this browser" banner while a run is active).
let ATTACHED = null; // tabId currently attached, or null

function dbgCmd(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(res);
    });
  });
}
function dbgAttach(tabId) {
  return new Promise((resolve, reject) => {
    if (ATTACHED === tabId) return resolve();
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      ATTACHED = tabId;
      resolve();
    });
  });
}
function dbgDetach() {
  return new Promise((resolve) => {
    if (ATTACHED == null) return resolve();
    const id = ATTACHED; ATTACHED = null;
    chrome.debugger.detach({ tabId: id }, () => resolve());
  });
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId === ATTACHED) ATTACHED = null; });

async function cdpClick(tabId, x, y) {
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
async function cdpHover(tabId, x, y) {
  await dbgCmd(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
}
// Download one tile (by grid index, 0 = newest) with a trusted hover→⋮→Download
// sequence, naming the file via PENDING_NAMES + the onDeterminingFilename hook.
// `filename` is the full "folder/.../name.ext" path.
async function cdpDownloadTile(tabId, index, filename) {
  try {
    const tr = await send(tabId, { cmd: "tileRect", index });
    if (!tr.ok) return false;
    await cdpHover(tabId, tr.x, tr.y); await sleep(350);           // real hover reveals controls
    const mr = await send(tabId, { cmd: "moreRect", index });
    if (!mr.ok) return false;
    await cdpClick(tabId, mr.x, mr.y); await sleep(450);           // open ⋮ menu
    const dr = await send(tabId, { cmd: "downloadItemRect" });
    if (!dr.ok) { await send(tabId, { cmd: "dismiss" }); return false; }
    PENDING_NAMES = [filename];
    await cdpClick(tabId, dr.x, dr.y); await sleep(1200);          // click Download (wait for onDeterminingFilename)
    return true;
  } catch (e) {
    try { await send(tabId, { cmd: "dismiss" }); } catch (_) {}
    return false;
  }
}
async function cdpType(tabId, x, y, text) {
  await dbgAttach(tabId);
  try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}
  if (typeof x === "number") await cdpClick(tabId, x, y); // ensure the editor is focused (trusted)
  await dbgCmd(tabId, "Input.insertText", { text });     // trusted text insertion
}
async function cdpEnter(tabId) {
  await dbgAttach(tabId);
  const k = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyDown", ...k });
  await dbgCmd(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...k });
}

function send(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(resp || { ok: false, error: "no response" });
    });
  });
}

function emit(evt) {
  chrome.runtime.sendMessage({ type: "progress", ...evt }).catch(() => {});
}

async function findFlowTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://labs.google/fx/tools/flow*", "https://flow.google.com/*"],
  });
  if (tabs && tabs.length) return tabs[0];
  const allTabs = await chrome.tabs.query({});
  return allTabs.find((t) => t.url && (/flow\.google\.com/i.test(t.url) || /labs\.google\/fx\/tools\/flow/i.test(t.url))) || null;
}

async function waitForCompletion(tabId, cfg, mediaBefore, beforeTopUrl) {
  if (RUN.stopped || RUN.skipWait) return;

  if (cfg.waitMode === "manual") {
    RUN.awaitingManual = true;
    emit({ kind: "await-manual" });
    while (RUN && RUN.awaitingManual && !RUN.stopped && !RUN.skipWait) {
      await sleep(250);
    }
    return;
  }

  // Poll for generation to complete (stop button gone / agent idle)
  const pollDeadline = Date.now() + (cfg.pollTimeoutSec || 240) * 1000;
  let startedGenerating = false;

  // Wait briefly (up to 3s) for generation to kick off
  for (let s = 0; s < 6; s++) {
    if (RUN.stopped || RUN.skipWait) return;
    const st = await send(tabId, { cmd: "status" });
    if (st.ok && st.generating) {
      startedGenerating = true;
      break;
    }
    await sleep(500);
  }

  // Wait until generation finishes (Stop button disappears / prompt box returns)
  while (Date.now() < pollDeadline) {
    if (RUN.stopped || RUN.skipWait) return;
    const st = await send(tabId, { cmd: "status" });
    if (st.ok) {
      if (st.generating) {
        startedGenerating = true;
      } else if (startedGenerating || !st.generating) {
        console.log("[Flow Batch] Generation finished (stop button cleared). Actively polling for new image...");
        break;
      }
    }
    await sleep(500);
  }

  // Once generation finishes, poll every 500ms (up to 5s max) until res.images.length > beforeCount
  // or until the top image URL updates:
  const settleDeadline = Date.now() + 5000;
  while (Date.now() < settleDeadline) {
    if (RUN.stopped || RUN.skipWait) return;
    const m = await send(tabId, { cmd: "mediaItems" });
    if (m.ok) {
      const curCount = (m.images || []).length + (m.videos || []).length;
      const topUrl = (m.images && m.images[0] && m.images[0].src) || (m.videos && m.videos[0]) || "";
      if (curCount > mediaBefore || (topUrl && topUrl !== beforeTopUrl)) {
        console.log(`[Flow Batch] New image appeared! (Count: ${mediaBefore} -> ${curCount}). Immediately triggering download.`);
        return;
      }
    }
    await sleep(500);
  }
}

async function runLoop() {
  const cfg = RUN.cfg;
  const tabId = RUN.tabId;

  // Mode / aspect / outputs / model are whatever the user set in Flow's own UI —
  // the extension no longer configures those. But we DO force "Confirm before
  // generating → Never", otherwise the Agent just asks for confirmation and never
  // generates (the batch would time out with nothing saved).
  let ag = { ok: false };
  for (let a = 0; a < 3 && !ag.ok; a++) { ag = await send(tabId, { cmd: "autogen" }); if (!ag.ok) await sleep(700); }
  if (!ag.ok) emit({ kind: "warn", message: "couldn't set auto-generate — set 'Confirm before generating: Never' in Flow's tune (⚙) settings, or it may stall" });
  else if (ag.skipped) emit({ kind: "info", message: "✓ Flow settings chip detected · continuing batch with current settings" });
  else emit({ kind: "info", message: "✓ auto-generate on · using Flow's Mode/Aspect/Outputs/Model" });

  // Connect trusted typing up front so failures are obvious (and not silent).
  try {
    await dbgAttach(tabId);
    emit({ kind: "info", message: "✓ trusted typing connected (debugger)" });
  } catch (e) {
    emit({ kind: "error", message: "can't connect trusted typing: " + e.message + " — CLOSE DevTools on the Flow tab (and any other debugger), then retry" });
    await dbgDetach();
    RUN.running = false;
    emit({ kind: "stopped", index: RUN.i, total: RUN.queue.length });
    return;
  }

  // Download the media a single job just produced. Compares media before and after to download new assets.
  async function downloadJob(job, beforeMedia) {
    if (!cfg.autoDownload) return;
    const tag = job.customTag || String(job.n).padStart(2, "0");

    await sleep(250); // slight pause to ensure DOM handles final paint

    const mres = await send(tabId, { cmd: "mediaItems" });
    const currentImages = (mres.ok && mres.images) || []; // [{src,name}], newest-first
    const currentVideos = (mres.ok && mres.videos) || []; // [src], newest-first

    const prevImages = (beforeMedia && beforeMedia.images) || [];
    const prevVideos = (beforeMedia && beforeMedia.videos) || [];
    const prevUrls = new Set(prevImages.map((i) => i.src).filter(Boolean).concat(prevVideos.filter(Boolean)));

    // 1) Explicitly log number of images found before vs after generation
    console.log(`[Flow Batch] #${job.n} (${tag}) Media count: before=${prevImages.length} img, ${prevVideos.length} vid vs after=${currentImages.length} img, ${currentVideos.length} vid`);
    emit({
      kind: "info",
      message: `Media count: before=${prevImages.length} img → after=${currentImages.length} img`,
    });

    // 2) Find newly added items by URL difference
    let newImgItems = currentImages.filter((i) => i.src && !prevUrls.has(i.src));
    let newVidItems = currentVideos.filter((v) => v && !prevUrls.has(v));

    // Fallback: if URL diff is empty but count increased, take newest items from top
    if (newImgItems.length === 0 && currentImages.length > prevImages.length) {
      newImgItems = currentImages.slice(0, currentImages.length - prevImages.length);
    }
    if (newVidItems.length === 0 && currentVideos.length > prevVideos.length) {
      newVidItems = currentVideos.slice(0, currentVideos.length - prevVideos.length);
    }

    // 3) DO NOT abort if the diff returns 0 items: grab top-most visible image
    if (newImgItems.length === 0 && newVidItems.length === 0) {
      if (currentImages.length > 0) {
        console.log("[Flow Batch] Diff returned 0 items; grabbing top-most image (currentImages[0])");
        emit({ kind: "info", message: "Diff was 0 — grabbing newest visible image on canvas" });
        newImgItems = [currentImages[0]];
      } else if (currentVideos.length > 0) {
        console.log("[Flow Batch] Diff returned 0 items; grabbing top-most video (currentVideos[0])");
        emit({ kind: "info", message: "Diff was 0 — grabbing newest visible video on canvas" });
        newVidItems = [currentVideos[0]];
      }
    }

    const total = newImgItems.length + newVidItems.length;
    if (total === 0) {
      console.warn(`[Flow Batch] No media found on page at all for #${job.n}`);
      emit({ kind: "warn", message: `no media found on page for #${job.n} — nothing saved` });
      return;
    }

    // Log the exact URL or blob scheme detected
    for (const item of newImgItems) {
      const scheme = item.src ? (item.src.startsWith("data:") ? "data" : item.src.startsWith("blob:") ? "blob" : (item.src.split(":")[0] || "http")) : "none";
      console.log(`[Flow Batch] Detected image (${scheme}:):`, item.src ? item.src.slice(0, 120) : "empty");
      emit({ kind: "info", message: `Detected scheme: ${scheme}: (${(item.src || "").slice(0, 45)}...)` });
    }
    for (const vSrc of newVidItems) {
      const scheme = vSrc ? (vSrc.startsWith("blob:") ? "blob" : (vSrc.split(":")[0] || "http")) : "none";
      console.log(`[Flow Batch] Detected video (${scheme}:):`, vSrc ? vSrc.slice(0, 120) : "empty");
      emit({ kind: "info", message: `Detected video scheme: ${scheme}:` });
    }

    const timestamp = (RUN && RUN.timestamp) || stampNow();
    const folder = (cfg && cfg.folder) || "Flow-Automation";

    let done = 0, seq = 0;
    const one = async (tileIndex, url, name, ext, isVideo) => {
      seq++;
      const fileName = total > 1 ? `${tag}__v${seq}${ext}` : `${tag}${ext}`;
      const filename = `${folder}/${timestamp}/${fileName}`;

      emit({ kind: "info", message: `Downloading: ${fileName}...` });
      console.log(`[Flow Batch] Saving ${filename} from:`, url ? url.slice(0, 100) : "empty");

      const saved = await saveMedia(tabId, tileIndex, url, filename, cfg.upscale && !isVideo, isVideo);
      if (saved) {
        done++;
      } else {
        console.warn("[Flow Batch] Download failed for:", filename);
        emit({ kind: "warn", message: "download failed: " + fileName });
      }
      await sleep(100);
    };

    for (let k = 0; k < newImgItems.length; k++) {
      await one(k, newImgItems[k].src, newImgItems[k].name, ".png", false);
    }
    for (let k = 0; k < newVidItems.length; k++) {
      await one(k, newVidItems[k], "", ".mp4", true);
    }

    emit({ kind: "info", message: `✓ saved ${done}/${total} → Downloads/${folder}/${timestamp}/` });
  }

  for (; RUN.i < RUN.queue.length; RUN.i++) {
    if (RUN.stopped) break;
    while (RUN.paused && !RUN.stopped && !RUN.skipWait) await sleep(250);
    if (RUN.stopped) break;

    RUN.skipWait = false;
    const job = RUN.queue[RUN.i];

    // Ensure customTag exists
    if (!job.customTag) {
      const tagMatch = (job.prompt || "").match(/^(?:#?\s*)(\d+[-_]\d+)/) ||
                       ((job.label || "").match(/^(?:#?\s*)(\d+[-_]\d+)/));
      if (tagMatch) {
        job.customTag = tagMatch[1];
        job.prompt = job.prompt.replace(/^(?:#?\s*)\d+[-_]\d+[\s\:\-\.]*/i, "").trim();
      } else {
        job.customTag = String(job.n || (RUN.i + 1)).padStart(2, "0");
      }
    }

    emit({ kind: "start", index: RUN.i, total: RUN.queue.length, job });

    // 0) dismiss any stray menu/popover left open from the previous prompt
    await send(tabId, { cmd: "dismiss" });
    try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}

    // Snapshot media BEFORE submitting this prompt
    const beforeMediaRes = await send(tabId, { cmd: "mediaItems" });
    const beforeMedia = {
      images: (beforeMediaRes.ok && beforeMediaRes.images) || [],
      videos: (beforeMediaRes.ok && beforeMediaRes.videos) || [],
    };
    const beforeMediaCount = beforeMedia.images.length + beforeMedia.videos.length;
    const beforeTopUrl = (beforeMedia.images[0] && beforeMedia.images[0].src) || beforeMedia.videos[0] || "";

    // 1) focus + clear the prompt box (content script), get its center point
    const f = await send(tabId, { cmd: "focusPrompt" });
    if (!f.ok) {
      emit({ kind: "error", index: RUN.i, job, message: "focus: " + f.error });
      await sleep(cfg.gapSec * 1000);
      continue;
    }
    // 2) type the prompt with TRUSTED keystrokes (debugger), then verify it landed.
    const promptKey = job.prompt.slice(0, 24).toLowerCase();
    const didType = async () => {
      const r = await send(tabId, { cmd: "readPrompt" });
      return r.ok && (r.text || "").includes(promptKey);
    };
    let typed = false;
    for (let a = 0; a < 3 && !typed && !RUN.stopped && !RUN.skipWait; a++) {
      if (a > 0) {
        await send(tabId, { cmd: "dismiss" });
        const rf = await send(tabId, { cmd: "focusPrompt" });
        if (rf.ok) { f.x = rf.x; f.y = rf.y; }
        await sleep(250);
      }
      try { await cdpType(tabId, f.x, f.y, job.prompt); }
      catch (e) { emit({ kind: "warn", message: "type (debugger): " + e.message }); }
      await sleep(350);
      typed = await didType();
      if (!typed) {
        // Fallback: direct synthetic injection via content script
        await send(tabId, { cmd: "typePrompt", text: job.prompt });
        await sleep(250);
        typed = await didType();
      }
    }
    if (RUN.skipWait) {
      continue;
    }
    if (!typed) {
      emit({ kind: "error", index: RUN.i, job, message: "prompt didn't type into Flow — skipping (make sure the Flow tab is the active/focused window)" });
      await send(tabId, { cmd: "dismiss" });
      await sleep(cfg.gapSec * 1000);
      continue;
    }
    // submit as a TRUSTED click; confirm success by the prompt box CLEARING
    const boxCleared = async () => {
      const r = await send(tabId, { cmd: "readPrompt" });
      return r.ok && !(r.text || "").includes(promptKey);
    };
    let submitted = false;
    for (let attempt = 0; attempt < 6 && !submitted && !RUN.stopped && !RUN.skipWait; attempt++) {
      for (let w = 0; w < 12; w++) { const se = await send(tabId, { cmd: "submitEnabled" }); if (se.ok && se.enabled) break; await sleep(200); }
      const sr = await send(tabId, { cmd: "submitRect" });
      if (sr.ok) { try { await cdpClick(tabId, sr.x, sr.y); } catch (e) {} }
      for (let t = 0; t < 8 && !submitted && !RUN.skipWait; t++) { await sleep(300); if (await boxCleared()) submitted = true; }
      if (submitted || RUN.skipWait) break;
      const pr = await send(tabId, { cmd: "promptRect" });
      if (pr.ok) { try { await cdpClick(tabId, pr.x, pr.y); await sleep(100); await cdpEnter(tabId); } catch (e) {} }
      for (let t = 0; t < 6 && !submitted && !RUN.skipWait; t++) { await sleep(300); if (await boxCleared()) submitted = true; }
    }
    if (RUN.skipWait) {
      continue;
    }
    if (!submitted) {
      emit({ kind: "error", index: RUN.i, job, message: "couldn't submit after retries — skipping this prompt" });
      await send(tabId, { cmd: "dismiss" });
      await sleep(cfg.gapSec * 1000);
      continue;
    }
    RUN.submitted.push(job);

    // Active polling for completion without long static delays
    await waitForCompletion(tabId, cfg, beforeMediaCount, beforeTopUrl);
    if (!RUN.stopped && !RUN.skipWait) {
      await downloadJob(job, beforeMedia);
    }

    emit({ kind: "done", index: RUN.i, job });
    if (!RUN.skipWait) {
      await sleep(cfg.gapSec * 1000);
    }
  }

  await dbgDetach(); // remove the "being debugged" banner
  const finished = RUN.i >= RUN.queue.length;
  emit({ kind: finished ? "finished" : "stopped", index: RUN.i, total: RUN.queue.length });
  RUN.running = false;
}

// Manual download triggered from the side panel UI
async function handleManualDownload(mode /* "latest" | "all" */, requestedTag) {
  const tab = await findFlowTab();
  if (!tab) {
    emit({ kind: "warn", message: "No Google Flow tab found." });
    return { ok: false, error: "Open a Google Flow project tab first." };
  }

  const mres = await send(tab.id, { cmd: "mediaItems" });
  const images = (mres.ok && mres.images) || [];
  const videos = (mres.ok && mres.videos) || [];

  console.log(`[Flow Batch] handleManualDownload (${mode}): found ${images.length} images, ${videos.length} videos`);
  emit({ kind: "info", message: `Found ${images.length} images, ${videos.length} videos on canvas` });

  if (images.length === 0 && videos.length === 0) {
    emit({ kind: "warn", message: "No visible images or videos detected on Flow canvas." });
    return { ok: false, error: "No media detected on Flow canvas." };
  }

  const timestamp = (RUN && RUN.timestamp) || stampNow();
  const folder = (RUN && RUN.folder) || "Flow-Automation";
  const currentJob = (RUN && RUN.queue && RUN.queue[RUN.i]) ? RUN.queue[RUN.i] : null;

  if (mode === "latest") {
    const tag = requestedTag || (currentJob && currentJob.customTag) || `image_${Date.now()}`;
    if (images.length > 0) {
      const item = images[0];
      const fileName = `${tag}.png`;
      const filename = `${folder}/${timestamp}/${fileName}`;
      console.log(`[Flow Batch] Manual download latest: ${filename}, src:`, item.src ? item.src.slice(0, 100) : "empty");
      emit({ kind: "info", message: `Downloading latest image: ${fileName}...` });
      const saved = await saveMedia(tab.id, 0, item.src, filename, false, false);
      if (saved) {
        emit({ kind: "info", message: `✓ Downloaded latest: ${fileName}` });
        return { ok: true, filename };
      } else {
        emit({ kind: "warn", message: "Failed to download latest image" });
        return { ok: false, error: "Failed to download image file" };
      }
    } else {
      const vidSrc = videos[0];
      const fileName = `${tag}.mp4`;
      const filename = `${folder}/${timestamp}/${fileName}`;
      emit({ kind: "info", message: `Downloading latest video: ${fileName}...` });
      const saved = await saveMedia(tab.id, 0, vidSrc, filename, false, true);
      if (saved) {
        emit({ kind: "info", message: `✓ Downloaded latest video: ${fileName}` });
        return { ok: true, filename };
      } else {
        return { ok: false, error: "Failed to download video file" };
      }
    }
  }

  // mode === "all"
  emit({ kind: "info", message: `Starting download of all ${images.length + videos.length} visible items...` });
  let count = 0;
  for (let i = 0; i < images.length; i++) {
    const item = images[i];
    const qJob = (RUN && RUN.queue && RUN.queue[i]) ? RUN.queue[i] : null;
    const tag = (qJob && qJob.customTag) ? qJob.customTag : String(i + 1).padStart(2, "0");
    const fileName = `${tag}.png`;
    const filename = `${folder}/${timestamp}/${fileName}`;
    emit({ kind: "info", message: `[${i + 1}/${images.length}] Downloading: ${fileName}...` });
    const saved = await saveMedia(tab.id, i, item.src, filename, false, false);
    if (saved) count++;
    await sleep(100);
  }
  for (let i = 0; i < videos.length; i++) {
    const vidSrc = videos[i];
    const nn = String(images.length + i + 1).padStart(2, "0");
    const fileName = `video_${nn}.mp4`;
    const filename = `${folder}/${timestamp}/${fileName}`;
    const saved = await saveMedia(tab.id, i, vidSrc, filename, false, true);
    if (saved) count++;
    await sleep(100);
  }
  emit({ kind: "info", message: `✓ Saved ${count}/${images.length + videos.length} items → Downloads/${folder}/${timestamp}/` });
  return { ok: true, count };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const action = msg.type || msg.cmd;
    switch (action) {
      case "start": {
        const tab = await findFlowTab();
        if (!tab) return sendResponse({ ok: false, error: "Open a Google Flow project tab first." });
        let ping = await send(tab.id, { cmd: "ping" });
        if (!ping.ok) {
          // Adapter not live in this tab (common after reloading the unpacked
          // extension while the Flow tab was already open — Chrome doesn't
          // retroactively inject content scripts). Force-inject and retry.
          try {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["flow-adapter.js"] });
            await sleep(300);
          } catch (e) {
            return sendResponse({ ok: false, error: "Couldn't inject Flow adapter: " + e.message + " — reload the Flow tab." });
          }
          ping = await send(tab.id, { cmd: "ping" });
          if (!ping.ok) return sendResponse({ ok: false, error: "Flow adapter not loaded — reload the Flow tab." });
        }
        if (!ping.project) return sendResponse({ ok: false, error: "Open a Flow PROJECT (click New project), then start." });
        const cfg = { ...DEFAULTS, ...(msg.cfg || {}) };
        const ts = stampNow();
        RUN = {
          queue: msg.queue, i: msg.startIndex || 0, tabId: tab.id,
          paused: false, stopped: false, running: true, submitted: [],
          cfg, timestamp: ts, folder: cfg.folder || "Flow-Automation",
          runDir: (cfg.folder || "Flow-Automation") + "/" + ts,
        };
        runLoop();
        return sendResponse({ ok: true, count: msg.queue.length });
      }
      case "pause": if (RUN) RUN.paused = true; return sendResponse({ ok: true });
      case "resume": if (RUN) RUN.paused = false; return sendResponse({ ok: true });
      case "skipNext":
      case "manualNext": {
        if (RUN) {
          RUN.awaitingManual = false;
          RUN.skipWait = true;
          RUN.paused = false;
          console.log("[Flow Batch] Next / Skip requested for prompt index", RUN.i);
          emit({ kind: "info", message: "⏭ Advancing to next prompt..." });
        }
        return sendResponse({ ok: true });
      }
      case "stop": if (RUN) { RUN.stopped = true; RUN.awaitingManual = false; } dbgDetach(); return sendResponse({ ok: true });
      case "state":
        return sendResponse({ ok: true, running: !!(RUN && RUN.running), i: RUN ? RUN.i : 0, paused: RUN ? RUN.paused : false });
      case "downloadLatestManual": {
        const res = await handleManualDownload("latest", msg.customTag);
        return sendResponse(res);
      }
      case "downloadAllManual": {
        const res = await handleManualDownload("all");
        return sendResponse(res);
      }
      default:
        return sendResponse({ ok: false, error: "unknown type: " + action });
    }
  })();
  return true;
});
