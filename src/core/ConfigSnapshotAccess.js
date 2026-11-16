/**
 * 566Flow ConfigSnapshotAccess (local).
 *
 * Content scripts read provider selectors / API config from chrome.storage.local
 * snapshots. The original added device-bound leases on top of that; 566Flow has
 * no remote service, so access is always granted and `ensure()` just asks the
 * service worker to (re)publish the local config snapshots from /config.
 *
 * Public surface is unchanged so existing callers keep working.
 */
(() => {
  "use strict";
  if (globalThis.ConfigSnapshotAccess) return;

  const OPERATIONS = ["dom", "api", "models", "execution"];
  let provider = null;
  let ready = null;
  const listeners = new Set();

  async function publish(force = false) {
    const results = await Promise.all(
      OPERATIONS.map((operation) =>
        chrome.runtime
          .sendMessage({ action: "FETCH_PROTECTED_CONFIG", operation, force })
          .catch(() => null),
      ),
    );
    return results.every((r) => r?.success === true);
  }

  async function ensure() {
    if (!ready) {
      ready = publish().then((ok) => {
        if (!ok) ready = null; // retry on next call
        return ok;
      });
    }
    return ready;
  }

  async function read(keys, callback) {
    await ensure();
    const result = await chrome.storage.local.get(
      typeof keys === "string" ? [keys] : keys,
    );
    if (typeof callback === "function") callback(result);
    return result;
  }

  async function privateApi(providerSlug, options = {}) {
    if (!["chatgpt", "grok", "gemini", "muse"].includes(providerSlug))
      return null;
    try {
      const response = await chrome.runtime.sendMessage({
        action: "getProviderPrivateConfigs",
        provider: providerSlug,
        force: options.force === true,
      });
      return response?.success ? response.data || null : null;
    } catch (_) {
      return null;
    }
  }

  globalThis.ConfigSnapshotAccess = Object.freeze({
    read,
    privateApi,
    ensure,
    recheckAfterBrokerRefresh: async () => ensure(),
    acceptChange: () => true,
    updateOverlay: async () => {},
    start: (value) => {
      provider = value;
      ensure().catch(() => {});
    },
    active: () => true,
    code: () => null,
    onInvalidated: (listener) => listeners.add(listener),
  });

  // Config changes made in storage (e.g. from the options page) are picked up
  // by listeners that registered through onInvalidated().
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      Object.keys(changes).some((key) => key.startsWith("local566_config_"))
    ) {
      ready = null;
      for (const listener of listeners) {
        try {
          listener();
        } catch (_) {}
      }
    }
  });
})();
