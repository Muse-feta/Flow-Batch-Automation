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

function buildQueue() {
  if ($("source").value === "paste") {
    const prefix = ($("prefix").value || "custom").trim() || "custom";
    return parsePasted($("pasteText").value).map((it, i) => ({
      collection: prefix,
      listing_id: null,
      n: i + 1,
      label: it.label || "",
      prompt: it.prompt,
    }));
  }
  const col = $("collection").value;
  const shots = parseShots($("shots").value);
  const queue = [];
  for (const c of DATA.collections) {
    if (col !== "*" && c.collection !== col) continue;
    for (const p of c.prompts) {
      if (shots && !shots.has(p.n)) continue;
      queue.push({
        collection: c.collection,
        listing_id: c.listing_id,
        n: p.n,
        label: p.label,
        prompt: p.prompt,
      });
    }
  }
  return queue;
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

function setRunning(on, manual = false) {
  $("start").disabled = on;
  $("pause").disabled = !on;
  $("stop").disabled = !on;
  $("next").disabled = !manual;
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
});
$("next").addEventListener("click", () => chrome.runtime.sendMessage({ type: "manualNext" }));
$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stop" });
  setRunning(false);
  logLine("Stopped.", "warn");
});

chrome.runtime.onMessage.addListener((m) => {
  if (m.type !== "progress") return;
  switch (m.kind) {
    case "start":
      $("now").textContent = `▶ ${m.index + 1}/${m.total}  ${m.job.collection} #${m.job.n} (${m.job.label})`;
      $("bar").value = m.index;
      break;
    case "done":
      logLine(`✓ ${m.job.collection} #${m.job.n}`, "ok");
      $("bar").value = m.index + 1;
      $("next").disabled = true;
      break;
    case "await-manual":
      $("next").disabled = false;
      $("now").textContent += "  — waiting: click Next when ready";
      break;
    case "info": logLine(m.message, "ok"); break;
    case "warn": logLine("⚠ " + m.message, "warn"); break;
    case "error": logLine(`✗ ${m.job ? m.job.collection + " #" + m.job.n + ": " : ""}${m.message}`, "err"); break;
    case "finished": $("now").textContent = "✅ Finished"; setRunning(false); logLine("All done.", "ok"); break;
    case "stopped": $("now").textContent = "⏹ Stopped"; setRunning(false); break;
  }
});

load();
