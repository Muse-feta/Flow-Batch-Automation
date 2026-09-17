"use strict";

let DATA = null;
const $ = (id) => document.getElementById(id);

function logLine(text, cls = "") {
  const d = document.createElement("div");
  d.className = "l " + cls;
  d.textContent = text;
  $("log").prepend(d);
}

function parseShots(spec) {
  const s = (spec || "").trim();
  if (!s) return null; // all
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

// Strip Midjourney-style flags Flow doesn't understand (--ar 16:9, --v 6.0,
// --style raw, --q 2, --no x …) so they aren't typed literally into the prompt.
function stripMjFlags(s) {
  return String(s).replace(/\s--\w+(?:\s+[^\s-]\S*)?/gi, " ").replace(/\s+/g, " ").trim();
}
function cleanHeading(h) {
  return String(h).replace(/\*\*/g, "").replace(/^#+\s*/, "").replace(/^\d+[.)]\s*/, "").trim();
}
// Turn pasted text into [{prompt, label}]. Handles three shapes, in order:
//  1) Markdown with ```fenced``` blocks — the FENCE BODY is the prompt (Flow's
//     composer renders markdown, so ###/``` must never be typed); the nearest
//     preceding "### heading" becomes the label.
//  2) Blank-line-separated multi-line blocks.
//  3) One prompt per line.
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
// Regex matcher: /^(?:#?\s*)(\d+[-_]\d+)/
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

function buildQueue() {
  let rawList = [];
  if ($("source").value === "paste") {
    const prefix = ($("prefix").value || "custom").trim() || "custom";
    rawList = parsePasted($("pasteText").value).map((it, i) => ({
      collection: prefix,
      listing_id: null,
      n: i + 1,
      label: it.label || "",
      prompt: it.prompt,
    }));
  } else {
    const col = $("collection").value;
    const shots = parseShots($("shots").value);
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
    // 1) Try prompt text for timestamp prefix like #2-06, 0-00, 0-04, etc.
    let parsed = parseTimestampTag(it.prompt, i + 1);
    let customTag = parsed.customTag;
    let cleanPrompt = parsed.promptText;

    // 2) If not in prompt, check label (e.g. from markdown headings like ### #2-06)
    if ((!customTag || customTag === String(i + 1).padStart(2, "0")) && it.label) {
      const fromLabel = parseTimestampTag(it.label, i + 1);
      if (fromLabel.customTag && fromLabel.customTag !== String(i + 1).padStart(2, "0")) {
        customTag = fromLabel.customTag;
      }
    }

    return {
      collection: it.collection,
      listing_id: it.listing_id,
      n: i + 1,
      label: it.label || "",
      customTag,
      rawPrompt: it.prompt,
      prompt: cleanPrompt || it.prompt,
      promptText: cleanPrompt || it.prompt,
    };
  });
}

function cfgFromUI() {
  // Mode / Aspect / Outputs / Model are set by the user in Flow's own UI — the
  // extension no longer configures them. It just runs prompts and saves whatever
  // Flow produces.
  return {
    upscale: $("upscale").checked,
    waitMode: $("waitMode").value,
    autoDownload: $("autoDownload").checked,
    delaySec: parseInt($("delaySec").value, 10) || 45,
    gapSec: $("waitMode").value === "fast" ? 1 : Math.min(8, Math.max(2, Math.round((parseInt($("delaySec").value, 10) || 45) / 12))),
  };
}

const btnNext = $("btnNext") || $("next");
let CURRENT_JOB = null;

function setRunning(on, manual = false) {
  $("start").disabled = on;
  $("pause").disabled = !on;
  $("stop").disabled = !on;
  if (btnNext) btnNext.disabled = !on; // Enabled whenever running or paused!
  document.querySelectorAll("select,input").forEach((e) => (e.disabled = on));
}

async function load() {
  // ponytail: prompts.json is optional (not shipped in the public repo).
  // Without it the "bundled" source simply disappears; paste-your-own still works.
  try {
    const res = await fetch(chrome.runtime.getURL("prompts.json"));
    DATA = await res.json();
    $("loaded").textContent = `${DATA.meta.collections} collections · ${DATA.meta.total_prompts} prompts`;
    const sel = $("collection");
    for (const c of DATA.collections) {
      const o = document.createElement("option");
      o.value = c.collection;
      o.textContent = `${c.collection} (${c.listing_id})`;
      sel.appendChild(o);
    }
  } catch (e) {
    DATA = null;
    $("loaded").textContent = "paste your own prompts";
    const bundled = $("source").querySelector('option[value="bundled"]');
    if (bundled) bundled.remove();
  }
  await restoreState();
  if (!DATA) $("source").value = "paste";
  syncSource();
}

function refreshCount() {
  if (!DATA && $("source").value === "bundled") return;
  $("queueCount").textContent = buildQueue().length;
}

function syncSource() {
  const paste = $("source").value === "paste";
  $("pasteBlock").style.display = paste ? "" : "none";
  $("bundledBlock").style.display = paste ? "none" : "";
  refreshCount();
}
$("source").addEventListener("change", syncSource);
["collection", "shots", "pasteText", "prefix"].forEach((id) => $(id).addEventListener("input", refreshCount));

// --- persist settings + prompt text across opens -------------------------
const PERSIST = ["source", "pasteText", "prefix", "collection", "shots", "waitMode", "delaySec"];
const PERSIST_CHK = ["autoDownload", "upscale"];
function saveState() {
  const s = {};
  PERSIST.forEach((id) => { if ($(id)) s[id] = $(id).value; });
  PERSIST_CHK.forEach((id) => { if ($(id)) s[id] = $(id).checked; });
  chrome.storage.local.set({ flowBatchState: s });
}
function restoreState() {
  return new Promise((res) => chrome.storage.local.get("flowBatchState", (r) => {
    const s = r && r.flowBatchState;
    if (s) {
      PERSIST.forEach((id) => { if ($(id) && s[id] != null) $(id).value = s[id]; });
      PERSIST_CHK.forEach((id) => { if ($(id) && s[id] != null) $(id).checked = s[id]; });
    }
    res();
  }));
}
document.querySelectorAll("select,input,textarea").forEach((e) => e.addEventListener("change", saveState));
$("pasteText") && $("pasteText").addEventListener("input", saveState);

$("start").addEventListener("click", async () => {
  const queue = buildQueue();
  if (!queue.length) return logLine("Nothing to queue.", "warn");
  const cfg = cfgFromUI();
  const resp = await chrome.runtime.sendMessage({ type: "start", queue, cfg, startIndex: 0 });
  if (!resp || !resp.ok) return logLine("Cannot start: " + (resp && resp.error), "err");
  $("bar").max = queue.length;
  setRunning(true);
  logLine(`Started ${queue.length} prompts · using Flow's current settings`, "ok");
});

$("pause").addEventListener("click", async () => {
  const paused = $("pause").textContent === "Pause";
  await chrome.runtime.sendMessage({ type: paused ? "pause" : "resume" });
  $("pause").textContent = paused ? "Resume" : "Pause";
  if (btnNext) btnNext.disabled = false;
});

if (btnNext) {
  btnNext.addEventListener("click", async () => {
    btnNext.style.border = "";
    btnNext.style.boxShadow = "";
    logLine("Skipping to next prompt ▶...", "ok");
    await chrome.runtime.sendMessage({ type: "skipNext", cmd: "manualNext" });
  });
}

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  setRunning(false);
  logLine("Stopped.", "warn");
});

