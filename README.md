# Flow Batch Automation (Chrome extension)

Queue a list of prompts into **Google Flow**, let it generate them one at a time, and
auto-download every result into a fresh, named folder.

Flow's composer ignores synthetic keystrokes, so this extension types with **real**
keystrokes via `chrome.debugger` (CDP `Input.insertText`). That's why Chrome shows the
*"extension is debugging this browser"* banner while a run is active — it detaches when the
run finishes.

## What it does

- **Paste prompts** (one per line, or a markdown doc with ```` ```fenced``` ```` blocks) and hit Start.
- **Runs them sequentially.** Flow's Agent handles one request at a time, so the extension
  waits for each image to actually finish before submitting the next — not a fixed delay.
- **Auto-downloads each result** as it completes, into a new timestamped folder per run so
  results never mix with a previous run's images:
  ```
  Downloads/Flow-Automation/<timestamp>/<prefix>/01_<Flow's image name>.jpg
  ```
- **Names files after Flow's own image caption** (e.g. `01_Outdoor tufted seat cushion.jpg`),
  falling back to the prompt's heading.

## What it does *not* do

Mode, Aspect, **Outputs** and Model are set by **you, in Flow's own UI** (click the model
chip in Flow's prompt bar). The extension uses whatever Flow is set to and saves however many
images Flow produces. It only forces **"Confirm before generating → Never"**, otherwise the
Agent stalls waiting for a confirmation click and nothing generates.

Set **Outputs → 1x** in Flow if you want one image per prompt.

## Install (load unpacked)

1. Chrome → `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin the extension; click its icon to open the **side panel**

> After reloading the extension, also **reload the Flow tab** — Chrome doesn't re-inject
> content scripts into already-open tabs. (The extension tries to self-inject; a tab reload
> is the sure fix.)

## Use

1. Open **Google Flow** and enter a **project** (not the home screen).
2. In Flow, set Mode / Aspect / **Outputs** / Model via the model chip.
3. Open the side panel, paste your prompts, optionally set a **Name prefix** (it becomes the
   subfolder name).
4. **Start.** Keep the Flow tab as the active/focused tab — trusted typing goes to the
   focused tab.

### Prompt formats

Plain, one per line:

```
create dog image
create cat image
```

Or a markdown doc — the **fence body** becomes the prompt, the `###` heading becomes the
label, and Midjourney-style flags (`--ar 4:3 --v 6.0 --style raw`) are stripped. Flow's
composer renders markdown, so `###` and fences must never be typed into it:

~~~
### 1. Hero Three-Quarter View
```text
A product photo of a premium cushion cover, 45-degree view, photorealistic --ar 4:3 --v 6.0
```
~~~

## Permissions

| Permission | Why |
|---|---|
| `debugger` | Trusted keystrokes — Flow ignores synthetic input |
| `downloads` | Save results, and force the folder + filename |
| `scripting`, `tabs` | Inject and talk to the content script in the Flow tab |
| `sidePanel`, `storage` | The UI, and remembering your settings |
| `host_permissions: labs.google` | Only runs on Flow |

Nothing leaves your machine — no analytics, no network calls beyond Flow itself.

## Troubleshooting

| Symptom | Fix |
|---|---|
| *"Flow adapter not loaded"* | Reload the Flow tab |
| *"couldn't set auto-generate"* | In Flow's tune (⚙) settings set **Confirm before generating → Never** |
| A **Save As** dialog per file | `chrome://settings/downloads` → turn **off** "Ask where to save each file" |
| *"prompt didn't type into Flow"* | Make the Flow tab the active/focused window |
| *"can't connect trusted typing"* | Close DevTools on the Flow tab — only one debugger can attach |
| Poll timeout, nothing saved | The Agent is waiting for confirmation — see *auto-generate* above |

## Layout

| File | Role |
|---|---|
| `background.js` | Service worker: run loop, trusted typing, downloads |
| `flow-adapter.js` | **The brittle DOM layer** — every Flow selector lives here |
| `sidepanel.{html,css,js}` | The UI and prompt parsing |

Google changes the Flow UI often. When a run breaks with *"prompt box not found"* or
*"settings (tune) button not found"*, `flow-adapter.js` is the only file to recalibrate —
each helper is small and text-based. Selectors were last verified against the live
**Agent-based Flow UI (July 2026)**.

## Notes

- Flow is a Google product; automating it is a grey area in its ToS. Use your judgment.
- Outputs > 1x multiplies credit spend across a long queue. Start small.

## License

MIT
