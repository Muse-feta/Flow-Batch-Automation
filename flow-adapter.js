/* ZIPCushions Flow Automation — content script (the brittle DOM layer).
 *
 * All selectors here are derived from the LIVE Flow UI (June 2026):
 *   - prompt box placeholder: "What do you want to create?"
 *   - model chip in the prompt bar shows the model name (e.g. "Nano Banana 2")
 *   - clicking the chip opens a popover with:
 *       Image | Video tabs
 *       aspect buttons: 16:9 4:3 1:1 3:4 9:16
 *       count buttons:  1x x2 x3 x4
 *       a model dropdown
 *   - submit is the arrow button at the right end of the prompt bar
 *
 * If Google changes the UI, THIS is the file to recalibrate. Each helper is
 * isolated and text-based so fixes are localized.
 */
(() => {
  "use strict";

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

  // ---- generic finders -----------------------------------------------------
  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  }

  const CLICKABLE_SEL =
    'button, [role="tab"], [role="radio"], [role="button"], [role="menuitemradio"], [role="option"], a, label, div, span';

  // Find a control by its visible label. Flow renders Material-Symbols icons as
  // ligature TEXT glued to the label (e.g. the chip reads "…crop_square1x"), so
  // matching an element's whole textContent fails. Instead walk TEXT NODES and
  // match the bare label node, then return its nearest clickable ancestor.
  // (Confirmed against the live Flow UI, June 2026.)
  function findByExactText(text, { root = document } = {}) {
    const want = norm(text);
    const scope = root === document ? document.body : root;
    if (!scope) return null;
    const w = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) {
      const n = w.currentNode;
      if (norm(n.nodeValue) === want) {
        const p = n.parentElement;
        if (p && visible(p)) return p.closest(CLICKABLE_SEL) || p;
      }
    }
    return null;
  }

  function byText(tag, text, { exact = false, root = document } = {}) {
    const want = norm(text);
    return (
      [...root.querySelectorAll(tag)].find((el) => {
        const t = norm(el.textContent);
        return exact ? t === want : t.includes(want);
      }) || null
    );
  }

  // Robust click: React often binds handlers to pointerdown/mousedown rather than
  // the synthetic "click" event, so dispatch the FULL pointer+mouse sequence.
  function robustClick(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.scrollIntoView({ block: "nearest" }); } catch (e) {}
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent("pointerover", o));
    el.dispatchEvent(new MouseEvent("mouseover", o));
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    if (window.PointerEvent) el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.dispatchEvent(new MouseEvent("click", o));
    if (typeof el.click === "function") { try { el.click(); } catch (e) {} }
    return true;
  }

  // Click an element even if the real handler is on an ancestor.
  function clickEl(el) {
    if (!el) return false;
    const target =
      el.closest(
        'button, [role="tab"], [role="radio"], [role="button"], [role="menuitemradio"], [role="option"], a'
      ) || el;
    return robustClick(target);
  }

  // Single, native click — for TOGGLE controls (the tune settings button, the model
  // dropdown, the panel close). robustClick fires a synthetic click AND el.click(),
  // which double-activates a toggle (open→closed) and makes it flaky. (Confirmed live.)
  function singleClick(el) {
    if (!el) return false;
    const target = el.closest('button, [role="button"]') || el;
    try { target.click(); } catch (e) { return false; }
    return true;
  }

  // ---- prompt box ----------------------------------------------------------
  // The Agent composer's prompt box is a contenteditable div[role=textbox]; its
  // placeholder ("What do you want to create?") is rendered as textContent when
  // empty (NOT a placeholder attr / aria-label). (Recalibrated live, July 2026.)
  function findPromptBox() {
    const ph = "what do you want to create";
    // 1) the composer editor, matched by placeholder text or aria/data-placeholder
    const editors = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')].filter(visible);
    let el = editors.find((e) =>
      norm(e.getAttribute("aria-label") || e.dataset.placeholder || "").includes(ph) ||
      norm(e.textContent).includes(ph)
    );
    if (el) return el;
    // 2) classic textarea / input with the placeholder attribute
    el = [...document.querySelectorAll("textarea, input[type=text]")].find((e) => norm(e.placeholder).includes(ph));
    if (el) return el;
    // 3) last resort: the lowest visible editor (composer sits at the bottom)
    const candidates = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')]
      .filter(visible)
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return candidates[0] || null;
  }

  // The Agent hides the prompt box while it is busy ("Defining the scope…" /
  // generating) and restores it when idle. Wait for it before typing the next
  // prompt — this is what makes a batch run sequentially against the agent.
  async function waitForPromptBox(timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let box = findPromptBox();
    while (!box && Date.now() < deadline) { await sleep(500); box = findPromptBox(); }
    return box;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function typePrompt(text) {
    const box = findPromptBox();
    if (!box) throw new Error("prompt box not found");
    box.focus();
    if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
      setNativeValue(box, text);
    } else {
      // contenteditable
      box.textContent = "";
      document.execCommand("insertText", false, text);
      box.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    await sleep(120);
    return true;
  }

  // ---- generation settings (Agent settings panel) --------------------------
  // Flow moved image/video config into a right-side "Agent settings" panel,
  // opened by the composer's tune button. Layout (recalibrated live, July 2026):
  //   Confirm before generating:  Always | Never  (role=radio)
  //   Image generation default:   aspect role=tab "crop_square1:1" (label suffix),
  //                               count role=tab "1x"/"x2"/"x3"/"x4", model dropdown
  //   Video generation default:   aspect (16:9 | 9:16), count, model dropdown
  //   Save
  // aspect/count labels repeat across sections, so controls are scoped by the
  // vertical band between a section header and the next header / Save button.
  function findTuneButton() {
    return [...document.querySelectorAll("button")].find((b) => visible(b) && norm(b.textContent).includes("tune")) || null;
  }
  function settingsPanel() {
    const h = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && norm(e.textContent) === "agent settings");
    if (!h) return null;
    let p = h;
    for (let i = 0; i < 12 && p.parentElement; i++) { p = p.parentElement; if (p.querySelectorAll("button").length > 8) return p; }
    return p;
  }
  function settingsOpen() { return !!settingsPanel(); }

  async function openSettings() {
    if (settingsOpen()) return true;
    const t = findTuneButton();
    if (!t) throw new Error("settings (tune) button not found");
    for (let attempt = 0; attempt < 3; attempt++) {
      if (settingsOpen()) return true;
      singleClick(t); // toggle — MUST be a single activation, not robustClick
      for (let i = 0; i < 12; i++) { await sleep(150); if (settingsOpen()) return true; }
    }
    throw new Error("Agent settings panel did not open");
  }

  // Buttons within one section's vertical band. `section` is "image" | "video".
  function sectionButtons(section) {
    const panel = settingsPanel();
    if (!panel) return [];
    const heads = [...panel.querySelectorAll("*")].filter((e) => e.children.length === 0 && /generation default/i.test(norm(e.textContent)));
    const head = heads.find((e) => norm(e.textContent).includes(section));
    if (!head) return [];
    const headTop = head.getBoundingClientRect().top;
    const top = head.getBoundingClientRect().bottom;
    const laterTops = heads.map((e) => e.getBoundingClientRect().top).filter((t) => t > headTop);
    const save = [...panel.querySelectorAll("button")].find((b) => norm(b.textContent) === "save");
    const bottom = Math.min(laterTops.length ? Math.min(...laterTops) : Infinity, save ? save.getBoundingClientRect().top : Infinity);
    return [...panel.querySelectorAll("button")].filter((b) => {
      if (!visible(b)) return false;
      const t = b.getBoundingClientRect().top;
      return t >= top && t < bottom;
    });
  }

  function setConfirm(mode /* "never" | "always" */) {
    const panel = settingsPanel();
    if (!panel) return false;
    const want = mode === "always" ? "always" : "never";
    const radio = [...panel.querySelectorAll('[role="radio"], button')].find((b) => visible(b) && norm(b.textContent).includes(want));
    if (radio && radio.getAttribute("aria-checked") !== "true") { clickEl(radio); }
    return !!radio;
  }

  async function setAspectFor(section, aspect) {
    const want = norm(aspect); // e.g. "1:1"; buttons read like "crop_square1:1"
    const btn = sectionButtons(section).find((b) => norm(b.textContent).endsWith(want));
    if (btn) { clickEl(btn); await sleep(120); return true; }
    return false;
  }
  async function setCountFor(section, count) {
    const n = String(count).replace(/[^\d]/g, "");
    const wants = (n === "1" || n === "") ? ["1x"] : ["x" + n, n + "x"]; // UI: "1x", "x2", "x3", "x4"
    const btns = sectionButtons(section);
    for (const w of wants) {
      const btn = btns.find((b) => norm(b.textContent) === w);
      if (btn) { clickEl(btn); await sleep(120); return true; }
    }
    return false;
  }
  async function setModelFor(section, modelName) {
    if (!modelName) return true;
    const dd = sectionButtons(section).find((b) => /arrow_drop_down/.test(norm(b.textContent)));
    if (!dd) return false;
    if (norm(dd.textContent).includes(norm(modelName))) return true; // already selected
    singleClick(dd); await sleep(300); // dropdown is a toggle
    const opt = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], li, button')]
      .find((e) => visible(e) && norm(e.textContent).includes(norm(modelName)));
    if (opt) { clickEl(opt); await sleep(150); return true; }
    // couldn't find it — dismiss the menu and leave the current model
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(120);
    return false;
  }

  async function saveSettings() {
    const panel = settingsPanel();
    const save = panel && [...panel.querySelectorAll("button")].find((b) => visible(b) && norm(b.textContent) === "save");
    if (save) { clickEl(save); await sleep(300); return true; }
    return false;
  }
  async function closeSettings() {
    for (let i = 0; i < 3 && settingsOpen(); i++) {
      const panel = settingsPanel();
      const x = panel && [...panel.querySelectorAll("button")].find(
        (b) => visible(b) && /(^|[^a-z])(close|arrow_back)([^a-z]|$)/.test(norm(b.textContent))
      );
      if (x) singleClick(x);
      else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await sleep(150);
    }
    return true;
  }

  // Apply mode/aspect/count/model in one panel open→Save→close cycle.
  async function configure(cfg) {
    await openSettings();
    setConfirm("never"); // don't stall an unattended batch waiting for confirmation
    await sleep(120);
    const section = cfg.mode === "video" ? "video" : "image";
    if (cfg.aspect) await setAspectFor(section, cfg.aspect);
    if (cfg.count) await setCountFor(section, cfg.count);
    if (cfg.model) await setModelFor(section, cfg.model);
    await saveSettings();
    await closeSettings();
    return true;
  }

  // Set ONLY "Confirm before generating → Never" (leave Mode/Aspect/Outputs/Model
  // to the user in Flow). Without this the Agent asks for confirmation and never
  // auto-generates, so a batch run just times out with nothing saved. Returns
  // { ok, changed } — changed=false means it was already Never (or radio absent).
  async function ensureAutoGenerate() {
    await openSettings();
    const found = setConfirm("never");
    await sleep(120);
    if (found) { await saveSettings(); }
    await closeSettings();
    return { ok: true, found };
  }

  // ---- submit --------------------------------------------------------------
  function findSubmitButton() {
    // The submit control is a button whose Material icon ligature is "arrow_forward"
    // (its full text reads "arrow_forwardcreate"). Right-most such button. (Confirmed live.)
    const btns = [...document.querySelectorAll("button")].filter(
      (b) => visible(b) && norm(b.textContent).includes("arrow_forward")
    );
    if (btns.length) return btns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    return null;
  }

  async function submit() {
    const btn = findSubmitButton();
    if (btn) { robustClick(btn); return true; }
    // fallback: Enter on the prompt box
    const box = findPromptBox();
    if (box) {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      box.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
      return true;
    }
    throw new Error("submit control not found");
  }

  // ---- generation state ----------------------------------------------------
  // A generated still is an <img> whose src is Flow's media endpoint
  // (…/media.getMediaUrlRedirect?name=…) — NOT the tiny account avatar.
  // (Confirmed against live Flow, June 2026.)
  function isGenImg(i) {
    const s = i.src || "";
    if (i.naturalWidth && i.naturalWidth < 220) return false; // excludes avatars/icons (32–96px)
    return /getMediaUrlRedirect/.test(s) ||
      /labs\.google\/fx\/api\/.*media/i.test(s) ||
      /\/fx\/.*\/(media|image|result)/i.test(s) ||
      (/(lh3|lh4|lh5|lh6)\.googleusercontent/.test(s) && !/\/a[/-]/.test(s)) ||
      (/googleusercontent/.test(s) && !/\/a\//.test(s));
  }
  function genImgs() {
    return [...document.querySelectorAll("img")].filter(isGenImg); // DOM order = newest first
  }
  // The caption Flow shows on a tile (e.g. "Golden retriever puppy sitting park").
  // Rendered as a leaf element near the <img>; skip icon ligatures / %-badges.
  function mediaCaption(img) {
    let el = img;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      const leaf = [...el.querySelectorAll("*")].find((e) => {
        if (e.childElementCount !== 0 || !visible(e)) return false;
        const t = (e.textContent || "").trim();
        return t.length > 4 && !/^[a-z_0-9%]+$/.test(t) && !/generated image/i.test(t);
      });
      if (leaf) return (leaf.textContent || "").trim();
    }
    return "";
  }
  // Generated stills as {src, name}, newest-first — name is Flow's own caption.
  function genImgItems() {
    return genImgs().map((img) => ({ src: img.src, name: mediaCaption(img) }));
  }
  function genVideos() {
    // generated videos render as <video> (src may be the media endpoint or blob)
    return [...document.querySelectorAll("video")].map((v) => v.currentSrc || v.src).filter(Boolean);
  }
  function countMedia() {
    return genImgs().length;
  }

  function genCount() {
    // number of in-progress tiles (each shows a "NN%" badge while generating)
    return [...document.querySelectorAll("div, span")].filter(
      (e) => visible(e) && /^\d{1,3}%$/.test((e.textContent || "").trim())
    ).length;
  }
  // The Agent works one request at a time: it "thinks" (Defining the Goal…) then
  // generates. During BOTH phases the composer swaps its send arrow for a Stop
  // control — so treat that (plus %-badges / spinners) as busy. This is what lets
  // the runner wait for each prompt to finish before submitting the next.
  function isGenerating() {
    if (genCount() > 0) return true;
    if (document.querySelector('[role="progressbar"], [aria-busy="true"]')) return true;
    // a Stop control anywhere in the lower composer means the agent is working
    const stop = [...document.querySelectorAll("button")].some((b) => {
      if (!visible(b) || b.getBoundingClientRect().top < 300) return false;
      const t = norm(b.textContent), a = norm(b.getAttribute("aria-label") || "");
      return /(^|[^a-z])stop([^a-z]|$)/.test(t) || a.includes("stop");
    });
    if (stop) return true;
    // fallback: the composer is present but its send arrow is gone => still busy
    return !!(findPromptBox() && !findSubmitButton());
  }

  // ---- download (Phase 2) --------------------------------------------------
  // Confirmed path (June 2026): hover a media tile -> click its ⋮ (more) button
  // -> click the "Download" item in the menu. Newest tiles render first in the grid.
  function mediaTiles() {
    // each tile contains a generated <img> and a caption; map img -> tile container
    const imgs = genImgs();
    const tiles = [];
    const seen = new Set();
    for (const img of imgs) {
      // climb to the smallest ancestor that also holds a button (the hover controls)
      let el = img;
      for (let i = 0; i < 8 && el.parentElement; i++) {
        el = el.parentElement;
        if (el.querySelector("button")) break;
      }
      if (el && !seen.has(el)) { seen.add(el); tiles.push(el); }
    }
    return tiles; // DOM order = newest first
  }

  function menuOpen() {
    return !!(findByExactText("Download") && findByExactText("Rename"));
  }

  async function downloadTile(tile) {
    // reveal hover controls
    tile.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    tile.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await sleep(250);
    // the ⋮ button carries the Material ligature "more_vert" (not text-less!)
    let more = [...tile.querySelectorAll("button")].find((b) => norm(b.textContent).includes("more_vert"));
    if (!more) more = [...tile.querySelectorAll("button")].pop(); // fallback: last button
    if (!more) throw new Error("tile more-button not found");
    // open the menu (retry — it may need a moment / second click)
    for (let attempt = 0; attempt < 3 && !menuOpen(); attempt++) {
      robustClick(more);
      await sleep(300);
    }
    if (!menuOpen()) throw new Error("tile menu did not open");
    const dl = findByExactText("Download");
    if (!dl) { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); throw new Error('"Download" item not found'); }
    clickEl(dl);
    await sleep(300);
    return true;
  }

  async function downloadNewest(count) {
    const tiles = mediaTiles();
    const n = Math.min(count || 1, tiles.length);
    let ok = 0;
    for (let i = 0; i < n; i++) {
      try { await downloadTile(tiles[i]); ok++; await sleep(500); }
      catch (e) { console.debug("[ZIPCushions Flow] download tile skipped:", e && e.message); }
    }
    return ok;
  }

  // ---- message router ------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.cmd) {
          case "ping":
            return sendResponse({ ok: true, url: location.href, project: /\/project\//.test(location.href) });
          case "configure":
            await configure({ mode: msg.mode || "image", aspect: msg.aspect, count: msg.count, model: msg.model });
            return sendResponse({ ok: true });
          case "autogen": {
            const r = await ensureAutoGenerate();
            return sendResponse(r);
          }
          case "submitPrompt": {
            // legacy synthetic path (kept as fallback; Flow ignores untrusted typing)
            const before = countMedia();
            await typePrompt(msg.text);
            await sleep(150);
            await submit();
            return sendResponse({ ok: true, mediaBefore: before });
          }
          case "focusPrompt": {
            // focus + clear the contenteditable, place caret, return its center
            // point so the background can type via the debugger (trusted input).
            // Wait for the box first: the Agent removes it while busy, so this is
            // what serialises the batch (next prompt waits for the agent to idle).
            const box = await waitForPromptBox();
            if (!box) return sendResponse({ ok: false, error: "prompt box not found (agent still busy?)" });
            box.focus();
            try {
              const sel = getSelection(), r = document.createRange();
              r.selectNodeContents(box); sel.removeAllRanges(); sel.addRange(r);
              document.execCommand("delete");
              const r2 = document.createRange(); r2.selectNodeContents(box); r2.collapse(false);
              sel.removeAllRanges(); sel.addRange(r2);
            } catch (e) {}
            const rect = box.getBoundingClientRect();
            return sendResponse({ ok: true, before: countMedia(), beforeVid: genVideos().length, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
          }
          case "clickSubmit": {
            await submit();
            return sendResponse({ ok: true });
          }
          case "promptRect": {
            // box center WITHOUT clearing it — used to re-focus before a retry submit/Enter.
            const box = findPromptBox();
            if (!box) return sendResponse({ ok: false, error: "prompt box not found" });
            const r = box.getBoundingClientRect();
            return sendResponse({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
          case "submitEnabled": {
            // is the submit arrow present AND not disabled? (Flow disables it with no text / mid-accept)
            const b = findSubmitButton();
            const dis = !!b && (b.disabled || b.getAttribute("aria-disabled") === "true" || /true/i.test(b.getAttribute("aria-disabled") || ""));
            return sendResponse({ ok: true, present: !!b, enabled: !!b && !dis });
          }
          case "readPrompt": {
            const box = findPromptBox();
            return sendResponse({ ok: true, text: box ? norm(box.textContent) : "" });
          }
          case "dismiss": {
            for (let i = 0; i < 2; i++) {
              document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
              await sleep(90);
            }
            return sendResponse({ ok: true });
          }
          case "submitRect": {
            const btn = findSubmitButton();
            if (!btn) return sendResponse({ ok: false, error: "submit button not found" });
            btn.scrollIntoView({ block: "nearest" });
            const r = btn.getBoundingClientRect();
            return sendResponse({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
          case "status":
            return sendResponse({ ok: true, generating: isGenerating(), genCount: genCount(), media: countMedia(), videos: genVideos().length });
          case "mediaSrcs":
            // both generated images and videos, newest-first
            return sendResponse({ ok: true, images: genImgs().map((i) => i.src), videos: genVideos() });
          case "mediaItems":
            // generated stills as {src, name}, newest-first (name = Flow's caption)
            return sendResponse({ ok: true, images: genImgItems(), videos: genVideos() });
          case "upscale": {
            // fetch the image (CORS-ok), draw to a canvas at `size` longest-side,
            // return a JPEG data URL. Uses a blob source so the canvas isn't tainted.
            try {
              const r = await fetch(msg.url); const b = await r.blob();
              const bmp = await createImageBitmap(b);
              const size = msg.size || 2048;
              const scale = size / Math.max(bmp.width, bmp.height);
              const c = document.createElement("canvas");
              c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
              const ctx = c.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
              ctx.drawImage(bmp, 0, 0, c.width, c.height);
              return sendResponse({ ok: true, dataUrl: c.toDataURL("image/jpeg", 0.92), w: c.width, h: c.height });
            } catch (e) { return sendResponse({ ok: false, error: String(e && e.message || e) }); }
          }
          case "download": {
            const did = await downloadNewest(msg.count || 1);
            return sendResponse({ ok: true, downloaded: did });
          }
          case "tileSrcs":
            // direct image URLs of the generated stills, newest-first
            return sendResponse({ ok: true, srcs: genImgs().map((i) => i.src) });
          case "tileCount":
            return sendResponse({ ok: true, count: mediaTiles().length });
          case "tileRect": {
            const t = mediaTiles()[msg.index];
            if (!t) return sendResponse({ ok: false, error: "no tile " + msg.index });
            t.scrollIntoView({ block: "center" });
            await sleep(120);
            const r = t.getBoundingClientRect();
            return sendResponse({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
          case "moreRect": {
            const t = mediaTiles()[msg.index];
            if (!t) return sendResponse({ ok: false, error: "no tile " + msg.index });
            t.scrollIntoView({ block: "center" });
            await sleep(80);
            let m = [...t.querySelectorAll("button")].find((b) => norm(b.textContent).includes("more_vert"));
            if (!m) m = [...t.querySelectorAll("button")].pop();
            if (!m) return sendResponse({ ok: false, error: "no more button" });
            const r = m.getBoundingClientRect();
            return sendResponse({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
          case "downloadItemRect": {
            const el = findByExactText("Download");
            if (!el) return sendResponse({ ok: false, error: "no Download item" });
            const r = el.getBoundingClientRect();
            return sendResponse({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 });
          }
          default:
            return sendResponse({ ok: false, error: "unknown cmd " + msg.cmd });
        }
      } catch (e) {
        return sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  });

  console.log("[ZIPCushions Flow] adapter loaded on", location.href);
})();