$("btnDownloadLatest").addEventListener("click", async () => {
  logLine("Requesting latest generated image...", "ok");
  const customTag = (CURRENT_JOB && CURRENT_JOB.customTag) || "";
  const resp = await chrome.runtime.sendMessage({
    type: "downloadLatestManual",
    cmd: "downloadLatestManual",
    customTag,
  });
  if (resp && resp.ok) {
    const name = resp.filename ? resp.filename.split("/").pop() : (customTag ? customTag + ".png" : "image.png");
    logLine(`Downloading latest image: ${name}...`, "ok");
  } else {
    logLine("Download failed: " + ((resp && resp.error) || "no media found"), "err");
  }
  // Highlight and enable Next button so user can advance immediately
  if (btnNext) {
    btnNext.disabled = false;
    btnNext.style.border = "2px solid #2563eb";
    btnNext.style.boxShadow = "0 0 10px rgba(37, 99, 235, 0.7)";
    btnNext.focus();
  }
});

$("btnDownloadAll").addEventListener("click", async () => {
  logLine("Requesting download of all visible images...", "ok");
  const resp = await chrome.runtime.sendMessage({ type: "downloadAllManual", cmd: "downloadAllManual" });
  if (resp && resp.ok) {
    logLine(`Downloading all visible media (${resp.count || 0} items)...`, "ok");
  } else {
    logLine("Download all failed: " + ((resp && resp.error) || "no media found"), "err");
  }
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.type !== "progress") return;
  switch (m.kind) {
    case "start":
      CURRENT_JOB = m.job;
      const tagPrefix = m.job && m.job.customTag ? `[${m.job.customTag}] ` : "";
      $("now").textContent = `▶ ${m.index + 1}/${m.total}  ${tagPrefix}${m.job.collection} #${m.job.n}`;
      $("bar").value = m.index;
      if (btnNext) btnNext.disabled = false;
      break;
    case "done":
      const doneTag = m.job ? (m.job.customTag || m.job.n) : "done";
      logLine(`✓ ${doneTag} (${m.job ? m.job.collection : ""})`, "ok");
      $("bar").value = m.index + 1;
      if (btnNext) btnNext.disabled = false;
      break;
    case "await-manual":
      if (btnNext) btnNext.disabled = false;
      $("now").textContent += "  — waiting: click Next when ready";
      break;
    case "info": logLine(m.message, "ok"); break;
    case "warn": logLine("⚠ " + m.message, "warn"); break;
    case "error": logLine(`✗ ${m.job ? (m.job.customTag || m.job.collection + " #" + m.job.n) + ": " : ""}${m.message}`, "err"); break;
    case "finished":
      CURRENT_JOB = null;
      $("now").textContent = "✅ Finished";
      setRunning(false);
      if (btnNext) {
        btnNext.disabled = true;
        btnNext.style.border = "";
        btnNext.style.boxShadow = "";
      }
      logLine("All done.", "ok");
      break;
    case "stopped":
      CURRENT_JOB = null;
      $("now").textContent = "⏹ Stopped";
      setRunning(false);
      if (btnNext) {
        btnNext.disabled = true;
        btnNext.style.border = "";
        btnNext.style.boxShadow = "";
      }
      break;
  }
});

load();
