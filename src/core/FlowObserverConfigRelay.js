(() => {
  "use strict";
  if (globalThis.FlowObserverConfigRelay) return;
  let epoch = 0;
  let published = null;
  const publish = (cache, { force = false, source = "content_cache" } = {}) => {
    const configs = cache?.data?.flow?.configs;
    const value = configs?.flow_v2_observer_transport;
    const schema = configs?.native_project_media_identity || null;
    const transport = value
      ? { version: value.version, paths: value.paths }
      : null;
    const fingerprint = JSON.stringify({ schema, transport });
    if (!force && fingerprint === published) return;
    published = fingerprint;
    const schemaEvent = new CustomEvent("TOBY_FLOW_NATIVE_MEDIA_SCHEMA", {
      detail: schema,
    });
    schemaEvent.tobyConfigSource = source;
    window.dispatchEvent(schemaEvent);
    window.dispatchEvent(
      new CustomEvent("TOBY_FLOW_OBSERVER_TRANSPORT", { detail: transport }),
    );
  };
  const load = ({ force = false, source = "relay_startup" } = {}) => {
    const ticket = ++epoch;
    ConfigSnapshotAccess.read(["toby_provider_api_configs"], (result) => {
      if (ticket === epoch)
        publish(result?.toby_provider_api_configs, { force, source });
    });
  };
  let captureEnabled = false,
    captureEpoch = 0;
  const publishCaptureSelectors = (snapshot) => {
    const flow = snapshot?.toby_provider_configs?.data?.flow;
    const profile = Object.values(flow?.profiles || {}).find(
      (value) =>
        Array.isArray(value?.host_patterns) &&
        value.host_patterns.includes(globalThis.location?.origin),
    );
    const selectors = Object.create(null);
    for (const [key, value] of Object.entries(profile?.selectors || {}).slice(
      0,
      256,
    )) {
      if (/^[a-z0-9_]{1,80}$/.test(key) && Array.isArray(value?.selectors))
        selectors[key] = {
          selectors: value.selectors
            .filter((s) => typeof s === "string" && s.length <= 2e3)
            .slice(0, 16),
        };
    }
    window.dispatchEvent(
      new CustomEvent("TOBYBRIDGE_PARITY_PROFILE", {
        detail: {
          version: 1,
          selectors,
          configVersion:
            typeof profile?.version === "number" ? profile.version : null,
        },
      }),
    );
  };
  const readCaptureSelectors = () => {
    if (!captureEnabled) return;
    const ticket = ++captureEpoch;
    ConfigSnapshotAccess.read(["toby_provider_configs"], (result) => {
      if (captureEnabled && ticket === captureEpoch)
        publishCaptureSelectors(result);
    });
  };
  window.addEventListener(
    "TOBYBRIDGE_PARITY_PROFILE_READ",
    readCaptureSelectors,
  );
  window.addEventListener("TOBYBRIDGE_CAPTURE_STATE", (event) => {
    captureEnabled = event.detail?.enabled === true;
    captureEpoch++;
    if (captureEnabled) readCaptureSelectors();
  });
  globalThis.FlowObserverConfigRelay = { publish, load };
  ConfigSnapshotAccess.start("flow");
  ConfigSnapshotAccess.onInvalidated(() => {
    epoch++;
    publish(null, { source: "access_invalidated" });
    captureEpoch++;
    if (captureEnabled) publishCaptureSelectors(null);
  });
  window.addEventListener("TOBY_FLOW_NATIVE_MEDIA_SCHEMA_READ", () =>
    load({ force: true, source: "schema_read" }),
  );
  window.addEventListener("TOBY_FLOW_OBSERVER_TRANSPORT_READ", () =>
    load({ force: true, source: "transport_read" }),
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.toby_provider_api_configs)
      load({ source: "storage_change" });
    if (area === "local" && changes.toby_provider_configs)
      readCaptureSelectors();
  });
  load();
  window.dispatchEvent(
    new CustomEvent("TOBYBRIDGE_CAPTURE_STATE_READ", { detail: null }),
  );
})();
