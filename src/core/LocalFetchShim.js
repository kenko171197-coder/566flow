/**
 * 566Flow: some UI modules call fetch() directly against the API base URL.
 * There is no remote service, so those calls are routed to LocalBackend (in the
 * service worker) through the same `apiRequest` message the rest of the UI uses.
 */
(() => {
  "use strict";
  const PREFIX = "https://local.566flow.invalid/";
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url;
    if (!url || !url.startsWith(PREFIX)) return nativeFetch(input, init);
    const parsed = new URL(url);
    const endpoint = parsed.pathname.replace(/^\/api\/v1\//, "") + parsed.search;
    let data;
    try {
      if (typeof init?.body === "string") data = JSON.parse(init.body);
    } catch (_) {}
    const res = await chrome.runtime.sendMessage({
      action: "apiRequest",
      method: init?.method || "GET",
      endpoint,
      data,
    });
    const body = res?.success
      ? { success: true, data: res.data, ...(res.meta ? { meta: res.meta } : {}) }
      : { success: false, error: res?.error || { code: "LOCAL_BACKEND_ERROR" } };
    return new Response(JSON.stringify(body), {
      status: res?.success ? 200 : res?.httpStatus || 500,
      headers: { "Content-Type": "application/json" },
    });
  };
})();
