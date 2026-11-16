# 566Flow

Personal Chrome extension (Manifest V3) for batch automation on Google Flow, based on
an MIT-licensed codebase (see `LICENSE`; original copyright notice preserved).

## Status: experimental, untested in a real browser
- No remote service: `src/core/LocalBackend.js` answers all API calls on-device.
- Provider config (selectors, execution settings) lives in `config/*.json`.
- Flow selectors in `config/dom.json` are best-effort guesses. Generate/refresh them with
  `python3 tools/gen_flow_config.py`, then run `tools/flow-selector-check.js` in the DevTools
  console on flow.google.com and fix keys that report 0 matches.
- ChatGPT / Grok / Gemini / Muse selectors are not written yet.

## Load
`chrome://extensions` -> Developer mode -> Load unpacked -> select this folder.
