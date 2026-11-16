# 566Flow

Personal Chrome extension (Manifest V3) based on an MIT-licensed codebase
(see `LICENSE`; original copyright preserved). No remote service: everything
runs on-device via `src/core/LocalBackend.js`. All features unlocked, no quota.

## Status (2026-11-16, evening)

### Working — verified on the live site
- Google Flow gen: Nano Banana images, Veo 3.1 video, ratio, quantity,
  Multi-Prompt + Pipeline Queue.
- Workflow editor opens and saves locally; Tasks save and run locally.

### Fixed in this pass, needs re-test
- **Studio (Motion)**: editor crashed (`MOTION-DCFD992FC`, `reading 'length'`) because
  local projects stored `references`/`frames` as arrays, and `config/motionTool.json`
  was empty (`INVALID_TOOL_PROFILE`). Both fixed; old projects are repaired on read.
- **Tasks slow / "No new results"**: `image_url_pattern` was missing, so every prompt
  waited for config and then watched results blind until the 120s timeout.
- **Reference images**: picker/chip selectors were guesses; now mapped from the live DOM
  (`flow-add-menu-popover-content`, `flow-ingredient-bar`, `reference_picker_policy`).
- **New project button**, **page settings** (grid/size/tile details), prompt clear button.
- Error banner patterns (`error_patterns`), titles "566Flow", no "FREE" badge.

### Second pass (same evening)
- **Tasks still slow**: real cause found — `tile_container` had no `attribute`, so the
  tile selector resolved to null and no result tile was ever seen. Now the tile id is read
  from the inner `<img data-media-id>`.
- **Studio**: now fails later at `flow_download_resolutions` (items lacked `label`) and
  the bulk modal rejected object ratios (`MOTION_BULK_CONFIG_UNAVAILABLE`). Fixed.
- Startup config prefetch no longer fails because the AI-tools config (server feature) is empty.

### Models (verified on flow.google.com 2026-11-16)
- Image: Nano Banana Pro (default), Nano Banana 2 Lite, Nano Banana 2.1.
- Video: **Omni 1.2 Flash (default)**, Omni 1.1 Flash, Veo 3.1 Lite/Fast/Quality.
  Omni 1.1, Veo Fast, Veo Quality retire on Dec 5. Omni: 360p/720p; Omni 1.1 also 4–10s.
- Motion Studio lists only models with `supports_ref_video` (the Omni models).
- Model picker selectors now read `.label` only (the retirement `.caption` broke matching).

### Not tested yet
Auto-download, Angles, Effects. Tile error detection (`tile_error_*`) is still unmapped:
a failed tile is only noticed at the timeout.

### Needs a server (later, Cloudflare)
Prompt Assistant / AI script writing, Motion Studio *run* (transcription), sync,
Telegram, MCP. Watermark removal: not planned.

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
