/**
 * 566Flow ProtectedConfigClient (local).
 *
 * The original implementation fetched provider selectors / execution settings
 * from a remote service using device-bound signed leases. 566Flow has no
 * remote service, so the same public interface is kept but every operation is
 * served from files bundled in /config plus optional overrides the user can
 * store in chrome.storage.local under `local566_config_<operation>`.
 *
 *   config/dom.json        provider DOM selectors      (operation "dom")
 *   config/api.json        provider API configs        (operation "api")
 *   config/private.json    per-provider private config (operation "private")
 *   config/models.json     model registry              (operation "models")
 *   config/execution.json  execution/timing settings   (operation "execution")
 *   config/aiTools.json    AI tool settings            (operation "aiTools")
 *   config/motionTool.json motion tool settings        (operation "motionTool")
 */
(() => {
  "use strict";

  const FILES = Object.freeze({
    dom: "dom",
    api: "api",
    private: "private",
    models: "models",
    execution: "execution",
    aiTools: "aiTools",
    motionTool: "motionTool",
  });
  const SNAPSHOT_KEYS = Object.freeze({
    dom: "toby_provider_configs",
    api: "toby_provider_api_configs",
    models: "toby_provider_models",
    execution: "af_execution_config",
  });
  const cache = new Map();

  const META = Object.freeze({
    access: { contract: "device-v1", mode: "local" },
  });
  const fail = (code, httpStatus = 404) =>
    Object.assign(new Error(code), { code, httpStatus });

  function isObject(v) {
    return v && typeof v === "object" && !Array.isArray(v);
  }
  function merge(base, extra) {
    if (!isObject(base) || !isObject(extra))
      return extra === undefined ? base : extra;
    const out = { ...base };
    for (const [k, v] of Object.entries(extra)) out[k] = merge(base[k], v);
    return out;
  }

  async function load(operation) {
    const file = FILES[operation];
    if (!file) throw fail("INVALID_CONFIG_OPERATION", 422);
    if (!cache.has(operation)) {
      cache.set(
        operation,
        fetch(chrome.runtime.getURL(`config/${file}.json`))
          .then((r) => (r.ok ? r.json() : {}))
          .catch(() => ({})),
      );
    }
    const bundled = await cache.get(operation);
    const key = `local566_config_${operation}`;
    const stored = (await chrome.storage.local.get([key]))[key];
    return merge(bundled, stored);
  }

  function pick(data, options = {}) {
    if (options.provider && isObject(data)) {
      return { [options.provider]: data[options.provider] };
    }
    return data;
  }

  async function fetchConfig(operation, options = {}) {
    const data = pick(await load(operation), options);
    const snapshotKey = SNAPSHOT_KEYS[operation];
    if (snapshotKey) {
      try {
        await chrome.storage.local.set({
          [snapshotKey]: {
            data,
            fetched_at: Date.now(),
            scope: { contract: "local" },
          },
          _tobyConfigsReady: Date.now(),
        });
      } catch (_) {}
    }
    return { success: true, data, meta: META };
  }

  async function envelope(operation, options) {
    try {
      return await fetchConfig(operation, options);
    } catch (failure) {
      return {
        success: false,
        error: { code: failure.code || "CONFIG_FETCH_FAILED" },
        httpStatus: failure.httpStatus || 503,
      };
    }
  }

  const allowedSender = (sender) =>
    sender?.id === chrome.runtime.id && typeof sender.url === "string";
  const noop = async () => ({ success: true, data: {}, meta: META });

  self.ProtectedConfigClient = Object.freeze({
    configure: () => {},
    allowedSender,
    allowedProviderSender: (sender) => sender?.id === chrome.runtime.id,
    invalidate: async () => cache.clear(),
    fetch: fetchConfig,
    envelope,
    ready: async () => ({ ready: true }),
    markReady: async () => true,
    claim: noop,
    prepareMutation: async (method, url, payload) => ({
      headers: {},
      body: JSON.stringify(payload || {}),
    }),
    prepareRenewal: async () => null,
    rotate: noop,
    replaceIdentity: noop,
    status: () => ({ ready: true, code: null, retryAfterMs: 0 }),
  });
})();
