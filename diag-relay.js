// 566Flow dev aid (isolated world on flow.google.com): prints extension diagnostics to this
// page's console and lets `window.postMessage({type:"566FLOW_DEV_RELOAD"},"*")` reload the extension.
(() => {
  const KEY = "local566_diag";
  let lastId = 0;
  const dump = (list) =>
    (list || []).forEach((e) => {
      // entries without id (older builds) are printed once on load only
      if (Number.isFinite(e.id)) {
        if (e.id <= lastId) return;
        lastId = e.id;
      }
      console.log("[566Diag]", e.t, e.where, e.kind, e.msg);
    });
  chrome.storage.local.get([KEY]).then((r) => dump(r[KEY]));
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && c[KEY])
      dump((c[KEY].newValue || []).filter((e) => Number.isFinite(e.id)));
  });
  window.addEventListener("message", (e) => {
    if (e.source === window && e.data?.type === "566FLOW_DEV_RELOAD")
      chrome.runtime
        .sendMessage({ action: "566flowDevReload" })
        .catch(() => {});
  });
})();
