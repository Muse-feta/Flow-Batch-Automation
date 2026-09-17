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
// Returns true only if Chrome accepted the download (id assigned, no lastError).
async function downloadOne(tabId, url, filename, upscale) {
  let dlUrl = url;
  if (upscale) {
    const up = await send(tabId, { cmd: "upscale", url, size: 2048 });
    if (up && up.ok && up.dataUrl) dlUrl = up.dataUrl;
  }
  // Force our exact folder + name. These media URLs (getMediaUrlRedirect) send their
  // own Content-Disposition, so without overriding via onDeterminingFilename Chrome
  // drops the file in the Downloads ROOT under a server-chosen name. saveAs:false
  // also stops the "ask where to save" dialog from ignoring the subfolder path.
  PENDING_NAMES = [filename]; // full "folder/.../name.ext"
  return await new Promise((res) => {
    try {
      chrome.downloads.download({ url: dlUrl, filename, conflictAction: "uniquify", saveAs: false }, (id) => {
        res(!chrome.runtime.lastError && id != null);
      });
    } catch (e) { PENDING_NAMES = []; res(false); }
  });
}

// Save one result robustly: try the direct media URL first; if Chrome rejects it
// (auth/redirect issues), fall back to Flow's own "Download" button via the debugger
// (trusted), naming the file through PENDING_NAMES + onDeterminingFilename.
async function saveMedia(tabId, tileIndex, url, base, ext, upscale, isVideo) {
  let ok = false;
  if (url) { try { ok = await downloadOne(tabId, url, base + ext, upscale); } catch (e) {} }
  if (!ok && !isVideo && tileIndex >= 0) {
    try { ok = await cdpDownloadTile(tabId, tileIndex, base + ext); } catch (e) {}
  }
  return ok;
}

// ---- Phase 2: rename downloads as they fire -------------------------------
let PENDING_NAMES = []; // FIFO of suggested filenames for upcoming Flow downloads

function sanitize(s) {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}
// A filesystem-safe timestamp, e.g. "2026-07-16_1606-42" — used to give every
// run its own download folder so results never mix with a previous run's images.
function stampNow() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (!PENDING_NAMES.length) return false; // not ours / nothing queued
  const filename = PENDING_NAMES.shift(); // full "folder/.../name.ext" — overrides server name
  suggest({ filename, conflictAction: "uniquify" });
  return true;
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
  const tabs = await chrome.tabs.query({ url: "https://labs.google/fx/tools/flow*" });
  return tabs[0] || null;
}

