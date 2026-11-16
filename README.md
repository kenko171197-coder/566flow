# 566Flow

Personal Chrome extension (Manifest V3) based on an MIT-licensed codebase
(see `LICENSE`; original copyright preserved). No remote service: everything
runs on-device via `src/core/LocalBackend.js`. All features unlocked, no quota.

## Status (2026-11-16)

### Working — verified on the live site
- **Google Flow – single image** (Nano Banana) and **single video** (Veo):
  auto-fill prompt, auto-submit, result appears in Flow. Mode switch
  image/video, model pick, ratio (16:9 … 9:16) and quantity all apply.
- **Gemini – image**: selectors written and verified against the live DOM
  (composer, send via Enter, result `<single-image><img>`, stop/busy, download).

### Needs your test (code pushed, not yet run end-to-end)
Reload the extension, then try each and send logs if something fails:
1. **Flow batch / multi-prompt** — turn on Multi-Prompt, paste 2–3 prompts, Generate.
2. **Gemini image** — pick the Gemini provider, image mode, type a prompt, Generate.
   (Gemini generates with its default mode; the extension does not force a model.)
3. Flow **Workflow / Tasks / Angles / Effects** — each may need selector fixes.

### Not available (needs a server — out of scope for the local build)
Watermark removal, realtime (SSE), Motion Studio, Prompt Assistant, workflow
templates & sharing, Telegram, MCP, cross-device sync, accounts/quota/upgrade.

### Not done yet
ChatGPT, Grok, Muse providers (only Google Flow + Gemini so far).
Gemini does images only (no video).

## Config (selectors live outside the code, so pages can change without a rebuild)
- `config/dom.json` — DOM selectors. Flow under `flow.profiles.v2.selectors`,
  chat providers under `<provider>.selectors`.
- `config/api.json` — ratios, resolutions, durations, `supports` per provider.
- `config/models.json` — model registry (Flow: Nano Banana + Veo).
- `config/private.json` — per-provider private config (prefixes, ratios).
- `config/execution.json` — execution/timing.
- Regenerate with `python3 tools/gen_flow_config.py`, `gen_flow_models.py`,
  `gen_gemini_config.py`. Verify live with `tools/flow-selector-check.js`.

## Debugging
Extension errors are recorded to `chrome.storage.local.local566_diag` and
printed on any flow.google.com tab console as `[566Diag] …` (see `diag-relay.js`).

## Load
`chrome://extensions` → Developer mode → Load unpacked → select this folder.

## Regeneration order (important)
Run in this order — `gen_flow_config.py` now MERGES into `config/api.json` so it
no longer wipes the ratios/resolutions written by `gen_flow_models.py`:
1. `python3 tools/gen_flow_config.py`
2. `python3 tools/gen_flow_models.py`
3. `python3 tools/gen_gemini_config.py`
