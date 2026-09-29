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

  // ---- prompt box & injection ----------------------------------------------
  // Deep search across standard DOM tree and open Shadow Roots
  function queryAllDeep(selector, root = document) {
    let results = [...root.querySelectorAll(selector)];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.shadowRoot) {
        results = results.concat(queryAllDeep(selector, node.shadowRoot));
      }
    }
    return results;
  }

  // The prompt box in Google Flow can be a <textarea>, a contenteditable element
  // (div/p with contenteditable="true" or contenteditable="plaintext-only"), or
  // an element with role="textbox".
  function findPromptBox() {
    const phKeywords = ["what do you want to create", "describe", "prompt", "imagine", "type", "create"];

    // 1) Collect all candidate interactive text elements deep in the DOM & Shadow Roots
    const rawCandidates = queryAllDeep(
      'textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]'
    ).filter(visible);

    if (!rawCandidates.length) return null;

    // Filter out search bars or top-bar elements (Google Flow search is at y < 130)
    const validCandidates = rawCandidates.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 120 && (el.getAttribute("type") === "search" || /search|filter/i.test(el.getAttribute("aria-label") || "") || /search/i.test(el.getAttribute("placeholder") || ""))) {
        return false;
      }
      return true;
    });

    if (!validCandidates.length) return null;

    // Score candidates based on relevance, attributes, and proximity to the prompt bar
    const scored = validCandidates.map((el) => {
      let score = 0;
      const r = el.getBoundingClientRect();
      const aria = norm(el.getAttribute("aria-label") || "");
      const placeholder = norm(el.getAttribute("placeholder") || el.placeholder || (el.dataset && el.dataset.placeholder) || "");
      const text = norm(el.textContent || "");
      const role = norm(el.getAttribute("role") || "");

      // Proximity to bottom: Google Flow's prompt bar is docked in the lower part of the window
      if (r.bottom > window.innerHeight * 0.45) score += 30;
      if (r.top < 120) score -= 100; // Search inputs at top

      // Placeholder or label matching
      for (const kw of phKeywords) {
        if (placeholder.includes(kw)) { score += 50; break; }
        if (aria.includes(kw)) { score += 40; break; }
        if (text.includes(kw)) { score += 30; break; }
      }

      // Element type preference
      if (el.tagName === "TEXTAREA") score += 25;
      else if (el.isContentEditable || el.getAttribute("contenteditable") !== null) score += 25;
      else if (role === "textbox") score += 15;

      // Inside container with submit button or model pill
      const container = el.closest('form, [role="region"], div');
      if (container) {
        if (container.querySelector('button, [role="button"]')) score += 15;
      }

      // If this element contains child editables, penalize it so we choose the leaf editor
      const childEditable = el.querySelector('textarea, [contenteditable]:not([contenteditable="false"]), input');
      if (childEditable && childEditable !== el) score -= 40;

      return { el, score, r };
    });

    scored.sort((a, b) => b.score - a.score);

    let chosen = scored[0] ? scored[0].el : null;

    // Ensure if a container was chosen, pick its leaf editable child if present
    if (chosen && chosen.tagName !== "TEXTAREA" && chosen.tagName !== "INPUT" && !chosen.isContentEditable) {
      const inner = chosen.querySelector('textarea, [contenteditable]:not([contenteditable="false"]), input');
      if (inner && visible(inner)) {
        chosen = inner;
      }
    }

    return chosen;
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

  // Safe coordinate calculation for focusing/clicking the text editor.
  // CRITICAL: Click on the LEFT side of the text area to avoid clicking model chips or buttons.
  function getPromptBoxCoordinates(box) {
    if (!box) return { x: 0, y: 0 };
    const r = box.getBoundingClientRect();
    const clickX = Math.min(r.left + 35, r.left + r.width / 4);
    const clickY = r.top + r.height / 2;
    return { x: clickX, y: clickY, rect: r };
  }

  // Read the current text value from prompt editor, safely filtering out placeholder text
  function readPromptValue(box) {
    if (!box) return "";
    let val = "";
    if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
      val = box.value || "";
    } else if (box.isContentEditable || box.getAttribute("contenteditable") !== null) {
      const ph = "what do you want to create";
      const raw = box.textContent || box.innerText || "";
      // If content is purely the placeholder text, treat as empty
      if (norm(raw) === ph || norm(raw) === ph + "?") {
        val = "";
      } else {
        val = raw;
      }
    } else {
      val = box.value !== undefined ? box.value : (box.innerText || box.textContent || "");
    }
    return val;
  }

  // Robust native value setter for textarea/input with React 16-19 tracker handling
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }

    // React 16-19 value tracker support: React checks _valueTracker to detect changes.
    // If we don't update/reset it, React ignores the synthetic input event!
    if (el._valueTracker) {
      el._valueTracker.setValue(value === "" ? "previous_dummy_val" : "");
    }

    // 1. Dispatch beforeinput (vital for modern frameworks)
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (_) {}

    // 2. Dispatch input
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (_) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // 3. Dispatch change
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Clear contenteditable element
  function clearContentEditable(el) {
    el.focus();
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand("delete", false, null);
      }
    } catch (_) {}
    if (el.textContent && el.textContent.trim().length > 0) {
      el.textContent = "";
    }
    try {
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
    } catch (_) {}
  }

  // Robust contenteditable text insertion with caret range and input events
  function setContentEditableText(el, text) {
    el.focus();

    // 1. Place caret inside element
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    // 2. Dispatch beforeinput
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: text,
      }));
    } catch (_) {}

    // 3. Insert via execCommand (most reliable for contenteditable / ProseMirror / Lexical)
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (_) {}

    // 4. Fallback if execCommand failed or was blocked
    if (!ok || !el.textContent.includes(text.slice(0, 15))) {
      el.textContent = text;
    }

    // 5. Dispatch input
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        composed: true,
        inputType: "insertText",
        data: text,
      }));
    } catch (_) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // Direct React props/handlers fallback
  function triggerReactHandlers(el, value) {
    try {
      const propKey = Object.keys(el).find((k) => k.startsWith("__reactProps") || k.startsWith("__reactEventHandlers"));
      if (propKey && el[propKey]) {
        const props = el[propKey];
        if (typeof props.onChange === "function") {
          props.onChange({ target: el, currentTarget: el, type: "change" });
        }
        if (typeof props.onInput === "function") {
          props.onInput({ target: el, currentTarget: el, type: "input" });
        }
      }
    } catch (_) {}
  }

  // Complete robust prompt injection
  async function injectPrompt(text) {
    console.log("[Flow Batch] Queue prompt:", text ? text.slice(0, 60) + "..." : "(empty)");
    const box = findPromptBox();
    if (!box) {
      console.error("[Flow Batch] Prompt box not found!");
      return { ok: false, error: "Prompt box not found", recognized: false };
    }

    console.log("[Flow Batch] Found Flow input:", `<${box.tagName.toLowerCase()}>`, {
      id: box.id || null,
      role: box.getAttribute("role") || null,
      placeholder: box.getAttribute("placeholder") || box.placeholder || null,
      isContentEditable: box.isContentEditable,
      rect: box.getBoundingClientRect(),
    });

    console.log("[Flow Batch] Injecting prompt...");

    // 1. Focus
    box.focus();
    await sleep(60);

    // 2. Clear
    if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
      setNativeValue(box, "");
    } else {
      clearContentEditable(box);
    }
    await sleep(40);

    // 3. Insert text
    if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
      setNativeValue(box, text);
    } else {
      setContentEditableText(box, text);
    }

    // 4. Sync React handlers
    triggerReactHandlers(box, text);

    await sleep(150);

    // 5. Verification
    const currentVal = readPromptValue(box);
    console.log("[Flow Batch] Input value after injection:", currentVal ? `"${currentVal.slice(0, 60)}..."` : "(empty)");

    const promptSnippet = norm(text.slice(0, 20));
    const recognized = promptSnippet ? norm(currentVal).includes(promptSnippet) : currentVal.trim().length > 0;
    console.log("[Flow Batch] Flow recognized prompt:", recognized ? "YES" : "NO");

    const submitBtn = findSubmitButton();
    const btnDisabled = isSubmitButtonDisabled(submitBtn);
    console.log("[Flow Batch] Generate button state:", btnDisabled ? "disabled" : "enabled");

    return {
      ok: recognized,
      recognized,
      currentValue: currentVal,
      generateEnabled: !btnDisabled,
    };
  }

  async function typePrompt(text) {
    const res = await injectPrompt(text);
    if (!res.ok) {
      console.warn("[Flow Batch] injectPrompt verification returned not recognized, will retry");
    }
    return res.ok;
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
    return (
      [...document.querySelectorAll('button, [role="button"]')].find((b) => {
        if (!visible(b)) return false;
        const text = norm(b.textContent);
        const aria = norm(b.getAttribute("aria-label") || "");
        return text.includes("tune") || aria.includes("tune") || aria.includes("settings");
      }) || null
    );
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
    if (!t) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (settingsOpen()) return true;
      singleClick(t); // toggle — MUST be a single activation, not robustClick
      for (let i = 0; i < 12; i++) { await sleep(150); if (settingsOpen()) return true; }
    }
    return settingsOpen();
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
    try {
      const t = findTuneButton();
      if (!t) return false;
      const opened = await openSettings();
      if (!opened) return false;
      setConfirm("never"); // don't stall an unattended batch waiting for confirmation
      await sleep(120);
      const section = cfg.mode === "video" ? "video" : "image";
      if (cfg.aspect) await setAspectFor(section, cfg.aspect);
      if (cfg.count) await setCountFor(section, cfg.count);
      if (cfg.model) await setModelFor(section, cfg.model);
      await saveSettings();
      await closeSettings();
      return true;
    } catch (e) {
      console.warn("[ZIPCushions Flow] configure settings skipped:", e);
      return false;
    }
  }

  // Set ONLY "Confirm before generating → Never" (leave Mode/Aspect/Outputs/Model
  // to the user in Flow). If the UI uses a pill/chip without a tune button, or if
  // opening settings fails, resolve gracefully with { ok: true, skipped: true }
  // to allow the batch run to continue unhindered.
  async function ensureAutoGenerate() {
    try {
      const tuneBtn = findTuneButton();
      if (!tuneBtn) {
        return { ok: true, skipped: true };
      }
      const opened = await openSettings();
      if (!opened && !settingsOpen()) {
        return { ok: true, skipped: true };
      }
      const found = setConfirm("never");
      await sleep(120);
      if (found) { await saveSettings(); }
      await closeSettings();
      return { ok: true, found };
    } catch (e) {
      console.warn("[ZIPCushions Flow] settings (tune) panel logic skipped:", e);
      return { ok: true, skipped: true, error: String(e && e.message || e) };
    }
  }

  // ---- submit --------------------------------------------------------------
  function isSubmitButtonDisabled(b) {
    if (!b) return true;
    if (b.disabled) return true;
    if (b.getAttribute("aria-disabled") === "true" || /true/i.test(b.getAttribute("aria-disabled") || "")) return true;
    if (b.classList.contains("disabled") || b.getAttribute("data-disabled") === "true") return true;
    try {
      const cs = getComputedStyle(b);
      if (cs.pointerEvents === "none") return true;
      if (parseFloat(cs.opacity) < 0.4) return true;
    } catch (_) {}
    try {
      const rKey = Object.keys(b).find((k) => k.startsWith("__reactProps"));
      if (rKey && b[rKey]) {
        if (b[rKey].disabled === true || b[rKey]["aria-disabled"] === true) return true;
      }
    } catch (_) {}
    return false;
  }

  function isStopButton(b) {
    if (!b) return false;
    const t = norm(b.textContent);
    const a = norm(b.getAttribute("aria-label") || "");
    const title = norm(b.getAttribute("title") || "");
    return /(^|[^a-z])stop([^a-z]|$)/.test(t) || a.includes("stop") || title.includes("stop");
  }

  function findSubmitButton() {
    // 1) Standard buttons with "arrow_forward" text/ligature or aria-label
    const arrowBtns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
      if (!visible(b) || isStopButton(b)) return false;
      const text = norm(b.textContent);
      const aria = norm(b.getAttribute("aria-label") || "");
      const title = norm(b.getAttribute("title") || "");
      return text.includes("arrow_forward") || aria.includes("arrow_forward") || title.includes("arrow_forward");
    });
    if (arrowBtns.length) {
      return arrowBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    }

    // 2) Semantic submit/send/generate/run/create buttons
    const semanticBtns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
      if (!visible(b) || isStopButton(b)) return false;
      const aria = norm((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || ""));
      return /submit|send|generate|run|create prompt/.test(aria);
    });
    if (semanticBtns.length) {
      return semanticBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    }

    // 3) SVG / icon-based submit arrow situated on the far-right of the prompt dock
    const box = findPromptBox();
    if (box) {
      const boxRect = box.getBoundingClientRect();

      // Find dock or composer container enclosing the prompt box
      let container = box.closest('form, [role="region"]');
      if (!container) {
        let cur = box.parentElement;
        while (cur && cur !== document.body) {
          if (cur.querySelectorAll('button, [role="button"]').length > 0) {
            container = cur;
            break;
          }
          cur = cur.parentElement;
        }
      }

      // Collect buttons in container or near the prompt box vertically
      let dockBtns = [];
      if (container) {
        dockBtns = [...container.querySelectorAll('button, [role="button"]')].filter(visible);
      }
      if (!dockBtns.length) {
        dockBtns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
          if (!visible(b)) return false;
          const r = b.getBoundingClientRect();
          return Math.abs(r.top - boxRect.top) < 100 || (r.bottom >= boxRect.top && r.top <= boxRect.bottom);
        });
      }

      // Filter out non-submit buttons (stop, tune, settings, attachments, close)
      const validBtns = dockBtns.filter((b) => {
        if (isStopButton(b)) return false;
        const text = norm(b.textContent);
        const aria = norm((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("title") || ""));
        if (text.includes("tune") || aria.includes("tune") || aria.includes("settings")) return false;
        if (aria.includes("attach") || aria.includes("upload") || text.includes("attach_file")) return false;
        if (text.includes("close") || aria.includes("close") || aria.includes("dismiss")) return false;
        return true;
      });

      // Prefer buttons containing an SVG (icon-based submit arrows)
      const svgBtns = validBtns.filter((b) => b.querySelector("svg"));
      if (svgBtns.length) {
        return svgBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
      }

      // Fallback: far-right button in the prompt dock
      if (validBtns.length) {
        return validBtns.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
      }
    }

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
  // Helper to filter out user avatars, system icons, and small UI thumbnails
  function isAvatarOrIcon(el, url) {
    const s = url || (el && (el.src || el.currentSrc)) || "";
    if (/\/a[/-]/i.test(s) || /googleusercontent\.com\/a\//i.test(s) || /lh\d\.googleusercontent\.com\/a\//i.test(s)) return true;
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      const nw = el.naturalWidth || 0, nh = el.naturalHeight || 0;
      const w = nw || r.width || el.width || 0;
      const h = nh || r.height || el.height || 0;
      if ((w > 0 && w < 150) || (h > 0 && h < 150)) return true;
    }
    const cls = (el && el.className) || "";
    if (typeof cls === "string" && /avatar|profile|icon|badge|logo/i.test(cls)) return true;
    const alt = el && el.getAttribute ? (el.getAttribute("alt") || "") : "";
    if (/avatar|profile/i.test(alt)) return true;
    return false;
  }

  function isGenImg(i) {
    if (!i) return false;
    const s = (i.src || i.currentSrc || "").trim();
    if (!s) return false;
    if (isAvatarOrIcon(i, s)) return false;

    // Check size if already loaded/rendered
    const r = i.getBoundingClientRect ? i.getBoundingClientRect() : { width: 0, height: 0 };
    const w = i.naturalWidth || r.width || i.width || 0;
    const h = i.naturalHeight || r.height || i.height || 0;
    if (w > 0 && w < 150) return false;
    if (h > 0 && h < 150) return false;

    // Known media endpoints / protocols
    if (/getMediaUrlRedirect/.test(s)) return true;
    if (/(labs|flow)\.google(\.com)?\/.*(media|image|result|api)/i.test(s)) return true;
    if (/\/fx\/.*\/(media|image|result)/i.test(s)) return true;
    if (s.startsWith("blob:") || s.startsWith("data:")) return true;
    if (/googleusercontent\.com/i.test(s) && !/\/a[/-]/.test(s)) return true;

    // Any other visible card/canvas image on page with valid dimensions
    return (w >= 150 || w === 0) && (h >= 150 || h === 0);
  }

  function genImgs() {
    // 1) Search for all matching <img> elements
    const imgs = [...document.querySelectorAll("img")].filter((i) => visible(i) && isGenImg(i));
    if (imgs.length > 0) return imgs;

    // 2) Fallback: Check if tiles use <canvas>
    const canvases = [...document.querySelectorAll("canvas")].filter((c) => {
      if (!visible(c)) return false;
      const r = c.getBoundingClientRect();
      return r.width >= 150 && r.height >= 150;
    });
    if (canvases.length > 0) {
      const items = [];
      for (const c of canvases) {
        try {
          const dataUrl = c.toDataURL("image/png");
          if (dataUrl && dataUrl.length > 100) {
            items.push({ src: dataUrl, element: c });
          }
        } catch (e) {}
      }
      if (items.length > 0) return items;
    }

    // 3) Fallback: Check if tiles use CSS background-image
    const bgEls = [...document.querySelectorAll("div, span, section, article")].filter((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 150) return false;
      const bg = getComputedStyle(el).backgroundImage || "";
      return bg && bg.startsWith("url(") && !isAvatarOrIcon(el, bg);
    });
    if (bgEls.length > 0) {
      const items = [];
      for (const el of bgEls) {
        const bg = getComputedStyle(el).backgroundImage;
        const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
        if (m && m[1]) {
          items.push({ src: m[1], element: el });
        }
      }
      if (items.length > 0) return items;
    }

    return [];
  }

  // The caption Flow shows on a tile (e.g. "Golden retriever puppy sitting park").
  function mediaCaption(img) {
    let el = img && (img.element || img);
    if (!el || !el.parentElement) return "";
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
    return genImgs().map((item) => {
      const el = item.element || item;
      const src = item.src || el.currentSrc || el.src || "";
      return { src, name: mediaCaption(el) };
    });
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
  // control — so treat that (plus %-badges / spinners) as busy.
  function isGenerating() {
    if (genCount() > 0) return true;
    if (document.querySelector('[role="progressbar"], [aria-busy="true"], .progress-bar, [data-is-generating="true"]')) return true;
    // a Stop control anywhere in the lower composer means the agent is working
    const stop = [...document.querySelectorAll('button, [role="button"]')].some((b) => {
      if (!visible(b) || b.getBoundingClientRect().top < 250) return false;
      return isStopButton(b);
    });
    if (stop) return true;

    // Check for thinking / generating text chips in Flow
    const busyChip = [...document.querySelectorAll("span, div, p, [role='status']")].some((el) => {
      if (!visible(el)) return false;
      const t = (el.textContent || "").trim();
      return /^(generating|thinking|creating|rendering|running)\b/i.test(t) && el.getBoundingClientRect().top > 200;
    });
    if (busyChip) return true;

    return false;
  }

  // Convert blob URL or DOM image to clean PNG data URL inside page context (prevents .jfif / WebP)
  async function blobToDataUrl(url) {
    if (!url) throw new Error("No URL provided");

    // Method 1: Fetch raw blob directly and convert with FileReader (avoids canvas black frame)
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      if (blob && blob.size > 100) {
        const reader = new FileReader();
        return await new Promise((resolve, reject) => {
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }
    } catch (fetchErr) {
      console.debug("[Flow Adapter] Direct blob fetch failed, falling back to canvas:", fetchErr);
    }

    // Method 2: If an existing DOM <img> already has this source and is loaded, draw to canvas
    const imgEl = [...document.querySelectorAll("img")].find((i) => (i.src === url || i.currentSrc === url));
    if (imgEl) {
      try {
        if (typeof imgEl.decode === "function") {
          await imgEl.decode().catch(() => {});
        }
        const w = imgEl.naturalWidth || imgEl.width || 512;
        const h = imgEl.naturalHeight || imgEl.height || 512;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(imgEl, 0, 0, w, h);
        return canvas.toDataURL("image/png");
      } catch (e) {
        console.debug("[Flow Adapter] Canvas draw from imgEl failed:", e);
      }
    }
    throw new Error("Failed to convert image to Data URL");
  }

  // ---- download (Phase 2 fallback) -----------------------------------------
  // Confirmed path (June 2026): hover a media tile -> click its ⋮ (more) button
  // -> click the "Download" item in the menu. Newest tiles render first in the grid.
  function mediaTiles() {
    // each tile contains a generated <img> and a caption; map img -> tile container
    const items = genImgs();
    const tiles = [];
    const seen = new Set();
    for (const item of items) {
      let el = item.element || item;
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

  // Detect error banners/messages on Google Flow (e.g. policy violations, unusual activity, rate limits, failures)
  function detectFlowError() {
    // 1. Look for known error toast/snackbar/banner/dialog/alert elements
    // CRITICAL: MUST NOT inspect existing tiles/cards on the canvas, because an old
    // "OPERATION FAILED" card from a previous failure must never block retries or new prompts!
    const isInsideCanvasCard = (el) => {
      try {
        return !!el.closest('[class*="tile" i], [class*="card" i], [class*="canvas" i], [class*="workspace" i], [class*="grid" i], flow-card, flow-tile');
      } catch (_) {
        return false;
      }
    };

    const errorContainers = [
      ...document.querySelectorAll(
        '[role="alert"], [role="dialog"], [aria-live="assertive"], [class*="snackbar" i], [class*="toast" i], [class*="banner" i], mat-snack-bar-container, mwc-snackbar, .error-message'
      )
    ].filter((el) => visible(el) && !isInsideCanvasCard(el));

    // 2. Also look at small floating overlay notifications
    const allCandidates = new Set(errorContainers);
    document.querySelectorAll('[role="alert"] p, [role="alert"] span, [role="dialog"] p, [role="dialog"] span, [class*="snackbar" i] span, [class*="toast" i] span').forEach((el) => {
      if (visible(el) && !isInsideCanvasCard(el)) allCandidates.add(el);
    });

    for (const el of allCandidates) {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;

      // Empty prompt validation error from Flow UI
      if (/prompt must be provided|please enter a prompt|prompt is required|empty prompt/i.test(text)) {
        return {
          hasError: true,
          type: "empty_prompt",
          message: text.length > 140 ? text.slice(0, 140) + "..." : text
        };
      }

      // Policy violation
      if (/policy|safety guidelines|content violation|restricted content|violat|prompt blocked|against our policy/i.test(text)) {
        return {
          hasError: true,
          type: "policy",
          message: text.length > 140 ? text.slice(0, 140) + "..." : text
        };
      }

      // Unusual activity / rate limit / quota
      if (/unusual activity|unusual traffic|quota|rate limit|too many requests|suspicious activity|try again later/i.test(text)) {
        return {
          hasError: true,
          type: "unusual_activity",
          message: text.length > 140 ? text.slice(0, 140) + "..." : text
        };
      }

      // General generation failure in floating toast/dialog
      if (/failed to generate|generation failed|unable to generate|could not generate|something went wrong|error generating|cannot generate/i.test(text)) {
        return {
          hasError: true,
          type: "failed",
          message: text.length > 140 ? text.slice(0, 140) + "..." : text
        };
      }
    }

    return { hasError: false };
  }

    // Full DOM Diagnostic as required for inspecting Flow page
  function diagnoseDOM() {
    console.group("[Flow Batch Diagnostic] Google Flow DOM Inspection");
    const editables = queryAllDeep('textarea, input:not([type="button"]):not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    
    console.log(`[Flow Batch Diagnostic] Found ${editables.length} editable candidate elements across document and shadow roots:`);
    const candidateInfos = editables.map((el, i) => {
      const r = el.getBoundingClientRect();
      return {
        index: i,
        tagName: el.tagName,
        isContentEditable: el.isContentEditable || el.getAttribute("contenteditable") !== null,
        role: el.getAttribute("role") || "",
        placeholder: el.getAttribute("placeholder") || el.placeholder || (el.dataset && el.dataset.placeholder) || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
        valueSnippet: (el.value || el.textContent || "").slice(0, 30),
      };
    });
    console.table(candidateInfos);

    const box = findPromptBox();
    let boxDiag = null;
    if (box) {
      const r = box.getBoundingClientRect();
      const parents = [];
      let p = box.parentElement;
      while (p && parents.length < 8) {
        parents.push(`${p.tagName.toLowerCase()}${p.id ? '#' + p.id : ''}${p.className ? '.' + String(p.className).trim().replace(/\s+/g, '.') : ''}`);
        p = p.parentElement;
      }

      // Check if inside shadow root or iframe
      let isShadow = false;
      let curr = box.parentNode;
      while (curr) {
        if (curr instanceof ShadowRoot) { isShadow = true; break; }
        curr = curr.parentNode;
      }
      const inIframe = window.self !== window.top;

      boxDiag = {
        tagName: box.tagName,
        id: box.id || null,
        className: box.className || null,
        role: box.getAttribute("role") || null,
        placeholder: box.getAttribute("placeholder") || box.placeholder || (box.dataset && box.dataset.placeholder) || null,
        ariaLabel: box.getAttribute("aria-label") || null,
        contenteditable: box.getAttribute("contenteditable"),
        isContentEditable: box.isContentEditable,
        isTextarea: box.tagName === "TEXTAREA",
        isInput: box.tagName === "INPUT",
        currentValue: box.value !== undefined ? box.value : null,
        currentTextContent: box.textContent || null,
        currentInnerText: box.innerText || null,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height, bottom: r.bottom },
        parentChain: parents.join(" > "),
        isInsideShadowRoot: isShadow,
        isInsideIframe: inIframe,
      };

      console.log("[Flow Batch Diagnostic] Active/Chosen Prompt Editor:", boxDiag);
    } else {
      console.warn("[Flow Batch Diagnostic] No Prompt Editor found!");
    }

    const btn = findSubmitButton();
    let btnDiag = null;
    if (btn) {
      const br = btn.getBoundingClientRect();
      btnDiag = {
        tagName: btn.tagName,
        className: btn.className || null,
        ariaLabel: btn.getAttribute("aria-label") || null,
        title: btn.getAttribute("title") || null,
        disabled: btn.disabled || false,
        ariaDisabled: btn.getAttribute("aria-disabled") || null,
        hasSvg: !!btn.querySelector("svg"),
        rect: { left: br.left, top: br.top, width: br.width, height: br.height },
        effectivelyDisabled: isSubmitButtonDisabled(btn),
      };
      console.log("[Flow Batch Diagnostic] Active/Chosen Generate Button:", btnDiag);
    } else {
      console.warn("[Flow Batch Diagnostic] No Generate Button found!");
    }

    const flowErrors = detectFlowError();
    console.log("[Flow Batch Diagnostic] Flow Errors Detected:", flowErrors);
    console.groupEnd();

    return {
      ok: true,
      timestamp: new Date().toISOString(),
      url: location.href,
      promptBox: boxDiag,
      submitButton: btnDiag,
      candidatesCount: editables.length,
      candidates: candidateInfos,
      flowErrors,
    };
  }

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
          case "typePrompt": {
            await typePrompt(msg.text);
            return sendResponse({ ok: true });
          }
          case "focusPrompt": {
            const box = await waitForPromptBox();
            if (!box) return sendResponse({ ok: false, error: "prompt box not found (agent still busy?)" });
            box.focus();
            try {
              if (box.tagName === "TEXTAREA" || box.tagName === "INPUT") {
                setNativeValue(box, "");
                if (typeof box.setSelectionRange === "function") {
                  box.setSelectionRange(0, 0);
                }
              } else {
                clearContentEditable(box);
              }
            } catch (e) {}
            const coords = getPromptBoxCoordinates(box);
            return sendResponse({
              ok: true,
              before: countMedia(),
              beforeVid: genVideos().length,
              x: coords.x,
              y: coords.y,
              rect: coords.rect,
              tag: box.tagName,
              isContentEditable: box.isContentEditable
            });
          }
          case "verifyPrompt": {
            const box = findPromptBox();
            if (!box) return sendResponse({ ok: false, verified: false, error: "prompt box not found" });
            const val = readPromptValue(box);
            const expected = norm(msg.expected || "");
            const recognized = expected ? norm(val).includes(expected) : val.trim().length > 0;
            const btn = findSubmitButton();
            const submitDisabled = isSubmitButtonDisabled(btn);
            console.log(`[Flow Batch] verifyPrompt: expected="${expected.slice(0, 20)}...", recognized=${recognized}, submitDisabled=${submitDisabled}`);
            return sendResponse({
              ok: true,
              verified: recognized,
              text: norm(val),
              rawText: val,
              submitDisabled,
              submitPresent: !!btn,
            });
          }
          case "diagnoseDOM": {
            const diag = diagnoseDOM();
            return sendResponse(diag);
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
            const dis = isSubmitButtonDisabled(b);
            return sendResponse({ ok: true, present: !!b, enabled: !!b && !dis });
          }
          case "readPrompt": {
            const box = findPromptBox();
            const val = readPromptValue(box);
            return sendResponse({ ok: true, text: norm(val), rawText: val });
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
          case "status": {
            const errInfo = detectFlowError();
            return sendResponse({ ok: true, generating: isGenerating(), genCount: genCount(), media: countMedia(), videos: genVideos().length, hasError: errInfo.hasError, errorType: errInfo.type, errorMessage: errInfo.message });
          }
          case "mediaSrcs":
            // both generated images and videos, newest-first
            return sendResponse({ ok: true, images: genImgItems().map((i) => i.src), videos: genVideos() });
          case "mediaItems":
            // generated stills as {src, name}, newest-first (name = Flow's caption)
            return sendResponse({ ok: true, images: genImgItems(), videos: genVideos() });
          case "getLatestGeneratedDataUrl": {
            (async () => {
              try {
                // 1. Locate all valid generated images in Flow
                const imgs = [...document.querySelectorAll("img")].filter((img) => {
                  const w = img.naturalWidth || img.clientWidth || 0;
                  const h = img.naturalHeight || img.clientHeight || 0;
                  const src = img.currentSrc || img.src || "";
                  if (w < 150 || h < 150) return false;
                  if (/\/a[/-]/.test(src) || src.includes("googleusercontent.com/a/")) return false;
                  return Boolean(src);
                });

                if (!imgs.length) {
                  // Fallback: check canvas elements
                  const canvases = [...document.querySelectorAll("canvas")].filter((c) => {
                    const w = c.width || c.clientWidth || 0;
                    const h = c.height || c.clientHeight || 0;
                    return w >= 150 && h >= 150 && visible(c);
                  });
                  if (canvases.length) {
                    try {
                      const c = canvases[0];
                      const dataUrl = c.toDataURL("image/png");
                      if (dataUrl && dataUrl.length > 200) {
                        return sendResponse({ ok: true, dataUrl, width: c.width, height: c.height, src: "canvas" });
                      }
                    } catch (_) {}
                  }
                  return sendResponse({ ok: false, error: "No generated image found on page" });
                }

                const excludeSet = new Set((msg.excludeUrls || []).map((u) => String(u || "").trim()).filter(Boolean));
                if (msg.beforeTopUrl) excludeSet.add(String(msg.beforeTopUrl).trim());

                // If excludeUrls provided, select NEW image(s) not in excludeSet
                let targetImg = null;
                if (excludeSet.size > 0) {
                  const newImgs = imgs.filter((img) => {
                    const s = (img.currentSrc || img.src || "").trim();
                    return s && !excludeSet.has(s);
                  });
                  if (newImgs.length > 0) {
                    // In Google Flow, newest tile is the last appended in DOM
                    targetImg = newImgs[newImgs.length - 1];
                  }
                }

                // If not found yet and we were looking for non-excluded images:
                if (!targetImg) {
                  if (excludeSet.size > 0) {
                    return sendResponse({ ok: false, error: "New image not rendered yet", notReady: true });
                  }
                  // Fallback: newest image overall (last or first)
                  targetImg = imgs[imgs.length - 1] || imgs[0];
                }

                const imgSrc = (targetImg.currentSrc || targetImg.src || "").trim();

                // Method 1: Fetch raw image blob directly in page context (Preserves exact bytes, avoids black canvas)
                try {
                  const resp = await fetch(imgSrc);
                  const blob = await resp.blob();
                  if (blob && blob.size > 1000) {
                    const reader = new FileReader();
                    const dataUrl = await new Promise((resolve, reject) => {
                      reader.onloadend = () => resolve(reader.result);
                      reader.onerror = reject;
                      reader.readAsDataURL(blob);
                    });
                    return sendResponse({
                      ok: true,
                      dataUrl,
                      width: targetImg.naturalWidth || targetImg.clientWidth || 1024,
                      height: targetImg.naturalHeight || targetImg.clientHeight || 576,
                      src: imgSrc,
                    });
                  }
                } catch (fetchErr) {
                  console.warn("[Flow Automation] Direct fetch failed, trying decoded canvas fallback:", fetchErr);
                }

                // Method 2: Safe Canvas Fallback (MUST await decode() to prevent black frame)
                try {
                  if (typeof targetImg.decode === "function") {
                    await targetImg.decode();
                  }
                } catch (e) {
                  // Continue if decode isn't supported or already decoded
                }

                const w = targetImg.naturalWidth || targetImg.width || 1024;
                const h = targetImg.naturalHeight || targetImg.height || 576;
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d", { willReadFrequently: true });

                // Draw onto white background to ensure transparency doesn't render black
                ctx.fillStyle = "#FFFFFF";
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(targetImg, 0, 0, w, h);

                const dataUrl = canvas.toDataURL("image/png");
                return sendResponse({ ok: true, dataUrl, width: w, height: h, src: imgSrc });
              } catch (err) {
                return sendResponse({ ok: false, error: err.message });
              }
            })();
            return true; // Keep message channel open for async response
          }
          case "fetchBlobAsDataUrl": {
            try {
              const url = msg.url;
              // If it is already a PNG data URL, return directly
              if (url.startsWith("data:image/png")) return sendResponse({ ok: true, dataUrl: url });

              const dataUrl = await blobToDataUrl(url);
              return sendResponse({ ok: true, dataUrl });
            } catch (err) {
              // Fallback: draw from existing DOM <img> onto canvas
              try {
                const imgEl = [...document.querySelectorAll("img")].find((i) => i.src === msg.url || i.currentSrc === msg.url);
                if (imgEl) {
                  const canvas = document.createElement("canvas");
                  canvas.width = imgEl.naturalWidth || imgEl.width || 512;
                  canvas.height = imgEl.naturalHeight || imgEl.height || 512;
                  const ctx = canvas.getContext("2d");
                  ctx.drawImage(imgEl, 0, 0);
                  return sendResponse({ ok: true, dataUrl: canvas.toDataURL("image/png") });
                }
              } catch (_) {}
              return sendResponse({ ok: false, error: err.message });
            }
          }
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
              return sendResponse({ ok: true, dataUrl: c.toDataURL("image/png"), w: c.width, h: c.height });
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