async function waitForCompletion(tabId, cfg, mediaBefore) {
  if (cfg.waitMode === "manual") {
    RUN.awaitingManual = true;
    emit({ kind: "await-manual" });
    while (RUN && RUN.awaitingManual && !RUN.stopped) await sleep(500);
    return;
  }
  if (cfg.waitMode === "fixed") {
    for (let s = 0; s < cfg.delaySec; s++) {
      if (RUN.stopped) return;
      await sleep(1000);
    }
    return;
  }
  // auto: poll until TOTAL media (images + videos) grows past `mediaBefore` and
  // generating clears, or timeout. Counting both types means we don't need to know
  // in advance whether the user set Flow to Image or Video.
  const deadline = Date.now() + cfg.pollTimeoutSec * 1000;
  let grew = false;
  await sleep(2500); // let the request kick off
  while (Date.now() < deadline) {
    if (RUN.stopped) return;
    const st = await send(tabId, { cmd: "status" });
    if (st.ok) {
      if ((st.media || 0) + (st.videos || 0) > mediaBefore) grew = true;
      if (grew && !st.generating) { await sleep(1500); return; }
    }
    await sleep(2500);
  }
  emit({ kind: "warn", message: "poll timeout — moving on" });
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

  // Download the media a single job just produced. Called right after the job
  // finishes, so its outputs are simply the newest `n` tiles (0 = newest) — no
  // fragile indexing into the whole (accumulating) grid, and no risk of grabbing
  // an older image. Everything lands in this run's own folder (RUN.runDir).
  async function downloadJob(job, beforeImg, beforeVid) {
    if (!cfg.autoDownload) return;
    const coll = sanitize(job.collection) || "custom";
    const nn = String(job.n).padStart(2, "0");
    const fallbackLbl = sanitize(job.label) || sanitize(job.prompt.slice(0, 40)) || "img";
    const mres = await send(tabId, { cmd: "mediaItems" });
    const images = (mres.ok && mres.images) || []; // [{src,name}], newest-first
    const videos = (mres.ok && mres.videos) || []; // [src], newest-first
    // Save only what THIS job added — never fall back to an older file (guards the
    // timeout case). We don't rely on a preset Outputs count: whatever Flow made,
    // we save. Auto-detects image vs video from which list grew.
    const newImg = Math.max(0, images.length - (beforeImg || 0));
    const newVid = Math.max(0, videos.length - (beforeVid || 0));
    const total = newImg + newVid;
    if (total === 0) { emit({ kind: "warn", message: `no new media for #${job.n} — nothing saved (generation failed/timed out?)` }); return; }
    let done = 0, seq = 0;
    // Name each file after Flow's own caption for that image; fall back to the
    // prompt label. Prefix with the queue number so files sort in run order.
    const one = async (tileIndex, url, name, ext, isVideo) => {
      seq++;
      const nm = sanitize(name) || fallbackLbl;
      const suffix = total > 1 ? `__v${seq}` : "";
      const base = `${RUN.runDir}/${coll}/${nn}_${nm}${suffix}`;
      const saved = await saveMedia(tabId, tileIndex, url, base, ext, cfg.upscale && !isVideo, isVideo);
      if (saved) done++; else emit({ kind: "warn", message: "download failed: " + base.split("/").pop() });
      await sleep(120);
    };
    for (let k = 0; k < newImg; k++) await one(k, images[k].src, images[k].name, ".jpg", false); // k: 0 = newest
    for (let k = 0; k < newVid; k++) await one(k, videos[k], "", ".mp4", true);
    emit({ kind: "info", message: `✓ saved ${done}/${total} → Downloads/${RUN.runDir}/${coll}/` });
  }

  for (; RUN.i < RUN.queue.length; RUN.i++) {
    if (RUN.stopped) break;
    while (RUN.paused && !RUN.stopped) await sleep(400);
    if (RUN.stopped) break;

    const job = RUN.queue[RUN.i];
    emit({ kind: "start", index: RUN.i, total: RUN.queue.length, job });

    // 0) dismiss any stray menu/popover left open from the previous prompt
    await send(tabId, { cmd: "dismiss" });

    // 1) focus + clear the prompt box (content script), get its center point
    const f = await send(tabId, { cmd: "focusPrompt" });
    if (!f.ok) {
      emit({ kind: "error", index: RUN.i, job, message: "focus: " + f.error });
      await sleep(cfg.gapSec * 1000); continue;
    }
    // 2) type the prompt with TRUSTED keystrokes (debugger), then verify it landed.
    //    Retry with a fresh focus a few times — the fresh "Untitled session"
    //    composer sometimes drops the first insert — and SKIP (not kill the run)
    //    if it never takes.
    const promptKey = job.prompt.slice(0, 24).toLowerCase();
    const didType = async () => {
      const r = await send(tabId, { cmd: "readPrompt" });
      return r.ok && (r.text || "").includes(promptKey);
    };
    let typed = false;
    for (let a = 0; a < 3 && !typed && !RUN.stopped; a++) {
      if (a > 0) { // re-focus + clear before re-typing
        await send(tabId, { cmd: "dismiss" });
        const rf = await send(tabId, { cmd: "focusPrompt" });
        if (rf.ok) { f.x = rf.x; f.y = rf.y; }
        await sleep(250);
      }
      try { await cdpType(tabId, f.x, f.y, job.prompt); }
      catch (e) { emit({ kind: "warn", message: "type (debugger): " + e.message }); }
      await sleep(400);
      typed = await didType();
    }
    if (!typed) {
      emit({ kind: "error", index: RUN.i, job, message: "prompt didn't type into Flow — skipping (make sure the Flow tab is the active/focused window)" });
      await send(tabId, { cmd: "dismiss" });
      await sleep(cfg.gapSec * 1000);
      continue; // one stuck prompt must never kill the whole run
    }
    // submit as a TRUSTED click; confirm success by the prompt box CLEARING
    // (Flow empties the box once a generation is accepted — the reliable signal).
    const boxCleared = async () => {
      const r = await send(tabId, { cmd: "readPrompt" });
      return r.ok && !(r.text || "").includes(promptKey);
    };
    // Right after a prior generation kicks off, the prompt bar can shift or the submit
    // arrow disables for a moment — so RETRY: wait for the button to be enabled, re-fetch
    // its rect (layout moves), click it, and interleave a trusted Enter (after re-focusing
    // the box, no clear) as a fallback. This is what makes long 50+ runs reliable.
    let submitted = false;
    for (let attempt = 0; attempt < 6 && !submitted && !RUN.stopped; attempt++) {
      for (let w = 0; w < 12; w++) { const se = await send(tabId, { cmd: "submitEnabled" }); if (se.ok && se.enabled) break; await sleep(250); }
      const sr = await send(tabId, { cmd: "submitRect" });
      if (sr.ok) { try { await cdpClick(tabId, sr.x, sr.y); } catch (e) {} }
      for (let t = 0; t < 8 && !submitted; t++) { await sleep(350); if (await boxCleared()) submitted = true; }
      if (submitted) break;
      const pr = await send(tabId, { cmd: "promptRect" }); // re-focus without clearing, then trusted Enter
      if (pr.ok) { try { await cdpClick(tabId, pr.x, pr.y); await sleep(120); await cdpEnter(tabId); } catch (e) {} }
      for (let t = 0; t < 6 && !submitted; t++) { await sleep(350); if (await boxCleared()) submitted = true; }
    }
    if (!submitted) {
      // SKIP this one and keep going — a single stuck prompt must never kill a big run.
      emit({ kind: "error", index: RUN.i, job, message: "couldn't submit after retries — skipping this prompt" });
      await send(tabId, { cmd: "dismiss" });
      await sleep(cfg.gapSec * 1000);
      continue;
    }
    RUN.submitted.push(job); // confirmed, in submission order (for download naming)

    // FAST mode: Flow's Agent handles ONE request at a time (it "thinks", then
    // generates), so we can't fire prompts in parallel — submitting while it's
    // busy gets dropped. Wait for THIS prompt to finish before the next one.
    // Waits as long as the image needs (up to pollTimeoutSec), not a fixed delay.
    // Wait for THIS prompt to finish (the Agent is one-at-a-time), then save its
    // result immediately into this run's folder before moving to the next prompt.
    const beforeImg = f.before || 0, beforeVid = f.beforeVid || 0;
    await waitForCompletion(tabId, cfg, beforeImg + beforeVid);
    if (!RUN.stopped) await downloadJob(job, beforeImg, beforeVid);

    emit({ kind: "done", index: RUN.i, job });
    await sleep(cfg.gapSec * 1000);
  }

  await dbgDetach(); // remove the "being debugged" banner
  const finished = RUN.i >= RUN.queue.length;
  emit({ kind: finished ? "finished" : "stopped", index: RUN.i, total: RUN.queue.length });
  RUN.running = false;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
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
        RUN = {
          queue: msg.queue, i: msg.startIndex || 0, tabId: tab.id,
          paused: false, stopped: false, running: true, submitted: [],
          cfg, runDir: cfg.folder + "/" + stampNow(), // fresh folder per Start
        };
        runLoop();
        return sendResponse({ ok: true, count: msg.queue.length });
      }
      case "pause": if (RUN) RUN.paused = true; return sendResponse({ ok: true });
      case "resume": if (RUN) RUN.paused = false; return sendResponse({ ok: true });
      case "manualNext": if (RUN) RUN.awaitingManual = false; return sendResponse({ ok: true });
      case "stop": if (RUN) { RUN.stopped = true; RUN.awaitingManual = false; } dbgDetach(); return sendResponse({ ok: true });
      case "state":
        return sendResponse({ ok: true, running: !!(RUN && RUN.running), i: RUN ? RUN.i : 0, paused: RUN ? RUN.paused : false });
      default:
        return sendResponse({ ok: false, error: "unknown type" });
    }
  })();
  return true;
});
