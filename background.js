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

let isAborted = false;
const abortWaiters = new Set();

function sleep(ms) {
  return new Promise((resolve) => {
    if (isAborted || (RUN && RUN.stopped)) return resolve();
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      abortWaiters.delete(onAbort);
      resolve();
    };
    abortWaiters.add(onAbort);
    timer = setTimeout(() => {
      abortWaiters.delete(onAbort);
      resolve();
    }, ms);
  });
}

function cancelActiveDelays() {
  for (const fn of abortWaiters) {
    try { fn(); } catch (_) {}
  }
  abortWaiters.clear();
}

// Download one media URL with the given filename; optionally upscale images first.
// Handles http/https directly, converts blob: URLs in page context, and retries with
// page-context dataURL if network/CORS fails.
async function downloadOne(tabId, url, filename, upscale, isVideo) {
  if (isAborted || (RUN && RUN.stopped)) return { ok: false };

  let dlUrl = url;
  if (!isVideo && upscale) {
    const up = await send(tabId, { cmd: "upscale", url, size: 2048 });
    if (up && up.ok && up.dataUrl) dlUrl = up.dataUrl;
  }

  // Enforce PNG conversion:
  // For images, if the URL is not already a PNG data URL, fetch and convert via canvas
  // in page context to standard image/png data URL. This prevents Chrome from saving as .jfif.
  if (!isVideo) {
    if (!dlUrl.startsWith("data:image/png")) {
      const bres = await send(tabId, { cmd: "fetchBlobAsDataUrl", url: dlUrl });
      if (bres && bres.ok && bres.dataUrl) {
        dlUrl = bres.dataUrl;
      }
    }
  } else if (dlUrl.startsWith("blob:")) {
    const bres = await send(tabId, { cmd: "fetchBlobAsDataUrl", url: dlUrl });
    if (bres && bres.ok && bres.dataUrl) {
      dlUrl = bres.dataUrl;
    }
  }

  if (isAborted || (RUN && RUN.stopped)) return { ok: false, dataUrl: dlUrl };

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
  if (!ok && !dlUrl.startsWith("data:") && !isAborted && (!RUN || !RUN.stopped)) {
    console.log("[Flow Batch] Direct download failed, attempting fetchBlobAsDataUrl retry...");
    const bres = await send(tabId, { cmd: "fetchBlobAsDataUrl", url });
    if (bres && bres.ok && bres.dataUrl) {
      dlUrl = bres.dataUrl;
      ok = await doDownload(bres.dataUrl);
    }
  }

  return { ok: !!ok, dataUrl: dlUrl };
}

