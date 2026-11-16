// 566Flow dev aid (isolated world on flow.google.com): prints extension diagnostics to this
// page's console and lets `window.postMessage({type:"566FLOW_DEV_RELOAD"},"*")` reload the extension.
(() => {
  const KEY = "local566_diag";
  const dump = (list) => (list || []).forEach((e) => console.log("[566Diag]", e.t, e.where, e.kind, e.msg));
  chrome.storage.local.get([KEY]).then((r) => dump(r[KEY]));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c[KEY]) dump((c[KEY].newValue || []).slice((c[KEY].oldValue || []).length));
  });
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.type === "566FLOW_DEV_RELOAD")
      chrome.runtime.sendMessage({ action: "566flowDevReload" }).catch(() => {});
  });
})();
