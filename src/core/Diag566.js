/**
 * 566Flow diagnostics (dev aid). Records uncaught errors and console.error calls
 * from extension pages / the service worker into chrome.storage.local.local566_diag
 * (last 40 entries). diag-relay.js prints them in the flow.google.com console so they
 * can be read without opening the side panel's own DevTools.
 * In the service worker it also handles {action:"566flowDevReload"} -> chrome.runtime.reload().
 */
(() => {
  "use strict";
  if (globalThis.__diag566) return;
  globalThis.__diag566 = true;
  const KEY = "local566_diag";
  const where =
    typeof document === "undefined"
      ? "sw"
      : (location.pathname.split("/").pop() || "page").replace(".html", "");
  const text = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message} @ ${(v.stack || "").split("\n").slice(1, 3).join(" ").trim()}`;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  };
  let queue = Promise.resolve();
  const NOISE = /\[SSE\]|\[Watermark\]|\[WM\]|Motion Studio|MCP status check|mcp\/tokens|workflow-templates|Model catalog not ready/;
  function record(kind, args) {
    const joined = args.map(text).join(" ");
    if (NOISE.test(joined)) return;
    const entry = { t: new Date().toISOString().slice(11, 19), where, kind, msg: joined.slice(0, 600) };
    queue = queue.then(async () => {
      try {
        const cur = (await chrome.storage.local.get([KEY]))[KEY] || [];
        cur.push(entry);
        await chrome.storage.local.set({ [KEY]: cur.slice(-200) });
      } catch (_) {}
    });
  }
  const origError = console.error.bind(console);
  console.error = (...args) => { record("console.error", args); origError(...args); };
  const origWarn = console.warn.bind(console);
  console.warn = (...args) => { record("warn", args); origWarn(...args); };
  globalThis.addEventListener?.("error", (e) => record("uncaught", [e.error || e.message]));
  globalThis.addEventListener?.("unhandledrejection", (e) => record("unhandledrejection", [e.reason]));
  record("start", ["loaded"]);
  if (where === "sw") {
    chrome.runtime.onMessage.addListener((msg, sender) => {
      if (msg?.action === "566flowDevReload" && sender?.id === chrome.runtime.id) {
        setTimeout(() => chrome.runtime.reload(), 100);
      }
    });
  }
})();