// Save one result robustly: direct download first, then page context dataURL, then UI menu fallback.
async function saveMedia(tabId, tileIndex, url, filename, upscale, isVideo) {
  if (isAborted || (RUN && RUN.stopped)) return { ok: false };
  const safeFilename = filename.replace(/\.jfif$/i, ".png");
  let ok = false;
  let savedDataUrl = null;
  if (url) {
    try {
      const res = await downloadOne(tabId, url, safeFilename, upscale, isVideo);
      if (res && res.ok) {
        ok = true;
        savedDataUrl = res.dataUrl;
      }
    } catch (e) {
      console.warn("[Flow Batch] direct download error:", e);
    }
  }
  if (!ok && !isVideo && tileIndex >= 0 && !isAborted && (!RUN || !RUN.stopped)) {
    try {
      const cdpOk = await cdpDownloadTile(tabId, tileIndex, safeFilename);
      if (cdpOk) ok = true;
    } catch (e) {
      console.warn("[Flow Batch] cdpDownloadTile error:", e);
    }
  }
  return { ok: !!ok, dataUrl: savedDataUrl || url, filename: safeFilename };
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

// Resolve and sanitize custom subfolder path from user input.
// Falls back to Flow-Automation/${runTimestamp} if empty or invalid.
function resolveDownloadFolder(cfg, timestamp) {
  const raw = (cfg && (cfg.subfolder || cfg.folder)) ? String(cfg.subfolder || cfg.folder).trim() : "";
  if (!raw) {
    return `Flow-Automation/${timestamp}`;
  }
  const segments = raw
    .replace(/\\+/g, "/")
    .split("/")
    .map((seg) => seg.replace(/[/\\?%*:|"<>]/g, "_").trim().replace(/^[._]+|[._]+$/g, ""))
    .filter(Boolean);

  if (segments.length === 0) {
    return `Flow-Automation/${timestamp}`;
  }
  return segments.join("/");
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
function dbgDetach(tabId = null) {
  return new Promise((resolve) => {
    const id = tabId || ATTACHED;
    if (id == null) return resolve();
    if (ATTACHED === id) ATTACHED = null;
    try {
      chrome.debugger.detach({ tabId: id }, () => {
        // Must read chrome.runtime.lastError to prevent "Unchecked runtime.lastError"
        if (chrome.runtime.lastError) {
          console.debug("[Flow Batch] Detach info (safe):", chrome.runtime.lastError.message);
        }
        resolve();
      });
    } catch (e) {
      resolve();
    }
  });
}
chrome.debugger.onDetach.addListener((src) => {
  if (src && src.tabId === ATTACHED) ATTACHED = null;
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === ATTACHED) ATTACHED = null;
});
chrome.runtime.onSuspend.addListener(() => {
  dbgDetach();
});

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

async function waitForCompletion(tabId, cfg, mediaBefore, beforeTopUrl, beforeUrls = new Set()) {
  if (isAborted || !RUN || RUN.stopped) return { ok: false, error: "Aborted" };
  if (RUN.skipWait) return { ok: false, error: "Skipped by user", skipped: true };

  if (cfg.waitMode === "manual") {
    RUN.awaitingManual = true;
    emit({ kind: "await-manual" });
    while (RUN && RUN.awaitingManual && !isAborted && !RUN.stopped && !RUN.skipWait) {
      await sleep(250);
    }
    if (RUN && RUN.skipWait) return { ok: false, error: "Skipped by user", skipped: true };
    return { ok: true };
  }

  if (cfg.waitMode === "fixed") {
    const waitMs = (cfg.delaySec || 45) * 1000;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (isAborted || !RUN || RUN.stopped) return { ok: false, error: "Aborted" };
      if (RUN.skipWait) return { ok: false, error: "Skipped by user", skipped: true };
      await sleep(500);
    }
    return { ok: true };
  }

  // Poll for generation to complete with sensible timeout (90s for images, 180s for videos)
  const timeoutSec = cfg.mode === "video" ? 180 : (cfg.pollTimeoutSec || 90);
  const pollDeadline = Date.now() + timeoutSec * 1000;
  let startedGenerating = false;

  // Wait briefly (up to 3.5s) for generation to kick off
  for (let s = 0; s < 7; s++) {
    if (isAborted || !RUN || RUN.stopped) return { ok: false, error: "Aborted" };
    if (RUN.skipWait) return { ok: false, error: "Skipped by user", skipped: true };
    const st = await send(tabId, { cmd: "status" });
    if (st.ok) {
      // Only abort early for fatal prompt errors (e.g. empty prompt validation)
      if (st.hasError && (st.errorType === "empty_prompt" || st.errorType === "policy")) {
        return { ok: false, error: st.errorMessage || "Prompt validation failed in Flow" };
      }
      if (st.generating) {
        startedGenerating = true;
        break;
      }
    }
    await sleep(500);
  }

  // Poll until generation finishes or new image appears
  while (Date.now() < pollDeadline) {
    if (isAborted || !RUN || RUN.stopped) return { ok: false, error: "Aborted" };
    if (RUN.skipWait) return { ok: false, error: "Skipped by user", skipped: true };
    const st = await send(tabId, { cmd: "status" });
    const isBusy = st.ok && st.generating;
    if (isBusy) {
      startedGenerating = true;
    }

    // 1. Actively check if a truly NEW generated image is available
    if (cfg.mode !== "video") {
      const gRes = await send(tabId, {
        cmd: "getLatestGeneratedDataUrl",
        beforeTopUrl,
        excludeUrls: Array.from(beforeUrls),
      });
      if (gRes && gRes.ok && gRes.dataUrl && !beforeUrls.has(gRes.src) && gRes.src !== beforeTopUrl) {
        console.log("[Flow Batch] New image rendered on canvas, generation complete.");
        await sleep(400);
        return { ok: true, dataUrl: gRes.dataUrl, src: gRes.src };
      }
    } else {
      const mres = await send(tabId, { cmd: "mediaItems" });
      const currentVideos = (mres.ok && mres.videos) || [];
      const newVid = currentVideos.find((v) => v && !beforeUrls.has(v));
      if (newVid) {
        console.log("[Flow Batch] New video rendered on canvas, generation complete.");
        await sleep(400);
        return { ok: true, isVideo: true, src: newVid };
      }
    }

    // 2. Only fatal policy violations abort during active generation
    if (st.ok && st.hasError && (st.errorType === "policy" || st.errorType === "empty_prompt")) {
      console.warn("[Flow Batch] Flow fatal policy error detected:", st.errorMessage);
      return { ok: false, error: st.errorMessage || "Generation rejected by policy" };
    }

    // 3. Agent finished generating (was busy, now idle)
    if (startedGenerating && !isBusy) {
      console.log("[Flow Batch] Generation status cleared (agent idle). Verifying result...");
      await sleep(800);

      // Verify if a real new asset was produced
      if (cfg.mode !== "video") {
        const finalG = await send(tabId, {
          cmd: "getLatestGeneratedDataUrl",
          beforeTopUrl,
          excludeUrls: Array.from(beforeUrls),
        });
        if (finalG && finalG.ok && finalG.dataUrl && !beforeUrls.has(finalG.src) && finalG.src !== beforeTopUrl) {
          return { ok: true, dataUrl: finalG.dataUrl, src: finalG.src };
        }

        // Also check mediaItems for any new <img> src
        const mres = await send(tabId, { cmd: "mediaItems" });
        const currentImages = (mres.ok && mres.images) || [];
        const newImg = currentImages.find((img) => img.src && !beforeUrls.has(img.src));
        if (newImg) {
          const bres = await send(tabId, { cmd: "fetchBlobAsDataUrl", url: newImg.src });
          if (bres && bres.ok && bres.dataUrl) {
            return { ok: true, dataUrl: bres.dataUrl, src: newImg.src };
          }
        }
      } else {
        const finalM = await send(tabId, { cmd: "mediaItems" });
        const currentVideos = (finalM.ok && finalM.videos) || [];
        const newVid = currentVideos.find((v) => v && !beforeUrls.has(v));
        if (newVid) {
          return { ok: true, isVideo: true, src: newVid };
        }
      }

      // Check for error text ONLY IF NO NEW IMAGE WAS PRODUCED
      const errCheck = await send(tabId, { cmd: "checkError" });
      if (errCheck && errCheck.hasError) {
        return { ok: false, error: errCheck.message };
      }

      // No new media and agent stopped => generation failed!
      return { ok: false, error: "Generation failed: No new image was produced" };
    }
    await sleep(600);
  }

  // Timed out: check error or final state
  const errFinal = await send(tabId, { cmd: "checkError" });
  if (errFinal && errFinal.hasError) {
    return { ok: false, error: errFinal.message };
  }
  return { ok: false, error: "Generation timed out without producing a new image" };
}

async function diagnoseFlowDOM(tabId) {
  try {
    const diag = await send(tabId, { cmd: "diagnoseDOM" });
    if (diag && diag.ok) {
      console.log("[Flow Batch Diagnostic] Google Flow DOM Diagnostic:", diag);
      emit({
        kind: "info",
        message: `[Diag] Flow input: <${diag.promptBox ? diag.promptBox.tagName : 'none'}> (${diag.promptBox ? (diag.promptBox.isTextarea ? 'textarea' : diag.promptBox.isContentEditable ? 'contenteditable' : 'other') : 'not found'}), Submit: ${diag.submitButton ? (diag.submitButton.effectivelyDisabled ? 'disabled' : 'enabled') : 'not found'}`
      });
// Diagnostic kept in memory/console only; no JSON file download
    }
  } catch (e) {
    console.warn("[Flow Batch Diagnostic] Failed to diagnose Flow DOM:", e);
  }
}

async function injectAndSubmitPrompt(tabId, job, promptKey, f) {
  console.log(`[Flow Batch] Queue prompt: #${job.customTag} "${job.prompt.slice(0, 60)}..."`);
  console.log(`[Flow Batch] Injecting prompt...`);

  let typed = false;
  let lastVal = "";

  for (let a = 0; a < 4 && !typed && !isAborted && (!RUN || !RUN.stopped) && (!RUN || !RUN.skipWait); a++) {
    if (a > 0) {
      console.log(`[Flow Batch] Retrying prompt injection (attempt ${a + 1}/4)...`);
      await send(tabId, { cmd: "dismiss" });
      const rf = await send(tabId, { cmd: "focusPrompt" });
      if (rf.ok) { f.x = rf.x; f.y = rf.y; }
      await sleep(200);
    }

    // Strategy A: CDP trusted keystroke insertion
    try {
      await cdpType(tabId, f.x, f.y, job.prompt);
      await sleep(250);
    } catch (e) {
      console.warn("[Flow Batch] CDP type warning:", e.message);
    }

    // Verify if CDP insertion registered
    let vRes = await send(tabId, { cmd: "verifyPrompt", expected: promptKey });
    if (vRes && vRes.ok && vRes.verified) {
      typed = true;
      lastVal = vRes.rawText || vRes.text;
      break;
    }

    // Strategy B: Content script DOM / React state injection
    console.log("[Flow Batch] CDP typing did not fully register in Flow state; falling back to direct React/DOM injection...");
    await send(tabId, { cmd: "typePrompt", text: job.prompt });
    await sleep(250);

    // Verify after DOM injection
    vRes = await send(tabId, { cmd: "verifyPrompt", expected: promptKey });
    if (vRes && vRes.ok && vRes.verified) {
      typed = true;
      lastVal = vRes.rawText || vRes.text;
      break;
    } else if (vRes && vRes.ok) {
      lastVal = vRes.rawText || vRes.text;
    }
  }

  console.log(`[Flow Batch] Input value after injection: "${lastVal ? lastVal.slice(0, 60) + "..." : "(empty)"}"`);
  console.log(`[Flow Batch] Flow recognized prompt: ${typed ? "YES" : "NO"}`);

  // PRE-SUBMIT VALIDATION (CRITICAL REQUIREMENT 8):
  // IF prompt is empty or not recognized, DO NOT CLICK GENERATE!
  if (!typed) {
    console.error(`[Flow Batch] VALIDATION FAILED: Prompt #${job.customTag} is NOT present in Flow input!`);
    console.error(`[Flow Batch] Aborting Generate click to prevent 'Prompt must be provided' error.`);
    return { ok: false, error: "Prompt was not registered in Flow input — aborted submit to prevent 'Prompt must be provided'" };
  }

  // Submit prompt — ONLY after verification succeeded!
  const boxCleared = async () => {
    const r = await send(tabId, { cmd: "readPrompt" });
    return r.ok && !(r.text || "").includes(promptKey);
  };

  let submitted = false;
  for (let attempt = 0; attempt < 6 && !submitted && !isAborted && (!RUN || !RUN.stopped) && (!RUN || !RUN.skipWait); attempt++) {
    // Wait for submit button to be present and enabled
    for (let w = 0; w < 12; w++) {
      if (isAborted || (RUN && RUN.stopped)) break;
      const se = await send(tabId, { cmd: "submitEnabled" });
      if (se.ok && se.enabled) {
        console.log(`[Flow Batch] Generate button state: enabled`);
        break;
      }
      await sleep(200);
    }
    if (isAborted || (RUN && RUN.stopped)) break;

    const sr = await send(tabId, { cmd: "submitRect" });
    if (sr.ok) {
      console.log(`[Flow Batch] Clicking Generate at (${Math.round(sr.x)}, ${Math.round(sr.y)})...`);
      try { await cdpClick(tabId, sr.x, sr.y); } catch (e) {}
    }

    // Wait to confirm submission
    for (let t = 0; t < 8 && !submitted && !isAborted && (!RUN || !RUN.skipWait); t++) {
      await sleep(300);
      const st = await send(tabId, { cmd: "status" });
      if (st.ok && st.hasError && st.errorType === "empty_prompt") {
        console.warn("[Flow Batch] Flow displayed 'Prompt must be provided' error toast! Submission rejected.");
        break;
      }
      if (st.ok && st.generating) {
        console.log("[Flow Batch] Generation started confirmed by Flow status.");
        submitted = true;
        break;
      }
      if (await boxCleared()) {
        const errCheck = await send(tabId, { cmd: "status" });
        if (errCheck.ok && errCheck.hasError && errCheck.errorType === "empty_prompt") {
          console.warn("[Flow Batch] Box was cleared due to empty_prompt error, not real submission.");
          break;
        }
        console.log("[Flow Batch] Prompt box cleared — prompt accepted by Flow.");
        submitted = true;
        break;
      }
    }

    if (submitted || isAborted || (RUN && RUN.stopped) || (RUN && RUN.skipWait)) break;

    // Fallback: Press Enter on the prompt box
    const pr = await send(tabId, { cmd: "promptRect" });
    if (pr.ok) {
      console.log("[Flow Batch] Submit button click did not trigger generation; trying Enter key...");
      try { await cdpClick(tabId, pr.x, pr.y); await sleep(100); await cdpEnter(tabId); } catch (e) {}
    }
    for (let t = 0; t < 6 && !submitted && !isAborted && (!RUN || !RUN.skipWait); t++) {
      await sleep(300);
      const st = await send(tabId, { cmd: "status" });
      if (st.ok && st.generating) {
        submitted = true;
        break;
      }
      if (await boxCleared()) {
        submitted = true;
        break;
      }
    }
  }

  return { ok: submitted, skipped: !!(RUN && RUN.skipWait) };
}

async function runLoop() {
  const cfg = RUN.cfg;
  const tabId = RUN.tabId;

  // Mode / aspect / outputs / model are whatever the user set in Flow's own UI —
  // the extension no longer configures those. But we DO force "Confirm before
  // generating → Never", otherwise the Agent just asks for confirmation and never
  // generates (the batch would time out with nothing saved).
  let ag = { ok: false };
  for (let a = 0; a < 3 && !ag.ok; a++) {
    if (isAborted || (RUN && RUN.stopped)) return;
    ag = await send(tabId, { cmd: "autogen" });
    if (!ag.ok) await sleep(700);
  }
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

  // Download the media a single job just produced.
  async function downloadJob(job, beforeMedia, verifiedDataUrl) {
    if (!cfg.autoDownload || isAborted || (RUN && RUN.stopped)) return null;
    const tag = job.customTag || String(job.n).padStart(2, "0");

    await sleep(250); // slight pause to ensure DOM handles final paint
    if (isAborted || (RUN && RUN.stopped)) return null;

    const timestamp = (RUN && RUN.timestamp) || stampNow();
    const customFolder = (RUN && RUN.customFolder) || resolveDownloadFolder(cfg, timestamp);

    // 1) Primary path for Images: if verifiedDataUrl was already acquired during waitForCompletion, save directly
    if (cfg.mode !== "video") {
      let dataUrlToSave = verifiedDataUrl;
      if (!dataUrlToSave) {
        const prevImages = (beforeMedia && beforeMedia.images) || [];
        const prevUrls = prevImages.map((i) => i.src).filter(Boolean);
        const gRes = await send(tabId, {
          cmd: "getLatestGeneratedDataUrl",
          excludeUrls: prevUrls,
        });
        if (gRes && gRes.ok && gRes.dataUrl) {
          dataUrlToSave = gRes.dataUrl;
        }
      }

      if (dataUrlToSave) {
        const fileName = `${tag}.png`;
        const filename = `${customFolder}/${fileName}`;
        console.log(`[Flow Batch] Saving image for #${job.n} (${tag})...`);
        emit({ kind: "info", message: `Saving image for #${job.n} (${tag})...` });

        const saved = await saveMedia(tabId, 0, dataUrlToSave, filename, cfg.upscale, false);
        emit({ kind: "info", message: `✓ saved 1/1 → Downloads/${customFolder}/` });
        return {
          done: saved && saved.ok ? 1 : 0,
          total: 1,
          dataUrl: dataUrlToSave,
          filename: saved && saved.ok ? saved.filename : filename,
        };
      }
    }

    // 2) Fallback path for videos or multi-media diffs
    let seq = 0;
    let done = 0;
    const mres = await send(tabId, { cmd: "mediaItems" });
    const currentImages = (mres.ok && mres.images) || [];
    const currentVideos = (mres.ok && mres.videos) || [];

    const prevImages = (beforeMedia && beforeMedia.images) || [];
    const prevVideos = (beforeMedia && beforeMedia.videos) || [];
    const prevUrls = new Set(prevImages.map((i) => i.src).filter(Boolean).concat(prevVideos.filter(Boolean)));

    console.log(`[Flow Batch] #${job.n} (${tag}) Media count: before=${prevImages.length} img vs after=${currentImages.length} img`);

    let newImgItems = currentImages.filter((i) => i.src && !prevUrls.has(i.src));
    let newVidItems = currentVideos.filter((v) => v && !prevUrls.has(v));

    if (newImgItems.length === 0 && currentImages.length > prevImages.length) {
      newImgItems = currentImages.slice(0, currentImages.length - prevImages.length);
    }
    if (newVidItems.length === 0 && currentVideos.length > prevVideos.length) {
      newVidItems = currentVideos.slice(0, currentVideos.length - prevVideos.length);
    }

    if (newImgItems.length === 0 && newVidItems.length === 0) {
      if (currentImages.length > 0) {
        newImgItems = [currentImages[0]];
      } else if (currentVideos.length > 0) {
        newVidItems = [currentVideos[0]];
      }
    }

    const total = newImgItems.length + newVidItems.length;
    if (total === 0) {
      console.warn(`[Flow Batch] No media found on page for #${job.n}`);
      emit({ kind: "warn", message: `no media found on page for #${job.n} — nothing saved` });
      return null;
    }

    let lastSavedDataUrl = null;
    let lastSavedFilename = null;
    const one = async (tileIndex, url, name, ext, isVideo) => {
      if (isAborted || (RUN && RUN.stopped)) return;
      seq++;
      let safeExt = ext;
      if (!isVideo) {
        safeExt = (safeExt === ".jpg" || safeExt === ".jpeg") ? ".jpg" : ".png";
      }
      const fileName = total > 1 ? `${tag}__v${seq}${safeExt}` : `${tag}${safeExt}`;
      const filename = `${customFolder}/${fileName}`;

      emit({ kind: "info", message: `Downloading: ${fileName}...` });
      const saved = await saveMedia(tabId, tileIndex, url, filename, cfg.upscale && !isVideo, isVideo);
      if (saved && saved.ok) {
        done++;
        lastSavedDataUrl = saved.dataUrl || url;
        lastSavedFilename = saved.filename || filename;
      }
      await sleep(100);
    };

    for (let k = 0; k < newImgItems.length; k++) {
      if (isAborted || (RUN && RUN.stopped)) break;
      await one(k, newImgItems[k].src, newImgItems[k].name, ".png", false);
    }
    for (let k = 0; k < newVidItems.length; k++) {
      if (isAborted || (RUN && RUN.stopped)) break;
      await one(k, newVidItems[k], "", ".mp4", true);
    }

    emit({ kind: "info", message: `✓ saved ${done}/${total} → Downloads/${customFolder}/` });
    return { done, total, dataUrl: lastSavedDataUrl, filename: lastSavedFilename };
  }

  for (; RUN.i < RUN.queue.length; RUN.i++) {
    if (isAborted || RUN.stopped) {
      console.log("[Flow Batch] Batch stopped by user.");
      break;
    }
    while (RUN.paused && !isAborted && !RUN.stopped && !RUN.skipWait && !RUN.retryRequested) {
      await sleep(250);
    }
    if (isAborted || RUN.stopped) {
      console.log("[Flow Batch] Batch stopped by user.");
      break;
    }

    RUN.skipWait = false;
    RUN.retryRequested = false;
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

    // Inner retry loop for current prompt (allows Retry or Next)
    let promptFinished = false;
    while (!promptFinished && !isAborted && !RUN.stopped) {
      RUN.retryRequested = false;
      RUN.skipWait = false;

      emit({ kind: "start", index: RUN.i, total: RUN.queue.length, job });

      if (isAborted || RUN.stopped) break;

      // 0) dismiss any stray menu/popover left open from the previous prompt
      await send(tabId, { cmd: "dismiss" });
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}

      if (isAborted || RUN.stopped) break;

      // Snapshot media BEFORE submitting this prompt
      const beforeMediaRes = await send(tabId, { cmd: "mediaItems" });
      const beforeMedia = {
        images: (beforeMediaRes.ok && beforeMediaRes.images) || [],
        videos: (beforeMediaRes.ok && beforeMediaRes.videos) || [],
      };
      const beforeMediaCount = beforeMedia.images.length + beforeMedia.videos.length;
      const beforeTopUrl = (beforeMedia.images[0] && beforeMedia.images[0].src) || beforeMedia.videos[0] || "";
      const beforeUrls = new Set(beforeMedia.images.map((i) => i.src).filter(Boolean).concat(beforeMedia.videos.filter(Boolean)));

      if (isAborted || RUN.stopped) break;

      // 1) focus + clear the prompt box
      const f = await send(tabId, { cmd: "focusPrompt" });
      if (isAborted || RUN.stopped) break;
      if (!f.ok) {
        emit({ kind: "error", index: RUN.i, job, message: "focus: " + f.error });
        RUN.paused = true;
        RUN.awaitingUserChoice = true;
        RUN.failedIndex = RUN.i;
        emit({ kind: "generation-failed-pause", index: RUN.i, job, error: "Focus prompt failed: " + f.error });
        while (RUN.paused && !RUN.retryRequested && !RUN.skipWait && !isAborted && !RUN.stopped) await sleep(250);
        if (isAborted || RUN.stopped) break;
        if (RUN.skipWait) {
          RUN.skipWait = false;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          promptFinished = true;
          break;
        }
        if (RUN.retryRequested || !RUN.paused) {
          RUN.retryRequested = false;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          emit({ kind: "card-status", index: RUN.i, status: "generating", job });
          continue;
        }
      }

      // 2) Type and submit prompt with pre-validation
      const promptKey = job.prompt.slice(0, 24).toLowerCase();
      const subRes = await injectAndSubmitPrompt(tabId, job, promptKey, f);

      if (isAborted || RUN.stopped) break;

      if (RUN.skipWait || (subRes && subRes.skipped)) {
        console.log(`[Flow Batch] User clicked Next during injection: skipping #${job.customTag}`);
        RUN.skipWait = false;
        RUN.paused = false;
        RUN.awaitingUserChoice = false;
        promptFinished = true;
        break;
      }

      if (!subRes.ok) {
        const errMsg = subRes.error || "Prompt submission failed (Flow did not accept prompt)";
        emit({ kind: "error", index: RUN.i, job, message: errMsg });
        RUN.paused = true;
        RUN.awaitingUserChoice = true;
        RUN.failedIndex = RUN.i;
        emit({ kind: "generation-failed-pause", index: RUN.i, job, error: errMsg });
        while (RUN.paused && !RUN.retryRequested && !RUN.skipWait && !isAborted && !RUN.stopped) await sleep(250);
        if (isAborted || RUN.stopped) break;
        if (RUN.skipWait) {
          RUN.skipWait = false;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          promptFinished = true;
          break;
        }
        if (RUN.retryRequested || !RUN.paused) {
          RUN.retryRequested = false;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          emit({ kind: "card-status", index: RUN.i, status: "generating", job });
          continue;
        }
      }

      RUN.submitted.push(job);

      // 4) Active polling for completion with error detection
      const compRes = await waitForCompletion(tabId, cfg, beforeMediaCount, beforeTopUrl, beforeUrls);

      if (isAborted || RUN.stopped) break;

      if (RUN.skipWait || (compRes && compRes.skipped)) {
        console.log(`[Flow Batch] User clicked Next: skipping wait for #${job.customTag}`);
        RUN.skipWait = false;
        RUN.paused = false;
        RUN.awaitingUserChoice = false;
        promptFinished = true;
        break;
      }

      if (compRes && compRes.ok) {
        // Generation SUCCEEDED! Save real media
        let dlRes = null;
        if (!RUN.skipWait) {
          dlRes = await downloadJob(job, beforeMedia, compRes.dataUrl);
        }

        emit({
          kind: "done",
          index: RUN.i,
          job,
          dataUrl: dlRes ? dlRes.dataUrl : (compRes.dataUrl || null),
          filename: dlRes ? dlRes.filename : null,
        });

        promptFinished = true;
        if (!RUN.skipWait && cfg.gapSec) {
          await sleep(cfg.gapSec * 1000);
        }
        break;
      } else {
        // GENERATION FAILED (policy, unusual activity, no new image, etc.)!
        const failMsg = (compRes && compRes.error) || "Generation failed";
        console.warn(`[Flow Batch] Generation failed for #${job.customTag}:`, failMsg);

        // NEVER download previous image!
        // Pause generation and wait for user choice
        RUN.paused = true;
        RUN.awaitingUserChoice = true;
        RUN.failedIndex = RUN.i;

        emit({
          kind: "generation-failed-pause",
          index: RUN.i,
          job,
          error: failMsg,
        });

        // Wait for user to click Retry or Next or Resume
        while (RUN.paused && !RUN.retryRequested && !RUN.skipWait && !isAborted && !RUN.stopped) {
          await sleep(250);
        }

        if (isAborted || RUN.stopped) break;

        if (RUN.skipWait) {
          // User clicked Next: leave this one and advance to next image
          console.log(`[Flow Batch] User clicked Next: leaving #${job.customTag} and advancing`);
          RUN.skipWait = false;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          promptFinished = true; // exit retry loop for this prompt, so outer loop increments RUN.i
          break;
        }

        if (RUN.retryRequested || !RUN.paused) {
          // User clicked Retry or Resume: try generating this image again
          console.log(`[Flow Batch] User clicked Retry/Resume: re-attempting #${job.customTag}`);
          RUN.retryRequested = false;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          emit({ kind: "card-status", index: RUN.i, status: "generating", job });
          // Loop will retry generating this exact prompt!
          continue;
        }
      }
    }
  }

  await dbgDetach(); // remove the "being debugged" banner
  const finished = !isAborted && (!RUN || !RUN.stopped) && RUN.i >= RUN.queue.length;
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
  const customFolder = (RUN && RUN.customFolder) || resolveDownloadFolder(RUN && RUN.cfg, timestamp);
  const currentJob = (RUN && RUN.queue && RUN.queue[RUN.i]) ? RUN.queue[RUN.i] : null;

  if (mode === "latest") {
    const tag = requestedTag || (currentJob && currentJob.customTag) || `image_${Date.now()}`;
    const gRes = await send(tab.id, { cmd: "getLatestGeneratedDataUrl" });
    if (gRes && gRes.ok && gRes.dataUrl) {
      const fileName = `${tag}.png`;
      const filename = `${customFolder}/${fileName}`;
      emit({ kind: "info", message: `Downloading latest image: ${fileName}...` });
      const saved = await saveMedia(tab.id, 0, gRes.dataUrl, filename, false, false);
      if (saved && saved.ok) {
        emit({ kind: "info", message: `✓ Downloaded latest: ${fileName}` });
        return { ok: true, filename, dataUrl: gRes.dataUrl };
      }
    }
    if (images.length > 0) {
      const item = images[0];
      const fileName = `${tag}.png`;
      const filename = `${customFolder}/${fileName}`;
      console.log(`[Flow Batch] Manual download latest: ${filename}, src:`, item.src ? item.src.slice(0, 100) : "empty");
      emit({ kind: "info", message: `Downloading latest image: ${fileName}...` });
      const saved = await saveMedia(tab.id, 0, item.src, filename, false, false);
      if (saved && saved.ok) {
        emit({ kind: "info", message: `✓ Downloaded latest: ${fileName}` });
        return { ok: true, filename, dataUrl: saved.dataUrl };
      } else {
        emit({ kind: "warn", message: "Failed to download latest image" });
        return { ok: false, error: "Failed to download image file" };
      }
    } else {
      const vidSrc = videos[0];
      const fileName = `${tag}.mp4`;
      const filename = `${customFolder}/${fileName}`;
      emit({ kind: "info", message: `Downloading latest video: ${fileName}...` });
      const saved = await saveMedia(tab.id, 0, vidSrc, filename, false, true);
      if (saved && saved.ok) {
        emit({ kind: "info", message: `✓ Downloaded latest video: ${fileName}` });
        return { ok: true, filename, dataUrl: saved.dataUrl };
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
    const filename = `${customFolder}/${fileName}`;
    emit({ kind: "info", message: `[${i + 1}/${images.length}] Downloading: ${fileName}...` });
    const saved = await saveMedia(tab.id, i, item.src, filename, false, false);
    if (saved && saved.ok) count++;
    await sleep(100);
  }
  for (let i = 0; i < videos.length; i++) {
    const vidSrc = videos[i];
    const nn = String(images.length + i + 1).padStart(2, "0");
    const fileName = `video_${nn}.mp4`;
    const filename = `${customFolder}/${fileName}`;
    const saved = await saveMedia(tab.id, i, vidSrc, filename, false, true);
    if (saved && saved.ok) count++;
    await sleep(100);
  }
  emit({ kind: "info", message: `✓ Saved ${count}/${images.length + videos.length} items → Downloads/${customFolder}/` });
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
// Ready to start batch

        if (!ping.project) return sendResponse({ ok: false, error: "Open a Flow PROJECT (click New project), then start." });
        const cfg = { ...DEFAULTS, ...(msg.cfg || {}) };
        const ts = stampNow();
        const customFolder = resolveDownloadFolder(cfg, ts);
        isAborted = false;
        RUN = {
          queue: msg.queue, i: msg.startIndex || 0, tabId: tab.id,
          paused: false, stopped: false, running: true, submitted: [],
          cfg, timestamp: ts, customFolder,
          folder: customFolder,
          runDir: customFolder,
        };
        runLoop();
        return sendResponse({ ok: true, count: msg.queue.length });
      }
      case "diagnose": {
        const tab = await findFlowTab();
        if (!tab) return sendResponse({ ok: false, error: "No Google Flow tab found" });
        await diagnoseFlowDOM(tab.id);
        const diag = await send(tab.id, { cmd: "diagnoseDOM" });
        return sendResponse(diag);
      }
      case "pause": {
        if (RUN) {
          RUN.paused = true;
          emit({ kind: "paused", index: RUN.i, job: RUN.queue ? RUN.queue[RUN.i] : null });
          console.log("[Flow Batch] Queue paused by user at index", RUN.i);
        }
        return sendResponse({ ok: true });
      }
      case "resume": {
        if (RUN) {
          RUN.paused = false;
          if (RUN.awaitingUserChoice) {
            RUN.retryRequested = true;
            RUN.awaitingUserChoice = false;
          }
          cancelActiveDelays();
          emit({ kind: "resumed", index: RUN.i, job: RUN.queue ? RUN.queue[RUN.i] : null });
          console.log("[Flow Batch] Queue resumed by user at index", RUN.i);
        }
        return sendResponse({ ok: true });
      }
      case "retryCurrent": {
        if (RUN && RUN.running && (RUN.awaitingUserChoice || RUN.paused)) {
          if (typeof msg.index === "number" && msg.index >= 0 && msg.index < RUN.queue.length) {
            RUN.i = msg.index;
          }
          RUN.retryRequested = true;
          RUN.paused = false;
          RUN.awaitingUserChoice = false;
          cancelActiveDelays();
          emit({ kind: "resumed", index: RUN.i, job: RUN.queue ? RUN.queue[RUN.i] : null });
          console.log("[Flow Batch] Retry current requested for index", RUN.i);
          return sendResponse({ ok: true, activeBatch: true });
        }
        return sendResponse({ ok: false, error: "No active paused prompt" });
      }
      case "skipNext":
      case "manualNext": {
        if (RUN) {
          RUN.awaitingManual = false;
          RUN.awaitingUserChoice = false;
          RUN.skipWait = true;
          RUN.paused = false;
          cancelActiveDelays();
          console.log("[Flow Batch] Next / Skip requested for prompt index", RUN.i);
          emit({ kind: "info", message: "➔ Advancing to next prompt..." });
        }
        return sendResponse({ ok: true });
      }
      case "stopBatch":
      case "stop": {
        isAborted = true;
        if (RUN) {
          RUN.stopped = true;
          RUN.running = false;
          RUN.awaitingManual = false;
        }
        cancelActiveDelays();
        await dbgDetach();
        console.log("[Flow Batch] Batch stopped by user.");
        emit({ kind: "stopped", index: RUN ? RUN.i : 0, total: RUN ? RUN.queue.length : 0 });
        return sendResponse({ ok: true });
      }
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
      case "retryCard": {
        const tab = await findFlowTab();
        if (!tab) return sendResponse({ ok: false, error: "Open a Google Flow project tab first." });
        const job = msg.job;
        const cardIndex = msg.index;
        const cfg = { ...DEFAULTS, ...(msg.cfg || {}) };
        const timestamp = (RUN && RUN.timestamp) || stampNow();
        const customFolder = (RUN && RUN.customFolder) || resolveDownloadFolder(cfg, timestamp);

        emit({ kind: "card-status", index: cardIndex, status: "generating", job });

        try {
          await dbgAttach(tab.id);
        } catch (e) {
          emit({ kind: "card-status", index: cardIndex, status: "failed", error: e.message, job });
          return sendResponse({ ok: false, error: e.message });
        }

        try {
          // 0) dismiss stray menus
          await send(tab.id, { cmd: "dismiss" });
          try { await chrome.tabs.update(tab.id, { active: true }); } catch (_) {}

          // Snapshot media before submitting
          const beforeMediaRes = await send(tab.id, { cmd: "mediaItems" });
          const beforeMedia = {
            images: (beforeMediaRes.ok && beforeMediaRes.images) || [],
            videos: (beforeMediaRes.ok && beforeMediaRes.videos) || [],
          };
          const beforeMediaCount = beforeMedia.images.length + beforeMedia.videos.length;
          const beforeTopUrl = (beforeMedia.images[0] && beforeMedia.images[0].src) || beforeMedia.videos[0] || "";

          // 1) Focus prompt box
          const f = await send(tab.id, { cmd: "focusPrompt" });
          if (!f.ok) throw new Error("Focus failed: " + f.error);

          // 2) Type and submit prompt with pre-validation
          const promptKey = (job.prompt || "").slice(0, 24).toLowerCase();
          const subRes = await injectAndSubmitPrompt(tab.id, job, promptKey, f);
          if (!subRes.ok) {
            throw new Error(subRes.error || "Prompt submission failed — make sure Flow tab is active");
          }

          // 4) Wait for generation
          const originalRun = RUN;
          if (!RUN || !RUN.running) {
            RUN = { stopped: false, running: true, cfg, timestamp, customFolder };
          }
          const compRes = await waitForCompletion(tab.id, cfg, beforeMediaCount, beforeTopUrl, beforeUrls);
          if (!originalRun) RUN = null;

          if (!compRes || !compRes.ok) {
            throw new Error((compRes && compRes.error) || "Generation failed in Flow");
          }

          // 5) Fetch resulting media
          await sleep(250);
          const tag = job.customTag || String(job.n).padStart(2, "0");

          // Primary path for Images: use verified compRes.dataUrl directly
          if (cfg.mode !== "video" && compRes.dataUrl) {
            const fileName = `${tag}.png`;
            const filename = `${customFolder}/${fileName}`;
            const saved = await saveMedia(tab.id, 0, compRes.dataUrl, filename, cfg.upscale, false);
            await dbgDetach();
            const finalDataUrl = compRes.dataUrl;
            emit({
              kind: "card-done",
              index: cardIndex,
              job,
              dataUrl: finalDataUrl,
              filename: saved && saved.ok ? saved.filename : filename,
            });
            return sendResponse({ ok: true, dataUrl: finalDataUrl, filename: saved && saved.ok ? saved.filename : filename });
          }

          const mres = await send(tab.id, { cmd: "mediaItems" });
          const currentImages = (mres.ok && mres.images) || [];
          const currentVideos = (mres.ok && mres.videos) || [];

          const prevUrls = new Set(beforeMedia.images.map((i) => i.src).filter(Boolean).concat(beforeMedia.videos.filter(Boolean)));

          let targetUrl = "";
          let isVideo = false;
          if (cfg.mode === "video") {
            targetUrl = currentVideos.find((v) => v && !prevUrls.has(v)) || currentVideos[0] || "";
            isVideo = true;
          }
          if (!targetUrl) {
            const newImg = currentImages.find((i) => i.src && !prevUrls.has(i.src)) || currentImages[0];
            if (newImg) {
              targetUrl = newImg.src;
              isVideo = false;
            }
          }

          if (!targetUrl) throw new Error("No media found on Flow canvas after generation");

          const ext = isVideo ? ".mp4" : ".png";
          const fileName = `${tag}${ext}`;
          const filename = `${customFolder}/${fileName}`;

          const saved = await saveMedia(tab.id, 0, targetUrl, filename, cfg.upscale && !isVideo, isVideo);
          await dbgDetach();

          if (saved && saved.ok) {
            emit({
              kind: "card-done",
              index: cardIndex,
              job,
              dataUrl: saved.dataUrl || targetUrl,
              filename,
            });
            return sendResponse({ ok: true, dataUrl: saved.dataUrl || targetUrl, filename });
          } else {
            throw new Error("Failed to save media");
          }
        } catch (err) {
          await dbgDetach();
          emit({ kind: "card-status", index: cardIndex, status: "failed", error: err.message, job });
          return sendResponse({ ok: false, error: err.message });
        }
      }
      case "redownload": {
        const url = msg.dataUrl || msg.url;
        const filename = msg.filename || "image.png";
        if (!url) return sendResponse({ ok: false, error: "No URL provided" });
        chrome.downloads.download(
          { url, filename, conflictAction: "overwrite", saveAs: false },
          (id) => {
            if (chrome.runtime.lastError || id == null) {
              return sendResponse({ ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "Download ID is null" });
            }
            return sendResponse({ ok: true, id });
          }
        );
        return true;
      }
      default:
        return sendResponse({ ok: false, error: "unknown type: " + action });
    }
  })();
  return true;
});
