importScripts("src/core/Diag566.js", "src/core/LocalBackend.js");
LocalBackend.ensureLocalUser().catch(() => {});
importScripts(
  "src/core/DeviceKeyStore.js",
  "src/core/ProtectedConfigClient.js",
  "src/core/ConfigAccessRecovery.js",
);
importScripts("src/core/ProviderWorkerRegistry.js");
importScripts("src/core/FlowUuidGateway.js");
importScripts("src/core/FlowUuidRefreshCoordinator.js");
importScripts("src/core/MotionRunnerHostRegistry.js");
importScripts("src/core/MotionRunnerRecovery.js");
importScripts("src/core/MotionWebCapture.js");
importScripts("src/core/WorkflowMuseVideoStore.js");
importScripts("src/core/WorkflowSpaceArtifacts.js");
importScripts("src/core/WorkflowSpaceEventBroker.js");
importScripts(
  "src/core/WorkflowSpaceDiagnosticSchema.js",
  "src/core/WorkflowSpaceDiagnostics.js",
);
importScripts("src/core/WorkflowSpaceCommands.js");
importScripts("src/core/WorkflowRunLogStore.js");
importScripts("src/core/LegacyProviderResultWake.js");
importScripts("src/core/ProviderWebQueueStore.js");
importScripts("src/core/MotionArtifactStore.js");
importScripts("src/motion/MotionRunJournal.js");
importScripts("src/motion/MotionTranscriptOutbox.js");
const _spaceEventBroker = new WorkflowSpaceEventBroker({
  audit: (scope, documentId, diagnostic) => {
    chrome.runtime
      .sendMessage({
        action: "workflowSpaceTransportAudit",
        documentId,
        ...scope,
        diagnostic,
      })
      .catch(() => {});
  },
  readAuth: async () => (await chrome.storage.local.get("af_auth")).af_auth,
  authorize: async (scope, origin, auth) => {
    const response = await _signedFetch(
      `${getApiBaseUrl()}/workflows/${encodeURIComponent(scope.workflowId)}/space-event-grants/verify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Extension-Id": chrome.runtime.id,
        },
        body: JSON.stringify({
          grant: scope.grant,
          sessionId: scope.sessionId,
          origin,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(2e4),
      },
    );
    if (!response.ok) throw Error("SPACE_EVENTS_AUTHORIZATION_FAILED");
    return response.json();
  },
  snapshot: async (scope) => {
    const flag = (await chrome.storage.local.get("af_running_workflow"))
      .af_running_workflow;
    if (
      flag?.wf_id !== scope.workflowId ||
      !flag.owner_document_id ||
      Date.now() - (flag.last_heartbeat_at || flag.started_at || 0) >=
        5 * 60 * 1e3
    )
      return { owner: null, patches: [], reconciliationRequired: true };
    const contexts = await chrome.runtime.getContexts({
      documentIds: [flag.owner_document_id],
    });
    const allowed = [
      "sidebar.html",
      "workflow-editor.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    if (
      !contexts.some((context) =>
        allowed.includes(String(context.documentUrl || "").split(/[?#]/)[0]),
      )
    )
      return { owner: null, patches: [], reconciliationRequired: true };
    const result = await chrome.runtime
      .sendMessage({
        action: "workflowSpaceNativeEventSnapshot",
        documentId: flag.owner_document_id,
        ...scope,
      })
      .catch(() => null);
    const after = (await chrome.storage.local.get("af_running_workflow"))
      .af_running_workflow;
    if (
      after?.run_id !== flag.run_id ||
      after?.owner_document_id !== flag.owner_document_id
    )
      throw Error("SPACE_EVENTS_OWNER_CHANGED");
    return result?.ok === true && result.runId === flag.run_id
      ? {
          ...result,
          owner: flag.owner_document_id,
          reconciliationRequired: true,
        }
      : { owner: null, patches: [], reconciliationRequired: true };
  },
});
chrome.runtime.onConnectExternal.addListener((port) => {
  if (!_spaceEventBroker.accept(port)) port.disconnect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.af_auth) _spaceEventBroker.revoke();
});
try {
  importScripts(
    "src/core/WatermarkRemover.js",
    "src/core/TrackerRegenProjection.js",
    "src/core/flow-api/FlowApiDownloadRetry.js",
  );
} catch (e) {
  console.warn(
    "[Background] Kh\xF4ng n\u1EA1p \u0111\u01B0\u1EE3c WatermarkRemover:",
    e?.message,
  );
}
const _flowUuidRefreshCoordinator = new FlowUuidRefreshCoordinator(
  chrome.storage.session,
);
const _flowUuidContextProbes = new Map();
let _flowUuidStopSafetyTail = Promise.resolve();
async function _persistFlowUuidApiStop(message) {
  if (
    typeof message.jobId !== "string" ||
    !/^[A-Za-z0-9_.:-]{1,160}$/.test(message.jobId) ||
    !Array.isArray(message.projects) ||
    !message.projects.length ||
    message.projects.length > 32 ||
    message.projects.some(
      (project) =>
        project !== "unknown" && !self.flow_uuid_gateway.isUuid(project),
    )
  )
    throw Error("INVALID_STOP_SAFETY_SCOPE");
  const operations = (
    Array.isArray(message.operations) ? message.operations : []
  )
    .filter(
      (operation) =>
        self.flow_uuid_gateway.isUuid(operation.operationId) &&
        self.flow_uuid_gateway.isUuid(operation.projectId) &&
        ["image", "video"].includes(operation.mediaType),
    )
    .slice(0, 256)
    .map((operation) => ({
      operationId: operation.operationId.toLowerCase(),
      projectId: operation.projectId.toLowerCase(),
      mediaType: operation.mediaType,
      protocolRevision: Number.isInteger(operation.protocolRevision)
        ? operation.protocolRevision
        : null,
      protocolFingerprint: /^fnv1a-[a-f0-9]{8}$/.test(
        operation.protocolFingerprint || "",
      )
        ? operation.protocolFingerprint
        : null,
    }));
  const task = _flowUuidStopSafetyTail
    .catch(() => {})
    .then(async () => {
      const projects = message.projects.map((project) => project.toLowerCase());
      const keys = projects.map(
        (project) => "flow_uuid_gateway_unsettled_api:" + project,
      );
      const stored = await chrome.storage.local.get(keys),
        values = {};
      for (const [index, project] of projects.entries()) {
        const value = stored[keys[index]] || { version: 1, jobs: {} };
        for (const [jobId, job] of Object.entries(value.jobs || {})) {
          if (Object.keys(value.jobs || {}).length < 256) break;
          if (job.terminal === true) delete value.jobs[jobId];
        }
        if (
          Object.keys(value.jobs || {}).length >= 256 &&
          !value.jobs?.[message.jobId]
        )
          value.saturated = true;
        else
          value.jobs = {
            ...value.jobs,
            [message.jobId]: {
              unknown:
                message.unknown === true ||
                operations.length !== (message.operations?.length || 0),
              operations: operations.filter(
                (operation) => operation.projectId === project,
              ),
            },
          };
        values[keys[index]] = value;
      }
      await chrome.storage.local.set(values);
      return { ok: true };
    });
  _flowUuidStopSafetyTail = task;
  return task;
}
async function _reconcileFlowUuidApiStops(stored, keys, target) {
  let reads = 0;
  for (const key of keys) {
    const safety = stored[key];
    if (!safety) continue;
    if (safety.saturated || safety.unverified || !safety.jobs) return false;
    const entries = Object.entries(safety.jobs).filter(
      ([, job]) => job.terminal !== true,
    );
    if (!entries.length) continue;
    const settings = stored.af_settings || {};
    if (
      (settings.defaultGenMode || settings.gen_mode) !== "api" ||
      ![true, 1, "true"].includes(settings.apiModeEnabled)
    )
      return false;
    for (const [jobId, job] of entries) {
      if (job.terminal === true) continue;
      if (job.unknown || !job.operations?.length || job.operations.length > 256)
        return false;
      let terminal = true;
      for (const operation of job.operations) {
        if (++reads > 16) return false;
        if (operation.projectId !== target.projectId) return false;
        const input = {
          ...operation,
          apiDriver: "v2",
          flowTabId: target.tabId,
        };
        const ready = await _flowApiDownloadPreflight({
          ...input,
          acceptedMonitor: true,
        });
        if (!ready?.ok) return false;
        const loaded = await _flowV2DownloadConfig(input);
        if (!loaded?.ok) return false;
        const config = loaded.config;
        const poll = await _flowDownloadBridgeRequest(
          "flow_v2_poll_operations",
          {
            protocol: config.protocol,
            models: config.models,
            schema: config.schema,
            stateMapping: config.state_mapping,
            runtime: config.runtime,
            projectId: target.projectId,
            flowTabId: target.tabId,
            operationIds: [operation.operationId],
            acceptedOperationIds: [operation.operationId],
            protocolRevision: loaded.protocolRevision,
            protocolFingerprint: loaded.protocolFingerprint,
          },
        );
        const output = poll?.outputs?.[0];
        if (
          poll?.ok !== true ||
          poll.outputs?.length !== 1 ||
          output.operationId !== operation.operationId ||
          output.projectId !== target.projectId ||
          output.compact === true ||
          output.unknownState === true
        )
          return false;
        if (!["completed", "failed"].includes(output.state)) terminal = false;
      }
      if (!terminal) return false;
      const snapshot = JSON.stringify(job);
      const write = _flowUuidStopSafetyTail
        .catch(() => {})
        .then(async () => {
          const current = (await chrome.storage.local.get(key))[key];
          if (JSON.stringify(current?.jobs?.[jobId]) !== snapshot) return;
          current.jobs[jobId] = { ...job, terminal: true };
          await chrome.storage.local.set({ [key]: current });
        });
      _flowUuidStopSafetyTail = write;
      await write;
    }
    if (
      Object.values(
        (await chrome.storage.local.get(key))[key]?.jobs || {},
      ).some((job) => job.terminal !== true)
    )
      return false;
  }
  return true;
}
async function _resolveFlowUuidSenderDocument(sender) {
  const base = chrome.runtime.getURL("");
  if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(base))
    return null;
  if (typeof sender.documentId === "string" && sender.documentId)
    return sender.documentId;
  if (
    sender.origin + "/" !== base ||
    sender.tab ||
    (sender.frameId != null && sender.frameId !== 0) ||
    !chrome.runtime.getContexts
  )
    return null;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["SIDE_PANEL"],
    documentUrls: [sender.url],
  });
  const matches = contexts.filter(
    (context) =>
      context.contextType === "SIDE_PANEL" &&
      context.documentId &&
      context.frameId === 0 &&
      context.documentUrl === sender.url &&
      context.documentOrigin === sender.origin,
  );
  return matches.length === 1 ? matches[0].documentId : null;
}
async function _probeFlowUuidContexts(request, ownerDocumentId) {
  if (!chrome.runtime.getContexts)
    return { safe: false, reason: "context_inventory_unavailable" };
  const list = await chrome.runtime.getContexts({});
  const documents = list.filter(
    (context) =>
      context.documentId &&
      context.documentUrl?.startsWith(chrome.runtime.getURL("")),
  );
  if (!documents.length)
    return { safe: false, reason: "context_inventory_empty" };
  if (!documents.some((context) => context.documentId === ownerDocumentId))
    return { safe: false, reason: "owner_context_missing" };
  const ids = new Set(documents.map((context) => context.documentId));
  const config = await chrome.storage.local.get("af_system_settings");
  const timeout = Number(config?.af_system_settings?.api_timeout_ms);
  if (!(timeout > 0))
    return { safe: false, reason: "probe_timeout_config_missing" };
  const probeId = crypto.randomUUID();
  const snapshot = await new Promise((resolve) => {
    const done = (result) => {
      clearTimeout(timer);
      _flowUuidContextProbes.delete(probeId);
      resolve(result);
    };
    const timer = setTimeout(
      () => done({ safe: false, reason: "context_unresponsive" }),
      Math.min(2e3, timeout),
    );
    _flowUuidContextProbes.set(probeId, { pending: ids, done });
    chrome.runtime
      .sendMessage({
        action: "flowUuidContextProbe",
        probeId,
        request: {
          generationProcessId: request.generationProcessId,
          settledApiJobs: request.settledApiJobs || [],
        },
      })
      .catch(() => {});
  });
  if (snapshot.safe !== true) return snapshot;
  const after = await chrome.runtime.getContexts({});
  const current = after
    .filter(
      (context) =>
        context.documentId &&
        context.documentUrl?.startsWith(chrome.runtime.getURL("")),
    )
    .map((context) => context.documentId);
  if (
    current.length !== documents.length ||
    current.some(
      (id) => !documents.some((context) => context.documentId === id),
    )
  )
    return { safe: false, reason: "context_inventory_changed" };
  return { safe: true };
}
async function _verifyFlowUuidControlledSafety(request, ownerDocumentId) {
  const record = (await _flowUuidRefreshCoordinator._load()).get(
    _flowUuidRefreshCoordinator._scope(request),
  );
  if (
    !record ||
    record.ownerDocumentId !== ownerDocumentId ||
    record.controlledTicket !== request.ticket
  )
    return { safe: false, reason: "controlled_owner_changed" };
  if (
    _flowApiUpscaleDownloadInflight.size ||
    _flowApiUpscaleDownloadAccepted.size
  )
    return { safe: false, reason: "upscale_unsettled" };
  const target = request.expectedFlowTarget;
  const safetyKeys = [
    "flow_uuid_gateway_unsettled_api:" + target.projectId,
    "flow_uuid_gateway_unsettled_api:unknown",
  ];
  const stateKeys = [
    "flow_web_recovery_v1",
    "toby_flow_api_checkpoints_v2_schema1",
    "af_settings",
    "af_system_settings",
    ...safetyKeys,
  ];
  const stored = await chrome.storage.local.get(stateKeys);
  if (!(await _reconcileFlowUuidApiStops(stored, safetyKeys, target)))
    return { safe: false, reason: "stopped_api_unverified" };
  const settled = await chrome.storage.local.get(safetyKeys);
  const settledApiJobs = safetyKeys.flatMap((key) =>
    Object.entries(settled[key]?.jobs || {})
      .filter(([, job]) => job.terminal === true)
      .map(([id]) => id),
  );
  if (
    Object.values(stored.toby_flow_api_checkpoints_v2_schema1 || {}).some(
      (record2) => record2.projectId === target.projectId,
    )
  )
    return { safe: false, reason: "accepted_api_checkpoint" };
  if (
    (stored.flow_web_recovery_v1 || []).some(
      (record2) =>
        (record2.snapshot?._flowTabId === target.tabId ||
          record2.projectId === target.projectId) &&
        record2.outputs?.some((output) =>
          ["dispatched", "retry_queued", "captcha_held"].includes(output.state),
        ),
    )
  )
    return { safe: false, reason: "accepted_web_checkpoint" };
  const activity = await chrome.scripting
    .executeScript({
      target: { tabId: target.tabId },
      world: "MAIN",
      func: () => {
        const state = window.__tobyBridgeIdentityActivity;
        return state ? { version: state.version, active: state.active } : null;
      },
    })
    .catch(() => null);
  const bridgeActivity = activity?.[0]?.result;
  if (bridgeActivity?.active > 0)
    return { safe: false, reason: "page_api_mutation_active" };
  if (
    [true, 1, "true"].includes(stored.af_settings?.apiModeEnabled) &&
    bridgeActivity?.version !== 1
  )
    return { safe: false, reason: "page_api_activity_unverified" };
  const fingerprint = (data) =>
    JSON.stringify({
      mode:
        data.af_settings?.defaultGenMode || data.af_settings?.gen_mode || null,
      enabled: data.af_settings?.apiModeEnabled ?? null,
      driver: data.af_system_settings?.flow_api_driver ?? null,
      checkpoints: Object.entries(
        data.toby_flow_api_checkpoints_v2_schema1 || {},
      ).filter(([, entry]) => entry.projectId === target.projectId),
      web: (data.flow_web_recovery_v1 || []).filter(
        (entry) =>
          (entry.snapshot?._flowTabId === target.tabId ||
            entry.projectId === target.projectId) &&
          entry.outputs?.some((output) =>
            ["dispatched", "retry_queued", "captcha_held"].includes(
              output.state,
            ),
          ),
      ),
      stops: safetyKeys.map((key) => data[key] || null),
    });
  const before = fingerprint({ ...stored, ...settled });
  const contexts = await _probeFlowUuidContexts(
    { ...request, settledApiJobs },
    ownerDocumentId,
  );
  if (contexts.safe !== true) return contexts;
  const current = await chrome.storage.local.get(stateKeys);
  if (fingerprint(current) !== before)
    return { safe: false, reason: "provider_state_changed" };
  return { safe: true };
}
async function _requestFlowUuidRefresh(request) {
  const expected = request?.expectedFlowTarget;
  const tab = Number.isInteger(expected?.tabId)
    ? await chrome.tabs.get(expected.tabId).catch(() => null)
    : null;
  const target = tab && describeFlowTab(tab);
  if (
    !target ||
    ["projectId", "origin", "driverKey"].some(
      (key) => target[key] !== expected[key],
    )
  ) {
    return { state: "deferred", reason: "target_changed" };
  }
  return _flowUuidRefreshCoordinator.observeRefresh(request);
}
self._flowUuidGatewayRefreshPrimitive = _requestFlowUuidRefresh;
async function resolveNativeWorkflowDocument(sender) {
  if (sender?.id !== chrome.runtime.id) return null;
  if (typeof sender.documentId === "string" && sender.documentId)
    return sender.documentId;
  const page = String(sender.url || "").split(/[?#]/)[0];
  const allowed = [
    "sidebar.html",
    "workflow-editor.html",
    "run-window.html",
  ].map((path) => chrome.runtime.getURL(path));
  if (
    !allowed.includes(page) ||
    typeof chrome.runtime.getContexts !== "function"
  )
    return null;
  const contexts = await chrome.runtime.getContexts({});
  const candidates = contexts.filter(
    (context) =>
      context.documentId &&
      String(context.documentUrl || "").split(/[?#]/)[0] === page &&
      (Number.isInteger(sender.tab?.id)
        ? context.tabId === sender.tab.id
        : context.contextType === "SIDE_PANEL"),
  );
  return candidates.length === 1 ? candidates[0].documentId : null;
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.action === "workflowRunHostAutoClose") {
    const reply = (value) => {
      try {
        sendResponse(value);
      } catch (_) {}
    };
    closeSettledRunHost(message, sender).then(reply, () =>
      reply({ ok: false, reason: "CLOSE_CHECK_FAILED" }),
    );
    return true;
  }
  if (message?.action === "workflowSpaceHealthIdentify") {
    const allowed = [
      "sidebar.html",
      "workflow-editor.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    if (
      sender.id !== chrome.runtime.id ||
      !allowed.includes(String(sender.url || "").split(/[?#]/)[0])
    )
      return;
    resolveNativeWorkflowDocument(sender).then(
      (documentId) => sendResponse({ documentId }),
      () => sendResponse({ documentId: null }),
    );
    return true;
  }
  if (message?.action === "workflowSpaceResetProgress") {
    handleSpaceResetProgress(message, sender).then(sendResponse, () =>
      sendResponse({ ok: false }),
    );
    return true;
  }
  if (message?.action === "workflowSpaceHealthSignal") {
    const allowed = [
      "sidebar.html",
      "workflow-editor.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    if (
      sender.id !== chrome.runtime.id ||
      !allowed.includes(String(sender.url || "").split(/[?#]/)[0])
    )
      return;
    (async () => {
      if (!(await resolveNativeWorkflowDocument(sender))) return { ok: false };
      const auth = (await chrome.storage.local.get("af_auth")).af_auth;
      if (
        !auth?.token ||
        String(auth.user?.id || "") !== String(message.userId || "")
      )
        return { ok: false };
      notifySpaceHealthChanged(message.settingsChanged === true);
      return { ok: true };
    })().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (message?.action === "flowUuidApiStop") {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    )
      return;
    _persistFlowUuidApiStop(message).then(sendResponse, () =>
      sendResponse({ ok: false }),
    );
    return true;
  }
  if (message?.action === "flowUuidControlledBoundary") {
    if (
      sender.id !== chrome.runtime.id ||
      sender.tab?.id !== message.request?.expectedFlowTarget?.tabId
    )
      return;
    (async () => {
      const expected = message.request.expectedFlowTarget;
      const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
      const live = tab && describeFlowTab(tab);
      const source = describeFlowTab({ id: sender.tab.id, url: sender.url });
      if (
        sender.frameId !== 0 ||
        !live ||
        !source ||
        ["projectId", "origin", "driverKey", "routePrefix"].some(
          (key) =>
            (expected[key] || null) !== (live[key] || null) ||
            (expected[key] || null) !== (source[key] || null),
        )
      )
        return { safe: false, reason: "target_changed" };
      const record = (await _flowUuidRefreshCoordinator._load()).get(
        _flowUuidRefreshCoordinator._scope(message.request),
      );
      return _verifyFlowUuidControlledSafety(
        message.request,
        record?.ownerDocumentId,
      );
    })().then(sendResponse, () =>
      sendResponse({ safe: false, reason: "boundary_unverified" }),
    );
    return true;
  }
  if (message?.action === "flowUuidContextProbeReply") {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    )
      return;
    (async () => {
      const documentId = await _resolveFlowUuidSenderDocument(sender);
      const probe = _flowUuidContextProbes.get(message.probeId);
      if (!documentId || !probe || !probe.pending.has(documentId))
        return { ok: false };
      if (message.snapshot?.safe !== true)
        probe.done({
          safe: false,
          reason: message.snapshot?.reason || "context_busy",
        });
      else {
        probe.pending.delete(documentId);
        if (!probe.pending.size) probe.done({ safe: true });
      }
      return { ok: true };
    })().then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (
    [
      "flowUuidControlledBegin",
      "flowUuidControlledFinish",
      "flowUuidControlledStatus",
      "flowUuidControlledSafety",
    ].includes(message?.action)
  ) {
    if (
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL(""))
    ) {
      sendResponse({ state: "deferred", reason: "owner_unverified" });
      return false;
    }
    (async () => {
      const ownerDocumentId = await _resolveFlowUuidSenderDocument(sender);
      if (!ownerDocumentId)
        return { state: "deferred", reason: "owner_unverified" };
      const expected = message.request?.expectedFlowTarget;
      const tab = Number.isInteger(expected?.tabId)
        ? await chrome.tabs.get(expected.tabId).catch(() => null)
        : null;
      const live = tab && describeFlowTab(tab);
      if (
        message.action !== "flowUuidControlledFinish" &&
        (!live ||
          ["projectId", "origin", "driverKey", "routePrefix"].some(
            (key) => (expected?.[key] || null) !== (live[key] || null),
          ))
      )
        return { state: "deferred", reason: "target_changed" };
      if (message.action === "flowUuidControlledBegin")
        return {
          ...(await _flowUuidRefreshCoordinator.beginControlled(
            message.request,
            ownerDocumentId,
          )),
          ownerSource: sender.documentId
            ? "sender_document"
            : "side_panel_context",
        };
      if (message.action === "flowUuidControlledFinish")
        return _flowUuidRefreshCoordinator.finishControlled(
          message.request,
          ownerDocumentId,
        );
      if (message.action === "flowUuidControlledSafety")
        return _verifyFlowUuidControlledSafety(
          message.request,
          ownerDocumentId,
        );
      return _flowUuidRefreshCoordinator.controlledStatus(message.request);
    })().then(sendResponse, (error) =>
      sendResponse({
        state: "deferred",
        reason: error?.message || "refresh_unavailable",
      }),
    );
    return true;
  }
  if (
    message?.action !== "flowUuidGatewayRefresh" ||
    sender.id !== chrome.runtime.id
  )
    return;
  _requestFlowUuidRefresh(message.request).then(sendResponse, (error) =>
    sendResponse({
      state: "deferred",
      reason: error?.message || "refresh_unavailable",
    }),
  );
  return true;
});
let settingsWindowId = null;
let workflowWindowId = null;
const _legacyWorkflowRevealAt = new Map();
let _grokFocusReturnWindowId = null;
let editingWorkflowId = null;
let templateWindowId = null;
let anglesWindowId = null;
let effectsWindowId = null;
const _museTrackerSnapshotsByTab = new Map();
const _chatgptTrackerSnapshotsByTab = new Map();
const _grokTrackerSnapshotsByTab = new Map();
const FLOW_CONTENT_SCRIPT_FILES = Object.freeze([
  "src/core/ConfigSnapshotAccess.js",
  "src/core/FlowObserverConfigRelay.js",
  "src/core/flow/FlowPageDriver.js",
  "src/core/flow/FlowDriverRegistry.js",
  "src/core/flow/drivers/v2/FlowV2Editor.js",
  "src/core/flow/drivers/v2/FlowV2GenerationSettings.js",
  "src/core/flow/drivers/v2/FlowV2PageSettings.js",
  "src/core/flow/drivers/v2/FlowV2TileResolver.js",
  "src/core/flow/drivers/v2/FlowV2ComponentPicker.js",
  "src/core/flow/drivers/v2/FlowV2MediaMenu.js",
  "src/core/flow/drivers/FlowV2Driver.js",
  "src/core/FlowUuidGateway.js",
  "content.js",
  "src/core/TrackerRegenProjection.js",
  "floating-tracker-flow.js",
  "media-intercept-bridge.js",
]);
const _extensionPopupWindows = new Set();
const API_BASE_DEFAULT = "https://local.566flow.invalid/api/v1";
let _apiBaseUrl = API_BASE_DEFAULT;
chrome.storage.local.get(["apiBaseUrl"], (data) => {
  if (data?.apiBaseUrl) _apiBaseUrl = data.apiBaseUrl;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.apiBaseUrl?.newValue) {
    _apiBaseUrl = changes.apiBaseUrl.newValue;
  }
});
function getApiBaseUrl() {
  return _apiBaseUrl;
}
function _isExtensionAuthRejection(body, httpStatus) {
  return (
    httpStatus === 403 &&
    ["REQUEST_REJECTED", "EXTENSION_NOT_AUTHORIZED"].includes(body?.error?.code)
  );
}
async function _handleExtensionAuthRejection() {
  await ProtectedConfigClient.invalidate("EXTENSION_NOT_AUTHORIZED");
  try {
    await new Promise((resolve) => {
      chrome.storage.local.set(
        {
          tobyflow_extension_not_authorized: {
            at: Date.now(),
            reason: "whitelist_miss",
            ext_id: chrome.runtime.id,
          },
        },
        resolve,
      );
    });
    chrome.runtime
      .sendMessage({ type: "EXTENSION_NOT_AUTHORIZED" })
      .catch(() => {});
    console.error(
      "[Auth] \u{1F6E1}\uFE0F Extension not authorized \u2014 sidebar notice triggered",
    );
  } catch (e) {
    console.error("[Auth] Failed to set ext-not-authorized flag", e);
  }
}
const DEVICE_BANNED_FLAG = "tobyflow_device_banned";
let _deviceBanned = false;
try {
  chrome.storage.local.get(DEVICE_BANNED_FLAG, (res) => {
    _deviceBanned = !!res?.[DEVICE_BANNED_FLAG];
  });
} catch (_) {}
async function _handleDeviceBanned(reason) {
  await ProtectedConfigClient.invalidate("DEVICE_BANNED");
  const wasBanned = _deviceBanned;
  _deviceBanned = true;
  try {
    await new Promise((r) =>
      chrome.storage.local.set(
        {
          [DEVICE_BANNED_FLAG]: {
            at: Date.now(),
            reason: reason || "banned",
            ext_id: chrome.runtime.id,
          },
        },
        r,
      ),
    );
    if (!wasBanned) {
      chrome.runtime.sendMessage({ type: "DEVICE_BANNED" }).catch(() => {});
      console.error(
        "[Enrollment] \u{1F6AB} Device banned \u2014 block ALL requests + overlay",
      );
    }
  } catch (_) {}
}
async function _clearDeviceBanned() {
  if (!_deviceBanned) return;
  _deviceBanned = false;
  try {
    await new Promise((r) =>
      chrome.storage.local.remove(DEVICE_BANNED_FLAG, r),
    );
    chrome.runtime.sendMessage({ type: "DEVICE_UNBANNED" }).catch(() => {});
    console.log("[Enrollment] \u2705 Device un-banned \u2014 access restored");
  } catch (_) {}
}
async function _deviceBanRecoveryProbe() {
  if (!_deviceBanned) return;
  try {
    await _ensureEnrollment(true);
  } catch (_) {}
}
async function _selfHealProbe() {
  try {
    const stored = await new Promise((resolve) =>
      chrome.storage.local.get("tobyflow_extension_not_authorized", resolve),
    );
    if (!stored?.tobyflow_extension_not_authorized) return;
    const apiBase = getApiBaseUrl();
    const r = await _signedFetch(`${apiBase}/entitlements`, {
      method: "GET",
      headers: {
        "X-Extension-Id": chrome.runtime.id,
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (r.ok) {
      await new Promise((resolve) =>
        chrome.storage.local.remove(
          "tobyflow_extension_not_authorized",
          resolve,
        ),
      );
      chrome.runtime
        .sendMessage({ type: "EXTENSION_AUTHORIZED" })
        .catch(() => {});
      console.log("[Auth] \u2705 Extension re-authorized \u2014 flag cleared");
    } else if (r.status === 403) {
      try {
        const body = await r.clone().json();
        if (_isExtensionAuthRejection(body, r.status)) {
          console.log(
            "[Auth] \u{1F6E1}\uFE0F Probe still rejected \u2014 flag retained",
          );
        }
      } catch (_) {}
    }
  } catch (_) {}
}
_selfHealProbe();
setInterval(_selfHealProbe, 60 * 1e3);
try {
  chrome.tabs.onActivated.addListener(() => {
    _selfHealProbe();
    _deviceBanRecoveryProbe();
  });
  chrome.windows.onFocusChanged?.addListener?.((id) => {
    if (id !== chrome.windows.WINDOW_ID_NONE) {
      _selfHealProbe();
      _deviceBanRecoveryProbe();
    }
    ProviderWorkerRegistry.logFocusChange(id).catch(() => {});
  });
} catch (_) {}
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (
    msg?.type === "EXTENSION_AUTH_RETRY" ||
    msg?.type === "DEVICE_BAN_RETRY"
  ) {
    Promise.all([_selfHealProbe(), _deviceBanRecoveryProbe()])
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
const ENROLLMENT_KEY = "toby_client_enrollment";
const DEVICE_FP_KEY = "toby_device_fp";
const TIME_OFFSET_KEY = "toby_server_time_offset";
const ENROLLMENT_REFRESH_BEFORE_EXPIRY_MS = 24 * 3600 * 1e3;
const SIGNATURE_RETRY_CODES = new Set([
  "REVOKED_CLIENT",
  "EXPIRED_CLIENT",
  "INVALID_CLIENT",
  "INVALID_SIGNATURE",
]);
let _cachedEnrollment = null;
let _enrollmentPromise = null;
let _enrollmentLastFailure = null;
let _enrollmentRetryUntil = 0;
const ENROLLMENT_RETRY_KEY = "_tobyEnrollmentRetryUntil";
let _serverTimeOffsetMs = 0;
chrome.storage.local.get([ENROLLMENT_KEY, TIME_OFFSET_KEY], (res) => {
  if (res?.[ENROLLMENT_KEY]) _cachedEnrollment = res[ENROLLMENT_KEY];
  const off = res?.[TIME_OFFSET_KEY];
  if (typeof off === "number" && isFinite(off)) _serverTimeOffsetMs = off;
});
function _syncServerTimeFromResponse(response) {
  try {
    const dateHeader = response?.headers?.get?.("Date");
    if (!dateHeader) return;
    const serverMs = Date.parse(dateHeader);
    if (isNaN(serverMs)) return;
    const newOffset = serverMs - Date.now();
    if (Math.abs(newOffset - _serverTimeOffsetMs) > 5e3) {
      _serverTimeOffsetMs = newOffset;
      chrome.storage.local.set({ [TIME_OFFSET_KEY]: newOffset });
    }
  } catch (_) {}
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ENROLLMENT_KEY]) {
    _cachedEnrollment = changes[ENROLLMENT_KEY].newValue || null;
  }
});
async function _getOrCreateDeviceFingerprint() {
  const stored = await new Promise((r) =>
    chrome.storage.local.get([DEVICE_FP_KEY], r),
  );
  if (stored[DEVICE_FP_KEY]) return stored[DEVICE_FP_KEY];
  const fp =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
  await new Promise((r) =>
    chrome.storage.local.set({ [DEVICE_FP_KEY]: fp }, r),
  );
  return fp;
}
function _getDeviceDisplayLabel() {
  const ua = String(navigator.userAgent || "");
  const browser = /Edg\//.test(ua)
    ? "Microsoft Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Google Chrome"
        : "Browser";
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /Mac OS X/.test(ua)
      ? "macOS"
      : /Android/.test(ua)
        ? "Android"
        : /Linux/.test(ua)
          ? "Linux"
          : "Unknown OS";
  return `${browser} - ${os}`;
}
async function _getEnrollment() {
  return { client_id: "local", secret: "local", expires_at: null, device_fingerprint: "local" };
}
function _isEnrollmentValid(e) {
  if (!e || !e.client_id || !e.secret) return false;
  if (!e.expires_at) return true;
  const expiresAt = new Date(e.expires_at).getTime();
  return (
    !isNaN(expiresAt) &&
    expiresAt > Date.now() + ENROLLMENT_REFRESH_BEFORE_EXPIRY_MS
  );
}
function _isEnrollmentUnexpired(e) {
  if (!e?.client_id || !e?.secret) return false;
  if (!e.expires_at) return true;
  const expiresAt = new Date(e.expires_at).getTime();
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}
async function _doEnrollment() {
  const controller = new AbortController();
  let timedOut = false;
  let requestStarted = false;
  let responseReceived = false;
  let attemptClient = null;
  let attemptAudience = null;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15e3);
  _enrollmentLastFailure = null;
  try {
    attemptClient = (await _getEnrollment())?.client_id || null;
    const fp = await _getOrCreateDeviceFingerprint();
    const apiBase = getApiBaseUrl();
    attemptAudience = apiBase;
    const extVersion = chrome.runtime.getManifest()?.version || "unknown";
    const url = `${apiBase}/enroll`;
    const payload = { device_fingerprint: fp, ext_version: extVersion };
    const proof = await ProtectedConfigClient.prepareRenewal(url, payload);
    const body =
      proof?.body ||
      JSON.stringify({ ...payload, request_nonce: DeviceKeyStore.nonce() });
    const signature =
      proof?.headers ||
      (await _buildSignatureHeaders("POST", new URL(url).pathname, body));
    requestStarted = true;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Extension-Id": chrome.runtime.id,
        "X-Ext-Version": extVersion,
        ...signature,
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    responseReceived = true;
    _syncServerTimeFromResponse(response);
    if (!response.ok) {
      let failureBody;
      try {
        failureBody = await response.clone().json();
      } catch (_) {
        failureBody = {};
      }
      const code =
        failureBody?.error?.code ||
        (response.status === 429
          ? "RATE_LIMITED"
          : response.status >= 500
            ? "HTTP_SERVICE_UNAVAILABLE"
            : "ENROLLMENT_REQUIRED");
      const retryHeader = response.headers.get("Retry-After");
      const retrySeconds =
        retryHeader && Number.isFinite(Number(retryHeader))
          ? Number(retryHeader)
          : retryHeader && Number.isFinite(Date.parse(retryHeader))
            ? Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1e3)
            : Number(failureBody?.data?.retry_after ?? 60);
      const retryAfterMs =
        response.status === 429
          ? Math.max(0, Number.isFinite(retrySeconds) ? retrySeconds : 60) * 1e3
          : 0;
      const permanent =
        /^(KEY_|LOCAL_|DEVICE_KEY_|CLIENT_|ACCOUNT_|EXTENSION_DEVICE_|INVALID_DEVICE_)/.test(
          code,
        ) ||
        [
          "REQUEST_REJECTED",
          "EXTENSION_NOT_AUTHORIZED",
          "LEGACY_CONTRACT_STATE_UNAVAILABLE",
        ].includes(code);
      _enrollmentLastFailure = {
        code,
        httpStatus: response.status,
        client_id: attemptClient,
        audience: attemptAudience,
        retryable:
          !permanent && (response.status === 429 || response.status >= 500),
        retryAfterMs,
      };
      if (response.status === 429) {
        _enrollmentRetryUntil = Date.now() + retryAfterMs;
        try {
          await chrome.storage.session?.set?.({
            [ENROLLMENT_RETRY_KEY]: _enrollmentRetryUntil,
          });
        } catch (_) {}
      }
      if (response.status === 403) {
        try {
          const body2 = failureBody;
          if (body2?.error?.code === "DEVICE_BANNED") {
            console.error(
              "[Enrollment] \u{1F6AB} Device banned, abort enrollment",
            );
            await _handleDeviceBanned(body2?.error?.message || "banned");
            return null;
          }
          if (_isExtensionAuthRejection(body2, 403)) {
            _handleExtensionAuthRejection();
            return null;
          }
        } catch (_) {}
      }
      console.warn("[Enrollment] Failed HTTP", response.status);
      return null;
    }
    const json = await response.json();
    if (!json.success || !json.data?.client_id || !json.data?.secret) {
      console.warn("[Enrollment] Invalid response shape", json);
      return null;
    }
    const enrollment = {
      client_id: json.data.client_id,
      secret: json.data.secret,
      expires_at: json.data.expires_at,
      device_fingerprint: fp,
    };
    if (((await _getEnrollment())?.client_id || null) !== attemptClient) {
      throw Object.assign(new Error("CONFIG_SCOPE_CHANGED"), {
        code: "CONFIG_SCOPE_CHANGED",
      });
    }
    await new Promise((r) =>
      chrome.storage.local.set({ [ENROLLMENT_KEY]: enrollment }, r),
    );
    _cachedEnrollment = enrollment;
    _enrollmentRetryUntil = 0;
    try {
      await chrome.storage.session?.remove?.(ENROLLMENT_RETRY_KEY);
    } catch (_) {}
    console.log(
      "[Enrollment] \u2705 Enrolled successfully:",
      enrollment.client_id,
    );
    await _clearDeviceBanned();
    return enrollment;
  } catch (e) {
    const retryable =
      !e.code &&
      requestStarted &&
      (timedOut || !responseReceived || e.name === "TypeError");
    _enrollmentLastFailure = {
      code:
        e.code ||
        (retryable
          ? timedOut
            ? "REQUEST_TIMEOUT"
            : "NETWORK_ERROR"
          : "ENROLLMENT_REQUIRED"),
      httpStatus: retryable ? 503 : 403,
      retryable,
      client_id: attemptClient,
      audience: attemptAudience,
    };
    console.warn("[Enrollment] Network error:", e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function _ensureEnrollment() {
  return { client_id: "local", secret: "local", expires_at: null, device_fingerprint: "local" };
}
async function _sha256Hex(text) {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text || ""),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function _buildSignatureHeaders() {
  return {};
}
async function _clearEnrollment() {
  _cachedEnrollment = null;
  await new Promise((r) => chrome.storage.local.remove([ENROLLMENT_KEY], r));
}
async function _signedFetch(url, options = {}) {
  const parsed = new URL(url);
  const configOperations = {
    "/api/v1/providers/dom-selectors": "dom",
    "/api/v1/providers/api-configs": "api",
    "/api/v1/providers/private-configs": "private",
    "/api/v1/provider-models": "models",
    "/api/v1/system-config/execution": "execution",
    "/api/v1/system-config/ai-tools": "aiTools",
  };
  if (Object.hasOwn(configOperations, parsed.pathname)) {
    const result = await ProtectedConfigClient.envelope(
      configOperations[parsed.pathname],
      {
        ...(parsed.searchParams.has("provider")
          ? { provider: parsed.searchParams.get("provider") }
          : {}),
        ...(parsed.searchParams.has("keys")
          ? { keys: parsed.searchParams.get("keys").split(",") }
          : {}),
      },
    );
    return new Response(JSON.stringify(result), {
      status: result.httpStatus || (result.success ? 200 : 503),
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    });
  }
  const headers = { ...(options.headers || {}) };
  const method = (options.method || "GET").toUpperCase();
  const isEnroll = typeof url === "string" && /\/enroll(\?|$)/.test(url);
  const isPrivateConfig =
    typeof url === "string" && /\/providers\/private-configs(\?|$)/.test(url);
  if (_deviceBanned && !isEnroll) {
    return new Response(
      JSON.stringify({
        success: false,
        error: { code: "DEVICE_BANNED", message: "Device banned" },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  const bodyIsString = typeof options.body === "string";
  if (isPrivateConfig) {
    const enrollment = await _ensureEnrollment();
    if (!enrollment?.client_id || !enrollment?.secret) {
      return new Response(
        JSON.stringify({
          success: false,
          error: { code: "MISSING_SIGNATURE", message: "Enrollment required" },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    }
    headers["X-Ext-Version"] = chrome.runtime.getManifest()?.version;
  }
  if (
    !isEnroll &&
    (!options.body || bodyIsString) &&
    !(await _ensureEnrollment())
  ) {
    const failure = _enrollmentLastFailure;
    const retryAfter = Math.max(
      0,
      Math.ceil((_enrollmentRetryUntil - Date.now()) / 1e3),
    );
    return new Response(
      JSON.stringify({
        success: false,
        error: {
          code:
            failure?.code ||
            (retryAfter ? "RATE_LIMITED" : "ENROLLMENT_REQUIRED"),
          message: "Enrollment unavailable",
        },
        ...(retryAfter ? { data: { retry_after: retryAfter } } : {}),
      }),
      {
        status: retryAfter ? 429 : failure?.httpStatus === 403 ? 403 : 503,
        headers: {
          "Content-Type": "application/json",
          ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
        },
      },
    );
  }
  if (!isEnroll && (!options.body || bodyIsString)) {
    try {
      const pathForSig = new URL(url).pathname;
      const bodyStr = bodyIsString ? options.body : "";
      const sigHeaders = await _buildSignatureHeaders(
        method,
        pathForSig,
        bodyStr,
      );
      if (!sigHeaders["X-Client-Id"] || !sigHeaders["X-Signature"])
        throw new Error("SIGNATURE_UNAVAILABLE");
      Object.assign(headers, sigHeaders);
    } catch (_) {
      return new Response(
        JSON.stringify({
          success: false,
          error: {
            code: "SIGNATURE_UNAVAILABLE",
            message: "Enrollment signature unavailable",
          },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );
    }
  }
  const resp = await fetch(url, { ...options, headers });
  _syncServerTimeFromResponse(resp);
  return resp;
}
ProtectedConfigClient.configure({
  automaticIdentityRecovery: true,
  apiBase: getApiBaseUrl,
  getEnrollment: _getEnrollment,
  ensureEnrollment: async (intent = "read") => {
    await _protectedBootPromise;
    const owner = await _protectedConfigOwner();
    const admission = ConfigAccessRecovery.admission(owner, {
      allowBlocked: intent === "claim",
    });
    if (!admission.allowed)
      throw Object.assign(new Error(admission.code), admission, { owner });
    return _ensureEnrollment();
  },
  enrollmentFailure: () => _enrollmentLastFailure,
  hmac: _buildSignatureHeaders,
  sha256: _sha256Hex,
  syncTime: _syncServerTimeFromResponse,
  deviceLabel: _getDeviceDisplayLabel,
  admit: (endpoint, owner, options) => {
    if (_deviceBanned)
      return { allowed: false, code: "DEVICE_BANNED", httpStatus: 403 };
    if (globalThis._protectedConfigRateLimitedUntil > Date.now())
      return {
        allowed: false,
        code: "RATE_LIMITED",
        httpStatus: 429,
        retryAfterMs: globalThis._protectedConfigRateLimitedUntil - Date.now(),
      };
    const admission = _apiNetworkBeforeRequest(endpoint);
    return admission.allowed
      ? ConfigAccessRecovery.admission(owner, options)
      : { ...admission, code: "NETWORK_CIRCUIT_OPEN", httpStatus: 503 };
  },
  reachable: _apiNetworkRecordReachable,
  networkFailed: _apiNetworkRecordFailure,
  rejected: (details) =>
    console.warn(
      "[ConfigAccess] Protected request rejected",
      JSON.stringify(details),
    ),
  rateLimited: (seconds) => {
    globalThis._protectedConfigRateLimitedUntil = Date.now() + seconds * 1e3;
  },
  bootReady: () => _protectedBootPromise,
  recoveryFailed: (failure, needsClaim) =>
    ConfigAccessRecovery.failed(failure, needsClaim),
  recoveryClaimed: (owner) => ConfigAccessRecovery.claimed(owner),
  recoveryAuthorized: (owner) => ConfigAccessRecovery.authorized(owner),
  replacementCommitted: async () => {
    _cachedEnrollment =
      (await chrome.storage.local.get(ENROLLMENT_KEY))[ENROLLMENT_KEY] || null;
  },
  commitUrls: async (data, scope) => {
    _serverUrlsCache = Object.fromEntries(
      Object.entries(data)
        .filter(([, blob]) => blob?.configs?.urls)
        .map(([slug, blob]) => [slug, blob.configs.urls]),
    );
    await chrome.storage.session.set({
      _provider_urls_cache: {
        data: Object.fromEntries(
          Object.entries(_serverUrlsCache).filter(([slug]) => slug !== "flow"),
        ),
        scope,
      },
    });
  },
  commitPrivateUrls: (data, complete) => {
    const urls = Object.fromEntries(
      ["chatgpt", "grok", "gemini", "muse"]
        .filter((slug) => data?.[slug]?.configs?.urls)
        .map((slug) => [slug, data[slug].configs.urls]),
    );
    _privateProviderUrlsCache = complete
      ? urls
      : { ..._privateProviderUrlsCache, ...urls };
  },
  invalidateRuntime: () => _invalidateProtectedRuntime(),
  invalidateResource: (operation) => {
    if (operation !== "private") return;
    _privateProviderUrlsCache = {};
    _flowDownloadPrivateEpoch++;
    _flowDownloadPrivateCache = null;
    _flowDownloadPrivateAt = 0;
    _flowDownloadPrivateToken = null;
    _wmInvalidate("protected config refresh");
  },
  broadcast: (message) => {
    chrome.runtime.sendMessage(message).catch(() => {});
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs)
        if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  },
});
const _identityRecoveryPromise = DeviceKeyStore.recoverReplacement().catch(
  (error) => {
    console.warn(
      "[DeviceKey] Local recovery unavailable:",
      error.code || "LOCAL_KEY_UNAVAILABLE",
    );
  },
);
_ensureEnrollment().catch(() => {});
const PROVIDER_URLS = {
  flow: {
    tabQuery: "https://flow.google.com/*",
    tabQueryPatterns: ["https://flow.google.com/*"],
    createUrl: "https://flow.google.com/",
    base: "https://flow.google.com",
  },
  chatgpt: { tabQuery: "*://chatgpt.com/*", createUrl: "https://chatgpt.com/" },
  grok: {
    tabQuery: "*://grok.com/*",
    tabQueryPatterns: ["*://grok.com/*", "https://x.com/i/grok*"],
    createUrl: "https://grok.com/",
    imagine: "https://grok.com/imagine",
  },
  gemini: {
    tabQuery: "*://gemini.google.com/*",
    createUrl: "https://gemini.google.com/app",
  },
};
let _serverUrlsCache = null;
let _privateProviderUrlsCache = {};
function getProviderUrl(provider, key) {
  if (
    provider === "flow" &&
    Object.prototype.hasOwnProperty.call(PROVIDER_URLS.flow, key)
  )
    return PROVIDER_URLS.flow[key];
  const museUrls = _privateProviderUrlsCache.muse;
  if (
    provider === "muse" &&
    key === "baseUrl" &&
    !museUrls?.baseUrl &&
    !museUrls?.base_url
  ) {
    try {
      const parsed = new URL(museUrls?.newChatUrl || museUrls?.new_chat_url);
      if (parsed.protocol === "https:") return parsed.origin;
    } catch (_) {}
  }
  const serverUrls =
    provider === "muse"
      ? _privateProviderUrlsCache.muse
      : _privateProviderUrlsCache[provider] || _serverUrlsCache?.[provider];
  if (serverUrls?.[key]) {
    const value = serverUrls[key];
    if (provider === "flow" && key === "createUrl" && !isFlowUrl(value)) {
      return PROVIDER_URLS.flow.createUrl;
    }
    return value;
  }
  const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
  if (serverUrls?.[snakeKey]) {
    const value = serverUrls[snakeKey];
    if (provider === "flow" && snakeKey === "create_url" && !isFlowUrl(value)) {
      return PROVIDER_URLS.flow.createUrl;
    }
    return value;
  }
  return PROVIDER_URLS[provider]?.[key] || null;
}
function getProviderWorkerUrl(provider, key) {
  const urls =
    provider === "muse"
      ? _privateProviderUrlsCache.muse
      : _privateProviderUrlsCache[provider] || _serverUrlsCache?.[provider];
  const snakeKey = key.replace(/([A-Z])/g, "_$1").toLowerCase();
  const value = urls?.[key] || urls?.[snakeKey] || null;
  if (value) return value;
  if (provider === "muse" && key === "baseUrl") {
    try {
      return new URL(urls?.newChatUrl || urls?.new_chat_url).origin;
    } catch (_) {
      return null;
    }
  }
  if (["chatgpt", "gemini"].includes(provider) && key === "base") {
    try {
      const create = new URL(urls?.createUrl || urls?.create_url);
      return create.protocol === "https:" ? create.origin : null;
    } catch (_) {
      return null;
    }
  }
  return null;
}
function getFlowTabQueryPatterns() {
  return ["https://flow.google.com/*"];
}
const FLOW_PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FLOW_LOCALE_RE = /^[a-z]{2,3}(?:-[a-z]{2,4})?$/i;
function parseFlowV2Path(pathname) {
  const segments = String(pathname || "")
    .split("/")
    .filter(Boolean);
  const projectAt = segments.indexOf("project");
  const prefix = projectAt >= 0 ? segments.slice(0, projectAt) : segments;
  let accountSeen = false;
  let localeSeen = false;
  for (let i = 0; i < prefix.length; i++) {
    if (
      prefix[i] === "u" &&
      !accountSeen &&
      /^\d+$/.test(prefix[i + 1] || "")
    ) {
      accountSeen = true;
      i++;
      continue;
    }
    if (!localeSeen && FLOW_LOCALE_RE.test(prefix[i])) {
      localeSeen = true;
      continue;
    }
    return null;
  }
  if (projectAt < 0) {
    return {
      projectId: null,
      isProjectEditor: false,
      isMediaViewer: false,
      routePrefix: prefix.length ? `/${prefix.join("/")}` : "",
    };
  }
  const projectId = segments[projectAt + 1];
  if (!FLOW_PROJECT_ID_RE.test(projectId || "")) return null;
  return {
    projectId,
    isProjectEditor: segments.length === projectAt + 2,
    isMediaViewer:
      segments[projectAt + 2] === "edit" && !!segments[projectAt + 3],
    routePrefix: prefix.length ? `/${prefix.join("/")}` : "",
  };
}
function isFlowUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://flow.google.com" &&
      !!parseFlowV2Path(parsed.pathname)
    );
  } catch (_) {
    return false;
  }
}
function isFlowOriginUrl(url) {
  if (typeof url !== "string") return false;
  try {
    return new URL(url).origin === "https://flow.google.com";
  } catch (_) {
    return false;
  }
}
function describeFlowTab(tab) {
  if (!tab?.id || !isFlowUrl(tab.url)) return null;
  try {
    const parsed = new URL(tab.url);
    const route = parseFlowV2Path(parsed.pathname);
    if (!route) return null;
    return {
      tabId: tab.id,
      origin: parsed.origin,
      driverKey: "flow_v2",
      projectId: route.projectId,
      routePrefix: route.routePrefix,
      isProjectEditor: route.isProjectEditor,
      isMediaViewer: route.isMediaViewer === true,
    };
  } catch (_) {
    return null;
  }
}
function sameFlowTarget(a, b) {
  return (
    !!a &&
    !!b &&
    a.origin === b.origin &&
    a.projectId === b.projectId &&
    (a.routePrefix || "") === (b.routePrefix || "")
  );
}
function scopeFlowProjectUrlForTab(value, tab) {
  try {
    const target = new URL(value);
    const current = new URL(tab?.url || "");
    if (
      target.origin !== "https://flow.google.com" ||
      current.origin !== target.origin
    )
      return value;
    const targetRoute = parseFlowV2Path(target.pathname);
    const currentRoute = parseFlowV2Path(current.pathname);
    if (!targetRoute || !currentRoute) return value;
    if (!targetRoute.routePrefix && currentRoute.routePrefix) {
      target.pathname = `${currentRoute.routePrefix}${target.pathname}`;
    }
    return target.href;
  } catch (_) {
    return value;
  }
}
function isFlowHomepageTab(tab) {
  const context = describeFlowTab(tab);
  return !!context && !context.projectId;
}
async function getFlowDuplicateGroup(tabs, requestedTarget = null) {
  const described = (tabs || [])
    .map((tab) => ({ tab, context: describeFlowTab(tab) }))
    .filter(
      (x) =>
        x.context?.projectId && x.context.origin === "https://flow.google.com",
    );
  let intended = requestedTarget;
  if (!intended) {
    try {
      intended =
        (await chrome.storage?.session?.get("targetFlowContext"))
          ?.targetFlowContext || null;
    } catch (_) {}
  }
  const intendedEntry = intended
    ? described.find(
        (x) =>
          x.context.tabId === intended.tabId &&
          sameFlowTarget(x.context, intended),
      )
    : null;
  if (intendedEntry) {
    return {
      intended: intendedEntry.context,
      entries: described.filter((x) =>
        sameFlowTarget(x.context, intendedEntry.context),
      ),
    };
  }
  const groups = new Map();
  for (const entry of described) {
    const key = `${entry.context.origin}|${entry.context.routePrefix || "<root>"}|${entry.context.projectId || "<homepage>"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const duplicate =
    [...groups.values()].find((group) => group.length > 1) || [];
  return { intended: duplicate[0]?.context || null, entries: duplicate };
}
let _flowTabsAdvisorySignature = null;
async function getLiveFlowAdvisoryTabs(snapshot) {
  const ids = [
    ...new Set((snapshot || []).map((tab) => tab?.id).filter(Number.isInteger)),
  ];
  const current = await Promise.all(
    ids.map((id) => chrome.tabs.get(id).catch(() => null)),
  );
  const live = current.filter((tab) => tab && isFlowUrl(tab.url));
  const windows =
    live.length > 1 && typeof chrome.windows?.get === "function"
      ? await Promise.all(
          [
            ...new Set(
              live.map((tab) => tab.windowId).filter(Number.isInteger),
            ),
          ].map((id) => chrome.windows.get(id).catch(() => null)),
        )
      : [];
  const diagnostic = {
    stage: "live_snapshot",
    queriedIds: ids,
    missingIds: ids.filter((id, index) => !current[index]),
    tabs: live.map((tab) => ({
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      active: tab.active === true,
      status: tab.status || null,
      discarded: tab.discarded === true,
      project: !!describeFlowTab(tab)?.projectId,
    })),
    windows: windows
      .filter(Boolean)
      .map((win) => ({
        windowId: win.id,
        type: win.type || null,
        state: win.state || null,
        focused: win.focused === true,
      })),
  };
  const signature = JSON.stringify(diagnostic);
  if (_flowTabsAdvisorySignature !== signature) {
    _flowTabsAdvisorySignature = signature;
    console.info("[FlowTabsAdvisory]", signature);
  }
  return live;
}
function selectFlowTab(tabs, targetTabId = null) {
  const supported = (tabs || []).filter((tab) => isFlowUrl(tab.url));
  if (targetTabId) {
    const pinned = supported.find((tab) => tab.id === targetTabId);
    return pinned || null;
  }
  return (
    supported.find(
      (tab) =>
        tab.active && new URL(tab.url).origin === "https://flow.google.com",
    ) ||
    supported.find(
      (tab) => new URL(tab.url).origin === "https://flow.google.com",
    ) ||
    supported.find((tab) => tab.active) ||
    supported[0] ||
    null
  );
}
async function openFlowProjectFromHomepage(tabId, projectId, timeoutMs = 15e3) {
  const deadline = Date.now() + timeoutMs;
  let clickDispatched = false;
  let lastError = null;
  do {
    const liveTab = await chrome.tabs.get(tabId).catch(() => null);
    const liveContext = describeFlowTab(liveTab);
    if (liveContext?.projectId === projectId) {
      return {
        success: true,
        clicked: clickDispatched,
        projectId,
        tab: liveTab,
      };
    }
    if (
      liveTab?.status === "complete" &&
      liveContext &&
      !liveContext.projectId &&
      !clickDispatched
    ) {
      const opened = await chrome.tabs
        .sendMessage(tabId, { action: "openFlowProject", projectId })
        .catch(() => null);
      if (opened?.success) clickDispatched = true;
      else if (opened?.error && opened.error !== "FLOW_PROJECT_CARD_NOT_FOUND")
        return opened;
      else lastError = opened?.error || lastError;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return {
    success: false,
    error: clickDispatched
      ? "FLOW_PROJECT_NAVIGATION_TIMEOUT"
      : lastError || "FLOW_PROJECT_CARD_NOT_FOUND",
  };
}
async function selectFlowStatusTab(tabs, targetTabId = null) {
  const supported = (tabs || []).filter((tab) => isFlowUrl(tab.url));
  if (targetTabId) return selectFlowTab(supported, targetTabId);
  let storedTargetTabId = null;
  try {
    storedTargetTabId =
      (await chrome.storage?.session?.get("targetFlowTabId"))
        ?.targetFlowTabId || null;
  } catch (_) {}
  if (storedTargetTabId) {
    const pinned = selectFlowTab(supported, storedTargetTabId);
    if (pinned && describeFlowTab(pinned)?.projectId) return pinned;
  }
  const mostRecent = (candidates) =>
    candidates
      .slice()
      .sort(
        (a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0),
      )[0] || null;
  const projectTabs = supported.filter(
    (tab) => !!describeFlowTab(tab)?.projectId,
  );
  const projectEditors = projectTabs.filter(
    (tab) => describeFlowTab(tab)?.isProjectEditor === true,
  );
  return (
    mostRecent(projectEditors.filter((tab) => tab.active)) ||
    mostRecent(projectEditors) ||
    mostRecent(projectTabs.filter((tab) => tab.active)) ||
    mostRecent(projectTabs) ||
    mostRecent(supported.filter((tab) => tab.active)) ||
    mostRecent(supported)
  );
}
function spaceComponentSlugify(value, prefix) {
  let slug = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) slug = "unknown";
  if (!/^[a-z]/.test(slug)) slug = `${prefix}_${slug}`;
  return slug.slice(0, 100);
}
async function syncFlowComponentsForSpace(kind) {
  const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
  let flowTab = await selectFlowStatusTab(tabs);
  if (!flowTab?.id) {
    flowTab = await openOrActivateTab(
      getFlowTabQueryPatterns(),
      getProviderUrl("flow", "createUrl"),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 2e3));
  }
  if (!flowTab?.id) return { ok: false, error: "FLOW_TAB_NOT_FOUND" };
  if (!flowTab.active) await chrome.tabs.update(flowTab.id, { active: true });
  if (flowTab.windowId)
    await chrome.windows
      .update(flowTab.windowId, { focused: true })
      .catch(() => {});
  const action = kind === "voice" ? "scrapeFlowVoices" : "scrapeFlowCharacters";
  const result = await chrome.tabs
    .sendMessage(flowTab.id, { action })
    .catch(() => null);
  const raw = kind === "voice" ? result?.voices : result?.characters;
  if (!result?.success || !Array.isArray(raw))
    return { ok: false, error: result?.error || "FLOW_COMPONENT_SYNC_FAILED" };
  if (kind === "character") {
    const seen2 = new Set();
    const characters = raw.reduce((out, item) => {
      const name = String(item?.name || "").trim();
      const slug = spaceComponentSlugify(name, "c");
      if (!name || seen2.has(slug)) return out;
      seen2.add(slug);
      out.push({
        slug,
        name,
        search_value: name,
        thumbnail_url: item?.thumbnail || item?.thumbnail_url || null,
        scraped_at: Date.now(),
      });
      return out;
    }, []);
    await chrome.storage.local.set({
      toby_provider_characters_scraped: {
        data: characters,
        scrapedAt: Date.now(),
      },
    });
    return { ok: true, characters };
  }
  const stored = await chrome.storage.local.get(["toby_provider_voices_base"]);
  const baseWrap = stored?.toby_provider_voices_base;
  const base = Array.isArray(baseWrap?.data)
    ? baseWrap.data
    : Array.isArray(baseWrap)
      ? baseWrap
      : [];
  const bySearch = new Map(
    base
      .filter((item) => item?.provider === "flow")
      .map((item) => [String(item.search_value || "").toLowerCase(), item]),
  );
  const seen = new Set();
  const voices = raw.reduce((out, item) => {
    const name = String(item?.name || "").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return out;
    seen.add(key);
    const known = bySearch.get(key);
    out.push(
      known
        ? { ...known, is_custom: false, scraped_at: Date.now() }
        : {
            slug: spaceComponentSlugify(name, "v"),
            provider: "flow",
            display_name: name,
            search_value: name,
            description: item?.description || null,
            thumbnail_url: null,
            thumbnail_full_url: null,
            sample_url: null,
            is_premium: false,
            is_custom: true,
            scraped_at: Date.now(),
          },
    );
    return out;
  }, []);
  await chrome.storage.local.set({
    toby_provider_voices_scraped: { data: voices, scrapedAt: Date.now() },
  });
  return { ok: true, voices };
}
function buildFlowProjectContext(tab, response = null) {
  const route = describeFlowTab(tab);
  const routeProjectId = route?.projectId || null;
  const responseProjectId = response?.projectId || null;
  const identityMatches =
    !!response &&
    (!response.driverKey || response.driverKey === route?.driverKey) &&
    String(responseProjectId || "").toLowerCase() ===
      String(routeProjectId || "").toLowerCase();
  const contentReady = identityMatches;
  return {
    ...(contentReady ? response : {}),
    driverKey: route?.driverKey || null,
    origin: route?.origin || null,
    projectId: routeProjectId,
    routePrefix: route?.routePrefix || "",
    isProjectEditor: route?.isProjectEditor === true,
    projectError: contentReady ? response?.projectError === true : null,
    mediaViewer: contentReady
      ? response?.mediaViewer === true
      : routeProjectId !== null && route?.isProjectEditor !== true,
    contentReady,
    contextSource: contentReady
      ? "content"
      : route
        ? "url_fallback"
        : "invalid_route",
    tabId: tab?.id || null,
    tabTitle: tab?.title || null,
  };
}
chrome.storage?.session?.get(
  [
    "_settingsWindowId",
    "_workflowWindowId",
    "_editingWorkflowId",
    "_templateWindowId",
    "_anglesWindowId",
    "_effectsWindowId",
  ],
  (result) => {
    if (result?._settingsWindowId) {
      settingsWindowId = result._settingsWindowId;
      _extensionPopupWindows.add(result._settingsWindowId);
    }
    if (result?._workflowWindowId) {
      workflowWindowId = result._workflowWindowId;
      _extensionPopupWindows.add(result._workflowWindowId);
    }
    if (result?._editingWorkflowId) {
      editingWorkflowId = result._editingWorkflowId;
    }
    if (result?._templateWindowId) {
      templateWindowId = result._templateWindowId;
      _extensionPopupWindows.add(result._templateWindowId);
    }
    if (result?._anglesWindowId) {
      anglesWindowId = result._anglesWindowId;
      _extensionPopupWindows.add(result._anglesWindowId);
    }
    if (result?._effectsWindowId) {
      effectsWindowId = result._effectsWindowId;
      _extensionPopupWindows.add(result._effectsWindowId);
    }
  },
);
let _settingsWindowOpening = false;
function _persistWindowIds() {
  chrome.storage?.session
    ?.set({
      _settingsWindowId: settingsWindowId,
      _workflowWindowId: workflowWindowId,
      _editingWorkflowId: editingWorkflowId,
      _templateWindowId: templateWindowId,
      _anglesWindowId: anglesWindowId,
      _effectsWindowId: effectsWindowId,
    })
    .catch(() => {});
}
async function _closeAllExtensionPopups() {
  const windowIds = [..._extensionPopupWindows];
  for (const windowId of windowIds) {
    try {
      await chrome.windows.remove(windowId);
    } catch (e) {}
  }
  _extensionPopupWindows.clear();
  settingsWindowId = null;
  workflowWindowId = null;
  editingWorkflowId = null;
  templateWindowId = null;
  anglesWindowId = null;
  effectsWindowId = null;
  _persistWindowIds();
}
chrome.runtime.onSuspend.addListener(() => {
  console.log("[Background] Extension suspending, closing popup windows...");
  _closeAllExtensionPopups();
});
chrome.runtime.onSuspend.addListener(() => {
  try {
    chrome.storage.local.get(["af_running_workflow"], (data) => {
      const execId = data?.af_running_workflow?.execution_id;
      if (!execId) return;
      fetch(`${getApiBaseUrl()}/executions/${execId}/complete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Extension-Id": chrome.runtime.id,
        },
        body: JSON.stringify({
          status: "stopped",
          summary: { reason: "sw_suspend" },
        }),
        keepalive: true,
        credentials: "include",
      }).catch(() => {});
      console.log("[Background] onSuspend: released execution token", execId);
    });
  } catch (_) {}
});
async function openOrActivateTab(
  urlPattern,
  createUrl,
  activate = true,
  focusWindow = true,
) {
  try {
    const existingTabs = await chrome.tabs.query({ url: urlPattern });
    if (existingTabs.length > 0) {
      const tab = existingTabs[0];
      if (activate) {
        await chrome.tabs.update(tab.id, { active: true });
        if (focusWindow)
          await chrome.windows.update(tab.windowId, { focused: true });
      }
      console.log(
        `[TobyFlow] Activated existing tab: ${tab.url?.substring(0, 50)}`,
      );
      return tab;
    } else {
      const newTab = await chrome.tabs.create({
        url: createUrl,
        active: activate,
      });
      console.log(`[TobyFlow] Created new tab: ${createUrl}`);
      return newTab;
    }
  } catch (err) {
    console.error("[TobyFlow] openOrActivateTab error:", err);
    return await chrome.tabs.create({ url: createUrl, active: activate });
  }
}
function _isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (!["https:", "http:"].includes(u.protocol)) return false;
    const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local")) return false;
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const p = m.slice(1).map(Number);
      if (p.some((n) => n < 0 || n > 255)) return false;
      if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224)
        return false;
      if (p[0] === 169 && p[1] === 254) return false;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
      if (p[0] === 192 && p[1] === 168) return false;
      if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
      if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
    }
    if (
      host === "::" ||
      host === "::1" ||
      host.startsWith("::ffff:") ||
      host.startsWith("fe8") ||
      host.startsWith("fe9") ||
      host.startsWith("fea") ||
      host.startsWith("feb") ||
      host.startsWith("fec") ||
      host.startsWith("fed") ||
      host.startsWith("fee") ||
      host.startsWith("fef") ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("ff") ||
      host.startsWith("2001:db8")
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
function _isAllowedFlowMediaUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "flow.google.com" ||
      host === "flow-content.google" ||
      host === "labs.google" ||
      host === "aisandbox-pa.googleapis.com" ||
      host === "googleusercontent.com" ||
      host.endsWith(".googleusercontent.com")
    );
  } catch (_) {
    return false;
  }
}
function _isAllowedFlowAsbRedirectUrl(url) {
  if (_isAllowedFlowMediaUrl(url)) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return (
      host === "storage.googleapis.com" ||
      host === "googlevideo.com" ||
      host.endsWith(".googlevideo.com")
    );
  } catch (_) {
    return false;
  }
}
function _isFlowPageUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      (parsed.origin === "https://flow.google.com" ||
        (parsed.origin === "https://labs.google" &&
          parsed.pathname.startsWith("/fx/")))
    );
  } catch (_) {
    return false;
  }
}
function _hostIs(host, root) {
  return host === root || host.endsWith("." + root);
}
function _safeUrlForLog(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "blob:") return `blob:${parsed.pathname}`;
    return `${parsed.origin}${parsed.pathname}`;
  } catch (_) {
    return "[invalid-url]";
  }
}
async function _readResponseBytesLimited(resp, maxBytes) {
  const declared = Number(resp.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    try {
      resp.body?.cancel?.().catch(() => {});
    } catch (_) {}
    throw new Error(`Response too large (${declared} bytes)`);
  }
  if (!resp.body?.getReader) {
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > maxBytes)
      throw new Error(`Response too large (${buf.byteLength} bytes)`);
    return new Uint8Array(buf);
  }
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch (_) {}
      throw new Error(`Response too large (>${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
async function _calcWindowPosition(popupWidth, popupHeight) {
  try {
    const currentWin = await chrome.windows.getCurrent();
    const winLeft = currentWin.left || 0;
    const winTop = currentWin.top || 0;
    const winWidth = currentWin.width || 1440;
    const winHeight = currentWin.height || 900;
    const sidebarWidth = 600;
    const sidebarLeft = winLeft + winWidth - sidebarWidth;
    let left = sidebarLeft - popupWidth;
    if (left < winLeft) left = winLeft;
    let top = winTop + Math.round((winHeight - popupHeight) / 2);
    if (top < winTop) top = winTop;
    return { left, top };
  } catch (e) {
    return { left: 100, top: 100 };
  }
}
let _pendingDownloadRenames = [];
const _geminiDownloadJobs = new Map();
const _museDownloadJobs = new Map();
const _museNativeDownloadTabs = new Set();
async function _probeMuseSessionInPage(policy) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), policy.timeout_ms);
  const startedAt = Date.now();
  let stage = "initial_get";
  let wakeAccepted = false;
  let pollCount = 0;
  let lastVmState = null;
  const timeoutDiagnostic = () => ({
    stage,
    wakeAccepted,
    pollCount,
    elapsedMs: Date.now() - startedAt,
    timeoutMs: policy.timeout_ms,
    lastVmState,
  });
  try {
    const options = {
      credentials: "include",
      mode: "same-origin",
      redirect: "error",
      signal: controller.signal,
      cache: "no-store",
    };
    const probe = async (probeStage) => {
      stage = probeStage;
      const response = await fetch(policy.session_url, options);
      if (!response.ok)
        return {
          success: false,
          error:
            response.status === 401
              ? "MUSE_SESSION_EXPIRED"
              : `MUSE_SESSION_HTTP_${response.status}`,
        };
      const session = await response.json();
      if (
        session?.status !== policy.assigned_status ||
        typeof session?.vm_state !== "string" ||
        !session.vm_state
      ) {
        return { success: false, error: "MUSE_SESSION_NOT_ASSIGNED" };
      }
      if (session.vm_state === policy.disabled_state)
        return {
          success: false,
          error: "MUSE_VM_DISABLED",
          vmState: session.vm_state,
        };
      return { success: true, vmId: session.vm_id, vmState: session.vm_state };
    };
    let state = await probe("initial_get");
    if (!state.success) return state;
    lastVmState = state.vmState;
    if (state.vmState === policy.running_state)
      return { success: true, vmState: state.vmState, woke: false };
    const vmId = state.vmId;
    if (!vmId || !["string", "number"].includes(typeof vmId))
      return { success: false, error: "MUSE_VM_ID_MISSING" };
    stage = "wake_post";
    const wake = await fetch(policy.wake_url, {
      ...options,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vm_id: vmId,
        retry_count: 0,
        connect_attempt_id: crypto.randomUUID(),
      }),
    });
    if (!wake.ok)
      return { success: false, error: `MUSE_VM_WAKE_HTTP_${wake.status}` };
    wakeAccepted = true;
    while (!controller.signal.aborted) {
      stage = "poll_wait";
      await new Promise((resolve) =>
        setTimeout(resolve, policy.poll_interval_ms),
      );
      if (controller.signal.aborted) break;
      pollCount++;
      state = await probe("poll_get");
      if (!state.success) return state;
      lastVmState = state.vmState;
      if (state.vmId !== vmId)
        return { success: false, error: "MUSE_SESSION_CHANGED" };
      if (state.vmState === policy.running_state)
        return { success: true, vmState: state.vmState, woke: true };
    }
    return {
      success: false,
      error: "MUSE_SESSION_TIMEOUT",
      diagnostic: timeoutDiagnostic(),
    };
  } catch (_) {
    return controller.signal.aborted
      ? {
          success: false,
          error: "MUSE_SESSION_TIMEOUT",
          diagnostic: timeoutDiagnostic(),
        }
      : { success: false, error: "MUSE_SESSION_REQUEST_FAILED" };
  } finally {
    clearTimeout(timer);
  }
}
function _setGeminiDownloadJob(requestId, patch) {
  if (!requestId) return;
  const current = _geminiDownloadJobs.get(requestId) || {};
  _geminiDownloadJobs.set(requestId, { ...current, ...patch });
}
function _findArmedGeminiRenameIndex(downloadItem, now = Date.now()) {
  if (downloadItem?.byExtensionId) return -1;
  const source = `${downloadItem?.url || ""} ${downloadItem?.finalUrl || ""} ${downloadItem?.referrer || ""}`;
  if (/(?:grok\.com|\.x\.ai)/i.test(source)) return -1;
  const candidates = [];
  _pendingDownloadRenames.forEach((entry, index) => {
    if (
      entry?.sourceProvider === "gemini" &&
      !!entry.requestId &&
      Number.isFinite(entry.expires) &&
      now <= entry.expires
    )
      candidates.push({ entry, index });
  });
  if (candidates.length === 0) return -1;
  if (Number.isInteger(downloadItem?.tabId) && downloadItem.tabId >= 0) {
    const exact = candidates.find(
      (candidate) => candidate.entry.tabId === downloadItem.tabId,
    );
    if (exact) return exact.index;
  }
  return candidates.length === 1 ? candidates[0].index : -1;
}
function _findArmedGrokRenameIndex(downloadItem, now = Date.now()) {
  if (downloadItem?.byExtensionId) return -1;
  const candidates = [];
  _pendingDownloadRenames.forEach((entry, index) => {
    if (
      entry?.sourceProvider === "grok" &&
      entry.requestId &&
      Number.isFinite(entry.expires) &&
      now <= entry.expires
    ) {
      candidates.push({ entry, index });
    }
  });
  if (!candidates.length) return -1;
  const source = `${downloadItem?.url || ""} ${downloadItem?.finalUrl || ""} ${downloadItem?.referrer || ""}`;
  const fromGrok = /(?:grok\.com|\.grok\.com|\.x\.ai|grok\.x\.ai)/i.test(
    source,
  );
  if (!fromGrok) return -1;
  const sameTab =
    Number.isInteger(downloadItem?.tabId) && downloadItem.tabId >= 0
      ? candidates.filter(({ entry }) => entry.tabId === downloadItem.tabId)
      : candidates;
  if (!sameTab.length) return -1;
  const exact = sameTab.filter(
    ({ entry }) => entry.identifier && source.includes(entry.identifier),
  );
  if (exact.length === 1) return exact[0].index;
  return sameTab.length === 1 ? sameTab[0].index : -1;
}
function _findArmedMuseRenameIndex(downloadItem, now = Date.now()) {
  if (downloadItem?.byExtensionId) return -1;
  const candidates = [];
  _pendingDownloadRenames.forEach((entry, index) => {
    if (
      entry?.sourceProvider === "muse" &&
      entry.requestId &&
      Number.isFinite(entry.expires) &&
      now <= entry.expires
    )
      candidates.push({ entry, index });
  });
  if (!candidates.length) return -1;
  const sourceUrls = [downloadItem?.url, downloadItem?.finalUrl];
  const owned = candidates.filter(({ entry }) => {
    if (entry.sourceUrl && sourceUrls.includes(entry.sourceUrl)) return true;
    return [
      downloadItem?.url,
      downloadItem?.finalUrl,
      downloadItem?.referrer,
    ].some((value) => {
      try {
        return (
          !!entry.sourceOrigin && new URL(value).origin === entry.sourceOrigin
        );
      } catch (_) {
        return false;
      }
    });
  });
  if (Number.isInteger(downloadItem?.tabId) && downloadItem.tabId >= 0) {
    const sameTab = owned.filter(
      (candidate) => candidate.entry.tabId === downloadItem.tabId,
    );
    const exact = sameTab.find(
      (candidate) =>
        candidate.entry.sourceUrl &&
        sourceUrls.includes(candidate.entry.sourceUrl),
    );
    if (exact) return exact.index;
    if (sameTab.length === 1) return sameTab[0].index;
    return -1;
  }
  return owned.length === 1 ? owned[0].index : -1;
}
function _isHtmlDownloadResponse(item) {
  const mime = String(item?.mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mime === "text/html" || mime === "application/xhtml+xml") return true;
  const name = String(item?.filename || "").toLowerCase();
  return /\.html?$/.test(name) && !/^(image|video)\//.test(mime);
}
async function _rejectHtmlDownload(item) {
  if (!Number.isInteger(item?.id)) return;
  try {
    if (item.state === "complete") await chrome.downloads.removeFile(item.id);
    else if (item.state !== "interrupted") {
      try {
        await chrome.downloads.cancel(item.id);
      } catch (_) {}
      const latest = (await chrome.downloads.search({ id: item.id }))?.[0];
      if (latest?.state === "complete" && _isHtmlDownloadResponse(latest)) {
        await chrome.downloads.removeFile(item.id);
      }
    }
  } catch (error) {
    console.warn(
      "[TobyFlow] Could not discard Flow HTML response:",
      error?.message || error,
    );
  }
}
async function _waitForGeminiDownload(
  requestId,
  timeoutMs,
  creationTimeoutMs = 9e4,
  rejectHtmlResponse = false,
  sourceProvider = null,
) {
  const startedAt = Date.now();
  let observedDownloadId = null;
  if (
    sourceProvider === "gemini" &&
    (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  )
    return { success: false, error: "MONITOR_CONFIG_INVALID" };
  const totalTimeout =
    sourceProvider === "gemini"
      ? timeoutMs
      : Math.min(Math.max(Number(timeoutMs) || 12e4, 1e3), 10 * 60 * 1e3);
  const deadline = startedAt + totalTimeout;
  const creationDeadline =
    startedAt +
    Math.min(totalTimeout, Math.max(1e3, Number(creationTimeoutMs) || 9e4));
  while (Date.now() < deadline) {
    const job = _geminiDownloadJobs.get(requestId);
    if (job?.error) {
      _geminiDownloadJobs.delete(requestId);
      return { success: false, error: job.error };
    }
    if (Number.isInteger(job?.downloadId)) {
      if (observedDownloadId !== job.downloadId) {
        observedDownloadId = job.downloadId;
        console.log(
          `[TobyFlow] Native download claimed: request=${requestId}, id=${job.downloadId}, wait=${Date.now() - startedAt}ms`,
        );
      }
      const item = (await chrome.downloads.search({ id: job.downloadId }))?.[0];
      if (rejectHtmlResponse && _isHtmlDownloadResponse(item)) {
        await _rejectHtmlDownload(item);
        _geminiDownloadJobs.delete(requestId);
        return {
          success: false,
          error: "FLOW_DOWNLOAD_HTML_RESPONSE",
          downloadId: item.id,
        };
      }
      if (item?.state === "complete") {
        console.log(
          `[TobyFlow] Native download confirmed complete: request=${requestId}, id=${item.id}, total=${Date.now() - startedAt}ms`,
        );
        _geminiDownloadJobs.delete(requestId);
        return { success: true, downloadId: item.id, filename: item.filename };
      }
      if (item?.state === "interrupted") {
        _geminiDownloadJobs.delete(requestId);
        return {
          success: false,
          error: item.error || "DOWNLOAD_INTERRUPTED",
          downloadId: item.id,
        };
      }
    }
    if (!Number.isInteger(job?.downloadId) && Date.now() >= creationDeadline) {
      _geminiDownloadJobs.delete(requestId);
      return { success: false, error: "DOWNLOAD_NOT_STARTED" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  _geminiDownloadJobs.delete(requestId);
  return { success: false, error: "DOWNLOAD_TIMEOUT" };
}
async function _waitForMuseDownload(
  requestId,
  timeoutMs,
  creationTimeoutMs = 9e4,
) {
  const startedAt = Date.now();
  const deadline =
    startedAt +
    Math.min(Math.max(Number(timeoutMs) || 12e4, 1e3), 10 * 60 * 1e3);
  const creationDeadline =
    startedAt +
    Math.min(
      deadline - startedAt,
      Math.max(1e3, Number(creationTimeoutMs) || 9e4),
    );
  while (Date.now() < deadline) {
    const job = _museDownloadJobs.get(requestId);
    if (job?.error) {
      _museDownloadJobs.delete(requestId);
      return { success: false, error: job.error };
    }
    if (Number.isInteger(job?.downloadId)) {
      const item = (await chrome.downloads.search({ id: job.downloadId }))?.[0];
      if (item?.state === "complete") {
        _museDownloadJobs.delete(requestId);
        return { success: true, downloadId: item.id, filename: item.filename };
      }
      if (item?.state === "interrupted") {
        _museDownloadJobs.delete(requestId);
        return {
          success: false,
          error: item.error || "DOWNLOAD_INTERRUPTED",
          downloadId: item.id,
        };
      }
    } else if (Date.now() >= creationDeadline) {
      _museDownloadJobs.delete(requestId);
      return { success: false, error: "DOWNLOAD_NOT_STARTED" };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  _museDownloadJobs.delete(requestId);
  return { success: false, error: "DOWNLOAD_TIMEOUT" };
}
async function _waitForChromeDownload(
  downloadId,
  timeoutMs,
  flowApiRetry = false,
  rejectHtmlResponse = false,
) {
  const deadline =
    Date.now() +
    Math.min(Math.max(Number(timeoutMs) || 3e4, 1e3), 10 * 60 * 1e3);
  let retries = 0;
  let maxRetries = null;
  while (Date.now() < deadline) {
    const item2 = (await chrome.downloads.search({ id: downloadId }))?.[0];
    if (rejectHtmlResponse && _isHtmlDownloadResponse(item2)) {
      await _rejectHtmlDownload(item2);
      return {
        success: false,
        downloadId,
        state: item2.state,
        error: "FLOW_DOWNLOAD_HTML_RESPONSE",
      };
    }
    if (item2?.state === "complete")
      return {
        success: true,
        downloadId,
        state: "complete",
        filename: item2.filename,
      };
    if (item2?.state === "interrupted") {
      if (
        flowApiRetry &&
        item2.canResume &&
        /^(NETWORK_|SERVER_UNREACHABLE|FILE_TRANSIENT_ERROR)/.test(
          item2.error || "",
        )
      ) {
        if (maxRetries === null) {
          try {
            maxRetries = await FlowApiDownloadRetry.budget();
          } catch (_) {
            maxRetries = 0;
          }
        }
        if (retries < maxRetries) {
          retries++;
          console.warn(
            "[FlowDownloadRetry] resume Chrome download",
            JSON.stringify({
              downloadId,
              retry: retries,
              maxRetries,
              error: item2.error,
            }),
          );
          try {
            await chrome.downloads.resume(downloadId);
            continue;
          } catch (_) {}
        }
      }
      return {
        success: false,
        downloadId,
        state: "interrupted",
        error: item2.error || "DOWNLOAD_INTERRUPTED",
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const item = (await chrome.downloads.search({ id: downloadId }))?.[0];
  if (rejectHtmlResponse && _isHtmlDownloadResponse(item)) {
    await _rejectHtmlDownload(item);
    return {
      success: false,
      downloadId,
      state: item.state,
      error: "FLOW_DOWNLOAD_HTML_RESPONSE",
    };
  }
  if (item?.state === "complete")
    return {
      success: true,
      downloadId,
      state: "complete",
      filename: item.filename,
    };
  return {
    success: false,
    downloadId,
    state: "timeout",
    error: "Download timeout",
  };
}
const _PERSIST_KEY_RENAMES = "af_pending_download_renames";
function _persistPendingRenames() {
  try {
    chrome.storage?.session?.set({
      [_PERSIST_KEY_RENAMES]: _pendingDownloadRenames,
    });
  } catch (_) {}
}
async function _restorePendingRenames() {
  try {
    const res = await new Promise((resolve) => {
      chrome.storage?.session?.get([_PERSIST_KEY_RENAMES], (r) =>
        resolve(r || {}),
      );
    });
    const saved = res?.[_PERSIST_KEY_RENAMES];
    if (Array.isArray(saved)) {
      const now = Date.now();
      _pendingDownloadRenames = saved.filter(
        (r) => r && typeof r.expires === "number" && now <= r.expires,
      );
      if (_pendingDownloadRenames.length > 0) {
        console.log(
          `[TobyFlow] _restorePendingRenames: ${_pendingDownloadRenames.length} entries restored from session`,
        );
      }
    }
  } catch (_) {}
}
_restorePendingRenames();
const _determineLegacyDownloadFilename = (downloadItem, suggest) => {
  const initiatorExtId = downloadItem.byExtensionId;
  if (initiatorExtId && initiatorExtId !== chrome.runtime.id) {
    console.log(
      `[TobyFlow] onDeterminingFilename: initiated by different extension (${initiatorExtId}), skip`,
    );
    return;
  }
  const now = Date.now();
  const beforeFilter = _pendingDownloadRenames.length;
  _pendingDownloadRenames = _pendingDownloadRenames.filter(
    (r) => now <= r.expires,
  );
  if (_pendingDownloadRenames.length !== beforeFilter) _persistPendingRenames();
  if (_pendingDownloadRenames.length === 0) {
    console.log(
      `[TobyFlow] onDeterminingFilename: no pending renames, skip. file="${downloadItem.filename}"`,
    );
    return;
  }
  const url = downloadItem.url || "";
  const referrer = downloadItem.referrer || "";
  const filename = downloadItem.filename || "";
  const mime = downloadItem.mime || "";
  const grokRenameIdx = _findArmedGrokRenameIndex(downloadItem, now);
  if (grokRenameIdx >= 0) {
    const rename2 = _pendingDownloadRenames.splice(grokRenameIdx, 1)[0];
    _persistPendingRenames();
    _setGeminiDownloadJob(rename2.requestId, { downloadId: downloadItem.id });
    const fullPath2 = rename2.folder
      ? `${rename2.folder}/${rename2.filename}`
      : rename2.filename;
    suggest({ filename: fullPath2, conflictAction: "uniquify" });
    return;
  }
  const geminiRenameIdx = _findArmedGeminiRenameIndex(downloadItem, now);
  if (geminiRenameIdx >= 0) {
    const rename2 = _pendingDownloadRenames.splice(geminiRenameIdx, 1)[0];
    _persistPendingRenames();
    _setGeminiDownloadJob(rename2.requestId, { downloadId: downloadItem.id });
    const originalExt = downloadItem.filename?.split(".").pop() || "png";
    const customName2 = rename2.filename.includes(".")
      ? rename2.filename
      : `${rename2.filename}.${originalExt}`;
    const fullPath2 = rename2.folder
      ? `${rename2.folder}/${customName2}`
      : customName2;
    console.log(
      `[TobyFlow] Gemini armed download rename: ${downloadItem.filename} \u2192 ${fullPath2}`,
    );
    suggest({ filename: fullPath2, conflictAction: "uniquify" });
    return;
  }
  const museRenameIdx = _findArmedMuseRenameIndex(downloadItem, now);
  if (museRenameIdx >= 0) {
    const rename2 = _pendingDownloadRenames.splice(museRenameIdx, 1)[0];
    _persistPendingRenames();
    _museDownloadJobs.set(rename2.requestId, { downloadId: downloadItem.id });
    const nativeExtension =
      String(downloadItem.filename || "").match(/\.([a-z0-9]{1,10})$/i)?.[0] ||
      "";
    const name =
      rename2.mediaType === "image"
        ? rename2.filename.replace(/\.[^.\/]+$/, "") + nativeExtension
        : rename2.filename +
          (/\.(mp4|webm|mov)$/i.test(rename2.filename) ? "" : nativeExtension);
    const fullPath2 = rename2.folder ? `${rename2.folder}/${name}` : name;
    console.log(
      `[TobyFlow] Muse armed download rename: ${downloadItem.filename} \u2192 ${fullPath2}`,
    );
    suggest({ filename: fullPath2, conflictAction: "uniquify" });
    return;
  }
  if (initiatorExtId === chrome.runtime.id) {
    let renameIdx2 = _pendingDownloadRenames.findIndex(
      (r) => r.identifier && url.includes(r.identifier),
    );
    if (renameIdx2 < 0) renameIdx2 = 0;
    const urlUuidMatch2 = url.match(/name=([a-f0-9-]{36})/i);
    if (urlUuidMatch2) {
      const urlUuid = urlUuidMatch2[1];
      const matchIdx = _pendingDownloadRenames.findIndex(
        (r) =>
          r.identifier &&
          (r.identifier.includes(urlUuid) || urlUuid.includes(r.identifier)),
      );
      if (matchIdx >= 0) renameIdx2 = matchIdx;
    }
    const rename2 = _pendingDownloadRenames.splice(renameIdx2, 1)[0];
    _persistPendingRenames();
    if (rename2.requestId)
      _setGeminiDownloadJob(rename2.requestId, { downloadId: downloadItem.id });
    const origExt2 = downloadItem.filename?.split(".").pop() || "png";
    const customName2 = rename2.filename.includes(".")
      ? rename2.filename
      : `${rename2.filename}.${origExt2}`;
    const fullPath2 = rename2.folder
      ? `${rename2.folder}/${customName2}`
      : customName2;
    console.log(
      `[TobyFlow] Download rename (own extension): ${downloadItem.filename} \u2192 ${fullPath2}`,
    );
    suggest({ filename: fullPath2, conflictAction: "uniquify" });
    return;
  }
  if (referrer.includes("grok.com") || referrer.includes("x.com")) {
    console.log(`[TobyFlow] onDeterminingFilename: referrer is Grok/X, skip`);
    return;
  }
  const looksLikeGrokUrl =
    url.includes("grok.com") ||
    url.includes("imagine-public.x.ai") ||
    url.includes("assets.grok") ||
    url.includes("video.grok");
  if (looksLikeGrokUrl) {
    console.log(`[TobyFlow] onDeterminingFilename: URL looks like Grok, skip`);
    return;
  }
  if (url.startsWith("data:") && initiatorExtId === chrome.runtime.id) {
    const _e = _pendingDownloadRenames.shift();
    if (_e && _e.folder) {
      if (_e.requestId)
        _setGeminiDownloadJob(_e.requestId, { downloadId: downloadItem.id });
      suggest({
        filename: `${_e.folder}/${_e.filename}`,
        conflictAction: "uniquify",
      });
      return true;
    }
    return;
  }
  const hasFlowReferrer = _isFlowPageUrl(referrer);
  const hasFlowUrl = _isAllowedFlowMediaUrl(url);
  const isVideoDownload =
    mime.startsWith("video/") ||
    filename.endsWith(".mp4") ||
    filename.endsWith(".webm") ||
    filename.endsWith(".mov");
  const isFlowDownload =
    hasFlowReferrer ||
    hasFlowUrl ||
    ((url.includes("googleusercontent.com") ||
      url.includes("storage.googleapis.com") ||
      url.includes("googlevideo.com")) &&
      hasFlowReferrer) ||
    (url.startsWith("blob:") && hasFlowReferrer) ||
    (isVideoDownload && hasFlowReferrer);
  if (!isFlowDownload) {
    console.log(`[TobyFlow] onDeterminingFilename: not from Flow page, skip`);
    return;
  }
  let renameIdx = _pendingDownloadRenames.findIndex(
    (r) => r.identifier && url.includes(r.identifier),
  );
  if (renameIdx < 0) renameIdx = 0;
  const urlUuidMatch = url.match(/name=([a-f0-9-]{36})/i);
  if (urlUuidMatch) {
    const urlUuid = urlUuidMatch[1];
    const matchIdx = _pendingDownloadRenames.findIndex(
      (r) =>
        r.identifier &&
        (r.identifier.includes(urlUuid) || urlUuid.includes(r.identifier)),
    );
    if (matchIdx >= 0) renameIdx = matchIdx;
  }
  const rename = _pendingDownloadRenames.splice(renameIdx, 1)[0];
  _persistPendingRenames();
  if (rename.requestId)
    _setGeminiDownloadJob(rename.requestId, { downloadId: downloadItem.id });
  let origExt = downloadItem.filename?.split(".").pop()?.toLowerCase() || "png";
  if (_isHtmlDownloadResponse(downloadItem)) {
    console.warn("[TobyFlow] Flow menu returned HTML instead of media", {
      downloadId: downloadItem.id,
      mime,
      filename: downloadItem.filename,
    });
    if (rename.requestId)
      _setGeminiDownloadJob(rename.requestId, {
        error: "FLOW_DOWNLOAD_HTML_RESPONSE",
      });
    _rejectHtmlDownload(downloadItem).catch(() => {});
    return;
  }
  if (origExt === "html" || origExt === "htm") {
    if (mime.startsWith("video/") || isVideoDownload) {
      origExt = "mp4";
    } else if (mime.startsWith("image/")) {
      origExt = mime === "image/jpeg" ? "jpg" : mime.split("/")[1] || "png";
    }
    console.info(
      `[TobyFlow] Download rename: media MIME with stale HTML filename (mime="${mime}") \u2192 ${origExt}`,
    );
  }
  const customName = rename.filename.includes(".")
    ? rename.filename
    : `${rename.filename}.${origExt}`;
  const fullPath = rename.folder
    ? `${rename.folder}/${customName}`
    : customName;
  console.log(
    `[TobyFlow] Download rename: ${downloadItem.filename} \u2192 ${fullPath}`,
  );
  suggest({ filename: fullPath, conflictAction: "uniquify" });
};
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (
    ![item.url, item.finalUrl].some(
      (url) => typeof url === "string" && url.startsWith("blob:"),
    )
  )
    return _determineLegacyDownloadFilename(item, suggest);
  MotionWebCapture.claim(item)
    .then((entry) => {
      if (!entry) {
        let suggested = false;
        _determineLegacyDownloadFilename(item, (value) => {
          suggested = true;
          suggest(value);
        });
        if (!suggested) suggest();
        return;
      }
      _setGeminiDownloadJob(entry.operationId, { downloadId: item.id });
      suggest({ filename: entry.filename, conflictAction: "overwrite" });
    })
    .catch((error) => {
      console.warn("[MotionWebCapture]", { code: error?.message });
      suggest();
    });
  return true;
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "motionWebCaptureCleanup")
    MotionWebCapture.sweep().catch((error) =>
      console.warn("[MotionWebCaptureCleanup]", { code: error?.message }),
    );
});
MotionWebCapture.sweep().catch(() => {});
chrome.downloads.onCreated.addListener((downloadItem) => {
  const renameIdx = _findArmedGrokRenameIndex(downloadItem);
  if (renameIdx < 0) return;
  const entry = _pendingDownloadRenames[renameIdx];
  if (entry?.requestId)
    _setGeminiDownloadJob(entry.requestId, { downloadId: downloadItem.id });
});
chrome.downloads.onCreated.addListener((downloadItem) => {
  const now = Date.now();
  const url = downloadItem.finalUrl || downloadItem.url || "";
  const renameIdx = _findArmedGeminiRenameIndex(downloadItem, now);
  if (renameIdx < 0 || !/^https?:/i.test(url)) return;
  const rename = _pendingDownloadRenames.splice(renameIdx, 1)[0];
  _persistPendingRenames();
  const originalExt = downloadItem.filename?.split(".").pop() || "png";
  const customName = rename.filename.includes(".")
    ? rename.filename
    : `${rename.filename}.${originalExt}`;
  const fullPath = rename.folder
    ? `${rename.folder}/${customName}`
    : customName;
  console.log(
    `[TobyFlow] Gemini native download created; preparing "${fullPath}" clean=${rename.removeWatermark === true}`,
  );
  (async () => {
    let replacementUrl = url;
    if (rename.removeWatermark === true) {
      const cleaned = await _removeWatermarkFromSource({
        url,
        mime: downloadItem.mime || "image/png",
        mediaType: "image",
      });
      if (cleaned?.success && cleaned.applied && cleaned.base64) {
        replacementUrl = `data:${cleaned.mime || downloadItem.mime || "image/png"};base64,${cleaned.base64}`;
        console.log("[TobyFlow] Gemini full-size watermark removal applied");
      } else {
        console.warn(
          "[TobyFlow] Gemini full-size watermark not removed; preserving original bytes:",
          cleaned?.reason || cleaned?.error || "not_applied",
        );
      }
    }
    const replacementId = await chrome.downloads.download({
      url: replacementUrl,
      filename: fullPath,
      conflictAction: "uniquify",
    });
    _setGeminiDownloadJob(rename.requestId, { downloadId: replacementId });
    try {
      await chrome.downloads.cancel(downloadItem.id);
    } catch (_) {}
    try {
      await chrome.downloads.removeFile(downloadItem.id);
    } catch (_) {}
    try {
      await chrome.downloads.erase({ id: downloadItem.id });
    } catch (_) {}
    console.log(
      `[TobyFlow] Gemini native download replaced: original=${downloadItem.id}, replacement=${replacementId}`,
    );
  })().catch((error) => {
    console.warn(
      "[TobyFlow] Gemini native download processing failed; keeping original:",
      error?.message || error,
    );
    _setGeminiDownloadJob(rename.requestId, { downloadId: downloadItem.id });
  });
});
chrome.alarms.create("swKeepAlive", { periodInMinutes: 0.5 });
const _FAR_DEBUG = false;
let _executionConfigCache = null;
let _executionConfigCacheTime = 0;
const _EXECUTION_CONFIG_CACHE_TTL_MS = 5 * 60 * 1e3;
function _isValidExecutionConfig(data) {
  return !!(
    data &&
    typeof data === "object" &&
    (data.workflow || data.flow_recovery) &&
    ["pause_resume", "normal_error", "stop_batch"].includes(
      data.flow_recovery?.captcha_recovery_mode,
    )
  );
}
async function _fetchExecutionConfig() {
  const result = await ProtectedConfigClient.fetch("execution");
  if (!_isValidExecutionConfig(result.data))
    throw Object.assign(new Error("CONFIG_RESPONSE_INVALID"), {
      code: "CONFIG_RESPONSE_INVALID",
    });
  _executionConfigCache = result.data;
  _executionConfigCacheTime = Date.now();
  return result.data;
}
async function _motionRunnerEnsure(message, sender) {
  let caller;
  try {
    caller = new URL(sender?.url);
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const allowed = ["sidebar.html", "motion-editor.html"].some((page) => {
    const expected = new URL(chrome.runtime.getURL(page));
    return (
      caller.protocol === expected.protocol &&
      caller.host === expected.host &&
      caller.pathname === expected.pathname
    );
  });
  if (sender?.id !== chrome.runtime.id || !allowed)
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(message?.projectId || ""),
    ) ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(String(message?.flowProjectId || ""))
  ) {
    return { success: false, error: "MOTION_RUNNER_SCOPE_INVALID" };
  }
  return _motionRunnerEnsureCore(message);
}
async function _motionRunnerEnsureCore(message) {
  const initial = await chrome.storage.local.get([
    "af_auth",
    "af_system_settings",
  ]);
  const auth = initial?.af_auth;
  const userId = Number(auth?.user?.id);
  if (!auth?.token || !Number.isSafeInteger(userId) || userId < 1)
    return { success: false, error: "AUTH_REQUIRED" };
  const timeoutMs = Number(initial?.af_system_settings?.api_timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return { success: false, error: "API_TIMEOUT_CONFIG_UNAVAILABLE" };
  let response, payload;
  const controller = new AbortController();
  let timer;
  try {
    ({ response, payload } = await Promise.race([
      (async () => {
        const result = await _signedFetch(
          `${getApiBaseUrl()}/tools/motion-studio/projects/${encodeURIComponent(message.projectId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${auth.token}`,
              Accept: "application/json",
              "X-Extension-Id": chrome.runtime.id,
            },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        return { response: result, payload: await result.json() };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("MOTION_RUNNER_PROJECT_TIMEOUT"));
        }, timeoutMs);
      }),
    ]));
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_PROJECT_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
  const current = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (current?.token !== auth.token || Number(current?.user?.id) !== userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  if (
    !response.ok ||
    payload?.success !== true ||
    payload.data?.tool_project_id !== message.projectId
  ) {
    return {
      success: false,
      error: payload?.error?.code || "MOTION_RUNNER_PROJECT_UNAVAILABLE",
    };
  }
  if (payload.data.flow_project_id !== message.flowProjectId)
    return { success: false, error: "MOTION_FLOW_PROJECT_MISMATCH" };
  const assertScope = async () => {
    const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
    if (latest?.token !== auth.token || Number(latest?.user?.id) !== userId)
      throw new Error("ACCOUNT_SCOPE_CHANGED");
  };
  try {
    const tabs = (
      await chrome.tabs.query({ url: getFlowTabQueryPatterns() })
    ).filter((tab) => {
      const flow = describeFlowTab(tab);
      return flow?.isProjectEditor && flow.projectId === message.flowProjectId;
    });
    const flowTab = selectFlowTab(tabs);
    if (!Number.isInteger(flowTab?.windowId))
      return { success: false, error: "MOTION_FLOW_PROJECT_MISMATCH" };
    return await MotionRunnerHostRegistry.ensure(
      { userId, timeoutMs, sourceWindowId: flowTab.windowId },
      assertScope,
    );
  } catch (error) {
    return {
      success: false,
      error: error?.message || "MOTION_RUNNER_START_FAILED",
    };
  }
}
async function _providerWorkerAdmission(provider) {
  const config =
    !_executionConfigCache ||
    Date.now() - _executionConfigCacheTime > _EXECUTION_CONFIG_CACHE_TTL_MS
      ? await _fetchExecutionConfig()
      : _executionConfigCache;
  const settings = config?.parallel;
  if (settings?.provider_web_enabled === false) return { enabled: false };
  if (
    settings?.provider_web_enabled !== true ||
    !Number.isSafeInteger(settings.provider_web_max_concurrent_workers) ||
    settings.provider_web_max_concurrent_workers < 1 ||
    settings.provider_web_max_concurrent_workers > 4 ||
    !Array.isArray(settings.provider_web_enabled_providers) ||
    settings.provider_web_enabled_providers.some(
      (value) => !["muse", "grok", "chatgpt", "gemini"].includes(value),
    )
  ) {
    throw new Error("PROVIDER_WORKER_CONFIG_INVALID");
  }
  return {
    enabled: settings.provider_web_enabled_providers.includes(provider),
    max: settings.provider_web_max_concurrent_workers,
  };
}
async function _motionWorkerCreate(message, sender) {
  let caller;
  try {
    caller = new URL(sender?.url);
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const expected = new URL(chrome.runtime.getURL("motion-runner.html"));
  const host = (
    await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
  )?.[MotionRunnerHostRegistry.KEY];
  if (
    sender?.id !== chrome.runtime.id ||
    caller.protocol !== expected.protocol ||
    caller.host !== expected.host ||
    caller.pathname !== expected.pathname ||
    sender.tab?.id !== host?.tabId ||
    sender.tab?.windowId !== host?.windowId ||
    message.hostEpoch !== host?.epoch
  ) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const initial = await chrome.storage.local.get([
    "af_auth",
    "af_system_settings",
  ]);
  const auth = initial?.af_auth;
  const userId = Number(auth?.user?.id);
  const timeoutMs = Number(initial?.af_system_settings?.api_timeout_ms);
  if (!auth?.token || userId !== host.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    return { success: false, error: "API_TIMEOUT_CONFIG_UNAVAILABLE" };
  if (
    !["chatgpt", "gemini"].includes(message.provider) ||
    !Number.isInteger(message.flowTabId)
  ) {
    return { success: false, error: "MOTION_WORKER_SCOPE_INVALID" };
  }
  const owner = {
    userId,
    toolProjectId: message.toolProjectId,
    runId: message.runId,
    epoch: message.epoch,
    workerId: message.workerId,
    attemptId: message.attemptId,
  };
  let record;
  try {
    record = await MotionRunJournal.get(owner);
  } catch (_) {
    return { success: false, error: "MOTION_WORKER_SCOPE_INVALID" };
  }
  const operation = record?.operations?.[message.attemptId];
  if (
    record?.state !== "running" ||
    !(await MotionRunJournal.isWorkerLeaseActive(owner))
  ) {
    return { success: false, error: "MOTION_WORKER_FENCED" };
  }
  if (record.transcriptionProvider !== message.provider)
    return { success: false, error: "MOTION_WORKER_PROVIDER_MISMATCH" };
  const flowTab = await chrome.tabs.get(message.flowTabId).catch(() => null);
  const flow = describeFlowTab(flowTab);
  if (
    !flow?.isProjectEditor ||
    flow.projectId !== record.flowProjectId ||
    !Number.isInteger(flowTab?.windowId)
  ) {
    return { success: false, error: "MOTION_FLOW_PROJECT_MISMATCH" };
  }
  const pinnedLayout = record.preparationSnapshot?.layout;
  if (pinnedLayout && pinnedLayout.sourceWindowId !== flowTab.windowId)
    return { success: false, error: "MOTION_SOURCE_WINDOW_CHANGED" };
  const workerScreen = pinnedLayout?.screen || message;
  const controller = new AbortController();
  let timer;
  let response;
  let payload;
  try {
    ({ response, payload } = await Promise.race([
      (async () => {
        const result = await _signedFetch(
          `${getApiBaseUrl()}/tools/motion-studio/projects/${encodeURIComponent(message.toolProjectId)}`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${auth.token}`,
              Accept: "application/json",
              "X-Extension-Id": chrome.runtime.id,
            },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        return { response: result, payload: await result.json() };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("MOTION_PROJECT_TIMEOUT"));
        }, timeoutMs);
      }),
    ]));
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_PROJECT_UNAVAILABLE" };
  } finally {
    clearTimeout(timer);
  }
  const project = payload?.data;
  const frame = project?.data_json?.frames?.[operation?.frameId];
  if (project?.data_json?.paused === true)
    return { success: false, error: "MOTION_PROJECT_PAUSED" };
  if (
    project?.data_json?.preferences?.transcription_provider &&
    project.data_json.preferences.transcription_provider !== message.provider
  ) {
    return { success: false, error: "MOTION_WORKER_PROVIDER_MISMATCH" };
  }
  if (
    !response.ok ||
    payload?.success !== true ||
    project?.tool_project_id !== message.toolProjectId ||
    project?.flow_project_id !== record.flowProjectId ||
    Number(project?.data_json?.source_revision) !== record.sourceRevision ||
    frame?.run_id !== operation.frameRunId ||
    Number(frame?.input_revision) !== operation.inputRevision ||
    frame?.stages?.transcribe?.state !== "running" ||
    frame?.stages?.transcribe?.worker?.project_run_id !== message.runId ||
    frame?.stages?.transcribe?.worker?.attempt_id !== message.attemptId ||
    Number(frame?.stages?.transcribe?.worker?.retry_count) !==
      operation.retryCount ||
    (operation.fullAudioFrames &&
      !MotionRunJournal.fullAudioCheckpointMatches(
        record,
        operation,
        project,
        message.attemptId,
      ))
  ) {
    return { success: false, error: "MOTION_WORKER_CHECKPOINT_MISMATCH" };
  }
  const assertScope = async () => {
    const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
    const currentHost = (
      await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
    )?.[MotionRunnerHostRegistry.KEY];
    const currentFlowTab = await chrome.tabs
      .get(message.flowTabId)
      .catch(() => null);
    const currentFlow = describeFlowTab(currentFlowTab);
    const current = await MotionRunJournal.get(owner);
    if (
      latest?.token !== auth.token ||
      Number(latest?.user?.id) !== userId ||
      currentHost?.tabId !== host.tabId ||
      currentHost?.windowId !== host.windowId ||
      currentHost?.epoch !== host.epoch ||
      currentHost?.userId !== userId ||
      !currentFlow?.isProjectEditor ||
      currentFlow.projectId !== record.flowProjectId ||
      currentFlowTab?.windowId !== flowTab.windowId ||
      current?.state !== "running" ||
      !(await MotionRunJournal.isWorkerLeaseActive(owner))
    )
      throw new Error("MOTION_WORKER_FENCED");
  };
  let startupTimeoutMs = null;
  const admit = async (provider) => {
    await assertScope();
    const config =
      !_executionConfigCache ||
      Date.now() - _executionConfigCacheTime > _EXECUTION_CONFIG_CACHE_TTL_MS
        ? await _fetchExecutionConfig()
        : _executionConfigCache;
    const parallel = config?.parallel;
    if (parallel?.provider_web_motion_enabled === false)
      return { enabled: false };
    const startup = parallel?.[`provider_web_${provider}_startup_timeout_ms`];
    if (
      parallel?.provider_web_motion_enabled !== true ||
      !Number.isInteger(startup) ||
      startup < 1e4 ||
      startup > 12e4
    ) {
      throw new Error("PROVIDER_WORKER_CONFIG_INVALID");
    }
    startupTimeoutMs = startup;
    const [motionAccess, providerAccess] = await Promise.all([
      _featureAllowed("motion_tool_enabled"),
      _featureAllowed(`${provider}_enabled`),
    ]);
    if (!motionAccess.allowed || !providerAccess.allowed)
      return { enabled: false };
    return _providerWorkerAdmission(provider);
  };
  try {
    if (
      pinnedLayout &&
      ["screenLeft", "screenTop", "screenWidth", "screenHeight"].every((key) =>
        Number.isSafeInteger(workerScreen[key]),
      )
    ) {
      const authorization = await admit(message.provider);
      if (authorization?.enabled !== true)
        return { success: false, error: "PROVIDER_WEB_PAUSED_BY_CONFIG" };
      const layout = await ProviderWorkerRegistry.prepareMainLayout({
        windowId: pinnedLayout.sourceWindowId,
        runId: message.runId,
        ...workerScreen,
      });
      if (layout?.success !== true)
        console.warn("[MotionWorker] main layout unavailable", {
          code: layout?.error || "LAYOUT_UNAVAILABLE",
        });
      await assertScope();
    }
    const result = await ProviderWorkerRegistry.create(
      {
        ...owner,
        provider: message.provider,
        accountTabId: message.accountTabId ?? null,
        sourceWindowId: flowTab.windowId,
        sourceSurface: "motion",
        flowTabId: message.flowTabId,
        hostEpoch: host.epoch,
        hostTabId: host.tabId,
        screenTop: workerScreen.screenTop,
        screenHeight: workerScreen.screenHeight,
        screenLeft: workerScreen.screenLeft,
        screenWidth: workerScreen.screenWidth,
      },
      admit,
    );
    if (result.success) {
      try {
        await assertScope();
      } catch (error) {
        const closed = await ProviderWorkerRegistry.close(result.worker).catch(
          () => null,
        );
        return {
          success: false,
          error: error?.message || "MOTION_WORKER_FENCED",
          ...(closed?.success !== true && {
            closePending: true,
            worker: result.worker,
          }),
        };
      }
    }
    return result.success
      ? { ...result, waitForEditorMs: startupTimeoutMs }
      : result;
  } catch (error) {
    return {
      success: false,
      error: error?.message || "MOTION_WORKER_CREATE_FAILED",
    };
  }
}
async function _motionWorkerClose(message, sender) {
  let caller;
  try {
    caller = new URL(sender?.url);
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const expected = new URL(chrome.runtime.getURL("motion-runner.html"));
  const host = (
    await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
  )?.[MotionRunnerHostRegistry.KEY];
  if (
    sender?.id !== chrome.runtime.id ||
    caller.protocol !== expected.protocol ||
    caller.host !== expected.host ||
    caller.pathname !== expected.pathname ||
    sender.tab?.id !== host?.tabId ||
    sender.tab?.windowId !== host?.windowId ||
    message.hostEpoch !== host?.epoch
  ) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (!auth?.token || Number(auth?.user?.id) !== host.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  const record = (await ProviderWorkerRegistry._read())[message.workerId];
  if (!record) {
    const run2 = await MotionRunJournal.get({
      userId: host.userId,
      toolProjectId: message.toolProjectId,
    });
    const terminal =
      run2?.failedOperations?.[message.attemptId] ||
      run2?.completedOperations?.[message.attemptId];
    if (
      run2?.runId !== message.runId ||
      run2?.epoch !== message.epoch ||
      run2?.operations?.[message.attemptId] ||
      terminal?.workerId !== message.workerId ||
      !Number.isInteger(message.tabId)
    ) {
      return { success: false, error: "MOTION_WORKER_OWNER_MISMATCH" };
    }
    const tabs = await chrome.tabs.query({});
    const latest2 = (await chrome.storage.local.get("af_auth"))?.af_auth;
    const currentHost2 = (
      await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
    )?.[MotionRunnerHostRegistry.KEY];
    if (
      latest2?.token !== auth.token ||
      Number(latest2?.user?.id) !== host.userId ||
      currentHost2?.tabId !== host.tabId ||
      currentHost2?.windowId !== host.windowId ||
      currentHost2?.epoch !== host.epoch ||
      currentHost2?.userId !== host.userId
    )
      return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
    return tabs.some((tab) => tab.id === message.tabId)
      ? { success: false, error: "MOTION_WORKER_OWNER_MISMATCH" }
      : { success: true, alreadyClosed: true };
  }
  if (
    !record ||
    record.sourceSurface !== "motion" ||
    record.userId !== String(host.userId) ||
    record.tabId !== message.tabId ||
    record.epoch !== message.epoch ||
    record.runId !== message.runId ||
    record.toolProjectId !== message.toolProjectId ||
    record.attemptId !== message.attemptId
  ) {
    return { success: false, error: "MOTION_WORKER_OWNER_MISMATCH" };
  }
  const run = await MotionRunJournal.get({
    userId: host.userId,
    toolProjectId: record.toolProjectId,
  });
  if (
    run?.runId !== record.runId ||
    run?.epoch !== record.epoch ||
    run?.operations?.[record.attemptId] ||
    !(
      run?.failedOperations?.[record.attemptId] ||
      run?.completedOperations?.[record.attemptId]
    )
  ) {
    return { success: false, error: "MOTION_WORKER_RESULT_NOT_COMMITTED" };
  }
  const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
  const currentHost = (
    await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
  )?.[MotionRunnerHostRegistry.KEY];
  if (
    latest?.token !== auth.token ||
    Number(latest?.user?.id) !== host.userId ||
    currentHost?.tabId !== host.tabId ||
    currentHost?.windowId !== host.windowId ||
    currentHost?.epoch !== host.epoch ||
    currentHost?.userId !== host.userId
  ) {
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  }
  return ProviderWorkerRegistry.close(record);
}
async function _motionReleaseLayout(message, sender) {
  const host = (
    await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
  )?.[MotionRunnerHostRegistry.KEY];
  if (
    !host ||
    sender?.id !== chrome.runtime.id ||
    sender?.url !== (host.url || chrome.runtime.getURL("motion-runner.html")) ||
    sender.tab?.id !== host.tabId ||
    sender.tab?.windowId !== host.windowId ||
    message.hostEpoch !== host.epoch
  )
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (!auth?.token || Number(auth.user?.id) !== host.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  const run = await MotionRunJournal.get({
    userId: host.userId,
    toolProjectId: message.toolProjectId,
  });
  if (!run || run.runId !== message.runId)
    return { success: false, error: "MOTION_RUN_FENCED" };
  const layout = run.preparationSnapshot?.layout;
  if (!layout) return { success: true, restored: false };
  const workers = Object.values(await ProviderWorkerRegistry._read());
  if (
    workers.some(
      (worker) =>
        worker.sourceSurface === "motion" &&
        worker.userId === String(host.userId) &&
        worker.toolProjectId === message.toolProjectId &&
        worker.runId === run.runId,
    )
  )
    return { success: false, error: "MOTION_WORKER_CLOSE_PENDING" };
  const current = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (current?.token !== auth.token || Number(current.user?.id) !== host.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  return ProviderWorkerRegistry.restoreMainLayout({
    windowId: layout.sourceWindowId,
    runId: run.runId,
  });
}
async function _motionWorkerReconcile(message, sender) {
  let caller;
  try {
    caller = new URL(sender?.url);
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const expected = new URL(chrome.runtime.getURL("motion-runner.html"));
  const host = (
    await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
  )?.[MotionRunnerHostRegistry.KEY];
  if (
    sender?.id !== chrome.runtime.id ||
    caller.protocol !== expected.protocol ||
    caller.host !== expected.host ||
    caller.pathname !== expected.pathname ||
    sender.tab?.id !== host?.tabId ||
    sender.tab?.windowId !== host?.windowId ||
    message.hostEpoch !== host?.epoch
  )
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (!auth?.token || Number(auth?.user?.id) !== host.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  const owner = {
    userId: host.userId,
    toolProjectId: message.toolProjectId,
    runId: message.runId,
    ownerId: message.ownerId,
    epoch: message.epoch,
  };
  const verify = async () => {
    const [currentAuth, currentHost, run] = await Promise.all([
      chrome.storage.local.get("af_auth"),
      chrome.storage.session.get(MotionRunnerHostRegistry.KEY),
      MotionRunJournal.get(owner),
    ]);
    if (
      currentAuth?.af_auth?.token !== auth.token ||
      Number(currentAuth?.af_auth?.user?.id) !== host.userId ||
      currentHost?.[MotionRunnerHostRegistry.KEY]?.tabId !== host.tabId ||
      currentHost?.[MotionRunnerHostRegistry.KEY]?.windowId !== host.windowId ||
      currentHost?.[MotionRunnerHostRegistry.KEY]?.userId !== host.userId ||
      currentHost?.[MotionRunnerHostRegistry.KEY]?.epoch !== host.epoch
    )
      throw new Error("ACCOUNT_SCOPE_CHANGED");
    MotionRunJournal._owned(run, owner);
    return run;
  };
  try {
    let run = await verify();
    const workers = Object.values(await ProviderWorkerRegistry._read()).filter(
      (record) =>
        record.sourceSurface === "motion" &&
        record.userId === String(host.userId) &&
        record.toolProjectId === owner.toolProjectId &&
        (record.runId === owner.runId || message.resetTranscript === true),
    );
    const pending = [];
    for (const worker of workers) {
      run = await verify();
      if (message.resetTranscript === true && worker.runId !== owner.runId) {
        const closed2 = await ProviderWorkerRegistry.close(worker);
        if (!closed2?.success) pending.push(worker.workerId);
        continue;
      }
      const terminal =
        run.failedOperations?.[worker.attemptId] ||
        run.completedOperations?.[worker.attemptId];
      if (
        !Number.isSafeInteger(worker.epoch) ||
        worker.epoch > owner.epoch ||
        run.operations?.[worker.attemptId] ||
        !terminal ||
        (terminal.workerId && terminal.workerId !== worker.workerId)
      ) {
        pending.push(worker.workerId);
        continue;
      }
      const closed = await ProviderWorkerRegistry.close(worker);
      if (!closed?.success) pending.push(worker.workerId);
    }
    await verify();
    return { success: true, pending };
  } catch (error) {
    return {
      success: false,
      error: error?.code || error?.message || "MOTION_WORKER_RECONCILE_FAILED",
    };
  }
}
async function _motionWorkerFocus(
  message,
  sender,
  restore,
  verifyOnly = false,
) {
  let caller;
  try {
    caller = new URL(sender?.url);
  } catch (_) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const expected = new URL(chrome.runtime.getURL("motion-runner.html"));
  const host = (
    await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
  )?.[MotionRunnerHostRegistry.KEY];
  if (
    sender?.id !== chrome.runtime.id ||
    caller.protocol !== expected.protocol ||
    caller.host !== expected.host ||
    caller.pathname !== expected.pathname ||
    sender.tab?.id !== host?.tabId ||
    sender.tab?.windowId !== host?.windowId ||
    message.hostEpoch !== host?.epoch
  ) {
    return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
  }
  const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (!auth?.token || Number(auth?.user?.id) !== host.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  const worker = (await ProviderWorkerRegistry._read())[message.workerId];
  if (
    !worker ||
    worker.sourceSurface !== "motion" ||
    worker.userId !== String(host.userId) ||
    worker.tabId !== message.tabId ||
    worker.epoch !== message.epoch ||
    worker.runId !== message.runId ||
    worker.toolProjectId !== message.toolProjectId ||
    worker.attemptId !== message.attemptId
  ) {
    return { success: false, error: "MOTION_WORKER_OWNER_MISMATCH" };
  }
  if (!restore) {
    const scope = {
      userId: host.userId,
      toolProjectId: worker.toolProjectId,
      runId: worker.runId,
      epoch: worker.epoch,
      workerId: worker.workerId,
      attemptId: worker.attemptId,
    };
    const run = await MotionRunJournal.get(scope);
    let leaseActive = null;
    if (
      run?.state !== "running" ||
      !(leaseActive = await MotionRunJournal.isWorkerLeaseActive(scope))
    ) {
      console.warn(
        "[MotionWorkerFence]",
        JSON.stringify({
          stage: "focus",
          workerId: worker.workerId,
          runId: worker.runId,
          attemptId: worker.attemptId,
          runState: run?.state || null,
          leaseActive,
        }),
      );
      return { success: false, error: "MOTION_WORKER_FENCED" };
    }
  }
  if (verifyOnly) return ProviderWorkerRegistry.verify(worker);
  return restore
    ? ProviderWorkerRegistry.restoreFocus(worker)
    : ProviderWorkerRegistry.activateForSubmit(worker);
}
async function _motionWorkerBeforeSend(message, sender) {
  if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender?.tab?.id))
    return { success: false, error: "MOTION_WORKER_SENDER_INVALID" };
  const worker = await ProviderWorkerRegistry.motionWorkerForTab(sender.tab.id);
  if (!worker || worker.attemptId !== message.operationId)
    return { success: false, error: "MOTION_WORKER_OWNER_MISMATCH" };
  const scope = {
    userId: worker.userId,
    toolProjectId: worker.toolProjectId,
    runId: worker.runId,
    epoch: worker.epoch,
    workerId: worker.workerId,
    attemptId: worker.attemptId,
  };
  const initial = await chrome.storage.local.get([
    "af_auth",
    "af_system_settings",
  ]);
  const auth = initial?.af_auth;
  const timeout = Number(initial?.af_system_settings?.api_timeout_ms);
  if (!auth?.token || String(auth?.user?.id) !== worker.userId)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  if (!Number.isFinite(timeout) || timeout <= 0)
    return { success: false, error: "API_TIMEOUT_CONFIG_UNAVAILABLE" };
  const verifyOnce = async () => {
    const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
    const current = await MotionRunJournal.get(scope);
    const operation = current?.operations?.[worker.attemptId];
    const reservation = current?.reservations?.[operation?.frameId];
    const owned = await ProviderWorkerRegistry.verify(worker);
    const flowTab = await chrome.tabs.get(worker.flowTabId).catch(() => null);
    const flow = describeFlowTab(flowTab);
    const config =
      !_executionConfigCache ||
      Date.now() - _executionConfigCacheTime > _EXECUTION_CONFIG_CACHE_TTL_MS
        ? await _fetchExecutionConfig()
        : _executionConfigCache;
    const admission = await _providerWorkerAdmission(worker.provider);
    const [access, providerAccess] = await Promise.all([
      _featureAllowed("motion_tool_enabled"),
      _featureAllowed(`${worker.provider}_enabled`),
    ]);
    let leaseActive = null;
    const authorized =
      latest?.token === auth.token &&
      String(latest?.user?.id) === worker.userId &&
      current?.state === "running" &&
      (leaseActive = await MotionRunJournal.isWorkerLeaseActive(scope)) &&
      flow?.isProjectEditor === true &&
      flow.projectId === current.flowProjectId &&
      flowTab?.windowId === worker.sourceWindowId &&
      config?.parallel?.provider_web_motion_enabled === true &&
      admission?.enabled === true &&
      access.allowed &&
      providerAccess.allowed &&
      !!reservation?.token &&
      reservation.expiresAt > Date.now() &&
      reservation.lastAttemptId === worker.attemptId &&
      !reservation.pendingAttemptId;
    if (authorized && owned?.error === "WORKER_TAB_LOADING")
      return {
        workerLoading: true,
        startupMs:
          config.parallel[`provider_web_${worker.provider}_startup_timeout_ms`],
      };
    if (!authorized || !owned?.success) {
      console.warn(
        "[MotionWorkerFence]",
        JSON.stringify({
          stage: "before_send",
          workerId: worker.workerId,
          runId: worker.runId,
          attemptId: worker.attemptId,
          frameId: operation?.frameId || null,
          runState: current?.state || null,
          leaseActive,
          workerOwned: !!owned?.success,
          workerError: owned?.error || null,
          workerTabState: owned?.tabState || null,
          accountMatches:
            latest?.token === auth.token &&
            String(latest?.user?.id) === worker.userId,
          flowMatches:
            flow?.isProjectEditor === true &&
            flow.projectId === current?.flowProjectId &&
            flowTab?.windowId === worker.sourceWindowId,
          motionEnabled: config?.parallel?.provider_web_motion_enabled === true,
          providerAdmitted: admission?.enabled === true,
          motionAllowed: !!access?.allowed,
          providerAllowed: !!providerAccess?.allowed,
          reservationPresent: !!reservation?.token,
          reservationExpired: reservation?.expiresAt <= Date.now(),
          intentMatches:
            reservation?.lastAttemptId === worker.attemptId &&
            !reservation?.pendingAttemptId,
        }),
      );
      throw new Error("MOTION_WORKER_FENCED");
    }
    return reservation;
  };
  let loadingDeadline = null;
  let loadingStarted = null,
    announcedReady = false;
  const verify = async () => {
    for (;;) {
      const result = await verifyOnce();
      if (!result?.workerLoading) {
        if (loadingStarted !== null && !announcedReady) {
          announcedReady = true;
          console.info(
            "[MotionWorkerReadiness]",
            JSON.stringify({
              runId: worker.runId,
              attemptId: worker.attemptId,
              workerId: worker.workerId,
              stage: "before_send",
              state: "ready",
              elapsedMs: Date.now() - loadingStarted,
            }),
          );
        }
        return result;
      }
      if (loadingDeadline === null) {
        if (
          !Number.isSafeInteger(result.startupMs) ||
          result.startupMs < 1e4 ||
          result.startupMs > 12e4
        )
          throw new Error("PROVIDER_WORKER_CONFIG_INVALID");
        loadingStarted = Date.now();
        loadingDeadline = loadingStarted + result.startupMs;
        console.info(
          "[MotionWorkerReadiness]",
          JSON.stringify({
            runId: worker.runId,
            attemptId: worker.attemptId,
            workerId: worker.workerId,
            stage: "before_send",
            state: "waiting",
            waitForEditorMs: result.startupMs,
          }),
        );
      }
      if (Date.now() >= loadingDeadline) {
        console.warn(
          "[MotionWorkerReadiness]",
          JSON.stringify({
            runId: worker.runId,
            attemptId: worker.attemptId,
            workerId: worker.workerId,
            stage: "before_send",
            state: "failed",
            code: "WORKER_TAB_LOADING",
            elapsedMs: Date.now() - loadingStarted,
          }),
        );
        throw new Error("WORKER_TAB_LOADING");
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  try {
    const reservation = await verify();
    const body = JSON.stringify({
      run_id: reservation.reservationId,
      token: reservation.token,
      item_id: `${reservation.reservationId}:0`,
      attempt_id: worker.attemptId,
      prompt_index: 0,
      request_nonce: crypto.randomUUID(),
    });
    const controller = new AbortController();
    let timer;
    let response, receipt;
    try {
      ({ response, receipt } = await Promise.race([
        (async () => {
          const result = await _signedFetch(
            `${getApiBaseUrl()}/execution/provider-web/intent`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${auth.token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "X-Extension-Id": chrome.runtime.id,
              },
              body,
              cache: "no-store",
              signal: controller.signal,
            },
          );
          return { response: result, receipt: await result.json() };
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("MOTION_INTENT_TIMEOUT"));
          }, timeout);
        }),
      ]));
    } finally {
      clearTimeout(timer);
    }
    if (
      !response.ok ||
      receipt?.success !== true ||
      receipt?.data?.status !== "dispatch_intent"
    )
      throw new Error(receipt?.error?.code || "MOTION_INTENT_DENIED");
    if (receipt.data.dispatch_allowed !== true)
      throw new Error("MOTION_DISPATCH_NOT_ALLOWED");
    await verify();
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error?.message || "MOTION_WORKER_SEND_FAILED",
    };
  }
}
async function _reconcileClosedMotionWorker(record) {
  if (record?.sourceSurface !== "motion") return false;
  if (
    !Number.isSafeInteger(Number(record.userId)) ||
    Number(record.userId) < 1 ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 1 ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(record.toolProjectId || ""),
    ) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(record.runId || ""),
    ) ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(record.attemptId || ""),
    ) ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(String(record.workerId || ""))
  )
    throw new Error("MOTION_WORKER_IDENTITY_INVALID");
  const marked = await MotionRunJournal.failClosedWorker({
    userId: record.userId,
    toolProjectId: record.toolProjectId,
    runId: record.runId,
    epoch: record.epoch,
    workerId: record.workerId,
    attemptId: record.attemptId,
  });
  if (marked) return true;
  const run = await MotionRunJournal.get({
    userId: record.userId,
    toolProjectId: record.toolProjectId,
  });
  const terminal =
    run?.failedOperations?.[record.attemptId] ||
    run?.completedOperations?.[record.attemptId];
  if (
    run?.runId === record.runId &&
    !run.operations?.[record.attemptId] &&
    terminal &&
    (!terminal.workerId || terminal.workerId === record.workerId)
  )
    return true;
  throw new Error("MOTION_WORKER_CLOSE_UNRECONCILED");
}
async function _motionFlushOutbox({ userId, toolProjectId, flowProjectId }) {
  const initial = await chrome.storage.local.get([
    "af_auth",
    "af_system_settings",
  ]);
  const auth = initial?.af_auth;
  const timeout = Number(initial?.af_system_settings?.api_timeout_ms);
  if (
    !auth?.token ||
    Number(auth.user?.id) !== Number(userId) ||
    !Number.isFinite(timeout) ||
    timeout <= 0
  )
    throw new Error("MOTION_OUTBOX_SCOPE_INVALID");
  const assertScope = async () => {
    const current = (await chrome.storage.local.get("af_auth"))?.af_auth;
    if (current?.token !== auth.token || Number(current?.user?.id) !== userId)
      throw new Error("ACCOUNT_SCOPE_CHANGED");
  };
  const api = async (method, path, body) => {
    await assertScope();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await _signedFetch(`${getApiBaseUrl()}/${path}`, {
        method,
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "X-Extension-Id": chrome.runtime.id,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const payload = await response.json();
      await assertScope();
      if (!response.ok || payload?.success !== true)
        throw Object.assign(
          new Error(payload?.error?.code || "MOTION_OUTBOX_DELIVERY_FAILED"),
          { httpStatus: response.status },
        );
      return payload.data;
    } finally {
      clearTimeout(timer);
    }
  };
  return MotionTranscriptOutbox.flush({
    userId,
    toolProjectId,
    flowProjectId,
    api,
    assertScope,
  });
}
async function _motionHostClosed(tabId) {
  if (!Number.isInteger(tabId)) return;
  const candidates = Object.values(await ProviderWorkerRegistry._read()).filter(
    (record) =>
      record.sourceSurface === "motion" &&
      record.hostTabId === tabId &&
      Number.isSafeInteger(record.hostEpoch),
  );
  if (!candidates.length) return;
  const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
  const userId = Number(auth?.user?.id);
  if (!auth?.token || !Number.isSafeInteger(userId) || userId < 1) return;
  const assertScope = async () => {
    const current = (await chrome.storage.local.get("af_auth"))?.af_auth;
    if (current?.token !== auth.token || Number(current?.user?.id) !== userId)
      throw new Error("ACCOUNT_SCOPE_CHANGED");
  };
  const records = candidates.filter(
    (record) => record.userId === String(userId),
  );
  const projects = new Map();
  for (const record of records) {
    try {
      await assertScope();
      await _reconcileClosedMotionWorker(record);
      const run = await MotionRunJournal.get({
        userId,
        toolProjectId: record.toolProjectId,
      });
      const terminal =
        run?.failedOperations?.[record.attemptId] ||
        run?.completedOperations?.[record.attemptId];
      if (
        run?.runId !== record.runId ||
        run?.epoch !== record.epoch ||
        run.operations?.[record.attemptId] ||
        !terminal ||
        (terminal.workerId && terminal.workerId !== record.workerId)
      )
        continue;
      await assertScope();
      projects.set(record.toolProjectId, run.flowProjectId);
      const closed = await ProviderWorkerRegistry.close(record);
      if (!closed?.success)
        console.warn("[MotionHostClosed] worker close pending", {
          workerId: record.workerId,
          code: closed?.error,
        });
    } catch (error) {
      console.warn("[MotionHostClosed] worker reconcile pending", {
        workerId: record.workerId,
        code: error?.code || error?.message,
      });
    }
  }
  for (const [toolProjectId, flowProjectId] of projects) {
    try {
      await _motionFlushOutbox({ userId, toolProjectId, flowProjectId });
    } catch (error) {
      console.warn("[MotionHostClosed] transcript delivery pending", {
        toolProjectId,
        code: error?.code || error?.message,
      });
    }
  }
}
async function _motionFlushClosedScopes(scopes) {
  for (const scope of scopes || []) {
    try {
      const run = await MotionRunJournal.get({
        userId: scope.userId,
        toolProjectId: scope.toolProjectId,
      });
      if (run?.runId === scope.runId && run.flowProjectId)
        await _motionFlushOutbox({
          userId: Number(scope.userId),
          toolProjectId: scope.toolProjectId,
          flowProjectId: run.flowProjectId,
        });
    } catch (error) {
      console.warn("[MotionWorker] transcript delivery pending", {
        code: error?.code || error?.message,
      });
    }
  }
}
const _MOTION_RECOVERY_ALARM = "motionRunnerRecovery";
async function _scheduleMotionRecovery(delayMs = 1e3) {
  await chrome.alarms.create(_MOTION_RECOVERY_ALARM, {
    when: Date.now() + delayMs,
  });
}
async function _motionWakeRecovery() {
  const values = await chrome.storage.local.get([
    "af_auth",
    "af_system_settings",
    MotionRunnerRecovery.KEY,
  ]);
  const auth = values.af_auth,
    userId = Number(auth?.user?.id);
  if (!auth?.token || !Number.isSafeInteger(userId) || userId < 1) return;
  const timeoutMs = Number(values.af_system_settings?.api_timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
  const assertScope = async () => {
    const current = (await chrome.storage.local.get("af_auth"))?.af_auth;
    if (current?.token !== auth.token || Number(current?.user?.id) !== userId)
      throw new Error("ACCOUNT_SCOPE_CHANGED");
  };
  const orphans = await ProviderWorkerRegistry.recoverMotionCreations(
    userId,
    _reconcileClosedMotionWorker,
    async (intent) => {
      await assertScope();
      const run = await MotionRunJournal.get({
        userId,
        toolProjectId: intent.toolProjectId,
      });
      if (run?.runId !== intent.runId) return false;
      if (!run.operations?.[intent.attemptId]) return true;
      if (!run.ownerId || run.leaseUntil <= Date.now()) return true;
      const host = (
        await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
      )?.[MotionRunnerHostRegistry.KEY];
      if (
        host?.userId !== userId ||
        host.tabId !== intent.hostTabId ||
        host.epoch !== intent.hostEpoch ||
        !(await MotionRunnerHostRegistry._verify(host))
      )
        return true;
      const alive = await MotionRunnerHostRegistry._sendBounded(
        {
          action: "motionRunner:recoveryState",
          tabId: host.tabId,
          epoch: host.epoch,
        },
        timeoutMs,
      );
      await assertScope();
      return !(
        alive?.success &&
        alive.epoch === host.epoch &&
        alive.projects?.some(
          (item) =>
            item.projectId === intent.toolProjectId &&
            item.runId === intent.runId,
        )
      );
    },
  );
  await assertScope();
  await _motionFlushClosedScopes(orphans.closedScopes);
  if (
    !Object.values(values[MotionRunnerRecovery.KEY] || {}).some(
      (item) => item.userId === userId,
    )
  ) {
    if (orphans.pending) await _scheduleMotionRecovery(3e4);
    return;
  }
  const outcome = await MotionRunnerRecovery.recover({
    userId,
    assertScope,
    inspect: async (item) => {
      const host = (
        await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
      )?.[MotionRunnerHostRegistry.KEY];
      let alive = null;
      if (
        host?.userId === userId &&
        (await MotionRunnerHostRegistry._verify(host))
      )
        alive = await MotionRunnerHostRegistry._sendBounded(
          {
            action: "motionRunner:recoveryState",
            tabId: host.tabId,
            epoch: host.epoch,
          },
          timeoutMs,
        );
      if (
        alive?.success &&
        alive.epoch === host.epoch &&
        (item.batchId
          ? alive.batchId === item.batchId
          : alive.projects?.some(
              (project) =>
                project.projectId === item.projectId &&
                project.runId === item.runId,
            ))
      )
        return { alive: true };
      const unresponsive =
        !!host &&
        host.userId === userId &&
        !alive?.success &&
        (await MotionRunnerHostRegistry._verify(host));
      if (
        unresponsive &&
        (await MotionRunJournal.listForUser(userId)).some(
          (run2) => run2.ownerId && run2.leaseUntil > Date.now(),
        )
      )
        return { leaseActive: true };
      if (item.batchId) {
        const keys = [
          `motion_batch:${userId}:${item.batchId}`,
          `motion_batch_pause:${userId}:${item.batchId}`,
          `motion_batch_stop:${userId}:${item.batchId}`,
        ];
        const stored = await chrome.storage.local.get(keys),
          batch = stored[keys[0]];
        if (
          batch &&
          (batch.userId !== userId ||
            batch.flowProjectId !== item.flowProjectId)
        )
          throw new Error("MOTION_BATCH_SCOPE_MISMATCH");
        if (batch && ["ready", "stopped"].includes(batch.state))
          return { terminal: true };
        const current = batch?.items?.find(
          (project) => project.state === "running",
        );
        const run2 = current
          ? await MotionRunJournal.get({
              userId,
              toolProjectId: current.projectId,
            })
          : null;
        return {
          leaseActive: !!run2?.ownerId && run2.leaseUntil > Date.now(),
          unresponsive,
          drainOnly: !!stored[keys[1]] || !!stored[keys[2]],
        };
      }
      const run = await MotionRunJournal.get({
        userId,
        toolProjectId: item.projectId,
      });
      if (
        run &&
        (run.runId !== item.runId || run.flowProjectId !== item.flowProjectId)
      )
        return { terminal: true };
      return {
        leaseActive: !!run?.ownerId && run.leaseUntil > Date.now(),
        drainOnly: !!run?.stopOrigin,
        unresponsive,
      };
    },
    restart: async (item, { drainOnly, unresponsive }) => {
      await assertScope();
      if (unresponsive) {
        const oldHost = (
          await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
        )?.[MotionRunnerHostRegistry.KEY];
        if (oldHost?.userId !== userId)
          throw new Error("MOTION_RUNNER_ACCOUNT_CHANGED");
        await _motionHostClosed(oldHost.tabId);
        await assertScope();
        await MotionRunnerHostRegistry.reloadUnresponsive(
          oldHost,
          timeoutMs,
          assertScope,
        );
      }
      const host = await _motionRunnerEnsureCore(item);
      if (!host?.success)
        throw new Error(host?.error || "MOTION_RUNNER_NOT_READY");
      await assertScope();
      const batchKey = item.batchId
        ? `motion_batch:${userId}:${item.batchId}`
        : null;
      const savedBatch = batchKey
        ? (await chrome.storage.local.get(batchKey))?.[batchKey]
        : null;
      await assertScope();
      const response = await chrome.runtime.sendMessage({
        action: item.batchId
          ? savedBatch
            ? "motionRunner:resumeBatchHost"
            : "motionRunner:startBatchHost"
          : "motionRunner:startProject",
        tabId: host.tabId,
        epoch: host.epoch,
        projectId: item.projectId,
        flowProjectId: item.flowProjectId,
        runId: item.runId,
        ...(item.batchId && { batchId: item.batchId }),
        screen: item.screen,
        automaticRecovery: true,
        drainOnly,
      });
      if (!response?.success)
        throw new Error(response?.error || "MOTION_RUNNER_RECOVERY_FAILED");
    },
    onExhausted: async (item) => {
      const projects = item.batchId
        ? (
            await chrome.storage.local.get(
              `motion_batch:${userId}:${item.batchId}`,
            )
          )?.[`motion_batch:${userId}:${item.batchId}`]?.items || []
        : [{ projectId: item.projectId, runId: item.runId }];
      const workers = Object.values(await ProviderWorkerRegistry._read());
      const creations = Object.values(
        (
          await chrome.storage.session.get(
            ProviderWorkerRegistry.MOTION_CREATION_KEY,
          )
        )?.[ProviderWorkerRegistry.MOTION_CREATION_KEY] || {},
      );
      for (const project of projects) {
        const run = await MotionRunJournal.get({
          userId,
          toolProjectId: project.projectId,
        });
        const windowId = run?.preparationSnapshot?.layout?.sourceWindowId;
        if (
          run?.runId !== project.runId ||
          !Number.isInteger(windowId) ||
          [...workers, ...creations].some(
            (worker) =>
              worker.userId === String(userId) && worker.runId === run.runId,
          )
        )
          continue;
        await assertScope();
        await ProviderWorkerRegistry.restoreMainLayout({
          windowId,
          runId: run.runId,
        });
      }
      const status = {
        userId,
        projectId: item.projectId,
        flowProjectId: item.flowProjectId,
        runId: item.runId,
        epoch: item.hostEpoch,
        state: "needs_review",
        error: "MOTION_RUNNER_RECOVERY_EXHAUSTED",
        nonce: crypto.randomUUID(),
      };
      await assertScope();
      await chrome.storage.local.set(
        item.batchId
          ? { motion_batch_status: { ...status, batchId: item.batchId } }
          : {
              motion_runner_status: status,
              [`motion_runner_status:${userId}:${item.projectId}`]: status,
            },
      );
    },
  });
  if (outcome?.pending) await _scheduleMotionRecovery(3e4);
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === _MOTION_RECOVERY_ALARM)
    _motionWakeRecovery().catch((error) => {
      console.warn("[MotionRunnerRecovery]", {
        code: error?.code || error?.message,
      });
      _scheduleMotionRecovery(3e4).catch(() => {});
    });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (
    (area === "local" &&
      (changes[MotionRunnerRecovery.KEY] || changes.af_auth)) ||
    (area === "session" && changes[ProviderWorkerRegistry.MOTION_CREATION_KEY])
  )
    _scheduleMotionRecovery().catch(() => {});
});
_scheduleMotionRecovery().catch(() => {});
chrome.tabs.onRemoved.addListener((tabId) => {
  ProviderWorkerRegistry.handleMotionTabRemoved(
    tabId,
    _reconcileClosedMotionWorker,
  )
    .then(async (result) => {
      if (result.pending)
        console.warn("[MotionWorker] close reconciliation pending", {
          tabId,
          count: result.pending,
        });
      await _motionFlushClosedScopes(result.closedScopes);
    })
    .catch((error) =>
      console.warn("[MotionWorker] close reconciliation failed", {
        tabId,
        code: error?.message,
      }),
    );
  _motionHostClosed(tabId).catch((error) =>
    console.warn("[MotionHostClosed] reconciliation failed", {
      code: error?.message,
    }),
  );
  chrome.storage.session
    .get(MotionRunnerHostRegistry.KEY)
    .then((data) => {
      if (data?.[MotionRunnerHostRegistry.KEY]?.tabId === tabId)
        return _scheduleMotionRecovery();
    })
    .catch(() => {});
});
chrome.alarms.clear("flowSessionRefresh");
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.af_execution_config) {
    const next = changes.af_execution_config.newValue;
    _executionConfigCache = _isValidExecutionConfig(next) ? next : null;
    _executionConfigCacheTime = _executionConfigCache ? Date.now() : 0;
  }
});
const _ZOOM_GUARD_KEY = "af_zoom_guard";
const _ZOOM_GUARD_STALE_MS = 24e4;
const _ZOOM_GUARD_MAX_AGE_MS = 24 * 3600 * 1e3;
function _originOf(url) {
  try {
    return url ? new URL(url).origin : null;
  } catch (_) {
    return null;
  }
}
async function _zoomGuardReadAll() {
  try {
    return (
      (await chrome.storage.local.get(_ZOOM_GUARD_KEY))[_ZOOM_GUARD_KEY] || {}
    );
  } catch (_) {
    return {};
  }
}
async function _zoomGuardWriteAll(all) {
  try {
    if (all && Object.keys(all).length)
      await chrome.storage.local.set({ [_ZOOM_GUARD_KEY]: all });
    else await chrome.storage.local.remove(_ZOOM_GUARD_KEY);
  } catch (_) {}
}
async function _zoomGuardDrop(tabId) {
  const all = await _zoomGuardReadAll();
  if (all[tabId]) {
    delete all[tabId];
    await _zoomGuardWriteAll(all);
  }
}
async function _zoomGuardRestore(g) {
  const target =
    typeof g.original === "number" && g.original > 0 && g.original !== g.factor
      ? g.original
      : 1;
  try {
    await chrome.tabs.setZoom(g.tabId, target);
  } catch (_) {}
  await _zoomGuardDrop(g.tabId);
  try {
    await chrome.tabs.sendMessage(g.tabId, { action: "zoomGuard:revoked" });
  } catch (_) {}
  console.log(`[TobyFlow] zoom guard: restore tab ${g.tabId} \u2192 ${target}`);
  return target;
}
async function _zoomGuardWatchdog() {
  const all = await _zoomGuardReadAll();
  for (const key of Object.keys(all)) {
    const g = all[key];
    if (!g) {
      await _zoomGuardDrop(key);
      continue;
    }
    if (Date.now() - (g.ts || 0) < _ZOOM_GUARD_STALE_MS) continue;
    let alive = true;
    try {
      await chrome.tabs.get(g.tabId);
    } catch (_) {
      alive = false;
    }
    if (!alive) {
      await _zoomGuardDrop(key);
      continue;
    }
    console.warn(
      `[TobyFlow] zoom guard: kh\xF4ng th\u1EA5y heartbeat ${Math.round((Date.now() - (g.ts || 0)) / 1e3)}s \u2192 c\u1EE9u zoom tab ${g.tabId}`,
    );
    await _zoomGuardRestore(g);
  }
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (await LegacyProviderResultWake.onAlarm(alarm)) return;
  if (alarm.name === "swKeepAlive") {
    _zoomGuardWatchdog().catch(() => {});
    _pruneExpiredFlowRecoveryJournal().catch(() => {});
    _pruneExpiredTrackerHistory().catch(() => {});
    return;
  }
});
const TOBYFLOW_CONTENT_SCHEMA = 151;
const TOBYFLOW_CONTENT_REVISION = `flow-content-${chrome.runtime.getManifest().version}-r${TOBYFLOW_CONTENT_SCHEMA}`;
const _flowObserverEnsurePending = new Map();
const FLOW_CORRELATION_OBSERVER_REVISION = 52;
function ensureFlowCorrelationObserver(tabId) {
  if (_flowObserverEnsurePending.has(tabId))
    return _flowObserverEnsurePending.get(tabId);
  let observerCheckStage = "tab_lookup";
  const pending = (async () => {
    const tab = await chrome.tabs.get(tabId);
    const url = new URL(tab.url || "");
    const routeParts = url.pathname.split("/").filter(Boolean);
    const projectAt = routeParts.indexOf("project");
    if (
      url.origin !== "https://flow.google.com" ||
      projectAt < 0 ||
      !routeParts[projectAt + 1]
    ) {
      return { success: false, error: "FLOW_V2_REQUIRED" };
    }
    const probe = async () => {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          const observer = window.__tobyFlowV2CorrelationObserver;
          if (!observer) return { missing: true };
          const health2 = observer.health?.();
          return health2 || { ready: false, updateRequired: true };
        },
      });
      return results?.[0]?.result || {};
    };
    observerCheckStage = "health_probe";
    let health = await probe();
    const needsRepair = (current) =>
      current.missing ||
      current.observerRevision !== FLOW_CORRELATION_OBSERVER_REVISION ||
      current.structuredPromptVersion !== 2 ||
      current.ready !== true ||
      current.xhrHookActive !== true ||
      current.fetchHookActive !== true;
    if (
      health.observerRevision === FLOW_CORRELATION_OBSERVER_REVISION &&
      health.xhrHookActive === true &&
      health.fetchHookActive === true &&
      health.transportState &&
      health.transportState !== "ready"
    ) {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: () => {
          window.dispatchEvent(
            new CustomEvent("TOBY_FLOW_OBSERVER_TRANSPORT_READ"),
          );
        },
      });
      health = await probe();
      if (health.transportState !== "ready")
        return {
          success: false,
          error: "CONFIG_REQUIRED:flow_v2_observer_transport",
          observerCheckStage: "transport_config",
          activeAttempts: Math.max(0, Number(health.activeAttempts) || 0),
          ready: false,
        };
    }
    if (
      needsRepair(health) &&
      Math.max(0, Number(health.activeAttempts) || 0) === 0
    ) {
      observerCheckStage = "repair_inject";
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: ["flow-v2-correlation-observer.js"],
      });
      observerCheckStage = "repair_probe";
      health = await probe();
    }
    return !needsRepair(health)
      ? {
          success: true,
          observerRevision: health.observerRevision,
          activeAttempts: Math.max(0, Number(health.activeAttempts) || 0),
          ready: health.ready === true,
          xhrHookActive: health.xhrHookActive,
          fetchHookActive: health.fetchHookActive,
          observerCheckStage,
        }
      : {
          success: false,
          error:
            health.observerRevision !== FLOW_CORRELATION_OBSERVER_REVISION ||
            health.structuredPromptVersion !== 2
              ? "FLOW_RECOVERY_OBSERVER_UPDATE_REQUIRED"
              : "FLOW_RECOVERY_OBSERVER_UNAVAILABLE",
          observerRevision: health.observerRevision ?? null,
          activeAttempts: Math.max(0, Number(health.activeAttempts) || 0),
          ready: health.ready === true,
          xhrHookActive: health.xhrHookActive === true,
          fetchHookActive: health.fetchHookActive === true,
          observerCheckStage,
        };
  })()
    .catch((error) => {
      console.warn(
        "[FlowV2CorrelationObserver] preflight failed:",
        error?.message || error,
      );
      return {
        success: false,
        error: "FLOW_RECOVERY_OBSERVER_UNAVAILABLE",
        observerCheckStage,
      };
    })
    .finally(() => _flowObserverEnsurePending.delete(tabId));
  _flowObserverEnsurePending.set(tabId, pending);
  return pending;
}
function _autoInjectContentScripts() {
  chrome.tabs.query({ url: getFlowTabQueryPatterns() }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { action: "ping" }, async (response) => {
        const noLiveContent =
          !!chrome.runtime.lastError || !response?.pong || !response?.driverKey;
        const staleContent =
          !noLiveContent &&
          response.contentRevision !== TOBYFLOW_CONTENT_REVISION;
        const liveTab = await chrome.tabs.get(tab.id).catch(() => null);
        if (!isFlowUrl(liveTab?.url)) return;
        if (staleContent) {
          console.warn(
            "[TobyFlow] content.js revision stale; waiting for manual Flow refresh",
            {
              tabId: tab.id,
              expected: TOBYFLOW_CONTENT_REVISION,
              actual: response.contentRevision || null,
            },
          );
        } else if (noLiveContent) {
          if (describeFlowTab(tab)?.projectId)
            ensureFlowCorrelationObserver(tab.id);
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              files: FLOW_CONTENT_SCRIPT_FILES,
            })
            .catch((err) =>
              console.warn(
                "[TobyFlow] Auto-inject failed for tab",
                tab.id,
                err.message,
              ),
            );
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              files: ["media-interceptor.js"],
              world: "MAIN",
            })
            .catch((err) =>
              console.warn(
                "[TobyFlow] Auto-inject media-interceptor failed for tab",
                tab.id,
                err.message,
              ),
            );
          chrome.scripting
            .executeScript({
              target: { tabId: tab.id },
              files: ["slate-bridge.js"],
              world: "MAIN",
            })
            .catch((err) =>
              console.warn(
                "[TobyFlow] Auto-inject slate-bridge failed for tab",
                tab.id,
                err.message,
              ),
            );
        } else {
          console.log(
            "[TobyFlow] content.js \u0111\xE3 active trong tab",
            tab.id,
            "\u2192 skip auto-inject",
          );
        }
      });
    }
  });
}
function _injectRefBridgeIntoExistingLabsTabs() {
  chrome.tabs.query(
    { url: ["https://local.566flow.invalid/*", "https://566flow.invalid/*"] },
    (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.scripting
          .executeScript({
            target: { tabId: tab.id },
            files: ["ref-bridge.js"],
          })
          .catch((err) =>
            console.warn(
              "[TobyFlow] ref bridge injection failed for tab",
              tab.id,
              err.message,
            ),
          );
      }
    },
  );
}
if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) =>
      console.warn("[TobyFlow] sidePanel setPanelBehavior error:", err),
    );
  chrome.sidePanel
    .setOptions({ path: "sidebar.html", enabled: true })
    .catch((err) =>
      console.warn("[TobyFlow] sidePanel setOptions error:", err),
    );
  const _lastNotifiedProjectByTab = new Map();
  chrome.tabs.onRemoved.addListener((tabId) => {
    _lastNotifiedProjectByTab.delete(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (!tab.url) return;
    if (isFlowOriginUrl(tab.url)) {
      if (info.status === "complete" || info.url) {
        const flowContext = describeFlowTab(tab);
        const projectId = flowContext?.projectId || null;
        const _projKey = `${flowContext ? "supported" : "invalid"}|${flowContext?.routePrefix || ""}|${projectId || ""}`;
        if (_lastNotifiedProjectByTab.get(tabId) === _projKey) return;
        _lastNotifiedProjectByTab.set(tabId, _projKey);
        chrome.runtime
          .sendMessage({
            action: "projectContext",
            projectId,
            projectName: null,
            projectError: !flowContext,
            invalidFlowRoute: !flowContext,
            tabId,
            fromTabUpdate: true,
          })
          .catch(() => {});
        if (!flowContext) {
          chrome.storage.session
            .get(["targetFlowTabId"])
            .then((stored) => {
              if (stored?.targetFlowTabId === tabId) {
                return chrome.storage.session.remove([
                  "targetFlowTabId",
                  "targetFlowContext",
                ]);
              }
            })
            .catch(() => {});
        }
        if (projectId) {
          setTimeout(() => {
            chrome.tabs.sendMessage(
              tabId,
              { action: "getProjectContext" },
              (resp) => {
                if (chrome.runtime.lastError || !resp?.projectId) return;
                chrome.runtime
                  .sendMessage({
                    action: "projectContext",
                    projectId: resp.projectId,
                    projectName: resp.projectName,
                    tabId,
                    projectError: resp.projectError === true,
                  })
                  .catch(() => {});
              },
            );
          }, 500);
        }
      }
    }
  });
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
      const tab = await chrome.tabs.get(activeInfo.tabId);
      if (isFlowOriginUrl(tab.url)) {
        chrome.runtime
          .sendMessage({
            action: "flowTabActivated",
            tabId: activeInfo.tabId,
            url: tab.url,
            invalidFlowRoute: !isFlowUrl(tab.url),
          })
          .catch(() => {});
      }
    } catch (e) {}
  });
}
async function openSettingsWindow(tab = null) {
  if (_settingsWindowOpening) return;
  const hashSuffix = tab ? `#${tab}` : "";
  if (settingsWindowId !== null) {
    try {
      const win = await chrome.windows.get(settingsWindowId, {
        populate: true,
      });
      if (win) {
        if (tab && win.tabs?.[0]) {
          if (["flow-api", "muse-mode", "max-speed"].includes(tab))
            chrome.runtime
              .sendMessage({
                action: "settings:focusSection",
                targetTabId: win.tabs[0].id,
                section: tab,
              })
              .catch(() => {});
          else
            chrome.tabs.update(win.tabs[0].id, {
              url: chrome.runtime.getURL("settings.html" + hashSuffix),
            });
        }
        chrome.windows.update(settingsWindowId, { focused: true });
        return;
      }
    } catch (e) {
      settingsWindowId = null;
      _persistWindowIds();
    }
  }
  if (settingsWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(["_settingsWindowId"]);
      if (stored?._settingsWindowId) {
        const win = await chrome.windows.get(stored._settingsWindowId, {
          populate: true,
        });
        if (win) {
          settingsWindowId = stored._settingsWindowId;
          _extensionPopupWindows.add(settingsWindowId);
          if (tab && win.tabs?.[0]) {
            if (["flow-api", "muse-mode", "max-speed"].includes(tab))
              chrome.runtime
                .sendMessage({
                  action: "settings:focusSection",
                  targetTabId: win.tabs[0].id,
                  section: tab,
                })
                .catch(() => {});
            else
              chrome.tabs.update(win.tabs[0].id, {
                url: chrome.runtime.getURL("settings.html" + hashSuffix),
              });
          }
          chrome.windows.update(settingsWindowId, { focused: true });
          return;
        }
      }
    } catch (e) {}
  }
  _settingsWindowOpening = true;
  try {
    const pos = await _calcWindowPosition(580, 850);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("settings.html" + hashSuffix),
      type: "popup",
      width: 580,
      height: 850,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    settingsWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _settingsWindowOpening = false;
  }
}
async function _isFlowProjectReadyBg() {
  try {
    const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
    if (!tabs.length) return false;
    const activeTab = await selectFlowStatusTab(tabs);
    if (!activeTab) return false;
    if (!describeFlowTab(activeTab)?.projectId) return false;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        console.warn(
          "[Background] workflow editor project re-gate timed out; using project URL",
        );
        finish(true);
      }, 4e3);
      try {
        chrome.tabs.sendMessage(
          activeTab.id,
          { action: "getProjectContext" },
          (resp) => {
            if (chrome.runtime.lastError || !resp) return finish(true);
            const context = buildFlowProjectContext(activeTab, resp);
            finish(context.projectError !== true && !!context.projectId);
          },
        );
      } catch (_) {
        finish(true);
      }
    });
  } catch (_) {
    return true;
  }
}
let _motionEditorWindowTail = Promise.resolve();
function motionStudioTabUrl(tab) {
  const base = chrome.runtime.getURL("motion-editor.html");
  for (const value of [tab?.pendingUrl, tab?.url]) {
    try {
      const url = new URL(value),
        expected = new URL(base);
      if (
        url.protocol === expected.protocol &&
        url.host === expected.host &&
        url.pathname === expected.pathname
      )
        return url;
    } catch (_) {}
  }
  return null;
}
function openMotionStudioWindow(id, options = {}) {
  const opening = _motionEditorWindowTail.then(async () => {
    const previous = (await chrome.tabs.query({})).filter((tab) =>
      motionStudioTabUrl(tab),
    );
    const { width, height } = await _getEditorWindowSize();
    const pos = await _calcWindowPosition(width, height);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(
        `motion-editor.html?project=${encodeURIComponent(id)}${options.newlyCreated === true ? "&new=1" : ""}`,
      ),
      type: "popup",
      width,
      height,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    if (!Number.isInteger(win?.id))
      throw new Error("MOTION_EDITOR_OPEN_FAILED");
    _extensionPopupWindows.add(win.id);
    let closeFailed = false;
    for (const old of previous) {
      const current = await chrome.tabs.get(old.id).catch(() => null);
      if (
        !current ||
        current.windowId === win.id ||
        !motionStudioTabUrl(current)
      )
        continue;
      try {
        await chrome.tabs.remove(old.id);
      } catch (_) {
        const remaining = await chrome.tabs.get(old.id).catch(() => null);
        if (remaining && motionStudioTabUrl(remaining)) closeFailed = true;
      }
    }
    if (closeFailed)
      console.warn("[MotionEditorWindow]", {
        stage: "replace_previous",
        code: "MOTION_EDITOR_PREVIOUS_CLOSE_FAILED",
      });
    return {
      ok: true,
      ...(closeFailed && { warning: "MOTION_EDITOR_PREVIOUS_CLOSE_FAILED" }),
    };
  });
  _motionEditorWindowTail = opening.catch(() => {});
  return opening;
}
let _workflowWindowOpenPromise = null;
async function _notifyFlowTrackerWorkflowVisibility(open, workflowData = null) {
  try {
    if (open) {
      await chrome.storage.local.remove("af_flow_api_auto_open_tracker_grid");
    }
    const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
    const projectId =
      workflowData?.workflow?.project_id ||
      workflowData?.workflow?.projectId ||
      null;
    const matching = projectId
      ? tabs.filter((tab2) => describeFlowTab(tab2)?.projectId === projectId)
      : tabs;
    const tab = await selectFlowStatusTab(matching.length ? matching : tabs);
    if (!tab?.id) return;
    chrome.tabs.sendMessage(
      tab.id,
      {
        action: "workflowEditorVisibility",
        open: open === true,
        _flowTarget: describeFlowTab(tab),
      },
      () => {
        void chrome.runtime.lastError;
      },
    );
  } catch (_) {}
}
async function _getEditorWindowSize() {
  let width = 1440,
    height = 900;
  try {
    const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
    if (tabs[0]?.windowId) {
      const win = await chrome.windows.get(tabs[0].windowId);
      if (win?.width && win?.height) {
        width = Math.max(width, Math.round(win.width * 0.9));
        height = Math.max(height, Math.round(win.height * 0.9));
      }
    }
  } catch (error) {
    console.warn(
      "[Background] Editor window size unavailable:",
      error?.message,
    );
  }
  return { width, height };
}
async function openWorkflowWindow(workflowData) {
  if (_workflowWindowOpenPromise) {
    console.log("[Background] openWorkflowWindow joined in-flight open");
    return _workflowWindowOpenPromise;
  }
  const opening = _openWorkflowWindowOnce(workflowData);
  _workflowWindowOpenPromise = opening;
  try {
    return await opening;
  } finally {
    if (_workflowWindowOpenPromise === opening)
      _workflowWindowOpenPromise = null;
  }
}
async function _openWorkflowWindowOnce(workflowData) {
  console.log(
    "[Background] openWorkflowWindow called, workflowWindowId:",
    workflowWindowId,
  );
  await _notifyFlowTrackerWorkflowVisibility(true, workflowData);
  editingWorkflowId = workflowData?.workflow?.wf_id || null;
  _persistWindowIds();
  if (workflowWindowId !== null) {
    try {
      const win = await chrome.windows.get(workflowWindowId);
      if (win) {
        chrome.windows.update(workflowWindowId, { focused: true });
        if (workflowData) {
          chrome.runtime.sendMessage({
            action: "loadWorkflowInEditor",
            data: workflowData,
          });
        }
        editingWorkflowId = workflowData?.workflow?.wf_id || null;
        _persistWindowIds();
        return true;
      }
    } catch (e) {
      console.log(
        "[Background] openWorkflowWindow - window.get failed, clearing workflowWindowId",
      );
      workflowWindowId = null;
      _persistWindowIds();
    }
  }
  if (workflowWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(["_workflowWindowId"]);
      console.log(
        "[Background] openWorkflowWindow - session storage check:",
        stored?._workflowWindowId,
      );
      if (stored?._workflowWindowId) {
        const win = await chrome.windows.get(stored._workflowWindowId);
        if (win) {
          console.log(
            "[Background] openWorkflowWindow - found window in session storage, focusing",
          );
          workflowWindowId = stored._workflowWindowId;
          _extensionPopupWindows.add(workflowWindowId);
          chrome.windows.update(workflowWindowId, { focused: true });
          if (workflowData) {
            chrome.runtime.sendMessage({
              action: "loadWorkflowInEditor",
              data: workflowData,
            });
          }
          editingWorkflowId = workflowData?.workflow?.wf_id || null;
          _persistWindowIds();
          return true;
        }
      }
    } catch (e) {
      console.log(
        "[Background] openWorkflowWindow - session storage window invalid, will create new",
      );
    }
  }
  console.log("[Background] openWorkflowWindow - creating new window");
  let pendingWorkflowSet = false;
  try {
    if (workflowData) {
      await chrome.storage.local.set({ _pendingWorkflow: workflowData });
      pendingWorkflowSet = true;
    }
    const { width: winWidth, height: winHeight } = await _getEditorWindowSize();
    const pos = await _calcWindowPosition(winWidth, winHeight);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("workflow-editor.html"),
      type: "popup",
      width: winWidth,
      height: winHeight,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    workflowWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
    pendingWorkflowSet = false;
    return true;
  } catch (createErr) {
    console.error(
      "[Background] openWorkflowWindow create failed:",
      createErr.message,
    );
    if (pendingWorkflowSet) {
      try {
        await chrome.storage.local.remove("_pendingWorkflow");
      } catch (e) {}
    }
    return false;
  }
}
let _previewWindowOpening = false;
let _templatePreviewWindowId = null;
async function closeUsedTemplatePreview(sender) {
  try {
    const expected = new URL(sender?.url);
    if (
      !["https://local.566flow.invalid", "https://566flow.invalid"].includes(
        expected.origin,
      ) ||
      !/^\/app\/templates\/[^/]+\/preview\/?$/.test(expected.pathname) ||
      !Number.isInteger(sender.tab?.id) ||
      !Number.isInteger(sender.tab.windowId)
    )
      return false;
    const win = await chrome.windows.get(sender.tab.windowId, {
      populate: true,
    });
    const tab = win?.tabs?.[0];
    if (
      win?.type !== "popup" ||
      win.tabs?.length !== 1 ||
      tab?.id !== sender.tab.id
    )
      return false;
    const live = new URL(tab.url);
    if (live.origin !== expected.origin || live.pathname !== expected.pathname)
      return false;
    await chrome.windows.remove(win.id);
    return true;
  } catch (_) {
    return false;
  }
}
async function openWebSpacesWindow(message, sendResponse) {
  let winWidth = 1440,
    winHeight = 900;
  try {
    const flowTabs = await chrome.tabs.query({
      url: getFlowTabQueryPatterns(),
    });
    if (flowTabs.length > 0 && flowTabs[0].windowId) {
      const flowWin = await chrome.windows.get(flowTabs[0].windowId);
      if (flowWin?.width && flowWin?.height) {
        const tw = Math.round(flowWin.width * 0.9),
          th = Math.round(flowWin.height * 0.9);
        if (tw > winWidth) winWidth = tw;
        if (th > winHeight) winHeight = th;
      }
    }
  } catch (_) {}
  let winId = _webSpacesWindowId;
  if (!winId) {
    try {
      winId =
        (await chrome.storage?.session?.get(["_webSpacesWindowId"]))
          ?._webSpacesWindowId || null;
    } catch (_) {}
  }
  let tabId = null;
  if (winId) {
    try {
      await chrome.windows.get(winId);
      const tabs = await chrome.tabs.query({ windowId: winId });
      tabId = tabs?.[0]?.id ?? null;
      await chrome.windows.update(winId, { focused: true });
    } catch (_) {
      winId = null;
    }
  }
  if (!winId) {
    try {
      const pos = await _calcWindowPosition(winWidth, winHeight);
      const win = await chrome.windows.create({
        url: chrome.runtime.getURL("web-loading.html"),
        type: "popup",
        width: winWidth,
        height: winHeight,
        left: pos.left,
        top: pos.top,
        focused: true,
      });
      winId = win.id;
      tabId = win.tabs?.[0]?.id ?? null;
      _webSpacesWindowId = winId;
      _extensionPopupWindows.add(winId);
      try {
        await chrome.storage.session.set({ _webSpacesWindowId: winId });
      } catch (_) {}
    } catch (e) {
      console.error(
        "[Background] openWebSpaces windows.create failed:",
        e?.message,
      );
      sendResponse({
        ok: false,
        error: "WINDOW_CREATE_FAILED",
        message: e?.message,
      });
      return;
    }
  }
  const base = getApiBaseUrl().replace(/\/api\/v1$/, "");
  try {
    let wfId = String(message.wfId || "").trim();
    const rawPath = String(message.path || "").trim();
    const safePath =
      /^\/(app|admin\/(workflow-templates|creator-templates))\/[\w\-\/?=&%.]*$/.test(
        rawPath,
      )
        ? rawPath
        : "";
    if (!wfId && !safePath) {
      if (tabId)
        await chrome.tabs.update(tabId, { url: `${base}/app/workflows` });
      sendResponse({ ok: false, error: "NO_TARGET" });
      return;
    }
    let url = wfId
      ? `${base}/app/spaces/${encodeURIComponent(wfId)}`
      : `${base}${safePath}`;
    try {
      const stored = await chrome.storage.local.get(["af_auth"]);
      const token = stored?.af_auth?.token;
      if (token) {
        const resp = await _signedFetch(`${getApiBaseUrl()}/auth/web-ticket`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
            "X-Extension-Id": chrome.runtime.id,
          },
          body: "{}",
        });
        const json = await resp.json().catch(() => null);
        if (resp.ok && json?.success && json?.data?.ticket) {
          url += `${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(json.data.ticket)}`;
        }
      }
    } catch (_) {}
    if (tabId) await chrome.tabs.update(tabId, { url });
    sendResponse({ ok: true });
  } catch (e) {
    console.error("[Background] openWebSpaces navigate error:", e?.message);
    sendResponse({ ok: false, error: "EXCEPTION", message: e?.message });
  }
}
async function openWebsiteTemplatePreview(template) {
  if (!template?.id) throw new Error("NO_TEMPLATE_ID");
  const response = await _signedFetch(
    `${getApiBaseUrl()}/system-settings/public`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Extension-Id": chrome.runtime.id,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8e3),
    },
  );
  const payload = await response.json();
  const mode = payload?.data?.workflow_web_mode;
  if (
    !response.ok ||
    payload?.success !== true ||
    ![true, false, 1, 0, "1", "0"].includes(mode)
  )
    throw new Error("SYSTEM_CONFIG_UNAVAILABLE");
  const web = mode === true || mode === 1 || mode === "1";
  console.info("[WebsiteTemplatePreview]", {
    stage: "route",
    templateId: template.id,
    mode: web ? "space" : "extension",
  });
  if (!web) return openTemplatePreviewWindow(template);
  const result = await new Promise((resolve) =>
    openWebSpacesWindow(
      { path: `/app/templates/${encodeURIComponent(template.id)}/preview` },
      resolve,
    ),
  );
  if (!result?.ok) throw new Error(result?.error || "WINDOW_CREATE_FAILED");
}
async function openTemplatePreviewWindow(template, kind = "template") {
  if (_previewWindowOpening) {
    console.log(
      "[Background] openTemplatePreviewWindow: skip (already opening)",
    );
    return;
  }
  _previewWindowOpening = true;
  setTimeout(() => {
    _previewWindowOpening = false;
  }, 1500);
  let wid = _templatePreviewWindowId;
  if (!wid) {
    try {
      wid =
        (await chrome.storage?.session?.get(["_templatePreviewWindowId"]))
          ?._templatePreviewWindowId || null;
    } catch (_) {}
  }
  if (wid) {
    try {
      const win = await chrome.windows.get(wid);
      if (win) {
        _templatePreviewWindowId = wid;
        try {
          chrome.runtime.sendMessage(
            { action: "loadTemplatePreview", template, kind },
            () => void chrome.runtime.lastError,
          );
        } catch (_) {}
        try {
          await chrome.windows.update(wid, { focused: true });
        } catch (_) {}
        console.log(
          "[Background] template preview: swap content in existing lite window",
          wid,
          "kind=",
          kind,
        );
        return;
      }
    } catch (e) {
      _templatePreviewWindowId = null;
    }
  }
  await chrome.storage.local.set({
    _pendingTemplatePreview: { template, kind, timestamp: Date.now() },
  });
  let winWidth = 1280,
    winHeight = 860;
  try {
    const flowTabs = await chrome.tabs.query({
      url: getFlowTabQueryPatterns(),
    });
    if (flowTabs.length > 0 && flowTabs[0].windowId) {
      const flowWin = await chrome.windows.get(flowTabs[0].windowId);
      if (flowWin?.width && flowWin?.height) {
        const tw = Math.round(flowWin.width * 0.85),
          th = Math.round(flowWin.height * 0.85);
        if (tw > winWidth) winWidth = tw;
        if (th > winHeight) winHeight = th;
      }
    }
  } catch (_) {}
  try {
    const pos = await _calcWindowPosition(winWidth, winHeight);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("template-preview.html"),
      type: "popup",
      width: winWidth,
      height: winHeight,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    _templatePreviewWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    try {
      await chrome.storage.session.set({ _templatePreviewWindowId: win.id });
    } catch (_) {}
    console.log("[Background] template preview: created lite window", win.id);
  } catch (e) {
    console.error("[Background] template preview create failed:", e.message);
    try {
      await chrome.storage.local.remove("_pendingTemplatePreview");
    } catch (_) {}
  }
}
function normalizeFlowUploadBase64(value) {
  let payload = typeof value === "string" ? value.trim() : "";
  let mime = null;
  const dataUrl = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(payload);
  if (dataUrl) {
    mime = dataUrl[1].trim().toLowerCase();
    payload = dataUrl[2];
  }
  payload = payload.replace(/\s+/g, "");
  if (!payload || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)) {
    return { ok: false, error: "BAD_IMAGE_BASE64" };
  }
  payload = payload.replace(/-/g, "+").replace(/_/g, "/");
  const unpaddedLength = payload.replace(/=+$/, "").length;
  if (unpaddedLength % 4 === 1) return { ok: false, error: "BAD_IMAGE_BASE64" };
  payload = payload.replace(/=+$/, "");
  if (payload.length % 4) payload += "=".repeat(4 - (payload.length % 4));
  return { ok: true, base64: payload, mime };
}
async function uploadSpaceFlowFile(file, expectedFlowTarget, auth) {
  let dispatched = false;
  const userId = String(auth.user.id);
  const current = async (strict = true) => {
    const now = (await chrome.storage.local.get("af_auth")).af_auth;
    return (
      !!now?.token &&
      (!strict || now.token === auth.token) &&
      String(now.user?.id || "") === userId
    );
  };
  try {
    const allowed = [
      "sidebar.html",
      "workflow-editor.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    const contexts = (await chrome.runtime.getContexts({})).filter(
      (context) =>
        context.documentId &&
        allowed.includes(String(context.documentUrl || "").split(/[?#]/)[0]),
    );
    let documentId = null;
    for (const context of contexts) {
      const probe = await chrome.runtime
        .sendMessage({
          action: "workflowSpaceNativeUpload",
          probeOnly: true,
          documentId: context.documentId,
          userId,
        })
        .catch(() => null);
      if (!(await current()))
        return { error: "ACCOUNT_SCOPE_CHANGED", dispatchStarted: false };
      if (probe?.ok === true) {
        documentId = context.documentId;
        break;
      }
    }
    if (!documentId)
      return {
        error: "NATIVE_HEALTH_CONTEXT_REQUIRED",
        dispatchStarted: false,
      };
    if (!(await current()))
      return { error: "ACCOUNT_SCOPE_CHANGED", dispatchStarted: false };
    dispatched = true;
    const pending = chrome.runtime.sendMessage({
      action: "workflowSpaceNativeUpload",
      documentId,
      userId,
      expectedFlowTarget,
      filesData: [file],
    });
    file.base64 = "";
    const response = await pending;
    if (!(await current(false)) || !response)
      return { error: "BRIDGE_RESULT_UNKNOWN", dispatchStarted: true };
    return response;
  } catch (_) {
    return {
      error: dispatched
        ? "BRIDGE_RESULT_UNKNOWN"
        : "NATIVE_HEALTH_CONTEXT_REQUIRED",
      dispatchStarted: dispatched,
    };
  }
}
async function doUploadToFlow(message, options = {}) {
  if (globalThis._uploadToFlowBusy)
    return {
      ok: false,
      error: "BUSY",
      message: "Uploading another image to Flow \u2014 please try again later.",
    };
  globalThis._uploadToFlowBusy = true;
  try {
    const normalizedPayload = normalizeFlowUploadBase64(message.base64);
    if (!normalizedPayload.ok)
      return { ok: false, error: normalizedPayload.error };
    let b64 = normalizedPayload.base64;
    const uploadMime = normalizedPayload.mime || message.mime || "image/jpeg";
    if (!b64 || b64.length > 12 * 1024 * 1024)
      return { ok: false, error: "BAD_IMAGE" };
    message.base64 = "";
    const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
    const target = (await chrome.storage.session.get("targetFlowTabId"))
      ?.targetFlowTabId;
    const expectedProjectId =
      typeof message.expectedProjectId === "string"
        ? message.expectedProjectId.trim()
        : null;
    const candidates = tabs.filter(
      (t) =>
        describeFlowTab(t)?.projectId &&
        (!expectedProjectId ||
          describeFlowTab(t).projectId === expectedProjectId) &&
        (parseFlowV2Path(new URL(t.url).pathname)?.isProjectEditor ||
          options.externalMcpUpload === true),
    );
    const preferredTarget =
      expectedProjectId && !candidates.some((t) => t.id === target)
        ? null
        : target;
    const tab = selectFlowTab(candidates, preferredTarget);
    if (!tab)
      return {
        ok: false,
        error: expectedProjectId
          ? "FLOW_EXECUTION_TARGET_CHANGED"
          : "NO_FLOW_TAB",
        dispatchStarted: false,
      };
    const flowTarget = describeFlowTab(tab);
    const useNativeUploader = Number.isInteger(options.spaceOwnerTabId);
    let uploadAuth = null;
    if (useNativeUploader) {
      uploadAuth = (await chrome.storage.local.get("af_auth")).af_auth;
      if (!uploadAuth?.token || !uploadAuth.user?.id)
        return { ok: false, error: "AUTH_REQUIRED", dispatchStarted: false };
    }
    let result;
    if (useNativeUploader) {
      const file = {
        name: String(message.name || "web_ref.jpg").slice(0, 120),
        type: uploadMime,
        base64: b64,
      };
      b64 = "";
      result = await uploadSpaceFlowFile(file, flowTarget, uploadAuth);
    } else {
      try {
        await chrome.tabs.update(tab.id, { active: true });
      } catch (_) {}
      if (options.externalMcpUpload === true) {
        const prepared = await prepareFlowProjectEditorTab(tab);
        if (prepared?.success !== true) {
          return { ok: false, error: prepared?.error || "FLOW_PREPARE_FAILED" };
        }
      }
      const contentMessage = {
        action: "uploadFilesToFlow",
        _flowTarget: flowTarget,
        manualUpload: options.externalMcpUpload === true,
        uploadRequestId: crypto.randomUUID(),
        workflowUploadMenuFocus: Number.isInteger(options.spaceOwnerTabId),
        uploadMenuOwnerTabId: options.spaceOwnerTabId ?? null,
        filesData: [
          {
            name: String(message.name || "web_ref.jpg").slice(0, 120),
            type: uploadMime,
            base64: b64,
          },
        ],
      };
      const resultPromise = new Promise((resolve) => {
        chrome.tabs.sendMessage(tab.id, contentMessage, (resp) => {
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      });
      contentMessage.filesData[0].base64 = "";
      b64 = "";
      result = await resultPromise;
    }
    const tileId = result?.orderedTileIds?.[0] || result?.tileIds?.[0] || null;
    if (!tileId)
      return {
        ok: false,
        error: result?.error || "UPLOAD_FAILED",
        message: result?.errorMessage || null,
        ...(typeof result?.dispatchStarted === "boolean"
          ? { dispatchStarted: result.dispatchStarted }
          : {}),
      };
    const detail = Array.isArray(result?.tileDetails)
      ? result.tileDetails.find((x) => x?.id === tileId) || null
      : null;
    let fileName = detail?.file_name || detail?.file_id || null;
    let thumbnail = detail?.thumbnailUrl || null;
    let scannedMetadata = null;
    if (!detail && result?.tileDetails?.length)
      console.warn(
        "[Background/uploadToFlow] ignored unowned upload metadata",
        { detailCount: result.tileDetails.length },
      );
    try {
      if (
        (!useNativeUploader || !["v1", "v2"].includes(detail?.api_driver)) &&
        (!fileName || !thumbnail)
      ) {
        const scan = await _sendFlowMetadataRead(tab.id, {
          action: "scanFlowImages",
          deep: false,
          _flowTarget: flowTarget,
        });
        const found = (scan?.images || []).find((x) => x.fileId === tileId);
        if (found) {
          scannedMetadata = found;
          fileName = fileName || found.file_name || null;
          thumbnail = thumbnail || found.thumbnail || null;
        }
      }
    } catch (_) {}
    console.log("[Background/uploadToFlow] verified upload result", {
      hasTileDetail: !!detail,
      fileId: tileId,
      fileName: fileName || null,
      hasThumbnail: !!thumbnail,
    });
    const metadata = Object.fromEntries(
      [
        "media_uuid",
        "persistent_media_id",
        "project_id",
        "api_driver",
        "identity_kind",
        "identity_durability",
        "image_url",
        "source_thumbnail",
        "video_url",
        "playback_url_source",
        "preview_pending",
      ]
        .map((key) => [key, detail?.[key] ?? scannedMetadata?.[key]])
        .filter(([, value]) => value != null),
    );
    return {
      ok: true,
      file_id: tileId,
      file_name: fileName,
      thumbnail,
      ...metadata,
      type: String(uploadMime).startsWith("video/") ? "video" : "image",
    };
  } catch (e) {
    return { ok: false, error: "EXCEPTION", message: e.message };
  } finally {
    globalThis._uploadToFlowBusy = false;
  }
}
async function prepareFlowProjectEditorTab(tab) {
  const target = describeFlowTab(tab);
  if (target?.driverKey !== "flow_v2" || !target.projectId) {
    return { success: false, error: "FLOW_PROJECT_REQUIRED" };
  }
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const liveTab = await chrome.tabs.get(tab.id).catch(() => null);
    const live = describeFlowTab(liveTab);
    if (
      !live ||
      live.origin !== target.origin ||
      live.projectId !== target.projectId ||
      live.routePrefix !== target.routePrefix
    ) {
      return { success: false, error: "FLOW_EXECUTION_TARGET_CHANGED" };
    }
    const result = await chrome.tabs
      .sendMessage(tab.id, { action: "prepareFlowForGen", _flowTarget: target })
      .catch(() => ({ success: false, error: "FLOW_PROJECT_NAVIGATING" }));
    if (result?.success === true) return result;
    if (
      !["FLOW_PROJECT_NAVIGATING", "FLOW_VIEWER_NAVIGATING"].includes(
        result?.error,
      )
    )
      return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { success: false, error: "FLOW_PROJECT_NAVIGATION_TIMEOUT" };
}
async function getFlowProviderStatusForWeb({ prepare = false } = {}) {
  try {
    const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
    const tab = await selectFlowStatusTab(tabs);
    if (!tab?.id) return { tabOpen: false, ready: false, error: "NO_TAB" };
    let liveTab = tab;
    let context = describeFlowTab(liveTab);
    let ping = await chrome.tabs
      .sendMessage(liveTab.id, { action: "ping" })
      .catch(() => null);
    let contentReady = !!(
      context &&
      ping?.pong &&
      ping?.driverKey === context.driverKey &&
      ping?.contentRevision === TOBYFLOW_CONTENT_REVISION
    );
    if (prepare && !contentReady && context?.projectId && !ping?.pong) {
      try {
        await ensureFlowCorrelationObserver(liveTab.id);
        await chrome.scripting.executeScript({
          target: { tabId: liveTab.id },
          files: FLOW_CONTENT_SCRIPT_FILES,
        });
        try {
          await chrome.scripting.executeScript({
            target: { tabId: liveTab.id },
            files: ["slate-bridge.js"],
            world: "MAIN",
          });
          await chrome.scripting.executeScript({
            target: { tabId: liveTab.id },
            files: ["media-interceptor.js"],
            world: "MAIN",
          });
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 300));
        ping = await chrome.tabs
          .sendMessage(liveTab.id, { action: "ping" })
          .catch(() => null);
        contentReady = !!(
          context &&
          ping?.pong &&
          ping?.driverKey === context.driverKey &&
          ping?.contentRevision === TOBYFLOW_CONTENT_REVISION
        );
      } catch (_) {}
    }
    if (
      prepare &&
      contentReady &&
      context?.projectId &&
      context.isProjectEditor !== true
    ) {
      const repaired = await prepareFlowProjectEditorTab(liveTab);
      if (repaired?.success !== true) {
        return {
          tabOpen: true,
          ready: false,
          error: repaired?.error || "FLOW_VIEWER_PREPARE_FAILED",
        };
      }
      liveTab = await chrome.tabs.get(liveTab.id).catch(() => liveTab);
      context = describeFlowTab(liveTab);
      ping = await chrome.tabs
        .sendMessage(liveTab.id, { action: "ping" })
        .catch(() => null);
      contentReady = !!(
        context &&
        ping?.pong &&
        ping?.driverKey === context.driverKey &&
        ping?.contentRevision === TOBYFLOW_CONTENT_REVISION
      );
    }
    let preflight = null;
    if (
      prepare &&
      contentReady &&
      context?.driverKey === "flow_v2" &&
      context.projectId
    ) {
      preflight = await chrome.tabs
        .sendMessage(liveTab.id, { action: "flowPreflight" })
        .catch((error) => ({
          success: false,
          error: error?.message || "FLOW_PREFLIGHT_FAILED",
        }));
      liveTab = await chrome.tabs.get(liveTab.id).catch(() => liveTab);
      context = describeFlowTab(liveTab);
      contentReady = !!(
        context &&
        ping?.pong &&
        ping?.driverKey === context.driverKey &&
        ping?.contentRevision === TOBYFLOW_CONTENT_REVISION
      );
    }
    const recoverable = [
      "V2_AGENT_BLOCKED",
      "V2_MEDIA_VIEWER_OPEN",
      "V2_COMPOSER_NOT_READY",
    ].includes(preflight?.error);
    const preflightReady =
      !prepare || preflight?.success === true || recoverable;
    const ready =
      context?.driverKey === "flow_v2"
        ? !!(
            contentReady &&
            context.projectId &&
            context.isProjectEditor === true &&
            preflightReady
          )
        : contentReady;
    return {
      tabOpen: true,
      ready,
      tabId: liveTab.id,
      projectId: context?.projectId || null,
      error: ready
        ? null
        : !context?.projectId || context?.isProjectEditor !== true
          ? "NO_PROJECT_OPEN"
          : ping?.contentRevision !== TOBYFLOW_CONTENT_REVISION
            ? "CONTENT_REVISION_MISMATCH"
            : preflight?.error || "FLOW_CONTENT_NOT_READY",
    };
  } catch (error) {
    return {
      tabOpen: false,
      ready: false,
      error: error?.message || "FLOW_STATUS_CHECK_FAILED",
    };
  }
}
function openMotionTemplateSidebar(message, sender, sendResponse) {
  const templateId = Number(message.templateId),
    windowId = sender?.tab?.windowId;
  if (
    !Number.isSafeInteger(templateId) ||
    templateId <= 0 ||
    !Number.isInteger(windowId)
  ) {
    sendResponse({ ok: false, error: "INVALID_MOTION_TEMPLATE_REQUEST" });
    return false;
  }
  let opened;
  try {
    opened = chrome.sidePanel.open({ windowId });
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || "SIDEBAR_OPEN_FAILED" });
    return false;
  }
  (async () => {
    try {
      await opened;
      await chrome.storage.session.set({
        tobyflow_pending_motion_template: {
          templateId,
          windowId,
          requestId: crypto.randomUUID(),
          timestamp: Date.now(),
        },
      });
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || "SIDEBAR_OPEN_FAILED",
      });
    }
  })();
  return true;
}
const _spaceDiagnostics = new WorkflowSpaceDiagnostics({
  storage: chrome.storage.local,
  version: () => chrome.runtime.getManifest().version,
  probe: async () => {
    const patterns = getFlowTabQueryPatterns();
    if (!patterns?.length)
      return {
        flowTab: "config_missing",
        contentAck: "not_probed",
        nativeContexts: null,
      };
    const tabs = await chrome.tabs.query({ url: patterns });
    const tab = tabs.find((item) => item.active) || tabs[0];
    const contexts =
      typeof chrome.runtime.getContexts === "function"
        ? await chrome.runtime.getContexts({}).catch(() => null)
        : null;
    const nativeContexts = contexts
      ? contexts.filter((context) =>
          ["sidebar.html", "workflow-editor.html", "run-window.html"].some(
            (file) =>
              context.documentUrl?.split(/[?#]/)[0] ===
              chrome.runtime.getURL(file),
          ),
        ).length
      : null;
    if (!tab)
      return { flowTab: "closed", contentAck: "not_probed", nativeContexts };
    if (tab.status === "loading")
      return { flowTab: "loading", contentAck: "not_probed", nativeContexts };
    let timer;
    try {
      const reply = await Promise.race([
        chrome.tabs.sendMessage(tab.id, { action: "ping" }).catch(() => null),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 2500);
        }),
      ]);
      return {
        flowTab: "present",
        contentAck: reply?.pong === true ? "received" : "unavailable",
        contentRevision: Number.isSafeInteger(reply?.contentRevision)
          ? reply.contentRevision
          : null,
        nativeContexts,
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.af_auth) return;
  const previous = changes.af_auth.oldValue,
    current = changes.af_auth.newValue;
  if (
    previous?.user?.id &&
    (!current?.token ||
      String(previous.user.id) !== String(current?.user?.id || ""))
  ) {
    void _spaceDiagnostics.purgeUser(previous.user.id).catch(() => {});
    void _spaceCommandJournal.purgeUser(previous.user.id).catch(() => {});
  }
});
const _spaceCommandJournal = new WorkflowSpaceCommands({
  storage: chrome.storage.local,
});
const _spaceCommandDispatch = Symbol("Space command dispatch");
const _spaceUpgradeWindows = new Map();
chrome.tabs.onRemoved.addListener((tabId) =>
  _spaceUpgradeWindows.delete(tabId),
);
function openUpgradeSidebar(windowId, sendResponse) {
  if (!Number.isInteger(windowId) || !chrome.sidePanel?.open) {
    sendResponse({ ok: false, error: "BROWSER_WINDOW_NOT_READY" });
    return false;
  }
  let opened;
  try {
    opened = chrome.sidePanel.open({ windowId });
  } catch (_) {
    sendResponse({ ok: false, error: "SIDEBAR_OPEN_FAILED" });
    return false;
  }
  (async () => {
    try {
      await opened;
      await chrome.storage.session.set({
        tobyflow_pending_upgrade_modal: Date.now(),
      });
      await chrome.windows.update(windowId, { focused: true }).catch(() => {});
      sendResponse({ ok: true });
    } catch (_) {
      sendResponse({ ok: false, error: "SIDEBAR_OPEN_FAILED" });
    }
  })();
  return true;
}
const _spaceCommandTarget = Symbol("Space command target run");
const _spaceCommandJob = Symbol("Space command target job");
chrome.runtime.onMessageExternal.addListener(
  function handleWorkflowExternalMessage(
    message,
    sender,
    sendResponse,
    dispatchToken,
  ) {
    const origin = sender?.origin || sender?.url || "";
    if (!/^https:\/\/(?:labs\.toby\.vn|tobyflow\.com)(?:[/:]|$)/.test(origin)) {
      sendResponse({ ok: false, error: "BAD_ORIGIN" });
      return;
    }
    if (
      dispatchToken === void 0 &&
      message?.type !== "workflowSpaceCommandStatus" &&
      !(
        message?.type === "workflowSpaceArtifact" &&
        message.operation === "read"
      ) &&
      !(message?.type === "workflowSpaceQueue" && message.operation === "read")
    )
      console.log(
        "[Background] onMessageExternal:",
        message?.type,
        "from",
        origin,
      );
    if (message?.type === "workflowSpaceDiagnostics") {
      _spaceDiagnostics
        .handle(message, sender)
        .then(sendResponse, (error) =>
          sendResponse({
            ok: false,
            error:
              WorkflowSpaceDiagnosticSchema.code(error?.message) ||
              "SPACE_DIAGNOSTIC_FAILED",
          }),
        );
      return true;
    }
    if (message?._spaceDiagnostic) {
      const observedMessage = message;
      message = { ...message };
      delete message._spaceDiagnostic;
      try {
        _spaceDiagnostics.observeRpc(observedMessage, sender, "rpc_received");
      } catch (_) {}
      const originalReply = sendResponse;
      sendResponse = (response) => {
        try {
          _spaceDiagnostics.observeRpc(
            observedMessage,
            sender,
            "rpc_ack",
            response,
          );
        } catch (_) {}
        originalReply(response);
      };
    }
    if (message?.type === "workflowSpaceCommandStatus") {
      _spaceCommandJournal
        .status(message, sender)
        .then(sendResponse, (error) =>
          sendResponse({
            ok: false,
            error: error.message,
            dispatchStarted: false,
          }),
        );
      return true;
    }
    if (
      dispatchToken !== _spaceCommandDispatch &&
      message?.operationId != null &&
      ["runWorkflow", "runNode", "stopWorkflow", "stopNode"].includes(
        message.type,
      )
    ) {
      _spaceCommandJournal
        .handle(
          message,
          sender,
          (targetRunId, targetJobId) =>
            new Promise((resolve, reject) => {
              try {
                handleWorkflowExternalMessage(
                  {
                    ...message,
                    [_spaceCommandTarget]: targetRunId,
                    [_spaceCommandJob]: targetJobId,
                  },
                  sender,
                  resolve,
                  _spaceCommandDispatch,
                );
              } catch (error) {
                reject(error);
              }
            }),
        )
        .then(sendResponse, (error) =>
          sendResponse({
            ok: false,
            error: error.message,
            dispatchStarted: false,
          }),
        );
      return true;
    }
    if (message?.type === "openMotionTemplatePreview")
      return openMotionTemplateSidebar(message, sender, sendResponse);
    if (message?.type === "workflowSpaceOpenRunLog") {
      openWorkflowRunLog(message, sender).then(sendResponse, () =>
        sendResponse({ ok: false, error: "RUN_LOG_OPEN_FAILED" }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceQueue") {
      handleSpaceQueue(message, sender).then(sendResponse, (error) =>
        sendResponse({
          ok: false,
          error: error?.message || "QUEUE_RESULT_UNKNOWN",
        }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceDownload") {
      handleSpaceDownload(message, sender).then(sendResponse, (error) =>
        sendResponse({
          ok: false,
          error: error?.message || "DOWNLOAD_RESULT_UNKNOWN",
        }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceResetCleanup") {
      handleSpaceResetCleanup(message, sender).then(sendResponse, (error) =>
        sendResponse({
          ok: false,
          error: error?.message || "RESET_CLEANUP_PENDING",
        }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceReset") {
      handleSpaceReset(message, sender).then(sendResponse, (error) =>
        sendResponse({
          ok: false,
          error: error?.message || "SPACE_RESET_FAILED",
        }),
      );
      return true;
    }
    if (message?.type === "workflowSpacePicker") {
      handleSpacePicker(message, sender).then(sendResponse, (error) =>
        sendResponse({
          ok: false,
          error: error?.message || "SPACE_PICKER_FAILED",
        }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceArtifact") {
      WorkflowSpaceArtifacts.handle(message, sender, {
        readAuth: async () =>
          (await chrome.storage.local.get("af_auth")).af_auth,
        store: WorkflowResultMediaStore,
        recoverPoster: async (scope) => {
          const response = await readSpaceNativeHealth({
            workflowId: scope.workflowId,
            userId: scope.userId,
            providers: [],
            localPoster: { nodeId: scope.ownerNodeId, fileId: scope.fileId },
          });
          return response?.ok === true ? response.poster : null;
        },
        authorizeWorkflow: async (scope, auth) => {
          const response = await _signedFetch(
            `${getApiBaseUrl()}/workflows/${encodeURIComponent(scope.workflowId)}/space-artifact-grants/verify`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${auth.token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Extension-Id": chrome.runtime.id,
              },
              body: JSON.stringify({
                grant: scope.grant,
                origin: new URL(sender.origin || sender.url).origin,
                ownerNodeId: scope.ownerNodeId,
                fileId: scope.fileId,
              }),
              cache: "no-store",
              signal: AbortSignal.timeout(2e4),
            },
          );
          const payload = await response.json();
          if (!response.ok || payload?.success !== true) {
            const code = payload?.error?.code;
            throw new Error(
              typeof code === "string" && /^[A-Z0-9_]+$/.test(code)
                ? code
                : "SPACE_ARTIFACT_AUTHORIZATION_FAILED",
            );
          }
        },
      })
        .then(sendResponse)
        .catch((error) =>
          sendResponse({
            ok: false,
            error: error?.message || "SPACE_ARTIFACT_FAILED",
          }),
        );
      return true;
    }
    if (message?.type === "ping") {
      sendResponse({
        ok: true,
        installed: true,
        version: chrome.runtime.getManifest().version,
        capabilities: [
          "workflowSpaceUpgradeV1",
          ...(sender?.documentId
            ? ["workflowSpaceDiagnosticsV1", "workflowSpaceCommandsV1"]
            : []),
          ...(typeof chrome.runtime.getContexts === "function"
            ? [
                "workflowSpaceEventsV1",
                "workflowSpaceRunLogV1",
                "workflowSpaceContextV1",
              ]
            : []),
          "workflowSpaceFreshGroupsV1",
          "workflowSpaceQueueV1",
          "workflowSpaceDownloadV3",
          "workflowSpaceDownloadV2",
          "workflowSpaceDownloadV1",
          "workflowSpaceResetV1",
          "workflowSpacePickerV1",
          "workflowSpaceHealthV1",
          "workflowSpaceFlowModeV1",
          "workflowSpaceRescanV1",
          "workflowSpaceArtifactsV1",
          "openTemplatePreview",
          "openMotionTemplatePreview",
          "fetchMedia",
          "rescanWorkflowMedia",
          "resolveFlowApiMedia",
          "downloadWorkflowMedia",
          "providerStatus",
          "runWorkflow",
          "stopWorkflow",
          "workflowStatus",
          "runNode",
          "stopNode",
          "singleNodeSessions",
          "currentProject",
          "listFlowLibrary",
          "uploadToFlow",
          "listFlowCharacters",
          "listFlowVoices",
          "syncFlowCharacters",
          "syncFlowVoices",
          "closeWindow",
        ],
      });
      return;
    }
    if (message?.type === "closeWindow") {
      const winId = sender?.tab?.windowId;
      if (winId == null) {
        sendResponse({ ok: false, error: "NO_WINDOW" });
        return;
      }
      chrome.windows
        .remove(winId)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message }));
      return true;
    }
    if (message?.type === "openTemplatePreview") {
      const templateId = message.templateId;
      let refCode = (message.refCode || "").trim();
      if (templateId === void 0 || templateId === null || templateId === "") {
        sendResponse({ ok: false, error: "NO_TEMPLATE_ID" });
        return;
      }
      (async () => {
        try {
          if (refCode && /^[A-Za-z0-9_\-]{4,40}$/.test(refCode)) {
            try {
              chrome.storage.local.set({
                tf_ref: {
                  code: refCode,
                  expires: Date.now() + 90 * 24 * 60 * 60 * 1e3,
                },
              });
            } catch (_) {}
          }
          const url =
            message.kind === "official"
              ? `${getApiBaseUrl()}/workflow-templates/${encodeURIComponent(templateId)}`
              : `${getApiBaseUrl()}/creator-templates/${encodeURIComponent(templateId)}/public`;
          console.log("[Background] external preview fetch:", url);
          const headers = {
            Accept: "application/json",
            "X-Extension-Id": chrome.runtime.id,
          };
          try {
            const stored = await chrome.storage.local.get(["af_auth"]);
            if (stored?.af_auth?.token)
              headers["Authorization"] = `Bearer ${stored.af_auth.token}`;
          } catch (_) {}
          const resp = await _signedFetch(url, {
            method: "GET",
            headers,
            cache: "no-store",
          });
          const json = await resp.json().catch(() => null);
          console.log(
            "[Background] external preview fetch result:",
            resp.status,
            "success=",
            json?.success,
            "hasData=",
            !!json?.data,
            "authed=",
            !!headers["Authorization"],
            "code=",
            json?.error?.code || "-",
          );
          if (!resp.ok || !json?.success || !json?.data) {
            sendResponse({
              ok: false,
              error: "FETCH_FAILED",
              status: resp.status,
              code: json?.error?.code || null,
            });
            return;
          }
          await openWebsiteTemplatePreview(json.data);
          sendResponse({ ok: true });
        } catch (err) {
          console.error(
            "[Background] onMessageExternal openTemplatePreview error:",
            err.message,
          );
          sendResponse({ ok: false, error: "EXCEPTION", message: err.message });
        }
      })();
      return true;
    }
    if (message?.type === "fetchMedia") {
      const MEDIA_HOSTS =
        /(^|\.)(labs\.google|flow\.google\.com|googleusercontent\.com|storage\.googleapis\.com|flow-content\.google|chatgpt\.com|oaiusercontent\.com|openai\.com|grok\.com|x\.ai)$/i;
      const urls = (Array.isArray(message.urls) ? message.urls : [])
        .filter((u) => typeof u === "string")
        .slice(0, 12);
      (async () => {
        const results = {};
        let budget = 48 * 1024 * 1024;
        for (const u of urls) {
          results[u] = null;
          try {
            const parsed = new URL(u);
            if (
              parsed.protocol !== "https:" ||
              !MEDIA_HOSTS.test(parsed.hostname)
            )
              continue;
            const resp = await fetch(u, {
              credentials: "include",
              signal: AbortSignal.timeout(2e4),
            });
            if (!resp.ok) continue;
            try {
              const finalUrl = new URL(resp.url);
              if (
                finalUrl.protocol !== "https:" ||
                !MEDIA_HOSTS.test(finalUrl.hostname)
              )
                continue;
            } catch (_) {
              continue;
            }
            const clen = Number(resp.headers.get("content-length") || 0);
            if (clen > 25 * 1024 * 1024) continue;
            const blob = await resp.blob();
            const isImg = /^image\//.test(blob.type);
            const isVid = /^video\//.test(blob.type);
            if (
              (!isImg && !isVid) ||
              blob.size > (isVid ? 25 : 20) * 1024 * 1024
            )
              continue;
            let outBlob = blob;
            if (isImg) {
              try {
                const bmp = await createImageBitmap(blob);
                const scale = Math.min(
                  1,
                  512 / Math.max(bmp.width, bmp.height),
                );
                const oc = new OffscreenCanvas(
                  Math.max(1, Math.round(bmp.width * scale)),
                  Math.max(1, Math.round(bmp.height * scale)),
                );
                const ctx = oc.getContext("2d");
                ctx.fillStyle = "#fff";
                ctx.fillRect(0, 0, oc.width, oc.height);
                ctx.drawImage(bmp, 0, 0, oc.width, oc.height);
                outBlob = await oc.convertToBlob({
                  type: "image/jpeg",
                  quality: 0.82,
                });
              } catch (_) {}
            }
            const bytes = new Uint8Array(await outBlob.arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 8192)
              bin += String.fromCharCode.apply(
                null,
                bytes.subarray(i, i + 8192),
              );
            const b64 = btoa(bin);
            if (b64.length > budget) continue;
            budget -= b64.length;
            results[u] =
              `data:${outBlob.type || (isVid ? "video/mp4" : "image/jpeg")};base64,${b64}`;
          } catch (_) {}
        }
        sendResponse({ ok: true, results });
      })();
      return true;
    }
    if (message?.type === "workflowSpaceRescanStatus") {
      const key = `${sender.tab?.id}:${sender.documentId || sender.url || ""}:${message.operationId}`;
      const operation = _spaceRescanOperations.get(key);
      sendResponse(
        operation
          ? {
              ok: true,
              state: operation.state,
              stage: operation.stage,
              result: operation.result || null,
              error: operation.error || null,
            }
          : { ok: false, error: "RESCAN_OPERATION_UNAVAILABLE" },
      );
      return false;
    }
    if (message?.type === "workflowSpaceCancelRescan") {
      const key = `${sender.tab?.id}:${sender.documentId || sender.url || ""}:${message.operationId}`;
      const operation = _spaceRescanOperations.get(key);
      if (operation) {
        operation.cancelled = true;
        for (const requestId of operation.requests)
          chrome.tabs
            .sendMessage(operation.tabId, {
              action: "cancelFlowScanRequest",
              requestId,
            })
            .catch(() => {});
      }
      sendResponse({ ok: true, cancelled: !!operation });
      return false;
    }
    if (message?.type === "workflowSpaceRescan") {
      const key = `${sender.tab?.id}:${sender.documentId || sender.url || ""}:${message.operationId}`;
      if (
        !message.operationId ||
        typeof message.operationId !== "string" ||
        message.operationId.length > 150
      ) {
        sendResponse({ ok: false, error: "RESCAN_OPERATION_REQUIRED" });
        return false;
      }
      if (_spaceRescanOperations.has(key)) {
        sendResponse({ ok: false, error: "RESCAN_ALREADY_RUNNING" });
        return false;
      }
      const operation = {
        cancelled: false,
        requests: new Set(),
        tabId: null,
        state: "running",
        stage: "catalog",
        result: null,
        error: null,
      };
      _spaceRescanOperations.set(key, operation);
      console.info("[SpaceRescan]", {
        operationId: message.operationId,
        stage: "accepted",
        deep: message.deep === true,
      });
      sendResponse({
        ok: true,
        accepted: true,
        operationId: message.operationId,
      });
      (async () => {
        try {
          const config = (await chrome.storage.local.get("af_system_settings"))
            .af_system_settings;
          const timeoutMs = Number(config?.api_timeout_ms);
          if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
            throw Error("RESCAN_TIMEOUT_CONFIG_UNAVAILABLE");
          const tab = await selectFlowStatusTab(
            await chrome.tabs.query({ url: getFlowTabQueryPatterns() }),
          );
          const target = describeFlowTab(tab);
          if (!tab?.id || !target?.projectId || target.isProjectEditor !== true)
            throw Error("NO_PROJECT_OPEN");
          if (message.projectId && message.projectId !== target.projectId)
            throw Error("WRONG_PROJECT");
          operation.tabId = tab.id;
          const settings = (await chrome.storage.local.get("af_settings"))
            .af_settings;
          const mode = settings?.defaultGenMode || settings?.gen_mode;
          if (!["web", "api", "auto"].includes(mode))
            throw Error("FLOW_EXECUTION_MODE_UNAVAILABLE");
          const fileIds = [
            ...new Set(
              (Array.isArray(message.fileIds) ? message.fileIds : [])
                .filter((id) => typeof id === "string" && id.trim())
                .map((id) => id.trim()),
            ),
          ];
          const response = await _rescanFlowUuidMedia(
            fileIds,
            message.fileNamesById || {},
            Array.isArray(message.ownerRecords) ? message.ownerRecords : [],
            { tabId: tab.id, ...target },
            timeoutMs,
            {
              deep: message.deep === true,
              mode,
              followGatewayMode: true,
              assertActive: () => {
                if (operation.cancelled) throw Error("RESCAN_CANCELLED");
              },
              trackRequest: (id) => {
                operation.stage = "metadata";
                operation.requests.add(id);
              },
            },
          );
          if (operation.cancelled) throw Error("RESCAN_CANCELLED");
          return { ok: true, operationId: message.operationId, ...response };
        } finally {
          setTimeout(() => _spaceRescanOperations.delete(key), 5 * 60 * 1e3);
        }
      })()
        .then((result) => {
          operation.result = result;
          operation.state = "completed";
          operation.stage = "completed";
          console.info("[SpaceRescan]", {
            operationId: message.operationId,
            stage: "completed",
          });
        })
        .catch((error) => {
          operation.error = error.message;
          operation.state = operation.cancelled ? "cancelled" : "failed";
          operation.stage = operation.state;
          console.info("[SpaceRescan]", {
            operationId: message.operationId,
            stage: operation.state,
            code: error.message,
          });
        });
      return true;
    }
    if (message?.type === "rescanWorkflowMedia") {
      const fileIds = [
        ...new Set(
          (Array.isArray(message.fileIds) ? message.fileIds : [])
            .filter((id) => typeof id === "string" && id.trim())
            .map((id) => id.trim()),
        ),
      ];
      const fileNamesById =
        message.fileNamesById &&
        typeof message.fileNamesById === "object" &&
        !Array.isArray(message.fileNamesById)
          ? message.fileNamesById
          : {};
      const ownerRecords = Array.isArray(message.ownerRecords)
        ? message.ownerRecords
        : [];
      if (!fileIds.length) {
        sendResponse({ ok: true, results: {}, statuses: {} });
        return;
      }
      (async () => {
        try {
          const stored = await chrome.storage.local.get(["af_system_settings"]);
          const timeoutMs = Number(stored?.af_system_settings?.api_timeout_ms);
          if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
            sendResponse({
              ok: false,
              error: "RESCAN_TIMEOUT_CONFIG_UNAVAILABLE",
            });
            return;
          }
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          const flowTab = await selectFlowStatusTab(tabs);
          if (!flowTab?.id) {
            sendResponse({ ok: false, error: "FLOW_TAB_NOT_FOUND" });
            return;
          }
          const flowContext = describeFlowTab(flowTab);
          if (
            message.projectId &&
            String(flowContext?.projectId || "") !== String(message.projectId)
          ) {
            sendResponse({ ok: false, error: "WRONG_PROJECT" });
            return;
          }
          if (!flowTab.active)
            await chrome.tabs.update(flowTab.id, { active: true });
          const response = await _rescanFlowUuidMedia(
            fileIds,
            fileNamesById,
            ownerRecords,
            { tabId: flowTab.id, ...flowContext },
            timeoutMs,
          );
          sendResponse({ ok: true, ...response });
        } catch (err) {
          sendResponse({
            ok: false,
            error: "RESCAN_FAILED",
            message: err?.message || String(err),
          });
        }
      })();
      return true;
    }
    if (message?.type === "resolveFlowApiMedia") {
      const entries = (Array.isArray(message.media) ? message.media : [])
        .map((item) => ({
          id: String(item?.id || ""),
          type: item?.type === "video" ? "video" : "image",
          apiDriver: ["v1", "v2"].includes(item?.apiDriver)
            ? item.apiDriver
            : null,
        }))
        .filter((item) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            item.id,
          ),
        );
      if (entries.length > 12) {
        sendResponse({
          ok: false,
          error: "FLOW_MEDIA_LOOKUP_BATCH_LIMIT",
          limit: 12,
        });
        return;
      }
      if (!entries.length) {
        sendResponse({ ok: true, media: {} });
        return;
      }
      (async () => {
        try {
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          const tab = await selectFlowStatusTab(tabs);
          const context = describeFlowTab(tab);
          if (
            !tab?.id ||
            !context?.projectId ||
            context.isProjectEditor !== true
          ) {
            sendResponse({ ok: false, error: "NO_PROJECT_OPEN" });
            return;
          }
          if (
            message.projectId &&
            String(context.projectId) !== String(message.projectId)
          ) {
            sendResponse({ ok: false, error: "WRONG_PROJECT" });
            return;
          }
          const media = {},
            target = { tabId: tab.id, ...context },
            groups = new Map();
          for (const entry of entries) {
            const key = entry.apiDriver || "";
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(entry);
          }
          for (const [driver, group] of groups) {
            const lookup = await self.flow_uuid_gateway.resolve(
              group.map((entry) => entry.id),
              {
                projectId: context.projectId,
                expectedFlowTarget: target,
                passive: true,
                purpose: "preview",
                ...(driver && { apiContext: { apiDriver: driver } }),
                ownerRecords: group.map((entry) => ({
                  resultId: entry.id,
                  mediaUuid: entry.id,
                  mediaType: entry.type,
                })),
              },
            );
            for (const entry of group) {
              const verdict = lookup.results[entry.id];
              if (
                verdict?.status === "not_found" ||
                [
                  "type_mismatch",
                  "identity_mismatch",
                  "project_mismatch",
                ].includes(verdict?.reason)
              )
                continue;
              const metadata = verdict?.ok ? verdict.metadata : {};
              let resolved = {
                ok: verdict?.ok === true,
                metadata,
                effectiveMode: lookup.effectiveMode,
                url:
                  entry.type === "video"
                    ? metadata.video_url
                    : metadata.image_url || metadata.thumbnail,
                posterUrl: metadata.source_thumbnail || metadata.thumbnail,
              };
              if (!resolved.url && lookup.legacyActionAvailable === true) {
                resolved = await _flowApiResolveMediaForDownload({
                  mediaId: entry.id,
                  mediaType: entry.type,
                  projectId: context.projectId,
                  flowTabId: tab.id,
                  expectedFlowTarget: target,
                  apiDriver: "v1",
                });
              }
              if (!resolved?.ok || (!resolved.url && !resolved.base64))
                continue;
              const url =
                typeof resolved.url === "string" &&
                resolved.url.startsWith("https://")
                  ? resolved.url
                  : resolved.base64
                    ? `data:${resolved.mime || (entry.type === "video" ? "video/mp4" : "image/jpeg")};base64,${resolved.base64}`
                    : null;
              if (!url) continue;
              const info = resolved.metadata || {},
                native = resolved.effectiveMode === "web";
              media[entry.id] = {
                thumbnail: entry.type === "image" ? url : null,
                ...(entry.type === "video"
                  ? {
                      video_url: url,
                      thumbnail: url,
                      source_thumbnail:
                        resolved.posterUrl ||
                        info.source_thumbnail ||
                        info.thumbnail ||
                        null,
                      type: "video",
                    }
                  : { type: "image" }),
                file_name:
                  info.file_name || info.persistent_media_id || entry.id,
                media_uuid: entry.id,
                persistent_media_id: info.persistent_media_id || entry.id,
                ...(native
                  ? {
                      ...(info.identity_kind && {
                        identity_kind: info.identity_kind,
                      }),
                      ...(info.identity_durability && {
                        identity_durability: info.identity_durability,
                      }),
                    }
                  : {
                      identity_kind: "flow-api-uuid",
                      identity_durability: "durable-resolver",
                    }),
                ...(info.playback_url_source && {
                  playback_url_source: info.playback_url_source,
                }),
              };
            }
          }
          sendResponse({ ok: true, media, projectId: context.projectId });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error?.message || "FLOW_API_MEDIA_RESOLVE_FAILED",
          });
        }
      })();
      return true;
    }
    if (message?.type === "openWorkflowSpaceProvider") {
      if (
        !["flow", "chatgpt", "grok", "gemini", "muse"].includes(
          message.provider,
        )
      ) {
        sendResponse({ ok: false, error: "INVALID_PROVIDER" });
        return false;
      }
      (async () => {
        const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
        if (
          !auth?.user?.id ||
          String(auth.user.id) !== String(message.userId)
        ) {
          sendResponse({ ok: false, error: "ACCOUNT_MISMATCH" });
          return;
        }
        handleCoreRuntimeMessage(
          {
            action: "openProviderTab",
            provider: message.provider,
            focusWindow: false,
          },
          {},
          sendResponse,
        );
      })();
      return true;
    }
    if (message?.type === "openWorkflowSpaceSettings") {
      (async () => {
        const auth = (await chrome.storage.local.get("af_auth")).af_auth;
        if (
          !auth?.token ||
          String(auth?.user?.id || "") !== String(message.userId || "") ||
          !["ai-platform", "flow-api", "max-speed", "storage"].includes(
            message.tab,
          )
        ) {
          sendResponse({ ok: false, error: "SETTINGS_SCOPE_INVALID" });
          return;
        }
        const section =
          message.tab === "ai-platform" &&
          ["flow-api", "max-speed"].includes(message.section)
            ? message.section
            : message.tab;
        await openSettingsWindow(section);
        sendResponse({ ok: true });
      })().catch(() =>
        sendResponse({ ok: false, error: "SETTINGS_OPEN_FAILED" }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceManualSubmit") {
      if (typeof message.manualSubmitMode !== "boolean") {
        sendResponse({ ok: false, error: "INVALID_SETTING" });
        return false;
      }
      readSpaceNativeHealth({
        ...message,
        providers: [],
        flowReadiness: "passive",
      }).then(sendResponse, () =>
        sendResponse({ ok: false, error: "SETTINGS_NOT_READY" }),
      );
      return true;
    }
    if (message?.type === "workflowSpaceHealth") {
      registerSpaceHealthSubscriber(sender);
      if (message.contextOnly === true) {
        readSpaceNativeContext(message).then(sendResponse, () =>
          sendResponse({ ok: false, error: "CONTEXT_STATUS_UNAVAILABLE" }),
        );
        return true;
      }
      if (message.modeOnly === true) {
        readSpaceFlowMode(message).then(
          (flowMode) => sendResponse({ ok: true, flowMode }),
          () => sendResponse({ ok: false, error: "FLOW_MODE_UNAVAILABLE" }),
        );
        return true;
      }
      readSpaceNativeHealth({
        ...message,
        providers: ["flow", "muse"],
        header: true,
        flowReadiness: "passive",
      }).then(sendResponse, () =>
        sendResponse({ ok: false, error: "HEALTH_CHECK_FAILED" }),
      );
      return true;
    }
    if (message?.type === "prepareWorkflowSpaceUpgrade") {
      if (!Number.isInteger(sender.tab?.id)) {
        sendResponse({ ok: false, error: "WEB_TAB_REQUIRED" });
        return false;
      }
      (async () => {
        const windows = await chrome.windows.getAll({
          windowTypes: ["normal"],
        });
        const target =
          windows.find((win) => win.id === sender.tab.windowId) ||
          windows.find((win) => win.focused) ||
          windows[0];
        if (!Number.isInteger(target?.id)) {
          sendResponse({ ok: false, error: "BROWSER_WINDOW_NOT_READY" });
          return;
        }
        _spaceUpgradeWindows.set(sender.tab.id, {
          windowId: target.id,
          documentId: sender.documentId,
          url: sender.url,
        });
        sendResponse({ ok: true });
      })().catch(() =>
        sendResponse({ ok: false, error: "BROWSER_WINDOW_NOT_READY" }),
      );
      return true;
    }
    if (message?.type === "openWorkflowSpaceUpgrade") {
      const target = _spaceUpgradeWindows.get(sender.tab?.id);
      if (
        !target ||
        target.documentId !== sender.documentId ||
        target.url !== sender.url
      ) {
        sendResponse({ ok: false, error: "BROWSER_WINDOW_NOT_READY" });
        return false;
      }
      return openUpgradeSidebar(target.windowId, sendResponse);
    }
    if (message?.type === "openWorkflowSpaceHealth") {
      const windowId = sender.tab?.windowId;
      if (!Number.isInteger(windowId)) {
        sendResponse({ ok: false, error: "WEB_TAB_REQUIRED" });
        return false;
      }
      chrome.sidePanel.open({ windowId }).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false, error: "SIDEBAR_OPEN_FAILED" }),
      );
      return true;
    }
    if (message?.type === "providerStatus") {
      (async () => {
        if (
          message.nativeHealth === true &&
          typeof message.workflowId === "string" &&
          Array.isArray(message.providers)
        ) {
          sendResponse(await readSpaceNativeHealth(message));
          return;
        }
        const requested = Array.isArray(message.providers)
          ? message.providers.filter((p) =>
              ["flow", "chatgpt", "grok", "gemini", "muse"].includes(p),
            )
          : ["flow", "chatgpt", "grok", "gemini", "muse"];
        const out = {};
        await Promise.all(
          [...new Set(requested)].map(async (p) => {
            try {
              if (p === "flow") {
                const probe =
                  typeof message.workflowId === "string"
                    ? await chrome.runtime
                        .sendMessage({
                          action: "workflowSpaceHealthProbe",
                          workflowId: message.workflowId,
                          nodeIds: Array.isArray(message.nodeIds)
                            ? message.nodeIds.filter(
                                (id) => typeof id === "string",
                              )
                            : null,
                        })
                        .catch(() => null)
                    : null;
                if (
                  probe?.ok &&
                  probe.health?.apiMode &&
                  (probe.health.ready || probe.health.required)
                ) {
                  out[p] = { tabOpen: true, ...probe.health };
                  return;
                }
                out[p] = {
                  ...(await getFlowProviderStatusForWeb({
                    prepare: message.flowReadiness === "confirm",
                  })),
                  apiMode: false,
                };
                return;
              }
              const tabQuery = getProviderUrl(p, "tabQuery");
              if (!tabQuery) {
                out[p] = {
                  tabOpen: false,
                  ready: false,
                  error: "URL_CONFIG_UNAVAILABLE",
                };
                return;
              }
              const tabs = await chrome.tabs.query({ url: tabQuery });
              const tab = tabs.find((t) => t.active) || tabs[0];
              if (!tab) {
                out[p] = { tabOpen: false, ready: false, error: "NO_TAB" };
                return;
              }
              if (tab.status === "loading") {
                out[p] = {
                  tabOpen: true,
                  ready: false,
                  checking: true,
                  error: "TAB_LOADING",
                };
                return;
              }
              const health = await new Promise((resolve) =>
                handleCoreRuntimeMessage(
                  {
                    action: `${p}:checkLogin`,
                    tabId: tab.id,
                    waitForComposer: false,
                  },
                  {},
                  resolve,
                ),
              );
              const live = await chrome.tabs.get(tab.id).catch(() => null);
              const sameDocument =
                live?.url === tab.url && live?.status !== "loading";
              out[p] = {
                tabOpen: !!live,
                ready: sameDocument && health?.ready === true,
                error: !sameDocument
                  ? "PROVIDER_TARGET_CHANGED"
                  : health?.error ||
                    (health?.ready === true ? null : "PROVIDER_NOT_READY"),
              };
            } catch (_) {
              out[p] = {
                tabOpen: false,
                ready: false,
                error: "STATUS_CHECK_FAILED",
              };
            }
          }),
        );
        sendResponse({ ok: true, providers: out });
      })().catch(() =>
        sendResponse({ ok: false, error: "STATUS_CHECK_FAILED" }),
      );
      return true;
    }
    if (message?.type === "listFlowCharacters") {
      (async () => {
        try {
          const res = await chrome.storage.local.get([
            "toby_provider_characters_scraped",
          ]);
          const wrap = res?.toby_provider_characters_scraped;
          const list = Array.isArray(wrap?.data)
            ? wrap.data
            : Array.isArray(wrap)
              ? wrap
              : [];
          const characters = list
            .map((c) => ({
              slug: c?.slug || null,
              name: c?.name || c?.search_value || "",
              search_value: c?.search_value || c?.name || "",
              thumbnail: c?.thumbnail_url || null,
            }))
            .filter((c) => c.slug && c.search_value)
            .slice(0, 300);
          sendResponse({ ok: true, characters });
        } catch (e) {
          sendResponse({ ok: false, error: "EXCEPTION", message: e.message });
        }
      })();
      return true;
    }
    if (message?.type === "listFlowVoices") {
      (async () => {
        try {
          const res = await chrome.storage.local.get([
            "toby_provider_voices_scraped",
          ]);
          const wrap = res?.toby_provider_voices_scraped;
          const voices = Array.isArray(wrap?.data)
            ? wrap.data
            : Array.isArray(wrap)
              ? wrap
              : [];
          sendResponse({
            ok: true,
            voices: voices
              .filter((voice) => voice?.slug && voice?.search_value)
              .slice(0, 300),
          });
        } catch (e) {
          sendResponse({ ok: false, error: "EXCEPTION", message: e.message });
        }
      })();
      return true;
    }
    if (
      message?.type === "syncFlowVoices" ||
      message?.type === "syncFlowCharacters"
    ) {
      (async () => {
        try {
          sendResponse(
            await syncFlowComponentsForSpace(
              message.type === "syncFlowVoices" ? "voice" : "character",
            ),
          );
        } catch (e) {
          sendResponse({ ok: false, error: "EXCEPTION", message: e.message });
        }
      })();
      return true;
    }
    if (message?.type === "downloadWorkflowMedia") {
      (async () => {
        try {
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          const tab = await selectFlowStatusTab(tabs);
          const context = describeFlowTab(tab);
          if (
            !tab?.id ||
            !context?.projectId ||
            context.isProjectEditor !== true
          ) {
            sendResponse({ ok: false, error: "NO_PROJECT_OPEN" });
            return;
          }
          if (
            message.projectId &&
            String(message.projectId) !== String(context.projectId)
          ) {
            sendResponse({ ok: false, error: "WRONG_PROJECT" });
            return;
          }
          const requestId = /^[0-9a-f-]{36}$/i.test(message.requestId || "")
              ? message.requestId
              : crypto.randomUUID(),
            startedAt = Date.now();
          console.info("[SpaceLegacyDownload]", {
            requestId,
            stage: "target_selected",
            tabId: tab.id,
            active: tab.active === true,
          });
          if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
          const live = await chrome.tabs.get(tab.id).catch(() => null),
            after = describeFlowTab(live);
          if (
            !live ||
            after?.isProjectEditor !== true ||
            ["projectId", "origin", "driverKey", "routePrefix"].some(
              (key) => (after?.[key] || null) !== (context?.[key] || null),
            )
          ) {
            console.info("[SpaceLegacyDownload]", {
              requestId,
              stage: "target_changed",
              elapsedMs: Date.now() - startedAt,
            });
            sendResponse({
              ok: false,
              error: "FLOW_EXECUTION_TARGET_CHANGED",
              requestId,
            });
            return;
          }
          console.info("[SpaceLegacyDownload]", {
            requestId,
            stage: "content_dispatched",
            elapsedMs: Date.now() - startedAt,
          });
          const result = await chrome.tabs
            .sendMessage(tab.id, {
              action: "downloadTileMedia",
              requestId,
              _flowTarget: { tabId: tab.id, ...context },
              flowDomFocusOwnerTabId: sender.tab?.id ?? null,
              tileId: String(message.tileId || ""),
              promptText: String(message.promptText || ""),
              taskName: String(message.taskName || ""),
              fileName: message.fileName || null,
              resolution: message.resolution || null,
              flowFileId: message.flowFileId || null,
              index: Number(message.index) || 0,
              videoResolution: message.videoResolution || null,
              watermarkMode: message.watermarkMode || "inherit",
              plannedFilename: message.plannedFilename || null,
            })
            .catch(() => null);
          if (!result) {
            console.info("[SpaceLegacyDownload]", {
              requestId,
              stage: "content_ack_missing",
              elapsedMs: Date.now() - startedAt,
            });
            sendResponse({
              ok: false,
              error: "FLOW_CONTENT_NOT_READY",
              requestId,
              acknowledged: false,
              dispatchStarted: true,
            });
            return;
          }
          console.info("[SpaceLegacyDownload]", {
            requestId,
            stage: "content_ack",
            success: result.success === true,
            elapsedMs: Date.now() - startedAt,
            code: /^[A-Z0-9_]{1,80}$/.test(result.error || "")
              ? result.error
              : null,
          });
          sendResponse({ ...result, ok: result.success === true, requestId });
        } catch (e) {
          sendResponse({ ok: false, error: "EXCEPTION", message: e.message });
        }
      })();
      return true;
    }
    if (message?.type === "runWorkflow" || message?.type === "runNode") {
      const wfId = String(message.workflowId || message.wfId || "").trim();
      const nodeId =
        message.type === "runNode" ? String(message.nodeId || "").trim() : null;
      const manualSubmitMode = message.manualSubmitMode === true;
      const onlyNodeIds = Array.isArray(message.onlyNodeIds)
        ? message.onlyNodeIds.map((x) => String(x)).filter(Boolean)
        : null;
      let groupReset = null;
      if (message.groupReset != null) {
        const proof = message.groupReset;
        if (
          message.type !== "runWorkflow" ||
          !onlyNodeIds?.length ||
          !proof ||
          typeof proof.grant !== "string" ||
          !proof.grant ||
          proof.grant.length > 1e5 ||
          typeof proof.operationId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(proof.operationId) ||
          !Array.isArray(proof.nodeIds) ||
          proof.nodeIds.length !== onlyNodeIds.length ||
          ![...proof.nodeIds]
            .sort()
            .every(
              (id, index) =>
                typeof id === "string" && id === [...onlyNodeIds].sort()[index],
            )
        ) {
          sendResponse({
            ok: false,
            error: "INVALID_RESET_SCOPE",
            dispatchStarted: false,
          });
          return;
        }
        groupReset = {
          operationId: proof.operationId,
          nodeIds: [...proof.nodeIds],
          grant: proof.grant,
          origin: new URL(sender.origin || sender.url).origin,
        };
      }
      if (!wfId) {
        sendResponse({ ok: false, error: "NO_WORKFLOW_ID" });
        return;
      }
      if (message.type === "runNode" && !nodeId) {
        sendResponse({ ok: false, error: "NO_NODE_ID" });
        return;
      }
      (async () => {
        try {
          const actor = await readWorkflowCommandActor(message);
          const stored = await chrome.storage.local.get([
            "af_running_workflow",
          ]);
          const flag = stored?.af_running_workflow;
          await actor.assertCurrent();
          const alive =
            flag &&
            Date.now() - (flag.last_heartbeat_at || flag.started_at || 0) <
              5 * 60 * 1e3;
          if (alive) actor.assertFlag(flag);
          if (
            alive &&
            message.type === "runNode" &&
            flag.wf_id === wfId &&
            flag.executor_context === "single_nodes"
          ) {
            const response = await chrome.runtime.sendMessage({
              action: "workflow:single_node",
              workflowId: wfId,
              nodeId,
              runId: flag.run_id,
              options: { manualSubmitMode, actorUserId: actor.userId },
            });
            sendResponse(
              response?.accepted
                ? response
                : {
                    ok: false,
                    error: response?.error || "SINGLE_NODE_OWNER_UNAVAILABLE",
                  },
            );
            return;
          }
          if (alive) {
            sendResponse({
              ok: false,
              error: "BUSY",
              wf_id: flag.wf_id,
              wf_name: flag.wf_name || null,
            });
            return;
          }
          const opened = await openRunWindow(wfId, nodeId, {
            manualSubmitMode,
            onlyNodeIds,
            groupReset,
            actorUserId: actor.userId,
            assertCurrent: actor.assertCurrent,
            source: captureWorkflowRunSource(sender, wfId, actor.userId),
          });
          if (!opened) {
            sendResponse({ ok: false, error: "RUN_WINDOW_OPENING" });
            return;
          }
          sendResponse({
            ok: true,
            accepted: true,
            execution_mode: nodeId ? "single_nodes" : "workflow",
          });
        } catch (err) {
          console.error("[Background] runWorkflow error:", err.message);
          sendResponse({
            ok: false,
            error: err.code || "EXCEPTION",
            message: err.message,
          });
        }
      })();
      return true;
    }
    if (message?.type === "stopNode") {
      (async () => {
        try {
          const actor = await readWorkflowCommandActor(message);
          const { af_running_workflow: flag } = await chrome.storage.local.get([
            "af_running_workflow",
          ]);
          await actor.assertCurrent();
          actor.assertFlag(flag);
          if (
            message.operationId != null &&
            message[_spaceCommandTarget] &&
            String(flag?.run_id || "") !== String(message[_spaceCommandTarget])
          )
            throw Error("SPACE_COMMAND_TARGET_CHANGED");
          const wfId = String(message.workflowId || "");
          const nodeId = String(message.nodeId || "");
          if (
            !nodeId ||
            flag?.wf_id !== wfId ||
            flag?.executor_context !== "single_nodes"
          ) {
            sendResponse({ ok: false, error: "SINGLE_NODE_SESSION_NOT_FOUND" });
            return;
          }
          const targetJobId =
            message.operationId != null ? message[_spaceCommandJob] : null;
          if (
            targetJobId &&
            flag.single_node_states?.find(
              (node) => String(node.nodeId) === nodeId,
            )?.jobId !== targetJobId
          )
            throw Error("SPACE_COMMAND_TARGET_CHANGED");
          const response = await chrome.runtime.sendMessage(
            targetJobId
              ? {
                  action: "queue:stop_job",
                  jobId: targetJobId,
                  stopSource: "WEB_WORKFLOW_NODE_STOP",
                }
              : {
                  action: "workflow:stop_single_node",
                  workflowId: wfId,
                  nodeId,
                  runId: flag.run_id,
                  stopSource: "WEB_WORKFLOW_NODE_STOP",
                },
          );
          sendResponse(
            response || { ok: false, error: "SINGLE_NODE_OWNER_UNAVAILABLE" },
          );
        } catch (error) {
          sendResponse({ ok: false, error: error.code || error.message });
        }
      })();
      return true;
    }
    if (message?.type === "stopWorkflow") {
      const wfId = String(message.workflowId || message.wfId || "").trim();
      const eventName = "execution:stop";
      (async () => {
        const actor = await readWorkflowCommandActor(message);
        const { af_running_workflow: flag } = await chrome.storage.local.get(
          "af_running_workflow",
        );
        await actor.assertCurrent();
        actor.assertFlag(flag);
        if (
          message.operationId != null &&
          message[_spaceCommandTarget] &&
          String(flag?.run_id || "") !== String(message[_spaceCommandTarget])
        )
          throw Error("SPACE_COMMAND_TARGET_CHANGED");
        if (!wfId || (flag?.wf_id && flag.wf_id !== wfId))
          return { ok: false, error: "WORKFLOW_NOT_RUNNING" };
        await chrome.runtime.sendMessage({
          action: "workflowExecutionEvent",
          event: eventName,
          data: {
            wf_id: wfId,
            run_id: flag?.run_id || null,
            force: message.force === true,
            stopSource:
              message.force === true
                ? "WEB_WORKFLOW_FORCE_STOP"
                : "WEB_WORKFLOW_STOP",
          },
        });
        return { ok: true };
      })().then(sendResponse, (error) =>
        sendResponse({ ok: false, error: error.code || error.message }),
      );
      return true;
    }
    if (message?.type === "workflowStatus") {
      (async () => {
        try {
          const actor = await readWorkflowCommandActor(message);
          const stored = await chrome.storage.local.get([
            "af_running_workflow",
          ]);
          const flag = stored?.af_running_workflow;
          await actor.assertCurrent();
          const alive =
            flag &&
            Date.now() - (flag.last_heartbeat_at || flag.started_at || 0) <
              5 * 60 * 1e3;
          if (alive) actor.assertFlag(flag);
          sendResponse({
            ok: true,
            running: !!alive,
            wf_id: alive ? flag.wf_id : null,
            wf_name: alive ? flag.wf_name || null : null,
            started_at: alive ? flag.started_at || null : null,
            execution_mode:
              alive && flag.executor_context === "single_nodes"
                ? "single_nodes"
                : "workflow",
            single_node_states: alive ? flag.single_node_states || [] : [],
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e.code || "EXCEPTION",
            message: e.message,
          });
        }
      })();
      return true;
    }
    if (message?.type === "currentProject") {
      (async () => {
        try {
          if (message.spaceHealth === true) {
            registerSpaceHealthSubscriber(sender);
            const tabs2 = await chrome.tabs.query({
              url: getFlowTabQueryPatterns(),
            });
            const tab2 = await selectFlowStatusTab(tabs2);
            const reload = (
              await chrome.storage.session.get("flowReloadUiState")
            )?.flowReloadUiState;
            const base = {
              syncing:
                reload?.active === true &&
                Date.now() - Number(reload.at) >= 0 &&
                Date.now() - Number(reload.at) < 3e5,
              syncStage: reload?.stage || null,
            };
            if (!tab2?.id) {
              sendResponse({
                ok: true,
                tabOpen: false,
                projectId: null,
                ...base,
              });
              return;
            }
            const before = describeFlowTab(tab2);
            if (tab2.status === "loading") {
              sendResponse({
                ok: true,
                tabOpen: true,
                ...buildFlowProjectContext(tab2, null),
                loading: true,
                ...base,
              });
              return;
            }
            const response = await chrome.tabs
              .sendMessage(tab2.id, {
                action: "getProjectContext",
                _flowTarget: before,
              })
              .catch(() => null);
            const liveTab = await chrome.tabs.get(tab2.id).catch(() => null);
            const after = describeFlowTab(liveTab);
            const changed =
              !liveTab ||
              before?.projectId !== after?.projectId ||
              before?.origin !== after?.origin;
            const context = buildFlowProjectContext(
              liveTab,
              changed ? null : response,
            );
            sendResponse({
              ok: true,
              tabOpen: !!liveTab,
              ...context,
              loading: liveTab?.status === "loading",
              ...base,
            });
            return;
          }
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          const target = (await chrome.storage.session.get("targetFlowTabId"))
            ?.targetFlowTabId;
          const tab = selectFlowTab(
            tabs.filter(
              (t) =>
                describeFlowTab(t)?.projectId &&
                parseFlowV2Path(new URL(t.url).pathname)?.isProjectEditor,
            ),
            target,
          );
          if (!tab) {
            sendResponse({
              ok: true,
              tabOpen: false,
              projectId: null,
              projectName: null,
            });
            return;
          }
          const ctx = await new Promise((resolve) => {
            chrome.tabs.sendMessage(
              tab.id,
              {
                action: "getProjectContext",
                _flowTarget: describeFlowTab(tab),
              },
              (r) => {
                void chrome.runtime.lastError;
                resolve(r || null);
              },
            );
          });
          sendResponse({
            ok: true,
            tabOpen: true,
            projectId: ctx?.projectId || null,
            projectName: ctx?.projectName || null,
            projectError: !ctx || !!ctx.error || !!ctx.projectError,
          });
        } catch (e) {
          sendResponse({ ok: false, error: "EXCEPTION", message: e.message });
        }
      })();
      return true;
    }
    if (message?.type === "listFlowLibrary") {
      (async () => {
        try {
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          const target = (await chrome.storage.session.get("targetFlowTabId"))
            ?.targetFlowTabId;
          const tab = selectFlowTab(
            tabs.filter(
              (t) =>
                describeFlowTab(t)?.projectId &&
                parseFlowV2Path(new URL(t.url).pathname)?.isProjectEditor,
            ),
            target,
          );
          if (!tab) {
            sendResponse({ ok: false, error: "NO_FLOW_TAB" });
            return;
          }
          let previousTabId = null;
          if (!tab.active) {
            try {
              const [cur] = await chrome.tabs.query({
                active: true,
                windowId: tab.windowId,
              });
              previousTabId = cur?.id || null;
              await chrome.tabs.update(tab.id, { active: true });
              await new Promise((r2) => setTimeout(r2, 600));
            } catch (_) {}
          }
          let r;
          try {
            r = await _sendFlowMetadataRead(tab.id, {
              action: "scanFlowImages",
              deep: false,
              _flowTarget: describeFlowTab(tab),
            });
          } finally {
            if (previousTabId) {
              try {
                const [current] = await chrome.tabs.query({
                  active: true,
                  windowId: tab.windowId,
                });
                if (current?.id === tab.id)
                  await chrome.tabs.update(previousTabId, { active: true });
              } catch (_) {}
            }
          }
          if (!r || r.error) {
            sendResponse({ ok: false, error: r?.error || "SCAN_FAILED" });
            return;
          }
          const images = (Array.isArray(r.images) ? r.images : [])
            .slice(0, 300)
            .map((x) => ({
              file_id: x.fileId || null,
              file_name: x.file_name || null,
              display_name: x.display_name || null,
              thumbnail:
                x.thumbnail ||
                x.source_thumbnail ||
                (x.type === "video" ? null : x.image_url) ||
                null,
              image_url: x.type === "video" ? null : x.image_url || null,
              source_thumbnail: x.source_thumbnail || null,
              video_url: x.type === "video" ? x.video_url || null : null,
              project_id: x.project_id || r.projectId || null,
              type: x.type || "image",
              media_uuid: x.media_uuid || null,
              persistent_media_id: x.persistent_media_id || null,
              identity_kind: x.identity_kind || null,
              identity_durability: x.identity_durability || null,
            }))
            .filter(
              (x) =>
                x.file_id &&
                (message.includePlaceholders === true ||
                  x.thumbnail ||
                  x.type === "video"),
            );
          sendResponse({
            ok: true,
            images,
            projectId: r.projectId || null,
            catalogStatus: r.catalogStatus || null,
          });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e.code || "EXCEPTION",
            message: e.message,
          });
        }
      })();
      return true;
    }
    if (message?.type === "uploadToFlow") {
      const spaceOwnerTabId =
        sender.frameId === 0 &&
        /^https:\/\/(?:labs\.toby\.vn|tobyflow\.com)\/app\/spaces\/[^/?#]+(?:[?#]|$)/.test(
          sender.url || "",
        )
          ? sender.tab?.id
          : null;
      doUploadToFlow(message, {
        externalMcpUpload: true,
        spaceOwnerTabId,
      }).then(sendResponse);
      return true;
    }
    sendResponse({ ok: false, error: "UNKNOWN_TYPE" });
  },
);
let _runWindowId = null;
let _runWindowOpening = false;
let _runWindowCloseFlight = null;
let _runWindowAdmissionEpoch = 0;
let _webSpacesWindowId = null;
const _runLogOpenFlights = new Map();
const _runLogWindows = new Map();
async function openWorkflowRunLog(message, sender) {
  const workflowId = message.workflowId,
    userId = String(message.userId || "");
  let source;
  try {
    source = new URL(sender.url);
  } catch (_) {
    return { ok: false, error: "INVALID_LOG_SCOPE" };
  }
  if (
    sender.frameId !== 0 ||
    !sender.tab?.id ||
    typeof workflowId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,255}$/.test(workflowId) ||
    !["https://local.566flow.invalid", "https://566flow.invalid"].includes(source.origin) ||
    source.pathname.replace(/\/$/, "") !== `/app/spaces/${workflowId}`
  )
    return { ok: false, error: "INVALID_LOG_SCOPE" };
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  if (!auth?.token || !userId || String(auth.user?.id || "") !== userId)
    return { ok: false, error: "RUN_LOG_ACCOUNT_MISMATCH" };
  const key = `${userId}:${workflowId}`;
  if (_runLogOpenFlights.has(key)) return _runLogOpenFlights.get(key);
  const flight = (async () => {
    const current = async () => {
      const value = (await chrome.storage.local.get("af_auth")).af_auth;
      if (
        value?.token !== auth.token ||
        String(value?.user?.id || "") !== userId
      )
        throw Error("RUN_LOG_ACCOUNT_CHANGED");
    };
    const base = chrome.runtime.getURL("run-window.html"),
      viewerBase = chrome.runtime.getURL("run-log.html"),
      contexts = await chrome.runtime.getContexts({});
    contexts.sort(
      (a, b) => Number(b.documentUrl === base) - Number(a.documentUrl === base),
    );
    for (const context of contexts) {
      if (
        !context.documentId ||
        ![base, viewerBase].some((url3) =>
          context.documentUrl?.startsWith(url3),
        )
      )
        continue;
      const url2 = new URL(context.documentUrl);
      if (
        ![new URL(base).pathname, new URL(viewerBase).pathname].includes(
          url2.pathname,
        )
      )
        continue;
      let matched =
        url2.searchParams.get("logWorkflow") === workflowId &&
        url2.searchParams.get("logUser") === userId;
      if (url2.pathname === new URL(base).pathname && !url2.search) {
        const response = await chrome.runtime
          .sendMessage({
            action: "workflowSpaceShowRunLog",
            documentId: context.documentId,
            workflowId,
            userId,
          })
          .catch(() => null);
        matched = response?.ok === true;
      }
      if (!matched) continue;
      await current();
      if (context.tabId >= 0)
        await chrome.tabs.update(context.tabId, { active: true });
      const existing = await chrome.windows.get(context.windowId);
      await chrome.windows.update(context.windowId, {
        focused: true,
        ...(existing.state === "minimized" ? { state: "normal" } : {}),
      });
      if (url2.pathname === new URL(viewerBase).pathname)
        _runLogWindows.set(key, context.windowId);
      return { ok: true, reused: true };
    }
    const knownWindow = _runLogWindows.get(key);
    if (knownWindow) {
      let alive;
      try {
        alive = await chrome.windows.get(knownWindow);
      } catch (_) {
        _runLogWindows.delete(key);
      }
      if (alive) {
        await current();
        await chrome.windows.update(knownWindow, {
          focused: true,
          ...(alive.state === "minimized" ? { state: "normal" } : {}),
        });
        return { ok: true, reused: true };
      }
    }
    await current();
    const url = new URL(viewerBase);
    url.searchParams.set("logWorkflow", workflowId);
    url.searchParams.set("logUser", userId);
    const pos = await _calcWindowPosition(520, 720);
    await current();
    const opened = await chrome.windows.create({
      url: url.href,
      type: "popup",
      width: 520,
      height: 720,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    _runLogWindows.set(key, opened.id);
    return { ok: true, reused: false };
  })();
  _runLogOpenFlights.set(key, flight);
  try {
    return await flight;
  } finally {
    if (_runLogOpenFlights.get(key) === flight) _runLogOpenFlights.delete(key);
  }
}
async function closeSettledRunHost(message, sender) {
  const admissionEpoch = _runWindowAdmissionEpoch;
  const deny = (reason) => ({ ok: false, reason });
  const hostUrl = chrome.runtime.getURL("run-window.html");
  if (
    sender.id !== chrome.runtime.id ||
    !sender.documentId ||
    sender.url?.split(/[?#]/)[0] !== hostUrl ||
    !Number.isInteger(sender.tab?.windowId) ||
    !Number.isInteger(sender.tab?.id) ||
    !Number.isSafeInteger(message.runEpoch) ||
    !message.workflowId ||
    !message.userId ||
    !Number.isSafeInteger(message.receiptRevision) ||
    typeof chrome.runtime.getContexts !== "function"
  )
    return deny("INVALID_CLOSE_SCOPE");
  if (_runWindowOpening || _runWindowCloseFlight)
    return deny("RUN_REQUEST_PENDING");
  const stored = await chrome.storage.local.get([
    "af_auth",
    "af_system_settings",
    "_pendingRunWorkflow",
  ]);
  const auth = stored.af_auth,
    timeoutMs = Number(stored.af_system_settings?.api_timeout_ms);
  if (!auth?.token || String(auth.user?.id) !== String(message.userId))
    return deny("ACCOUNT_MISMATCH");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    return deny("TIMEOUT_CONFIG_UNAVAILABLE");
  if (stored._pendingRunWorkflow) return deny("RUN_REQUEST_PENDING");
  let timer, probe;
  try {
    probe = await Promise.race([
      chrome.runtime.sendMessage({
        action: "workflowRunHostCloseProbe",
        documentId: sender.documentId,
        workflowId: message.workflowId,
        userId: message.userId,
        runEpoch: message.runEpoch,
        receiptRevision: message.receiptRevision,
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (probe?.ok !== true) return deny("HOST_NOT_SETTLED");
  const contexts = await chrome.runtime.getContexts({});
  const serviceUrls = ["sidebar.html", "workflow-editor.html"].map((path) =>
    chrome.runtime.getURL(path),
  );
  if (
    !contexts.some(
      (context) =>
        context.documentId === message.serviceDocumentId &&
        context.documentId !== sender.documentId &&
        serviceUrls.includes(
          String(context.documentUrl || "").split(/[?#]/)[0],
        ),
    )
  )
    return deny("NATIVE_CONTEXT_REQUIRED");
  const win = await chrome.windows
    .get(sender.tab.windowId, { populate: true })
    .catch(() => null);
  if (
    win?.type !== "popup" ||
    win.tabs?.length !== 1 ||
    win.tabs[0].id !== sender.tab.id ||
    win.tabs[0].url?.split(/[?#]/)[0] !== hostUrl
  )
    return deny("HOST_WINDOW_CHANGED");
  const latest = await chrome.storage.local.get([
    "af_auth",
    "_pendingRunWorkflow",
    "af_running_workflow",
  ]);
  if (
    !latest.af_auth?.token ||
    latest.af_auth.token !== auth.token ||
    String(latest.af_auth.user?.id) !== String(message.userId)
  )
    return deny("ACCOUNT_CHANGED");
  if (latest._pendingRunWorkflow || _runWindowOpening)
    return deny("RUN_REQUEST_PENDING");
  const flag = latest.af_running_workflow;
  if (
    flag &&
    Date.now() - (flag.last_heartbeat_at || flag.started_at || 0) < 5 * 60 * 1e3
  )
    return deny("EXECUTION_STILL_ACTIVE");
  const journals = await chrome.storage.session.get(null);
  if (
    Object.entries(journals).some(
      ([key, value]) =>
        key.startsWith("workflow_space_") &&
        key.split(":")[1] === String(message.userId) &&
        value?.documentId === sender.documentId &&
        !value.response,
    )
  )
    return deny("HOST_RECEIPT_PENDING");
  if (
    _runWindowOpening ||
    _runWindowCloseFlight ||
    admissionEpoch !== _runWindowAdmissionEpoch
  )
    return deny("RUN_REQUEST_PENDING");
  const closing = (async () => {
    await chrome.windows.remove(win.id);
    if (_runWindowId === win.id) _runWindowId = null;
    _extensionPopupWindows.delete(win.id);
    const session = await chrome.storage.session.get("_runWindowId");
    if (session._runWindowId === win.id)
      await chrome.storage.session.remove("_runWindowId");
    return { ok: true };
  })();
  _runWindowCloseFlight = closing;
  try {
    return await closing;
  } finally {
    if (_runWindowCloseFlight === closing) _runWindowCloseFlight = null;
  }
}
async function readWorkflowCommandActor(message) {
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  const userId = String(auth?.user?.id || "");
  const mismatch = () =>
    Object.assign(new Error("ACCOUNT_SCOPE_CHANGED"), {
      code: "ACCOUNT_SCOPE_CHANGED",
    });
  if (
    !auth?.token ||
    !userId ||
    (message.userId != null && String(message.userId) !== userId)
  )
    throw mismatch();
  return {
    userId,
    assertFlag(flag) {
      if (flag?.owner_user_id && String(flag.owner_user_id) !== userId)
        throw mismatch();
    },
    async assertCurrent() {
      const current = (await chrome.storage.local.get("af_auth")).af_auth;
      if (
        !current?.token ||
        current.token !== auth.token ||
        String(current.user?.id || "") !== userId
      )
        throw mismatch();
    },
  };
}
function captureWorkflowRunSource(sender, workflowId, userId) {
  try {
    const url = new URL(sender?.url);
    const route = url.pathname.match(/^\/app\/spaces\/([^/]+)\/?$/);
    if (
      sender.frameId !== 0 ||
      !Number.isInteger(sender.tab?.id) ||
      !["https://local.566flow.invalid", "https://566flow.invalid"].includes(url.origin) ||
      (sender.origin && sender.origin !== url.origin) ||
      !route ||
      decodeURIComponent(route[1]) !== workflowId
    )
      return null;
    return { tabId: sender.tab.id, workflowId, userId: String(userId) };
  } catch (_) {
    return null;
  }
}
async function resolveWorkflowWorkerSource(message, sender) {
  if (
    message.sourceSurface !== "workflow" ||
    sender.url?.split(/[?#]/)[0] !== chrome.runtime.getURL("run-window.html")
  )
    return message;
  try {
    const binding = (
      await chrome.storage.session.get("workflow_space_worker_source")
    ).workflow_space_worker_source;
    if (!binding || binding.userId !== String(message.userId)) return message;
    const data = await ProviderWebQueueStore.getRun(message.runId);
    if (
      data?.run?.source !== "workflow" ||
      data.run.workflowId !== binding.workflowId ||
      String(data.run.userId) !== binding.userId
    )
      return message;
    const tab = await chrome.tabs.get(binding.tabId).catch(() => null);
    const current =
      tab &&
      captureWorkflowRunSource(
        { url: tab.url, frameId: 0, tab },
        binding.workflowId,
        binding.userId,
      );
    if (!current || !Number.isInteger(tab.windowId)) {
      console.warn("[WorkflowSpaceWorker] source_unavailable", {
        runId: message.runId,
        sourceTabId: binding.tabId,
      });
      return message;
    }
    let screen = null;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          screenLeft: window.screen.availLeft,
          screenTop: window.screen.availTop,
          screenWidth: window.screen.availWidth,
          screenHeight: window.screen.availHeight,
        }),
      });
      screen = results?.[0]?.result;
    } catch (_) {}
    const resolved = {
      ...message,
      sourceWindowId: tab.windowId,
      screenLeft: Number.isSafeInteger(screen?.screenLeft)
        ? screen.screenLeft
        : null,
      screenTop: Number.isSafeInteger(screen?.screenTop)
        ? screen.screenTop
        : null,
      screenWidth:
        Number.isSafeInteger(screen?.screenWidth) && screen.screenWidth > 100
          ? screen.screenWidth
          : null,
      screenHeight:
        Number.isSafeInteger(screen?.screenHeight) && screen.screenHeight > 100
          ? screen.screenHeight
          : null,
    };
    console.info("[WorkflowSpaceWorker] source_resolved", {
      runId: message.runId,
      provider: message.provider,
      sourceTabId: tab.id,
      sourceWindowId: tab.windowId,
      hostWindowId: sender.tab?.windowId ?? null,
      screenWidth: resolved.screenWidth,
      screenHeight: resolved.screenHeight,
    });
    return resolved;
  } catch (error) {
    console.warn("[WorkflowSpaceWorker] source_lookup_failed", {
      runId: message.runId,
      code: error?.message,
    });
    return message;
  }
}
async function openRunWindow(wfId, nodeId = null, opts = {}) {
  if (_runWindowCloseFlight) await _runWindowCloseFlight.catch(() => {});
  await opts.assertCurrent?.();
  if (_runWindowOpening) return false;
  _runWindowOpening = true;
  _runWindowAdmissionEpoch++;
  try {
    try {
      if (opts.source)
        await chrome.storage.session.set({
          workflow_space_worker_source: opts.source,
        });
      else await chrome.storage.session.remove("workflow_space_worker_source");
    } catch (error) {
      console.warn("[WorkflowSpaceWorker] source_binding_failed", {
        code: error?.message,
      });
    }
    await chrome.storage.local.set({
      _pendingRunWorkflow: {
        wfId,
        nodeId,
        timestamp: Date.now(),
        ...(opts.actorUserId != null
          ? { actorUserId: String(opts.actorUserId) }
          : {}),
        manualSubmitMode: opts.manualSubmitMode === true,
        onlyNodeIds:
          Array.isArray(opts.onlyNodeIds) && opts.onlyNodeIds.length
            ? opts.onlyNodeIds
            : null,
        ...(opts.groupReset ? { groupReset: opts.groupReset } : {}),
      },
    });
    let wid = _runWindowId;
    if (!wid) {
      try {
        wid =
          (await chrome.storage?.session?.get(["_runWindowId"]))
            ?._runWindowId || null;
      } catch (_) {}
    }
    if (wid) {
      try {
        const win2 = await chrome.windows.get(wid);
        if (win2) {
          _runWindowId = wid;
          try {
            chrome.runtime.sendMessage(
              { action: "loadRunWorkflow" },
              () => void chrome.runtime.lastError,
            );
          } catch (_) {}
          try {
            await chrome.windows.update(wid, { focused: false });
          } catch (_) {}
          return true;
        }
      } catch (_) {
        _runWindowId = null;
      }
    }
    const pos = await _calcWindowPosition(520, 720);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("run-window.html"),
      type: "popup",
      width: 520,
      height: 720,
      left: pos.left,
      top: pos.top,
      focused: false,
    });
    _runWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
    try {
      await chrome.storage.session.set({ _runWindowId: win.id });
    } catch (_) {}
    return true;
  } catch (e) {
    console.error("[Background] openRunWindow failed:", e.message);
    try {
      await chrome.storage.local.remove("_pendingRunWorkflow");
    } catch (_) {}
    throw e;
  } finally {
    _runWindowOpening = false;
  }
}
let _templateWindowOpening = false;
async function openTemplateEditorWindow(templateData) {
  if (_templateWindowOpening) return;
  if (templateWindowId !== null) {
    try {
      const win = await chrome.windows.get(templateWindowId);
      if (win) {
        chrome.windows.update(templateWindowId, { focused: true });
        if (templateData) {
          await chrome.storage.local.set({ _pendingTemplate: templateData });
          chrome.runtime.sendMessage({
            action: "loadTemplateInEditor",
            data: templateData,
          });
        }
        return;
      }
    } catch (e) {
      templateWindowId = null;
      _persistWindowIds();
    }
  }
  if (templateWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(["_templateWindowId"]);
      if (stored?._templateWindowId) {
        const win = await chrome.windows.get(stored._templateWindowId);
        if (win) {
          templateWindowId = stored._templateWindowId;
          _extensionPopupWindows.add(templateWindowId);
          chrome.windows.update(templateWindowId, { focused: true });
          if (templateData) {
            await chrome.storage.local.set({ _pendingTemplate: templateData });
            chrome.runtime.sendMessage({
              action: "loadTemplateInEditor",
              data: templateData,
            });
          }
          return;
        }
      }
    } catch (e) {}
  }
  _templateWindowOpening = true;
  try {
    if (templateData && templateData.nodes) {
      await chrome.storage.local.set({ _pendingTemplate: templateData });
    } else if (!templateData) {
      await chrome.storage.local.remove("_pendingTemplate");
    }
    let winWidth = 1440;
    let winHeight = 900;
    try {
      const flowTabs = await chrome.tabs.query({
        url: getFlowTabQueryPatterns(),
      });
      if (flowTabs.length > 0 && flowTabs[0].windowId) {
        const flowWin = await chrome.windows.get(flowTabs[0].windowId);
        if (flowWin?.width && flowWin?.height) {
          const targetW = Math.round(flowWin.width * 0.9);
          const targetH = Math.round(flowWin.height * 0.9);
          if (targetW > winWidth) winWidth = targetW;
          if (targetH > winHeight) winHeight = targetH;
          console.log(
            "[Background] Template editor window size:",
            winWidth,
            "x",
            winHeight,
          );
        }
      }
    } catch (sizeErr) {
      console.warn(
        "[Background] Failed to read Flow window size:",
        sizeErr.message,
      );
    }
    let url = "workflow-template-editor.html";
    if (templateData?.mode) {
      const params = new URLSearchParams();
      params.set("mode", templateData.mode);
      if (templateData.templateId) {
        params.set("templateId", String(templateData.templateId));
      }
      url += "?" + params.toString();
    }
    const pos = await _calcWindowPosition(winWidth, winHeight);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(url),
      type: "popup",
      width: winWidth,
      height: winHeight,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    templateWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _templateWindowOpening = false;
  }
}
let _anglesWindowOpening = false;
async function openAnglesWindow() {
  if (_anglesWindowOpening) return;
  if (anglesWindowId !== null) {
    try {
      const win = await chrome.windows.get(anglesWindowId);
      if (win) {
        chrome.windows.update(anglesWindowId, { focused: true });
        return;
      }
    } catch (e) {
      anglesWindowId = null;
      _persistWindowIds();
    }
  }
  if (anglesWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(["_anglesWindowId"]);
      if (stored?._anglesWindowId) {
        const win = await chrome.windows.get(stored._anglesWindowId);
        if (win) {
          anglesWindowId = stored._anglesWindowId;
          _extensionPopupWindows.add(anglesWindowId);
          chrome.windows.update(anglesWindowId, { focused: true });
          return;
        }
      }
    } catch (e) {}
  }
  _anglesWindowOpening = true;
  try {
    const pos = await _calcWindowPosition(1200, 950);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("angles-editor.html"),
      type: "popup",
      width: 1200,
      height: 950,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    anglesWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _anglesWindowOpening = false;
  }
}
let _effectsWindowOpening = false;
async function openEffectsWindow() {
  if (_effectsWindowOpening) return;
  if (effectsWindowId !== null) {
    try {
      const win = await chrome.windows.get(effectsWindowId);
      if (win) {
        chrome.windows.update(effectsWindowId, { focused: true });
        return;
      }
    } catch (e) {
      effectsWindowId = null;
      _persistWindowIds();
    }
  }
  if (effectsWindowId === null) {
    try {
      const stored = await chrome.storage?.session?.get(["_effectsWindowId"]);
      if (stored?._effectsWindowId) {
        const win = await chrome.windows.get(stored._effectsWindowId);
        if (win) {
          effectsWindowId = stored._effectsWindowId;
          _extensionPopupWindows.add(effectsWindowId);
          chrome.windows.update(effectsWindowId, { focused: true });
          return;
        }
      }
    } catch (e) {}
  }
  _effectsWindowOpening = true;
  try {
    const pos = await _calcWindowPosition(1200, 900);
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL("effects-editor.html"),
      type: "popup",
      width: 1200,
      height: 900,
      left: pos.left,
      top: pos.top,
      focused: true,
    });
    effectsWindowId = win.id;
    _extensionPopupWindows.add(win.id);
    _persistWindowIds();
  } finally {
    _effectsWindowOpening = false;
  }
}
chrome.windows.onRemoved.addListener(async (windowId) => {
  _extensionPopupWindows.delete(windowId);
  if (windowId === _webSpacesWindowId) {
    _webSpacesWindowId = null;
    try {
      await chrome.storage.session.remove("_webSpacesWindowId");
    } catch (_) {}
  } else {
    try {
      const s = await chrome.storage?.session?.get(["_webSpacesWindowId"]);
      if (s?._webSpacesWindowId === windowId) {
        _webSpacesWindowId = null;
        try {
          await chrome.storage.session.remove("_webSpacesWindowId");
        } catch (_) {}
      }
    } catch (_) {}
  }
  if (windowId === _templatePreviewWindowId) {
    _templatePreviewWindowId = null;
    try {
      await chrome.storage.session.remove("_templatePreviewWindowId");
    } catch (_) {}
  } else {
    try {
      const s = await chrome.storage?.session?.get([
        "_templatePreviewWindowId",
      ]);
      if (s?._templatePreviewWindowId === windowId) {
        _templatePreviewWindowId = null;
        try {
          await chrome.storage.session.remove("_templatePreviewWindowId");
        } catch (_) {}
      }
    } catch (_) {}
  }
  let isSettingsWindow = windowId === settingsWindowId;
  if (!isSettingsWindow) {
    try {
      const stored = await chrome.storage?.session?.get(["_settingsWindowId"]);
      if (stored?._settingsWindowId === windowId) isSettingsWindow = true;
    } catch (e) {}
  }
  if (isSettingsWindow) {
    settingsWindowId = null;
    _persistWindowIds();
    chrome.runtime.sendMessage({ action: "settingsClosed" }).catch(() => {});
  }
  let isWorkflowWindow = windowId === workflowWindowId;
  console.log(
    "[Background] onRemoved windowId:",
    windowId,
    "workflowWindowId:",
    workflowWindowId,
    "isWorkflow:",
    isWorkflowWindow,
  );
  if (!isWorkflowWindow) {
    try {
      const stored = await chrome.storage?.session?.get(["_workflowWindowId"]);
      if (stored?._workflowWindowId === windowId) {
        isWorkflowWindow = true;
        console.log("[Background] onRemoved - matched via session storage");
      }
    } catch (e) {}
  }
  if (isWorkflowWindow) {
    console.log("[Background] onRemoved - clearing workflow window state");
    const closedWorkflowId = editingWorkflowId;
    if (workflowWindowId == null || workflowWindowId === windowId) {
      workflowWindowId = null;
      editingWorkflowId = null;
      _persistWindowIds();
      chrome.runtime
        .sendMessage({
          action: "workflowEditorClosed",
          wfId: closedWorkflowId,
          windowId,
        })
        .catch(() => {});
      _notifyFlowTrackerWorkflowVisibility(false).catch(() => {});
    }
  }
  let isTemplateWindow = windowId === templateWindowId;
  if (!isTemplateWindow) {
    try {
      const stored = await chrome.storage?.session?.get(["_templateWindowId"]);
      if (stored?._templateWindowId === windowId) isTemplateWindow = true;
    } catch (e) {}
  }
  if (isTemplateWindow) {
    templateWindowId = null;
    _persistWindowIds();
    chrome.runtime
      .sendMessage({ action: "templateEditorClosed" })
      .catch(() => {});
  }
  let isAnglesWindow = windowId === anglesWindowId;
  if (!isAnglesWindow) {
    try {
      const stored = await chrome.storage?.session?.get(["_anglesWindowId"]);
      if (stored?._anglesWindowId === windowId) isAnglesWindow = true;
    } catch (e) {}
  }
  if (isAnglesWindow) {
    anglesWindowId = null;
    _persistWindowIds();
  }
  let isEffectsWindow = windowId === effectsWindowId;
  if (!isEffectsWindow) {
    try {
      const stored = await chrome.storage?.session?.get(["_effectsWindowId"]);
      if (stored?._effectsWindowId === windowId) isEffectsWindow = true;
    } catch (e) {}
  }
  if (isEffectsWindow) {
    effectsWindowId = null;
    _persistWindowIds();
  }
});
let _ftCacheWriteChain = Promise.resolve();
let _lastFlowRecoveryPruneAt = 0;
function _ftCachedItemIsBusy(item) {
  return [
    "PENDING",
    "WAITING_DEPENDENCY",
    "SUBMITTING",
    "SUBMITTED",
    "MONITORING",
    "RETRY_SUBMIT",
    "WAITING_USER",
    "WAITING_PROVIDER",
    "RECOVERY_REQUIRED",
  ].includes(String(item?.state || "").toUpperCase());
}
function _ftCachedJobIsBusy(job) {
  return (job?.items || []).some(_ftCachedItemIsBusy);
}
async function _pruneExpiredFlowRecoveryJournal() {
  const now = Date.now();
  if (now - _lastFlowRecoveryPruneAt < 15 * 60 * 1e3) return;
  _lastFlowRecoveryPruneAt = now;
  if (!globalThis.navigator?.locks) return;
  await navigator.locks.request(
    "flow-web-recovery-owner",
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return;
      const key = "flow_web_recovery_v1";
      const stored = await chrome.storage.local.get([key]);
      const records = stored[key] || [];
      let changed = false;
      let legacyStamped = 0;
      const kept = records.filter((record) => {
        if (!record.terminal) return true;
        if (!Number.isFinite(record.finishedAt)) {
          record.finishedAt = now;
          changed = true;
          legacyStamped++;
        }
        const waitingDownload =
          !record.stopped &&
          record.snapshot?._autoDownload === true &&
          (record.outputs || []).some(
            (output) =>
              output.mediaId &&
              !["downloaded", "failed", "skipped"].includes(
                output.downloadStatus,
              ),
          );
        if (waitingDownload || now - record.finishedAt < 2 * 60 * 60 * 1e3)
          return true;
        changed = true;
        return false;
      });
      if (changed) {
        await chrome.storage.local.set({ [key]: kept });
        console.info(
          "[FlowRecoveryJournal] ttl_cleanup " +
            JSON.stringify({
              removed: records.length - kept.length,
              retained: kept.length,
              legacyStamped,
            }),
        );
      }
    },
  );
}
async function _ftPersistRecoveryStop(jobId, projectId) {
  const commit = async () => {
    const stored = await chrome.storage.local.get(["flow_web_recovery_v1"]);
    const records = stored.flow_web_recovery_v1 || [];
    const matches = records.filter((record) => record.jobId === jobId);
    if (!matches.length) return;
    if (matches.some((record) => record.projectId !== projectId))
      throw new Error("RECOVERY_STOP_PROJECT_MISMATCH");
    for (const record of matches) {
      record.terminal = true;
      record.stopped = true;
      record.finishedAt = Date.now();
    }
    await chrome.storage.local.set({
      flow_web_recovery_v1: records,
      ...(records.every((record) => record.terminal) && {
        flow_web_recovery_meta_v1: {
          windowCount: 0,
          closed: false,
          members: null,
        },
      }),
    });
    console.log(
      "[FlowRecovery] cached stop committed " +
        JSON.stringify({ job: jobId, records: matches.length }),
    );
  };
  if (!globalThis.navigator?.locks) return commit();
  return navigator.locks.request(
    "flow-web-recovery-owner",
    { ifAvailable: true },
    async (lock) => {
      if (!lock) {
        const stored = await chrome.storage.local.get(["flow_web_recovery_v1"]);
        if (
          (stored.flow_web_recovery_v1 || []).some(
            (record) => record.jobId === jobId && !record.stopped,
          )
        ) {
          throw new Error("RECOVERY_STOP_OWNER_ACTIVE");
        }
        return;
      }
      return commit();
    },
  );
}
function _ftDurableUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value)
    ? value
    : null;
}
function _ftSanitizeMentionData(value) {
  if (!value || typeof value !== "object") return null;
  return {
    originalPrompt:
      typeof value.originalPrompt === "string" ? value.originalPrompt : null,
    cleanedPrompt:
      typeof value.cleanedPrompt === "string" ? value.cleanedPrompt : null,
    hasUnresolvedMentions: value.hasUnresolvedMentions === true,
    mentions: (Array.isArray(value.mentions) ? value.mentions : [])
      .map((entry) => ({
        found: entry?.found === true,
        mention:
          entry?.mention && typeof entry.mention.imageName === "string"
            ? { imageName: entry.mention.imageName }
            : null,
      }))
      .filter((entry) => entry.mention),
    refImages: (Array.isArray(value.refImages) ? value.refImages : [])
      .map((ref) => ({
        name: typeof ref?.name === "string" ? ref.name : null,
        type: typeof ref?.type === "string" ? ref.type : null,
        source: typeof ref?.source === "string" ? ref.source : null,
        file_id: typeof ref?.file_id === "string" ? ref.file_id : null,
        file_name: typeof ref?.file_name === "string" ? ref.file_name : null,
        thumbnail_url: _ftDurableUrl(ref?.thumbnail_url),
      }))
      .filter((ref) => ref.name && ref.file_id),
  };
}
function _ftSanitizeProviderFailures(values) {
  return (Array.isArray(values) ? values : [])
    .slice(0, 32)
    .map((value) => ({
      operationId:
        typeof value?.operationId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.operationId,
        )
          ? value.operationId
          : null,
      statusCode: Number.isInteger(value?.statusCode) ? value.statusCode : null,
      message:
        typeof value?.message === "string"
          ? value.message
              .replace(/https?:\/\/[^\s"<>]+/gi, "[url]")
              .replace(/Bearer\s+\S+/gi, "[authorization]")
              .replace(/[A-Za-z0-9_=-]{64,}/g, "[token]")
              .replace(/[\u0000-\u001f\u007f]/g, " ")
              .slice(0, 1e3)
          : null,
    }))
    .filter((value) => value.message || value.statusCode !== null);
}
function _ftSanitizeItem(item) {
  const clean = {};
  for (const key of ["_regenSlotRoot", "_regenExecutionJobId"]) {
    if (typeof item?.[key] === "string") clean[key] = item[key];
  }
  const scalar = [
    "id",
    "promptIndex",
    "promptText",
    "prompt",
    "state",
    "retryCount",
    "error",
    "errorDisplay",
    "retryErrorDisplay",
    "errorType",
    "submittedAt",
    "flowApiDispatchedAt",
    "flowApiOperationDeadlineAt",
    "providerPausedAt",
    "completedAt",
    "createdAt",
    "taskName",
    "autoDownload",
    "downloadResolution",
    "videoDownloadResolution",
    "genMode",
    "apiWaiting",
    "model",
    "ratio",
    "genType",
    "quantity",
    "regenOf",
    "isRegen",
    "refImageMode",
    "operationId",
    "mediaId",
    "mediaUuid",
    "projectId",
    "flowApiAccepted",
    "flowApiDriver",
    "flowApiMode",
    "flowApiProtocolRevision",
    "flowApiProtocolFingerprint",
    "recoveryLabel",
    "recoveryPhase",
    "recoveryAttempt",
    "recoveryMaxAttempts",
    "recoveryExhausted",
  ];
  scalar.forEach((k) => {
    if (
      ["string", "number", "boolean"].includes(typeof item?.[k]) ||
      item?.[k] === null
    )
      clean[k] = item[k];
  });
  clean.noRetry = item?.noRetry === true;
  clean.refFileIds = Array.isArray(item?.refFileIds)
    ? item.refFileIds.filter((v) => typeof v === "string").slice(0, 50)
    : [];
  clean.refFileNames = Object.fromEntries(
    Object.entries(item?.refFileNames || {})
      .filter(([k, v]) => typeof k === "string" && typeof v === "string")
      .slice(0, 50),
  );
  const refIdentityKeys = [
    "media_uuid",
    "mediaUuid",
    "persistent_media_id",
    "persistentMediaId",
    "media_id",
    "mediaId",
    "file_name",
    "api_driver",
    "project_id",
    "type",
    "video_url",
    "videoUrl",
  ];
  clean.refThumbnails = {};
  for (const [id, value] of Object.entries(item?.refThumbnails || {}).slice(
    0,
    50,
  )) {
    if (
      typeof id !== "string" ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      continue;
    const identity = {};
    for (const key of refIdentityKeys)
      if (typeof value[key] === "string" && value[key])
        identity[key] = value[key];
    if (Array.isArray(value.identity_aliases)) {
      const aliases = [
        ...new Set(
          value.identity_aliases.filter(
            (alias) => typeof alias === "string" && alias,
          ),
        ),
      ].slice(0, 50);
      if (aliases.length) identity.identity_aliases = aliases;
    }
    if (Object.keys(identity).length) clean.refThumbnails[id] = identity;
  }
  clean.results = (Array.isArray(item?.results) ? item.results : [])
    .map((r) => ({
      url: _ftDurableUrl(r?.url),
      thumbnail: _ftDurableUrl(r?.thumbnail),
      downloadUrl: _ftDurableUrl(
        r?.downloadUrl || r?.durableUrl || r?.providerUrl,
      ),
      apiProvider: r?.apiProvider === true,
      playUrl: _ftDurableUrl(r?.playUrl),
      video: r?.video === true,
      sourceThumbnail: _ftDurableUrl(r?.sourceThumbnail || r?.source_thumbnail),
      poster: _ftDurableUrl(r?.poster) || r?.poster === true,
      fileName: typeof r?.fileName === "string" ? r.fileName : null,
      mediaId: typeof r?.mediaId === "string" ? r.mediaId : null,
      mediaUuid:
        typeof (r?.mediaUuid || r?.media_uuid) === "string"
          ? r.mediaUuid || r.media_uuid
          : null,
      tileId: typeof r?.tileId === "string" ? r.tileId : null,
    }))
    .map((r) => ({
      ...r,
      url: r.url || r.playUrl || r.thumbnail || r.downloadUrl || null,
    }))
    .filter((r) => r.url || r.downloadUrl);
  clean.attemptId =
    typeof item?.attemptId === "string" ? item.attemptId : clean.id || null;
  clean.flowApiLineage = (
    Array.isArray(item?.flowApiLineage) ? item.flowApiLineage : []
  )
    .slice(0, 32)
    .map((entry) => ({
      attemptId: typeof entry?.attemptId === "string" ? entry.attemptId : null,
      operationId:
        typeof entry?.operationId === "string" ? entry.operationId : null,
      mediaId: typeof entry?.mediaId === "string" ? entry.mediaId : null,
      state: ["completed", "failed"].includes(entry?.state)
        ? entry.state
        : null,
    }))
    .filter((entry) => entry.operationId);
  clean.hasFlowOperationId = item?.hasFlowOperationId === true;
  clean.outputs = (Array.isArray(item?.outputs) ? item.outputs : [])
    .slice(0, 32)
    .map((output) => ({
      outputIndex: Number.isFinite(Number(output?.outputIndex))
        ? Number(output.outputIndex)
        : null,
      status: typeof output?.status === "string" ? output.status : null,
      downloadStatus:
        typeof output?.downloadStatus === "string"
          ? output.downloadStatus
          : null,
      identityKind:
        typeof output?.identityKind === "string" ? output.identityKind : null,
      correlationConfidence:
        typeof output?.correlationConfidence === "string"
          ? output.correlationConfidence
          : null,
      hasMediaIdentity: output?.hasMediaIdentity === true,
      completedAt: Number(output?.completedAt) || null,
      downloadedAt: Number(output?.downloadedAt) || null,
      hasError: output?.hasError === true,
    }));
  clean.thumb = _ftDurableUrl(item?.thumb);
  clean.thumbPlayUrl = _ftDurableUrl(item?.thumbPlayUrl);
  clean.thumbSourceThumbnail = _ftDurableUrl(item?.thumbSourceThumbnail);
  clean.thumbVideo = item?.thumbVideo === true;
  clean.thumbPoster = item?.thumbPoster === true;
  clean.dl =
    item?.dl && typeof item.dl === "object"
      ? { state: item.dl.state || null, res: item.dl.res || null }
      : null;
  clean.dependency =
    item?.dependency && typeof item.dependency === "object"
      ? {
          previousItemId: item.dependency.previousItemId || null,
          state: item.dependency.state || null,
          resolvedRefFileIds: Array.isArray(item.dependency.resolvedRefFileIds)
            ? item.dependency.resolvedRefFileIds
                .filter((v) => typeof v === "string")
                .slice(0, 20)
            : [],
          errorCode: item.dependency.errorCode || null,
        }
      : null;
  clean.errorPolicy =
    item?.errorPolicy && typeof item.errorPolicy === "object"
      ? {
          retryable: item.errorPolicy.retryable === true,
          manualOnly: item.errorPolicy.manualOnly === true,
          fallbackDom: item.errorPolicy.fallbackDom === true,
          retryDelayMs: Number(item.errorPolicy.retryDelayMs) || 0,
          action:
            typeof item.errorPolicy.action === "string"
              ? item.errorPolicy.action
              : null,
          code:
            typeof item.errorPolicy.code === "string"
              ? item.errorPolicy.code.slice(0, 255)
              : null,
          driver: ["v1", "v2"].includes(item.errorPolicy.driver)
            ? item.errorPolicy.driver
            : null,
          stage:
            typeof item.errorPolicy.stage === "string"
              ? item.errorPolicy.stage
              : null,
          dispatchStarted: item.errorPolicy.dispatchStarted === true,
          ambiguous: item.errorPolicy.ambiguous === true,
          grpcCode: Number.isInteger(item.errorPolicy.grpcCode)
            ? item.errorPolicy.grpcCode
            : null,
          grpcReason:
            typeof item.errorPolicy.grpcReason === "string" &&
            /^[A-Z][A-Z0-9_]{2,119}$/.test(item.errorPolicy.grpcReason)
              ? item.errorPolicy.grpcReason
              : null,
          providerErrorCodes: (Array.isArray(
            item.errorPolicy.providerErrorCodes,
          )
            ? item.errorPolicy.providerErrorCodes
            : []
          )
            .filter(
              (value) =>
                typeof value === "string" &&
                /^PUBLIC_ERROR_[A-Z0-9_]{1,107}$/.test(value),
            )
            .slice(0, 8),
          failureDetails: _ftSanitizeProviderFailures(
            item.errorPolicy.failureDetails,
          ),
        }
      : null;
  if (clean.errorPolicy?.stage === "terminal")
    clean.errorPolicy.retryable = false;
  clean.mentionData = _ftSanitizeMentionData(item?.mentionData);
  return clean;
}
function _ftSnapshotSession(data, pid, maxItems) {
  const sessionId = String(data?.sessionId || "imported-session");
  return {
    id: sessionId,
    createdAt: Number(data?.createdAt) || Date.now(),
    updatedAt: Date.now(),
    status: data?.isRunning ? "running" : "terminal",
    jobs: (Array.isArray(data?.jobs) ? data.jobs : []).map((job) => ({
      id: String(job?.id || crypto.randomUUID()),
      sessionId:
        typeof job?.sessionId === "string" && job.sessionId
          ? job.sessionId
          : sessionId,
      projectId: pid,
      owner: job?.owner || "prompts",
      mcpJobId:
        job?.owner === "mcp" && typeof job.mcpJobId === "string"
          ? job.mcpJobId.slice(0, 100)
          : null,
      mcpBatchName:
        job?.owner === "mcp" && typeof job.mcpBatchName === "string"
          ? job.mcpBatchName.slice(0, 150)
          : null,
      mcpUserId:
        job?.owner === "mcp" && typeof job.mcpUserId === "string"
          ? job.mcpUserId.slice(0, 100)
          : null,
      sourceBatchId:
        typeof job?.sourceBatchId === "string" ? job.sourceBatchId : null,
      label: job?.label || "Imported session",
      status: job?.status || "completed",
      modeType: job?.modeType || "web",
      effectiveRunMode: job?.effectiveRunMode || null,
      manualRegenItemId:
        typeof job?.manualRegenItemId === "string"
          ? job.manualRegenItemId
          : null,
      manualRegenBatchPending: Math.max(
        0,
        Number(job?.manualRegenBatchPending) || 0,
      ),
      manualRegenStatus: ["running", "paused"].includes(job?.manualRegenStatus)
        ? job.manualRegenStatus
        : null,
      pauseReason:
        typeof job?.pauseReason === "string"
          ? job.pauseReason.slice(0, 120)
          : null,
      modeReason: typeof job?.modeReason === "string" ? job.modeReason : null,
      startedAt: Number(job?.startedAt) || Date.now(),
      completedAt: Number(job?.completedAt) || null,
      completed: Number(job?.completed) || 0,
      failed: Number(job?.failed) || 0,
      total: Number(job?.total) || 0,
      settings: job?.settings || null,
      chain: job?.chain && typeof job.chain === "object" ? job.chain : null,
      regenDisplay:
        job?.regenDisplay && typeof job.regenDisplay === "object"
          ? {
              jobId:
                typeof job.regenDisplay.jobId === "string"
                  ? job.regenDisplay.jobId
                  : null,
              sessionId:
                typeof job.regenDisplay.sessionId === "string"
                  ? job.regenDisplay.sessionId
                  : null,
              label:
                typeof job.regenDisplay.label === "string"
                  ? job.regenDisplay.label.slice(0, 200)
                  : null,
              owner:
                typeof job.regenDisplay.owner === "string"
                  ? job.regenDisplay.owner.slice(0, 40)
                  : null,
              startedAt: Number(job.regenDisplay.startedAt) || null,
            }
          : null,
      items: (Array.isArray(job?.items) ? job.items : []).map(_ftSanitizeItem),
    })),
  };
}
function _ftLimitSessionJobs(session, maxItems) {
  const jobs = Array.isArray(session?.jobs) ? session.jobs : [];
  if (!jobs.length || !(maxItems > 0)) return session;
  const busyStates = new Set([
    "PENDING",
    "WAITING_DEPENDENCY",
    "SUBMITTING",
    "SUBMITTED",
    "MONITORING",
    "RETRY_SUBMIT",
    "WAITING_USER",
    "WAITING_PROVIDER",
    "RECOVERY_REQUIRED",
  ]);
  const active = jobs.filter((job) =>
    (job.items || []).some((item) =>
      busyStates.has(String(item?.state || "").toUpperCase()),
    ),
  );
  const activeIds = new Set(active.map((job) => job.id));
  const terminalNewest = jobs
    .filter((job) => !activeIds.has(job.id))
    .sort(
      (a, b) =>
        Number(b.completedAt || b.startedAt || 0) -
        Number(a.completedAt || a.startedAt || 0),
    );
  const kept = new Set(activeIds);
  let used = active.reduce((sum, job) => sum + (job.items || []).length, 0);
  for (const job of terminalNewest) {
    const count = (job.items || []).length;
    if (kept.size === 0 || used + count <= maxItems) {
      kept.add(job.id);
      used += count;
    }
  }
  session.jobs = jobs.filter((job) => kept.has(job.id));
  return session;
}
function _enqueueTrackerSnapshot(message, sender, sendResponse) {
  const pending =
    _enqueueTrackerSnapshot.pending ||
    (_enqueueTrackerSnapshot.pending = new Map());
  const scope = JSON.stringify([
    message.key || "toby_flow_tracker_snapshots",
    message.projectId,
    message.data?.sessionId || null,
    sender?.tab?.id ?? sender?.documentId ?? null,
  ]);
  const jobs = Array.isArray(message.data?.jobs) ? message.data.jobs : [];
  const shape = JSON.stringify(
    jobs.map((job) => [
      job?.id,
      (Array.isArray(job?.items) ? job.items : []).map((item) => item?.id),
    ]),
  );
  const prior = pending.get(scope);
  if (prior && prior.shape === shape) {
    if ((Number(message.at) || 0) >= (Number(prior.message.at) || 0))
      prior.message = message;
    prior.replies.push(sendResponse);
    return;
  }
  const entry = { shape, message, replies: [sendResponse] };
  pending.set(scope, entry);
  _ftCacheWriteChain = _ftCacheWriteChain
    .catch(() => {})
    .then(async () => {
      if (pending.get(scope) === entry) pending.delete(scope);
      const latest = entry.message;
      entry.message = null;
      return _writeTrackerSnapshot(latest);
    });
  _ftCacheWriteChain.then(
    (result) => {
      for (const reply of entry.replies) {
        try {
          reply(result);
        } catch (_) {}
      }
      entry.replies.length = 0;
    },
    (error) => {
      for (const reply of entry.replies) {
        try {
          reply({ ok: false, error: error?.message || "CACHE_WRITE_FAILED" });
        } catch (_) {}
      }
      entry.replies.length = 0;
    },
  );
}
function _ftProjectCacheKey(key, pid) {
  return key + ":project:" + encodeURIComponent(pid);
}
function _ftBatchHistoryAt(job, recordAt) {
  return (
    Math.max(
      Number(job?.completedAt) || 0,
      ...(job?.items || []).map((item) => Number(item.completedAt) || 0),
    ) ||
    Number(job?.startedAt) ||
    Number(recordAt) ||
    0
  );
}
function _ftProjectCacheMeta(entry) {
  const data = entry?.data;
  const active =
    (data?.sessions || []).some((session) =>
      ["running", "recovery_required"].includes(session.status),
    ) ||
    (data?.jobs || []).some((job) =>
      ["running", "paused"].includes(job.status),
    );
  const jobs = Array.isArray(data?.sessions)
    ? data.sessions.flatMap((session) => session.jobs || [])
    : data?.jobs || [];
  const oldestBatchAt = entry?._ftMetadataOnly
    ? entry.oldestBatchAt
    : jobs.length
      ? Math.min(...jobs.map((job) => _ftBatchHistoryAt(job, entry.at)))
      : Number(entry?.at) || 0;
  return {
    at: Number(entry?.at) || 0,
    active,
    ...(oldestBatchAt !== void 0 ? { oldestBatchAt } : {}),
  };
}
function _ftExcludeWorkflowCacheEntry(entry) {
  const data = entry?.data;
  if (!data) return entry;
  let changed = false;
  const filterJobs = (jobs) => {
    const kept = (jobs || []).filter((job) => job.owner !== "workflow");
    if (kept.length !== (jobs || []).length) changed = true;
    return kept;
  };
  if (Array.isArray(data.sessions)) {
    const sessions = data.sessions
      .map((session) => {
        const jobs = filterJobs(session.jobs);
        if (jobs.length === (session.jobs || []).length) return session;
        const active = jobs.some((job) => _ftCachedJobIsBusy(job));
        return { ...session, jobs, status: active ? "running" : "terminal" };
      })
      .filter((session) => (session.jobs || []).length);
    return !changed
      ? entry
      : sessions.length
        ? { ...entry, data: { ...data, sessions } }
        : null;
  }
  if (Array.isArray(data.jobs)) {
    const jobs = filterJobs(data.jobs);
    return !changed
      ? entry
      : jobs.length
        ? { ...entry, data: { ...data, jobs } }
        : null;
  }
  return entry;
}
async function _ftReadCacheMap(key, pid) {
  if (key !== "toby_flow_tracker_snapshots") {
    const stored2 = await chrome.storage.local.get([key]);
    return stored2?.[key] || {};
  }
  const projectKey = _ftProjectCacheKey(key, pid);
  const stored = await chrome.storage.local.get([key, projectKey]);
  let index = stored?.[key],
    entry = stored?.[projectKey];
  if (
    index?.schemaVersion !== 2 ||
    !index.projects ||
    typeof index.projects !== "object"
  ) {
    const legacy = index || {};
    const projects = {},
      writes = {};
    for (const [id, record] of Object.entries(legacy)) {
      if (!record || typeof record !== "object") continue;
      const normalized = record.data
        ? record
        : Array.isArray(record.jobs) || Array.isArray(record.sessions)
          ? { at: Number(record.at) || 0, data: record }
          : null;
      if (!normalized) continue;
      projects[id] = _ftProjectCacheMeta(normalized);
      writes[_ftProjectCacheKey(key, id)] = normalized;
    }
    index = { schemaVersion: 2, projects };
    writes[key] = index;
    await chrome.storage.local.set(writes);
    entry = writes[projectKey];
  }
  const map = {};
  for (const [id, metadata] of Object.entries(index.projects)) {
    map[id] = {
      at: metadata.at,
      oldestBatchAt: metadata.oldestBatchAt,
      _ftMetadataOnly: true,
      data: { sessions: metadata.active ? [{ status: "running" }] : [] },
    };
  }
  if (Object.prototype.hasOwnProperty.call(index.projects, pid) && entry?.data)
    map[pid] = entry;
  Object.defineProperty(map, "_ftOriginalProjectIds", {
    value: Object.keys(index.projects),
  });
  if (map[pid] && !map[pid]._ftMetadataOnly) {
    const filtered = _ftExcludeWorkflowCacheEntry(map[pid]);
    if (filtered !== map[pid]) {
      if (filtered) map[pid] = filtered;
      else delete map[pid];
      await _ftWriteCacheMap(key, map, pid);
    }
  }
  return map;
}
async function _ftWriteCacheMap(key, map, pid, originalMap) {
  if (key !== "toby_flow_tracker_snapshots") {
    await chrome.storage.local.set({ [key]: map });
    return;
  }
  const projects = {};
  for (const [id, entry] of Object.entries(map))
    projects[id] = _ftProjectCacheMeta(entry);
  const writes = { [key]: { schemaVersion: 2, projects } };
  if (map[pid] && !map[pid]._ftMetadataOnly)
    writes[_ftProjectCacheKey(key, pid)] = map[pid];
  const originalIds = (originalMap || map)._ftOriginalProjectIds || [];
  const removed = originalIds.filter(
    (id) => !Object.prototype.hasOwnProperty.call(projects, id),
  );
  if (removed.length)
    await chrome.storage.local.remove(
      removed.map((id) => _ftProjectCacheKey(key, id)),
    );
  await chrome.storage.local.set(writes);
}
async function _ftUpdateGenBatchItem(
  projectId,
  sessionId,
  jobId,
  rootItemId,
  mutation,
) {
  if (!projectId || !sessionId || !jobId || !rootItemId) return false;
  if (typeof indexedDB === "undefined") return false;
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("tobyflow_gen_batches");
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    if (error?.name === "AbortError") return null;
    throw error;
  });
  if (!db) return false;
  try {
    if (!db.objectStoreNames.contains("batches")) return false;
    const changed = await new Promise((resolve, reject) => {
      const tx = db.transaction("batches", "readwrite");
      const cursor = tx.objectStore("batches").openCursor();
      let matched = false;
      tx.oncomplete = () => resolve(matched);
      tx.onabort = tx.onerror = () =>
        reject(tx.error || new Error("BATCH_TRACKER_SYNC_FAILED"));
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const batch = entry.value;
        const index = batch.runtimeItemIds?.indexOf(rootItemId) ?? -1;
        if (
          batch.projectId === projectId &&
          batch.trackerSessionId === sessionId &&
          batch.jobId === jobId &&
          index >= 0 &&
          batch.items?.[index]
        ) {
          if (mutation.type === "prompt") {
            batch.items[index].prompt = mutation.prompt;
            if (batch.terminalItems?.[index])
              batch.terminalItems[index].prompt = mutation.prompt;
          } else if (mutation.type === "remove")
            batch.items[index].hidden = true;
          batch.revision = (Number(batch.revision) || 0) + 1;
          batch.updatedAt = Date.now();
          entry.update(batch);
          matched = true;
        } else entry.continue();
      };
    });
    if (changed)
      chrome.runtime.sendMessage(
        { action: "genBatch:changed", projectId },
        () => void chrome.runtime.lastError,
      );
    return changed;
  } finally {
    db.close();
  }
}
const _ftExpiredTrackerJobs = new Map();
async function _ftExpiredIds(pid) {
  if (_ftExpiredTrackerJobs.has(pid)) return _ftExpiredTrackerJobs.get(pid);
  const key = "toby_tracker_expired_jobs:" + encodeURIComponent(pid);
  const stored = await chrome.storage.session?.get([key]);
  const ids = new Set(Array.isArray(stored?.[key]) ? stored[key] : []);
  _ftExpiredTrackerJobs.set(pid, ids);
  return ids;
}
async function _ftRememberExpiredJobs(pid, ids) {
  const expired = await _ftExpiredIds(pid);
  ids.forEach((id) => expired.add(id));
  await chrome.storage.session?.set({
    ["toby_tracker_expired_jobs:" + encodeURIComponent(pid)]: [...expired],
  });
}
let _ftTrackerExpiryFlight = null;
function _pruneExpiredTrackerHistory() {
  if (_ftTrackerExpiryFlight) return _ftTrackerExpiryFlight;
  const sweep = _ftCacheWriteChain
    .catch(() => {})
    .then(async () => {
      const key = "toby_flow_tracker_snapshots";
      const stored = await chrome.storage.local.get([
        key,
        "af_system_settings",
      ]);
      const hours = Number(stored?.af_system_settings?.tracker_cache_ttl_hours);
      if (!(hours > 0)) return;
      const ttl = hours * 36e5,
        now = Date.now();
      let index = stored?.[key];
      if (index && index.schemaVersion !== 2) {
        const firstProject = Object.keys(index).find(
          (id) =>
            index[id]?.data ||
            Array.isArray(index[id]?.jobs) ||
            Array.isArray(index[id]?.sessions),
        );
        if (!firstProject) return;
        await _ftReadCacheMap(key, firstProject);
        index = (await chrome.storage.local.get([key]))?.[key];
      }
      if (index?.schemaVersion !== 2) return;
      const expired = Object.entries(index.projects || {}).filter(
        ([, meta]) =>
          meta.oldestBatchAt === void 0 ||
          now - Number(meta.oldestBatchAt) >= ttl,
      );
      if (!expired.length) return;
      for (const [pid] of expired) {
        const map = await _ftReadCacheMap(key, pid),
          entry = map[pid];
        if (!entry) continue;
        if (entry._ftMetadataOnly) {
          delete map[pid];
          await _ftWriteCacheMap(key, map, pid);
          continue;
        }
        const data = entry.data,
          removed = [];
        const keep = (jobs) =>
          (jobs || []).filter((job) => {
            if (now - _ftBatchHistoryAt(job, entry.at) < ttl) return true;
            removed.push(
              job.id,
              ...(job.items || [])
                .map((item) => item._regenExecutionJobId)
                .filter((id) => typeof id === "string" && id),
            );
            return false;
          });
        let filtered;
        if (Array.isArray(data.sessions)) {
          filtered = {
            ...data,
            sessions: data.sessions
              .map((session) => ({ ...session, jobs: keep(session.jobs) }))
              .filter((session) => session.jobs.length),
          };
          if (filtered.sessions.length) map[pid] = { ...entry, data: filtered };
          else delete map[pid];
        } else if (Array.isArray(data.jobs)) {
          filtered = { ...data, jobs: keep(data.jobs) };
          if (filtered.jobs.length) map[pid] = { ...entry, data: filtered };
          else delete map[pid];
        }
        if (!removed.length) {
          if (index.projects[pid]?.oldestBatchAt === void 0)
            await _ftWriteCacheMap(key, map, pid);
          continue;
        }
        await _ftRememberExpiredJobs(pid, removed);
        await _ftWriteCacheMap(key, map, pid);
      }
    });
  _ftCacheWriteChain = sweep;
  _ftTrackerExpiryFlight = sweep.finally(() => {
    _ftTrackerExpiryFlight = null;
  });
  return _ftTrackerExpiryFlight;
}
async function _writeTrackerSnapshot(message) {
  const key = String(message.key || "toby_flow_tracker_snapshots");
  const pid = String(message.projectId || "");
  if (!pid || !message.data)
    return { ok: false, error: "INVALID_CACHE_PAYLOAD" };
  const expired =
    key === "toby_flow_tracker_snapshots" ? await _ftExpiredIds(pid) : null;
  const jobs = (
    Array.isArray(message.data.jobs) ? message.data.jobs : []
  ).filter((job) => job.owner !== "workflow" && !expired?.has(job.id));
  if (
    !jobs.length &&
    expired &&
    (message.data.jobs || []).some((job) => expired.has(job.id))
  )
    return { ok: true, skipped: "EXPIRED_HISTORY" };
  if (
    !jobs.length &&
    (message.data.jobs || []).some((job) => job.owner === "workflow")
  ) {
    return { ok: true, skipped: "WORKFLOW_HISTORY_EXCLUDED" };
  }
  if (jobs.length !== (message.data.jobs || []).length)
    message = { ...message, data: { ...message.data, jobs } };
  const now = Number(message.at) || Date.now();
  const ttl = Math.max(6e4, Number(message.ttl) || 6048e5);
  const max = Math.max(1, Math.min(20, Number(message.max) || 5));
  const maxSessions = Math.max(
    1,
    Math.min(50, Number(message.maxSessions) || 1),
  );
  const maxItems = Math.max(10, Math.min(1e3, Number(message.maxItems) || 200));
  const map = await _ftReadCacheMap(key, pid);
  const currentAt = Number(map[pid]?.at) || 0;
  if (now >= currentAt) {
    const previous = map[pid]?.data;
    const record =
      previous?.schemaVersion === 1 && Array.isArray(previous.sessions)
        ? previous
        : {
            schemaVersion: 1,
            projectId: pid,
            sessions: previous?.jobs?.length
              ? [_ftSnapshotSession(previous, pid, maxItems)]
              : [],
          };
    const grouped = new Map();
    for (const job of message.data.jobs || []) {
      const sessionId =
        typeof job?.sessionId === "string" && job.sessionId
          ? job.sessionId
          : String(message.data.sessionId || "imported-session");
      if (!grouped.has(sessionId)) grouped.set(sessionId, []);
      grouped.get(sessionId).push(job);
    }
    const incomingItemIds = new Set();
    for (const [sessionId, jobsForSession] of grouped) {
      const incoming = _ftSnapshotSession(
        {
          ...message.data,
          sessionId,
          jobs: jobsForSession,
          createdAt:
            sessionId === message.data.sessionId
              ? message.data.createdAt
              : Math.min(
                  ...jobsForSession.map((job) => Number(job.startedAt) || now),
                ),
        },
        pid,
        maxItems,
      );
      const previousJobs = record.sessions.flatMap(
        (session) => session.jobs || [],
      );
      incoming.jobs = incoming.jobs.map((job) => {
        const prior = previousJobs.find((entry) => entry.id === job.id);
        if (
          prior &&
          job.items.some(
            (item) => item.isRegen || item.regenOf || item._regenSlotRoot,
          )
        ) {
          const slotKey = (item) =>
            item._regenSlotRoot || item.regenOf || item.id;
          const changed = new Map(
            job.items.map((item) => [slotKey(item), item]),
          );
          const seen = new Set();
          const items = prior.items.map((item) => {
            const slot = slotKey(item);
            seen.add(slot);
            const replacement = changed.get(slot);
            return replacement
              ? {
                  ...replacement,
                  promptIndex: item.promptIndex ?? replacement.promptIndex,
                }
              : item;
          });
          items.push(...job.items.filter((item) => !seen.has(slotKey(item))));
          return { ...job, items };
        }
        const ids2 = new Set(job.items.map((item) => item.id));
        const replacements = (prior?.items || []).filter(
          (item) => item._regenSlotRoot && !ids2.has(item.id),
        );
        return { ...job, items: job.items.concat(replacements) };
      });
      const sameSession = record.sessions.find(
        (session) => session.id === incoming.id,
      );
      const idsInSnapshot = new Set(incoming.jobs.map((job) => job.id));
      incoming.jobs = (sameSession?.jobs || [])
        .filter((job) => !idsInSnapshot.has(job.id))
        .concat(incoming.jobs);
      if (sameSession?.createdAt) incoming.createdAt = sameSession.createdAt;
      const incomingJobIds = new Set(incoming.jobs.map((job) => job.id));
      record.sessions.forEach((session) => {
        if (session.id !== incoming.id)
          session.jobs = (session.jobs || []).filter(
            (job) => !incomingJobIds.has(job.id),
          );
      });
      record.sessions = record.sessions.filter(
        (session) =>
          (session.jobs || []).length > 0 || session.id === incoming.id,
      );
      const at = record.sessions.findIndex(
        (session) => session.id === incoming.id,
      );
      if (at >= 0) record.sessions[at] = incoming;
      else record.sessions.push(incoming);
      for (const job of incoming.jobs)
        for (const item of job.items || []) incomingItemIds.add(item.id);
    }
    const winner = new Map();
    for (const session of record.sessions)
      for (const job of session.jobs || []) {
        const prior = winner.get(job.id);
        if (
          !prior ||
          Number(session.updatedAt || 0) >= Number(prior.updatedAt || 0)
        )
          winner.set(job.id, session);
      }
    record.sessions.forEach((session) => {
      session.jobs = (session.jobs || []).filter(
        (job) => winner.get(job.id) === session,
      );
    });
    record.sessions = record.sessions.filter(
      (session) => (session.jobs || []).length > 0,
    );
    const displayJobs = self.TrackerRegenProjection.jobs(
      record.sessions.flatMap((session) => session.jobs || []),
    );
    record.sessions.forEach((session) => {
      const ownedIds = new Set((session.jobs || []).map((job) => job.id));
      session.jobs = displayJobs.filter((job) => ownedIds.has(job.id));
      if (
        session.jobs.some((job) =>
          job.items.some((item) => incomingItemIds.has(item.id)),
        )
      )
        session.updatedAt = now;
      session.status = session.jobs.some((job) =>
        ["running", "paused"].includes(job.status),
      )
        ? "running"
        : "terminal";
      _ftLimitSessionJobs(session, maxItems);
    });
    record.sessions = record.sessions.filter(
      (session) => session.jobs.length > 0,
    );
    const protectedSessions = record.sessions.filter(
      (s) => s.status === "running" || s.status === "recovery_required",
    );
    const terminal = record.sessions
      .filter((s) => !protectedSessions.includes(s))
      .filter(
        (s) =>
          key === "toby_flow_tracker_snapshots" ||
          now - Number(s.updatedAt || s.createdAt || 0) <= ttl,
      )
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    record.sessions = [
      ...protectedSessions,
      ...terminal.slice(0, Math.max(0, maxSessions - protectedSessions.length)),
    ].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    map[pid] = { at: now, data: record };
  }
  const ids = Object.keys(map)
    .filter((id) => {
      const sessions = map[id]?.data?.sessions || [];
      return (
        key === "toby_flow_tracker_snapshots" ||
        sessions.some(
          (s) => s.status === "running" || s.status === "recovery_required",
        ) ||
        now - (Number(map[id]?.at) || 0) <= ttl
      );
    })
    .sort((a, b) => (Number(map[b]?.at) || 0) - (Number(map[a]?.at) || 0));
  const kept = {};
  const protectedIds = ids.filter((id) =>
    (map[id]?.data?.sessions || []).some(
      (s) => s.status === "running" || s.status === "recovery_required",
    ),
  );
  const terminalIds = ids.filter((id) => !protectedIds.includes(id));
  [
    ...protectedIds,
    ...terminalIds.slice(0, Math.max(0, max - protectedIds.length)),
  ].forEach((id) => {
    kept[id] = map[id];
  });
  await _ftWriteCacheMap(key, kept, pid, map);
  return { ok: true };
}
const _API_NETWORK_FAILURE_THRESHOLD = 3;
const _API_NETWORK_FAILURE_WINDOW_MS = 3e4;
const _API_NETWORK_BACKOFF_BASE_MS = 5e3;
const _API_NETWORK_BACKOFF_MAX_MS = 3e4;
const _apiNetworkCircuit = {
  consecutiveFailures: 0,
  lastFailureAt: 0,
  openUntil: 0,
  announcedOffline: false,
};
function _apiEndpointForLog(endpoint) {
  return (
    String(endpoint || "")
      .split("?")[0]
      .replace(/[^A-Za-z0-9_./{}:-]/g, "")
      .slice(0, 160) || "[missing]"
  );
}
function _apiBroadcastNetworkState(online, details = {}) {
  try {
    chrome.runtime.sendMessage(
      { type: "API_NETWORK_STATE", online, ...details },
      () => void chrome.runtime.lastError,
    );
  } catch (_) {}
}
function _apiNetworkBeforeRequest(endpoint) {
  const recoveryProbe =
    String(endpoint || "").split("?")[0] === "health" ||
    String(endpoint || "").startsWith("auth/");
  const now = Date.now();
  if (!recoveryProbe && _apiNetworkCircuit.openUntil > now) {
    return { allowed: false, retryAfterMs: _apiNetworkCircuit.openUntil - now };
  }
  return { allowed: true, recoveryProbe };
}
function _apiNetworkRecordReachable() {
  const notify = _apiNetworkCircuit.announcedOffline;
  _apiNetworkCircuit.consecutiveFailures = 0;
  _apiNetworkCircuit.lastFailureAt = 0;
  _apiNetworkCircuit.openUntil = 0;
  _apiNetworkCircuit.announcedOffline = false;
  if (notify) {
    _apiBroadcastNetworkState(true, { source: "api-proxy" });
    globalThis.ConfigAccessRecovery?.run("online").catch(() => {});
  }
}
function _apiNetworkRecordFailure({ method, endpoint, error, audience }) {
  const now = Date.now();
  if (now - _apiNetworkCircuit.lastFailureAt > _API_NETWORK_FAILURE_WINDOW_MS) {
    _apiNetworkCircuit.consecutiveFailures = 0;
  }
  _apiNetworkCircuit.lastFailureAt = now;
  _apiNetworkCircuit.consecutiveFailures++;
  if (
    _apiNetworkCircuit.consecutiveFailures >= _API_NETWORK_FAILURE_THRESHOLD
  ) {
    const exponent =
      _apiNetworkCircuit.consecutiveFailures - _API_NETWORK_FAILURE_THRESHOLD;
    const backoffMs = Math.min(
      _API_NETWORK_BACKOFF_MAX_MS,
      _API_NETWORK_BACKOFF_BASE_MS * 2 ** exponent,
    );
    _apiNetworkCircuit.openUntil = Math.max(
      _apiNetworkCircuit.openUntil,
      now + backoffMs,
    );
    if (!_apiNetworkCircuit.announcedOffline) {
      _apiNetworkCircuit.announcedOffline = true;
      _apiBroadcastNetworkState(false, {
        source: "api-proxy",
        code: "NETWORK_CIRCUIT_OPEN",
        retryAfterMs: backoffMs,
      });
    }
  }
  console.error(
    "[TobyFlow] API Proxy: network failure",
    JSON.stringify({
      method: String(method || "GET").toUpperCase(),
      endpoint: _apiEndpointForLog(endpoint),
      ...(audience ? { audience } : {}),
      error: String(error?.message || error || "Failed to fetch").slice(0, 240),
      consecutiveFailures: _apiNetworkCircuit.consecutiveFailures,
      circuitOpenMs: Math.max(0, _apiNetworkCircuit.openUntil - now),
    }),
  );
}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.af_system_settings)
      _pruneExpiredTrackerHistory().catch(() => {});
  });
} catch (_) {}
function handleCoreRuntimeMessage(message, sender, sendResponse) {
  if (message?.action === "openMotionTemplatePreview") {
    let origin;
    try {
      origin = new URL(sender?.url).origin;
    } catch (_) {}
    if (!["https://local.566flow.invalid", "https://566flow.invalid"].includes(origin)) {
      sendResponse({ ok: false, error: "BAD_ORIGIN" });
      return false;
    }
    return openMotionTemplateSidebar(message, sender, sendResponse);
  }
  if (
    [
      "FETCH_PROTECTED_CONFIG",
      "PROTECTED_CONFIG_STATUS",
      "CLAIM_PROTECTED_DEVICE",
      "ROTATE_DEVICE_KEY",
      "REPLACE_DEVICE_IDENTITY",
      "RETRY_PROTECTED_CONFIG",
    ].includes(message.action)
  ) {
    if (!ProtectedConfigClient.allowedSender(sender)) {
      sendResponse({
        success: false,
        error: { code: "PROTECTED_RPC_FORBIDDEN" },
        httpStatus: 403,
      });
      return false;
    }
    let task;
    if (message.action === "FETCH_PROTECTED_CONFIG") {
      const options = {
        ...(message.provider !== void 0 ? { provider: message.provider } : {}),
        ...(message.keys !== void 0 ? { keys: message.keys } : {}),
        ...(message.profileKey !== void 0
          ? { profileKey: message.profileKey }
          : {}),
        ...(message.promptVariant !== void 0
          ? { promptVariant: message.promptVariant }
          : {}),
        ...(message.revision !== void 0 ? { revision: message.revision } : {}),
        ...(message.force !== void 0 ? { force: message.force } : {}),
      };
      task = ProtectedConfigClient.envelope(message.operation, options);
    } else if (message.action === "PROTECTED_CONFIG_STATUS") {
      task = (async () => {
        if (_enrollmentPromise) await _enrollmentPromise.catch(() => {});
        const status = ProtectedConfigClient.status();
        const savedRetryUntil =
          Number(
            (await chrome.storage.session?.get?.(ENROLLMENT_RETRY_KEY))?.[
              ENROLLMENT_RETRY_KEY
            ],
          ) || 0;
        const retryUntil = Math.max(_enrollmentRetryUntil, savedRetryUntil);
        const enrollmentCodeMayReplaceStatus =
          !status.code ||
          [
            "CONFIG_SCOPE_CHANGED",
            "CONFIG_ACCESS_INVALIDATED",
            "CONFIG_FETCH_FAILED",
            "ENROLLMENT_REQUIRED",
            "RATE_LIMITED",
          ].includes(status.code);
        if (
          !status.ready &&
          enrollmentCodeMayReplaceStatus &&
          !_isEnrollmentUnexpired(await _getEnrollment())
        ) {
          return {
            success: true,
            data: {
              ...status,
              code:
                retryUntil > Date.now()
                  ? "RATE_LIMITED"
                  : _enrollmentLastFailure?.code &&
                      _enrollmentLastFailure.code !== "RATE_LIMITED"
                    ? _enrollmentLastFailure.code
                    : "ENROLLMENT_REQUIRED",
              enrollmentFailure: true,
              retryable: _enrollmentLastFailure?.retryable !== false,
              retryAfterMs: Math.max(0, retryUntil - Date.now()),
            },
          };
        }
        if (!status.ready && enrollmentCodeMayReplaceStatus) {
          const auth = (await chrome.storage.local.get("af_auth")).af_auth;
          if (!auth?.token || !auth?.user?.id) {
            return {
              success: true,
              data: { ...status, code: "AUTH_REQUIRED", retryable: false },
            };
          }
        }
        return { success: true, data: status };
      })();
    } else if (message.action === "RETRY_PROTECTED_CONFIG")
      task = (async () => {
        const missingEnrollment = !_isEnrollmentUnexpired(
          await _getEnrollment(),
        );
        if (!(await _ensureEnrollment())) {
          const retryAfterMs = Math.max(0, _enrollmentRetryUntil - Date.now());
          return {
            success: false,
            error: {
              code: retryAfterMs
                ? "RATE_LIMITED"
                : _enrollmentLastFailure?.code || "ENROLLMENT_REQUIRED",
            },
            retryAfterMs,
          };
        }
        if (missingEnrollment) {
          const auth = (await chrome.storage.local.get("af_auth")).af_auth;
          if (!auth?.token || !auth?.user?.id) {
            await ProtectedConfigClient.invalidate("AUTH_REQUIRED");
            return { success: false, error: { code: "AUTH_REQUIRED" } };
          }
          const claim = await ProtectedConfigClient.claim();
          if (claim.data?.registered !== true) return claim;
        }
        return ConfigAccessRecovery.run(
          message.trigger === "online" ? "online" : "manual",
        );
      })();
    else if (message.action === "CLAIM_PROTECTED_DEVICE")
      task = ProtectedConfigClient.claim().then(async (result) => {
        if (
          result?.data?.registered === true &&
          !ProtectedConfigClient.status().ready
        ) {
          await ConfigAccessRecovery.run("manual");
        } else if (result?.data?.registered === true) {
          _notifyProtectedConfigReady();
        }
        return result;
      });
    else if (message.action === "ROTATE_DEVICE_KEY")
      task = ProtectedConfigClient.rotate();
    else if (
      new URL(sender.url).pathname === "/settings.html" &&
      message.confirmed === true
    ) {
      task = ProtectedConfigClient.replaceIdentity(
        message.retryOrphan === true,
      );
    } else
      task = Promise.reject(
        Object.assign(new Error("PROTECTED_RPC_FORBIDDEN"), {
          code: "PROTECTED_RPC_FORBIDDEN",
          httpStatus: 403,
        }),
      );
    task
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          error: { code: error.code || "CONFIG_FETCH_FAILED" },
          httpStatus: error.httpStatus || 503,
        }),
      );
    return true;
  }
  if (message.action === "ensureEnrollment") {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false });
      return false;
    }
    _ensureEnrollment()
      .then((value) =>
        sendResponse({ ok: !!(value?.client_id && value?.secret) }),
      )
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (
    typeof message.action === "string" &&
    message.action.startsWith("ft:") &&
    message.action !== "ft:cacheSnapshot" &&
    message.action !== "ft:getProjectHistory"
  )
    _enqueueTrackerSnapshot.pending?.clear();
  if (message.action === "ft:cacheSnapshot") {
    _enqueueTrackerSnapshot(message, sender, sendResponse);
    return true;
  }
  if (message.action === "ft:getProjectHistory") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        if (!pid) return { ok: false, error: "INVALID_CACHE_PROJECT" };
        const map = await _ftReadCacheMap(key, pid);
        return {
          ok: true,
          projectId: pid,
          expiredJobIds:
            key === "toby_flow_tracker_snapshots"
              ? [...(await _ftExpiredIds(pid))]
              : [],
          record: map[pid]?._ftMetadataOnly ? null : map[pid] || null,
        };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_READ_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:removeHistoryJob") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        if (!pid || !message.sessionId || !message.jobId)
          return { ok: false, error: "INVALID_REMOVE_TARGET" };
        const map = await _ftReadCacheMap(key, pid);
        const record = map[pid]?.data;
        if (!record || !Array.isArray(record.sessions)) return { ok: true };
        const sessions =
          message.allSessions === true
            ? record.sessions
            : record.sessions.filter((s) => s.id === message.sessionId);
        if (!sessions.length) return { ok: true };
        if (
          message.queueRemovalConfirmed !== true &&
          sessions.some((session) =>
            (session.jobs || []).some(
              (job) => job.id === message.jobId && _ftCachedJobIsBusy(job),
            ),
          )
        )
          return { ok: false, error: "BATCH_BUSY" };
        for (const session of sessions)
          session.jobs = (session.jobs || []).filter(
            (job) => job.id !== message.jobId,
          );
        record.sessions = record.sessions.filter(
          (s) => (s.jobs || []).length > 0,
        );
        map[pid] = { at: Date.now(), data: record };
        await _ftWriteCacheMap(key, map, pid);
        return { ok: true };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_REMOVE_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:removeHistoryItem") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        if (!pid || !message.sessionId || !message.jobId || !message.itemId)
          return { ok: false, error: "INVALID_REMOVE_TARGET" };
        const map = await _ftReadCacheMap(key, pid);
        const record = map[pid]?.data;
        if (!record || !Array.isArray(record.sessions)) {
          if (message.skipBatchSync !== true)
            await _ftUpdateGenBatchItem(
              pid,
              message.sessionId,
              message.rootJobId || message.jobId,
              message.rootItemId || message.itemId,
              { type: "remove" },
            );
          return { ok: true };
        }
        const session = record.sessions.find((s) => s.id === message.sessionId);
        if (!session) {
          if (message.skipBatchSync !== true)
            await _ftUpdateGenBatchItem(
              pid,
              message.sessionId,
              message.rootJobId || message.jobId,
              message.rootItemId || message.itemId,
              { type: "remove" },
            );
          return { ok: true };
        }
        const job = (session.jobs || []).find((j) => j.id === message.jobId);
        const targetItem = (job?.items || []).find(
          (item) => item.id === message.itemId,
        );
        if (
          message.queueRemovalConfirmed !== true &&
          targetItem &&
          _ftCachedItemIsBusy(targetItem)
        ) {
          return { ok: false, error: "BATCH_BUSY" };
        }
        if (job)
          job.items = (job.items || []).filter(
            (item) => item.id !== message.itemId,
          );
        session.jobs = (session.jobs || []).filter(
          (entry) => (entry.items || []).length > 0,
        );
        record.sessions = record.sessions.filter(
          (entry) => (entry.jobs || []).length > 0,
        );
        if (record.sessions.length) map[pid] = { at: Date.now(), data: record };
        else delete map[pid];
        await _ftWriteCacheMap(key, map, pid);
        if (message.skipBatchSync !== true)
          await _ftUpdateGenBatchItem(
            pid,
            message.sessionId,
            message.rootJobId || message.jobId,
            message.rootItemId ||
              targetItem?._regenSlotRoot ||
              targetItem?.regenOf ||
              message.itemId,
            { type: "remove" },
          );
        return { ok: true };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_REMOVE_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:updateHistoryPrompt") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        const prompt =
          typeof message.prompt === "string" ? message.prompt.trim() : "";
        if (!pid || !message.sessionId || !message.itemId || !prompt)
          return { ok: false, error: "INVALID_PROMPT" };
        const map = await _ftReadCacheMap(key, pid);
        const record = map[pid]?.data;
        const session = record?.sessions?.find(
          (entry) => entry.id === message.sessionId,
        );
        const item = session?.jobs
          ?.flatMap((job) => job.items || [])
          .find((entry) => entry.id === message.itemId);
        if (!item) {
          if (message.skipBatchSync !== true)
            await _ftUpdateGenBatchItem(
              pid,
              message.sessionId,
              message.rootJobId || message.jobId,
              message.rootItemId || message.itemId,
              { type: "prompt", prompt },
            );
          return { ok: true, cached: false };
        }
        item.prompt = prompt;
        item.promptText = prompt.substring(0, 80);
        map[pid] = { at: Date.now(), data: record };
        await _ftWriteCacheMap(key, map, pid);
        if (message.skipBatchSync !== true)
          await _ftUpdateGenBatchItem(
            pid,
            message.sessionId,
            message.rootJobId || message.jobId,
            message.rootItemId ||
              item._regenSlotRoot ||
              item.regenOf ||
              message.itemId,
            { type: "prompt", prompt },
          );
        return { ok: true, cached: true };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_SAVE_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:updateHistoryItem") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        if (
          !pid ||
          !message.sessionId ||
          !message.jobId ||
          !message.itemId ||
          !message.patch ||
          typeof message.patch !== "object"
        )
          return { ok: false, error: "INVALID_HISTORY_ITEM_PATCH" };
        const map = await _ftReadCacheMap(key, pid);
        const record = map[pid]?.data;
        const session = record?.sessions?.find(
          (entry) => entry.id === message.sessionId,
        );
        const job = session?.jobs?.find((entry) => entry.id === message.jobId);
        const item = job?.items?.find((entry) => entry.id === message.itemId);
        if (!item) return { ok: true, cached: false };
        const patch = message.patch;
        const prompt =
          typeof patch.prompt === "string" ? patch.prompt.trim() : "";
        const quantity = Number(patch.quantity);
        if (
          !prompt ||
          !patch.model ||
          !patch.ratio ||
          !Number.isSafeInteger(quantity) ||
          quantity < 1 ||
          !Array.isArray(patch.refFileIds) ||
          patch.refFileIds.some((id) => typeof id !== "string") ||
          !patch.refFileNames ||
          typeof patch.refFileNames !== "object" ||
          Array.isArray(patch.refFileNames) ||
          !patch.refThumbnails ||
          typeof patch.refThumbnails !== "object" ||
          Array.isArray(patch.refThumbnails)
        )
          return { ok: false, error: "INVALID_HISTORY_ITEM_PATCH" };
        item.prompt = prompt;
        item.promptText = prompt.substring(0, 80);
        item.model = String(patch.model);
        item.ratio = String(patch.ratio);
        item.quantity = quantity;
        item.settings = {
          ...(item.settings || {}),
          model: item.model,
          ratio: item.ratio,
          quantity: item.quantity,
        };
        if (patch.genType === "Image" || patch.genType === "Video") {
          item.genType = patch.genType;
          item.settings.genType = patch.genType;
        }
        for (const field of [
          "flowVideoDuration",
          "flowVideoResolution",
          "flowThinkingLevel",
        ]) {
          if (patch[field] === null || typeof patch[field] === "string")
            item.settings[field] = patch[field];
        }
        for (const field of ["voice", "character"]) {
          if (Object.prototype.hasOwnProperty.call(patch, field))
            item.settings[field] = patch[field] || null;
        }
        if (typeof patch.autoDownload === "boolean")
          item.autoDownload = patch.autoDownload;
        for (const field of [
          "downloadResolution",
          "videoDownloadResolution",
          "taskName",
        ]) {
          if (patch[field] === null || typeof patch[field] === "string")
            item[field] = patch[field];
        }
        item.refFileIds = [...new Set(patch.refFileIds)];
        item.refFileNames = { ...patch.refFileNames };
        item.refThumbnails = { ...patch.refThumbnails };
        item.refImageMode = String(patch.refImageMode || "none");
        item.mentionData = patch.mentionData || null;
        map[pid] = { at: Date.now(), data: record };
        await _ftWriteCacheMap(key, map, pid);
        return { ok: true, cached: true };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_SAVE_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:clearProjectHistory") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        if (!pid) return { ok: false, error: "INVALID_CLEAR_TARGET" };
        const map = await _ftReadCacheMap(key, pid);
        delete map[pid];
        await _ftWriteCacheMap(key, map, pid);
        return { ok: true };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_CLEAR_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:recoveryPatch") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        const map = await _ftReadCacheMap(key, pid);
        const record = map[pid]?.data;
        if (!record?.sessions || !message.itemId)
          return { ok: false, error: "RECOVERY_ITEM_NOT_FOUND" };
        let found = null,
          ownerSession = null;
        for (const session of record.sessions)
          for (const job of session.jobs || []) {
            found = (job.items || []).find(
              (item) => item.id === message.itemId,
            );
            if (found) {
              ownerSession = session;
              break;
            }
          }
        if (!found) return { ok: false, error: "RECOVERY_ITEM_NOT_FOUND" };
        if (found.state === "CANCELLED")
          return { ok: false, error: "RECOVERY_ITEM_CANCELLED" };
        const patch = message.patch || {};
        if (found.recoveryExhausted === true)
          return { ok: false, error: "RECOVERY_ITEM_EXHAUSTED" };
        const results = new Map(
          (found.results || []).map((result) => [
            result.tileId || result.mediaId || result.url,
            result,
          ]),
        );
        for (const result of patch.results || [])
          results.set(result.tileId || result.mediaId || result.url, result);
        const lineage = new Map(
          (found.flowApiLineage || []).map((entry) => [
            entry.operationId,
            entry,
          ]),
        );
        for (const entry of patch.flowApiLineage || []) {
          const previous = lineage.get(entry.operationId) || {};
          const state = ["completed", "failed"].includes(previous.state)
            ? previous.state
            : patch.state === "COMPLETED"
              ? "completed"
              : patch.state === "FAILED"
                ? "failed"
                : null;
          lineage.set(entry.operationId, { ...previous, ...entry, state });
        }
        const merged = {
          ...found,
          ...patch,
          results: [...results.values()],
          flowApiLineage: [...lineage.values()],
        };
        const failures = _ftSanitizeProviderFailures([
          ...(found.errorPolicy?.failureDetails || []),
          ...(patch.errorPolicy?.failureDetails || []),
        ]);
        if (failures.length) {
          merged.errorPolicy = {
            ...found.errorPolicy,
            ...patch.errorPolicy,
            stage: "terminal",
            retryable: false,
            failureDetails: [
              ...new Map(
                failures.map((value) => [JSON.stringify(value), value]),
              ).values(),
            ],
          };
          merged.noRetry = true;
          merged.error = [
            ...new Set(
              merged.errorPolicy.failureDetails.map((value) =>
                [
                  value.message,
                  value.statusCode !== null
                    ? `Google status ${value.statusCode}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" \xB7 "),
              ),
            ),
          ]
            .join(" \xB7 ")
            .slice(0, 1200);
        }
        for (const entry of merged.flowApiLineage) {
          if (
            entry.mediaId &&
            merged.results.some(
              (result) => (result.tileId || result.mediaId) === entry.mediaId,
            )
          )
            entry.state = "completed";
        }
        const expected = Math.max(1, Number(found.quantity) || lineage.size);
        const allTerminal =
          lineage.size >= expected &&
          merged.flowApiLineage.every((entry) =>
            ["completed", "failed"].includes(entry.state),
          );
        const recoveryExhausted =
          patch.recoveryExhausted === true && patch.state === "FAILED";
        merged.state = recoveryExhausted
          ? merged.results.length
            ? "PARTIAL_FAIL"
            : "FAILED"
          : allTerminal
            ? merged.results.length
              ? merged.flowApiLineage.some((entry) => entry.state === "failed")
                ? "PARTIAL_FAIL"
                : "COMPLETED"
              : "FAILED"
            : "RECOVERY_REQUIRED";
        if (
          allTerminal &&
          merged.results.length &&
          merged.flowApiLineage.every((entry) => entry.state === "completed")
        ) {
          merged.error = null;
          merged.errorType = null;
          merged.errorPolicy = null;
          merged.noRetry = false;
        }
        Object.assign(found, _ftSanitizeItem(merged));
        ownerSession.updatedAt = Date.now();
        ownerSession.status = ownerSession.jobs.every((job) =>
          (job.items || []).every((item) =>
            ["COMPLETED", "PARTIAL_FAIL", "FAILED", "CANCELLED"].includes(
              item.state,
            ),
          ),
        )
          ? "terminal"
          : "recovery_required";
        map[pid] = { at: Date.now(), data: record };
        await _ftWriteCacheMap(key, map, pid);
        return { ok: true };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "RECOVERY_PATCH_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "ft:stopCachedJob") {
    _ftCacheWriteChain = _ftCacheWriteChain
      .catch(() => {})
      .then(async () => {
        const key = String(message.key || "toby_flow_tracker_snapshots");
        const pid = String(message.projectId || "");
        const map = await _ftReadCacheMap(key, pid);
        const record = map[pid]?.data;
        if (!pid || !message.jobId)
          return { ok: false, error: "INVALID_CACHE_STOP_TARGET" };
        let found = false;
        for (const session of record?.sessions || []) {
          const job = (session.jobs || []).find(
            (entry) =>
              entry.id === message.jobId ||
              entry.executionJobId === message.jobId,
          );
          if (!job) continue;
          found = true;
          job.status = "stopped";
          job.pauseReason = null;
          job.recoveryLabel = null;
          job.recoveryRequired = null;
          job.recoveryHint = null;
          for (const item of job.items || []) {
            if (_ftCachedItemIsBusy(item)) {
              item.state = "CANCELLED";
              item.providerGenerationState = "CANCELLED";
              item.errorType = "cancelled";
              item.error = "STOPPED_AFTER_PAGE_RELOAD";
              item.completedAt = Date.now();
            }
            if (item.state === "CANCELLED") {
              item.recoveryLabel = null;
              item.recoveryPhase = null;
              item.recoveryCode = null;
              item.recoveryAttempt = 0;
              item.recoveryMaxAttempts = 0;
              item.statusLabel = null;
              item.statusKind = null;
              item.statusReason = null;
              item.apiWaiting = false;
              item.apiWaitingLabel = null;
            }
          }
          session.status = (session.jobs || []).some((entry) =>
            ["running", "paused", "pending", "queued"].includes(entry.status),
          )
            ? "running"
            : "terminal";
          session.updatedAt = Date.now();
          break;
        }
        if (!found && message.allowMissingCache !== true)
          return { ok: false, error: "CACHED_JOB_NOT_FOUND" };
        const trustedLiveQueueCommit =
          message.durableCleanupCommitted === true &&
          typeof sender?.url === "string" &&
          sender.url.startsWith(chrome.runtime.getURL(""));
        if (!trustedLiveQueueCommit) {
          await _ftPersistRecoveryStop(message.jobId, pid);
          for (const checkpointKey of [
            "toby_flow_api_checkpoints_v1",
            "toby_flow_api_checkpoints_v2_schema1",
          ]) {
            const checkpointStored = await chrome.storage.local.get([
              checkpointKey,
            ]);
            const checkpoints = checkpointStored?.[checkpointKey] || {};
            let checkpointChanged = false;
            for (const [operationId, checkpoint] of Object.entries(
              checkpoints,
            )) {
              if (checkpoint?.jobId !== message.jobId) continue;
              delete checkpoints[operationId];
              checkpointChanged = true;
            }
            if (checkpointChanged)
              await chrome.storage.local.set({ [checkpointKey]: checkpoints });
          }
        }
        if (found) {
          map[pid] = { at: Date.now(), data: record };
          await _ftWriteCacheMap(key, map, pid);
        }
        return { ok: true, cacheFound: found };
      });
    _ftCacheWriteChain
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CACHE_STOP_FAILED",
        }),
      );
    return true;
  }
  if (message?.type === "uploadToFlow") {
    doUploadToFlow(message).then(sendResponse);
    return true;
  }
  if (message.action === "ping") {
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "updateProviderUrlsCache") {
    if (!ProtectedConfigClient.allowedSender(sender)) {
      sendResponse({
        success: false,
        error: { code: "PROTECTED_RPC_FORBIDDEN" },
      });
      return false;
    }
    ProtectedConfigClient.fetch("api")
      .then(async (result) => {
        _serverUrlsCache = Object.fromEntries(
          Object.entries(result.data)
            .filter(([, data]) => data?.configs?.urls)
            .map(([slug, data]) => [slug, data.configs.urls]),
        );
        await chrome.storage.session.set({
          _provider_urls_cache: {
            data: Object.fromEntries(
              Object.entries(_serverUrlsCache).filter(
                ([slug]) => slug !== "flow",
              ),
            ),
            scope: result.meta.access,
          },
        });
        sendResponse({ success: true });
      })
      .catch((error) =>
        sendResponse({ success: false, error: { code: error.code } }),
      );
    return true;
  }
  if (
    message.action === "getProviderConfigs" ||
    message.action === "getProviderApiConfigs"
  ) {
    if (
      !ProtectedConfigClient.allowedProviderSender(sender, message.provider)
    ) {
      sendResponse({
        success: false,
        error: { code: "PROTECTED_RPC_FORBIDDEN" },
        httpStatus: 403,
      });
      return false;
    }
    const operation = message.action === "getProviderConfigs" ? "dom" : "api";
    ProtectedConfigClient.envelope(operation, {
      force: message.force === true,
    }).then((result) => {
      if (!result.success) {
        sendResponse(result);
        return;
      }
      const provider = message.provider;
      const row = provider ? result.data?.[provider] || null : null;
      const data =
        operation === "api" &&
        ["chatgpt", "grok", "gemini", "muse"].includes(provider) &&
        row
          ? { ...row, configs: {} }
          : row;
      sendResponse({
        success: !!data,
        data,
        meta: result.meta,
        httpStatus: result.httpStatus,
      });
    });
    return true;
  }
  if (message.action === "getProviderPrivateConfigs") {
    const provider = message.provider;
    if (
      !["chatgpt", "grok", "gemini", "muse"].includes(provider) ||
      !ProtectedConfigClient.allowedProviderSender(sender, provider)
    ) {
      sendResponse({
        success: false,
        error: { code: "PROTECTED_RPC_FORBIDDEN" },
        httpStatus: 403,
      });
      return false;
    }
    ProtectedConfigClient.envelope("private", {
      provider,
      force: message.force === true,
    }).then((result) => {
      if (!result.success) {
        sendResponse(result);
        return;
      }
      const data = result.data?.[provider] || null;
      sendResponse({
        success: !!data,
        data,
        meta: result.meta,
        httpStatus: result.httpStatus,
      });
    });
    return true;
  }
  if (message.action === "reportSelectorFailure") {
    (async () => {
      try {
        const { provider, key, tried_selectors } = message.data || {};
        const baseUrl = await _getApiBaseUrl();
        _signedFetch(`${baseUrl}/api/v1/analytics/selector-failure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Extension-Id": chrome.runtime.id,
          },
          body: JSON.stringify({
            provider,
            key,
            tried_selectors,
            timestamp: new Date().toISOString(),
          }),
        })
          .then(async (resp) => {
            if (resp.status === 403) {
              try {
                const body = await resp.clone().json();
                if (_isExtensionAuthRejection(body, 403))
                  _handleExtensionAuthRejection();
              } catch (_) {}
            }
          })
          .catch(() => {});
      } catch {}
    })();
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "providerConfigUpdated") {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs
          .sendMessage(tab.id, {
            action: "providerConfigUpdated",
            data: message.data,
          })
          .catch(() => {});
      });
    });
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "providerApiConfigUpdated") {
    if (
      message.data?.key === "watermark_removal" ||
      message.data?.key === "watermark_removal_video"
    ) {
      _wmInvalidate("SSE b\xE1o c\u1EA5u h\xECnh \u0111\u1ED5i");
    }
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs
          .sendMessage(tab.id, {
            action: "providerApiConfigUpdated",
            data: message.data,
          })
          .catch(() => {});
      });
    });
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "removeWatermarkAndDownload") {
    (async () => {
      const { url, filename } = message;
      try {
        if (
          message.requestId &&
          _geminiDownloadJobs.get(message.requestId)?.error ===
            "DOWNLOAD_STOPPED"
        ) {
          sendResponse({ success: false, error: "DOWNLOAD_STOPPED" });
          return;
        }
        let r =
          message.alreadyClean && message.base64
            ? {
                success: true,
                applied: true,
                base64: message.base64,
                mime: message.mime,
              }
            : await _removeWatermarkFromSource({
                url,
                base64: message.base64,
                mime: message.mime,
                mediaType: message.mediaType,
              });
        const noWatermarkReason = [
          "not_found",
          "below_threshold",
          "already_clean_output",
        ].includes(r?.reason || r?.error);
        if ((!r.success || !r.applied) && noWatermarkReason && message.base64) {
          console.info(
            `[Watermark] kh\xF4ng ph\xE1t hi\u1EC7n watermark (${r.reason || r.error}) \u2192 t\u1EA3i file g\u1ED1c`,
          );
          r = {
            success: true,
            applied: true,
            base64: message.base64,
            mime: message.mime,
            original: true,
            watermarkReason: r.reason || r.error,
          };
        } else if (!r.success || !r.applied) {
          console.warn(
            `[Watermark] KH\xD4NG xo\xE1 \u0111\u01B0\u1EE3c: reason=${r.error || r.reason || "not_applied"}` +
              (r.ncc != null ? ` ncc=${Number(r.ncc).toFixed(3)}` : "") +
              ` mediaType=${message.mediaType || "image"}`,
          );
          sendResponse({
            success: false,
            fallback: true,
            reason: r.error || r.reason || "not_applied",
          });
          return;
        }
        const dataUrl = `data:${r.mime || "image/png"};base64,${r.base64}`;
        if (
          message.requestId &&
          _geminiDownloadJobs.get(message.requestId)?.error ===
            "DOWNLOAD_STOPPED"
        ) {
          sendResponse({ success: false, error: "DOWNLOAD_STOPPED" });
          return;
        }
        _queueDownloadRename(filename, dataUrl, message.requestId || null);
        const downloadId = await chrome.downloads.download({
          url: dataUrl,
          filename: filename || void 0,
          conflictAction: "uniquify",
        });
        if (message.requestId) {
          const cancelled =
            _geminiDownloadJobs.get(message.requestId)?.error ===
            "DOWNLOAD_STOPPED";
          _setGeminiDownloadJob(message.requestId, { downloadId });
          if (cancelled)
            await chrome.downloads.cancel(downloadId).catch(() => {});
        }
        if (message.waitForComplete) {
          const completed = await _waitForChromeDownload(
            downloadId,
            message.waitTimeoutMs,
            message.flowApiDownloadRetry === true,
          );
          if (message.requestId) _geminiDownloadJobs.delete(message.requestId);
          sendResponse({
            ...completed,
            cleaned: r.original !== true,
            original: r.original === true,
            watermarkReason: r.watermarkReason || null,
          });
        } else {
          if (message.requestId) _geminiDownloadJobs.delete(message.requestId);
          sendResponse({
            success: true,
            cleaned: r.original !== true,
            original: r.original === true,
            watermarkReason: r.watermarkReason || null,
            downloadId,
          });
        }
      } catch (e) {
        console.warn(
          "[Watermark] removeWatermarkAndDownload l\u1ED7i:",
          e?.message,
        );
        sendResponse({
          success: false,
          fallback: true,
          reason: e?.message || "EXCEPTION",
        });
      }
    })();
    return true;
  }
  if (message.action === "getWatermarkConfig") {
    (async () => {
      try {
        const kind = message.mediaType === "video" ? "video" : "image";
        if (!(await _wmGateAllowed(kind))) {
          sendResponse({ success: false, error: "NOT_ALLOWED" });
          return;
        }
        let { cfg, error } = await _wmGetConfig();
        if (error === "STALE") ({ cfg, error } = await _wmGetConfig());
        if (!cfg) {
          sendResponse({ success: false, error: error || "NO_CONFIG" });
          return;
        }
        sendResponse({ success: true, cfg });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || "EXCEPTION" });
      }
    })();
    return true;
  }
  if (message.action === "wm:canRemove") {
    (async () => {
      try {
        const kind = message.mediaType === "video" ? "video" : "image";
        const ok = await _wmGateAllowed(kind);
        sendResponse({ allowed: ok, reason: ok ? null : "GATE_BLOCKED" });
      } catch (e) {
        sendResponse({ allowed: false, reason: e?.message || "EXCEPTION" });
      }
    })();
    return true;
  }
  if (message.action === "wm:getInterceptConfig") {
    (async () => {
      try {
        let { cfg, error } = await _wmGetConfig();
        if (error === "STALE") ({ cfg, error } = await _wmGetConfig());
        const ic = cfg?.intercept;
        const pats = Array.isArray(ic?.url_patterns)
          ? ic.url_patterns.filter((s) => typeof s === "string" && s)
          : [];
        if (!pats.length) {
          console.warn(
            "[WM] ch\u01B0a c\xF3 intercept.url_patterns t\u1EEB server \u2192 kh\xF4ng ch\u1EB7n t\u1EA7ng m\u1EA1ng" +
              (error ? ` (${error})` : ""),
          );
        }
        sendResponse({
          success: true,
          enabled: pats.length > 0 && ic?.enabled !== false,
          patterns: pats,
          timeout_ms: Number.isFinite(ic?.timeout_ms) ? ic.timeout_ms : void 0,
          image_timeout_ms: Number.isFinite(ic?.image_timeout_ms)
            ? ic.image_timeout_ms
            : void 0,
          reason: error || (pats.length ? null : "NO_URL_PATTERNS"),
        });
      } catch (e) {
        console.warn(
          "[WM] kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c c\u1EA5u h\xECnh ch\u1EB7n:",
          e?.message,
        );
        sendResponse({
          success: false,
          enabled: false,
          patterns: [],
          reason: "EXCEPTION",
        });
      }
    })();
    return true;
  }
  if (message.action === "removeWatermark") {
    (async () => {
      try {
        const r = await _removeWatermarkFromSource(message);
        sendResponse(r);
      } catch (err) {
        console.warn("[TobyFlow] removeWatermark exception:", err?.message);
        sendResponse({ success: false, error: err?.message || "EXCEPTION" });
      }
    })();
    return true;
  }
  if (message.action === "openFlowTabForLogin") {
    (async () => {
      try {
        console.log("[Background] openFlowTabForLogin called");
        const flowTabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        console.log("[Background] Found Flow tabs:", flowTabs.length);
        if (flowTabs.length > 0) {
          await chrome.tabs.update(flowTabs[0].id, { active: true });
          await chrome.windows.update(flowTabs[0].windowId, { focused: true });
          console.log(
            "[Background] Focused existing Flow tab:",
            flowTabs[0].id,
          );
        } else {
          const newTab = await chrome.tabs.create({
            url: PROVIDER_URLS.flow.createUrl,
          });
          console.log("[Background] Created new Flow tab:", newTab.id);
        }
      } catch (err) {
        console.error("[Background] openFlowTabForLogin error:", err);
      }
    })();
    return true;
  }
  if (message.action === "openProviderTab") {
    (async () => {
      try {
        const provider = message.provider;
        const focusWindow = message.focusWindow !== false;
        let museTabConfig = null;
        if (provider === "muse") {
          const baseUrl = getProviderUrl("muse", "baseUrl");
          const newChatUrl = getProviderUrl("muse", "newChatUrl");
          let target;
          try {
            target = new URL(newChatUrl);
            if (
              target.protocol !== "https:" ||
              target.origin !== new URL(baseUrl).origin
            )
              throw new Error("INVALID_ORIGIN");
          } catch (_) {
            sendResponse({
              ok: false,
              error: "MUSE_NEW_CHAT_URL_CONFIG_MISSING",
            });
            return;
          }
          museTabConfig = {
            urlPattern: `*://${target.hostname}/*`,
            createUrl: target.href,
          };
        }
        const providerConfig = {
          muse: museTabConfig,
          flow: {
            urlPattern: getFlowTabQueryPatterns(),
            createUrl: PROVIDER_URLS.flow.createUrl,
          },
          chatgpt: {
            urlPattern: PROVIDER_URLS.chatgpt.tabQuery,
            createUrl: PROVIDER_URLS.chatgpt.createUrl,
          },
          grok: {
            urlPattern: PROVIDER_URLS.grok.tabQueryPatterns,
            createUrl: PROVIDER_URLS.grok.createUrl,
          },
          gemini: {
            urlPattern: PROVIDER_URLS.gemini.tabQuery,
            createUrl: PROVIDER_URLS.gemini.createUrl,
          },
        };
        const config = providerConfig[provider];
        if (!config || !config.urlPattern || !config.createUrl) {
          sendResponse({ ok: false, error: "UNKNOWN_PROVIDER" });
          return;
        }
        const patterns = Array.isArray(config.urlPattern)
          ? config.urlPattern
          : [config.urlPattern];
        let existingTab = null;
        if (provider === "flow") {
          const flowTabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          existingTab = await selectFlowStatusTab(
            flowTabs,
            message.targetTabId,
          );
        }
        for (const pattern of patterns) {
          if (existingTab) break;
          const tabs = await chrome.tabs.query({ url: pattern });
          if (tabs.length > 0) {
            existingTab = tabs[0];
            break;
          }
        }
        if (existingTab) {
          await chrome.tabs.update(existingTab.id, { active: true });
          if (focusWindow) {
            await chrome.windows.update(existingTab.windowId, {
              focused: true,
            });
          }
          console.log(
            `[Background] Activated existing ${provider} tab:`,
            existingTab.id,
            focusWindow ? "(focused)" : "(no focus)",
          );
          sendResponse({ ok: true, tabId: existingTab.id, existing: true });
        } else {
          const newTab = await chrome.tabs.create({
            url: config.createUrl,
            active: true,
          });
          if (focusWindow) {
            await chrome.windows.update(newTab.windowId, { focused: true });
          }
          console.log(
            `[Background] Created new ${provider} tab:`,
            newTab.id,
            focusWindow ? "(focused)" : "(no focus)",
          );
          sendResponse({ ok: true, tabId: newTab.id, existing: false });
        }
      } catch (err) {
        console.error("[Background] openProviderTab error:", err);
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "openSettings") {
    openSettingsWindow(message.tab || null)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("[Background] openSettings failed:", error);
        sendResponse({
          ok: false,
          error: error?.message || "SETTINGS_OPEN_FAILED",
        });
      });
    return true;
  }
  if (message.action === "openUpgradeModal") {
    chrome.runtime.sendMessage({ action: "showUpgradeModal" }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "openUpgradeSidePanel") {
    return openUpgradeSidebar(message.windowId, sendResponse);
  }
  if (message.action === "openLoginModal") {
    chrome.runtime.sendMessage({ action: "showLoginOverlay" }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "openLoginSidePanel") {
    const windowId = Number.isInteger(message.windowId)
      ? message.windowId
      : Number.isInteger(sender?.tab?.windowId)
        ? sender.tab.windowId
        : null;
    if (!windowId || !chrome.sidePanel?.open) {
      sendResponse({ ok: false, error: "BROWSER_WINDOW_NOT_READY" });
      return false;
    }
    let opened;
    try {
      opened = chrome.sidePanel.open({ windowId });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error?.message || "SIDEBAR_OPEN_FAILED",
      });
      return false;
    }
    (async () => {
      try {
        await opened;
        await chrome.windows
          .update(windowId, { focused: true })
          .catch(() => {});
        await chrome.storage.session.set({
          tobyflow_pending_login_overlay: Date.now(),
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || "SIDEBAR_OPEN_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "flow:openSidebar") {
    (async () => {
      const tabId = sender?.tab?.id;
      try {
        if (tabId && chrome.sidePanel?.open)
          await chrome.sidePanel.open({ tabId });
      } catch (e) {
        console.warn("[Background] flow:openSidebar fail:", e.message);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === "affiliate:setRef") {
    const code = (message.code || "").trim();
    if (code) {
      try {
        chrome.storage.local.set({
          tf_ref: { code, expires: Date.now() + 90 * 24 * 60 * 60 * 1e3 },
        });
      } catch (_) {}
    }
    sendResponse({ ok: true });
    return false;
  }
  if (message.action === "openSidePanelForTemplateUse") {
    const tabId = Number.isInteger(message.tabId) ? message.tabId : null;
    if (!tabId || !chrome.sidePanel?.open) {
      sendResponse({ ok: false, error: "FLOW_TAB_NOT_READY" });
      return false;
    }
    let openPromise;
    try {
      openPromise = chrome.sidePanel.open({ tabId });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
      return false;
    }
    (async () => {
      try {
        await openPromise;
        await chrome.storage.local.set({
          _pendingTemplateClone: message.pendingClone,
        });
        sendResponse({ ok: true });
      } catch (e) {
        console.error(
          "[Background] openSidePanelForTemplateUse error:",
          e.message,
          e,
        );
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "openSidePanel") {
    (async () => {
      try {
        let tabId = null;
        const flowTabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (flowTabs.length > 0) {
          tabId = flowTabs[0].id;
          console.log("[Background] Found existing Flow tab:", tabId);
        } else {
          console.log("[Background] No Flow tab found, creating new one");
          const newTab = await chrome.tabs.create({
            url: PROVIDER_URLS.flow.createUrl,
          });
          tabId = newTab.id;
          await new Promise((resolve) => {
            const checkLoaded = (updatedTabId, info) => {
              if (updatedTabId === tabId && info.status === "complete") {
                chrome.tabs.onUpdated.removeListener(checkLoaded);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(checkLoaded);
            setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(checkLoaded);
              resolve();
            }, 1e4);
          });
          await new Promise((r) => setTimeout(r, 300));
        }
        await chrome.sidePanel.open({ tabId });
        if (message.closeSettingsWindow && settingsWindowId) {
          try {
            await chrome.windows.remove(settingsWindowId);
          } catch (e) {
            settingsWindowId = null;
            _persistWindowIds();
          }
        }
        if (message.showLoginOverlay) {
          setTimeout(() => {
            chrome.runtime
              .sendMessage({ action: "showLoginOverlay" })
              .catch(() => {});
          }, 500);
        }
        sendResponse({ ok: true });
      } catch (e) {
        console.error("[Background] openSidePanel error:", e.message, e);
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "openWorkflowEditor") {
    (async () => {
      try {
        const ready = await _isFlowProjectReadyBg();
        if (!ready) {
          console.warn(
            "[Background] openWorkflowEditor B\u1ECA CH\u1EB6N \u2014 Flow project ch\u01B0a s\u1EB5n s\xE0ng (re-gate)",
          );
          sendResponse({ ok: false, error: "PROJECT_NOT_READY" });
          return;
        }
        const opened = await openWorkflowWindow(message.data || null);
        sendResponse(
          opened
            ? { ok: true }
            : { ok: false, error: "WORKFLOW_WINDOW_OPEN_FAILED" },
        );
      } catch (error) {
        console.error("[Background] openWorkflowEditor failed:", error);
        sendResponse({ ok: false, error: "WORKFLOW_WINDOW_OPEN_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "openTemplateEditor") {
    openTemplateEditorWindow(message.data || null);
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "openWorkflowTemplatePreview") {
    const template = message.template;
    if (!template) {
      sendResponse({ ok: false, error: "NO_TEMPLATE" });
      return true;
    }
    (async () => {
      await openTemplatePreviewWindow(template, message.kind || "template");
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === "openWorkflowTemplatePreviewById") {
    const templateId = message.templateId;
    const refCode = (message.refCode || "").trim();
    if (!templateId) {
      sendResponse({ ok: false, error: "NO_TEMPLATE_ID" });
      return true;
    }
    (async () => {
      try {
        if (refCode) {
          try {
            chrome.storage.local.set({
              tf_ref: {
                code: refCode,
                expires: Date.now() + 90 * 24 * 60 * 60 * 1e3,
              },
            });
          } catch (_) {}
        }
        const apiBaseUrl = getApiBaseUrl();
        const fetchUrl =
          message.kind === "official"
            ? `${apiBaseUrl}/workflow-templates/${encodeURIComponent(templateId)}`
            : `${apiBaseUrl}/creator-templates/${encodeURIComponent(templateId)}/public`;
        const resp = await _signedFetch(fetchUrl, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "X-Extension-Id": chrome.runtime.id,
          },
          cache: "no-store",
        });
        const json = await resp.json().catch(() => null);
        if (!resp.ok || !json?.success || !json?.data) {
          sendResponse({
            ok: false,
            error: "FETCH_FAILED",
            status: resp.status,
          });
          return;
        }
        await openWebsiteTemplatePreview(json.data);
        sendResponse({ ok: true });
      } catch (err) {
        console.error(
          "[Background] openWorkflowTemplatePreviewById error:",
          err.message,
        );
        sendResponse({ ok: false, error: "EXCEPTION", message: err.message });
      }
    })();
    return true;
  }
  if (message.action === "importWorkflowTemplate") {
    if (message.template) {
      chrome.storage.local.set({
        _pendingTemplateImport: {
          template: message.template,
          timestamp: Date.now(),
        },
      });
      chrome.runtime
        .sendMessage({
          action: "workflowTemplateImportRequested",
          template: message.template,
        })
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }
  if (
    message.action === "cloneWorkflowTemplate" &&
    sender?.tab?.windowId != null
  ) {
    setTimeout(() => {
      void closeUsedTemplatePreview(sender);
    }, 150);
  }
  if (message.action === "openAnglesEditor") {
    if (message.projectId) {
      chrome.storage.local.set({
        _pendingAnglesProject: {
          projectId: message.projectId,
          projectName: message.projectName || null,
        },
      });
    }
    openAnglesWindow();
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "motionRunner:ensure") {
    _motionRunnerEnsure(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_RUNNER_START_FAILED",
      }),
    );
    return true;
  }
  if (
    [
      "motionRunner:start",
      "motionRunner:resume",
      "motionRunner:pause",
      "motionRunner:stop",
      "motionRunner:resetFrame",
      "motionRunner:startBatch",
      "motionRunner:resumeBatch",
      "motionRunner:pauseBatch",
      "motionRunner:stopBatch",
    ].includes(message.action)
  ) {
    (async () => {
      let caller;
      try {
        caller = new URL(sender?.url);
      } catch (_) {
        return sendResponse({
          success: false,
          error: "MOTION_RUNNER_SENDER_INVALID",
        });
      }
      const allowed = ["sidebar.html", "motion-editor.html"].some((page) => {
        const expected = new URL(chrome.runtime.getURL(page));
        return (
          caller.protocol === expected.protocol &&
          caller.host === expected.host &&
          caller.pathname === expected.pathname
        );
      });
      if (sender?.id !== chrome.runtime.id || !allowed)
        return sendResponse({
          success: false,
          error: "MOTION_RUNNER_SENDER_INVALID",
        });
      const editorCaller =
        caller.pathname ===
        new URL(chrome.runtime.getURL("motion-editor.html")).pathname;
      if (message.action === "motionRunner:resetFrame" && !editorCaller)
        return sendResponse({
          success: false,
          error: "MOTION_RUNNER_SCOPE_INVALID",
        });
      if (
        message.taskKind !== void 0 &&
        (!editorCaller || message.taskKind !== "transcript_batch")
      )
        return sendResponse({
          success: false,
          error: "MOTION_RUNNER_SCOPE_INVALID",
        });
      let host;
      if (
        ![
          "motionRunner:pause",
          "motionRunner:stop",
          "motionRunner:resetFrame",
          "motionRunner:pauseBatch",
          "motionRunner:stopBatch",
        ].includes(message.action)
      ) {
        host = await _motionRunnerEnsure(message, sender);
        if (!host?.success) return sendResponse(host);
      } else {
        host = (
          await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
        )?.[MotionRunnerHostRegistry.KEY];
        const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
        if (message.action === "motionRunner:resetFrame" && !host)
          return sendResponse({
            success: false,
            error: "MOTION_RUNNER_NOT_FOUND",
          });
        if (!host || !auth?.token || Number(auth.user?.id) !== host.userId)
          return sendResponse({
            success: false,
            error: "MOTION_RUNNER_ACCOUNT_CHANGED",
          });
        if (message.action === "motionRunner:resetFrame") {
          if (
            !Number.isInteger(host.tabId) ||
            !Number.isInteger(host.windowId) ||
            !Number.isSafeInteger(host.epoch) ||
            host.epoch < 1
          )
            return sendResponse({
              success: false,
              error: "MOTION_RUNNER_OWNER_INVALID",
            });
          const tab = await chrome.tabs.get(host.tabId).catch(() => null);
          const absent = !tab;
          const config = (await chrome.storage.local.get("af_system_settings"))
            ?.af_system_settings;
          const timeoutMs = Number(config?.api_timeout_ms);
          if (!absent && (!Number.isFinite(timeoutMs) || timeoutMs <= 0))
            return sendResponse({
              success: false,
              error: "API_TIMEOUT_CONFIG_UNAVAILABLE",
            });
          const ready =
            !absent &&
            (await MotionRunnerHostRegistry._verify(host, {
              allowPending: true,
            })) &&
            (await MotionRunnerHostRegistry._awaitReady(host, timeoutMs));
          const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
          const current = (
            await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
          )?.[MotionRunnerHostRegistry.KEY];
          if (
            latest?.token !== auth.token ||
            Number(latest?.user?.id) !== host.userId
          )
            return sendResponse({
              success: false,
              error: "ACCOUNT_SCOPE_CHANGED",
            });
          if (
            ["userId", "tabId", "windowId", "epoch"].some(
              (key) => current?.[key] !== host[key],
            )
          )
            return sendResponse({
              success: false,
              error: "MOTION_RUNNER_OWNER_MISMATCH",
            });
          console.info(
            "[MotionResultEdit]",
            JSON.stringify({
              action: "reset",
              frameId: message.frameId,
              stage: "runner_reset_preflight",
              tabId: host.tabId,
              epoch: host.epoch,
              state: absent
                ? "host_absent"
                : ready
                  ? "host_ready"
                  : "host_not_ready",
            }),
          );
          if (absent)
            return sendResponse({
              success: false,
              error: "MOTION_RUNNER_NOT_FOUND",
            });
          if (!ready || !(await MotionRunnerHostRegistry._verify(host)))
            return sendResponse({
              success: false,
              error: "MOTION_RUNNER_NOT_READY",
            });
        }
      }
      const hostAction =
        message.action === "motionRunner:resetFrame"
          ? "motionRunner:resetFrameHost"
          : ["motionRunner:pause", "motionRunner:stop"].includes(message.action)
            ? "motionRunner:pauseProject"
            : message.action === "motionRunner:startBatch"
              ? "motionRunner:startBatchHost"
              : message.action === "motionRunner:resumeBatch"
                ? "motionRunner:resumeBatchHost"
                : message.action === "motionRunner:stopBatch"
                  ? "motionRunner:stopBatchHost"
                  : message.action === "motionRunner:pauseBatch"
                    ? "motionRunner:pauseBatchHost"
                    : "motionRunner:startProject";
      const response = await chrome.runtime.sendMessage({
        action: hostAction,
        tabId: host.tabId,
        epoch: host.epoch,
        projectId: message.projectId,
        flowProjectId: message.flowProjectId,
        runId: message.runId,
        screen: message.screen,
        ...(message.action === "motionRunner:resetFrame"
          ? {
              frameId: message.frameId,
              preserveGenerated: message.preserveGenerated === true,
            }
          : {}),
        confirmedFlowMode:
          caller.pathname ===
          new URL(chrome.runtime.getURL("motion-editor.html")).pathname
            ? message.confirmedFlowMode
            : null,
        batchId: message.batchId,
        skipProjectId: message.skipProjectId,
        ...(editorCaller && message.taskKind === "transcript_batch"
          ? { taskKind: message.taskKind, frameIds: message.frameIds }
          : {}),
        stop: message.action === "motionRunner:stop",
        resume: message.action === "motionRunner:resume",
      });
      sendResponse(
        response || { success: false, error: "MOTION_RUNNER_NOT_READY" },
      );
    })().catch((error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_RUNNER_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "motionWorker:create") {
    _motionWorkerCreate(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_WORKER_CREATE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "motionWorker:close") {
    _motionWorkerClose(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_WORKER_CLOSE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "motionWorker:releaseLayout") {
    _motionReleaseLayout(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.code || error?.message || "MOTION_LAYOUT_RELEASE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "motionWorker:reconcile") {
    _motionWorkerReconcile(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_WORKER_RECONCILE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "motionWorker:beforeSend") {
    _motionWorkerBeforeSend(message, sender).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_WORKER_SEND_FAILED",
      }),
    );
    return true;
  }
  if (
    message.action === "motionWorker:focus" ||
    message.action === "motionWorker:restoreFocus" ||
    message.action === "motionWorker:verify"
  ) {
    _motionWorkerFocus(
      message,
      sender,
      message.action === "motionWorker:restoreFocus",
      message.action === "motionWorker:verify",
    ).then(sendResponse, (error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_WORKER_FOCUS_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "motionRunner:closeIdle") {
    (async () => {
      let caller;
      try {
        caller = new URL(sender?.url);
      } catch (_) {
        return sendResponse({
          success: false,
          error: "MOTION_RUNNER_SENDER_INVALID",
        });
      }
      const expected = new URL(chrome.runtime.getURL("motion-runner.html"));
      const host = (
        await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
      )?.[MotionRunnerHostRegistry.KEY];
      if (
        sender?.id !== chrome.runtime.id ||
        caller.protocol !== expected.protocol ||
        caller.host !== expected.host ||
        caller.pathname !== expected.pathname ||
        sender.tab?.id !== host?.tabId ||
        message.epoch !== host?.epoch
      ) {
        return sendResponse({
          success: false,
          error: "MOTION_RUNNER_SENDER_INVALID",
        });
      }
      const settings = await chrome.storage.local.get("af_system_settings");
      const timeoutMs = Number(settings?.af_system_settings?.api_timeout_ms);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return sendResponse({
          success: false,
          error: "API_TIMEOUT_CONFIG_UNAVAILABLE",
        });
      }
      sendResponse(
        await MotionRunnerHostRegistry.closeIdle({
          userId: host.userId,
          epoch: host.epoch,
          timeoutMs,
        }),
      );
    })().catch((error) =>
      sendResponse({
        success: false,
        error: error?.message || "MOTION_RUNNER_CLOSE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "openMotionStudioEditor") {
    const id = String(message.toolProjectId || "");
    if (
      !ProtectedConfigClient.allowedSender(sender) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    ) {
      sendResponse({ ok: false, error: "INVALID_MOTION_PROJECT" });
      return false;
    }
    openMotionStudioWindow(id, message).then(sendResponse, (error) =>
      sendResponse({
        ok: false,
        error: error?.message || "MOTION_EDITOR_OPEN_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "openEffectsEditor") {
    if (message.projectId) {
      chrome.storage.local.set({
        _pendingEffectsProject: {
          projectId: message.projectId,
          projectName: message.projectName || null,
        },
      });
    }
    openEffectsWindow();
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "executionStatusUpdate") {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "workflowSaved") {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "workflowDeleted") {
    chrome.runtime.sendMessage(message).catch(() => {});
    if (editingWorkflowId && editingWorkflowId === message.wfId) {
      editingWorkflowId = null;
      _persistWindowIds();
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "openWebSpaces") {
    if (message.createNew === true) {
      sendResponse({ ok: false, error: "WORKFLOW_NAME_REQUIRED" });
      return false;
    }
    openWebSpacesWindow(message, sendResponse);
    return true;
  }
  if (message.action === "workflowSpaceTransferProgress") {
    const allowed = [
      "sidebar.html",
      "workflow-editor.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    if (
      sender?.id !== chrome.runtime.id ||
      !allowed.includes(String(sender?.url || "").split(/[?#]/)[0]) ||
      ![
        "workflow:bridge_upload",
        "workflow:download",
        "workflow:media_status",
      ].includes(message.event) ||
      !message.data?.workflowId ||
      !message.data?.userId ||
      !message.data?.nodeId
    ) {
      sendResponse({ ok: false, error: "SPACE_TRANSFER_HOST_REQUIRED" });
      return false;
    }
    chrome.tabs.query(
      {
        url: [
          "https://local.566flow.invalid/app/spaces/*",
          "https://566flow.invalid/app/spaces/*",
        ],
      },
      (tabs) => {
        void chrome.runtime.lastError;
        for (const tab of tabs || [])
          if (tab.id != null)
            chrome.tabs.sendMessage(
              tab.id,
              {
                action: "wfNodeStatusRelay",
                event: message.event,
                data: message.data,
              },
              () => void chrome.runtime.lastError,
            );
      },
    );
    sendResponse({ ok: true });
    return false;
  }
  if (message.action === "workflowSpaceResultPatch") {
    if (
      sender?.id !== chrome.runtime.id ||
      !["sidebar.html", "workflow-editor.html", "run-window.html"]
        .map((path) => chrome.runtime.getURL(path))
        .includes(sender?.url?.split(/[?#]/)[0])
    ) {
      sendResponse({ ok: false, error: "SPACE_RESULT_HOST_REQUIRED" });
      return false;
    }
    _spaceEventBroker.publish(
      "space:node_result",
      message.data,
      sender.documentId,
    );
    chrome.tabs.query(
      {
        url: [
          "https://local.566flow.invalid/app/spaces/*",
          "https://566flow.invalid/app/spaces/*",
        ],
      },
      (tabs) => {
        void chrome.runtime.lastError;
        for (const tab of tabs || [])
          if (tab.id != null)
            chrome.tabs.sendMessage(
              tab.id,
              {
                action: "wfNodeStatusRelay",
                event: "space:node_result",
                data: message.data,
              },
              () => void chrome.runtime.lastError,
            );
      },
    );
    sendResponse({
      ok: true,
      spaceTransport: _spaceEventBroker.stats(message.data),
    });
    return false;
  }
  if (message.action === "workflowExecutionEvent") {
    if (message._bg_relayed) {
      sendResponse({ ok: true });
      return true;
    }
    const WEB_RELAY_EVENTS = [
      "node:queued",
      "node:queue_cancelled",
      "node:run_rejected",
      "execution:single_node_state",
      "node:cancelled",
      "execution:started",
      "node:started",
      "node:phase",
      "node:completed",
      "node:failed",
      "node:review",
      "execution:completed",
      "workflow:reset",
      "execution:captcha_detected",
      "execution:quota_exceeded",
      "node:policy_blocked",
      "execution:rate_limited",
      "execution:captcha_resolved",
    ];
    if (WEB_RELAY_EVENTS.includes(message.event)) {
      try {
        chrome.tabs.query(
          {
            url: [
              "https://local.566flow.invalid/app/spaces/*",
              "https://566flow.invalid/app/spaces/*",
            ],
          },
          (tabs) => {
            void chrome.runtime.lastError;
            (tabs || []).forEach((t) => {
              if (t.id == null) return;
              chrome.tabs.sendMessage(
                t.id,
                {
                  action: "wfNodeStatusRelay",
                  event: message.event,
                  data: message.data,
                },
                () => void chrome.runtime.lastError,
              );
            });
          },
        );
      } catch (e) {}
    }
    chrome.runtime
      .sendMessage({ ...message, _bg_relayed: true })
      .then(() => {})
      .catch(() => {
        try {
          const sessionStore = chrome.storage?.session;
          if (!sessionStore) return;
          sessionStore.get(["af_execution_event_queue"], (res) => {
            const queue = Array.isArray(res?.af_execution_event_queue)
              ? res.af_execution_event_queue
              : [];
            queue.push({ ...message, _queued_at: Date.now() });
            if (queue.length > 50) queue.splice(0, queue.length - 50);
            sessionStore.set({ af_execution_event_queue: queue });
          });
        } catch (_) {}
      });
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "retry:status") {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (
    message.action === "queueImageToGenTab" ||
    message.action === "addImageToGenTab"
  ) {
    if (message._fromBackground) return false;
    const { tileId, fileName, thumbnail } = message;
    if (!tileId) {
      sendResponse({ success: false, error: "Missing tileId" });
      return true;
    }
    (async () => {
      try {
        let sidePanelHandled = false;
        try {
          const result = await Promise.race([
            new Promise((resolve) => {
              chrome.runtime.sendMessage(
                {
                  action: "addImageToGenTab",
                  tileId,
                  fileName,
                  thumbnail,
                  _fromBackground: true,
                },
                (resp) => {
                  if (chrome.runtime.lastError) {
                    resolve(null);
                  } else {
                    resolve(resp);
                  }
                },
              );
            }),
            new Promise((resolve) => setTimeout(() => resolve(null), 200)),
          ]);
          if (result?.success === true) {
            sidePanelHandled = true;
            sendResponse(result);
          }
        } catch (e) {}
        if (!sidePanelHandled) {
          const storage = await chrome.storage.local.get([
            "_pendingAddToGenTab",
          ]);
          const pending = storage._pendingAddToGenTab || [];
          if (pending.some((p) => p.tileId === tileId)) {
            sendResponse({ success: true, alreadyExists: true, queued: true });
            return;
          }
          pending.push({ tileId, fileName, thumbnail, addedAt: Date.now() });
          while (pending.length > 20) pending.shift();
          await chrome.storage.local.set({ _pendingAddToGenTab: pending });
          sendResponse({ success: true, queued: true });
        }
      } catch (e) {
        console.error("[Background] addImageToGenTab error:", e);
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "getEditingWorkflowId") {
    sendResponse({ editingWorkflowId });
    return true;
  }
  if (message.action === "updateEditingWorkflowId") {
    editingWorkflowId = message.wfId || null;
    _persistWindowIds();
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "getSettingsWindowId") {
    sendResponse({ windowId: settingsWindowId });
    return true;
  }
  if (message.action === "settingsAction") {
    chrome.tabs.query({ url: getFlowTabQueryPatterns() }, (tabs) => {
      tabs.forEach((tab) => {
        chrome.tabs.sendMessage(tab.id, message.payload);
      });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "setBadge") {
    if (chrome.action) {
      chrome.action.setBadgeText({ text: message.text || "" });
      chrome.action.setBadgeBackgroundColor({ color: "#cdff01" });
    }
    sendResponse({ success: true });
    return true;
  }
  if (message.action === "showNotification") {
    const notifId = message.notifId || "tobyflow-" + Date.now();
    chrome.notifications.create(
      notifId,
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
        title: message.title || "Toby Flow",
        message: message.body || "",
        priority: 2,
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[background] Notification error:",
            chrome.runtime.lastError.message,
          );
        }
      },
    );
    setTimeout(() => {
      chrome.notifications.clear(notifId);
    }, 5e3);
    sendResponse({ success: true });
    return true;
  }
  if (message.action === "ensureFlowCorrelationObserver") {
    const isExtensionPage =
      typeof sender.url === "string" &&
      sender.url.startsWith(chrome.runtime.getURL(""));
    const tabId = isExtensionPage ? message.tabId : sender.tab?.id;
    if (sender.id !== chrome.runtime.id || !Number.isInteger(tabId)) {
      sendResponse({ success: false, error: "INVALID_OBSERVER_TARGET" });
      return false;
    }
    ensureFlowCorrelationObserver(tabId).then((result) =>
      sendResponse({ ...result, tabId }),
    );
    return true;
  }
  if (message.action === "workflowOwnerDocument") {
    resolveNativeWorkflowDocument(sender).then(
      (documentId) => sendResponse({ documentId }),
      () => sendResponse({ documentId: null }),
    );
    return true;
  }
  if (message.action === "refreshFlowUploadBridge") {
    const tabId = sender.tab?.id;
    if (
      !Number.isInteger(tabId) ||
      !/^https:\/\/(?:flow\.google\.com|labs\.google)\//.test(sender.url || "")
    ) {
      sendResponse({ success: false, error: "INVALID_FLOW_SENDER" });
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId, frameIds: [0] },
        files: ["slate-bridge.js"],
        world: "MAIN",
      })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (
    message.action === "checkFlowTabOpen" ||
    message.action === "ensureFlowTabReady"
  ) {
    (async () => {
      let flowTab = null;
      try {
        const tabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (!tabs || tabs.length === 0) {
          sendResponse({ isOpen: false, ready: false, error: "NO_TAB" });
          return;
        }
        flowTab = await selectFlowStatusTab(tabs, message.targetTabId);
        if (!flowTab) {
          sendResponse({ isOpen: false, ready: false, error: "NO_TAB" });
          return;
        }
        const _ensureContentScriptReady = async (tabId) => {
          try {
            const pingResult = await chrome.tabs.sendMessage(tabId, {
              action: "ping",
            });
            if (
              pingResult?.pong &&
              pingResult?.driverKey &&
              pingResult.contentRevision === TOBYFLOW_CONTENT_REVISION
            ) {
              return { injected: false, ping: pingResult };
            }
            if (pingResult?.pong && pingResult?.driverKey) {
              console.warn(
                "[ensureFlowTabReady] stale content revision; automatic reload disabled",
                {
                  tabId,
                  expected: TOBYFLOW_CONTENT_REVISION,
                  actual: pingResult.contentRevision || null,
                },
              );
              return {
                injected: false,
                error: "CONTENT_REVISION_MISMATCH",
                expectedContentRevision: TOBYFLOW_CONTENT_REVISION,
                actualContentRevision: pingResult.contentRevision || null,
                ping: pingResult,
              };
            }
          } catch (_) {}
          try {
            if (describeFlowTab(await chrome.tabs.get(tabId))?.projectId) {
              await ensureFlowCorrelationObserver(tabId);
            }
            const liveTab = await chrome.tabs.get(tabId).catch(() => null);
            if (!isFlowUrl(liveTab?.url))
              throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
            await chrome.scripting.executeScript({
              target: { tabId },
              files: FLOW_CONTENT_SCRIPT_FILES,
            });
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ["slate-bridge.js"],
                world: "MAIN",
              });
              await chrome.scripting.executeScript({
                target: { tabId },
                files: ["media-interceptor.js"],
                world: "MAIN",
              });
            } catch (eB) {
              console.warn(
                "[ensureFlowTabReady] Inject slate-bridge failed:",
                eB?.message,
              );
            }
            await new Promise((r) => setTimeout(r, 300));
            const fresh = await chrome.tabs
              .sendMessage(tabId, { action: "ping" })
              .catch(() => null);
            return { injected: true, ping: fresh };
          } catch (e) {
            console.warn("[ensureFlowTabReady] Inject failed:", e?.message);
            return { injected: false, error: e?.message };
          }
        };
        const readinessScope = ["project", "upload"].includes(
          message.readinessScope,
        )
          ? message.readinessScope
          : "generation";
        const _buildFlowStatus = async (tab, content) => {
          const ping = content?.ping || null;
          const contentError =
            content?.error ||
            (ping?.pong && ping.contentRevision !== TOBYFLOW_CONTENT_REVISION
              ? "CONTENT_REVISION_MISMATCH"
              : null);
          let described = describeFlowTab(tab);
          let contentReady = !!(
            described &&
            ping?.pong &&
            ping?.driverKey === described.driverKey &&
            ping.contentRevision === TOBYFLOW_CONTENT_REVISION
          );
          let preflight = null;
          if (
            readinessScope === "project" &&
            message.readOnly !== true &&
            message.passive !== true &&
            contentReady &&
            described?.projectId &&
            described.isProjectEditor !== true
          ) {
            try {
              const preparation = await prepareFlowProjectEditorTab(tab);
              if (preparation?.success !== true) {
                preflight = {
                  success: false,
                  state: "viewer_prepare_failed",
                  error: preparation?.error || "FLOW_VIEWER_PREPARE_FAILED",
                };
              } else {
                const settledTab = await chrome.tabs
                  .get(tab.id)
                  .catch(() => null);
                described = describeFlowTab(settledTab);
                contentReady = !!(
                  described &&
                  ping?.pong &&
                  ping?.driverKey === described.driverKey &&
                  ping.contentRevision === TOBYFLOW_CONTENT_REVISION
                );
              }
            } catch (error) {
              preflight = {
                success: false,
                state: "viewer_prepare_failed",
                error: error?.message || "FLOW_VIEWER_PREPARE_FAILED",
              };
            }
          }
          if (
            readinessScope !== "upload" &&
            contentReady &&
            !preflight &&
            described?.driverKey === "flow_v2" &&
            described.projectId
          ) {
            try {
              preflight = await chrome.tabs.sendMessage(tab.id, {
                action: "flowPreflight",
                passive: message.readOnly === true || message.passive === true,
              });
            } catch (error) {
              preflight = {
                success: false,
                state: "unknown",
                error: error?.message || "FLOW_PREFLIGHT_FAILED",
              };
            }
            if (preflight?.success) {
              const settledTab = await chrome.tabs
                .get(tab.id)
                .catch(() => null);
              described = describeFlowTab(settledTab);
              contentReady = !!(
                described &&
                ping?.pong &&
                ping?.driverKey === described.driverKey &&
                ping.contentRevision === TOBYFLOW_CONTENT_REVISION
              );
            }
          }
          const recoverableProjectPreflight =
            readinessScope === "project" &&
            [
              "V2_AGENT_BLOCKED",
              "V2_MEDIA_VIEWER_OPEN",
              "V2_COMPOSER_NOT_READY",
            ].includes(preflight?.error);
          const scopeReady =
            readinessScope === "upload" ||
            (preflight?.success && preflight?.state === "ready") ||
            recoverableProjectPreflight;
          const ready2 =
            described?.driverKey === "flow_v2"
              ? !!(
                  contentReady &&
                  described.projectId &&
                  described.isProjectEditor === true &&
                  scopeReady
                )
              : contentReady;
          return {
            isOpen: true,
            ready: ready2,
            contentReady,
            readinessScope,
            expectedContentRevision: TOBYFLOW_CONTENT_REVISION,
            actualContentRevision: ping?.contentRevision || null,
            preparationRequired:
              readinessScope === "project" &&
              ready2 &&
              preflight?.state !== "ready",
            driverKey: described?.driverKey || ping?.driverKey || null,
            origin: described?.origin || ping?.origin || null,
            projectId: described?.projectId || ping?.projectId || null,
            isProjectEditor: described?.isProjectEditor === true,
            mediaViewer: described?.isMediaViewer === true,
            preflightState: preflight?.state || null,
            error: ready2
              ? null
              : !described?.projectId || described?.isProjectEditor !== true
                ? "NO_PROJECT_OPEN"
                : contentError || preflight?.error || "FLOW_CONTENT_NOT_READY",
          };
        };
        if (flowTab.active || message.action === "checkFlowTabOpen") {
          const ready2 =
            message.action === "checkFlowTabOpen" && message.passive === true
              ? {
                  injected: false,
                  ping: await chrome.tabs
                    .sendMessage(flowTab.id, { action: "ping" })
                    .catch(() => null),
                }
              : await _ensureContentScriptReady(flowTab.id);
          sendResponse({
            ...(await _buildFlowStatus(flowTab, ready2)),
            tabId: flowTab.id,
            wasInjected: ready2.injected,
          });
          return;
        }
        const [currentActiveTab] = await chrome.tabs.query({
          active: true,
          windowId: flowTab.windowId,
        });
        const previousTabId = currentActiveTab?.id || null;
        await chrome.tabs.update(flowTab.id, { active: true });
        await new Promise((r) => setTimeout(r, 600));
        const ready = await _ensureContentScriptReady(flowTab.id);
        sendResponse({
          ...(await _buildFlowStatus(await chrome.tabs.get(flowTab.id), ready)),
          tabId: flowTab.id,
          wasActivated: true,
          wasInjected: ready.injected,
          previousTabId,
        });
      } catch (e) {
        console.warn("[ensureFlowTabReady] Failed:", e?.message || e, {
          action: message.action,
          targetTabId: message.targetTabId,
          errorName: e?.name,
        });
        sendResponse({
          isOpen: !!flowTab,
          ready: false,
          tabId: flowTab?.id || null,
          ...describeFlowTab(flowTab),
          error: e?.message || "FLOW_STATUS_CHECK_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "ensureFlowTabActive") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false });
          return;
        }
        const contentTabId =
          isFlowUrl(sender.url) && Number.isInteger(sender.tab?.id)
            ? sender.tab.id
            : null;
        const flowTab = await selectFlowStatusTab(
          tabs,
          message.targetTabId || contentTabId,
        );
        if (!flowTab) {
          sendResponse({ ok: false });
          return;
        }
        const wasActivated = !flowTab.active;
        if (wasActivated)
          await chrome.tabs.update(flowTab.id, { active: true });
        if (message.focusWindow === true && flowTab.windowId != null) {
          await chrome.windows.update(flowTab.windowId, { focused: true });
        }
        sendResponse({
          ok: true,
          tabId: flowTab.id,
          projectId: describeFlowTab(flowTab)?.projectId || null,
          isProjectEditor: describeFlowTab(flowTab)?.isProjectEditor === true,
          wasActivated,
        });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (message.action === "restorePreviousTab") {
    if (message.previousTabId) {
      chrome.tabs
        .update(message.previousTabId, { active: true })
        .catch(() => {});
    }
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "getBrowserZoom") {
    (async () => {
      try {
        let tabId = sender.tab?.id;
        if (tabId == null) {
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          tabId = (tabs.find((t) => t.active) || tabs[0])?.id;
        }
        if (tabId == null) {
          sendResponse({ zoom: null });
          return;
        }
        const z = await chrome.tabs.getZoom(tabId);
        sendResponse({ zoom: typeof z === "number" ? z : null, tabId });
      } catch (e) {
        sendResponse({ zoom: null });
      }
    })();
    return true;
  }
  if (message.action === "zoomGuard:begin") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false });
          return;
        }
        const all = await _zoomGuardReadAll();
        const _prev = all[tabId];
        const _keepOriginal =
          _prev && typeof _prev.original === "number"
            ? _prev.original
            : message.original;
        all[tabId] = {
          tabId,
          origin: _originOf(sender.url || sender.tab?.url),
          original: _keepOriginal,
          factor: message.factor,
          ts: Date.now(),
        };
        await _zoomGuardWriteAll(all);
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (message.action === "zoomGuard:beat") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const all = await _zoomGuardReadAll();
        if (tabId != null && all[tabId]) {
          all[tabId].ts = Date.now();
          await _zoomGuardWriteAll(all);
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (message.action === "zoomGuard:end") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const all = await _zoomGuardReadAll();
        const guard = tabId != null ? all[tabId] : null;
        if (guard) {
          const target =
            typeof guard.original === "number" &&
            guard.original > 0 &&
            guard.original !== guard.factor
              ? guard.original
              : 1;
          try {
            await chrome.tabs.setZoom(tabId, target);
          } catch (_) {}
          delete all[tabId];
          await _zoomGuardWriteAll(all);
          sendResponse({ ok: true, restored: true, zoom: target });
          return;
        }
        sendResponse({ ok: true, restored: false, noGuard: true });
      } catch (e) {
        sendResponse({ ok: false });
      }
    })();
    return true;
  }
  if (message.action === "zoomGuard:recover") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const all = await _zoomGuardReadAll();
        const g = tabId != null ? all[tabId] : null;
        if (!g) {
          sendResponse({ recovered: false });
          return;
        }
        const _org = _originOf(sender.url || sender.tab?.url);
        if (g.origin && _org && g.origin !== _org) {
          sendResponse({ recovered: false });
          return;
        }
        if (Date.now() - (g.ts || 0) > _ZOOM_GUARD_MAX_AGE_MS) {
          await _zoomGuardDrop(tabId);
          sendResponse({ recovered: false });
          return;
        }
        const target = await _zoomGuardRestore(g);
        sendResponse({ recovered: true, original: target });
      } catch (e) {
        sendResponse({ recovered: false });
      }
    })();
    return true;
  }
  if (message.action === "setBrowserZoom") {
    (async () => {
      try {
        let tabId = message.tabId ?? sender.tab?.id;
        if (tabId == null) {
          const tabs = await chrome.tabs.query({
            url: getFlowTabQueryPatterns(),
          });
          tabId = (tabs.find((t) => t.active) || tabs[0])?.id;
        }
        if (tabId == null) {
          sendResponse({ ok: false });
          return;
        }
        await chrome.tabs.setZoom(tabId, message.factor);
        sendResponse({ ok: true, tabId });
      } catch (e) {
        sendResponse({ ok: false, error: e?.message });
      }
    })();
    return true;
  }
  if (message.action === "i2p:getConfig") {
    (async () => {
      try {
        sendResponse({ ok: true, config: await _i2pGetConfig() });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "i2p:invalidateConfig") {
    _aiToolsCache = null;
    _aiToolsAt = 0;
    _aiToolsEpoch++;
    ProtectedConfigClient.envelope("aiTools", { force: true }).then(
      (result) => {
        sendResponse({
          ok: result.success === true,
          ...(result.success ? {} : { error: result.error?.code }),
        });
      },
    );
    return true;
  }
  if (message.action === "pa:getConfig") {
    (async () => {
      try {
        sendResponse({ ok: true, config: await _paGetConfig() });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "pa:getFormats") {
    (async () => {
      try {
        sendResponse({ ok: true, formats: await _paGetFormats() });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "pa:invalidateFormats") {
    _paFormatsCache = null;
    _paFormatsAt = 0;
    sendResponse({ ok: true });
    return;
  }
  if (message.action === "pa:activateTab") {
    (async () => {
      try {
        const provider = message.provider === "gemini" ? "gemini" : "chatgpt";
        const { tabId, created } = await _i2pEnsureProviderTab(provider);
        if (provider === "chatgpt") {
          const waitForEditorMs =
            await _getProviderTextStartupTimeout(provider);
          const mode = await _i2pSendAnalyze(
            tabId,
            { action: "chatgpt:ensureChatMode", waitForEditorMs },
            created,
          );
          if (!mode?.success) {
            sendResponse({
              ok: false,
              error: mode?.error || "CHAT_MODE_NOT_READY",
            });
            return;
          }
        }
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "motion:cancelTranscript") {
    void _cancelMotionTranscriptTask(message.operationId, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse({ success: false, error: "MOTION_CANCEL_FAILED" }),
      );
    return true;
  }
  if (
    ["motion:transcribe", "motionRunner:transcribe"].includes(message.action)
  ) {
    (async () => {
      let providerDispatched = false,
        directTask = null;
      try {
        const runnerTask = message.action === "motionRunner:transcribe";
        if (
          !runnerTask &&
          !sender.url?.startsWith(chrome.runtime.getURL("motion-editor.html"))
        ) {
          return sendResponse({
            success: false,
            error: "MOTION_SENDER_INVALID",
          });
        }
        if (!runnerTask)
          directTask = _beginMotionTranscriptTask(message, sender);
        let verifyRunner;
        if (runnerTask) {
          let caller;
          try {
            caller = new URL(sender.url);
          } catch (_) {
            return sendResponse({
              success: false,
              error: "MOTION_SENDER_INVALID",
            });
          }
          const expected = new URL(chrome.runtime.getURL("motion-runner.html"));
          const host = (
            await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
          )?.[MotionRunnerHostRegistry.KEY];
          const initial = await chrome.storage.local.get([
            "af_auth",
            "af_system_settings",
          ]);
          const auth = initial?.af_auth;
          const timeout = Number(initial?.af_system_settings?.api_timeout_ms);
          if (
            sender.id !== chrome.runtime.id ||
            caller.protocol !== expected.protocol ||
            caller.host !== expected.host ||
            caller.pathname !== expected.pathname ||
            sender.tab?.id !== host?.tabId ||
            sender.tab?.windowId !== host?.windowId ||
            host?.epoch !== message.hostEpoch ||
            !auth?.token ||
            Number(auth.user?.id) !== host.userId ||
            !Number.isFinite(timeout) ||
            timeout <= 0
          )
            return sendResponse({
              success: false,
              error: "MOTION_SENDER_INVALID",
            });
          const owner = {
            userId: host.userId,
            toolProjectId: message.toolProjectId,
            runId: message.runId,
            ownerId: message.ownerId,
            epoch: message.epoch,
          };
          verifyRunner = async () => {
            const [storedAuth, storedHost, run] = await Promise.all([
              chrome.storage.local.get("af_auth"),
              chrome.storage.session.get(MotionRunnerHostRegistry.KEY),
              MotionRunJournal.get(owner),
            ]);
            if (
              storedAuth?.af_auth?.token !== auth.token ||
              Number(storedAuth?.af_auth?.user?.id) !== host.userId ||
              storedHost?.[MotionRunnerHostRegistry.KEY]?.tabId !==
                host.tabId ||
              storedHost?.[MotionRunnerHostRegistry.KEY]?.windowId !==
                host.windowId ||
              storedHost?.[MotionRunnerHostRegistry.KEY]?.epoch !== host.epoch
            )
              throw new Error("ACCOUNT_SCOPE_CHANGED");
            MotionRunJournal._owned(run, owner);
            const op = run?.operations?.[message.operationId];
            if (
              run.state !== "running" ||
              run.executionMode !== "sequential" ||
              run.transcriptionProvider !== message.provider ||
              op?.stage !== "direct_transcribe" ||
              op.frameId !== message.frameId
            )
              throw new Error("MOTION_RUN_FENCED");
            const tab = await chrome.tabs
              .get(message.flowTabId)
              .catch(() => null);
            const flow = describeFlowTab(tab);
            if (!flow?.isProjectEditor || flow.projectId !== run.flowProjectId)
              throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            let response, payload2;
            try {
              response = await _signedFetch(
                `${getApiBaseUrl()}/tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`,
                {
                  method: "GET",
                  headers: {
                    Authorization: `Bearer ${auth.token}`,
                    Accept: "application/json",
                    "X-Extension-Id": chrome.runtime.id,
                  },
                  cache: "no-store",
                  signal: controller.signal,
                },
              );
              payload2 = await response.json();
            } finally {
              clearTimeout(timer);
            }
            const project = payload2?.data;
            const frame = project?.data_json?.frames?.[op.frameId];
            const prefs = project?.data_json?.preferences || {};
            const settings = run.transcriptSettings;
            if (project?.data_json?.paused === true)
              throw new Error("MOTION_CANCELLED");
            if (
              !response.ok ||
              payload2?.success !== true ||
              project?.tool_project_id !== owner.toolProjectId ||
              project.flow_project_id !== run.flowProjectId ||
              project.data_json?.requires_resplit ||
              Number(project.data_json?.source_revision) !==
                run.sourceRevision ||
              frame?.run_id !== op.frameRunId ||
              Number(frame?.input_revision) !== op.inputRevision ||
              (prefs.transcription_provider &&
                prefs.transcription_provider !==
                  settings?.transcription_provider) ||
              (prefs.translate_enabled === true) !==
                settings?.translate_enabled ||
              (settings?.translate_enabled &&
                (prefs.target_language || null) !== settings.target_language)
            )
              throw new Error("MOTION_TRANSCRIPT_SCOPE_CHANGED");
            const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
            if (
              latest?.token !== auth.token ||
              Number(latest?.user?.id) !== host.userId
            )
              throw new Error("ACCOUNT_SCOPE_CHANGED");
            const finalHost = (
              await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
            )?.[MotionRunnerHostRegistry.KEY];
            const finalTab = await chrome.tabs
              .get(message.flowTabId)
              .catch(() => null);
            const finalFlow = describeFlowTab(finalTab);
            const finalRun = await MotionRunJournal.get(owner);
            MotionRunJournal._owned(finalRun, owner);
            if (
              finalHost?.tabId !== host.tabId ||
              finalHost?.windowId !== host.windowId ||
              finalHost?.epoch !== host.epoch ||
              !finalFlow?.isProjectEditor ||
              finalFlow.projectId !== run.flowProjectId ||
              finalRun?.state !== "running" ||
              finalRun.operations?.[message.operationId]?.stage !==
                "direct_transcribe"
            )
              throw new Error("MOTION_RUN_FENCED");
          };
          await verifyRunner();
        }
        const access = await _featureAllowed("motion_tool_enabled");
        if (!access.allowed)
          return sendResponse({ success: false, error: "FEATURE_LOCKED" });
        const audioFiles = Array.isArray(message.audioFiles)
          ? message.audioFiles
          : [message.audio];
        if (
          !["chatgpt", "gemini"].includes(message.provider) ||
          typeof message.text !== "string" ||
          !message.text.trim() ||
          !audioFiles.length ||
          audioFiles.some(
            (file) =>
              !file ||
              file.type !== "audio/wav" ||
              typeof file.base64 !== "string" ||
              !/^[A-Za-z0-9_-]+\.wav$/.test(file.name || ""),
          )
        ) {
          return sendResponse({
            success: false,
            error: "MOTION_AUDIO_REQUEST_INVALID",
          });
        }
        if (
          runnerTask &&
          (audioFiles.length !== 1 ||
            !Array.isArray(message.audioManifest) ||
            message.audioManifest.length !== 1 ||
            message.audioManifest[0]?.frame_id !== message.frameId ||
            message.audioManifest[0]?.order !== 1 ||
            message.audioManifest[0]?.file_name !== audioFiles[0].name ||
            audioFiles[0].name !== `frame_${message.frameId}.wav`)
        )
          return sendResponse({
            success: false,
            error: "MOTION_AUDIO_REQUEST_INVALID",
          });
        if (directTask?.cancelled)
          return sendResponse({ success: false, error: "MOTION_CANCELLED" });
        const { tabId, created } = await _i2pEnsureProviderTab(
          message.provider,
          { focusWindow: false },
        );
        if (directTask?.cancelled)
          return sendResponse({ success: false, error: "MOTION_CANCELLED" });
        if (directTask) directTask.tabId = tabId;
        if (verifyRunner) await verifyRunner();
        const payload = {
          action: "provider:textTask",
          text: message.text,
          images: audioFiles,
          motionAudio: true,
          ...(Number.isInteger(message.waitForEditorMs) &&
          message.waitForEditorMs >= 1e4 &&
          message.waitForEditorMs <= 12e4
            ? { waitForEditorMs: message.waitForEditorMs }
            : {}),
          motionOperationId: /^[0-9a-f-]{36}$/i.test(
            String(message.operationId || ""),
          )
            ? message.operationId
            : null,
          motionAudioManifest: Array.isArray(message.audioManifest)
            ? message.audioManifest
            : null,
          newChat: true,
          tabFreshlyCreated: created,
          deleteAfter: message.deleteAfter === true,
          deferCleanup: true,
          model: message.model || void 0,
        };
        providerDispatched = true;
        const result = await _i2pSendAnalyze(
          tabId,
          payload,
          created,
          directTask,
        );
        const responseText =
          typeof result?.text === "string" ? result.text : "";
        console.info(
          "[MotionTranscriptResponse]",
          JSON.stringify({
            operationId: message.operationId || null,
            provider: message.provider,
            success: result?.success === true,
            textLength: responseText.length,
            beginMarkers:
              responseText.split("TOBY_MOTION_JSON_BEGIN").length - 1,
            endMarkers: responseText.split("TOBY_MOTION_JSON_END").length - 1,
          }),
        );
        if (
          result?.success &&
          result.cleanupEligible === true &&
          result.cleanupConversationUrl
        ) {
          result.cleanupReceipt = {
            provider: message.provider,
            tabId,
            expectedConversationUrl: result.cleanupConversationUrl,
          };
        }
        console.info(
          "[MotionTranscriptCleanup]",
          JSON.stringify({
            operationId: message.operationId || null,
            provider: message.provider,
            state: "receipt",
            enabled: message.deleteAfter === true,
            providerSucceeded: result?.success === true,
            eligible: result?.cleanupEligible === true,
            receiptAvailable: !!result?.cleanupReceipt,
            code:
              message.deleteAfter !== true
                ? "CLEANUP_DISABLED"
                : result?.cleanupReceipt
                  ? null
                  : "CLEANUP_RECEIPT_MISSING",
          }),
        );
        if (result) {
          delete result.cleanupEligible;
          delete result.cleanupConversationUrl;
        }
        sendResponse(result || { success: false, error: "PROVIDER_NOT_READY" });
      } catch (error) {
        const code = String(error?.code || error?.message || "");
        sendResponse({
          success: false,
          error:
            message.action === "motionRunner:transcribe" &&
            /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(code)
              ? code
              : "MOTION_AGENT_ERROR",
          message: error.message,
          ...(message.action === "motionRunner:transcribe" &&
            code === "MOTION_CANCELLED" &&
            !providerDispatched && { notDispatched: true }),
        });
      } finally {
        if (
          directTask &&
          _motionTranscriptTasks.get(message.operationId) === directTask
        )
          _motionTranscriptTasks.delete(message.operationId);
      }
    })();
    return true;
  }
  if (message.action === "pa:generate") {
    (async () => {
      try {
        const acc = await _featureAllowed("prompt_assistant_enabled");
        if (!acc.allowed) {
          sendResponse({ success: false, error: "FEATURE_LOCKED" });
          return;
        }
        const provider = message.provider === "gemini" ? "gemini" : "chatgpt";
        if (Array.isArray(message.images) && message.images.length > 0) {
          const [globalRef, providerRef] = await Promise.all([
            _featureAllowed("ref_images"),
            _featureAllowed(`${provider}_ref_images`),
          ]);
          if (!globalRef.allowed || !providerRef.allowed) {
            sendResponse({ success: false, error: "FEATURE_LOCKED" });
            return;
          }
        }
        const metaPrompt = (message.metaPrompt || "").trim();
        if (!metaPrompt) {
          sendResponse({ success: false, error: "NO_PROMPT" });
          return;
        }
        let srcTabId = sender?.tab?.id || null;
        let srcWinId = sender?.tab?.windowId || null;
        if (!srcTabId) {
          try {
            const win = await chrome.windows.getLastFocused();
            const [act] = await chrome.tabs.query({
              active: true,
              windowId: win.id,
            });
            if (act) {
              srcTabId = act.id;
              srcWinId = act.windowId;
            }
          } catch (_) {}
        }
        const { tabId, created } = await _i2pEnsureProviderTab(provider);
        const storedSettings = await chrome.storage.local.get(["af_settings"]);
        const waitForEditorMs = await _getProviderTextStartupTimeout(provider);
        let payload = {
          action: "provider:textTask",
          text: metaPrompt,
          images: Array.isArray(message.images) ? message.images : [],
          timeout: message.timeout || 12e4,
          deleteAfter: !!message.deleteAfter,
          newChat: true,
          tabFreshlyCreated: created,
          waitForEditorMs,
          model:
            provider === "chatgpt"
              ? storedSettings?.af_settings?.chatgptModel || null
              : void 0,
        };
        let result = await _i2pSendAnalyze(tabId, payload, created);
        if (result?.error === "PROVIDER_NOT_READY" && !created) {
          console.warn(
            "[PA] provider content script stale \u2192 reload tab + retry",
          );
          try {
            await chrome.tabs.reload(tabId);
          } catch (_) {}
          payload = { ...payload, tabFreshlyCreated: true };
          result = await _i2pSendAnalyze(tabId, payload, true);
        }
        result = await _retryChatGptTextTaskAfterReadiness(
          tabId,
          payload,
          result,
          provider,
          "PA",
        );
        result = await _retryChatGptTextTaskAfterSubmitLost(
          tabId,
          payload,
          result,
          "PA",
        );
        result = await _finalizeChatGptTextTaskCleanup(
          tabId,
          payload,
          result,
          provider,
          "PA",
        );
        if (!result?.success) {
          console.warn(
            "[PAProviderFailureAudit]",
            JSON.stringify({
              provider,
              tabId,
              error: result?.error || null,
              diagnostics: result?.diagnostics || null,
            }),
          );
        }
        if (srcTabId) {
          try {
            await chrome.tabs.update(srcTabId, { active: true });
          } catch (_) {}
          try {
            if (srcWinId != null)
              await chrome.windows.update(srcWinId, { focused: true });
          } catch (_) {}
        }
        sendResponse(result);
      } catch (e) {
        sendResponse({
          success: false,
          error: "ORCHESTRATE_FAIL",
          message: e.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "i2p:checkProviders") {
    (async () => {
      const stored = await _readOperationalSnapshot(["toby_provider_configs"]);
      const providerConfigs = stored?.toby_provider_configs?.data || {};
      const out = {};
      let workerTabIds = null;
      if (message.excludeWorkerTabs === true) {
        try {
          workerTabIds = new Set(
            Object.values(await ProviderWorkerRegistry._read())
              .filter((item) => !item.reusedTab)
              .map((item) => item.tabId)
              .filter(Number.isInteger),
          );
        } catch (_) {
          sendResponse({
            ok: false,
            error: "PROVIDER_WORKER_REGISTRY_UNAVAILABLE",
            providers: {},
          });
          return;
        }
      }
      for (const p of ["gemini", "chatgpt"]) {
        try {
          const tabs = (
            await chrome.tabs.query({ url: PROVIDER_URLS[p].tabQuery })
          ).filter((tab2) => !workerTabIds?.has(tab2.id));
          const tab =
            tabs && tabs.length ? tabs.find((t) => t.active) || tabs[0] : null;
          if (!tab) {
            out[p] = { tabOpen: false, ready: false };
            continue;
          }
          const selectors =
            providerConfigs?.[p]?.selectors?.composer?.selectors;
          if (!Array.isArray(selectors) || selectors.length === 0) {
            out[p] = {
              tabOpen: true,
              ready: false,
              error: "SELECTOR_CONFIG_UNAVAILABLE",
            };
            continue;
          }
          let ready = false;
          try {
            const r = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              args: [selectors],
              func: (configuredSelectors) =>
                configuredSelectors.some((selector) => {
                  try {
                    const editor = document.querySelector(selector);
                    return (
                      !!editor &&
                      editor.isConnected &&
                      editor.getAttribute("aria-disabled") !== "true" &&
                      !editor.closest('[aria-busy="true"]')
                    );
                  } catch (_) {
                    return false;
                  }
                }),
            });
            ready = !!(r && r[0] && r[0].result);
          } catch (_) {}
          out[p] = { tabOpen: true, ready, tabId: tab.id };
        } catch (_) {
          out[p] = { tabOpen: false, ready: false };
        }
      }
      sendResponse({ ok: true, providers: out });
    })();
    return true;
  }
  if (message.action === "i2p:fetchImage") {
    (async () => {
      try {
        const maxPx = Number(message.maxPx) || 1536;
        const resp = await fetch(message.srcUrl);
        if (!resp.ok) {
          sendResponse({ ok: false, error: "HTTP_" + resp.status });
          return;
        }
        const blob = await resp.blob();
        let outBlob = blob;
        try {
          const bmp = await createImageBitmap(blob);
          const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
          const cw = Math.max(1, Math.round(bmp.width * scale));
          const ch = Math.max(1, Math.round(bmp.height * scale));
          const oc = new OffscreenCanvas(cw, ch);
          const ctx = oc.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, cw, ch);
          ctx.drawImage(bmp, 0, 0, cw, ch);
          outBlob = await oc.convertToBlob({
            type: "image/jpeg",
            quality: 0.85,
          });
        } catch (_) {}
        const buf = await outBlob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 8192)
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        const type = outBlob.type || "image/jpeg";
        const ext = type.includes("png")
          ? "png"
          : type.includes("webp")
            ? "webp"
            : "jpg";
        sendResponse({
          ok: true,
          image: { base64: btoa(bin), name: "i2p." + ext, type },
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "i2p:captureRegion") {
    (async () => {
      try {
        const rect = message.rect || {};
        const winId = sender?.tab?.windowId;
        const dataUrl = await chrome.tabs.captureVisibleTab(winId, {
          format: "png",
        });
        const blob = await (await fetch(dataUrl)).blob();
        const bmp = await createImageBitmap(blob);
        const dpr = rect.dpr || 1;
        const sx = Math.max(0, Math.round(rect.x * dpr)),
          sy = Math.max(0, Math.round(rect.y * dpr));
        const sw = Math.max(1, Math.round(rect.w * dpr)),
          sh = Math.max(1, Math.round(rect.h * dpr));
        const _cfg = await _i2pGetConfig();
        const maxPx = _cfg.maxImagePx || 1536;
        const scale = Math.min(1, maxPx / Math.max(sw, sh));
        const dw = Math.max(1, Math.round(sw * scale)),
          dh = Math.max(1, Math.round(sh * scale));
        const oc = new OffscreenCanvas(dw, dh);
        const ctx = oc.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, dw, dh);
        ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, dw, dh);
        const outBlob = await oc.convertToBlob({
          type: "image/jpeg",
          quality: 0.85,
        });
        const buf = await outBlob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 8192)
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        sendResponse({
          ok: true,
          image: {
            base64: btoa(bin),
            name: "i2p-region.jpg",
            type: "image/jpeg",
          },
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "i2p:cancel") {
    (async () => {
      const p = message.provider === "chatgpt" ? "chatgpt" : "gemini";
      try {
        const tabs = await chrome.tabs.query({
          url: PROVIDER_URLS[p].tabQuery,
        });
        const tab =
          tabs && tabs.length ? tabs.find((t) => t.active) || tabs[0] : null;
        if (tab)
          chrome.tabs.sendMessage(
            tab.id,
            { action: p + ":abort" },
            () => void chrome.runtime.lastError,
          );
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === "i2p:checkAccess") {
    (async () => {
      const r = await _featureAllowed("i2p_enabled");
      sendResponse({ ok: true, loggedIn: r.loggedIn, allowed: r.allowed });
    })();
    return true;
  }
  if (message.action === "i2p:sendImageToGen") {
    (async () => {
      const tabId = sender?.tab?.id;
      try {
        if (tabId && chrome.sidePanel?.open)
          await chrome.sidePanel.open({ tabId });
      } catch (_) {}
      const img = message.base64
        ? {
            base64: message.base64,
            name: message.name || `gen_ref_${Date.now()}.jpg`,
            type: message.type || "image/jpeg",
          }
        : message.srcUrl
          ? await _fetchImageAsBase64(message.srcUrl, 2048, 0.92)
          : null;
      if (!img) {
        sendResponse({ ok: false });
        return;
      }
      await _dispatchLocalImageToGen(img);
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === "i2p:openApp") {
    (async () => {
      const curTabId = sender?.tab?.id;
      try {
        if (curTabId && chrome.sidePanel?.open)
          await chrome.sidePanel.open({ tabId: curTabId });
      } catch (_) {}
      if (message.mode === "upgrade") {
        setTimeout(() => {
          try {
            chrome.runtime.sendMessage(
              { action: "showUpgradeModal" },
              () => void chrome.runtime.lastError,
            );
          } catch (_) {}
        }, 700);
      }
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === "i2p:openProviderLogin") {
    (async () => {
      try {
        const p = message.provider,
          urls = PROVIDER_URLS[p];
        if (!urls?.tabQuery || !urls?.createUrl)
          throw new Error("PROVIDER_URL_UNAVAILABLE");
        const tab = await openOrActivateTab(
          urls.tabQuery,
          urls.createUrl,
          true,
          false,
        );
        if (!Number.isInteger(tab?.id))
          throw new Error("PROVIDER_PAGE_OPEN_FAILED");
        sendResponse({ ok: true, tabId: tab.id });
      } catch (error) {
        sendResponse({
          ok: false,
          error:
            error?.message === "PROVIDER_URL_UNAVAILABLE"
              ? "PROVIDER_URL_UNAVAILABLE"
              : "PROVIDER_PAGE_OPEN_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "i2p:genOnFlow") {
    (async () => {
      const curTabId = sender?.tab?.id;
      try {
        if (curTabId && chrome.sidePanel?.open)
          await chrome.sidePanel.open({ tabId: curTabId });
      } catch (_) {}
      const acc = await _featureAllowed("i2p_enabled");
      if (!acc.allowed) {
        sendResponse({ ok: false, error: "FEATURE_LOCKED" });
        return;
      }
      const text = message.prompt || "";
      if (!text) {
        sendResponse({ ok: false, error: "NO_PROMPT" });
        return;
      }
      try {
        await chrome.storage.local.set({ i2p_pending_prompt: { text } });
      } catch (_) {}
      chrome.runtime.sendMessage(
        { action: "i2p:setGenPrompt", text },
        () => void chrome.runtime.lastError,
      );
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (message.action === "i2p:analyze") {
    (async () => {
      try {
        const acc = await _featureAllowed("i2p_enabled");
        if (!acc.allowed) {
          sendResponse({ success: false, error: "FEATURE_LOCKED" });
          return;
        }
        const provider = message.provider === "chatgpt" ? "chatgpt" : "gemini";
        const [globalRef, providerRef] = await Promise.all([
          _featureAllowed("ref_images"),
          _featureAllowed(`${provider}_ref_images`),
        ]);
        if (!globalRef.allowed || !providerRef.allowed) {
          sendResponse({ success: false, error: "FEATURE_LOCKED" });
          return;
        }
        const cfg = await _i2pGetConfig();
        if (!cfg.promptTemplate) {
          sendResponse({
            success: false,
            error: "CONFIG_MISSING",
            message: "Could not load prompt config from server",
          });
          return;
        }
        if (!message.image || !message.image.base64) {
          sendResponse({ success: false, error: "NO_IMAGE" });
          return;
        }
        const srcTabId = sender?.tab?.id;
        const srcWinId = sender?.tab?.windowId;
        const { tabId, created } = await _i2pEnsureProviderTab(provider);
        const waitForEditorMs = await _getProviderTextStartupTimeout(provider);
        let payload = {
          action: "provider:textTask",
          text: cfg.promptTemplate,
          images: [message.image],
          timeout: cfg.timeoutMs || 18e4,
          deleteAfter: !!cfg.deleteAfter,
          newChat: true,
          tabFreshlyCreated: created,
          waitForEditorMs,
          model: provider === "chatgpt" ? "Instant" : void 0,
        };
        let result = await _i2pSendAnalyze(tabId, payload, created);
        if (result?.error === "PROVIDER_NOT_READY" && !created) {
          console.warn(
            "[I2P] provider content script stale \u2192 reload tab + retry",
          );
          try {
            await chrome.tabs.reload(tabId);
          } catch (_) {}
          payload = { ...payload, tabFreshlyCreated: true };
          result = await _i2pSendAnalyze(tabId, payload, true);
        }
        result = await _retryChatGptTextTaskAfterReadiness(
          tabId,
          payload,
          result,
          provider,
          "I2P",
        );
        result = await _retryChatGptTextTaskAfterSubmitLost(
          tabId,
          payload,
          result,
          "I2P",
        );
        result = await _finalizeChatGptTextTaskCleanup(
          tabId,
          payload,
          result,
          provider,
          "I2P",
        );
        if (srcTabId) {
          try {
            await chrome.tabs.update(srcTabId, { active: true });
          } catch (_) {}
          try {
            if (srcWinId != null)
              await chrome.windows.update(srcWinId, { focused: true });
          } catch (_) {}
        }
        sendResponse(result);
      } catch (e) {
        sendResponse({
          success: false,
          error: "ORCHESTRATE_FAIL",
          message: e.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "pq:stopAll") {
    chrome.runtime
      .sendMessage({
        action: "queue:stop_all",
        requestedAt: message.requestedAt || Date.now(),
        stopSource: message.stopSource || null,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : {
                ok: false,
                error: response?.error || "STOP_ALL_NO_SIDEBAR_ACK",
              },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "STOP_ALL_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:stopJob") {
    chrome.runtime
      .sendMessage({
        action: "queue:stop_job",
        jobId: message.jobId,
        requestedAt: message.requestedAt || Date.now(),
        stopSource: message.stopSource || null,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : {
                ok: false,
                error: response?.error || "STOP_JOB_NO_SIDEBAR_ACK",
              },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "STOP_JOB_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:pauseJob") {
    chrome.runtime
      .sendMessage({
        action: "queue:pause_job",
        jobId: message.jobId,
        pauseSource: message.pauseSource || null,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : {
                ok: false,
                error: response?.error || "PAUSE_JOB_NO_SIDEBAR_ACK",
              },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "PAUSE_JOB_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:resumeJob") {
    chrome.runtime
      .sendMessage({ action: "queue:resume_job", jobId: message.jobId })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : {
                ok: false,
                error: response?.error || "RESUME_JOB_NO_SIDEBAR_ACK",
              },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "RESUME_JOB_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:regenItem") {
    chrome.runtime
      .sendMessage({
        action: "queue:regen_item",
        jobId: message.jobId,
        itemId: message.itemId,
        prompt: message.prompt,
        payload: message.payload,
        settingsOverride: message.settingsOverride,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : { ok: false, error: response?.error || "REGEN_NO_SIDEBAR_ACK" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "REGEN_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:addBatchReferences") {
    chrome.runtime
      .sendMessage({
        action: "queue:add_batch_references",
        projectId: message.projectId,
        references: message.references,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : {
                ok: false,
                error: response?.error || "REFERENCE_NO_SIDEBAR_ACK",
              },
        ),
      )
      .catch(() =>
        sendResponse({ ok: false, error: "REFERENCE_NO_SIDEBAR_ACK" }),
      );
    return true;
  }
  if (message.action === "pq:regenBatch") {
    chrome.runtime
      .sendMessage({ action: "queue:regen_batch", items: message.items })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : {
                ok: false,
                error: response?.error || "REGEN_BATCH_NO_SIDEBAR_ACK",
              },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "REGEN_BATCH_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:regenOptions") {
    chrome.runtime
      .sendMessage({
        action: "queue:regen_options",
        mediaTypes: message.mediaTypes,
      })
      .then((response) =>
        sendResponse(
          response || { ok: false, error: "REGEN_CONFIG_UNAVAILABLE" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "REGEN_CONFIG_UNAVAILABLE",
        }),
      );
    return true;
  }
  if (message.action === "pq:regenPreflight") {
    chrome.runtime
      .sendMessage({
        action: "queue:regen_preflight",
        mediaTypes: message.mediaTypes,
        reconnect: message.reconnect === true,
        executionMode: message.executionMode,
      })
      .then((response) =>
        sendResponse(
          response || { ready: false, error: "REGEN_PREFLIGHT_NO_SIDEBAR_ACK" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ready: false,
          error: error?.message || "REGEN_PREFLIGHT_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:clearTrackerHistory") {
    chrome.runtime
      .sendMessage({
        action: "queue:clear_tracker_history",
        projectId: message.projectId || null,
        force: message.force === true,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : { ok: false, error: response?.error || "CLEAR_NO_SIDEBAR_ACK" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "CLEAR_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:removeTrackerItem") {
    chrome.runtime
      .sendMessage({
        action: "queue:remove_tracker_item",
        projectId: message.projectId || null,
        jobId: message.jobId || null,
        itemId: message.itemId || null,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : { ok: false, error: response?.error || "REMOVE_NO_SIDEBAR_ACK" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "REMOVE_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "pq:updateTrackerPrompt") {
    chrome.runtime
      .sendMessage({
        action: "queue:update_tracker_prompt",
        projectId: message.projectId || null,
        jobId: message.jobId || null,
        itemId: message.itemId || null,
        prompt: message.prompt,
      })
      .then((response) =>
        sendResponse(
          response?.ok === true
            ? response
            : { ok: false, error: response?.error || "SAVE_NO_SIDEBAR_ACK" },
        ),
      )
      .catch((error) =>
        sendResponse({
          ok: false,
          error: error?.message || "SAVE_RELAY_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "execution:lock_broadcast") {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "execution:tracker_broadcast") {
    chrome.runtime.sendMessage(message).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "closeExtraProviderTabs") {
    (async () => {
      try {
        const provider = message.provider;
        const urlPatterns = {
          flow: getFlowTabQueryPatterns(),
          chatgpt: PROVIDER_URLS.chatgpt.tabQuery,
          grok: PROVIDER_URLS.grok.tabQuery,
          gemini: PROVIDER_URLS.gemini.tabQuery,
          muse: (() => {
            const base = getProviderUrl("muse", "baseUrl");
            try {
              return `*://${new URL(base).hostname}/*`;
            } catch (_) {
              return null;
            }
          })(),
        };
        const pattern = urlPatterns[provider];
        if (!pattern) {
          sendResponse({ ok: false, error: "Unknown provider", closed: 0 });
          return;
        }
        const tabs = await chrome.tabs.query({ url: pattern });
        if (provider === "flow") {
          if (message.scope === "all_projects") {
            const projects = (tabs || [])
              .map((tab) => ({ tab, context: describeFlowTab(tab) }))
              .filter(
                (entry) =>
                  entry.context?.projectId &&
                  entry.context.origin === "https://flow.google.com",
              );
            let target = message.targetContext || null;
            if (!target)
              target =
                (await chrome.storage?.session?.get("targetFlowContext"))
                  ?.targetFlowContext || null;
            const keep2 = projects.find(
              (entry) =>
                entry.context.tabId === target?.tabId &&
                sameFlowTarget(entry.context, target),
            );
            if (!keep2) {
              sendResponse({
                ok: false,
                error: "FLOW_TARGET_CONTEXT_REQUIRED",
                closed: 0,
              });
              return;
            }
            const extrasIds3 = projects
              .filter((entry) => entry.tab.id !== keep2.tab.id)
              .map((entry) => entry.tab.id);
            if (extrasIds3.length > 0) await chrome.tabs.remove(extrasIds3);
            sendResponse({
              ok: true,
              closed: extrasIds3.length,
              kept: keep2.tab.id,
              target: keep2.context,
            });
            return;
          }
          const group = await getFlowDuplicateGroup(
            tabs,
            message.targetContext || null,
          );
          if (group.entries.length <= 1) {
            sendResponse({
              ok: true,
              closed: 0,
              kept: group.entries[0]?.tab.id || null,
            });
            return;
          }
          const keep =
            group.entries.find(
              (x) => x.context.tabId === group.intended?.tabId,
            ) || group.entries[0];
          const extrasIds2 = group.entries
            .filter((x) => x.tab.id !== keep.tab.id)
            .map((x) => x.tab.id);
          await chrome.tabs.remove(extrasIds2);
          sendResponse({
            ok: true,
            closed: extrasIds2.length,
            kept: keep.tab.id,
            target: keep.context,
          });
          return;
        }
        if (!tabs || tabs.length <= 1) {
          sendResponse({ ok: true, closed: 0, kept: tabs?.[0]?.id || null });
          return;
        }
        const keepTab = tabs[0];
        const extras = tabs.slice(1);
        const extrasIds = extras.map((t) => t.id).filter(Boolean);
        if (extrasIds.length > 0) {
          await chrome.tabs.remove(extrasIds);
        }
        console.log(
          `[TobyFlow] closeExtraProviderTabs(${provider}): closed ${extrasIds.length} extras, kept tabId=${keepTab.id}`,
        );
        sendResponse({ ok: true, closed: extrasIds.length, kept: keepTab.id });
      } catch (e) {
        console.warn("[TobyFlow] closeExtraProviderTabs error:", e.message);
        sendResponse({ ok: false, error: e.message, closed: 0 });
      }
    })();
    return true;
  }
  if (message.action === "closeFlowProjectTab") {
    (async () => {
      try {
        const tabId = Number(message.tabId);
        if (!Number.isInteger(tabId) || tabId <= 0) {
          sendResponse({ ok: false, error: "INVALID_FLOW_TAB", closed: 0 });
          return;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const context = describeFlowTab(tab);
        if (!context?.projectId) {
          sendResponse({
            ok: false,
            error: "FLOW_PROJECT_TAB_NOT_FOUND",
            closed: 0,
          });
          return;
        }
        let target = message.targetContext || null;
        if (!target)
          target =
            (await chrome.storage?.session?.get("targetFlowContext"))
              ?.targetFlowContext || null;
        if (target?.tabId === tabId) {
          sendResponse({
            ok: false,
            error: "FLOW_TARGET_TAB_CANNOT_CLOSE",
            closed: 0,
          });
          return;
        }
        await chrome.tabs.remove(tabId);
        sendResponse({
          ok: true,
          closed: 1,
          closedTabId: tabId,
          closedContext: context,
        });
      } catch (e) {
        console.warn("[TobyFlow] closeFlowProjectTab error:", e?.message || e);
        sendResponse({
          ok: false,
          error: e?.message || "FLOW_TAB_CLOSE_FAILED",
          closed: 0,
        });
      }
    })();
    return true;
  }
  const isProviderWorkerUiSender = () => {
    if (sender.id !== chrome.runtime.id || typeof sender.url !== "string")
      return false;
    try {
      const page = new URL(sender.url);
      return (
        page.href.startsWith(chrome.runtime.getURL("/")) &&
        [
          "/sidebar.html",
          "/workflow-editor.html",
          "/workflow-template-editor.html",
          "/run-window.html",
        ].includes(page.pathname)
      );
    } catch (_) {
      return false;
    }
  };
  if (
    message.action === "providerWorker:prepareWorkflowLayout" ||
    message.action === "providerWorker:restoreWorkflowLayout"
  ) {
    (async () => {
      try {
        const editorUrl = chrome.runtime.getURL("workflow-editor.html");
        if (
          sender.id !== chrome.runtime.id ||
          !sender.url?.startsWith(editorUrl) ||
          !Number.isInteger(sender.tab?.windowId)
        ) {
          sendResponse({ success: false, error: "WORKFLOW_EDITOR_ONLY" });
          return;
        }
        const args = { ...message, windowId: sender.tab.windowId };
        sendResponse(
          message.action === "providerWorker:prepareWorkflowLayout"
            ? await ProviderWorkerRegistry.prepareWorkflowLayout(args)
            : await ProviderWorkerRegistry.restoreWorkflowLayout(args),
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "WORKFLOW_LAYOUT_FAILED",
        });
      }
    })();
    return true;
  }
  if (
    message.action === "providerWorker:prepareMainLayout" ||
    message.action === "providerWorker:restoreMainLayout"
  ) {
    (async () => {
      try {
        if (
          sender.id !== chrome.runtime.id ||
          !sender.url?.startsWith(chrome.runtime.getURL("sidebar.html")) ||
          !Number.isInteger(message.windowId) ||
          (sender.tab && sender.tab.windowId !== message.windowId)
        ) {
          sendResponse({ success: false, error: "SIDEBAR_MAIN_WINDOW_ONLY" });
          return;
        }
        const main = await chrome.windows
          .get(message.windowId)
          .catch(() => null);
        if (
          main?.type !== "normal" ||
          _extensionPopupWindows.has(message.windowId)
        ) {
          sendResponse({ success: false, error: "MAIN_WINDOW_INVALID" });
          return;
        }
        sendResponse(
          message.action === "providerWorker:prepareMainLayout"
            ? await ProviderWorkerRegistry.prepareMainLayout(message)
            : await ProviderWorkerRegistry.restoreMainLayout(message),
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MAIN_LAYOUT_FAILED",
        });
      }
    })();
    return true;
  }
  if (
    message.action === "providerWorker:create" ||
    message.action === "providerWorker:verify" ||
    message.action === "providerWorker:list" ||
    message.action === "providerWorker:close" ||
    message.action === "providerWorker:assignPrompt" ||
    message.action === "providerWorker:returnToSourceIfWorkerFocused" ||
    message.action === "providerWorker:activateForSubmit" ||
    message.action === "providerWorker:restoreFocus"
  ) {
    (async () => {
      try {
        if (!isProviderWorkerUiSender()) {
          sendResponse({ success: false, error: "WORKER_UI_ONLY" });
          return;
        }
        const operation = message.action.split(":")[1];
        if (operation === "create" && message.sourceSurface === "motion") {
          sendResponse({
            success: false,
            error: "MOTION_WORKER_OWNER_REQUIRED",
          });
          return;
        }
        if (
          !["create", "list"].includes(operation) &&
          message.workerId &&
          (await ProviderWorkerRegistry._read())[message.workerId]
            ?.sourceSurface === "motion"
        ) {
          sendResponse({
            success: false,
            error: "MOTION_WORKER_OWNER_REQUIRED",
          });
          return;
        }
        if (operation === "list") {
          const result = await ProviderWorkerRegistry.list(
            message,
            (record) =>
              record.sourceSurface === "motion"
                ? MotionRunJournal.isWorkerLeaseActive(record)
                : ProviderWebQueueStore.isWorkerLeaseActive(record),
            _reconcileClosedMotionWorker,
          );
          const scopes = result.closedScopes || [];
          delete result.closedScopes;
          sendResponse(result);
          try {
            await _motionFlushClosedScopes(scopes);
          } catch (error) {
            console.warn("[MotionWorker] deferred delivery failed", {
              code: error?.message,
            });
          }
          return;
        }
        sendResponse(
          operation === "create"
            ? await ProviderWorkerRegistry.create(
                await resolveWorkflowWorkerSource(message, sender),
                _providerWorkerAdmission,
              )
            : await ProviderWorkerRegistry[operation](message),
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "WORKER_OPERATION_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "providerWorker:trackerUpdate") {
    (async () => {
      try {
        if (!isProviderWorkerUiSender()) {
          sendResponse({ success: false, error: "WORKER_UI_ONLY" });
          return;
        }
        if (
          message.workerId &&
          (await ProviderWorkerRegistry._read())[message.workerId]
            ?.sourceSurface === "motion"
        ) {
          sendResponse({
            success: false,
            error: "MOTION_WORKER_OWNER_REQUIRED",
          });
          return;
        }
        sendResponse(await ProviderWorkerRegistry.updateTracker(message));
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "WORKER_TRACKER_FAILED",
        });
      }
    })();
    return true;
  }
  if (
    message.action === "providerWeb:inputFocus" ||
    message.action === "providerWeb:inputFinished"
  ) {
    (async () => {
      try {
        const attemptId = message.attempt?.attemptId;
        const tabId = sender.tab?.id;
        if (!tabId || typeof attemptId !== "string")
          throw new Error("PROVIDER_INPUT_OWNER_REQUIRED");
        const attempt = await ProviderWebQueueStore.getAttempt(attemptId);
        if (
          !attempt ||
          attempt.tabId !== tabId ||
          attempt.submitStage !== "pre_submit"
        )
          throw new Error("PROVIDER_INPUT_ATTEMPT_FENCED");
        const data = await ProviderWebQueueStore.getRun(attempt.runId);
        if (
          !["workflow", "gentab_direct", "batch", "mcp_direct"].includes(
            data?.run?.source,
          ) ||
          !["chatgpt", "muse", "gemini"].includes(data.run.provider)
        )
          throw new Error("PROVIDER_INPUT_SOURCE_MISMATCH");
        if (
          message.action === "providerWeb:inputFocus" &&
          (data.reservation?.state !== "reserved" ||
            data.reservation.epoch !== attempt.epoch ||
            data.reservation.expiresAt <= Date.now())
        )
          throw new Error("PROVIDER_INPUT_RESERVATION_INACTIVE");
        const owner = {
          workerId: attempt.workerId,
          epoch: attempt.epoch,
          userId: data.run.userId,
          tabId,
          preferSourceWindow: data.run.source === "workflow",
        };
        const verified = await ProviderWorkerRegistry.verify(owner);
        if (!verified?.success)
          throw new Error(verified?.error || "PROVIDER_INPUT_WORKER_LOST");
        const outcome =
          message.action === "providerWeb:inputFocus"
            ? await ProviderWorkerRegistry.focusForSend(owner)
            : await ProviderWorkerRegistry.restoreFocus(owner);
        console.info(
          "[ProviderWeb] input_focus",
          JSON.stringify({
            stage:
              message.action === "providerWeb:inputFocus"
                ? "begin"
                : "finished",
            provider: data.run.provider,
            runId: attempt.runId,
            promptIndex: attempt.promptIndex,
            focused: outcome?.focused === true,
            restored: outcome?.restored === true,
            reason: outcome?.reason || outcome?.error || null,
          }),
        );
        sendResponse(outcome);
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "PROVIDER_INPUT_FOCUS_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "providerWeb:prepStage") {
    (async () => {
      try {
        const stage = message.stage;
        const uploadGate = stage === "input_reference_gate";
        const allowed = [
          "initial_editor_ready",
          "new_chat_ready",
          "model_start",
          "model_finished",
          "ref_upload_start",
          "ref_upload_finished",
          "image_mode_start",
          "image_mode_toggle_finished",
          "image_mode_finished",
          "input_start",
          "input_clear_finished",
          "input_insert_finished",
          "input_focus_finished",
          "input_gate_finished",
          "input_send_granted",
          "input_reference_gate",
        ];
        if (
          !allowed.includes(stage) ||
          !Number.isSafeInteger(message.elapsedMs) ||
          message.elapsedMs < 0 ||
          message.elapsedMs > (uploadGate ? 18e5 : 12e4)
        )
          throw new Error("PROVIDER_PREP_STAGE_INVALID");
        const attempt = await ProviderWebQueueStore.getAttempt(
          message.attempt?.attemptId,
        );
        if (
          !attempt ||
          attempt.tabId !== sender.tab?.id ||
          !(uploadGate
            ? ["pre_submit", "dispatch_intent"].includes(attempt.submitStage)
            : attempt.submitStage === "pre_submit")
        )
          throw new Error("PROVIDER_PREP_ATTEMPT_FENCED");
        const data = await ProviderWebQueueStore.getRun(attempt.runId);
        if (data?.run?.provider !== "chatgpt")
          throw new Error("PROVIDER_PREP_SOURCE_MISMATCH");
        console.info(
          "[ProviderWeb] prep_stage",
          JSON.stringify({
            runId: attempt.runId,
            promptIndex: attempt.promptIndex,
            stage,
            elapsedMs: message.elapsedMs,
            ...(uploadGate && message.uploadState
              ? {
                  uploadState: Object.fromEntries(
                    [
                      "ready",
                      "expectedReferences",
                      "attachedReferences",
                      "refImages",
                      "refTexts",
                      "refUploading",
                      "composerConnected",
                      "sendButtonPresent",
                      "sendButtonDisabled",
                      "ariaDisabled",
                      "elapsedMs",
                      "timeoutMs",
                    ]
                      .filter(
                        (key) =>
                          typeof message.uploadState[key] === "boolean" ||
                          (Number.isSafeInteger(message.uploadState[key]) &&
                            message.uploadState[key] >= 0),
                      )
                      .map((key) => [key, message.uploadState[key]]),
                  ),
                }
              : {}),
            visibility: ["visible", "hidden"].includes(message.visibility)
              ? message.visibility
              : null,
            macroDelayMs:
              Number.isSafeInteger(message.macroDelayMs) &&
              message.macroDelayMs >= 0 &&
              message.macroDelayMs <= 1e4
                ? message.macroDelayMs
                : null,
            ...(stage === "model_finished"
              ? {
                  modelSelected:
                    typeof message.modelSelected === "boolean"
                      ? message.modelSelected
                      : null,
                  modelSelectionReason: [
                    "not_requested",
                    "labels_missing",
                    "switcher_missing",
                    "already_active",
                    "control_not_menu",
                    "slider_selected",
                    "menu_missing",
                    "option_clicked",
                    "option_not_found",
                    "not_selected",
                    "interaction_error",
                  ].includes(message.modelSelectionReason)
                    ? message.modelSelectionReason
                    : null,
                }
              : {}),
          }),
        );
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "PROVIDER_PREP_STAGE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "providerWeb:beforeSend") {
    (async () => {
      let focusedOwner = null;
      try {
        const { attemptId } = message.attempt || {};
        const tabId = sender.tab?.id;
        if (!tabId || typeof attemptId !== "string")
          throw new Error("PROVIDER_SEND_OWNER_REQUIRED");
        const attempt = await ProviderWebQueueStore.getAttempt(attemptId);
        if (
          !attempt ||
          attempt.tabId !== tabId ||
          attempt.submitStage !== "pre_submit"
        )
          throw new Error("PROVIDER_SEND_ATTEMPT_FENCED");
        const data = await ProviderWebQueueStore.getRun(attempt.runId);
        const reservation = data?.reservation;
        const worker = await ProviderWorkerRegistry.verify({
          workerId: attempt.workerId,
          epoch: attempt.epoch,
          userId: data?.run?.userId,
          tabId,
        });
        const reservationActive =
          reservation?.state === "reserved" &&
          reservation.epoch === attempt.epoch &&
          reservation.expiresAt > Date.now();
        if (!worker.success || !reservationActive) {
          console.warn(
            "[ProviderWeb] before_send_denied",
            JSON.stringify({
              runId: attempt.runId,
              attemptId,
              provider: data?.run?.provider,
              workerError: worker?.error || null,
              workerTabState: worker?.tabState || null,
              reservationState: reservation?.state || null,
              epochMatches: reservation?.epoch === attempt.epoch,
              expiresInMs: Number.isFinite(reservation?.expiresAt)
                ? reservation.expiresAt - Date.now()
                : null,
            }),
          );
          throw new Error(
            worker.success
              ? "PROVIDER_SEND_RESERVATION_INACTIVE"
              : worker.error || "PROVIDER_SEND_WORKER_LOST",
          );
        }
        const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
        if (!auth?.token || String(auth?.user?.id) !== data.run.userId)
          throw new Error("PROVIDER_SEND_ACCOUNT_CHANGED");
        await ProviderWebQueueStore.markIntentRequest(attemptId, tabId);
        const body = JSON.stringify({
          run_id: attempt.runId,
          token: reservation.token,
          item_id: attempt.itemId,
          attempt_id: attempt.id,
          prompt_index: attempt.promptIndex,
          ...(data.run.source === "mcp_direct" &&
          data.run.provider === "muse" &&
          attempt.retryPreviousAttemptId
            ? {
                retry_previous_attempt_id: attempt.retryPreviousAttemptId,
                retry_reason: "muse_delivery_unconfirmed",
              }
            : {}),
        });
        const response = await _signedFetch(
          `${getApiBaseUrl()}/execution/provider-web/intent`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${auth.token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-Extension-Id": chrome.runtime.id,
            },
            body,
            cache: "no-store",
          },
        );
        const receipt = await response.json();
        if (
          !response.ok ||
          receipt?.success !== true ||
          receipt?.data?.status !== "dispatch_intent"
        )
          throw new Error(
            receipt?.error?.code || "PROVIDER_SERVER_INTENT_DENIED",
          );
        const currentAuth = (await chrome.storage.local.get("af_auth"))
          ?.af_auth;
        if (
          currentAuth?.token !== auth.token ||
          String(currentAuth?.user?.id) !== data.run.userId
        )
          throw new Error("PROVIDER_SEND_ACCOUNT_CHANGED");
        const currentWorker = await ProviderWorkerRegistry.verify({
          workerId: attempt.workerId,
          epoch: attempt.epoch,
          userId: data.run.userId,
          tabId,
        });
        if (!currentWorker.success)
          throw new Error("PROVIDER_SEND_WORKER_LOST");
        await ProviderWebQueueStore.markIntent(attemptId, {
          status: "dispatch_intent",
          replayed: receipt.data.replayed === true,
        });
        focusedOwner = {
          workerId: attempt.workerId,
          epoch: attempt.epoch,
          userId: data.run.userId,
          tabId,
          preferSourceWindow: data.run.source === "workflow",
        };
        const focus = await ProviderWorkerRegistry.focusForSend(focusedOwner);
        if (!focus.success)
          throw new Error(focus.error || "WORKER_SEND_FOCUS_FAILED");
        await ProviderWebQueueStore.grantClick(attemptId, tabId, attempt.epoch);
        chrome.runtime.sendMessage(
          {
            action: "providerWeb:changed",
            runId: attempt.runId,
            projectId: data.run.projectId,
          },
          () => void chrome.runtime.lastError,
        );
        sendResponse({ success: true, status: "dispatch_intent" });
      } catch (error) {
        if (focusedOwner)
          await ProviderWorkerRegistry.restoreFocus(focusedOwner).catch(
            () => {},
          );
        sendResponse({
          success: false,
          error: error?.message || "PROVIDER_SEND_INTENT_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "providerWeb:sendObserved") {
    (async () => {
      let owner = null;
      let observedAttempt = null;
      let response = null;
      try {
        const { attemptId } = message.attempt || {};
        const tabId = sender.tab?.id;
        if (!tabId || typeof attemptId !== "string")
          throw new Error("PROVIDER_SEND_OWNER_REQUIRED");
        const attempt = await ProviderWebQueueStore.getAttempt(attemptId);
        observedAttempt = attempt;
        if (!attempt || attempt.tabId !== tabId)
          throw new Error("PROVIDER_SEND_ATTEMPT_FENCED");
        const data = await ProviderWebQueueStore.getRun(attempt.runId);
        owner = {
          workerId: attempt.workerId,
          epoch: attempt.epoch,
          userId: data?.run?.userId,
          tabId,
        };
        await ProviderWebQueueStore.markSendObserved(attemptId, tabId);
        chrome.runtime.sendMessage(
          {
            action: "providerWeb:changed",
            runId: attempt.runId,
            projectId: data?.run?.projectId,
          },
          () => void chrome.runtime.lastError,
        );
        response = { success: true };
      } catch (error) {
        response = {
          success: false,
          error: error?.message || "PROVIDER_SEND_OBSERVATION_FAILED",
        };
      } finally {
        if (owner) {
          const restored = await ProviderWorkerRegistry.restoreFocus(
            owner,
          ).catch((error) => ({
            success: false,
            error: error?.message || "FOCUS_RESTORE_FAILED",
          }));
          console.info(
            "[ProviderWeb] send_observed_focus",
            JSON.stringify({
              runId: observedAttempt?.runId || null,
              promptIndex: observedAttempt?.promptIndex ?? null,
              restored: restored?.restored === true,
              reason: restored?.reason || restored?.error || null,
            }),
          );
        }
        sendResponse(response);
      }
    })();
    return true;
  }
  if (message.action === "providerWeb:revealResult") {
    (async () => {
      try {
        const attemptId = message.attempt?.attemptId;
        const tabId = sender.tab?.id;
        if (!tabId || typeof attemptId !== "string")
          throw new Error("PROVIDER_RESULT_OWNER_REQUIRED");
        const attempt = await ProviderWebQueueStore.getAttempt(attemptId);
        if (
          !attempt ||
          attempt.tabId !== tabId ||
          attempt.submitStage !== "dispatch_intent" ||
          !attempt.sendObservedAt ||
          attempt.receiptStage !== "none"
        )
          throw new Error("PROVIDER_RESULT_ATTEMPT_FENCED");
        const data = await ProviderWebQueueStore.getRun(attempt.runId);
        if (!data?.run?.userId) throw new Error("PROVIDER_RESULT_RUN_MISSING");
        const owner = {
          workerId: attempt.workerId,
          epoch: attempt.epoch,
          userId: data.run.userId,
          tabId,
        };
        const result = await ProviderWorkerRegistry.revealForResult(owner);
        console.info(
          "[ProviderWeb] result_reveal",
          JSON.stringify({
            provider: data.run.provider,
            runId: attempt.runId,
            promptIndex: attempt.promptIndex,
            revealed: result.revealed === true,
            restored: result.restored === true,
            focusAfter: result.focusAfter || null,
            reason: result.reason || result.error || null,
          }),
        );
        sendResponse(result);
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "PROVIDER_RESULT_REVEAL_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "provider:revealLegacyResult") {
    (async () => {
      try {
        const provider = message.provider;
        const tabId = sender.tab?.id;
        const sidebarResult =
          message.surface === "sidebar" &&
          ["chatgpt", "muse", "gemini"].includes(provider);
        if (
          !["muse", "gemini", "chatgpt"].includes(provider) ||
          !Number.isInteger(tabId) ||
          (!sidebarResult && !Number.isInteger(workflowWindowId))
        )
          throw new Error("LEGACY_REVEAL_OWNER_INVALID");
        if (!sidebarResult) {
          const editorTabs = await chrome.tabs.query({
            windowId: workflowWindowId,
            active: true,
          });
          if (
            !editorTabs.some((tab) =>
              tab.url?.startsWith(
                chrome.runtime.getURL("workflow-editor.html"),
              ),
            )
          )
            throw new Error("LEGACY_REVEAL_EDITOR_MISSING");
        }
        const visibility = await Promise.race([
          chrome.scripting
            .executeScript({
              target: { tabId },
              func: () => document.visibilityState,
            })
            .then((results) => results?.[0]?.result)
            .catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 2e3)),
        ]);
        if (visibility !== "hidden") {
          sendResponse({
            success: true,
            revealed: false,
            reason:
              visibility === "visible"
                ? "TARGET_VISIBLE"
                : "TARGET_VISIBILITY_UNKNOWN",
          });
          return;
        }
        const sourceWindowId = sidebarResult
          ? message.sourceWindowId
          : workflowWindowId;
        const result = await ProviderWorkerRegistry.revealLegacyForResult({
          sourceWindowId,
          tabId,
          provider,
        });
        console.info(
          "[ProviderWeb] legacy_result_reveal",
          JSON.stringify({
            provider,
            tabId,
            revealed: result.revealed === true,
            restored: result.restored === true,
            reason: result.reason || result.error || null,
          }),
        );
        sendResponse(result);
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "LEGACY_RESULT_REVEAL_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "provider:legacyResultWake") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const workflow =
          message.phase === "begin" && Number.isInteger(workflowWindowId)
            ? (
                await chrome.tabs.query({
                  windowId: workflowWindowId,
                  active: true,
                })
              ).some((tab) =>
                tab.url?.startsWith(
                  chrome.runtime.getURL("workflow-editor.html"),
                ),
              )
            : true;
        const provider = message.provider;
        const providerUrl = ["chatgpt", "muse", "gemini"].includes(provider)
          ? getProviderWorkerUrl(
              provider,
              provider === "muse" ? "baseUrl" : "base",
            )
          : null;
        if (
          !Number.isInteger(tabId) ||
          !["begin", "finish"].includes(message.phase) ||
          !workflow ||
          !providerUrl ||
          !sender.url ||
          new URL(sender.url).origin !== new URL(providerUrl).origin
        )
          throw new Error("LEGACY_RESULT_WAKE_OWNER_INVALID");
        const args = {
          provider,
          tabId,
          requestId: message.requestId,
          sourceWindowId: workflowWindowId,
        };
        sendResponse(
          message.phase === "begin"
            ? await LegacyProviderResultWake.begin(args)
            : await LegacyProviderResultWake.finish(args),
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "LEGACY_RESULT_WAKE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "flow:workflowUploadWake") {
    sendResponse({ success: false, error: "FLOW_UPLOAD_WAKE_RETIRED" });
    return true;
  }
  if (message.action === "flow:domFocus") {
    message = { ...message, action: "flow:uploadMenuFocus", domFocus: true };
  }
  if (message.action === "flow:uploadMenuFocus") {
    const runFocus = async () => {
      try {
        const isEditorUrl = (url) =>
          /^https:\/\/(?:labs\.toby\.vn|tobyflow\.com)\/app\/spaces\/[^/?#]+(?:[?#]|$)/.test(
            url || "",
          ) ||
          ["workflow-editor.html", "motion-editor.html"].some((page) => {
            const base = chrome.runtime.getURL(page);
            return (
              url === base ||
              url?.startsWith(base + "?") ||
              url?.startsWith(base + "#")
            );
          });
        const directEditor = Number.isInteger(message.tabId);
        let owner = directEditor ? sender.tab : null;
        if (
          directEditor &&
          (sender.id !== chrome.runtime.id || !isEditorUrl(sender.url))
        )
          throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
        if (!directEditor && Number.isInteger(message.uploadMenuOwnerTabId)) {
          owner = await chrome.tabs
            .get(message.uploadMenuOwnerTabId)
            .catch(() => null);
          if (
            !isEditorUrl(owner?.url) &&
            !(message.domFocus === true && message.phase === "end")
          )
            throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
        }
        if (message.domFocus === true) {
          if (sender.id !== chrome.runtime.id)
            throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
          if (message.phase === "begin" && !directEditor && !owner)
            owner =
              (
                await chrome.tabs.query({
                  active: true,
                  lastFocusedWindow: true,
                })
              ).find((candidate) => isEditorUrl(candidate.url)) || null;
          if (message.phase === "begin" && !owner) {
            sendResponse({
              success: true,
              focused: false,
              reason: "EDITOR_NOT_FOREGROUND",
            });
            return;
          }
        }
        const sourceWindowId = owner?.windowId ?? workflowWindowId;
        const tabId = directEditor ? message.tabId : sender.tab?.id;
        const requestId = message.requestId;
        if (
          !Number.isInteger(tabId) ||
          !["begin", "end"].includes(message.phase) ||
          typeof requestId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(requestId)
        )
          throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        const flow = describeFlowTab(tab);
        const key = `flow_upload_menu_focus_${tabId}`;
        if (
          message.domFocus === true &&
          message.phase === "end" &&
          (!tab?.active || flow?.isProjectEditor !== true)
        ) {
          const record = (await chrome.storage.session.get(key))?.[key];
          if (record?.requestId === requestId)
            await chrome.storage.session.remove(key);
          sendResponse({
            success: true,
            restored: false,
            reason: "USER_FOCUS_CHANGED",
          });
          return;
        }
        if (
          (!tab?.active &&
            !(message.domFocus === true && message.phase === "begin")) ||
          flow?.isProjectEditor !== true
        )
          throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
        if (message.phase === "begin") {
          const existing = (await chrome.storage.session.get(key))?.[key];
          if (
            existing &&
            existing.projectId === flow.projectId &&
            existing.requestId !== requestId
          ) {
            sendResponse({
              success: true,
              focused: false,
              reason: "FOCUS_LEASE_BUSY",
            });
            return;
          }
        }
        if (message.phase === "end") {
          const record = (await chrome.storage.session.get(key))?.[key];
          if (
            !record ||
            record.requestId !== requestId ||
            record.targetWindowId !== tab.windowId ||
            record.projectId !== flow.projectId
          ) {
            if (message.domFocus === true && record?.requestId === requestId)
              await chrome.storage.session.remove(key);
            sendResponse({
              success: true,
              restored: false,
              reason: "FOCUS_LEASE_MISSING",
            });
            return;
          }
          await chrome.storage.session.remove(key);
          const focused2 = await chrome.windows
            .getLastFocused()
            .catch(() => null);
          const target2 = await chrome.windows
            .get(tab.windowId)
            .catch(() => null);
          if (
            !(focused2?.id === tab.windowId && focused2.focused === true) &&
            target2?.focused !== true
          ) {
            sendResponse({
              success: true,
              restored: false,
              reason: "USER_FOCUS_CHANGED",
            });
            return;
          }
          const editorTabs2 = await chrome.tabs.query({
            windowId: record.sourceWindowId,
            active: true,
          });
          if (
            !editorTabs2.some((t) =>
              record.sourceTabId != null
                ? t.id === record.sourceTabId && isEditorUrl(t.url)
                : t.url?.startsWith(
                    chrome.runtime.getURL("workflow-editor.html"),
                  ),
            )
          ) {
            sendResponse({
              success: true,
              restored: false,
              reason: "WORKFLOW_EDITOR_CLOSED",
            });
            return;
          }
          const returnWindowId = Number.isInteger(record.returnWindowId)
            ? record.returnWindowId
            : record.sourceWindowId;
          const returnWindow = await chrome.windows
            .get(returnWindowId)
            .catch(() => null);
          await chrome.windows.update(
            returnWindow?.id || record.sourceWindowId,
            { focused: true },
          );
          console.info(
            "[FlowUploadMenuFocus] end",
            JSON.stringify({
              tabId,
              requestId,
              restored: true,
              returnWindowId: returnWindow?.id || record.sourceWindowId,
            }),
          );
          sendResponse({ success: true, restored: true });
          return;
        }
        if (
          flow.projectId !== message.projectId ||
          !Number.isInteger(sourceWindowId) ||
          tab.windowId === sourceWindowId
        )
          throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
        const editorTabs = await chrome.tabs.query({
          windowId: sourceWindowId,
          active: true,
        });
        const editor = editorTabs.find(
          (t) => isEditorUrl(t.url) && (!owner || t.id === owner.id),
        );
        if (
          !editor ||
          (editor.url?.startsWith(
            chrome.runtime.getURL("workflow-editor.html"),
          ) &&
            sourceWindowId !== workflowWindowId)
        )
          throw new Error("FLOW_UPLOAD_MENU_FOCUS_OWNER_INVALID");
        const source = await chrome.windows.get(sourceWindowId);
        const target = await chrome.windows.get(tab.windowId);
        const focused = await chrome.windows.getLastFocused().catch(() => null);
        if (
          target.focused === true ||
          (focused?.id === target.id && focused.focused === true)
        ) {
          sendResponse({
            success: true,
            focused: false,
            reason: "FLOW_ALREADY_FOCUSED",
          });
          return;
        }
        if (
          message.domFocus === true &&
          source.focused !== true &&
          !(focused?.id === sourceWindowId && focused.focused === true)
        ) {
          sendResponse({
            success: true,
            focused: false,
            reason: "EDITOR_NOT_FOREGROUND",
          });
          return;
        }
        const pageViewport = await Promise.race([
          chrome.scripting
            .executeScript({
              target: { tabId },
              func: () => ({
                visibility: document.visibilityState,
                innerWidth: window.innerWidth,
                outerWidth: window.outerWidth,
              }),
            })
            .then((results) => results?.[0]?.result)
            .catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 2e3)),
        ]);
        const visibility =
          typeof pageViewport === "string"
            ? pageViewport
            : (pageViewport?.visibility ?? null);
        const bounds = [
          source.left,
          source.top,
          source.width,
          source.height,
          target.left,
          target.top,
          target.width,
          target.height,
        ];
        const fullyCovered =
          bounds.every(Number.isFinite) &&
          source.left <= target.left &&
          source.top <= target.top &&
          source.left + source.width >= target.left + target.width &&
          source.top + source.height >= target.top + target.height;
        const overlapWidth = bounds.every(Number.isFinite)
          ? Math.max(
              0,
              Math.min(source.left + source.width, target.left + target.width) -
                Math.max(source.left, target.left),
            )
          : 0;
        const overlapHeight = bounds.every(Number.isFinite)
          ? Math.max(
              0,
              Math.min(source.top + source.height, target.top + target.height) -
                Math.max(source.top, target.top),
            )
          : 0;
        const coveredFraction =
          target.width > 0 && target.height > 0
            ? (overlapWidth * overlapHeight) / (target.width * target.height)
            : 0;
        const core = {
          left: target.left + target.width * 0.1,
          top: target.top + target.height * 0.1,
          width: target.width * 0.8,
          height: target.height * 0.8,
        };
        const coreOverlapWidth = bounds.every(Number.isFinite)
          ? Math.max(
              0,
              Math.min(source.left + source.width, core.left + core.width) -
                Math.max(source.left, core.left),
            )
          : 0;
        const coreOverlapHeight = bounds.every(Number.isFinite)
          ? Math.max(
              0,
              Math.min(source.top + source.height, core.top + core.height) -
                Math.max(source.top, core.top),
            )
          : 0;
        const coreCoveredFraction =
          core.width > 0 && core.height > 0
            ? (coreOverlapWidth * coreOverlapHeight) /
              (core.width * core.height)
            : 0;
        const needsMenuFocus =
          fullyCovered ||
          coveredFraction >= 0.95 ||
          (coveredFraction >= 0.92 && coreCoveredFraction >= 0.99);
        const canReveal = source.focused === true || visibility === "hidden";
        if (!canReveal || !needsMenuFocus) {
          console.info(
            "[FlowUploadMenuFocus] skip",
            JSON.stringify({
              tabId,
              requestId,
              reason: !canReveal ? "WORKFLOW_NOT_FOCUSED" : "FLOW_NOT_COVERED",
              visibility,
              sourceFocused: source.focused,
              pageViewportWidth: pageViewport?.innerWidth ?? null,
              pageOuterWidth: pageViewport?.outerWidth ?? null,
              coveredFraction: Math.round(coveredFraction * 100) / 100,
              coreCoveredFraction: Math.round(coreCoveredFraction * 100) / 100,
              foregroundWindowId: focused?.id ?? null,
              sourceBounds: {
                left: source.left,
                top: source.top,
                width: source.width,
                height: source.height,
              },
              flowBounds: {
                left: target.left,
                top: target.top,
                width: target.width,
                height: target.height,
              },
            }),
          );
          sendResponse({
            success: true,
            focused: false,
            reason: !canReveal ? "WORKFLOW_NOT_FOCUSED" : "FLOW_NOT_COVERED",
          });
          return;
        }
        if (message.domFocus === true) {
          const liveSource = await chrome.windows
            .get(sourceWindowId)
            .catch(() => null);
          if (liveSource?.focused !== true) {
            sendResponse({
              success: true,
              focused: false,
              reason: "USER_FOCUS_CHANGED",
            });
            return;
          }
        }
        await chrome.storage.session.set({
          [key]: {
            requestId,
            sourceWindowId,
            sourceTabId: editor.id,
            targetWindowId: tab.windowId,
            projectId: flow.projectId,
            returnWindowId:
              Number.isInteger(focused?.id) && focused.id !== tab.windowId
                ? focused.id
                : sourceWindowId,
          },
        });
        try {
          if (message.domFocus === true && !tab.active)
            await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (error) {
          await chrome.storage.session.remove(key);
          throw error;
        }
        if (message.domFocus === true) {
          const release = {
            action: "flow:domFocus",
            phase: "end",
            requestId,
            projectId: flow.projectId,
            uploadMenuOwnerTabId: editor.id,
          };
          setTimeout(
            () =>
              handleCoreRuntimeMessage(
                release,
                { id: chrome.runtime.id, tab: { id: tabId } },
                () => {},
              ),
            800,
          );
        }
        console.info(
          "[FlowUploadMenuFocus] begin",
          JSON.stringify({
            tabId,
            requestId,
            visibility,
            fullyCovered,
            coveredFraction: Math.round(coveredFraction * 100) / 100,
            pageViewportWidth: pageViewport?.innerWidth ?? null,
            pageOuterWidth: pageViewport?.outerWidth ?? null,
            coreCoveredFraction: Math.round(coreCoveredFraction * 100) / 100,
            stage:
              message.domFocus === true &&
              ["attach", "download"].includes(message.stage)
                ? message.stage
                : message.stage === "result_monitor"
                  ? "result_monitor"
                  : "menu",
            ...(message.domFocus === true &&
            [
              "target_missing",
              "media_not_ready",
              "menu_unacknowledged",
              "submenu_unacknowledged",
              "chip_pending",
              "scan_viewport",
            ].includes(message.reason)
              ? { reason: message.reason }
              : {}),
            sourceFocused: source.focused,
            previousWindowId: focused?.id || null,
            sourceBounds: {
              left: source.left,
              top: source.top,
              width: source.width,
              height: source.height,
            },
            flowBounds: {
              left: target.left,
              top: target.top,
              width: target.width,
              height: target.height,
            },
          }),
        );
        sendResponse({ success: true, focused: true, sourceWindowId });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "FLOW_UPLOAD_MENU_FOCUS_FAILED",
        });
      }
    };
    globalThis._flowMenuFocusQueue = (
      globalThis._flowMenuFocusQueue || Promise.resolve()
    )
      .catch(() => {})
      .then(runFocus);
    return true;
  }
  if (message.action === "flow:viewportSettleClock") {
    const flow = describeFlowTab(sender.tab);
    if (!Number.isInteger(sender.tab?.id) || flow?.isProjectEditor !== true) {
      sendResponse({
        success: false,
        error: "FLOW_VIEWPORT_CLOCK_OWNER_INVALID",
      });
    } else {
      setTimeout(
        () => sendResponse({ success: true }),
        message.timeoutMs === 500 ? 500 : 1e3,
      );
    }
    return true;
  }
  if (message.action === "provider:legacyInputFocus") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const sidebarInput = message.surface === "sidebar";
        const sourceWindowId = sidebarInput
          ? message.sourceWindowId
          : workflowWindowId;
        if (
          !["chatgpt", "muse", "gemini"].includes(message.provider) ||
          !Number.isInteger(tabId) ||
          !Number.isInteger(sourceWindowId) ||
          sender.tab?.windowId === sourceWindowId
        )
          throw new Error("LEGACY_INPUT_OWNER_INVALID");
        if (!sidebarInput) {
          const editorTabs = await chrome.tabs.query({
            windowId: sourceWindowId,
            active: true,
          });
          if (
            !editorTabs.some((tab) =>
              tab.url?.startsWith(
                chrome.runtime.getURL("workflow-editor.html"),
              ),
            )
          )
            throw new Error("LEGACY_INPUT_EDITOR_MISSING");
        }
        const result = await ProviderWorkerRegistry.revealLegacyForResult({
          sourceWindowId,
          tabId,
          provider: message.provider,
          purpose: "input",
        });
        console.info(
          "[ProviderWeb] legacy_input_focus",
          JSON.stringify({
            provider: message.provider,
            tabId,
            revealed: result.revealed === true,
            restored: result.restored === true,
            reason: result.reason || result.error || null,
          }),
        );
        sendResponse(result);
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "LEGACY_INPUT_FOCUS_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "provider:revealLegacyForWorkflow") {
    (async () => {
      try {
        const tabId = message.tabId;
        const editorTabId = sender.tab?.id;
        if (
          !["chatgpt", "muse", "gemini"].includes(message.provider) ||
          !["status", "input"].includes(message.stage) ||
          !Number.isInteger(tabId) ||
          !Number.isInteger(editorTabId) ||
          sender.tab?.windowId !== workflowWindowId ||
          !Number.isInteger(workflowWindowId)
        )
          throw new Error("LEGACY_REVEAL_OWNER_INVALID");
        const editorTabs = await chrome.tabs.query({
          windowId: workflowWindowId,
          active: true,
        });
        if (
          !editorTabs.some(
            (tab) =>
              tab.id === editorTabId &&
              tab.url?.startsWith(
                chrome.runtime.getURL("workflow-editor.html"),
              ),
          )
        )
          throw new Error("LEGACY_REVEAL_EDITOR_MISSING");
        const visibility = await Promise.race([
          chrome.scripting
            .executeScript({
              target: { tabId },
              func: () => document.visibilityState,
            })
            .then((results) => results?.[0]?.result)
            .catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 2e3)),
        ]);
        if (visibility !== "hidden") {
          sendResponse({
            success: true,
            revealed: false,
            reason:
              visibility === "visible"
                ? "TARGET_VISIBLE"
                : "TARGET_VISIBILITY_UNKNOWN",
          });
          return;
        }
        const revealKey = `${message.provider}:${tabId}`;
        if (
          message.stage === "input" &&
          Date.now() - (_legacyWorkflowRevealAt.get(revealKey) || 0) < 15e3
        ) {
          sendResponse({
            success: true,
            revealed: false,
            reason: "RECENTLY_REVEALED",
          });
          return;
        }
        const result = await ProviderWorkerRegistry.revealLegacyForResult({
          sourceWindowId: workflowWindowId,
          tabId,
          provider: message.provider,
        });
        if (result.revealed === true)
          _legacyWorkflowRevealAt.set(revealKey, Date.now());
        console.info(
          "[ProviderWeb] legacy_workflow_reveal",
          JSON.stringify({
            provider: message.provider,
            stage: message.stage,
            tabId,
            revealed: result.revealed === true,
            restored: result.restored === true,
            reason: result.reason || result.error || null,
          }),
        );
        sendResponse(result);
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "LEGACY_STATUS_REVEAL_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "provider:revealLegacyForSidebar") {
    (async () => {
      try {
        const tabId = message.tabId;
        if (
          sender.id !== chrome.runtime.id ||
          sender.url !== chrome.runtime.getURL("sidebar.html") ||
          !["chatgpt", "muse", "gemini"].includes(message.provider) ||
          !["status", "input"].includes(message.stage) ||
          !Number.isInteger(tabId)
        )
          throw new Error("LEGACY_REVEAL_OWNER_INVALID");
        const visibility = await Promise.race([
          chrome.scripting
            .executeScript({
              target: { tabId },
              func: () => document.visibilityState,
            })
            .then((results) => results?.[0]?.result)
            .catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 2e3)),
        ]);
        if (visibility !== "hidden") {
          sendResponse({
            success: true,
            revealed: false,
            reason:
              visibility === "visible"
                ? "TARGET_VISIBLE"
                : "TARGET_VISIBILITY_UNKNOWN",
          });
          return;
        }
        const source = Number.isInteger(message.sourceWindowId)
          ? await chrome.windows.get(message.sourceWindowId).catch(() => null)
          : null;
        if (!source || source.focused !== true) {
          sendResponse({
            success: true,
            revealed: false,
            reason: "SOURCE_WINDOW_UNAVAILABLE",
          });
          return;
        }
        sendResponse(
          await ProviderWorkerRegistry.revealLegacyForResult({
            sourceWindowId: message.sourceWindowId,
            tabId,
            provider: message.provider,
          }),
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "LEGACY_SIDEBAR_REVEAL_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:findOrCreateTab") {
    (async () => {
      try {
        const baseUrl = getProviderUrl("muse", "baseUrl");
        let host;
        try {
          host = new URL(baseUrl).hostname;
        } catch (_) {
          sendResponse({ success: false, error: "MUSE_URL_CONFIG_MISSING" });
          return;
        }
        const currentWindow = (await chrome.windows.getCurrent())?.id;
        let tabs = await chrome.tabs.query({
          url: `*://${host}/*`,
          windowId: currentWindow,
        });
        if (!tabs.length)
          tabs = await chrome.tabs.query({ url: `*://${host}/*` });
        let tab = tabs.find((candidate) => candidate.active) || tabs[0];
        if (!tab && message.createIfMissing !== false) {
          const newChatUrl = getProviderUrl("muse", "newChatUrl");
          let target;
          try {
            target = new URL(newChatUrl);
            if (
              target.protocol !== "https:" ||
              target.origin !== new URL(baseUrl).origin
            )
              throw new Error("INVALID_ORIGIN");
          } catch (_) {
            sendResponse({
              success: false,
              error: "MUSE_NEW_CHAT_URL_CONFIG_MISSING",
            });
            return;
          }
          tab = await chrome.tabs.create({
            url: target.href,
            active: !!message.activate,
            windowId: currentWindow,
          });
        }
        if (!tab?.id) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        sendResponse({ success: true, tabId: tab.id });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || "NO_TAB" });
      }
    })();
    return true;
  }
  if (message.action === "muse:ensureActive") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId);
        const baseUrl = getProviderUrl("muse", "baseUrl");
        const sameOrigin =
          baseUrl &&
          tab.url &&
          new URL(tab.url).origin === new URL(baseUrl).origin;
        if (!sameOrigin) {
          const pendingMuse =
            baseUrl &&
            tab.pendingUrl &&
            new URL(tab.pendingUrl).origin === new URL(baseUrl).origin;
          sendResponse({
            success: false,
            error:
              tab.status === "loading" && pendingMuse
                ? "MUSE_TAB_LOADING"
                : "NOT_MUSE_URL",
          });
          return;
        }
        const activated = message.activate !== false && !tab.active;
        const current = activated
          ? await chrome.tabs.update(message.tabId, { active: true })
          : tab;
        if (message.activate !== false && current?.active !== true) {
          sendResponse({
            success: false,
            error: "MUSE_TAB_ACTIVATION_UNCONFIRMED",
          });
          return;
        }
        if (message.activate !== false)
          console.info(
            "[MuseTabActivation]",
            JSON.stringify({
              tabId: message.tabId,
              windowId: tab.windowId || null,
              wasActive: tab.active === true,
              activeAfter: current?.active === true,
            }),
          );
        sendResponse({
          success: true,
          tabId: message.tabId,
          active: current?.active === true,
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "ACTIVATE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:injectScript") {
    (async () => {
      try {
        const tab = await chrome.tabs.get(message.tabId);
        if (tab.status === "loading") {
          sendResponse({ success: false, error: "MUSE_TAB_LOADING" });
          return;
        }
        const baseUrl = getProviderUrl("muse", "baseUrl");
        if (
          !baseUrl ||
          !tab.url ||
          new URL(tab.url).origin !== new URL(baseUrl).origin
        ) {
          sendResponse({ success: false, error: "NOT_MUSE_URL" });
          return;
        }
        const result = await chrome.scripting.executeScript({
          target: { tabId: message.tabId },
          func: () => !!window.__tobyflowMuseLoaded__,
        });
        if (!result?.[0]?.result)
          await chrome.scripting.executeScript({
            target: { tabId: message.tabId },
            files: ["src/core/ConfigSnapshotAccess.js", "chat-content-muse.js"],
          });
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "INJECT_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:checkSession") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const baseUrl = getProviderUrl("muse", "baseUrl");
        const origin = baseUrl ? new URL(baseUrl).origin : null;
        if (
          !Number.isInteger(tabId) ||
          !origin ||
          new URL(sender.tab.url).origin !== origin
        ) {
          sendResponse({
            success: false,
            error: "MUSE_SESSION_SOURCE_INVALID",
          });
          return;
        }
        if (!ProtectedConfigClient.allowedProviderSender(sender, "muse")) {
          sendResponse({
            success: false,
            error: "MUSE_SESSION_SOURCE_INVALID",
          });
          return;
        }
        const privateSnapshot = await ProtectedConfigClient.fetch("private", {
          provider: "muse",
        });
        const config = privateSnapshot?.data?.muse?.configs?.session_readiness;
        if (
          !config ||
          ![
            "session_url",
            "wake_url",
            "assigned_status",
            "running_state",
            "disabled_state",
          ].every((key) => typeof config[key] === "string" && config[key]) ||
          ![config.timeout_ms, config.poll_interval_ms].every(
            (value) => Number.isFinite(Number(value)) && Number(value) > 0,
          ) ||
          Number(config.poll_interval_ms) >= Number(config.timeout_ms)
        ) {
          sendResponse({
            success: false,
            error: "MUSE_SESSION_CONFIG_MISSING",
          });
          return;
        }
        const requestedTimeoutMs = message.timeoutMs;
        if (
          !Number.isSafeInteger(requestedTimeoutMs) ||
          requestedTimeoutMs < 1e4 ||
          requestedTimeoutMs > 12e4 ||
          Number(config.poll_interval_ms) >= requestedTimeoutMs
        ) {
          sendResponse({
            success: false,
            error: "MUSE_AUTOMATION_TIMINGS_MISSING",
          });
          return;
        }
        const policy = {
          ...config,
          timeout_ms: requestedTimeoutMs,
          session_url: new URL(config.session_url, origin).href,
          wake_url: new URL(config.wake_url, origin).href,
        };
        if (
          [policy.session_url, policy.wake_url].some(
            (url) => new URL(url).origin !== origin,
          )
        ) {
          sendResponse({ success: false, error: "MUSE_SESSION_URL_INVALID" });
          return;
        }
        const result = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: _probeMuseSessionInPage,
          args: [policy],
        });
        sendResponse(
          result?.[0]?.result || {
            success: false,
            error: "MUSE_SESSION_NO_RESPONSE",
          },
        );
      } catch (_) {
        sendResponse({ success: false, error: "MUSE_SESSION_CHECK_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "muse:checkLogin") {
    (async () => {
      try {
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "muse:checkLogin",
          waitForComposer: message.waitForComposer === true,
          timeoutMs: message.timeoutMs,
        });
        sendResponse(result || { success: false, error: "CHECK_FAILED" });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "CHECK_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:abort") {
    (async () => {
      try {
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "muse:abort",
          requestedAt: message.requestedAt,
        });
        sendResponse(result || { success: false, error: "ABORT_FAILED" });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "ABORT_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:newChat") {
    (async () => {
      try {
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "muse:newChat",
          timeoutMs: message.timeoutMs,
        });
        sendResponse(result || { success: false, error: "NEW_CHAT_FAILED" });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "NEW_CHAT_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:navigateNewChat") {
    (async () => {
      try {
        const timeoutMs = Number(message.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 12e4) {
          sendResponse({
            success: false,
            error: "MUSE_AUTOMATION_TIMINGS_MISSING",
          });
          return;
        }
        const baseUrl = getProviderUrl("muse", "baseUrl");
        const newChatUrl = getProviderUrl("muse", "newChatUrl");
        if (!baseUrl || !newChatUrl) {
          sendResponse({
            success: false,
            error: "NEW_CHAT_URL_CONFIG_MISSING",
          });
          return;
        }
        if (new URL(baseUrl).origin !== new URL(newChatUrl).origin) {
          sendResponse({
            success: false,
            error: "NEW_CHAT_URL_ORIGIN_INVALID",
          });
          return;
        }
        const current = await chrome.tabs.get(message.tabId);
        if (
          !current?.url ||
          new URL(current.url).origin !== new URL(baseUrl).origin
        ) {
          sendResponse({ success: false, error: "NOT_MUSE_URL" });
          return;
        }
        const target = new URL(newChatUrl);
        const oldUrl = current.url;
        const parentPath = target.pathname.slice(
          0,
          target.pathname.lastIndexOf("/") + 1,
        );
        const isNewChatDestination = (tab) => {
          if (tab?.pendingUrl || tab?.status !== "complete" || !tab.url)
            return false;
          let final;
          try {
            final = new URL(tab.url);
          } catch (_) {
            return false;
          }
          return (
            final.origin === target.origin &&
            (final.href === target.href ||
              (parentPath !== "/" &&
                final.pathname.startsWith(parentPath) &&
                final.href !== oldUrl))
          );
        };
        let finishLoad;
        const loaded = new Promise((resolve) => {
          finishLoad = resolve;
        });
        const onUpdated = (tabId, info, tab) => {
          if (
            tabId === message.tabId &&
            info.status === "complete" &&
            isNewChatDestination(tab)
          )
            finishLoad();
        };
        chrome.tabs.onUpdated.addListener(onUpdated);
        let timer;
        let poller;
        const navigationStartedAt = Date.now();
        try {
          const updated = await chrome.tabs.update(message.tabId, {
            url: newChatUrl,
            active: true,
          });
          const observed = isNewChatDestination(updated)
            ? updated
            : await chrome.tabs.get(message.tabId);
          if (!isNewChatDestination(observed)) {
            poller = setInterval(async () => {
              const candidate = await chrome.tabs
                .get(message.tabId)
                .catch(() => null);
              if (isNewChatDestination(candidate)) finishLoad();
            }, 150);
            timer = setTimeout(finishLoad, timeoutMs);
            await loaded;
          }
          const finalTab = await chrome.tabs.get(message.tabId);
          if (!isNewChatDestination(finalTab)) {
            let finalOrigin = null;
            let finalPath = null;
            try {
              const parsed = new URL(finalTab?.url);
              finalOrigin =
                parsed.origin === target.origin ? "same" : "different";
              finalPath =
                parsed.pathname === target.pathname
                  ? "target"
                  : parentPath !== "/" && parsed.pathname.startsWith(parentPath)
                    ? "parent_route"
                    : "other";
            } catch (_) {}
            console.warn("[MuseNavigation] new_chat_load_timeout", {
              tabId: message.tabId,
              status: finalTab?.status || null,
              origin: finalOrigin,
              route: finalPath,
              remainedOnPreviousUrl: finalTab?.url === oldUrl,
              elapsedMs: Date.now() - navigationStartedAt,
              timeoutMs,
            });
            sendResponse({ success: false, error: "NEW_CHAT_LOAD_TIMEOUT" });
            return;
          }
          sendResponse({ success: true });
        } finally {
          if (timer) clearTimeout(timer);
          if (poller) clearInterval(poller);
          chrome.tabs.onUpdated.removeListener(onUpdated);
        }
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "NEW_CHAT_NAVIGATION_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:deleteCurrentChat") {
    (async () => {
      try {
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "muse:deleteCurrentChat",
          cleanupOperationId: message.cleanupOperationId,
        });
        sendResponse(result || { success: false, error: "DELETE_FAILED" });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "DELETE_FAILED",
        });
      }
    })();
    return true;
  }
  if (
    message.action === "muse:downloadVideo" ||
    message.action === "muse:downloadImage"
  ) {
    (async () => {
      const { tabId, filename, url, waitTimeoutMs } = message;
      let sourceOrigin;
      if (
        !Number.isInteger(tabId) ||
        typeof filename !== "string" ||
        !filename ||
        typeof url !== "string" ||
        !url
      ) {
        sendResponse({
          success: false,
          error: "INVALID_MUSE_DOWNLOAD_ARGUMENTS",
        });
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        const base = getProviderUrl("muse", "baseUrl");
        if (
          !base ||
          !tab?.url ||
          new URL(tab.url).origin !== new URL(base).origin
        ) {
          sendResponse({
            success: false,
            error: "MUSE_DOWNLOAD_SOURCE_INVALID",
          });
          return;
        }
        sourceOrigin = new URL(base).origin;
      } catch (_) {
        sendResponse({ success: false, error: "MUSE_DOWNLOAD_SOURCE_INVALID" });
        return;
      }
      if (
        _museNativeDownloadTabs.size ||
        _pendingDownloadRenames.some(
          (entry) =>
            entry.sourceProvider === "muse" && entry.expires > Date.now(),
        )
      ) {
        sendResponse({ success: false, error: "MUSE_DOWNLOAD_BUSY" });
        return;
      }
      _museNativeDownloadTabs.add(tabId);
      const requestId = `muse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const slash = filename.lastIndexOf("/");
      _pendingDownloadRenames.push({
        requestId,
        sourceProvider: "muse",
        mediaType: message.action === "muse:downloadImage" ? "image" : "video",
        tabId,
        folder: slash >= 0 ? filename.slice(0, slash) : "",
        filename: slash >= 0 ? filename.slice(slash + 1) : filename,
        identifier: "",
        sourceUrl: url,
        sourceOrigin,
        expires: Date.now() + 9e4,
      });
      _persistPendingRenames();
      _museDownloadJobs.set(requestId, {});
      try {
        const triggered = await chrome.tabs.sendMessage(tabId, {
          action: message.action,
          payload: { url },
        });
        if (!triggered?.success) {
          _museDownloadJobs.delete(requestId);
          _pendingDownloadRenames = _pendingDownloadRenames.filter(
            (entry) => entry.requestId !== requestId,
          );
          _persistPendingRenames();
          sendResponse({
            success: false,
            error: triggered?.error || "MUSE_DOWNLOAD_NOT_TRIGGERED",
          });
          return;
        }
        sendResponse(await _waitForMuseDownload(requestId, waitTimeoutMs, 9e4));
      } catch (error) {
        _museDownloadJobs.delete(requestId);
        _pendingDownloadRenames = _pendingDownloadRenames.filter(
          (entry) => entry.requestId !== requestId,
        );
        _persistPendingRenames();
        sendResponse({
          success: false,
          error: error?.message || "MUSE_DOWNLOAD_FAILED",
        });
      } finally {
        _museNativeDownloadTabs.delete(tabId);
        _museDownloadJobs.delete(requestId);
        _pendingDownloadRenames = _pendingDownloadRenames.filter(
          (entry) => entry.requestId !== requestId,
        );
        _persistPendingRenames();
      }
    })();
    return true;
  }
  if (message.action === "muse:readVideoChunk") {
    (async () => {
      const { tabId, url, transferId, stage, offset, attemptId } = message;
      if (
        !isProviderWorkerUiSender() ||
        !Number.isInteger(tabId) ||
        typeof url !== "string" ||
        !url.startsWith("blob:") ||
        !/^[0-9a-f-]{36}$/i.test(transferId || "") ||
        !["open", "read", "close"].includes(stage) ||
        (stage === "read" && (!Number.isSafeInteger(offset) || offset < 0))
      ) {
        sendResponse({
          success: false,
          error: "INVALID_MUSE_VIDEO_CHUNK_ARGUMENTS",
        });
        return;
      }
      try {
        if (stage !== "close") {
          const attempt = await ProviderWebQueueStore.getAttempt(attemptId);
          const data =
            attempt && (await ProviderWebQueueStore.getRun(attempt.runId));
          if (
            !attempt ||
            attempt.tabId !== tabId ||
            attempt.submitStage !== "dispatch_intent" ||
            !attempt.sendObservedAt ||
            attempt.receiptStage !== "none" ||
            data?.run?.provider !== "muse" ||
            !data.items.some(
              (item) =>
                item.id === attempt.itemId && item.attemptId === attemptId,
            ) ||
            !(await ProviderWebQueueStore.isWorkerLeaseActive({
              runId: attempt.runId,
              userId: data.run.userId,
              epoch: attempt.epoch,
            }))
          ) {
            sendResponse({
              success: false,
              error: "MUSE_VIDEO_CHUNK_OWNER_LOST",
            });
            return;
          }
        }
        const tab = await chrome.tabs.get(tabId);
        if (
          new URL(tab?.url || "").origin !==
          new URL(getProviderUrl("muse", "baseUrl")).origin
        ) {
          sendResponse({ success: false, error: "MUSE_SOURCE_TAB_INVALID" });
          return;
        }
        const stored =
          stage === "close"
            ? null
            : await _readOperationalSnapshot(["toby_provider_configs"]);
        const config =
          stored?.toby_provider_configs?.data?.muse?.selectors?.result_video;
        const selectors = Array.isArray(config?.selectors)
          ? config.selectors.filter(
              (value) => typeof value === "string" && value,
            )
          : typeof config?.selector === "string" && config.selector
            ? [config.selector]
            : [];
        if (
          stage !== "close" &&
          (!selectors.length || !config?.attribute || !config?.media_selector)
        ) {
          sendResponse({
            success: false,
            error: "MUSE_VIDEO_SELECTOR_CONFIG_MISSING",
          });
          return;
        }
        const chunkBytes = 512 * 1024;
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [
            url,
            transferId,
            stage,
            offset ?? 0,
            chunkBytes,
            selectors,
            config?.attribute ?? null,
            config?.media_selector ?? null,
          ],
          func: async (
            requestedUrl,
            token,
            action,
            position,
            frameBytes,
            resultSelectors,
            attribute,
            mediaSelector,
          ) => {
            const transfers =
              globalThis.__tobyMuseVideoTransfers ||
              (globalThis.__tobyMuseVideoTransfers = new Map());
            const existing = transfers.get(token);
            if (action === "close") {
              if (existing?.url === requestedUrl) transfers.delete(token);
              return { success: true };
            }
            let wrappers = [];
            for (const selector of resultSelectors) {
              try {
                wrappers.push(...document.querySelectorAll(selector));
              } catch (_) {
                return { success: false, error: "MUSE_VIDEO_SELECTOR_INVALID" };
              }
            }
            const exact = wrappers.filter(
              (element) => element.getAttribute(attribute) === requestedUrl,
            );
            if (exact.length !== 1)
              return {
                success: false,
                error: exact.length
                  ? "MUSE_VIDEO_RESULT_AMBIGUOUS"
                  : "MUSE_VIDEO_RESULT_NOT_FOUND",
              };
            let media;
            try {
              media = exact[0].querySelector(mediaSelector);
            } catch (_) {
              return {
                success: false,
                error: "MUSE_VIDEO_MEDIA_SELECTOR_INVALID",
              };
            }
            const source =
              media?.currentSrc ||
              media?.src ||
              exact[0].getAttribute(attribute) ||
              "";
            if (source !== requestedUrl)
              return { success: false, error: "MUSE_VIDEO_SOURCE_MISMATCH" };
            if (action === "open") {
              if (existing)
                return { success: false, error: "MUSE_VIDEO_TRANSFER_EXISTS" };
              const response = await fetch(source);
              if (!response.ok)
                return {
                  success: false,
                  error: `MUSE_VIDEO_FETCH_${response.status}`,
                };
              const blob = await response.blob();
              if (
                !/^video\/[a-z0-9.+-]+$/i.test(blob.type || "") ||
                !Number.isSafeInteger(blob.size) ||
                blob.size <= 0
              )
                return { success: false, error: "MUSE_VIDEO_MEDIA_INVALID" };
              transfers.set(token, { url: requestedUrl, blob, offset: 0 });
              return {
                success: true,
                size: blob.size,
                mime: blob.type,
                chunkBytes: frameBytes,
              };
            }
            if (
              !existing ||
              existing.url !== requestedUrl ||
              position !== existing.offset ||
              position >= existing.blob.size
            )
              return {
                success: false,
                error: "MUSE_VIDEO_CHUNK_POSITION_INVALID",
              };
            const nextOffset = Math.min(
              position + frameBytes,
              existing.blob.size,
            );
            const part = existing.blob.slice(
              position,
              nextOffset,
              existing.blob.type,
            );
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () =>
                reject(
                  reader.error || new Error("MUSE_VIDEO_CHUNK_READ_FAILED"),
                );
              reader.readAsDataURL(part);
            });
            existing.offset = nextOffset;
            return {
              success: true,
              dataUrl,
              offset: position,
              nextOffset,
              done: nextOffset === existing.blob.size,
              size: existing.blob.size,
              mime: existing.blob.type,
            };
          },
        });
        sendResponse(
          injected?.[0]?.result || {
            success: false,
            error: "MUSE_VIDEO_MAIN_WORLD_EMPTY",
          },
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MUSE_VIDEO_CHUNK_READ_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:fetchVideoForFlow") {
    (async () => {
      const { tabId, url, maxBytes } = message;
      if (
        !Number.isInteger(tabId) ||
        typeof url !== "string" ||
        !url.startsWith("blob:") ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes <= 0
      ) {
        sendResponse({
          success: false,
          error: "INVALID_MUSE_VIDEO_FETCH_ARGUMENTS",
        });
        return;
      }
      try {
        const tab = await chrome.tabs.get(tabId);
        const museBaseUrl = getProviderUrl("muse", "baseUrl");
        let expectedHost = null;
        try {
          expectedHost = new URL(museBaseUrl).hostname;
        } catch (_) {}
        let actualHost = null;
        try {
          actualHost = new URL(tab?.url || "").hostname;
        } catch (_) {}
        if (!expectedHost || actualHost !== expectedHost) {
          sendResponse({ success: false, error: "MUSE_SOURCE_TAB_INVALID" });
          return;
        }
        const stored = await _readOperationalSnapshot([
          "toby_provider_configs",
        ]);
        const resultConfig =
          stored?.toby_provider_configs?.data?.muse?.selectors?.result_video ||
          null;
        const configuredSelectors = Array.isArray(resultConfig?.selectors)
          ? resultConfig.selectors.filter(
              (value) => typeof value === "string" && value,
            )
          : typeof resultConfig?.selector === "string" && resultConfig.selector
            ? [resultConfig.selector]
            : [];
        const sourceAttribute = resultConfig?.attribute;
        const mediaSelector = resultConfig?.media_selector;
        if (
          !configuredSelectors.length ||
          typeof sourceAttribute !== "string" ||
          !sourceAttribute ||
          typeof mediaSelector !== "string" ||
          !mediaSelector
        ) {
          sendResponse({
            success: false,
            error: "MUSE_VIDEO_SELECTOR_CONFIG_MISSING",
          });
          return;
        }
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [
            url,
            maxBytes,
            configuredSelectors,
            sourceAttribute,
            mediaSelector,
          ],
          func: async (
            requestedUrl,
            limitBytes,
            selectors,
            attribute,
            nestedSelector,
          ) => {
            let wrappers = [];
            for (const selector of selectors) {
              try {
                wrappers.push(...document.querySelectorAll(selector));
              } catch (_) {
                return { success: false, error: "MUSE_VIDEO_SELECTOR_INVALID" };
              }
            }
            const exact = wrappers.filter(
              (element) => element.getAttribute(attribute) === requestedUrl,
            );
            if (exact.length !== 1)
              return {
                success: false,
                error: exact.length
                  ? "MUSE_VIDEO_RESULT_AMBIGUOUS"
                  : "MUSE_VIDEO_RESULT_NOT_FOUND",
              };
            let media = null;
            try {
              media = exact[0].querySelector(nestedSelector);
            } catch (_) {
              return {
                success: false,
                error: "MUSE_VIDEO_MEDIA_SELECTOR_INVALID",
              };
            }
            const source =
              media?.currentSrc ||
              media?.src ||
              exact[0].getAttribute(attribute) ||
              "";
            if (source !== requestedUrl)
              return { success: false, error: "MUSE_VIDEO_SOURCE_MISMATCH" };
            try {
              const response = await fetch(source);
              if (!response.ok)
                return {
                  success: false,
                  error: `MUSE_VIDEO_FETCH_${response.status}`,
                };
              const declared = Number(
                response.headers.get("content-length") || 0,
              );
              if (Number.isFinite(declared) && declared > limitBytes)
                return {
                  success: false,
                  error: "MUSE_VIDEO_TOO_LARGE",
                  size: declared,
                };
              const blob = await response.blob();
              if (!/^video\//i.test(blob.type || "") || blob.size <= 0)
                return { success: false, error: "MUSE_VIDEO_MEDIA_INVALID" };
              if (blob.size > limitBytes)
                return {
                  success: false,
                  error: "MUSE_VIDEO_TOO_LARGE",
                  size: blob.size,
                };
              const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () =>
                  reject(reader.error || new Error("MUSE_VIDEO_READ_FAILED"));
                reader.readAsDataURL(blob);
              });
              return typeof dataUrl === "string" &&
                /^data:video\/[a-z0-9.+-]+;base64,/i.test(dataUrl)
                ? { success: true, dataUrl, mime: blob.type, size: blob.size }
                : { success: false, error: "MUSE_VIDEO_DATA_INVALID" };
            } catch (error) {
              return {
                success: false,
                error: error?.message || "MUSE_VIDEO_FETCH_FAILED",
              };
            }
          },
        });
        sendResponse(
          injected?.[0]?.result || {
            success: false,
            error: "MUSE_VIDEO_MAIN_WORLD_EMPTY",
          },
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MUSE_VIDEO_FETCH_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:captureVideoPoster") {
    (async () => {
      const { tabId, url } = message;
      if (!Number.isInteger(tabId) || !url) {
        sendResponse({
          success: false,
          error: "INVALID_MUSE_POSTER_ARGUMENTS",
        });
        return;
      }
      try {
        let result = null;
        try {
          result = await chrome.tabs.sendMessage(tabId, {
            action: "muse:captureVideoPoster",
            payload: { url },
          });
        } catch (_) {}
        const hasUsablePoster = (value) =>
          typeof value === "string" &&
          /^data:image\/[a-z0-9.+-]+;base64,/i.test(value) &&
          value.length > 512;
        if (result?.success && hasUsablePoster(result.poster)) {
          sendResponse(result);
          return;
        }
        const stored = await _readOperationalSnapshot([
          "toby_provider_configs",
        ]);
        const selectorConfig =
          stored?.toby_provider_configs?.data?.muse?.selectors?.result_video ||
          null;
        const captureConfig = selectorConfig
          ? {
              selector: selectorConfig.selector,
              sourceAttribute: selectorConfig.attribute,
              posterAttribute: selectorConfig.poster_attribute,
            }
          : null;
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [url, captureConfig],
          func: async (mediaUrl, config) => {
            const selector = config?.selector;
            const sourceAttribute = config?.sourceAttribute;
            const posterAttribute = config?.posterAttribute;
            if (!selector || !sourceAttribute || !posterAttribute) {
              return {
                success: false,
                error: "MUSE_POSTER_SELECTOR_CONFIG_MISSING",
              };
            }
            let wrappers = [];
            try {
              wrappers = [...document.querySelectorAll(selector)];
            } catch (_) {
              return { success: false, error: "MUSE_POSTER_SELECTOR_INVALID" };
            }
            const wrapper =
              wrappers.find(
                (element) => element.getAttribute(sourceAttribute) === mediaUrl,
              ) || (wrappers.length === 1 ? wrappers[0] : null);
            const posterUrl = wrapper?.getAttribute(posterAttribute) || "";
            if (!posterUrl)
              return { success: false, error: "MUSE_POSTER_SOURCE_NOT_FOUND" };
            try {
              const image = new Image();
              image.src = posterUrl;
              await image.decode();
              if (image.naturalWidth > 1 && image.naturalHeight > 1) {
                const maxWidth = 640;
                const scale = Math.min(1, maxWidth / image.naturalWidth);
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(
                  1,
                  Math.round(image.naturalWidth * scale),
                );
                canvas.height = Math.max(
                  1,
                  Math.round(image.naturalHeight * scale),
                );
                canvas
                  .getContext("2d")
                  ?.drawImage(image, 0, 0, canvas.width, canvas.height);
                const poster2 = canvas.toDataURL("image/jpeg", 0.8);
                if (poster2.startsWith("data:image/") && poster2.length > 512)
                  return { success: true, poster: poster2 };
              }
              const response = await fetch(posterUrl);
              if (!response.ok)
                return {
                  success: false,
                  error: `MUSE_POSTER_FETCH_${response.status}`,
                };
              const blob = await response.blob();
              const poster = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
              return typeof poster === "string" &&
                poster.startsWith("data:image/") &&
                poster.length > 512
                ? { success: true, poster }
                : { success: false, error: "MUSE_POSTER_NOT_IMAGE" };
            } catch (error) {
              return {
                success: false,
                error: error?.message || "MUSE_POSTER_FETCH_FAILED",
              };
            }
          },
        });
        sendResponse(
          injected?.[0]?.result ||
            result || { success: false, error: "MUSE_POSTER_CAPTURE_FAILED" },
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MUSE_POSTER_CAPTURE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:playVideo") {
    (async () => {
      const { tabId, url } = message;
      if (!Number.isInteger(tabId) || !url) {
        sendResponse({ success: false, error: "INVALID_MUSE_PLAY_ARGUMENTS" });
        return;
      }
      try {
        const stored = await _readOperationalSnapshot([
          "toby_provider_configs",
        ]);
        const selectorConfig =
          stored?.toby_provider_configs?.data?.muse?.selectors?.result_video ||
          null;
        const playConfig = selectorConfig
          ? {
              selector: selectorConfig.selector,
              sourceAttribute: selectorConfig.attribute,
              mediaSelector: selectorConfig.media_selector,
            }
          : null;
        const driverState = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.__tobyflowMuseNativeVideoWrapperPlay__ === true,
        });
        if (!driverState?.[0]?.result) {
          await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            args: [url, playConfig],
            func: async (mediaUrl, config) => {
              const selector = config?.selector;
              const sourceAttribute = config?.sourceAttribute;
              if (!selector || !sourceAttribute) return false;
              let wrappers = [];
              try {
                wrappers = [...document.querySelectorAll(selector)];
              } catch (_) {
                return false;
              }
              const wrapper =
                wrappers.find(
                  (element) =>
                    element.getAttribute(sourceAttribute) === mediaUrl,
                ) || (wrappers.length === 1 ? wrappers[0] : null);
              if (!wrapper) return false;
              try {
                wrapper.scrollIntoView({
                  block: "center",
                  inline: "nearest",
                  behavior: "auto",
                });
              } catch (_) {}
              const rect = wrapper.getBoundingClientRect();
              const options = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
                button: 0,
                buttons: 1,
              };
              wrapper.dispatchEvent(
                new PointerEvent("pointerdown", {
                  ...options,
                  pointerType: "mouse",
                }),
              );
              wrapper.dispatchEvent(new MouseEvent("mousedown", options));
              wrapper.dispatchEvent(
                new PointerEvent("pointerup", {
                  ...options,
                  pointerType: "mouse",
                }),
              );
              wrapper.dispatchEvent(new MouseEvent("mouseup", options));
              wrapper.dispatchEvent(new MouseEvent("click", options));
              return true;
            },
          });
        }
        let result = await chrome.tabs.sendMessage(tabId, {
          action: "muse:playVideo",
          payload: { url },
        });
        if (result?.success) {
          sendResponse(result);
          return;
        }
        const injected = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          args: [url, playConfig],
          func: async (mediaUrl, config) => {
            const selector = config?.selector;
            const sourceAttribute = config?.sourceAttribute;
            const mediaSelector = config?.mediaSelector;
            if (!selector || !sourceAttribute || !mediaSelector) {
              return {
                success: false,
                error: "MUSE_PLAY_SELECTOR_CONFIG_MISSING",
              };
            }
            let wrappers = [];
            try {
              wrappers = [...document.querySelectorAll(selector)];
            } catch (_) {
              return { success: false, error: "MUSE_PLAY_SELECTOR_INVALID" };
            }
            const wrapper =
              wrappers.find(
                (element) => element.getAttribute(sourceAttribute) === mediaUrl,
              ) || (wrappers.length === 1 ? wrappers[0] : null);
            if (!wrapper)
              return { success: false, error: "MUSE_PLAY_RESULT_AMBIGUOUS" };
            let media = null;
            try {
              media = wrapper.querySelector(mediaSelector);
            } catch (_) {}
            if (!media || typeof media.play !== "function")
              return { success: false, error: "MUSE_PLAY_MEDIA_NOT_FOUND" };
            try {
              wrapper.scrollIntoView({
                block: "center",
                inline: "nearest",
                behavior: "auto",
              });
              await media.play();
              return { success: true, playing: !media.paused };
            } catch (error) {
              try {
                media.muted = true;
                await media.play();
                return {
                  success: true,
                  playing: !media.paused,
                  mutedFallback: true,
                };
              } catch (_) {
                return {
                  success: false,
                  error: error?.message || "MUSE_PLAY_FAILED",
                };
              }
            }
          },
        });
        sendResponse(
          injected?.[0]?.result ||
            result || { success: false, error: "MUSE_PLAY_FAILED" },
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MUSE_PLAY_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:trace") {
    const stage = typeof message.stage === "string" ? message.stage : "unknown";
    const data =
      message.data && typeof message.data === "object" ? message.data : {};
    console.info(
      `[MuseTrace] ${stage}`,
      JSON.stringify({
        ...data,
        tabId: sender.tab?.id || null,
        attemptId:
          typeof message.attemptId === "string" ? message.attemptId : null,
      }),
    );
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "muse:submitAndWait") {
    (async () => {
      try {
        console.info(
          "[MuseTrace] relay_started",
          JSON.stringify({
            tabId: message.tabId,
            attemptId: message.payload?.workerAttempt?.attemptId || null,
            mode: message.payload?.mode || null,
          }),
        );
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "muse:submitAndWait",
          payload: message.payload || {},
        });
        console.info(
          "[MuseTrace] relay_finished",
          JSON.stringify({
            tabId: message.tabId,
            attemptId: message.payload?.workerAttempt?.attemptId || null,
            success: result?.success === true,
            error: result?.error || null,
            mediaType: result?.mediaType || null,
            mediaCount: Array.isArray(result?.mediaUrls)
              ? result.mediaUrls.length
              : 0,
          }),
        );
        sendResponse(result || { success: false, error: "SUBMIT_FAILED" });
      } catch (error) {
        console.error(
          "[TobyFlow] muse:submitAndWait error:",
          error?.message || error,
        );
        sendResponse({
          success: false,
          error: "EXCEPTION",
          message: error?.message || String(error),
          diagnostic: { exceptionOrigin: "bridge_dispatch" },
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:broadcastTracker") {
    (async () => {
      try {
        const baseUrl = getProviderUrl("muse", "baseUrl");
        const host = new URL(baseUrl).hostname;
        const tabs = await chrome.tabs.query({ url: `*://${host}/*` });
        const workerTabs = await ProviderWorkerRegistry.ownedTabIds();
        const data =
          message.data && typeof message.data === "object"
            ? message.data
            : null;
        for (const tab of tabs) {
          if (!Number.isInteger(tab?.id) || workerTabs.has(tab.id)) continue;
          if (data?.isRunning === false)
            _museTrackerSnapshotsByTab.delete(tab.id);
          else if (data) _museTrackerSnapshotsByTab.set(tab.id, data);
        }
        const legacyTabs = tabs.filter(
          (tab) => Number.isInteger(tab.id) && !workerTabs.has(tab.id),
        );
        await Promise.all(
          legacyTabs.map((tab) =>
            chrome.tabs
              .sendMessage(tab.id, { action: "pq:trackerUpdate", data })
              .catch(() => null),
          ),
        );
        sendResponse({ success: true, count: legacyTabs.length });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MUSE_TRACKER_BROADCAST_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "muse:getTrackerSnapshot") {
    const tabId = sender?.tab?.id;
    (async () => {
      const worker = Number.isInteger(tabId)
        ? await ProviderWorkerRegistry.trackerForTab(tabId)
        : null;
      const data = worker?.owned
        ? worker.data
        : Number.isInteger(tabId)
          ? _museTrackerSnapshotsByTab.get(tabId) || null
          : null;
      sendResponse({
        success: true,
        data: data?.isRunning !== false ? data : null,
      });
    })().catch(() => sendResponse({ success: false, data: null }));
    return true;
  }
  if (message.action === "chatgpt:broadcastTracker") {
    (async () => {
      try {
        const tabIds = [
          ...new Set(
            (Array.isArray(message.tabIds) ? message.tabIds : []).filter(
              Number.isInteger,
            ),
          ),
        ];
        const data =
          message.data && typeof message.data === "object"
            ? message.data
            : null;
        for (const tabId of tabIds) {
          if (data?.isRunning === false)
            _chatgptTrackerSnapshotsByTab.delete(tabId);
          else if (data) _chatgptTrackerSnapshotsByTab.set(tabId, data);
        }
        await Promise.all(
          tabIds.map((tabId) =>
            chrome.tabs
              .sendMessage(tabId, { action: "pq:trackerUpdate", data })
              .catch(() => null),
          ),
        );
        sendResponse({ success: true, count: tabIds.length });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "CHATGPT_TRACKER_BROADCAST_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:getTrackerSnapshot") {
    const tabId = sender?.tab?.id;
    const data = Number.isInteger(tabId)
      ? _chatgptTrackerSnapshotsByTab.get(tabId) || null
      : null;
    sendResponse({
      success: true,
      data: data?.isRunning !== false ? data : null,
    });
    return false;
  }
  if (message.action === "grok:broadcastTracker") {
    (async () => {
      try {
        const tabIds = [
          ...new Set(
            (Array.isArray(message.tabIds) ? message.tabIds : []).filter(
              Number.isInteger,
            ),
          ),
        ];
        const data =
          message.data && typeof message.data === "object"
            ? message.data
            : null;
        for (const tabId of tabIds) {
          if (data?.isRunning === false)
            _grokTrackerSnapshotsByTab.delete(tabId);
          else if (data) _grokTrackerSnapshotsByTab.set(tabId, data);
        }
        await Promise.all(
          tabIds.map((tabId) =>
            chrome.tabs
              .sendMessage(tabId, { action: "pq:trackerUpdate", data })
              .catch(() => null),
          ),
        );
        sendResponse({ success: true, count: tabIds.length });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "GROK_TRACKER_BROADCAST_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "grok:getTrackerSnapshot") {
    const tabId = sender?.tab?.id;
    const data = Number.isInteger(tabId)
      ? _grokTrackerSnapshotsByTab.get(tabId) || null
      : null;
    sendResponse({
      success: true,
      data: data?.isRunning !== false ? data : null,
    });
    return false;
  }
  if (message.action === "queryProviderTabs") {
    (async () => {
      try {
        const provider = message.provider;
        const urlPatterns = {
          flow: getFlowTabQueryPatterns(),
          chatgpt: PROVIDER_URLS.chatgpt.tabQuery,
          grok: PROVIDER_URLS.grok.tabQuery,
          gemini: PROVIDER_URLS.gemini.tabQuery,
          muse: (() => {
            const base = getProviderUrl("muse", "baseUrl");
            try {
              return `*://${new URL(base).hostname}/*`;
            } catch (_) {
              return null;
            }
          })(),
        };
        const pattern = urlPatterns[provider];
        if (!pattern) {
          sendResponse({ count: 0, error: "Unknown provider" });
          return;
        }
        let tabs = await chrome.tabs.query({ url: pattern });
        if (provider === "flow") {
          tabs = await getLiveFlowAdvisoryTabs(tabs);
          const group = await getFlowDuplicateGroup(
            tabs,
            message.targetContext || null,
          );
          const projectTabs = (tabs || [])
            .map((tab) => ({ tab, context: describeFlowTab(tab) }))
            .filter(
              (entry) =>
                entry.context?.projectId &&
                entry.context.origin === "https://flow.google.com",
            );
          sendResponse({
            count: group.entries.length,
            total: tabs?.length || 0,
            projectCount: projectTabs.length,
            target: group.intended,
            tabs: group.entries.map((x) => ({
              id: x.tab.id,
              url: x.tab.url,
              ...x.context,
            })),
            projectTabs: projectTabs.map((x) => ({
              id: x.tab.id,
              url: x.tab.url,
              ...x.context,
            })),
          });
          return;
        }
        sendResponse({
          count: tabs?.length || 0,
          tabs: (tabs || []).map((t) => ({ id: t.id, url: t.url })),
        });
      } catch (e) {
        sendResponse({ count: 0, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "activateFlowTabForExecution") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (!tabs || tabs.length === 0) {
          sendResponse({ ok: false, error: "No Flow tab found" });
          return;
        }
        const requestedTabId = message.forMediaScan
          ? sender.tab?.id
          : message.tabId;
        if (
          (message.forMediaScan || requestedTabId != null) &&
          !tabs.some((t) => t.id === requestedTabId)
        ) {
          sendResponse({
            ok: false,
            error: message.forMediaScan
              ? "Scan sender is not an available Flow tab"
              : "Requested Flow tab is not available",
          });
          return;
        }
        const flowTab =
          (requestedTabId && tabs.find((t) => t.id === requestedTabId)) ||
          tabs.find((t) => t.active) ||
          tabs[0];
        if (!flowTab.active) {
          await chrome.tabs.update(flowTab.id, { active: true });
        }
        if (message.focusWindow) {
          try {
            await chrome.windows.update(flowTab.windowId, { focused: true });
          } catch (_) {}
        }
        sendResponse({ ok: true, tabId: flowTab.id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "focusWorkflowWindow") {
    (async () => {
      try {
        if (workflowWindowId !== null) {
          const win = await chrome.windows
            .get(workflowWindowId)
            .catch(() => null);
          if (win) {
            await chrome.windows.update(workflowWindowId, { focused: true });
            sendResponse({ ok: true, focused: true });
            return;
          }
          workflowWindowId = null;
        }
        sendResponse({ ok: true, focused: false });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "sendWebhook") {
    const { url, data } = message;
    if (!_isAllowedUrl(url)) {
      sendResponse({ success: false, error: "URL not allowed" });
      return true;
    }
    (async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        sendResponse({ success: response.ok, status: response.status });
      } catch (err) {
        console.warn("[TobyFlow] Webhook send failed:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "prepareDownloadRename") {
    const flowCreationWindow =
      message.sourceProvider === "flow" &&
      Number.isFinite(message.creationTimeoutMs) &&
      message.creationTimeoutMs > 0
        ? message.creationTimeoutMs
        : 0;
    const renameTtlMs =
      message.sourceProvider === "gemini"
        ? 9e4
        : message.sourceProvider === "grok"
          ? 15e3
          : Math.max(3e5, flowCreationWindow + 3e4);
    const renameEntry = {
      folder: message.folder || "",
      filename: message.filename || "",
      identifier: message.identifier || message.filename || "",
      sourceProvider: message.sourceProvider || null,
      tabId: Number.isInteger(message.tabId) ? message.tabId : null,
      removeWatermark: message.removeWatermark === true,
      requestId: message.requestId || null,
      expires: Date.now() + renameTtlMs,
    };
    _pendingDownloadRenames.push(renameEntry);
    _persistPendingRenames();
    console.log(
      `[TobyFlow] prepareDownloadRename queued: folder="${message.folder}", filename="${message.filename}", identifier="${renameEntry.identifier}", queueSize=${_pendingDownloadRenames.length}`,
    );
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "awaitPreparedDownload") {
    const sourceTabId = Number.isInteger(sender?.tab?.id)
      ? sender.tab.id
      : null;
    const sourceFrameId = Number.isInteger(sender?.frameId)
      ? sender.frameId
      : null;
    const complete = (result) => {
      const before = _pendingDownloadRenames.length;
      _pendingDownloadRenames = _pendingDownloadRenames.filter(
        (entry) => entry.requestId !== message.requestId,
      );
      if (_pendingDownloadRenames.length !== before) _persistPendingRenames();
      if (sourceTabId !== null) {
        const payload = {
          action: "preparedDownloadCompleted",
          requestId: message.requestId,
          result,
        };
        try {
          const notification =
            sourceFrameId !== null
              ? chrome.tabs.sendMessage(sourceTabId, payload, {
                  frameId: sourceFrameId,
                })
              : chrome.tabs.sendMessage(sourceTabId, payload);
          Promise.resolve(notification).catch(() => {});
        } catch (_) {}
      }
      sendResponse(result);
    };
    _waitForGeminiDownload(
      message.requestId,
      message.timeoutMs,
      message.creationTimeoutMs,
      message.rejectHtmlResponse === true,
      message.sourceProvider,
    )
      .then(complete)
      .catch((error) => {
        complete({
          success: false,
          error: error?.message || "DOWNLOAD_WAIT_FAILED",
        });
      });
    return true;
  }
  if (message.action === "cancelDownloadRename") {
    const before = _pendingDownloadRenames.length;
    _pendingDownloadRenames = _pendingDownloadRenames.filter((entry) => {
      if (message.requestId) return entry.requestId !== message.requestId;
      return !(
        entry.sourceProvider === message.sourceProvider &&
        entry.identifier === message.identifier &&
        (!Number.isInteger(message.tabId) || entry.tabId === message.tabId)
      );
    });
    if (_pendingDownloadRenames.length !== before) _persistPendingRenames();
    sendResponse({
      ok: true,
      removed: before - _pendingDownloadRenames.length,
    });
    return true;
  }
  if (message.action === "cancelPreparedDownload") {
    (async () => {
      const requestId = String(message.requestId || "");
      if (!requestId) return { success: false, error: "REQUEST_ID_REQUIRED" };
      const job = _geminiDownloadJobs.get(requestId);
      _setGeminiDownloadJob(requestId, { error: "DOWNLOAD_STOPPED" });
      setTimeout(
        () => {
          if (_geminiDownloadJobs.get(requestId)?.error === "DOWNLOAD_STOPPED")
            _geminiDownloadJobs.delete(requestId);
        },
        10 * 60 * 1e3,
      );
      const before = _pendingDownloadRenames.length;
      _pendingDownloadRenames = _pendingDownloadRenames.filter(
        (entry) => entry.requestId !== requestId,
      );
      if (before !== _pendingDownloadRenames.length) _persistPendingRenames();
      if (Number.isInteger(job?.downloadId)) {
        const item = (
          await chrome.downloads.search({ id: job.downloadId })
        )?.[0];
        if (item?.state === "in_progress")
          await chrome.downloads.cancel(job.downloadId);
      }
      return { success: true };
    })()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || "DOWNLOAD_CANCEL_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "flowApiUpscaleForDownload") {
    (async () => {
      try {
        const result = await _flowApiUpscaleForDownload(message.payload || {});
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || "FLOW_API_DOWNLOAD_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "flowApiResolveMediaForDownload") {
    (async () => {
      try {
        sendResponse(
          await _flowApiResolveMediaForDownload(message.payload || {}),
        );
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || "FLOW_API_MEDIA_RESOLVE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "flowApiDownloadPreflight") {
    (async () => {
      try {
        sendResponse(await _flowApiDownloadPreflight(message.payload || {}));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error?.message || "FLOW_API_PREFLIGHT_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "chromeDownload") {
    const { url, filename, waitForComplete } = message;
    const isSafeMediaDataUrl =
      typeof url === "string" &&
      /^data:(?:image\/(?:png|jpeg|webp)|video\/mp4);base64,/i.test(url);
    if (
      !url ||
      url.includes("media.html") ||
      url.endsWith(".html") ||
      (!url.startsWith("http://") &&
        !url.startsWith("https://") &&
        !url.startsWith("blob:") &&
        !isSafeMediaDataUrl)
    ) {
      console.warn(
        `[TobyFlow] chromeDownload: invalid/placeholder URL rejected: ${url?.substring(0, 80)}`,
      );
      sendResponse({
        success: false,
        error: "Invalid or placeholder URL rejected",
      });
      return true;
    }
    console.log(
      `[TobyFlow] chromeDownload: filename="${filename}", url="${_safeUrlForLog(url)}", waitForComplete=${!!waitForComplete}`,
    );
    (async () => {
      try {
        if (
          message.requestId &&
          _geminiDownloadJobs.get(message.requestId)?.error ===
            "DOWNLOAD_STOPPED"
        ) {
          sendResponse({ success: false, error: "DOWNLOAD_STOPPED" });
          return;
        }
        if (message.avoidFilenameListenerConflict !== true) {
          _queueDownloadRename(filename, url, message.requestId || null);
          if (filename?.includes("/"))
            console.log(
              `[TobyFlow] chromeDownload: queued rename "${filename}"`,
            );
        } else {
          console.log(
            "[TobyFlow] chromeDownload: filename listener bypassed for conflict-safe Flow fallback",
          );
        }
        const downloadId = await chrome.downloads.download({
          url,
          filename: filename || void 0,
          conflictAction: "uniquify",
        });
        if (message.requestId) {
          const cancelled =
            _geminiDownloadJobs.get(message.requestId)?.error ===
            "DOWNLOAD_STOPPED";
          _setGeminiDownloadJob(message.requestId, { downloadId });
          if (cancelled)
            await chrome.downloads.cancel(downloadId).catch(() => {});
        }
        if (!waitForComplete) {
          if (message.requestId) _geminiDownloadJobs.delete(message.requestId);
          sendResponse({ success: true, downloadId });
          return;
        }
        const timeout = Math.max(
          3e4,
          Math.min(10 * 60 * 1e3, Number(message.waitTimeoutMs) || 3e4),
        );
        const result = await _waitForChromeDownload(
          downloadId,
          timeout,
          message.flowApiDownloadRetry === true,
          message.rejectHtmlResponse === true,
        );
        if (message.requestId) _geminiDownloadJobs.delete(message.requestId);
        console.log(
          `[TobyFlow] chromeDownload complete: id=${downloadId}, state=${result.state}`,
        );
        sendResponse(result);
      } catch (err) {
        console.warn("[TobyFlow] chrome.downloads failed:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "apiRequest") {
    // 566Flow: no remote service. Answer every API call locally.
    LocalBackend.dispatch(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({
          success: false,
          error: { code: "LOCAL_BACKEND_ERROR", message: err?.message || String(err) },
          httpStatus: 500,
        }),
      );
    return true;
  }
  if (message.action === "captureScreen") {
    (async () => {
      try {
        const now = Date.now();
        if (
          globalThis._lastCaptureTime &&
          now - globalThis._lastCaptureTime < 600
        ) {
          const waitMs = 600 - (now - globalThis._lastCaptureTime);
          console.log(
            `[TobyFlow] captureScreen rate limited, waiting ${waitMs}ms...`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
        globalThis._lastCaptureTime = Date.now();
        const flowTabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (flowTabs.length === 0) {
          sendResponse({
            success: false,
            error:
              "Ch\u01B0a m\u1EDF Google Flow. C\u1EA7n m\u1EDF flow.google.com/project/ \u0111\u1EC3 upload \u1EA3nh ch\u1EE5p.",
            action: "openFlow",
          });
          return;
        }
        const focusedWindow = await chrome.windows.getLastFocused({
          populate: true,
        });
        if (!focusedWindow || !focusedWindow.tabs) {
          sendResponse({
            success: false,
            error:
              "Kh\xF4ng t\xECm th\u1EA5y c\u1EEDa s\u1ED5 \u0111ang active",
          });
          return;
        }
        const activeTab = focusedWindow.tabs.find((t) => t.active);
        if (!activeTab) {
          sendResponse({
            success: false,
            error: "Kh\xF4ng t\xECm th\u1EA5y tab \u0111ang active",
          });
          return;
        }
        console.log(
          `[TobyFlow] captureScreen: url=${activeTab.url?.substring(0, 50)}, windowId=${focusedWindow.id}`,
        );
        const attemptCapture = async () => {
          await chrome.windows.update(focusedWindow.id, { focused: true });
          await new Promise((r) => setTimeout(r, 150));
          globalThis._lastCaptureTime = Date.now();
          return await chrome.tabs.captureVisibleTab(focusedWindow.id, {
            format: "png",
          });
        };
        try {
          const dataUrl = await attemptCapture();
          sendResponse({ success: true, dataUrl, tabId: activeTab.id });
          return;
        } catch (e) {
          console.warn("[TobyFlow] First capture attempt failed:", e.message);
          if (/quota/i.test(e?.message)) {
            console.log("[TobyFlow] Rate limit, waiting 1s...");
            await new Promise((r) => setTimeout(r, 1e3));
            globalThis._lastCaptureTime = Date.now();
            try {
              const dataUrl = await attemptCapture();
              sendResponse({ success: true, dataUrl, tabId: activeTab.id });
              return;
            } catch (e2) {
              console.warn(
                "[TobyFlow] Retry after rate limit failed:",
                e2.message,
              );
            }
          }
          if (/permission/i.test(e?.message)) {
            const hasAllUrls = await chrome.permissions.contains({
              origins: ["<all_urls>"],
            });
            console.log(
              "[TobyFlow] Permission denied, hasAllUrls:",
              hasAllUrls,
            );
            if (!hasAllUrls) {
              sendResponse({
                success: false,
                error:
                  "C\u1EA7n c\u1EA5p quy\u1EC1n \u0111\u1EC3 ch\u1EE5p m\xE0n h\xECnh t\u1EEB trang n\xE0y.",
                action: "requestCapturePermission",
              });
              return;
            }
            sendResponse({
              success: false,
              error:
                "Kh\xF4ng th\u1EC3 ch\u1EE5p trang n\xE0y (trang h\u1EC7 th\u1ED1ng ho\u1EB7c trang \u0111\u1EB7c bi\u1EC7t).",
            });
            return;
          }
          sendResponse({
            success: false,
            error:
              "L\u1ED7i ch\u1EE5p m\xE0n h\xECnh: " +
              (e?.message || "Unknown error"),
          });
        }
      } catch (err) {
        console.error("[TobyFlow] captureScreen error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "requestCapturePermission") {
    (async () => {
      try {
        const hasPermission = await chrome.permissions.contains({
          origins: ["<all_urls>"],
        });
        if (hasPermission) {
          sendResponse({ success: true, granted: true, alreadyHad: true });
          return;
        }
        const granted = await chrome.permissions.request({
          origins: ["<all_urls>"],
        });
        console.log("[TobyFlow] Capture permission request result:", granted);
        sendResponse({ success: true, granted });
      } catch (err) {
        console.error(
          "[TobyFlow] requestCapturePermission error:",
          err.message,
        );
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "openFlowTab") {
    (async () => {
      try {
        const tab = await openOrActivateTab(
          getFlowTabQueryPatterns(),
          getProviderUrl("flow", "createUrl"),
        );
        sendResponse({ success: true, tabId: tab.id });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "openOrActivateTab") {
    (async () => {
      try {
        const { urlPattern, createUrl, activate = true } = message;
        if (!urlPattern || !createUrl) {
          sendResponse({
            success: false,
            error: "Missing urlPattern or createUrl",
          });
          return;
        }
        const tab = await openOrActivateTab(urlPattern, createUrl, activate);
        sendResponse({ success: true, tabId: tab.id, url: tab.url });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "startCropOnActiveTab") {
    (async () => {
      try {
        const flowTabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (flowTabs.length === 0) {
          sendResponse({
            success: false,
            error:
              "Ch\u01B0a m\u1EDF Google Flow. C\u1EA7n m\u1EDF flow.google.com/project/ \u0111\u1EC3 upload \u1EA3nh ch\u1EE5p.",
            action: "openFlow",
          });
          return;
        }
        const [activeTab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (!activeTab || !activeTab.id) {
          sendResponse({
            success: false,
            error: "Kh\xF4ng t\xECm th\u1EA5y tab \u0111ang active",
          });
          return;
        }
        if (
          activeTab.url?.startsWith("chrome://") ||
          activeTab.url?.startsWith("edge://") ||
          activeTab.url?.startsWith("about:")
        ) {
          sendResponse({
            success: false,
            error:
              "Kh\xF4ng th\u1EC3 ch\u1EE5p trang h\u1EC7 th\u1ED1ng (chrome://, edge://)",
          });
          return;
        }
        const storage = await chrome.storage.local.get(["af_locale"]);
        const locale = storage.af_locale || "vi";
        const captureI18n = {
          vi: {
            captureBtn: "Ch\u1EE5p",
            cancelBtn: "H\u1EE7y",
            namePlaceholder: "T\xEAn \u1EA3nh (cho @mention)",
            areaTooSmall: "V\xF9ng ch\u1ECDn qu\xE1 nh\u1ECF",
          },
          en: {
            captureBtn: "Capture",
            cancelBtn: "Cancel",
            namePlaceholder: "Image name (for @mention)",
            areaTooSmall: "Selection area too small",
          },
          th: {
            captureBtn: "\u0E08\u0E31\u0E1A\u0E20\u0E32\u0E1E",
            cancelBtn: "\u0E22\u0E01\u0E40\u0E25\u0E34\u0E01",
            namePlaceholder:
              "\u0E0A\u0E37\u0E48\u0E2D\u0E20\u0E32\u0E1E (\u0E2A\u0E33\u0E2B\u0E23\u0E31\u0E1A @mention)",
            areaTooSmall:
              "\u0E1E\u0E37\u0E49\u0E19\u0E17\u0E35\u0E48\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E40\u0E25\u0E47\u0E01\u0E40\u0E01\u0E34\u0E19\u0E44\u0E1B",
          },
          ja: {
            captureBtn: "\u30AD\u30E3\u30D7\u30C1\u30E3",
            cancelBtn: "\u30AD\u30E3\u30F3\u30BB\u30EB",
            namePlaceholder: "\u753B\u50CF\u540D\uFF08@mention\u7528\uFF09",
            areaTooSmall:
              "\u9078\u629E\u7BC4\u56F2\u304C\u5C0F\u3055\u3059\u304E\u307E\u3059",
          },
        };
        const t = captureI18n[locale] || captureI18n.vi;
        const results = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          args: [t],
          func: (translations) => {
            return new Promise((resolve) => {
              const existing = document.getElementById("tobyflow-crop-overlay");
              if (existing) existing.remove();
              const defaultName = "capture_" + Date.now().toString(36);
              const overlay = document.createElement("div");
              overlay.id = "tobyflow-crop-overlay";
              overlay.innerHTML = `
                <div class="tobyflow-crop-selection" id="tobyflow-crop-selection">
                  <div class="tobyflow-crop-controls" id="tobyflow-crop-controls">
                    <div class="tobyflow-crop-name-row">
                      <input type="text" id="tobyflow-crop-name-input" class="tobyflow-crop-name-input"
                        placeholder="${translations.namePlaceholder}" value="${defaultName}" maxlength="50"
                        autocomplete="off" spellcheck="false">
                    </div>
                    <div class="tobyflow-crop-btn-row">
                      <button class="tobyflow-crop-btn tobyflow-crop-btn-capture" id="tobyflow-crop-capture-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
                          <circle cx="12" cy="13" r="4"></circle>
                        </svg>
                        ${translations.captureBtn}
                      </button>
                      <button class="tobyflow-crop-btn tobyflow-crop-btn-cancel" id="tobyflow-crop-cancel-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                        ${translations.cancelBtn}
                      </button>
                    </div>
                  </div>
                </div>
              `;
              const style = document.createElement("style");
              style.id = "tobyflow-crop-styles-injected";
              style.textContent = `
                #tobyflow-crop-overlay {
                  position: fixed;
                  inset: 0;
                  background: rgba(0,0,0,0.5);
                  z-index: 2147483647;
                  cursor: crosshair;
                }
                #tobyflow-crop-overlay .tobyflow-crop-selection {
                  position: absolute;
                  border: 2px dashed #fff;
                  background: transparent;
                  display: none;
                  box-shadow: 0 0 0 9999px rgba(0,0,0,0.5);
                }
                #tobyflow-crop-overlay .tobyflow-crop-controls {
                  position: absolute;
                  bottom: -90px;
                  left: 50%;
                  transform: translateX(-50%);
                  display: none;
                  flex-direction: column;
                  gap: 8px;
                  z-index: 2147483647;
                  white-space: nowrap;
                }
                #tobyflow-crop-overlay .tobyflow-crop-controls.visible {
                  display: flex;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-row {
                  display: flex;
                  justify-content: center;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-input {
                  width: 220px;
                  padding: 8px 12px;
                  border: 1px solid rgba(255,255,255,0.3);
                  border-radius: 6px;
                  background: rgba(30,30,35,0.95);
                  color: #fff;
                  font-size: 13px;
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                  outline: none;
                  text-align: center;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-input:focus {
                  border-color: #cdff01;
                }
                #tobyflow-crop-overlay .tobyflow-crop-name-input::placeholder {
                  color: rgba(255,255,255,0.5);
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-row {
                  display: flex;
                  gap: 8px;
                  justify-content: center;
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn {
                  display: flex;
                  align-items: center;
                  gap: 6px;
                  padding: 10px 20px;
                  border: none;
                  border-radius: 8px;
                  font-size: 14px;
                  font-weight: 500;
                  cursor: pointer;
                  transition: all 0.15s ease;
                  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
                  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn svg { flex-shrink: 0; }
                #tobyflow-crop-overlay .tobyflow-crop-btn-capture {
                  background: #cdff01;
                  color: #1c1c1f;
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-capture:hover {
                  background: #d4ff33;
                  transform: scale(1.02);
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-cancel {
                  background: rgba(40,40,45,0.95);
                  color: #fff;
                  border: 1px solid rgba(255,255,255,0.15);
                }
                #tobyflow-crop-overlay .tobyflow-crop-btn-cancel:hover {
                  background: rgba(60,60,65,0.95);
                }
              `;
              document.head.appendChild(style);
              document.body.appendChild(overlay);
              let startX = 0,
                startY = 0;
              let isDrawing = false;
              const selection = document.getElementById(
                "tobyflow-crop-selection",
              );
              const controls = document.getElementById(
                "tobyflow-crop-controls",
              );
              overlay.addEventListener("mousedown", (e) => {
                if (e.target.closest(".tobyflow-crop-controls")) return;
                isDrawing = true;
                controls.classList.remove("visible");
                startX = e.clientX;
                startY = e.clientY;
                selection.style.left = startX + "px";
                selection.style.top = startY + "px";
                selection.style.width = "0px";
                selection.style.height = "0px";
                selection.style.display = "block";
              });
              overlay.addEventListener("mousemove", (e) => {
                if (!isDrawing) return;
                const w = e.clientX - startX;
                const h = e.clientY - startY;
                if (w < 0) {
                  selection.style.left = e.clientX + "px";
                  selection.style.width = -w + "px";
                } else {
                  selection.style.left = startX + "px";
                  selection.style.width = w + "px";
                }
                if (h < 0) {
                  selection.style.top = e.clientY + "px";
                  selection.style.height = -h + "px";
                } else {
                  selection.style.top = startY + "px";
                  selection.style.height = h + "px";
                }
              });
              overlay.addEventListener("mouseup", () => {
                if (!isDrawing) return;
                isDrawing = false;
                const rect = selection.getBoundingClientRect();
                if (rect.width >= 20 && rect.height >= 20) {
                  controls.classList.add("visible");
                }
              });
              document
                .getElementById("tobyflow-crop-capture-btn")
                .addEventListener("click", () => {
                  const rect = selection.getBoundingClientRect();
                  const cropRect = {
                    x: Math.round(rect.left * window.devicePixelRatio),
                    y: Math.round(rect.top * window.devicePixelRatio),
                    width: Math.round(rect.width * window.devicePixelRatio),
                    height: Math.round(rect.height * window.devicePixelRatio),
                  };
                  const nameInput = document.getElementById(
                    "tobyflow-crop-name-input",
                  );
                  let captureName = (nameInput?.value || "").trim();
                  captureName = captureName
                    .replace(/[^a-zA-Z0-9_]/g, "_")
                    .slice(0, 50);
                  if (!captureName) {
                    captureName = "capture_" + Date.now().toString(36);
                  }
                  overlay.remove();
                  document
                    .getElementById("tobyflow-crop-styles-injected")
                    ?.remove();
                  if (cropRect.width < 20 || cropRect.height < 20) {
                    resolve({
                      success: false,
                      error: translations.areaTooSmall,
                    });
                  } else {
                    resolve({ success: true, cropRect, captureName });
                  }
                });
              document
                .getElementById("tobyflow-crop-cancel-btn")
                .addEventListener("click", () => {
                  overlay.remove();
                  document
                    .getElementById("tobyflow-crop-styles-injected")
                    ?.remove();
                  resolve({ success: false, cancelled: true });
                });
              const escHandler = (e) => {
                if (e.key === "Escape") {
                  overlay.remove();
                  document
                    .getElementById("tobyflow-crop-styles-injected")
                    ?.remove();
                  document.removeEventListener("keydown", escHandler);
                  resolve({ success: false, cancelled: true });
                }
              };
              document.addEventListener("keydown", escHandler);
            });
          },
        });
        const result = results?.[0]?.result;
        if (result) {
          sendResponse({ ...result, tabId: activeTab.id });
        } else {
          sendResponse({
            success: false,
            error: "Kh\xF4ng th\u1EC3 inject overlay v\xE0o trang n\xE0y",
          });
        }
      } catch (err) {
        console.error("[TobyFlow] startCropOnActiveTab error:", err.message);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "navigateToProject") {
    const url = message.url;
    (async () => {
      try {
        if (!isFlowUrl(url)) {
          sendResponse({ success: false, error: "UNSUPPORTED_FLOW_ORIGIN" });
          return;
        }
        let tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
        if (message.preserveOtherProjects === true && message.projectId) {
          tabs = tabs.filter(
            (tab) => describeFlowTab(tab)?.projectId === message.projectId,
          );
        }
        let target;
        if (tabs.length > 0) {
          const selected = message.targetTabId
            ? tabs.find(
                (tab) =>
                  tab.id === message.targetTabId && isFlowOriginUrl(tab.url),
              )
            : tabs.find((tab) => tab.active && isFlowOriginUrl(tab.url)) ||
              selectFlowTab(tabs);
          if (!selected) {
            sendResponse({
              success: false,
              error: "FLOW_EXECUTION_TARGET_CHANGED",
            });
            return;
          }
          const selectedContext = describeFlowTab(selected);
          const shouldOpenFromHomepage =
            !!message.projectId && !selectedContext?.projectId;
          if (
            message.projectId &&
            selectedContext?.projectId === message.projectId &&
            selectedContext.isProjectEditor === true
          ) {
            target = await chrome.tabs.update(selected.id, { active: true });
          } else if (shouldOpenFromHomepage) {
            const homepageUrl = new URL(url).origin + "/";
            target = selectedContext
              ? await chrome.tabs.update(selected.id, { active: true })
              : await chrome.tabs.update(selected.id, {
                  url: homepageUrl,
                  active: true,
                });
          } else {
            target = await chrome.tabs.update(selected.id, {
              url: scopeFlowProjectUrlForTab(url, selected),
              active: true,
            });
          }
          await chrome.windows.update(selected.windowId, { focused: true });
          if (shouldOpenFromHomepage) {
            const opened = await openFlowProjectFromHomepage(
              selected.id,
              message.projectId,
            );
            if (!opened?.success) {
              sendResponse({
                success: false,
                error: opened?.error || "FLOW_PROJECT_CARD_NOT_FOUND",
                tabId: selected.id,
              });
              return;
            }
            target =
              opened.tab ||
              (await chrome.tabs.get(selected.id).catch(() => target));
          }
        } else {
          if (message.targetTabId) {
            sendResponse({
              success: false,
              error: "FLOW_EXECUTION_TARGET_CHANGED",
            });
            return;
          }
          if (message.projectId) {
            const homepageUrl = new URL(url).origin + "/";
            target = await chrome.tabs.create({ url: homepageUrl });
            const opened = await openFlowProjectFromHomepage(
              target.id,
              message.projectId,
            );
            if (!opened?.success) {
              sendResponse({
                success: false,
                error: opened?.error || "FLOW_PROJECT_CARD_NOT_FOUND",
                tabId: target.id,
              });
              return;
            }
            target =
              opened.tab ||
              (await chrome.tabs.get(target.id).catch(() => target));
          } else {
            target = await chrome.tabs.create({ url });
          }
        }
        sendResponse({ success: true, tabId: target.id });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "clickCreateNewProject") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (tabs.length === 0) {
          sendResponse({
            success: false,
            error: "Kh\xF4ng t\xECm th\u1EA5y tab Flow",
          });
          return;
        }
        const target = message.targetTabId
          ? tabs.find((t) => t.id === message.targetTabId && isFlowUrl(t.url))
          : tabs.find((t) => isFlowHomepageTab(t) && t.active) ||
            tabs.find((t) => isFlowHomepageTab(t));
        if (!target) {
          sendResponse({ success: false, error: "FLOW_HOMEPAGE_REQUIRED" });
          return;
        }
        for (let i = 0; i < 40; i++) {
          let st;
          try {
            st = (await chrome.tabs.get(target.id))?.status;
          } catch (_) {
            break;
          }
          if (st === "complete") break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const storage = await new Promise((r) =>
          _readOperationalSnapshot(["toby_provider_configs"], r),
        );
        const profile =
          storage?.toby_provider_configs?.data?.flow?.profiles?.v2;
        const flowSel = profile?.host_patterns?.includes(
          "https://flow.google.com",
        )
          ? profile.selectors
          : null;
        const npCfg = flowSel?.new_project_button;
        if (
          !npCfg?.selectors?.length ||
          !flowSel?.icon_element?.selectors?.length
        ) {
          sendResponse({
            success: false,
            error: "CONFIG_REQUIRED:new_project_button",
          });
          return;
        }
        const _cfgList = (v) =>
          (!v ? [] : Array.isArray(v) ? v : String(v).split("|"))
            .map((x) => String(x).trim())
            .filter(Boolean);
        const iconText = _cfgList(npCfg.icon_text);
        const textMatch = _cfgList(npCfg.text_match);
        const btnSelectors = npCfg.selectors.join(", ");
        const iconSelectorJoined = flowSel.icon_element.selectors.join(", ");
        if (!iconText.length && !textMatch.length) {
          sendResponse({
            success: false,
            error: "CONFIG_REQUIRED:new_project_button",
          });
          return;
        }
        const live = await chrome.tabs.get(target.id);
        if (!isFlowUrl(live.url) || describeFlowTab(live)?.projectId) {
          sendResponse({ success: false, error: "FLOW_HOMEPAGE_REQUIRED" });
          return;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId: target.id },
          args: [iconSelectorJoined, iconText, textMatch, btnSelectors],
          func: (ICON_SELECTOR, ICON_TEXT, TEXT_MATCH, BTN_SEL) => {
            return new Promise((resolve) => {
              const maxWait = 12e3;
              const interval = 500;
              let elapsed = 0;
              function robustClick(el) {
                el.click();
              }
              function tryClick() {
                const parts = location.pathname.split("/").filter(Boolean);
                const isPrefix = parts.every(
                  (part, index) =>
                    (/^[a-z]{2,3}(?:-[a-z]{2,4})?$/i.test(part) &&
                      part !== "u") ||
                    (part === "u" && /^\d+$/.test(parts[index + 1] || "")) ||
                    (index > 0 &&
                      parts[index - 1] === "u" &&
                      /^\d+$/.test(part)),
                );
                if (
                  location.origin !== "https://flow.google.com" ||
                  !isPrefix
                ) {
                  resolve({ clicked: false, error: "FLOW_HOMEPAGE_REQUIRED" });
                  return;
                }
                const candidates = Array.from(
                  document.querySelectorAll(BTN_SEL),
                ).filter(
                  (el) =>
                    !el.disabled &&
                    el.getAttribute("aria-disabled") !== "true" &&
                    el.getBoundingClientRect().width > 0 &&
                    el.getBoundingClientRect().height > 0,
                );
                for (const el of candidates) {
                  const icons = el.querySelectorAll(ICON_SELECTOR);
                  for (const icon of icons) {
                    if (ICON_TEXT.includes((icon.textContent || "").trim())) {
                      robustClick(el);
                      resolve({ clicked: true, method: "icon" });
                      return;
                    }
                  }
                }
                for (const el of candidates) {
                  const text = (el.textContent || "").trim();
                  if (TEXT_MATCH.some((m) => text.includes(m))) {
                    robustClick(el);
                    resolve({ clicked: true, method: "text" });
                    return;
                  }
                }
                elapsed += interval;
                if (elapsed >= maxWait)
                  resolve({ clicked: false, error: "timeout" });
                else setTimeout(tryClick, interval);
              }
              tryClick();
            });
          },
        });
        const result = results?.[0]?.result;
        sendResponse({ success: !!result?.clicked, result });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (message.action === "getFlowProjectContext") {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({
          url: getFlowTabQueryPatterns(),
        });
        if (tabs.length > 0) {
          const activeTab = message.targetTabId
            ? await selectFlowStatusTab(tabs, message.targetTabId)
            : await selectFlowStatusTab(tabs);
          if (!activeTab) {
            sendResponse({ projectId: null, tabId: null });
            return;
          }
          let replied = false;
          const reply = (response) => {
            if (replied) return;
            replied = true;
            clearTimeout(timer);
            sendResponse(buildFlowProjectContext(activeTab, response));
          };
          const timer = setTimeout(() => {
            console.warn(
              "[Background] getFlowProjectContext content reply timed out; using project URL",
            );
            reply(null);
          }, 4e3);
          try {
            chrome.tabs.sendMessage(
              activeTab.id,
              { action: "getProjectContext" },
              (resp) => {
                reply(chrome.runtime.lastError ? null : resp);
              },
            );
          } catch (_) {
            reply(null);
          }
        } else {
          sendResponse({ projectId: null, tabId: null });
        }
      } catch (e) {
        sendResponse({ projectId: null, tabId: null });
      }
    })();
    return true;
  }
  if (message.action === "motion:webCaptureControl") {
    (async () => {
      const target = sender?.tab?.id
        ? describeFlowTab(await chrome.tabs.get(sender.tab.id))
        : null;
      const auth = (await chrome.storage.local.get("af_auth")).af_auth;
      return MotionWebCapture.control(
        message.captureId,
        message,
        sender,
        target,
        auth,
      );
    })()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({ success: false, error: error?.message }),
      );
    return true;
  }
  if (message.action === "workflow:videoCapture") {
    (async () => {
      const auth = (await chrome.storage.local.get("af_auth")).af_auth;
      if (
        !auth?.token ||
        Number(auth.user?.id) !== message.userId ||
        sender?.id !== chrome.runtime.id ||
        !["workflow-editor.html", "sidebar.html", "run-window.html"].some(
          (page) =>
            sender?.url?.split(/[?#]/)[0] === chrome.runtime.getURL(page),
        ) ||
        ["workflowId", "nodeId", "operationId"].some(
          (key) =>
            typeof message[key] !== "string" ||
            !message[key] ||
            message[key].length > 150,
        )
      )
        throw new Error("WORKFLOW_VIDEO_CAPTURE_SCOPE");
      if (message.prepare) {
        const target = describeFlowTab(
          await chrome.tabs.get(message.target?.tabId),
        );
        if (!sameFlowTarget(target, message.target))
          throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
        return {
          success: true,
          ...(await MotionWebCapture.prepareWorkflow(message, target, sender)),
        };
      }
      const entry = await MotionWebCapture.getWorkflow(
        message.captureId,
        message,
        sender,
      );
      if (message.release) {
        await MotionWebCapture.release(entry.id);
        return { success: true };
      }
      const blob = await MotionWebCapture.read(entry);
      const current = (await chrome.storage.local.get("af_auth")).af_auth;
      if (!current?.token || Number(current.user?.id) !== message.userId)
        throw new Error("WORKFLOW_VIDEO_OWNER_CHANGED");
      const fileId = `merge_temp_${entry.mergeOperationId}_${entry.id}`;
      await WorkflowResultMediaStore.put(
        message.workflowId,
        message.nodeId,
        fileId,
        blob,
        "",
        message.userId,
      );
      return { success: true, fileId, size: blob.size };
    })()
      .then(sendResponse)
      .catch((error) =>
        sendResponse({
          success: false,
          error: error?.message || "WORKFLOW_VIDEO_CAPTURE_FAILED",
        }),
      );
    return true;
  }
  if (message.action === "motion:storeFlowVideo") {
    (async () => {
      const url = String(message.url || "");
      if (
        !Number.isSafeInteger(Number(message.artifactRevision)) ||
        Number(message.artifactRevision) < 1
      ) {
        sendResponse({
          success: false,
          error: "MOTION_ARTIFACT_REVISION_REQUIRED",
        });
        return;
      }
      if (
        !message.webCapture &&
        (!url.startsWith("https://") || !_isAllowedUrl(url))
      ) {
        sendResponse({ success: false, error: "MOTION_VIDEO_URL_INVALID" });
        return;
      }
      const auth = (await chrome.storage.local.get("af_auth")).af_auth;
      if (Number(auth?.user?.id) !== Number(message.userId) || !auth?.token) {
        sendResponse({ success: false, error: "MOTION_OWNER_CHANGED" });
        return;
      }
      try {
        const verifyStageOwner = async (beforeStart = false) => {
          if (!message.stagingOperationId) return;
          const host = (
            await chrome.storage.session.get(MotionRunnerHostRegistry.KEY)
          )?.[MotionRunnerHostRegistry.KEY];
          const owner = message.stagingOwner;
          if (
            sender?.id !== chrome.runtime.id ||
            sender?.url !==
              (host?.url || chrome.runtime.getURL("motion-runner.html")) ||
            sender?.tab?.id !== host?.tabId ||
            sender?.tab?.windowId !== host?.windowId ||
            Number(host?.userId) !== Number(message.userId) ||
            !owner ||
            Number(owner.userId) !== Number(message.userId) ||
            owner.toolProjectId !== message.toolProjectId
          )
            throw new Error("MOTION_RUNNER_OWNER_MISMATCH");
          const run = await MotionRunJournal.get(owner);
          MotionRunJournal._owned(run, owner);
          if (
            run.flowProjectId !== message.flowProjectId ||
            run.sourceRevision !== Number(message.sourceRevision)
          )
            throw new Error("MOTION_RUN_FENCED");
          const operation = run.operations?.[message.stagingOperationId];
          if (
            !operation ||
            !["persist", "flow"].includes(operation.stage) ||
            operation.frameId !== message.frameId ||
            operation.inputRevision !== Number(message.artifactRevision) ||
            (operation.stage === "flow" && operation.persistStarted !== true)
          )
            throw new Error("MOTION_RUN_FENCED");
          if (beforeStart && run.state !== "running") {
            if (
              !["pausing", "stopping", "needs_review"].includes(run.state) ||
              !["flow", "persist"].includes(operation?.stage) ||
              operation.persistStarted !== true
            )
              throw new Error("MOTION_CANCELLED");
          }
        };
        await verifyStageOwner(true);
        if (message.webCapture?.prepare) {
          const target = describeFlowTab(
            await chrome.tabs.get(message.webCapture.target?.tabId),
          );
          if (!sameFlowTarget(target, message.webCapture.target))
            throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
          const capture2 = await MotionWebCapture.prepare(
            message,
            target,
            sender,
          );
          sendResponse({ success: true, ...capture2 });
          return;
        }
        if (message.webCapture?.release) {
          await MotionWebCapture.get(message.webCapture.id, message, sender);
          await MotionWebCapture.release(message.webCapture.id);
          sendResponse({ success: true });
          return;
        }
        const capture = message.webCapture?.id
          ? await MotionWebCapture.get(message.webCapture.id, message, sender)
          : null;
        const blob = capture
          ? await MotionWebCapture.read(capture)
          : await FlowApiDownloadRetry.execute(
              async () => {
                const attemptAuth = (await chrome.storage.local.get("af_auth"))
                  .af_auth;
                if (
                  Number(attemptAuth?.user?.id) !== Number(message.userId) ||
                  !attemptAuth?.token
                ) {
                  throw Object.assign(new Error("MOTION_OWNER_CHANGED"), {
                    noRetry: true,
                  });
                }
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 18e4);
                try {
                  let response = await fetch(url, {
                    credentials: "omit",
                    signal: controller.signal,
                  });
                  if (
                    response.status === 401 &&
                    /^https:\/\/flow\.google\.com\/asb\//i.test(url)
                  ) {
                    response = await fetch(url, {
                      credentials: "include",
                      signal: controller.signal,
                    });
                    if (!_isAllowedFlowAsbRedirectUrl(response.url || url))
                      throw new Error("MOTION_VIDEO_REDIRECT_INVALID");
                  }
                  if (!_isAllowedUrl(response.url || url))
                    throw new Error("MOTION_VIDEO_REDIRECT_INVALID");
                  if (!response.ok)
                    throw new Error(`MOTION_VIDEO_HTTP_${response.status}`);
                  const limit = 200 * 1024 * 1024;
                  if (Number(response.headers.get("content-length")) > limit)
                    throw new Error("MOTION_VIDEO_TOO_LARGE");
                  const reader = response.body?.getReader();
                  if (!reader) throw new Error("MOTION_VIDEO_BODY_MISSING");
                  const chunks = [];
                  let total = 0;
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > limit) {
                      await reader.cancel();
                      throw new Error("MOTION_VIDEO_TOO_LARGE");
                    }
                    chunks.push(value);
                  }
                  const prefix = new Uint8Array(12);
                  let copied = 0;
                  for (const chunk of chunks) {
                    const size = Math.min(
                      chunk.byteLength,
                      prefix.length - copied,
                    );
                    prefix.set(chunk.subarray(0, size), copied);
                    copied += size;
                    if (copied === prefix.length) break;
                  }
                  if (
                    total < 12 ||
                    String.fromCharCode(...prefix.subarray(4, 8)) !== "ftyp"
                  ) {
                    throw new Error("MOTION_VIDEO_BYTES_INVALID");
                  }
                  return new Blob(chunks, { type: "video/mp4" });
                } catch (error) {
                  if (controller.signal.aborted)
                    throw new Error("MOTION_VIDEO_FETCH_TIMEOUT");
                  throw error;
                } finally {
                  clearTimeout(timeout);
                }
              },
              { action: "motion_video_fetch", driver: "motion" },
            );
        const currentAuth = (await chrome.storage.local.get("af_auth")).af_auth;
        if (
          Number(currentAuth?.user?.id) !== Number(message.userId) ||
          !currentAuth?.token
        ) {
          throw new Error("MOTION_OWNER_CHANGED");
        }
        await verifyStageOwner();
        const artifact = {
          userId: Number(message.userId),
          toolProjectId: message.toolProjectId,
          flowProjectId: message.flowProjectId,
          sourceRevision: Number(message.sourceRevision),
          frameId: message.frameId,
          artifactRevision: Number(message.artifactRevision),
          resolution: message.resolution,
          blob,
          media_uuid: message.media_uuid || null,
          persistent_media_id: message.persistent_media_id || null,
        };
        const saved = message.stagingOperationId
          ? (await MotionArtifactStore.stageGenerated({
              ...artifact,
              operationId: message.stagingOperationId,
            }),
            {
              size: blob.size,
              mime: blob.type,
              resolution: message.resolution,
            })
          : await MotionArtifactStore.put({
              ...artifact,
              kind: "generated_clip",
            });
        if (capture)
          await MotionWebCapture.release(capture.id).catch((error) =>
            console.warn("[MotionWebCaptureCleanup]", { code: error?.message }),
          );
        sendResponse({
          success: true,
          size: saved.size,
          mime: saved.mime,
          resolution: saved.resolution,
          key: saved.key,
        });
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "MOTION_VIDEO_STORE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "fetchBlob") {
    if (!_isAllowedUrl(message.url)) {
      sendResponse({ success: false, error: "URL not allowed" });
      return true;
    }
    (async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 2e4);
      try {
        let resp = await fetch(message.url, {
          credentials: "omit",
          signal: ctrl.signal,
        });
        if (
          resp.status === 401 &&
          /^https:\/\/flow\.google\.com\/asb\//i.test(message.url)
        ) {
          try {
            resp = await fetch(message.url, {
              credentials: "include",
              signal: ctrl.signal,
            });
          } catch (error) {
            throw new Error(
              `FLOW_ASB_AUTH_FETCH_FAILED: ${error?.message || "unknown"}`,
            );
          }
          if (!_isAllowedFlowAsbRedirectUrl(resp.url || message.url)) {
            let host = "invalid";
            try {
              host = new URL(resp.url || message.url).hostname;
            } catch (_) {}
            sendResponse({
              success: false,
              error: `Flow media redirect target not allowed: ${host}`,
            });
            return;
          }
          if (!resp.ok)
            console.warn(
              "[FlowAsbFetch] authenticated retry HTTP",
              resp.status,
            );
        }
        if (!_isAllowedUrl(resp.url || message.url)) {
          sendResponse({
            success: false,
            error: "Redirect target not allowed",
          });
          return;
        }
        if (!resp.ok) {
          sendResponse({
            success: false,
            error: `HTTP ${resp.status} ${resp.statusText}`,
          });
          return;
        }
        const contentType = resp.headers.get("content-type") || "";
        if (message.expectImage && !contentType.startsWith("image/")) {
          sendResponse({
            success: false,
            error: `Not an image: ${contentType}`,
          });
          return;
        }
        const defaultLimit =
          (message.expectImage === false ? 45 : 25) * 1024 * 1024;
        const requestedLimit = Number(message.maxBytes);
        const byteLimit =
          Number.isSafeInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(defaultLimit, requestedLimit)
            : defaultLimit;
        const bytes = await _readResponseBytesLimited(resp, byteLimit);
        const base64 =
          typeof bytes.toBase64 === "function"
            ? bytes.toBase64()
            : (() => {
                let binary = "";
                for (let offset = 0; offset < bytes.length; offset += 8192) {
                  binary += String.fromCharCode.apply(
                    null,
                    bytes.subarray(offset, offset + 8192),
                  );
                }
                return btoa(binary);
              })();
        sendResponse({ success: true, base64, contentType });
      } catch (err) {
        sendResponse({
          success: false,
          error: err?.name === "AbortError" ? "Fetch timeout" : err.message,
        });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return true;
  }
  if (message.action === "checkImageUrl") {
    if (!_isAllowedUrl(message.url)) {
      sendResponse({ success: false, alive: false, error: "URL not allowed" });
      return true;
    }
    (async () => {
      try {
        const resp = await fetch(message.url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
        });
        const alive = resp.status >= 200 && resp.status < 400;
        console.log(
          "[checkImageUrl]",
          message.url.substring(0, 80),
          "\u2192",
          resp.status,
          alive ? "alive" : "dead",
        );
        sendResponse({ success: true, alive, status: resp.status });
      } catch (err) {
        console.log("[checkImageUrl] error:", err.message);
        sendResponse({ success: true, alive: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "oauth:success") {
    const senderUrl = sender.tab?.url || "";
    if (!senderUrl.includes("/auth/google/success")) {
      sendResponse({ success: false, error: "Invalid sender URL" });
      return true;
    }
    const { token } = message;
    if (token) {
      (async () => {
        try {
          const stored = await new Promise((resolve) => {
            chrome.storage.local.get(["af_auth"], (result) =>
              resolve(result.af_auth || {}),
            );
          });
          const apiBaseUrl = stored.apiBaseUrl || getApiBaseUrl();
          if (stored.token && stored.user) {
            console.log(
              "[TobyFlow] OAuth: clearing SSE session for previous user",
            );
            fetch(`${apiBaseUrl}/sse/end-session`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${stored.token}`,
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Extension-Id": chrome.runtime.id,
              },
            })
              .then(async (resp) => {
                if (resp.status === 403) {
                  try {
                    const body = await resp.clone().json();
                    if (_isExtensionAuthRejection(body, 403))
                      _handleExtensionAuthRejection();
                  } catch (_) {}
                }
              })
              .catch(() => {});
          }
          let user = null;
          try {
            const resp = await fetch(`${apiBaseUrl}/auth/me`, {
              method: "GET",
              headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/json",
                "X-Extension-Id": chrome.runtime.id,
              },
            });
            if (resp.status === 403) {
              try {
                const body = await resp.clone().json();
                if (_isExtensionAuthRejection(body, 403))
                  _handleExtensionAuthRejection();
              } catch (_) {}
            }
            if (resp.ok) {
              const data = await resp.json();
              user = data?.data?.user || data?.user || null;
              console.log(
                "[TobyFlow] OAuth: fetched user data from /auth/me",
                user?.google_id ? "with google_id" : "without google_id",
              );
            }
          } catch (fetchErr) {
            console.warn(
              "[TobyFlow] OAuth: failed to fetch /auth/me, continuing with null user",
              fetchErr.message,
            );
          }
          await new Promise((resolve) => {
            chrome.storage.local.set(
              { af_auth: { token, user, apiBaseUrl, savedAt: Date.now() } },
              resolve,
            );
          });
          console.log("[TobyFlow] OAuth success: token saved");
          chrome.runtime
            .sendMessage({ action: "auth:oauthLogin", token, user })
            .catch(() => {});
          if (sender.tab?.id) {
            const oauthTabId = sender.tab.id;
            const oauthWindowId = sender.tab.windowId;
            setTimeout(async () => {
              try {
                await chrome.tabs.remove(oauthTabId);
              } catch (err) {
                console.warn(
                  "[TobyFlow] Kh\xF4ng th\u1EC3 \u0111\xF3ng OAuth tab:",
                  err.message,
                );
              }
              try {
                let flowTabs = await chrome.tabs.query({
                  url: getFlowTabQueryPatterns(),
                  windowId: oauthWindowId,
                });
                if (!flowTabs.length) {
                  flowTabs = await chrome.tabs.query({
                    url: getFlowTabQueryPatterns(),
                  });
                }
                if (flowTabs.length > 0) {
                  const flowTab = flowTabs[0];
                  await chrome.tabs.update(flowTab.id, { active: true });
                  if (flowTab.windowId !== void 0) {
                    await chrome.windows.update(flowTab.windowId, {
                      focused: true,
                    });
                  }
                  console.log("[TobyFlow] Activated Flow tab sau OAuth login");
                } else {
                  console.log(
                    "[TobyFlow] Kh\xF4ng t\xECm th\u1EA5y Flow tab \u0111\u1EC3 activate",
                  );
                }
              } catch (err) {
                console.warn(
                  "[TobyFlow] Kh\xF4ng th\u1EC3 activate Flow tab:",
                  err.message,
                );
              }
            }, 1500);
          }
          sendResponse({ success: true });
        } catch (err) {
          console.error("[TobyFlow] OAuth save error:", err.message);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    sendResponse({ success: false, error: "Missing token" });
    return true;
  }
  if (message.action === "oauth:linked") {
    const senderUrl = sender.tab?.url || "";
    if (!senderUrl.includes("/auth/google/success")) {
      sendResponse({ success: false, error: "Invalid sender URL" });
      return true;
    }
    console.log("[TobyFlow] Google link success: notifying extension");
    chrome.runtime.sendMessage({ action: "auth:googleLinked" }).catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  if (message.action === "payment:success") {
    chrome.runtime
      .sendMessage({
        action: "payment:completed",
        orderId: message.orderId,
        status: message.status || "paid",
      })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "payment:cancelled") {
    chrome.runtime
      .sendMessage({ action: "payment:cancelled", orderId: message.orderId })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }
  if (message.action === "chatgpt:findOrCreateTab") {
    const { createIfMissing = true, activate = true } = message;
    (async () => {
      try {
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }
        let tabs = await chrome.tabs.query({
          url: PROVIDER_URLS.chatgpt.tabQuery,
          windowId: currentWindowId,
        });
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({
            url: PROVIDER_URLS.chatgpt.tabQuery,
          });
        }
        let tabId;
        if (tabs.length > 0) {
          tabId = tabs[0].id;
        } else if (createIfMissing) {
          const tab = await chrome.tabs.create({
            url: PROVIDER_URLS.chatgpt.createUrl,
            active: !!activate,
            windowId: currentWindowId,
          });
          tabId = tab.id;
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15e3);
            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        sendResponse({ success: true, tabId });
      } catch (err) {
        console.error("[TobyFlow] chatgpt:findOrCreateTab error:", err.message);
        sendResponse({ success: false, error: err.message || "NO_TAB" });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:ensureActive") {
    const tabId = message.tabId || sender?.tab?.id;
    const focusWindow = message.focusWindow === true;
    const navigateToHome = message.navigateToHome === true;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        let tabInfo = await chrome.tabs.get(tabId);
        const isAtHomepage =
          tabInfo.url &&
          tabInfo.url.match(/^https:\/\/chatgpt\.com\/?(\?|#|$)/);
        const shouldNavigate =
          navigateToHome && (!isAtHomepage || message.forceRefresh);
        if (shouldNavigate) {
          console.log(
            "[TobyFlow] chatgpt:ensureActive navigating to homepage from:",
            tabInfo.url,
            "forceRefresh:",
            !!message.forceRefresh,
          );
          const targetUrl = isAtHomepage
            ? `https://chatgpt.com/?_t=${Date.now()}`
            : "https://chatgpt.com/";
          await chrome.tabs.update(tabId, { url: targetUrl });
          await new Promise((resolve) => {
            const pageLoadDeadline = Date.now() + 15e3;
            const checkComplete = async () => {
              try {
                const tab = await chrome.tabs.get(tabId);
                if (
                  tab.status === "complete" &&
                  tab.url?.includes("chatgpt.com")
                ) {
                  resolve();
                } else if (Date.now() >= pageLoadDeadline) {
                  console.warn(
                    "[TobyFlow] chatgpt:ensureActive page-load wait timed out; continuing to readiness probe",
                  );
                  resolve();
                } else {
                  setTimeout(checkComplete, 200);
                }
              } catch {
                resolve();
              }
            };
            setTimeout(checkComplete, 300);
          });
          await new Promise((r) => setTimeout(r, 400));
          tabInfo = await chrome.tabs.get(tabId);
          console.log(
            "[TobyFlow] chatgpt:ensureActive homepage navigation complete",
          );
        }
        if (!tabInfo.active) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 300));
        }
        if (focusWindow && tabInfo.windowId) {
          try {
            await chrome.windows.update(tabInfo.windowId, {
              focused: true,
              drawAttention: true,
            });
          } catch (winErr) {
            console.warn(
              "[TobyFlow] chatgpt:ensureActive focusWindow failed:",
              winErr.message,
            );
          }
        }
        sendResponse({ success: true, active: true });
      } catch (err) {
        console.error("[TobyFlow] chatgpt:ensureActive error:", err.message);
        sendResponse({
          success: false,
          error: err.message || "ACTIVATE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:injectScript") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab?.url || !tab.url.startsWith("https://chatgpt.com/")) {
          sendResponse({
            success: false,
            error: "NOT_CHATGPT_URL",
            url: tab?.url || "",
          });
          return;
        }
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => !!window.__tobyflowChatGPTLoaded__,
        });
        const alreadyLoaded = !!(
          checkResults &&
          checkResults[0] &&
          checkResults[0].result
        );
        if (!alreadyLoaded) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [
              "src/core/ConfigSnapshotAccess.js",
              "floating-tracker-chat.js",
              "chat-content-chatgpt.js",
            ],
          });
        }
        sendResponse({ success: true, alreadyLoaded });
      } catch (err) {
        console.warn("[TobyFlow] chatgpt:injectScript skipped:", err.message);
        sendResponse({ success: false, error: err.message || "INJECT_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:checkWorkerEditorReady") {
    (async () => {
      try {
        if (!Number.isInteger(message.tabId)) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "chatgpt:checkWorkerEditorReady",
          timeoutMs: message.timeoutMs,
        });
        sendResponse(
          result || { success: false, error: "EDITOR_CHECK_FAILED" },
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "EDITOR_CHECK_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:checkLogin") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const storage = await _readOperationalSnapshot([
          "toby_provider_configs",
        ]);
        const privateConfig = await ProtectedConfigClient.fetch("private", {
          provider: "chatgpt",
        });
        const chatgptSelectors =
          storage?.toby_provider_configs?.data?.chatgpt?.selectors;
        const readSelectors = (key) => {
          const selectors = chatgptSelectors?.[key]?.selectors;
          return Array.isArray(selectors)
            ? selectors.filter(
                (selector) => typeof selector === "string" && selector.trim(),
              )
            : [];
        };
        const composerSelectors = readSelectors("composer");
        const loginBtnSelectors = readSelectors("login_button");
        const authLinkSelectors = readSelectors("auth_link");
        if (composerSelectors.length === 0) {
          sendResponse({
            success: false,
            ready: false,
            error: "SELECTOR_CONFIG_UNAVAILABLE",
          });
          return;
        }
        const notLoggedInRaw =
          privateConfig?.data?.chatgpt?.configs?.ui_text_patterns
            ?.not_logged_in_text || "";
        const notLoggedInPatterns = notLoggedInRaw
          .split("|")
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        const args = {
          composerSelectors,
          loginBtnSelectors,
          authLinkSelectors,
          notLoggedInPatterns,
        };
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          args: [args],
          func: function checkLoginStatus(cfg) {
            const queryFirst = (selectors, accept = () => true) => {
              if (!Array.isArray(selectors)) return null;
              for (const sel of selectors) {
                try {
                  for (const el of document.querySelectorAll(sel)) {
                    if (accept(el)) return el;
                  }
                } catch (_) {}
              }
              return null;
            };
            const isVisible = (el) => {
              if (!el || !el.isConnected) return false;
              try {
                const style = window.getComputedStyle(el);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  Number(style.opacity) === 0
                )
                  return false;
                const rect = el.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.bottom > 0 &&
                  rect.right > 0 &&
                  rect.top < window.innerHeight &&
                  rect.left < window.innerWidth
                );
              } catch (_) {
                return false;
              }
            };
            const editor = queryFirst(
              cfg.composerSelectors,
              (el) =>
                isVisible(el) &&
                el.getAttribute("contenteditable") === "true" &&
                el.getAttribute("aria-disabled") !== "true" &&
                !el.closest('[aria-busy="true"]'),
            );
            const loginBtn = queryFirst(cfg.loginBtnSelectors, isVisible);
            const loginLink = queryFirst(cfg.authLinkSelectors, isVisible);
            let signInTextBtn = null;
            if (cfg.notLoggedInPatterns && cfg.notLoggedInPatterns.length > 0) {
              try {
                const buttons = document.querySelectorAll("button");
                for (const btn of buttons) {
                  const text = (btn.textContent || "").trim().toLowerCase();
                  if (!text || text.length > 30) continue;
                  if (
                    isVisible(btn) &&
                    cfg.notLoggedInPatterns.some(
                      (p) => text === p || text.includes(p),
                    )
                  ) {
                    signInTextBtn = btn;
                    break;
                  }
                }
              } catch (_) {}
            }
            const editorInteractive =
              !!editor &&
              isVisible(editor) &&
              editor.getAttribute("contenteditable") === "true" &&
              editor.getAttribute("aria-disabled") !== "true" &&
              !editor.closest('[aria-busy="true"]');
            if (!editorInteractive)
              return { ready: false, error: "EDITOR_NOT_FOUND" };
            const visibleLoginBtn = isVisible(loginBtn) ? loginBtn : null;
            const visibleLoginLink = isVisible(loginLink) ? loginLink : null;
            if (visibleLoginBtn || visibleLoginLink || signInTextBtn) {
              return {
                ready: false,
                error: "NOT_LOGGED_IN",
                _detected: signInTextBtn
                  ? "text_pattern"
                  : visibleLoginBtn
                    ? "login_button"
                    : "auth_link",
              };
            }
            return { ready: true };
          },
        });
        const result = (results && results[0] && results[0].result) || {
          ready: false,
          error: "EDITOR_NOT_FOUND",
        };
        if (result._detected) {
          console.log(
            "[TobyFlow] chatgpt:checkLogin NOT_LOGGED_IN detected via:",
            result._detected,
          );
        }
        delete result._detected;
        sendResponse({ success: true, ...result });
      } catch (err) {
        console.error("[TobyFlow] chatgpt:checkLogin error:", err.message);
        sendResponse({ success: false, error: err.message || "CHECK_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "motion:cleanupTranscript") {
    _enqueueMotionTranscriptCleanup(message, sender)
      .then(sendResponse)
      .catch(() =>
        sendResponse({ success: false, error: "MOTION_CLEANUP_UNCONFIRMED" }),
      );
    return true;
  }
  if (message.action === "chatgpt:deleteConversationWithReloadFallback") {
    (async () => {
      const tabId = Number(message.tabId) || sender?.tab?.id;
      if (!tabId) {
        sendResponse({ success: false, error: "NO_TAB" });
        return;
      }
      const result = await _deleteChatGptConversationWithReloadFallback(tabId, {
        expectedConversationUrl: message.expectedConversationUrl || null,
        focusWindow: message.focusWindow === true,
        skipReload: message.skipReload === true,
        requestedAt: message.requestedAt,
      });
      sendResponse(result);
    })().catch((error) =>
      sendResponse({
        success: false,
        error: error?.message || "DELETE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "chatgpt:completeDeferredCleanup") {
    (async () => {
      const tabId = Number(message.tabId);
      const expectedConversationUrl = message.expectedConversationUrl || null;
      if (!tabId || !expectedConversationUrl) {
        sendResponse({ success: false, error: "INVALID_CLEANUP_RECEIPT" });
        return;
      }
      const result = await _deleteChatGptConversationWithReloadFallback(tabId, {
        expectedConversationUrl,
        focusWindow: false,
      });
      sendResponse(result);
    })().catch((error) =>
      sendResponse({
        success: false,
        error: error?.message || "DELETE_FAILED",
      }),
    );
    return true;
  }
  if (message.action === "gemini:findOrCreateTab") {
    const { createIfMissing = true, activate = true } = message;
    (async () => {
      try {
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }
        let tabs = await chrome.tabs.query({
          url: PROVIDER_URLS.gemini.tabQuery,
          windowId: currentWindowId,
        });
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({
            url: PROVIDER_URLS.gemini.tabQuery,
          });
        }
        let tabId;
        if (tabs.length > 0) {
          tabId = (tabs.find((tab) => tab.active) || tabs[0]).id;
        } else if (createIfMissing) {
          const tab = await chrome.tabs.create({
            url: PROVIDER_URLS.gemini.createUrl,
            active: !!activate,
            windowId: currentWindowId,
          });
          tabId = tab.id;
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15e3);
            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        sendResponse({ success: true, tabId });
      } catch (err) {
        console.error("[TobyFlow] gemini:findOrCreateTab error:", err.message);
        sendResponse({ success: false, error: err.message || "NO_TAB" });
      }
    })();
    return true;
  }
  if (message.action === "gemini:ensureActive") {
    const tabId = message.tabId || sender?.tab?.id;
    const focusWindow = message.focusWindow === true;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tabInfo = await chrome.tabs.get(tabId);
        if (!tabInfo.active) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 300));
        }
        if (focusWindow && tabInfo.windowId) {
          try {
            await chrome.windows.update(tabInfo.windowId, {
              focused: true,
              drawAttention: true,
            });
          } catch (winErr) {
            console.warn(
              "[TobyFlow] gemini:ensureActive focusWindow failed:",
              winErr.message,
            );
          }
        }
        sendResponse({ success: true, active: true });
      } catch (err) {
        console.error("[TobyFlow] gemini:ensureActive error:", err.message);
        sendResponse({
          success: false,
          error: err.message || "ACTIVATE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "gemini:injectScript") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab?.url || !tab.url.startsWith("https://gemini.google.com/")) {
          sendResponse({
            success: false,
            error: "NOT_GEMINI_URL",
            url: tab?.url || "",
          });
          return;
        }
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => ({
            content:
              !!window._tobyflowGeminiInjected &&
              window._tobyflowGeminiRuntimeId === chrome.runtime.id &&
              window._tobyflowGeminiListenerReady === true,
            tracker: typeof window.createFloatingTrackerRich === "function",
          }),
        });
        const loaded = checkResults?.[0]?.result || {};
        const alreadyLoaded =
          loaded.content === true && loaded.tracker === true;
        if (!loaded.tracker) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["floating-tracker-chat.js"],
          });
        }
        if (!loaded.content) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [
              "src/core/ConfigSnapshotAccess.js",
              "chat-content-gemini.js",
            ],
          });
          const listenerResults = await chrome.scripting.executeScript({
            target: { tabId },
            func: () =>
              window._tobyflowGeminiRuntimeId === chrome.runtime.id &&
              window._tobyflowGeminiListenerReady === true,
          });
          if (listenerResults?.[0]?.result !== true) {
            sendResponse({
              success: false,
              error: "GEMINI_LISTENER_NOT_READY",
            });
            return;
          }
        }
        const pingStartedAt = Date.now();
        const listenerProbe = await new Promise((resolve) => {
          const timer = setTimeout(
            () => resolve({ alive: false, reason: "timeout" }),
            2e3,
          );
          try {
            chrome.tabs.sendMessage(
              tabId,
              { action: "gemini:ping" },
              (response) => {
                clearTimeout(timer);
                const error = chrome.runtime.lastError;
                resolve({
                  alive:
                    !error &&
                    response?.success === true &&
                    response?.provider === "gemini" &&
                    response?.listenerReady === true,
                  reason: error
                    ? "message_error"
                    : response
                      ? "response_unready"
                      : "empty_response",
                });
              },
            );
          } catch (_) {
            clearTimeout(timer);
            resolve({ alive: false, reason: "send_exception" });
          }
        });
        console.info(
          "[GeminiReadinessAudit]",
          JSON.stringify({
            tabId,
            alreadyLoaded,
            listenerAlive: listenerProbe.alive,
            pingReason: listenerProbe.alive ? null : listenerProbe.reason,
            pingMs: Date.now() - pingStartedAt,
            tabStatus: tab.status || null,
          }),
        );
        sendResponse(
          listenerProbe.alive
            ? { success: true, alreadyLoaded }
            : { success: false, error: "GEMINI_LISTENER_UNRESPONSIVE" },
        );
      } catch (err) {
        console.warn("[TobyFlow] gemini:injectScript skipped:", err.message);
        sendResponse({ success: false, error: err.message || "INJECT_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "gemini:checkLogin") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const runCheck = async () => {
          const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: function checkGeminiLogin() {
              const url = location.href || "";
              if (/\/(ServiceLogin|signin|accounts\.google\.com)/.test(url)) {
                return { ready: false, error: "NOT_LOGGED_IN" };
              }
              const editor =
                document.querySelector('.ql-editor[contenteditable="true"]') ||
                document.querySelector(
                  'rich-textarea [contenteditable="true"]',
                ) ||
                document.querySelector(
                  'div[role="textbox"][contenteditable="true"]',
                );
              if (editor) return { ready: true };
              const sidebarNav =
                document.querySelector(
                  'side-navigation, [data-test-id="side-nav"], #side-navigation',
                ) ||
                document.querySelector(
                  'button[aria-label*="account"i], img[alt*="account"i][role]',
                );
              if (sidebarNav) return { ready: true };
              const signinLink = document.querySelector(
                'a[href*="accounts.google.com/ServiceLogin"], a[href*="signin"]',
              );
              if (signinLink) return { ready: false, error: "NOT_LOGGED_IN" };
              return { ready: false, error: "EDITOR_NOT_FOUND" };
            },
          });
          return (
            (results && results[0] && results[0].result) || {
              ready: false,
              error: "EDITOR_NOT_FOUND",
            }
          );
        };
        const RETRY_MAX = 4;
        const RETRY_DELAY = 400;
        let result = await runCheck();
        for (
          let i = 1;
          i < RETRY_MAX && !result.ready && result.error === "EDITOR_NOT_FOUND";
          i++
        ) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY));
          result = await runCheck();
        }
        sendResponse({ success: true, ...result });
      } catch (err) {
        console.error("[TobyFlow] gemini:checkLogin error:", err.message);
        sendResponse({ success: false, error: err.message || "CHECK_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "gemini:checkEditorReady") {
    (async () => {
      try {
        const result = await chrome.tabs.sendMessage(message.tabId, {
          action: "gemini:checkEditorReady",
        });
        sendResponse(
          result || { success: false, error: "EDITOR_CHECK_FAILED" },
        );
      } catch (error) {
        sendResponse({
          success: false,
          error: error?.message || "EDITOR_CHECK_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "gemini:getTabInfo") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tabInfo = await chrome.tabs.get(tabId);
        sendResponse({
          success: true,
          url: tabInfo?.url || null,
          active: !!tabInfo?.active,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message || "TAB_NOT_FOUND" });
      }
    })();
    return true;
  }
  if (message.action === "gemini:closeTab") {
    const { tabId } = message;
    (async () => {
      try {
        if (tabId) {
          try {
            await chrome.tabs.remove(tabId);
          } catch (e) {}
        }
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:activateImageMode") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: async function activateImageMode() {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const log = (...args) => console.log("[ChatGPT-activate]", ...args);
            const clickElement = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const opts = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
              };
              try {
                el.dispatchEvent(new PointerEvent("pointerdown", opts));
                el.dispatchEvent(new MouseEvent("mousedown", opts));
                el.dispatchEvent(new PointerEvent("pointerup", opts));
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
              } catch (e) {}
              const propsKey = Object.keys(el).find((k) =>
                k.startsWith("__reactProps$"),
              );
              const props = propsKey ? el[propsKey] : null;
              try {
                if (props && typeof props.onSelect === "function") {
                  props.onSelect({ preventDefault() {}, stopPropagation() {} });
                } else if (props && typeof props.onClick === "function") {
                  props.onClick({
                    preventDefault() {},
                    stopPropagation() {},
                    nativeEvent: new MouseEvent("click"),
                    type: "click",
                    target: el,
                    currentTarget: el,
                  });
                }
              } catch (e) {}
              return true;
            };
            try {
              const openMenu = document.querySelector(
                'div[role="menu"][data-state="open"]',
              );
              if (openMenu) {
                document.activeElement?.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                  }),
                );
                await sleep(60);
              }
            } catch (e) {}
            const existingRatioBtn = document.querySelector(
              'button[aria-label="Choose image aspect ratio"]',
            );
            if (existingRatioBtn) {
              log(
                "Step 1: ratio button \u0111\xE3 visible \u2014 image mode \u0111\xE3 active, skip click composer",
              );
              return {
                activated: true,
                ratioControlAvailable: true,
                alreadyActive: true,
              };
            }
            const plusBtn =
              document.querySelector("#composer-plus-btn") ||
              document.querySelector('[data-testid="composer-plus-btn"]');
            if (!plusBtn) {
              log("Step 2 FAIL: PLUS_BUTTON_NOT_FOUND");
              return { activated: false, error: "PLUS_BUTTON_NOT_FOUND" };
            }
            log("Step 2: Click composer plus button");
            clickElement(plusBtn);
            let menuContainer = null;
            for (let i = 0; i < 6; i++) {
              await sleep(80);
              menuContainer = document.querySelector(
                'div[role="menu"][data-radix-menu-content][data-state="open"]',
              );
              if (menuContainer) break;
            }
            if (!menuContainer) {
              log("Step 3 FAIL: MENU_NOT_RENDERED sau 480ms");
              return { activated: false, error: "MENU_NOT_RENDERED" };
            }
            log("Step 3: Menu rendered");
            const menuItems = menuContainer.querySelectorAll(
              '[role="menuitemradio"], [role="menuitem"]',
            );
            let createImageItem = null;
            let alreadyChecked = false;
            for (const item of menuItems) {
              const text = (item.innerText || "").trim().toLowerCase();
              if (
                text === "create image" ||
                text === "create an image" ||
                text.startsWith("create image")
              ) {
                createImageItem = item;
                alreadyChecked =
                  item.getAttribute("aria-checked") === "true" ||
                  item.getAttribute("data-state") === "checked";
                break;
              }
            }
            if (!createImageItem) {
              log(
                "Step 4 FAIL: MENU_ITEM_NOT_FOUND. Items found:",
                Array.from(menuItems).map((i) => i.innerText?.trim()),
              );
              return { activated: false, error: "MENU_ITEM_NOT_FOUND" };
            }
            log(
              'Step 4: Click "Create image" item (alreadyChecked:',
              alreadyChecked,
              ")",
            );
            if (!alreadyChecked) {
              clickElement(createImageItem);
            } else {
              try {
                document.activeElement?.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "Escape",
                    bubbles: true,
                  }),
                );
              } catch (e) {}
            }
            let ratioBtn = null;
            for (let i = 0; i < 8; i++) {
              await sleep(80);
              ratioBtn = document.querySelector(
                'button[aria-label="Choose image aspect ratio"]',
              );
              if (ratioBtn) break;
            }
            log(
              "Step 6:",
              ratioBtn
                ? "Ratio button visible"
                : "RATIO_CONTROL_NOT_RENDERED sau 640ms",
            );
            return {
              activated: !!ratioBtn,
              ratioControlAvailable: !!ratioBtn,
              wasAlreadyChecked: alreadyChecked,
              error: ratioBtn ? null : "RATIO_CONTROL_NOT_RENDERED",
            };
          },
        });
        const result = (results && results[0] && results[0].result) || {
          activated: false,
          error: "EXEC_FAILED",
        };
        sendResponse({ success: !!result.activated, ...result });
      } catch (err) {
        console.error(
          "[TobyFlow] chatgpt:activateImageMode error:",
          err.message,
        );
        sendResponse({
          success: false,
          activated: false,
          error: err.message || "EXEC_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:setRatio") {
    const { tabId, ratio, ariaLabelMap } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        if (!ratio) {
          sendResponse({ success: false, error: "INVALID_RATIO_KEY" });
          return;
        }
        if (
          !ariaLabelMap ||
          typeof ariaLabelMap !== "object" ||
          Object.keys(ariaLabelMap).length === 0
        ) {
          console.debug(
            "[Tier3] chatgpt:setRatio missing ariaLabelMap \u2014 caller ph\u1EA3i truy\u1EC1n t\u1EEB ChatGPTAdapter.capabilities",
          );
          sendResponse({ success: false, error: "MISSING_ARIA_LABEL_MAP" });
          return;
        }
        const resolvedAriaLabelMap = ariaLabelMap;
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          args: [ratio, resolvedAriaLabelMap],
          func: async function setRatio(ratioKey, ARIA_LABEL_MAP) {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const log = (...args) => console.log("[ChatGPT-setRatio]", ...args);
            const clickElement = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const opts = {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: rect.left + rect.width / 2,
                clientY: rect.top + rect.height / 2,
              };
              try {
                el.dispatchEvent(new PointerEvent("pointerdown", opts));
                el.dispatchEvent(new MouseEvent("mousedown", opts));
                el.dispatchEvent(new PointerEvent("pointerup", opts));
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
              } catch (e) {}
              const propsKey = Object.keys(el).find((k) =>
                k.startsWith("__reactProps$"),
              );
              const props = propsKey ? el[propsKey] : null;
              try {
                if (props && typeof props.onSelect === "function") {
                  props.onSelect({ preventDefault() {}, stopPropagation() {} });
                } else if (props && typeof props.onClick === "function") {
                  props.onClick({
                    preventDefault() {},
                    stopPropagation() {},
                    nativeEvent: new MouseEvent("click"),
                    type: "click",
                    target: el,
                    currentTarget: el,
                  });
                }
              } catch (e) {}
              return true;
            };
            const targetAriaLabel = ARIA_LABEL_MAP?.[ratioKey];
            if (!targetAriaLabel)
              return { success: false, error: "INVALID_RATIO_KEY" };
            const ratioBtn = document.querySelector(
              'button[aria-label="Choose image aspect ratio"]',
            );
            if (!ratioBtn) {
              log("FAIL: RATIO_BUTTON_NOT_FOUND");
              return { success: false, error: "RATIO_BUTTON_NOT_FOUND" };
            }
            log("Step 1: Click ratio button \u2192", targetAriaLabel);
            clickElement(ratioBtn);
            let items = [];
            for (let i = 0; i < 5; i++) {
              await sleep(150);
              items = document.querySelectorAll('[role="menuitemradio"]');
              if (items.length >= 5) break;
            }
            log("Step 2: Found", items.length, "menuitemradio options");
            let target = null;
            for (const item of items) {
              if (item.getAttribute("aria-label") === targetAriaLabel) {
                target = item;
                break;
              }
            }
            if (!target) {
              const ratioName = targetAriaLabel.split(" ")[0].toLowerCase();
              for (const item of items) {
                const text = (item.innerText || "").trim().toLowerCase();
                if (text.startsWith(ratioName)) {
                  target = item;
                  break;
                }
              }
            }
            if (!target) {
              log(
                "FAIL: RATIO_OPTION_NOT_FOUND. Items aria-labels:",
                Array.from(items).map((i) => i.getAttribute("aria-label")),
              );
              return { success: false, error: "RATIO_OPTION_NOT_FOUND" };
            }
            log("Step 3: Click target option");
            clickElement(target);
            return { success: true };
          },
        });
        const result = (results && results[0] && results[0].result) || {
          success: false,
          error: "EXEC_FAILED",
        };
        sendResponse(result);
      } catch (err) {
        console.error("[TobyFlow] chatgpt:setRatio error:", err.message);
        sendResponse({ success: false, error: err.message || "EXEC_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "fetchImageAsBase64") {
    const { url } = message;
    const maxBytes =
      Number.isSafeInteger(message.maxBytes) && message.maxBytes > 0
        ? message.maxBytes
        : 0;
    const timeoutMs =
      Number.isSafeInteger(message.timeoutMs) && message.timeoutMs > 0
        ? message.timeoutMs
        : 0;
    (async () => {
      try {
        if (!url || !_isAllowedFlowMediaUrl(url)) {
          sendResponse({
            success: false,
            error: url ? "FLOW_MEDIA_URL_NOT_ALLOWED" : "MISSING_URL",
          });
          return;
        }
        const flowTabs = await chrome.tabs.query({
          url: ["https://labs.google/*", "https://flow.google.com/*"],
        });
        if (flowTabs.length === 0) {
          try {
            const result = await _fetchFlowPreviewImageBytes(
              url,
              maxBytes,
              timeoutMs,
            );
            sendResponse(
              result.ok
                ? { ...result, success: true }
                : { success: false, error: result.error },
            );
          } catch (e) {
            sendResponse({
              success: false,
              error: "NO_FLOW_TAB_AND_DIRECT_FAILED",
            });
          }
          return;
        }
        let mediaOrigin = null;
        try {
          mediaOrigin = new URL(url).origin;
        } catch (_) {}
        const matchingTab = mediaOrigin
          ? flowTabs.find((tab) => {
              try {
                return new URL(tab.url || "").origin === mediaOrigin;
              } catch (_) {
                return false;
              }
            })
          : null;
        const tabId = (matchingTab || flowTabs[0]).id;
        const [scriptResult] = await chrome.scripting.executeScript({
          target: { tabId },
          func: _fetchFlowPreviewImageBytes,
          args: [url, maxBytes, timeoutMs],
        });
        const r = scriptResult?.result;
        if (!r?.ok) {
          sendResponse({ success: false, error: r?.error || "FETCH_FAILED" });
          return;
        }
        sendResponse({
          success: true,
          base64: r.base64,
          contentType: r.contentType,
          size: r.size,
        });
      } catch (err) {
        console.error("[TobyFlow] fetchImageAsBase64 error:", err.message);
        sendResponse({
          success: false,
          error: "EXCEPTION",
          message: err.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:fetchImage") {
    const { url, tabId } = message;
    (async () => {
      try {
        if (!url || !tabId) {
          sendResponse({ success: false, error: "MISSING_PARAMS" });
          return;
        }
        const [scriptResult] = await chrome.scripting.executeScript({
          target: { tabId },
          world: url.startsWith("blob:") ? "MAIN" : "ISOLATED",
          func: async (imgUrl) => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 18e4);
            try {
              const resp = await fetch(imgUrl, {
                credentials: "include",
                signal: controller.signal,
              });
              if (!resp.ok)
                return {
                  ok: false,
                  status: resp.status,
                  error: "HTTP_" + resp.status,
                };
              const blob = await resp.blob();
              return await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () =>
                  resolve({
                    ok: true,
                    base64: reader.result,
                    mime: blob.type || "image/png",
                    size: blob.size,
                  });
                reader.onerror = () =>
                  resolve({ ok: false, error: "READ_ERROR" });
                reader.readAsDataURL(blob);
              });
            } catch (e) {
              return { ok: false, error: e.message || "FETCH_EXCEPTION" };
            } finally {
              clearTimeout(timeout);
            }
          },
          args: [url],
        });
        const r = scriptResult?.result;
        if (!r?.ok) {
          sendResponse({
            success: false,
            error: r?.error || "FETCH_FAILED",
            status: r?.status,
          });
          return;
        }
        sendResponse({
          success: true,
          base64: r.base64,
          mime: r.mime,
          size: r.size,
        });
      } catch (err) {
        console.error("[TobyFlow] chatgpt:fetchImage error:", err.message);
        sendResponse({
          success: false,
          error: "EXCEPTION",
          message: err.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:closeTab") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: true });
          return;
        }
        try {
          await chrome.tabs.remove(tabId);
        } catch (e) {}
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "chatgpt:trace") {
    if (
      sender.tab &&
      typeof message.operationId === "string" &&
      /^[A-Za-z0-9_.:-]{1,160}$/.test(message.operationId) &&
      typeof message.stage === "string" &&
      /^[a-z_]{1,60}$/.test(message.stage)
    ) {
      console.info(
        "[ChatGPTTrace]",
        JSON.stringify({
          operationId: message.operationId,
          tabId: sender.tab.id,
          stage: message.stage,
          elapsedMs:
            Number.isSafeInteger(message.elapsedMs) && message.elapsedMs >= 0
              ? message.elapsedMs
              : null,
          ...(typeof message.success === "boolean"
            ? { success: message.success }
            : {}),
          ...(typeof message.errorCode === "string" &&
          /^[A-Z][A-Z0-9_]{0,119}$/.test(message.errorCode)
            ? { errorCode: message.errorCode }
            : {}),
        }),
      );
    }
    sendResponse({ success: true });
    return false;
  }
  if (message.action === "chatgpt:navigated") {
    if (!sender.tab) {
      sendResponse({ success: true, skipped: true });
      return true;
    }
    const tabId = sender.tab.id;
    chrome.runtime
      .sendMessage({
        action: "chatgpt:navigatedBroadcast",
        tabId,
        url: message.url,
      })
      .catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  if (message.action === "chatgpt:getTabInfo") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tabInfo = await chrome.tabs.get(tabId);
        sendResponse({
          success: true,
          url: tabInfo.url || null,
          active: !!tabInfo.active,
          status: tabInfo.status,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "grok:findOrCreateTab") {
    const { createIfMissing = true, activate = true } = message;
    (async () => {
      try {
        let currentWindowId = sender.tab?.windowId;
        if (!currentWindowId) {
          const focusedWindow = await chrome.windows.getCurrent();
          currentWindowId = focusedWindow?.id;
        }
        let tabs = await chrome.tabs.query({
          url: PROVIDER_URLS.grok.tabQuery,
          windowId: currentWindowId,
        });
        if (tabs.length === 0) {
          tabs = await chrome.tabs.query({ url: PROVIDER_URLS.grok.tabQuery });
        }
        let tabId;
        if (tabs.length > 0) {
          const imagineTab = tabs.find(
            (t) => t.url && t.url.includes("/imagine"),
          );
          if (imagineTab) {
            tabId = imagineTab.id;
          } else {
            tabId = tabs[0].id;
            await chrome.tabs.update(tabId, {
              url: PROVIDER_URLS.grok.imagine,
            });
            await new Promise((resolve) => {
              const timeout = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }, 1e4);
              const listener = (updatedTabId, changeInfo) => {
                if (
                  updatedTabId === tabId &&
                  changeInfo.status === "complete"
                ) {
                  clearTimeout(timeout);
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
            });
          }
        } else if (createIfMissing) {
          const tab = await chrome.tabs.create({
            url: PROVIDER_URLS.grok.imagine,
            active: !!activate,
            windowId: currentWindowId,
          });
          tabId = tab.id;
          await new Promise((resolve) => {
            const timeout = setTimeout(() => {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }, 15e3);
            const listener = (updatedTabId, changeInfo) => {
              if (updatedTabId === tabId && changeInfo.status === "complete") {
                clearTimeout(timeout);
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
          });
        } else {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        sendResponse({ success: true, tabId });
      } catch (err) {
        console.error("[TobyFlow] grok:findOrCreateTab error:", err.message);
        sendResponse({ success: false, error: err.message || "NO_TAB" });
      }
    })();
    return true;
  }
  if (message.action === "cloudflare:challenge") {
    try {
      chrome.runtime
        .sendMessage({
          action: "cloudflare:challenge",
          provider: message.provider,
          phase: message.phase,
          elapsedSec: message.elapsedSec || 0,
          timeoutSec: message.timeoutSec || 120,
          tabId: sender?.tab?.id || null,
        })
        .catch(() => {});
    } catch (_) {}
    sendResponse?.({ success: true });
    return false;
  }
  if (message.action === "grok:ensureActive") {
    const tabId = message.tabId || sender?.tab?.id;
    const focusWindow = message.focusWindow === true;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tabInfo = await chrome.tabs.get(tabId);
        if (!tabInfo.active) {
          await chrome.tabs.update(tabId, { active: true });
          await new Promise((r) => setTimeout(r, 300));
        }
        if (focusWindow && tabInfo.windowId) {
          try {
            try {
              const prev = await chrome.windows.getLastFocused();
              _grokFocusReturnWindowId =
                prev && prev.id !== tabInfo.windowId ? prev.id : null;
            } catch (_) {}
            await chrome.windows.update(tabInfo.windowId, {
              focused: true,
              drawAttention: true,
            });
          } catch (winErr) {
            console.warn(
              "[TobyFlow] grok:ensureActive focusWindow failed:",
              winErr.message,
            );
          }
        }
        sendResponse({ success: true, active: true });
      } catch (err) {
        console.error("[TobyFlow] grok:ensureActive error:", err.message);
        sendResponse({
          success: false,
          error: err.message || "ACTIVATE_FAILED",
        });
      }
    })();
    return true;
  }
  if (message.action === "grok:restoreFocus") {
    (async () => {
      try {
        if (_grokFocusReturnWindowId != null) {
          const wid = _grokFocusReturnWindowId;
          _grokFocusReturnWindowId = null;
          try {
            await chrome.windows.get(wid);
            await chrome.windows.update(wid, { focused: true });
          } catch (_) {}
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message });
      }
    })();
    return true;
  }
  if (message.action === "grok:injectScript") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        let tab = await chrome.tabs.get(tabId).catch(() => null);
        const loadDeadline = Date.now() + 15e3;
        while (tab?.status === "loading" && Date.now() < loadDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          tab = await chrome.tabs.get(tabId).catch(() => null);
        }
        if (!tab || tab.status === "loading") {
          sendResponse({
            success: false,
            error: tab ? "GROK_NAVIGATION_TIMEOUT" : "NO_TAB",
          });
          return;
        }
        const url = tab?.url || "";
        const isGrokUrl =
          url.startsWith("https://grok.com/") ||
          url.includes("://x.com/i/grok");
        if (!isGrokUrl) {
          sendResponse({ success: false, error: "NOT_GROK_URL", url });
          return;
        }
        const checkResults = await chrome.scripting.executeScript({
          target: { tabId },
          func: () => !!window.__tobyflowGrokLoaded__,
        });
        const alreadyLoaded = !!(
          checkResults &&
          checkResults[0] &&
          checkResults[0].result
        );
        if (!alreadyLoaded) {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: [
              "src/core/ConfigSnapshotAccess.js",
              "floating-tracker-chat.js",
              "chat-content-grok.js",
            ],
          });
        }
        sendResponse({ success: true, alreadyLoaded });
      } catch (err) {
        console.warn("[TobyFlow] grok:injectScript skipped:", err.message);
        sendResponse({ success: false, error: err.message || "INJECT_FAILED" });
      }
    })();
    return true;
  }
  if (message.action === "grok:checkLogin") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          func: function checkGrokLoginStatus() {
            const editor =
              document.querySelector("form div[contenteditable='true']") ||
              document.querySelector(".ProseMirror") ||
              document.querySelector(".tiptap");
            const loginLink =
              document.querySelector('a[href*="/login"]') ||
              document.querySelector('a[href*="/signin"]');
            if (!editor) {
              if (loginLink) return { ready: false, error: "NOT_LOGGED_IN" };
              if (
                /^\/imagine\/(?:post\/[^/]+|saved|projects(?:\/.*)?)\/?$/.test(
                  location.pathname,
                )
              ) {
                return { ready: true, editorRoutePending: true };
              }
              return { ready: false, error: "EDITOR_NOT_FOUND" };
            }
            return { ready: true };
          },
        });
        const result = (results && results[0] && results[0].result) || {
          ready: false,
          error: "EDITOR_NOT_FOUND",
        };
        sendResponse({ success: true, ...result });
      } catch (err) {
        console.error("[TobyFlow] grok:checkLogin error:", err.message);
        sendResponse({ success: false, error: err.message || "CHECK_FAILED" });
      }
    })();
    return true;
  }
  if (
    message.action === "grok:applySettings" ||
    message.action === "grok:setRatio"
  ) {
    const { tabId, settings, ratio } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        let payload = settings || {};
        if (message.action === "grok:setRatio" && ratio) {
          payload = { ratio };
        }
        const sent = await new Promise((resolve) => {
          chrome.tabs.sendMessage(
            tabId,
            { action: "grok:applySettingsInline", settings: payload },
            (resp) => {
              if (chrome.runtime.lastError) {
                resolve({
                  success: false,
                  error: chrome.runtime.lastError.message,
                });
                return;
              }
              resolve(resp || { success: false, error: "NO_RESPONSE" });
            },
          );
        });
        sendResponse(sent);
      } catch (err) {
        console.error("[TobyFlow] grok:applySettings error:", err.message);
        sendResponse({ success: false, error: err.message || "APPLY_FAILED" });
      }
    })();
    return true;
  }
  if (
    message.action === "grok:fetchImage" ||
    message.action === "grok:fetchMedia"
  ) {
    const { url, tabId } = message;
    (async () => {
      try {
        if (!url) {
          sendResponse({ success: false, error: "MISSING_PARAMS" });
          return;
        }
        const fetchHost = (() => {
          try {
            return new URL(url).hostname;
          } catch (_) {
            return "";
          }
        })();
        const trySwFetch = async () => {
          try {
            const resp = await fetch(url, { credentials: "include" });
            if (!resp.ok) {
              return {
                success: false,
                error: "HTTP_" + resp.status,
                status: resp.status,
              };
            }
            const blob = await resp.blob();
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let bin = "";
            const CH = 32768;
            for (let i = 0; i < bytes.length; i += CH)
              bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            const mime = blob.type || "image/jpeg";
            return {
              success: true,
              base64: `data:${mime};base64,` + btoa(bin),
              mime,
              size: blob.size,
            };
          } catch (e) {
            return { success: false, error: e.message || "SW_FETCH_FAILED" };
          }
        };
        const swResult = await trySwFetch();
        if (swResult.success) {
          sendResponse(swResult);
          return;
        }
        if (!fetchHost.endsWith("grok.com") || !tabId) {
          console.warn(
            "[TobyFlow] grok:fetchImage SW fetch failed:",
            swResult.error,
            fetchHost.endsWith("grok.com")
              ? `(no tabId for tab-inject fallback)`
              : `(non-grok.com host, no fallback)`,
          );
          sendResponse(swResult);
          return;
        }
        console.log(
          "[TobyFlow] grok:fetchImage SW fetch failed:",
          swResult.error,
          "\u2192 trying tab-inject fallback",
        );
        let scriptResult;
        try {
          [scriptResult] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (mediaUrl) => {
              try {
                const resp = await fetch(mediaUrl, { credentials: "include" });
                if (!resp.ok)
                  return {
                    ok: false,
                    status: resp.status,
                    error: "HTTP_" + resp.status,
                  };
                const blob = await resp.blob();
                return await new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve({
                      ok: true,
                      base64: reader.result,
                      mime: blob.type || "image/png",
                      size: blob.size,
                    });
                  reader.onerror = () =>
                    resolve({ ok: false, error: "READ_ERROR" });
                  reader.readAsDataURL(blob);
                });
              } catch (e) {
                return { ok: false, error: e.message || "FETCH_EXCEPTION" };
              }
            },
            args: [url],
          });
        } catch (injectErr) {
          console.warn(
            "[TobyFlow] grok:fetchImage tab-inject fail:",
            injectErr.message,
            "\u2192 return SW error",
          );
          sendResponse(swResult);
          return;
        }
        const r = scriptResult?.result;
        if (!r?.ok) {
          sendResponse({
            success: false,
            error: r?.error || "FETCH_FAILED",
            status: r?.status,
          });
          return;
        }
        sendResponse({
          success: true,
          base64: r.base64,
          mime: r.mime,
          size: r.size,
        });
      } catch (err) {
        console.error("[TobyFlow] grok:fetchImage error:", err.message);
        sendResponse({
          success: false,
          error: "EXCEPTION",
          message: err.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "creator:fetchImage") {
    const url = message.url;
    (async () => {
      try {
        if (!url || typeof url !== "string") {
          sendResponse({ success: false, error: "MISSING_URL" });
          return;
        }
        let queryPatterns = [];
        let useCredentials = true;
        const mediaHost = (() => {
          try {
            return new URL(url).hostname.toLowerCase();
          } catch (_) {
            return "";
          }
        })();
        if (!mediaHost || !_isAllowedUrl(url)) {
          sendResponse({ success: false, error: "URL_NOT_ALLOWED" });
          return;
        }
        if (
          _hostIs(mediaHost, "chatgpt.com") ||
          _hostIs(mediaHost, "oaiusercontent.com") ||
          _hostIs(mediaHost, "sandboxed.openai.com")
        ) {
          queryPatterns = [PROVIDER_URLS.chatgpt.tabQuery];
        } else if (
          _hostIs(mediaHost, "grok.com") ||
          _hostIs(mediaHost, "x.ai")
        ) {
          queryPatterns = PROVIDER_URLS.grok.tabQueryPatterns || [
            PROVIDER_URLS.grok.tabQuery,
          ];
        } else if (
          _isAllowedFlowMediaUrl(url) ||
          _hostIs(mediaHost, "uxlfoundation.org")
        ) {
          queryPatterns = getFlowTabQueryPatterns();
          useCredentials = false;
        } else {
          queryPatterns = [];
        }
        let tabId = null;
        for (const pattern of queryPatterns) {
          try {
            const tabs = await chrome.tabs.query({ url: pattern });
            if (tabs && tabs.length > 0) {
              tabId = tabs[0].id;
              break;
            }
          } catch (_) {}
        }
        const fetchInTab = async (tid) => {
          const [res] = await chrome.scripting.executeScript({
            target: { tabId: tid },
            func: async (imgUrl, withCreds) => {
              try {
                const resp = await fetch(
                  imgUrl,
                  withCreds ? { credentials: "include" } : {},
                );
                if (!resp.ok)
                  return {
                    ok: false,
                    status: resp.status,
                    error: "HTTP_" + resp.status,
                  };
                const blob = await resp.blob();
                return await new Promise((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () =>
                    resolve({
                      ok: true,
                      base64: reader.result,
                      mime: blob.type || "image/png",
                    });
                  reader.onerror = () =>
                    resolve({ ok: false, error: "READ_ERROR" });
                  reader.readAsDataURL(blob);
                });
              } catch (e) {
                return { ok: false, error: e.message || "FETCH_EXCEPTION" };
              }
            },
            args: [url, useCredentials],
          });
          return res?.result;
        };
        let r = null;
        if (tabId) {
          r = await fetchInTab(tabId);
        }
        if (!r?.ok) {
          try {
            const resp = await fetch(url, { cache: "no-store" });
            if (resp.ok) {
              const blob = await resp.blob();
              const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => resolve(null);
                reader.readAsDataURL(blob);
              });
              if (base64)
                r = { ok: true, base64, mime: blob.type || "image/png" };
            }
          } catch (_) {}
        }
        if (!r?.ok) {
          sendResponse({
            success: false,
            error: r?.error || "NO_PROVIDER_TAB",
            status: r?.status,
          });
          return;
        }
        sendResponse({ success: true, base64: r.base64, mime: r.mime });
      } catch (err) {
        console.error("[TobyFlow] creator:fetchImage error:", err.message);
        sendResponse({
          success: false,
          error: "EXCEPTION",
          message: err.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "grok:closeTab") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: true });
          return;
        }
        try {
          await chrome.tabs.remove(tabId);
        } catch (e) {}
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "grok:operationCheckpoint") {
    (async () => {
      try {
        const tabId = sender.tab?.id;
        const url = sender.tab?.url || "";
        if (
          !tabId ||
          !(
            url.startsWith("https://grok.com/") ||
            url.includes("://x.com/i/grok")
          ) ||
          !message.requestId
        ) {
          sendResponse({ success: false, error: "INVALID_GROK_CHECKPOINT" });
          return;
        }
        const key = `grokOperation:${tabId}:${message.requestId}`;
        const previous = (await chrome.storage.session.get(key))[key];
        if (previous?.requestId !== message.requestId) {
          sendResponse({ success: false, error: "GROK_OPERATION_MISMATCH" });
          return;
        }
        const state = {
          ...previous,
          ...message.state,
          requestId: previous.requestId,
          updatedAt: Date.now(),
        };
        await chrome.storage.session.set({ [key]: state });
        console.log(
          "[GrokOperation]",
          JSON.stringify({
            tabId,
            requestId: state.requestId,
            ...message.state,
          }),
        );
        sendResponse({ success: true });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.action === "grok:submitAndWait") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const payload = { ...message };
        delete payload.tabId;
        const requestId = message.payload?.requestId;
        if (requestId) {
          const key = `grokOperation:${tabId}:${requestId}`;
          if (message.payload.recover) {
            const state = (await chrome.storage.session.get(key))[key];
            if (state?.requestId !== requestId) {
              sendResponse({
                success: false,
                error: "GROK_RECOVERY_STATE_MISSING",
              });
              return;
            }
            payload.payload = { ...message.payload, recoveryState: state };
          } else {
            const stored = await chrome.storage.session.get(null);
            const obsolete = Object.keys(stored).filter(
              (storedKey) =>
                storedKey !== key &&
                storedKey.startsWith(`grokOperation:${tabId}:`) &&
                Date.now() - stored[storedKey]?.updatedAt > 36e5,
            );
            if (obsolete.length) await chrome.storage.session.remove(obsolete);
            await chrome.storage.session.set({
              [key]: { requestId, stage: "dispatched", updatedAt: Date.now() },
            });
          }
        }
        const resp = await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, payload, (r) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error: chrome.runtime.lastError.message,
              });
              return;
            }
            resolve(r || { success: false, error: "NO_RESPONSE" });
          });
        });
        sendResponse(resp);
      } catch (err) {
        console.error("[TobyFlow] grok:submitAndWait error:", err.message);
        sendResponse({
          success: false,
          error: "EXCEPTION",
          message: err.message,
        });
      }
    })();
    return true;
  }
  if (message.action === "grok:navigated") {
    if (!sender.tab) {
      sendResponse({ success: true, skipped: true });
      return true;
    }
    const tabId = sender.tab.id;
    chrome.runtime
      .sendMessage({
        action: "grok:navigatedBroadcast",
        tabId,
        url: message.url,
      })
      .catch(() => {});
    sendResponse({ success: true });
    return true;
  }
  if (message.action === "grok:getTabInfo") {
    const { tabId } = message;
    (async () => {
      try {
        if (!tabId) {
          sendResponse({ success: false, error: "NO_TAB" });
          return;
        }
        const tabInfo = await chrome.tabs.get(tabId);
        sendResponse({
          success: true,
          url: tabInfo.url || null,
          active: !!tabInfo.active,
          status: tabInfo.status,
        });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
  return false;
}
chrome.runtime.onMessage.addListener(handleCoreRuntimeMessage);
chrome.tabs.onRemoved.addListener((tabId) => {
  _museTrackerSnapshotsByTab.delete(tabId);
  _chatgptTrackerSnapshotsByTab.delete(tabId);
  _grokTrackerSnapshotsByTab.delete(tabId);
  chrome.storage?.session
    ?.get(null)
    .then((stored) => {
      const keys = Object.keys(stored).filter((key) =>
        key.startsWith(`grokOperation:${tabId}:`),
      );
      if (keys.length) return chrome.storage.session.remove(keys);
    })
    .catch(() => {});
  chrome.runtime
    .sendMessage({ action: "chatgpt:tabClosed", tabId })
    .catch(() => {});
  chrome.runtime
    .sendMessage({ action: "grok:tabClosed", tabId })
    .catch(() => {});
  chrome.storage?.session
    ?.get(["targetFlowTabId", "targetFlowContext"])
    .then((state) => {
      if (
        state.targetFlowTabId === tabId ||
        state.targetFlowContext?.tabId === tabId
      ) {
        return chrome.storage.session.remove([
          "targetFlowTabId",
          "targetFlowContext",
        ]);
      }
    })
    .catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isFlowUrl(changeInfo.url)) {
    chrome.storage?.session
      ?.get(["targetFlowTabId", "targetFlowContext"])
      .then((state) => {
        if (
          state.targetFlowTabId === tabId ||
          state.targetFlowContext?.tabId === tabId
        ) {
          return chrome.storage.session.remove([
            "targetFlowTabId",
            "targetFlowContext",
          ]);
        }
      })
      .catch(() => {});
  }
  if (changeInfo.status !== "complete") return;
  if (!tab || !tab.url || !tab.url.includes("grok.com")) return;
  chrome.runtime
    .sendMessage({ action: "grok:navigatedBroadcast", tabId, url: tab.url })
    .catch(() => {});
});
chrome.commands?.onCommand?.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "command", command });
    }
  });
});
const _PROVIDER_CONFIG_CACHE_KEY = "toby_provider_configs";
const _PROVIDER_CONFIG_TTL_MS = 60 * 60 * 1e3;
async function _getApiBaseUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["af_api_url"], (res) => {
      resolve(
        res?.af_api_url || API_BASE_DEFAULT.replace(/\/api\/v\d+\/?$/, ""),
      );
    });
  });
}
async function _fetchProviderConfigs(forceRefresh = false) {
  const result = await ProtectedConfigClient.envelope("dom", {
    force: forceRefresh,
  });
  return result.success ? result.data : null;
}
const _API_CONFIGS_CACHE_KEY = "toby_provider_api_configs";
const _API_CONFIGS_TTL_MS = 60 * 60 * 1e3;
async function _fetchApiConfigs(forceRefresh = false) {
  const result = await ProtectedConfigClient.envelope("api", {
    force: forceRefresh,
  });
  return result.success ? result.data : null;
}
const _FLOW_BRIDGE_ID = "heieobedadlfdkppgagnhfakcdapbfka";
const _FLOW_DOWNLOAD_PRIVATE_KEYS = [
  "api_endpoints",
  "flow_api_key",
  "captcha_config",
  "api_model_mapping",
  "api_video_model_keys",
  "api_image_ratio_mapping",
  "api_video_ratio_mapping",
  "api_video_resolutions",
  "api_image_input_types",
  "api_image_upsample_resolutions",
  "api_rate_limits",
  "api_error_codes",
  "api_video_edit",
];
let _flowDownloadPrivateCache = null;
let _flowDownloadPrivateEpoch = 0;
let _flowDownloadPrivateAt = 0;
let _flowDownloadPrivateToken = null;
let _flowDownloadPrivateInflight = null;
let _flowDownloadPrivateInflightToken = null;
const _FLOW_DOWNLOAD_PRIVATE_TTL_MS = 60 * 60 * 1e3;
async function _syncFlowApiMaintenanceSetting(settingsOverride = null) {
  try {
    const stored = await chrome.storage.local.get([
      "af_settings",
      "af_system_settings",
    ]);
    const settings =
      settingsOverride && typeof settingsOverride === "object"
        ? settingsOverride
        : stored?.af_settings;
    const runtimeDriver = stored?.af_system_settings?.flow_api_driver;
    const enabledFlag =
      settings?.apiModeEnabled === true ||
      settings?.apiModeEnabled === "true" ||
      settings?.apiModeEnabled === 1;
    const mode = settings?.defaultGenMode || settings?.gen_mode || "web";
    const enabled =
      enabledFlag &&
      (mode === "api" || mode === "auto") &&
      ["v1", "v2", "v2_canary", "auto"].includes(runtimeDriver);
    const response = await _flowDownloadBridgeRequest(
      "set_flow_api_maintenance",
      { enabled },
    );
    if (!response?.ok && response?.error !== "BRIDGE_NOT_INSTALLED") {
      console.info(
        "[Background] Flow API maintenance sync failed:",
        response?.error || "unknown",
      );
    }
    return response?.ok === true;
  } catch (_) {
    return false;
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.af_settings || changes.af_system_settings)) {
    _syncFlowApiMaintenanceSetting(changes.af_settings?.newValue || null).catch(
      () => {},
    );
  }
});
async function _flowDownloadBridgeRequest(method, params = {}) {
  const read = [
    "ping",
    "get_status",
    "flow_resolve_media",
    "flow_v2_resolve_media",
    "flow_v2_poll_operations",
  ].includes(method);
  const mutation = [
    "flow_upscale_image",
    "flow_upscale_video",
    "flow_v2_upscale_image",
    "flow_v2_upscale_video",
  ].includes(method);
  if (!read && !mutation) return _flowDownloadBridgeRequestOnce(method, params);
  try {
    return await FlowApiDownloadRetry.execute(
      () => _flowDownloadBridgeRequestOnce(method, params),
      {
        action: method,
        driver: method.startsWith("flow_v2_") ? "v2" : "v1",
        mutation,
        delayMs: params.runtime?.poll_interval_ms,
        onRetry: async () => {
          if (method.startsWith("flow_v2_") && params.projectId) {
            await _flowDownloadBridgeRequestOnce("flow_v2_health", {
              ...params,
              surface: "gen",
            });
          }
        },
      },
    );
  } catch (error) {
    return {
      ...error,
      ok: false,
      error: error.code || error.error || error.message,
    };
  }
}
async function _flowDownloadBridgeRequestOnce(method, params = {}) {
  return await new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(
        _FLOW_BRIDGE_ID,
        { method, params },
        (response) => {
          const error = chrome.runtime.lastError;
          resolve(
            error
              ? {
                  ok: false,
                  error: "BRIDGE_NOT_INSTALLED",
                  detail: error.message,
                }
              : response || { ok: false, error: "EMPTY_RESPONSE" },
          );
        },
      );
    } catch (error) {
      resolve({ ok: false, error: error?.message || "BRIDGE_SEND_FAILED" });
    }
  });
}
async function _flowApiDownloadPreflight(input = {}) {
  const driver =
    input?.apiDriver === "v1" || input?.apiDriver === "v2"
      ? input.apiDriver
      : input?.legacyV1Provenance === true
        ? "v1"
        : null;
  if (!driver) return { ok: false, error: "FLOW_API_MEDIA_PROVENANCE_MISSING" };
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(
      ["af_auth", "af_settings", "af_entitlements", "af_system_settings"],
      resolve,
    ),
  );
  if (!stored?.af_auth?.token) return { ok: false, error: "AUTH_REQUIRED" };
  const runtimeDriver = stored?.af_system_settings?.flow_api_driver;
  if (runtimeDriver === "disabled" && input.acceptedMonitor !== true) {
    return { ok: false, error: "SYSTEM_DRIVER_DISABLED" };
  }
  if (!["v1", "v2", "v2_canary", "auto"].includes(runtimeDriver)) {
    return { ok: false, error: "SYSTEM_CONFIG_MISSING" };
  }
  const settings = stored?.af_settings;
  const mode = settings?.defaultGenMode || settings?.gen_mode;
  if (input?.requireUpscale) {
    if (!settings || typeof settings !== "object")
      return { ok: false, error: "FLOW_API_SETTINGS_MISSING" };
    const apiEnabled =
      settings.apiModeEnabled === true ||
      settings.apiModeEnabled === "true" ||
      settings.apiModeEnabled === 1;
    if (!apiEnabled) return { ok: false, error: "FLOW_API_SETTING_DISABLED" };
    if (mode !== "api" && mode !== "auto")
      return { ok: false, error: "FLOW_API_MODE_DISABLED" };
  }
  const entitlement = stored?.af_entitlements?.entitlements?.flow_api_enabled;
  let entitled =
    entitlement?.value === true ||
    entitlement?.value === 1 ||
    entitlement?.value === "1";
  if (!entitlement) {
    const access = await _featureAllowed("flow_api_enabled");
    entitled = access.loggedIn && access.allowed;
  }
  if (!entitled) return { ok: false, error: "FLOW_API_NOT_ENTITLED" };
  if (driver === "v2") {
    const uuid = (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    const standaloneWebMedia = input.existingWebMedia === true;
    if (
      !uuid(input.mediaId) ||
      !uuid(input.projectId) ||
      (!standaloneWebMedia &&
        (!uuid(input.operationId) ||
          !Number.isInteger(Number(input.protocolRevision)) ||
          Number(input.protocolRevision) < 1 ||
          typeof input.protocolFingerprint !== "string" ||
          !input.protocolFingerprint))
    ) {
      return { ok: false, error: "V2_DOWNLOAD_LINEAGE_MISSING" };
    }
    const ping = await _flowDownloadBridgeRequest("ping");
    if (!ping?.ok)
      return { ok: false, error: ping?.error || "BRIDGE_NOT_INSTALLED" };
    if (
      !ping.capabilities?.includes(
        input.requireUpscale
          ? input.mediaType === "video"
            ? "flow_v2_upscale_video"
            : "flow_v2_upscale_image"
          : "flow_v2_resolve_media",
      )
    )
      return { ok: false, error: "V2_BRIDGE_CAPABILITY_MISSING" };
    return { ok: true, driver, mode };
  }
  const requiredCapability = input?.requireUpscale
    ? input?.mediaType === "video"
      ? "flow_upscale_video"
      : "flow_upscale_image"
    : null;
  if (requiredCapability) {
    const ping = await _flowDownloadBridgeRequest("ping");
    if (!ping?.ok)
      return { ok: false, error: ping?.error || "BRIDGE_NOT_INSTALLED" };
    if (
      !Array.isArray(ping.capabilities) ||
      !ping.capabilities.includes(requiredCapability)
    ) {
      return {
        ok: false,
        error: "BRIDGE_CAPABILITY_MISSING",
        capability: requiredCapability,
      };
    }
  }
  const status = await _flowDownloadBridgeRequest("get_status");
  if (!status?.ok)
    return { ok: false, error: status?.error || "BRIDGE_STATUS_UNAVAILABLE" };
  if (!status.tokenReady) return { ok: false, error: "FLOW_TOKEN_NOT_READY" };
  return { ok: true, mode, driver, capability: requiredCapability };
}
async function _flowDownloadConfig() {
  try {
    await ProtectedConfigClient.ready();
  } catch (error) {
    return { ok: false, error: error.code || "CONFIG_ACCESS_REQUIRED" };
  }
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get(["af_auth", _API_CONFIGS_CACHE_KEY], resolve),
  );
  const token = stored?.af_auth?.token || null;
  if (!token) {
    _flowDownloadPrivateCache = null;
    _flowDownloadPrivateAt = 0;
    _flowDownloadPrivateToken = null;
    return { ok: false, error: "AUTH_REQUIRED" };
  }
  const fresh =
    _flowDownloadPrivateCache &&
    _flowDownloadPrivateToken === token &&
    Date.now() - _flowDownloadPrivateAt < _FLOW_DOWNLOAD_PRIVATE_TTL_MS;
  if (!fresh) {
    if (
      !_flowDownloadPrivateInflight ||
      _flowDownloadPrivateInflightToken !== token
    ) {
      const requestToken = token;
      const requestEpoch = _flowDownloadPrivateEpoch;
      let requestPromise;
      requestPromise = (async () => {
        const query = encodeURIComponent(_FLOW_DOWNLOAD_PRIVATE_KEYS.join(","));
        const response = await _signedFetch(
          `${getApiBaseUrl()}/providers/private-configs?keys=${query}`,
          {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${token}`,
              "X-Extension-Id": chrome.runtime.id,
            },
            cache: "no-store",
          },
        );
        if (!response.ok) {
          if (
            [401, 403].includes(response.status) &&
            _flowDownloadPrivateToken === requestToken
          ) {
            _flowDownloadPrivateCache = null;
            _flowDownloadPrivateAt = 0;
            _flowDownloadPrivateToken = null;
          }
          return { ok: false, error: `PRIVATE_CONFIG_HTTP_${response.status}` };
        }
        const json = await response.json();
        const configs = json?.success ? json.data?.flow?.configs || {} : null;
        if (!configs)
          return { ok: false, error: "FLOW_PRIVATE_CONFIG_INVALID" };
        const authNow = await new Promise((resolve) =>
          chrome.storage.local.get(["af_auth"], resolve),
        );
        if (authNow?.af_auth?.token !== requestToken)
          return { ok: false, error: "AUTH_CHANGED" };
        if (requestEpoch !== _flowDownloadPrivateEpoch)
          return { ok: false, error: "CONFIG_SCOPE_CHANGED" };
        _flowDownloadPrivateCache = configs;
        _flowDownloadPrivateAt = Date.now();
        _flowDownloadPrivateToken = requestToken;
        return { ok: true };
      })()
        .catch((error) => ({
          ok: false,
          error: error?.message || "PRIVATE_CONFIG_FETCH_FAILED",
        }))
        .finally(() => {
          if (_flowDownloadPrivateInflight === requestPromise) {
            _flowDownloadPrivateInflight = null;
            _flowDownloadPrivateInflightToken = null;
          }
        });
      _flowDownloadPrivateInflight = requestPromise;
      _flowDownloadPrivateInflightToken = requestToken;
    }
    const loaded = await _flowDownloadPrivateInflight;
    if (!loaded?.ok) return loaded;
  }
  const config = { ..._flowDownloadPrivateCache };
  if (!config.api_endpoints || !config.flow_api_key || !config.captcha_config) {
    return { ok: false, error: "FLOW_API_CONFIG_MISSING" };
  }
  return { ok: true, config, source: "private-gated" };
}
async function _sendFlowMetadataRead(tabId, payload) {
  if (!["scanFlowImages", "getThumbnailsByIds"].includes(payload?.action))
    throw Object.assign(new Error("FLOW_METADATA_ACTION_INVALID"), {
      code: "FLOW_METADATA_ACTION_INVALID",
      noRetry: true,
    });
  const stored = await chrome.storage.local.get("af_system_settings");
  const ack = Number(stored?.af_system_settings?.api_timeout_ms);
  const remaining = Number.isFinite(payload.metadataDeadline)
    ? Math.max(0, payload.metadataDeadline - Date.now())
    : 0;
  const timeoutMs = ack + remaining;
  if (
    !Number.isSafeInteger(ack) ||
    ack <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs > 2147483647
  )
    throw Object.assign(new Error("FLOW_COMMAND_TIMEOUT_CONFIG_UNAVAILABLE"), {
      code: "FLOW_COMMAND_TIMEOUT_CONFIG_UNAVAILABLE",
      noRetry: true,
    });
  const expected = payload.expectedFlowTarget || payload._flowTarget;
  let timer,
    response = null,
    active = true;
  const started = Date.now(),
    deadline = started + timeoutMs;
  const timeoutError = () =>
    Object.assign(new Error("FLOW_COMMAND_ACK_TIMEOUT"), {
      code: "FLOW_COMMAND_ACK_TIMEOUT",
      noRetry: true,
    });
  const assertActive = () => {
    if (!active || Date.now() >= deadline) throw timeoutError();
  };
  try {
    const read = (async () => {
      response = await chrome.tabs.sendMessage(tabId, payload);
      assertActive();
      if (!response)
        throw Object.assign(new Error("FLOW_CONTENT_NO_RESPONSE"), {
          code: "FLOW_CONTENT_NO_RESPONSE",
          noRetry: true,
        });
      if (expected) {
        const current = describeFlowTab(await chrome.tabs.get(tabId));
        assertActive();
        if (
          !current ||
          ["projectId", "origin", "driverKey", "routePrefix"].some(
            (field) => (current[field] || null) !== (expected[field] || null),
          ) ||
          (response.projectId && response.projectId !== expected.projectId)
        )
          throw Object.assign(new Error("FLOW_EXECUTION_TARGET_CHANGED"), {
            code: "FLOW_EXECUTION_TARGET_CHANGED",
            noRetry: true,
          });
      }
      return response;
    })();
    return await Promise.race([
      read,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    active = false;
    response = null;
    clearTimeout(timer);
    console.info?.(
      "[FlowMetadataRead]",
      JSON.stringify({
        action: payload.action,
        elapsedMs: Date.now() - started,
        timeoutMs,
      }),
    );
  }
}
const _spaceRescanOperations = new Map();
const _spacePickerSessions = new Map();
const _spaceResetFlights = new Map();
const _spaceQueueFlights = new Map();
async function handleSpaceQueue(message, sender) {
  const key = JSON.stringify([
    sender.tab?.id,
    sender.documentId,
    message.userId,
    message.operationId || "read",
    message.workflowId,
  ]);
  const signature = JSON.stringify([
    message.queueAction,
    message.nodeId,
    message.jobId,
    message.runId,
  ]);
  const previous = _spaceQueueFlights.get(key);
  if (previous) {
    if (previous.signature !== signature)
      throw Error("QUEUE_OPERATION_CONFLICT");
    return previous.promise;
  }
  const promise = handleSpaceQueueOnce(message, sender);
  _spaceQueueFlights.set(key, { signature, promise });
  try {
    return await promise;
  } finally {
    if (_spaceQueueFlights.get(key)?.promise === promise)
      _spaceQueueFlights.delete(key);
  }
}
async function handleSpaceQueueOnce(message, sender) {
  let dispatchStarted = false;
  try {
    const auth = (await chrome.storage.local.get("af_auth")).af_auth,
      userId = String(auth?.user?.id || "");
    if (!auth?.token || !userId || userId !== String(message.userId || ""))
      throw Error("QUEUE_ACCOUNT_MISMATCH");
    if (
      typeof message.workflowId !== "string" ||
      !message.workflowId ||
      message.workflowId.length > 255 ||
      !["read", "start", "status"].includes(message.operation) ||
      !["read", "resume", "stop"].includes(message.queueAction) ||
      (message.operation === "read") !== (message.queueAction === "read")
    )
      throw Error("INVALID_QUEUE_SCOPE");
    const current = async () => {
      const now = (await chrome.storage.local.get("af_auth")).af_auth;
      if (now?.token !== auth.token || String(now?.user?.id || "") !== userId)
        throw Error("QUEUE_ACCOUNT_CHANGED");
    };
    const origin = new URL(sender.origin || sender.url).origin;
    const scope = {
      queueAction: message.queueAction,
      nodeId: message.nodeId || null,
      jobId: message.jobId || null,
      runId: message.runId || null,
      operationId: message.operationId || null,
    };
    if (
      message.operation !== "read" &&
      (["nodeId", "jobId", "runId", "operationId"].some(
        (field) =>
          typeof message[field] !== "string" ||
          !message[field] ||
          message[field].length > 255,
      ) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          message.operationId,
        ))
    )
      throw Error("INVALID_QUEUE_SCOPE");
    const signature = JSON.stringify([
      sender.tab?.id,
      sender.documentId,
      origin,
      userId,
      message.workflowId,
      scope,
    ]);
    const key = `workflow_space_queue:${userId}:${message.operationId}`;
    const journal =
      message.operation === "read"
        ? null
        : (await chrome.storage.session.get(key))[key];
    dispatchStarted = !!journal;
    if (journal && journal.signature !== signature)
      throw Error("QUEUE_OPERATION_CONFLICT");
    if (journal?.response) return journal.response;
    if (!journal && message.operation === "status")
      return { ok: false, error: "QUEUE_RESULT_UNKNOWN" };
    let documentId = journal?.documentId;
    if (!journal) {
      const proof = await _signedFetch(
        `${getApiBaseUrl()}/workflows/${encodeURIComponent(message.workflowId)}/space-queue-grants/verify`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${auth.token}`,
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Extension-Id": chrome.runtime.id,
          },
          body: JSON.stringify({ grant: message.grant, origin, ...scope }),
          cache: "no-store",
          signal: AbortSignal.timeout(2e4),
        },
      );
      if (!proof.ok || (await proof.json())?.success !== true)
        throw Error("QUEUE_AUTHORIZATION_FAILED");
      await current();
      const allowed = [
        "sidebar.html",
        "workflow-editor.html",
        "run-window.html",
      ].map((path) => chrome.runtime.getURL(path));
      for (const context of (await chrome.runtime.getContexts({})).filter(
        (item) =>
          item.documentId &&
          allowed.includes(String(item.documentUrl || "").split(/[?#]/)[0]),
      )) {
        const probe = await chrome.runtime
          .sendMessage({
            action: "workflowSpaceNativeQueue",
            documentId: context.documentId,
            operation: "read",
            workflowId: message.workflowId,
            userId,
          })
          .catch(() => null);
        await current();
        if (probe?.ok !== true) continue;
        if (message.operation === "read") {
          if (probe.nodes?.length) return probe;
          continue;
        }
        const pause = probe.nodes?.find(
          (node) => node.nodeId === message.nodeId,
        )?.pause;
        if (pause?.jobId === message.jobId && pause?.runId === message.runId) {
          documentId = context.documentId;
          break;
        }
      }
      if (message.operation === "read") return { ok: true, nodes: [] };
      if (!documentId)
        return { ok: false, stage: "failed", error: "QUEUE_PAUSE_CHANGED" };
      await chrome.storage.session.set({
        [key]: { signature, documentId, phase: "dispatched" },
      });
    }
    await current();
    dispatchStarted = true;
    const response = await chrome.runtime
      .sendMessage({
        action: "workflowSpaceNativeQueue",
        documentId,
        operation: journal ? "status" : "start",
        workflowId: message.workflowId,
        userId,
        ...scope,
      })
      .catch(() => null);
    await current();
    if (
      response &&
      (response.stage === "done" || response.stage === "failed")
    ) {
      await chrome.storage.session.set({
        [key]: { signature, documentId, response },
      });
    }
    return response || { ok: false, error: "QUEUE_RESULT_UNKNOWN" };
  } catch (error) {
    if (!dispatchStarted && message.operation === "start")
      return {
        ok: false,
        stage: "failed",
        dispatchStarted: false,
        error: error?.message || "QUEUE_ACTION_FAILED",
      };
    throw error;
  }
}
const _spaceDownloadFlights = new Map();
async function handleSpaceDownload(message, sender) {
  const key = JSON.stringify([message.userId, message.operationId]);
  const signature = JSON.stringify([
    sender.tab?.id,
    sender.documentId,
    sender.origin || sender.url,
    message.workflowId,
    message.ownerNodeId,
    message.fileId,
    message.source,
    message.resolution,
    message.watermarkMode,
    ...(message.originalOnly === true ? ["original-only"] : []),
    ...(message.selectionFileIds ? [message.selectionFileIds] : []),
  ]);
  const flight = _spaceDownloadFlights.get(key);
  if (flight) {
    if (flight.signature !== signature)
      throw new Error("DOWNLOAD_OPERATION_CONFLICT");
    if (message.operation === "cancel") {
      await flight.promise.catch(() => {});
      return handleSpaceDownloadOnce(message, sender);
    }
    return flight.promise;
  }
  const promise = handleSpaceDownloadOnce(message, sender);
  _spaceDownloadFlights.set(key, { signature, promise });
  try {
    return await promise;
  } finally {
    if (_spaceDownloadFlights.get(key)?.promise === promise)
      _spaceDownloadFlights.delete(key);
  }
}
async function handleSpaceDownloadOnce(message, sender) {
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  const userId = String(auth?.user?.id || "");
  if (!auth?.token || !userId || userId !== String(message.userId || ""))
    throw new Error("DOWNLOAD_ACCOUNT_MISMATCH");
  const fields = [
    "workflowId",
    "ownerNodeId",
    "fileId",
    "operationId",
    "resolution",
  ];
  if (
    fields.some(
      (key2) =>
        typeof message[key2] !== "string" ||
        !message[key2] ||
        message[key2].length > (key2 === "fileId" ? 1024 : 255),
    ) ||
    !["start", "status", "cancel"].includes(message.operation) ||
    !["original", "flow"].includes(message.source) ||
    !["inherit", "clean", "original"].includes(message.watermarkMode) ||
    (message.originalOnly === true && message.source !== "original") ||
    (message.selectionFileIds !== void 0 &&
      (!Array.isArray(message.selectionFileIds) ||
        !message.selectionFileIds.length ||
        message.selectionFileIds.some(
          (id) => typeof id !== "string" || !id || id.length > 1024,
        )))
  )
    throw new Error("INVALID_DOWNLOAD_SCOPE");
  const origin = new URL(sender.origin || sender.url).origin;
  const signature = JSON.stringify([
    sender.tab?.id,
    sender.documentId,
    origin,
    userId,
    ...fields.map((key2) => message[key2]),
    message.source,
    message.watermarkMode,
    ...(message.originalOnly === true ? ["original-only"] : []),
    ...(message.selectionFileIds ? [message.selectionFileIds] : []),
  ]);
  const key = `workflow_space_download:${userId}:${message.operationId}`;
  const journal = (await chrome.storage.session.get(key))[key];
  if (journal && journal.signature !== signature)
    throw new Error("DOWNLOAD_OPERATION_CONFLICT");
  if (!journal && message.operation !== "start")
    return { ok: false, error: "DOWNLOAD_RESULT_UNKNOWN" };
  if (
    journal?.response &&
    ["done", "failed", "needs_flow_selection"].includes(journal.response.stage)
  )
    return journal.response;
  let documentId = journal?.documentId;
  if (!journal) {
    const proof = await _signedFetch(
      `${getApiBaseUrl()}/workflows/${encodeURIComponent(message.workflowId)}/space-artifact-grants/verify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Extension-Id": chrome.runtime.id,
        },
        body: JSON.stringify({
          grant: message.grant,
          origin,
          ownerNodeId: message.ownerNodeId,
          fileId: message.fileId,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(2e4),
      },
    );
    if (!proof.ok || (await proof.json())?.success !== true)
      throw new Error("DOWNLOAD_AUTHORIZATION_FAILED");
    const allowed = [
      "workflow-editor.html",
      "sidebar.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    const contexts = (await chrome.runtime.getContexts({}))
      .filter(
        (item) =>
          item.documentId &&
          allowed.includes(String(item.documentUrl || "").split(/[?#]/)[0]),
      )
      .sort(
        (a, b) =>
          allowed.indexOf(String(a.documentUrl).split(/[?#]/)[0]) -
          allowed.indexOf(String(b.documentUrl).split(/[?#]/)[0]),
      );
    for (const context of contexts) {
      const probe = await chrome.runtime
        .sendMessage({
          action: "workflowSpaceNativeDownloadProbe",
          documentId: context.documentId,
          userId,
        })
        .catch(() => null);
      if (probe?.ok === true) {
        documentId = context.documentId;
        break;
      }
    }
    if (!documentId)
      return { ok: false, error: "NATIVE_DOWNLOAD_CONTEXT_REQUIRED" };
    const raced = (await chrome.storage.session.get(key))[key];
    if (raced) {
      if (raced.signature !== signature)
        throw new Error("DOWNLOAD_OPERATION_CONFLICT");
      return { ok: false, error: "DOWNLOAD_RESULT_UNKNOWN" };
    }
    const beforeClaim = (await chrome.storage.local.get("af_auth")).af_auth;
    if (
      beforeClaim?.token !== auth.token ||
      String(beforeClaim?.user?.id || "") !== userId
    )
      throw new Error("DOWNLOAD_ACCOUNT_CHANGED");
    await chrome.storage.session.set({
      [key]: { signature, documentId, phase: "dispatched" },
    });
  }
  const current = (await chrome.storage.local.get("af_auth")).af_auth;
  if (
    current?.token !== auth.token ||
    String(current?.user?.id || "") !== userId
  )
    throw new Error("DOWNLOAD_ACCOUNT_CHANGED");
  const action =
    message.operation === "cancel"
      ? "workflowSpaceNativeDownloadCancel"
      : journal
        ? "workflowSpaceNativeDownloadStatus"
        : "workflowSpaceNativeDownload";
  const response = await chrome.runtime
    .sendMessage({
      action,
      documentId,
      userId,
      workflowId: message.workflowId,
      ownerNodeId: message.ownerNodeId,
      fileId: message.fileId,
      operationId: message.operationId,
      source: message.source,
      resolution: message.resolution,
      watermarkMode: message.watermarkMode,
      index: message.index,
      originalOnly: message.originalOnly === true,
      selectionFileIds: message.selectionFileIds,
    })
    .catch(() => null);
  const finalAuth = (await chrome.storage.local.get("af_auth")).af_auth;
  if (
    finalAuth?.token !== auth.token ||
    String(finalAuth?.user?.id || "") !== userId
  )
    throw new Error("DOWNLOAD_ACCOUNT_CHANGED");
  if (
    response &&
    ["done", "failed", "needs_flow_selection"].includes(response.stage)
  )
    await chrome.storage.session.set({
      [key]: { signature, documentId, phase: "completed", response },
    });
  return response || { ok: false, error: "DOWNLOAD_RESULT_UNKNOWN" };
}
async function handleSpaceResetCleanup(message, sender) {
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  const userId = String(auth?.user?.id || "");
  if (
    !auth?.token ||
    !userId ||
    userId !== String(message.userId) ||
    typeof message.grant !== "string" ||
    typeof message.workflowId !== "string" ||
    typeof message.operationId !== "string" ||
    !Array.isArray(message.nodeIds)
  )
    throw new Error("INVALID_RESET_CLEANUP_SCOPE");
  const origin = new URL(sender.origin || sender.url).origin;
  const proof = await _signedFetch(
    `${getApiBaseUrl()}/workflows/${encodeURIComponent(message.workflowId)}/space-reset-grants/verify`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Extension-Id": chrome.runtime.id,
      },
      body: JSON.stringify({
        grant: message.grant,
        origin,
        operationId: message.operationId,
        nodeIds: message.nodeIds,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(2e4),
    },
  );
  if (!proof.ok || (await proof.json())?.success !== true)
    throw new Error("SPACE_RESET_AUTHORIZATION_FAILED");
  const allowed = [
    "sidebar.html",
    "workflow-editor.html",
    "run-window.html",
  ].map((path) => chrome.runtime.getURL(path));
  const contexts = await chrome.runtime.getContexts({});
  const context = contexts.find(
    (item) =>
      item.documentId &&
      allowed.includes(String(item.documentUrl || "").split(/[?#]/)[0]),
  );
  if (!context) return { ok: false, error: "RESET_CLEANUP_PENDING" };
  const current = (await chrome.storage.local.get("af_auth")).af_auth;
  if (
    current?.token !== auth.token ||
    String(current?.user?.id || "") !== userId
  )
    throw new Error("SPACE_RESET_ACCOUNT_CHANGED");
  const response = await chrome.runtime
    .sendMessage({
      action: "workflowSpaceNativeResetCleanup",
      documentId: context.documentId,
      workflowId: message.workflowId,
      userId,
      nodeIds: message.nodeIds,
      operationId: message.operationId,
      grant: message.grant,
      origin,
    })
    .catch(() => null);
  const finalAuth = (await chrome.storage.local.get("af_auth")).af_auth;
  return finalAuth?.token === auth.token &&
    String(finalAuth?.user?.id || "") === userId
    ? response || { ok: false, error: "RESET_CLEANUP_PENDING" }
    : { ok: false, error: "SPACE_RESET_ACCOUNT_CHANGED" };
}
async function handleSpaceResetProgress(message, sender) {
  const flight = _spaceResetFlights.get(
    `workflow_space_reset:${message.userId}:${message.operationId}`,
  );
  const documentId = await resolveNativeWorkflowDocument(sender);
  if (
    !documentId ||
    documentId !== flight?.trace?.documentId ||
    message.workflowId !== flight?.trace?.workflowId
  )
    return { ok: false };
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  if (!auth?.token || String(auth.user?.id || "") !== String(message.userId))
    return { ok: false };
  if (
    typeof message.stage !== "string" ||
    !/^[a-z_]{1,60}$/.test(message.stage)
  )
    return { ok: false };
  flight.report(`native_${message.stage}`, {
    code: message.code,
    httpStatus: message.httpStatus,
  });
  return { ok: true };
}
async function handleSpaceReset(message, sender) {
  const startedAt = Date.now();
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  const userId = String(auth?.user?.id || "");
  if (!auth?.token || !userId || userId !== String(message.userId))
    throw new Error("SPACE_RESET_ACCOUNT_MISMATCH");
  if (
    typeof message.grant !== "string" ||
    !message.grant ||
    typeof message.workflowId !== "string" ||
    !message.workflowId ||
    typeof message.operationId !== "string" ||
    !/^[a-z0-9-]{1,128}$/i.test(message.operationId) ||
    !Array.isArray(message.nodeIds) ||
    !message.nodeIds.length ||
    message.nodeIds.some(
      (id) => typeof id !== "string" || !id || id.length > 255,
    )
  )
    throw new Error("INVALID_RESET_SCOPE");
  if (
    message.scope != null &&
    !["single", "selection", "workflow"].includes(message.scope)
  )
    throw new Error("INVALID_RESET_SCOPE");
  const nodeIds = [...new Set(message.nodeIds)].sort();
  const owner = `${sender.tab?.id}:${sender.documentId || ""}:${new URL(sender.origin || sender.url).origin}`;
  const signature = JSON.stringify([
    owner,
    userId,
    message.workflowId,
    nodeIds,
    message.grant,
    message.allowRunningSingle === true,
    message.forceStop === true,
    ...(message.scope ? [message.scope] : []),
  ]);
  const key = `workflow_space_reset:${userId}:${message.operationId}`;
  const trace = { workflowId: message.workflowId, documentId: null };
  const report = (stage, detail = {}) => {
    try {
      const diagnostic = {
        operationId: message.operationId,
        workflowId: message.workflowId,
        stage,
        timestamp: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        nodeCount: nodeIds.length,
      };
      if (
        typeof detail.code === "string" &&
        /^[A-Z][A-Z0-9_]{0,99}$/.test(detail.code)
      )
        diagnostic.code = detail.code;
      if (
        Number.isInteger(detail.httpStatus) &&
        detail.httpStatus >= 100 &&
        detail.httpStatus <= 599
      )
        diagnostic.httpStatus = detail.httpStatus;
      if (trace.documentId) diagnostic.nativeDocumentId = trace.documentId;
      console.info("[SpaceResetBridge]", JSON.stringify(diagnostic));
      if (Number.isInteger(sender.tab?.id) && sender.documentId) {
        chrome.tabs
          ?.sendMessage?.(
            sender.tab.id,
            { action: "workflowSpaceResetDebug", diagnostic },
            { documentId: sender.documentId },
          )
          ?.catch?.(() => {});
      }
    } catch (_) {}
  };
  report("received");
  const previous = (await chrome.storage.session.get(key))[key];
  const running = _spaceResetFlights.get(key);
  if (running) {
    if (running.signature !== signature)
      throw new Error("RESET_OPERATION_CONFLICT");
    return running.promise;
  }
  if (previous) {
    if (previous.signature !== signature)
      throw new Error("RESET_OPERATION_CONFLICT");
    if (!previous.response && previous.documentId) {
      const status = await chrome.runtime
        .sendMessage({
          action: "workflowSpaceNativeResetStatus",
          documentId: previous.documentId,
          workflowId: message.workflowId,
          userId,
          nodeIds,
          operationId: message.operationId,
          ...(message.scope ? { scope: message.scope } : {}),
          allowRunningSingle: message.allowRunningSingle === true,
          forceStop: message.forceStop === true,
        })
        .catch(() => null);
      const current = (await chrome.storage.local.get("af_auth")).af_auth;
      if (
        current?.token !== auth.token ||
        String(current?.user?.id || "") !== userId
      )
        throw new Error("SPACE_RESET_ACCOUNT_CHANGED");
      if (status && status.error !== "BRIDGE_RESULT_UNKNOWN") {
        await chrome.storage.session.set({
          [key]: { ...previous, phase: "completed", response: status },
        });
        return status;
      }
    }
    return (
      previous.response || {
        ok: false,
        error: "BRIDGE_RESULT_UNKNOWN",
        dispatchStarted: true,
      }
    );
  }
  const flight = (async () => {
    report("verify_requested");
    const proofResponse = await _signedFetch(
      `${getApiBaseUrl()}/workflows/${encodeURIComponent(message.workflowId)}/space-reset-grants/verify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Extension-Id": chrome.runtime.id,
        },
        body: JSON.stringify({
          grant: message.grant,
          origin: new URL(sender.origin || sender.url).origin,
          operationId: message.operationId,
          nodeIds,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(2e4),
      },
    );
    report("verify_received", { httpStatus: proofResponse.status });
    if (!proofResponse.ok || (await proofResponse.json())?.success !== true)
      throw new Error("SPACE_RESET_AUTHORIZATION_FAILED");
    const allowed = [
      "sidebar.html",
      "workflow-editor.html",
      "run-window.html",
    ].map((path) => chrome.runtime.getURL(path));
    report("contexts_requested");
    const contexts = await chrome.runtime.getContexts({});
    const context = contexts
      .filter(
        (item) =>
          item.documentId &&
          allowed.includes(String(item.documentUrl || "").split(/[?#]/)[0]),
      )
      .sort(
        (a, b) =>
          allowed.indexOf(a.documentUrl.split(/[?#]/)[0]) -
          allowed.indexOf(b.documentUrl.split(/[?#]/)[0]),
      )[0];
    if (!context) return { ok: false, error: "NATIVE_RESET_CONTEXT_REQUIRED" };
    trace.documentId = context.documentId;
    report("context_selected");
    const current = (await chrome.storage.local.get("af_auth")).af_auth;
    if (
      current?.token !== auth.token ||
      String(current?.user?.id || "") !== userId
    )
      throw new Error("SPACE_RESET_ACCOUNT_CHANGED");
    await chrome.storage.session.set({
      [key]: {
        signature,
        at: Date.now(),
        phase: "dispatched",
        documentId: context.documentId,
      },
    });
    report("native_dispatched");
    let response = await chrome.runtime
      .sendMessage({
        action: "workflowSpaceNativeReset",
        documentId: context.documentId,
        workflowId: message.workflowId,
        userId,
        nodeIds,
        operationId: message.operationId,
        grant: message.grant,
        origin: new URL(sender.origin || sender.url).origin,
        ...(message.scope ? { scope: message.scope } : {}),
        allowRunningSingle: message.allowRunningSingle === true,
        forceStop: message.forceStop === true,
      })
      .catch(() => null);
    if (!response)
      response = {
        ok: false,
        error: "BRIDGE_RESULT_UNKNOWN",
        dispatchStarted: true,
      };
    report("native_received", { code: response.error });
    await chrome.storage.session.set({
      [key]: {
        signature,
        at: Date.now(),
        phase: "completed",
        documentId: context.documentId,
        ...(response.error === "BRIDGE_RESULT_UNKNOWN" ? {} : { response }),
      },
    });
    const finalAuth = (await chrome.storage.local.get("af_auth")).af_auth;
    return finalAuth?.token === auth.token &&
      String(finalAuth?.user?.id || "") === userId
      ? response
      : { ok: false, error: "SPACE_RESET_ACCOUNT_CHANGED" };
  })();
  _spaceResetFlights.set(key, { signature, promise: flight, trace, report });
  try {
    return await flight;
  } catch (error) {
    report("failed", { code: error?.code || error?.message });
    throw error;
  } finally {
    if (_spaceResetFlights.get(key)?.promise === flight)
      _spaceResetFlights.delete(key);
  }
}
async function handleSpacePicker(message, sender) {
  const auth = (await chrome.storage.local.get("af_auth")).af_auth;
  const userId = String(auth?.user?.id || ""),
    origin = new URL(sender.origin || sender.url).origin;
  if (!auth?.token || !userId || userId !== String(message.userId))
    throw new Error("SPACE_PICKER_ACCOUNT_MISMATCH");
  if (
    typeof message.workflowId !== "string" ||
    !message.workflowId ||
    typeof message.grant !== "string"
  )
    throw new Error("INVALID_PICKER_SCOPE");
  const owner = `${sender.tab?.id}:${sender.documentId || ""}:${origin}`;
  for (const [id, session2] of _spacePickerSessions)
    if (
      session2.expires <= Date.now() ||
      session2.userId !== userId ||
      session2.token !== auth.token
    )
      _spacePickerSessions.delete(id);
  const current = async () => {
    const live = (await chrome.storage.local.get("af_auth")).af_auth;
    if (live?.token !== auth.token || String(live?.user?.id || "") !== userId)
      throw new Error("SPACE_PICKER_ACCOUNT_CHANGED");
  };
  let session = _spacePickerSessions.get(message.sessionId),
    sessionId = message.sessionId;
  if (message.operation === "open") {
    const response = await _signedFetch(
      `${getApiBaseUrl()}/workflows/${encodeURIComponent(message.workflowId)}/space-picker-grants/verify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Extension-Id": chrome.runtime.id,
        },
        body: JSON.stringify({ grant: message.grant, origin }),
        cache: "no-store",
        signal: AbortSignal.timeout(2e4),
      },
    );
    const proof = await response.json();
    if (
      !response.ok ||
      proof?.success !== true ||
      !Number.isFinite(proof.expires)
    )
      throw new Error("SPACE_PICKER_AUTHORIZATION_FAILED");
    await current();
    const allowed = ["sidebar.html", "workflow-editor.html"].map((path) =>
      chrome.runtime.getURL(path),
    );
    const contexts = await chrome.runtime.getContexts({});
    const context = contexts
      .filter(
        (item) =>
          item.documentId &&
          allowed.includes(String(item.documentUrl || "").split(/[?#]/)[0]),
      )
      .sort(
        (a, b) =>
          allowed.indexOf(a.documentUrl.split(/[?#]/)[0]) -
          allowed.indexOf(b.documentUrl.split(/[?#]/)[0]),
      )[0];
    if (!context) throw new Error("NATIVE_PICKER_CONTEXT_REQUIRED");
    sessionId = crypto.randomUUID();
    session = {
      owner,
      userId,
      token: auth.token,
      workflowId: message.workflowId,
      grant: message.grant,
      documentId: context.documentId,
      expires: proof.expires * 1e3,
    };
    _spacePickerSessions.set(sessionId, session);
  }
  if (
    !session ||
    session.owner !== owner ||
    session.workflowId !== message.workflowId ||
    session.grant !== message.grant
  )
    throw new Error("SPACE_PICKER_SESSION_EXPIRED");
  const operation = message.operation === "open" ? "list" : message.operation;
  if (!["list", "thumbnail", "select", "resume", "release"].includes(operation))
    throw new Error("INVALID_PICKER_OPERATION");
  if (operation === "select" || operation === "resume") {
    const response = await _signedFetch(
      `${getApiBaseUrl()}/workflows/${encodeURIComponent(message.workflowId)}/space-picker-grants/verify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Extension-Id": chrome.runtime.id,
        },
        body: JSON.stringify({ grant: message.grant, origin }),
        cache: "no-store",
        signal: AbortSignal.timeout(2e4),
      },
    );
    const proof = await response.json();
    if (!response.ok || proof?.success !== true)
      throw new Error("SPACE_PICKER_AUTHORIZATION_FAILED");
    await current();
  }
  const result = await chrome.runtime
    .sendMessage({
      action: "workflowSpaceNativePicker",
      documentId: session.documentId,
      userId,
      sessionId,
      operation,
      imageId: message.imageId,
      operationId: message.operationId,
    })
    .catch(() => ({ ok: false, error: "NATIVE_PICKER_CONTEXT_CLOSED" }));
  await current();
  if (
    operation === "release" ||
    [
      "NATIVE_PICKER_CONTEXT_CLOSED",
      "ACCOUNT_CHANGED",
      "PICKER_SESSION_EXPIRED",
    ].includes(result?.error)
  )
    _spacePickerSessions.delete(sessionId);
  return { ...result, sessionId };
}
async function readSpaceFlowMode(message) {
  const stored = await chrome.storage.local.get([
    "af_auth",
    "af_settings",
    "af_settings_owner",
    "af_system_settings",
  ]);
  const auth = stored.af_auth;
  if (
    !auth?.token ||
    !auth?.user?.id ||
    String(auth.user.id) !== String(message.userId)
  )
    throw Error("ACCOUNT_MISMATCH");
  const owner = stored.af_settings_owner?.user_id;
  const sameOwner = owner == null || String(owner) === String(auth.user.id);
  const value = sameOwner ? stored.af_settings?.apiModeEnabled : void 0,
    driver = stored.af_system_settings?.flow_api_driver;
  const enabled = [true, 1, "true"].includes(value),
    known = [true, false, 1, 0, "true", "false"].includes(value);
  return {
    selected:
      driver === "disabled" ? "web" : known ? (enabled ? "api" : "web") : null,
    driver: ["v1", "v2", "v2_canary", "auto"].includes(driver) ? driver : null,
  };
}
async function readSpaceNativeContext(message) {
  if (
    typeof message.workflowId !== "string" ||
    !message.workflowId ||
    message.workflowId.length > 150
  )
    return { ok: false, error: "INVALID_CONTEXT_SCOPE" };
  const stored = await chrome.storage.local.get([
      "af_auth",
      "af_system_settings",
    ]),
    auth = stored.af_auth;
  if (
    !auth?.token ||
    !auth?.user?.id ||
    String(auth.user.id) !== String(message.userId)
  )
    return { ok: false, error: "ACCOUNT_MISMATCH" };
  const timeoutMs = Number(stored.af_system_settings?.api_timeout_ms);
  const pages = ["sidebar.html", "workflow-editor.html", "run-window.html"].map(
    (path) => chrome.runtime.getURL(path),
  );
  const eligible = (list) =>
    list.filter(
      (item) =>
        item.documentId &&
        pages.includes(String(item.documentUrl || "").split(/[?#]/)[0]),
    );
  const before = eligible(await chrome.runtime.getContexts({}));
  if (before.length && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
    return { ok: false, error: "CONTEXT_TIMEOUT_CONFIG_UNAVAILABLE" };
  const probes = await Promise.allSettled(
    before.map(async (candidate) => {
      let timer;
      try {
        return await Promise.race([
          chrome.runtime.sendMessage({
            action: "workflowSpaceNativeHealth",
            documentId: candidate.documentId,
            workflowId: message.workflowId,
            userId: message.userId,
            providers: [],
            probeOnly: true,
            prepare: false,
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const after = eligible(await chrome.runtime.getContexts({}));
  const current = (await chrome.storage.local.get("af_auth")).af_auth;
  if (
    !current?.token ||
    current.token !== auth.token ||
    String(current.user?.id) !== String(auth.user.id)
  )
    return { ok: false, error: "ACCOUNT_CHANGED" };
  const state = (picker) => {
    const candidates = after.filter(
      (item) =>
        !picker || String(item.documentUrl || "").split(/[?#]/)[0] !== pages[2],
    );
    if (!candidates.length) return "missing";
    let initializing = false;
    for (const candidate of candidates) {
      const index = before.findIndex(
        (item) => item.documentId === candidate.documentId,
      );
      if (index < 0) {
        initializing = true;
        continue;
      }
      const probe =
        probes[index]?.status === "fulfilled" ? probes[index].value : null;
      if (
        probe?.ok === true &&
        probe.contextReady === true &&
        (!picker || probe.pickerReady === true)
      )
        return "ready";
      if (
        probe?.error === "NATIVE_CONTEXT_INITIALIZING" ||
        (picker &&
          probe?.ok === true &&
          probe.contextReady === true &&
          probe.pickerReady === false)
      )
        initializing = true;
    }
    return initializing ? "initializing" : "unknown";
  };
  return { ok: true, context: { services: state(false), picker: state(true) } };
}
async function readSpaceNativeHealth(message) {
  const started = Date.now(),
    operationId = crypto.randomUUID();
  const providers = (message.providers || ["flow"]).filter((provider) =>
    ["flow", "chatgpt", "grok", "gemini", "muse"].includes(provider),
  );
  const failure = (error) => ({
    ok: true,
    providers: Object.fromEntries(
      providers.map((provider) => [
        provider,
        { ready: false, tabOpen: false, error },
      ]),
    ),
  });
  const allowed = [
    "sidebar.html",
    "workflow-editor.html",
    "run-window.html",
  ].map((path) => chrome.runtime.getURL(path));
  const contexts = await chrome.runtime.getContexts({});
  const candidates = contexts
    .filter(
      (context2) =>
        context2.documentId &&
        allowed.includes(String(context2.documentUrl || "").split(/[?#]/)[0]),
    )
    .sort(
      (a, b) =>
        allowed.indexOf(a.documentUrl.split(/[?#]/)[0]) -
        allowed.indexOf(b.documentUrl.split(/[?#]/)[0]),
    );
  const discoveryKey = JSON.stringify([
    message.userId,
    message.workflowId,
    candidates.map((item) => item.documentId),
  ]);
  const discoveries =
    readSpaceNativeHealth.discoveryFlights ||
    (readSpaceNativeHealth.discoveryFlights = new Map());
  let discovery = discoveries.get(discoveryKey);
  if (!discovery) {
    discovery = (async () => {
      let context2 = null,
        unavailable2 = "NATIVE_HEALTH_CONTEXT_REQUIRED";
      const outcomes2 = [];
      for (const candidate of candidates) {
        const probe = await chrome.runtime
          .sendMessage({
            action: "workflowSpaceNativeHealth",
            documentId: candidate.documentId,
            workflowId: message.workflowId,
            userId: message.userId,
            providers: [],
            probeOnly: true,
            prepare: false,
          })
          .catch(() => null);
        outcomes2.push({
          page: String(candidate.documentUrl || "")
            .split(/[?#]/)[0]
            .split("/")
            .pop(),
          code:
            probe?.ok === true
              ? "ACK"
              : typeof probe?.error === "string" &&
                  /^[A-Z0-9_]+$/.test(probe.error)
                ? probe.error
                : "NO_ACK",
        });
        if (probe?.ok === true) {
          context2 = candidate;
          break;
        }
        if (probe?.error) unavailable2 = probe.error;
      }
      return {
        context: context2,
        unavailable: unavailable2,
        outcomes: outcomes2,
      };
    })();
    discoveries.set(discoveryKey, discovery);
  }
  let discovered;
  try {
    discovered = await discovery;
  } finally {
    if (discoveries.get(discoveryKey) === discovery)
      discoveries.delete(discoveryKey);
  }
  const { context, unavailable, outcomes } = discovered;
  const contextMs = Date.now() - started;
  if (!context) {
    const code =
      candidates.length && unavailable === "NATIVE_HEALTH_CONTEXT_REQUIRED"
        ? "HEALTH_RESULT_UNKNOWN"
        : unavailable;
    console.warn("[SpaceHealthContext]", {
      stage: "probe_unavailable",
      operationId,
      surface: message.localPoster
        ? "poster"
        : message.header === true
          ? "header"
          : "node",
      elapsedMs: Date.now() - started,
      candidates: candidates.length,
      outcomes,
      code,
    });
    return failure(code);
  }
  const response = await chrome.runtime
    .sendMessage({
      action: "workflowSpaceNativeHealth",
      documentId: context.documentId,
      workflowId: message.workflowId,
      userId: message.userId,
      healthOperationId: operationId,
      localPoster: message.localPoster,
      providers,
      nodeIds: message.nodeIds,
      includeDisabled: message.includeDisabled === true,
      header: message.header === true,
      projectId: message.projectId || void 0,
      manualSubmitMode: message.manualSubmitMode,
      settingRevision: message.settingRevision,
      settingSession: message.settingSession,
      activationOnly: message.activationOnly === true,
      skipFlowActivation: message.skipFlowActivation === true,
      reloadMuse: message.reloadMuse === true,
      prepare: message.flowReadiness === "confirm",
    })
    .catch(() => null);
  console.info?.("[SpaceProviderHealth]", {
    operationId,
    surface: message.localPoster
      ? "poster"
      : message.header === true
        ? "header"
        : "node",
    prepare: message.flowReadiness === "confirm",
    providers,
    contextMs,
    healthMs: Date.now() - started - contextMs,
    totalMs: Date.now() - started,
    ok: response?.ok === true,
  });
  return response?.ok
    ? response
    : failure(response?.error || "HEALTH_RESULT_UNKNOWN");
}
const _spaceHealthSubscribers = new Map();
function registerSpaceHealthSubscriber(sender) {
  if (
    Number.isInteger(sender.tab?.id) &&
    sender.documentId &&
    /^https:\/\/(?:labs\.toby\.vn|tobyflow\.com)\/app\/spaces\//.test(
      sender.url || "",
    )
  ) {
    _spaceHealthSubscribers.set(`${sender.tab.id}:${sender.documentId}`, {
      tabId: sender.tab.id,
      documentId: sender.documentId,
    });
  }
}
let _spaceHealthNotifyTimer = null,
  _spaceSettingsChanged = false;
function notifySpaceHealthChanged(settingsChanged = false) {
  if (settingsChanged === true) _spaceSettingsChanged = true;
  if (_spaceHealthNotifyTimer || !_spaceHealthSubscribers.size) return;
  _spaceHealthNotifyTimer = setTimeout(async () => {
    _spaceHealthNotifyTimer = null;
    const settingsChanged2 = _spaceSettingsChanged;
    _spaceSettingsChanged = false;
    const reload = (
      await chrome.storage.session.get("flowReloadUiState").catch(() => ({}))
    )?.flowReloadUiState;
    const tabs = await chrome.tabs
      .query({ url: getFlowTabQueryPatterns() })
      .catch(() => []);
    const tab = await selectFlowStatusTab(tabs);
    const syncing =
      tab?.status === "loading" ||
      (reload?.active === true &&
        Date.now() - Number(reload.at) >= 0 &&
        Date.now() - Number(reload.at) < 3e5);
    for (const [key, subscriber] of _spaceHealthSubscribers) {
      chrome.tabs
        .sendMessage(
          subscriber.tabId,
          {
            action: "workflowSpaceHealthChanged",
            syncing,
            settingsChanged: settingsChanged2,
          },
          { documentId: subscriber.documentId },
        )
        .catch(() => _spaceHealthSubscribers.delete(key));
    }
  }, 100);
}
chrome.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if ((changes.status || changes.url) && isFlowUrl(tab?.url || changes.url))
    notifySpaceHealthChanged();
});
chrome.tabs.onRemoved.addListener(() => notifySpaceHealthChanged());
chrome.tabs.onActivated.addListener(() => notifySpaceHealthChanged());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.af_auth) {
    const before = changes.af_auth.oldValue,
      after = changes.af_auth.newValue;
    if (
      before?.user?.id &&
      (!after?.token ||
        String(before.user.id) !== String(after?.user?.id || ""))
    )
      WorkflowRunLogStore.clearUser(before.user.id).catch(() => {});
  }
  const healthChanged =
    area === "local" &&
    Object.entries(changes).some(
      ([key, change]) =>
        /^toby_flow_api_health_(?:gen|workflow)_(?:image|video)$/.test(key) &&
        ["ready", "driver", "reason", "connecting", "fallbackFrom"].some(
          (field) => change.oldValue?.[field] !== change.newValue?.[field],
        ),
    );
  if (
    (area === "session" && changes.flowReloadUiState) ||
    healthChanged ||
    (area === "local" &&
      (changes.af_settings ||
        changes.af_settings_owner ||
        changes.af_execution_config ||
        changes.af_system_settings ||
        changes.af_auth ||
        changes.toby_flow_api_v2_private_epoch ||
        changes.toby_flow_api_v2_private_configs))
  )
    notifySpaceHealthChanged();
});
async function _rescanFlowUuidMedia(
  fileIds,
  fileNamesById,
  ownerRecords,
  target,
  timeoutMs,
  options = {},
) {
  const deadline = Date.now() + timeoutMs;
  const assertTarget = async () => {
    options.assertActive?.();
    const tab = await chrome.tabs.get(target.tabId);
    const current = describeFlowTab(tab);
    if (
      !current ||
      ["projectId", "origin", "driverKey", "routePrefix"].some(
        (field) => (current[field] || null) !== (target[field] || null),
      )
    )
      throw Error("FLOW_EXECUTION_TARGET_CHANGED");
  };
  const identities = fileIds.map((id) =>
    self.flow_uuid_gateway.identity(
      ownerRecords.find(
        (record) => record?.resultId === id || record?.id === id,
      ),
      fileNamesById[id] || id,
    ),
  );
  const lookup = await self.flow_uuid_gateway.resolve(identities, {
    mode: options.mode || "web",
    passive: true,
    purpose: "rescan",
    expectedFlowTarget: target,
    ownerRecords,
  });
  await assertTarget();
  const results = {},
    statuses = {},
    pending = [],
    known = {};
  for (const [index, id] of fileIds.entries()) {
    const verdict = lookup.results[identities[index]];
    if (verdict?.status === "not_found") {
      statuses[id] = "missing";
      continue;
    }
    if (verdict?.ok) {
      results[id] = verdict.metadata;
      known[identities[index]] = verdict.metadata;
      statuses[id] = "resolved";
    } else statuses[id] = "unresolved";
    if (!verdict?.metadata?.thumbnail && !verdict?.metadata?.source_thumbnail)
      pending.push(id);
  }
  const modernDeep =
    options.followGatewayMode === true && options.deep === true;
  if (modernDeep && lookup.effectiveMode === "web" && pending.length) {
    await assertTarget();
    await chrome.tabs.update(target.tabId, { active: true });
    await assertTarget();
  }
  const batchSize = modernDeep ? Math.max(1, pending.length) : 250;
  for (
    let offset = 0;
    (options.followGatewayMode !== true || lookup.effectiveMode === "web") &&
    offset < pending.length;
    offset += batchSize
  ) {
    await assertTarget();
    if (Date.now() >= deadline) throw Error("RESCAN_TIMEOUT");
    const batch = pending.slice(offset, offset + batchSize),
      members = new Set(batch);
    const batchOwners = ownerRecords.filter((record) =>
      members.has(record?.resultId || record?.id),
    );
    const metadataRequestId = crypto.randomUUID();
    options.trackRequest?.(metadataRequestId);
    const response = await _sendFlowMetadataRead(target.tabId, {
      action: "getThumbnailsByIds",
      fileIds: batch,
      fileNamesById: Object.fromEntries(
        batch
          .filter((id) => fileNamesById[id])
          .map((id) => [id, fileNamesById[id]]),
      ),
      ownerRecords: modernDeep ? batchOwners : batchOwners.slice(0, 500),
      deep: options.deep !== false,
      allowOwnerIdentityPromotion: false,
      metadataRequestId,
      metadataDeadline: deadline,
      expectedFlowTarget: target,
      _flowTarget: target,
    });
    await assertTarget();
    if (response?.success === false || response?.error)
      throw Error(response?.error || "RESCAN_FAILED");
    for (const id of batch) {
      const info = response?.results?.[id];
      if (info)
        results[id] = self.flow_uuid_gateway.mergeMetadata?.(
          results[id],
          info,
        ) || { ...results[id], ...info };
      const status = response?.statuses?.[id];
      statuses[id] =
        status && status !== "missing"
          ? status
          : info
            ? "resolved"
            : "unresolved";
    }
  }
  const reconciledOwners = {};
  if (options.followGatewayMode === true)
    for (const owner of ownerRecords) {
      if (typeof owner.ownerKey !== "string" || owner.ownerKey.length > 1e3)
        continue;
      const id = owner.resultId || owner.id;
      const info = results[id];
      if (!info) continue;
      const { ownerKey, nodeId, resultId, id: ownerId, ...record } = owner;
      const metadata = self.flow_uuid_gateway.reconcileMetadata(record, info);
      reconciledOwners[owner.ownerKey] = {
        metadata,
        fileName:
          self.flow_uuid_gateway.isAsb(metadata?.persistent_media_id) &&
          metadata.file_name === metadata.persistent_media_id
            ? metadata.file_name
            : null,
      };
    }
  return {
    results,
    statuses,
    ...(options.followGatewayMode === true && { reconciledOwners }),
    effectiveMode: lookup.effectiveMode || null,
    projectId: target.projectId,
    catalog: {
      supported: target.driverKey === "flow_v2",
      projectId: target.projectId,
      known,
      unknown: identities.filter((id) => !known[id]),
      complete: false,
      failed: lookup.failed,
      unresolved: lookup.unresolved,
      gateway: true,
    },
  };
}
self._flowUuidGatewayTargetPrimitive = async (context) => {
  const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
  const pin = context.expectedFlowTarget;
  const pinnedId =
    pin?.tabId ??
    context.flowTabId ??
    context.apiContext?.flowTabId ??
    context.apiContext?.flowApiTabId;
  const tab = Number.isInteger(pinnedId)
    ? tabs.find((entry) => entry.id === pinnedId)
    : await selectFlowStatusTab(tabs);
  const page = tab && describeFlowTab(tab);
  if (
    !page ||
    (pin &&
      ["projectId", "origin", "driverKey", "routePrefix"].some(
        (key) => (pin[key] || null) !== (page[key] || null),
      )) ||
    (context.projectId && context.projectId !== page.projectId)
  )
    throw Error("FLOW_EXECUTION_TARGET_CHANGED");
  return { tabId: tab.id, ...page };
};
self._flowUuidGatewayWebPrimitive = async (identities, context) => {
  const tabs = await chrome.tabs.query({ url: getFlowTabQueryPatterns() });
  const pinned = context.expectedFlowTarget;
  const tab = pinned
    ? tabs.find((tab2) => tab2.id === pinned.tabId)
    : await selectFlowStatusTab(tabs);
  const target = tab && describeFlowTab(tab);
  if (
    !target ||
    (pinned &&
      ["projectId", "origin", "driverKey", "routePrefix"].some(
        (key) => (pinned[key] || null) !== (target[key] || null),
      )) ||
    (context.projectId && context.projectId !== target.projectId)
  )
    return { error: "FLOW_EXECUTION_TARGET_CHANGED" };
  return chrome.tabs.sendMessage(tab.id, {
    action: "flowUuidGatewayRead",
    identities,
    ownerRecords: context.ownerRecords || [],
    expectedFlowTarget: { tabId: tab.id, ...target },
    _flowTarget: { tabId: tab.id, ...target },
  });
};
self._flowUuidGatewayApiStatusPrimitive = async (context) => {
  const stored = await chrome.storage.local.get([
    "af_settings",
    "af_system_settings",
  ]);
  const settings = stored?.af_settings;
  const mode = context.mode || settings?.defaultGenMode || settings?.gen_mode;
  const runtimeDriver = stored?.af_system_settings?.flow_api_driver;
  if (
    mode !== "api" ||
    (settings?.defaultGenMode || settings?.gen_mode) === "web" ||
    context.requireWebInteraction === true ||
    runtimeDriver === "disabled" ||
    ![true, 1, "true"].includes(settings?.apiModeEnabled)
  )
    return null;
  const requested =
    context.apiContext?.apiDriver ||
    context.apiDriver ||
    context.apiContext?.providerData?.api_driver;
  if (requested && !["v1", "v2"].includes(requested)) return null;
  const driver =
    requested || (["v1", "v2"].includes(runtimeDriver) ? runtimeDriver : null);
  if (!driver) return null;
  const readContext = {
    ...context.apiContext,
    apiDriver: driver,
    existingWebMedia: driver === "v2",
    acceptedMonitor: false,
    mediaId:
      context.lookupMediaIds?.[0] ||
      context.apiContext?.mediaId ||
      context.mediaId,
    projectId: context.projectId,
    mediaType: context.mediaType,
    requireUpscale: false,
    ...(Number.isInteger(context.expectedFlowTarget?.tabId)
      ? { flowTabId: context.expectedFlowTarget.tabId }
      : {}),
  };
  const result = await _flowApiDownloadPreflight(readContext);
  if (!result?.ok) return null;
  let maxConcurrent = null;
  if (result.driver === "v2") {
    const loaded = await _flowV2DownloadConfig(readContext);
    if (!loaded?.ok) return null;
    const config = loaded.config;
    maxConcurrent = config.runtime?.max_concurrent || null;
    readContext.protocolRevision = loaded.protocolRevision;
    readContext.protocolFingerprint = loaded.protocolFingerprint;
    const health = await _flowDownloadBridgeRequest("flow_v2_health", {
      protocol: config.protocol,
      models: config.models,
      schema: config.schema,
      stateMapping: config.state_mapping,
      runtime: config.runtime,
      projectId: context.projectId,
      mediaType: context.mediaType,
      protocolRevision: loaded.protocolRevision,
      protocolFingerprint: loaded.protocolFingerprint,
      ...(Number.isInteger(context.expectedFlowTarget?.tabId)
        ? { flowTabId: context.expectedFlowTarget.tabId }
        : {}),
    });
    if (health?.ok !== true || health?.ready !== true) return null;
  }
  const current = await chrome.storage.local.get([
    "af_settings",
    "af_system_settings",
  ]);
  if (
    (context.mode ||
      current?.af_settings?.defaultGenMode ||
      current?.af_settings?.gen_mode) !== "api" ||
    (current?.af_settings?.defaultGenMode || current?.af_settings?.gen_mode) ===
      "web" ||
    current?.af_system_settings?.flow_api_driver !== runtimeDriver ||
    ![true, 1, "true"].includes(current?.af_settings?.apiModeEnabled)
  )
    return null;
  return { ready: true, driver: result.driver, maxConcurrent, readContext };
};
self._flowUuidGatewayApiReadPrimitive = (input) =>
  _flowApiResolveMediaForDownloadPrimitive(input);
async function _flowApiResolveMediaForDownload(input = {}) {
  if (!input.apiDriver || input.apiDriver === "v1") {
    try {
      const payload = await self.flow_uuid_gateway.resolveMedia({
        ...input,
        apiContext: input,
        mediaType: input.mediaType === "video" ? "video" : "image",
      });
      return payload?.url || payload?.base64
        ? { ...payload, ok: true }
        : { ok: false, error: "FLOW_MEDIA_UUID_UNRESOLVED" };
    } catch (error) {
      return {
        ok: false,
        error: error?.code || error?.message,
        noRetry: error?.noRetry === true,
      };
    }
  }
  const response = await self.flow_uuid_gateway.resolve([input.mediaId], {
    projectId: input.projectId,
    mediaType: input.mediaType === "video" ? "video" : "image",
    apiContext: input,
    mode: input.mode,
    operationId: input.operationId,
  });
  const verdict = response.results[input.mediaId];
  if (!verdict?.ok)
    return {
      ok: false,
      error: verdict?.code || "FLOW_MEDIA_UUID_UNRESOLVED",
      noRetry: verdict?.status === "not_found",
    };
  const metadata = verdict.metadata;
  const url =
    metadata.type === "video"
      ? metadata.video_url
      : metadata.image_url || metadata.thumbnail;
  return url
    ? {
        ok: true,
        mediaId: metadata.media_uuid,
        mediaType: metadata.type,
        url,
        posterUrl: metadata.thumbnail || null,
        base64: null,
      }
    : { ok: false, error: "FLOW_MEDIA_UUID_UNRESOLVED" };
}
async function _flowApiResolveMediaForDownloadPrimitive(input = {}) {
  const mediaId = String(input?.mediaId || "");
  const mediaType = input?.mediaType === "video" ? "video" : "image";
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      mediaId,
    )
  ) {
    return { ok: false, error: "FLOW_MEDIA_ID_INVALID" };
  }
  const preflight = await _flowApiDownloadPreflight({
    ...input,
    mediaType,
    requireUpscale: false,
  });
  if (!preflight?.ok) return preflight;
  if (preflight.driver === "v2") {
    const loaded2 = await _flowV2DownloadConfig({
      ...input,
      requireUpscale: false,
    });
    if (!loaded2.ok) return loaded2;
    const config = loaded2.config;
    const result2 = await _flowDownloadBridgeRequest("flow_v2_resolve_media", {
      protocol: config.protocol,
      models: config.models,
      schema: config.schema,
      stateMapping: config.state_mapping,
      runtime: config.runtime,
      mediaId,
      mediaType,
      operationId: input.operationId,
      projectId: input.projectId,
      ...(Number.isInteger(input.flowTabId)
        ? { flowTabId: input.flowTabId }
        : {}),
      protocolRevision: loaded2.protocolRevision,
      protocolFingerprint: loaded2.protocolFingerprint,
    });
    const output = result2?.output;
    if (!result2?.ok)
      return {
        ...result2,
        ok: false,
        error: result2?.error || "V2_RESOLVE_FAILED",
      };
    const url =
      typeof output?.url === "string" && output.url.startsWith("https://")
        ? output.url
        : null;
    if (
      output?.mediaId !== mediaId ||
      output?.projectId !== input.projectId ||
      (input.operationId &&
        output.operationId &&
        output.operationId !== input.operationId) ||
      (!url && input.identityOnly !== true)
    ) {
      return { ok: false, error: "V2_RESOLVE_IDENTITY_MISMATCH" };
    }
    return {
      ok: true,
      mediaId,
      projectId: output.projectId,
      mediaType,
      url,
      posterUrl: output.posterUrl || null,
      base64: null,
      mime: mediaType === "video" ? "video/mp4" : null,
    };
  }
  const loaded = await _flowDownloadConfig();
  if (!loaded?.ok) return loaded;
  const policy = loaded.config?.api_rate_limits || {};
  const attempts = 1;
  const delayMs = Math.max(0, Number(policy.poll_interval_ms) || 0);
  let result = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await _flowDownloadBridgeRequest("flow_resolve_media", {
      config: loaded.config,
      mediaId,
      mediaType,
    });
    if (result?.ok && (result.url || result.base64)) {
      const servingUrl =
        typeof result.url === "string" &&
        !result.url.includes("media.getMediaUrlRedirect")
          ? result.url
          : null;
      const base64 =
        typeof result.base64 === "string" && result.base64
          ? result.base64
          : null;
      if (!servingUrl && !base64) {
        if (attempt < attempts && delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      const inferredMime =
        mediaType === "video"
          ? "video/mp4"
          : base64?.startsWith("iVBOR")
            ? "image/png"
            : base64?.startsWith("UklGR")
              ? "image/webp"
              : "image/jpeg";
      return {
        ok: true,
        mediaId,
        mediaType,
        url: servingUrl,
        base64,
        mime: String(result.contentType || "").startsWith(`${mediaType}/`)
          ? result.contentType
          : inferredMime,
      };
    }
    if (attempt < attempts && delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ok: false, error: result?.error || "FLOW_API_MEDIA_RESOLVE_FAILED" };
}
async function _flowV2DownloadConfig(input) {
  const token = (await chrome.storage.local.get("af_auth"))?.af_auth?.token;
  if (!token) return { ok: false, error: "AUTH_REQUIRED" };
  const suffixes = [
    "protocol",
    "models",
    "schema",
    "state_mapping",
    "runtime",
    "error_mapping",
  ];
  const query = suffixes.map((key) => `flow_api_v2_${key}`).join(",");
  const response = await _signedFetch(
    `${getApiBaseUrl()}/providers/private-configs?keys=${query}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Extension-Id": chrome.runtime.id,
      },
      cache: "no-store",
    },
  );
  if (!response.ok)
    return { ok: false, error: `PRIVATE_CONFIG_HTTP_${response.status}` };
  const json = await response.json();
  const values = json?.success ? json.data?.flow?.configs : null;
  const config = {};
  for (const key of suffixes) {
    if (!values?.[`flow_api_v2_${key}`])
      return { ok: false, error: "V2_PRIVATE_CONFIG_MISSING" };
    config[key] = values[`flow_api_v2_${key}`];
  }
  if ((await chrome.storage.local.get("af_auth"))?.af_auth?.token !== token)
    return { ok: false, error: "AUTH_CHANGED" };
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  const text = JSON.stringify(
    canonical(
      Object.fromEntries(
        suffixes
          .filter((key) => key !== "error_mapping")
          .map((key) => [key, config[key]]),
      ),
    ),
  );
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const fingerprint = `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  const standaloneWebMedia = input.existingWebMedia === true;
  if (
    !standaloneWebMedia &&
    (Number(config.protocol.schema_version) !==
      Number(input.protocolRevision) ||
      fingerprint !== input.protocolFingerprint)
  )
    return { ok: false, error: "V2_PINNED_CONFIG_MISMATCH" };
  return {
    ok: true,
    config,
    protocolRevision: Number(config.protocol.schema_version),
    protocolFingerprint: fingerprint,
  };
}
const _flowApiUpscaleDownloadInflight = new Map();
const _flowApiUpscaleDownloadAccepted = new Map();
async function _flowApiUpscaleForDownload(input) {
  const mediaId = input?.mediaId;
  const projectId = input?.projectId;
  const resolution = String(input?.resolution || "").toLowerCase();
  const mediaType = input?.mediaType === "video" ? "video" : "image";
  if (!mediaId || !projectId || !resolution)
    return { ok: false, error: "UPSCALE_INPUT_MISSING" };
  const key = [
    projectId,
    mediaType,
    mediaId,
    resolution,
    input?.apiDriver || "legacy",
  ].join(":");
  const now = Date.now();
  for (const [acceptedKey, accepted] of _flowApiUpscaleDownloadAccepted) {
    if (accepted.expiresAt <= now)
      _flowApiUpscaleDownloadAccepted.delete(acceptedKey);
  }
  const active = _flowApiUpscaleDownloadInflight.get(key);
  if (active) {
    console.log("[FlowApiDownload] joining in-flight upscale:", {
      mediaType,
      resolution,
    });
    return active;
  }
  const pending = _flowApiUpscaleForDownloadOnce(
    input,
    key,
    _flowApiUpscaleDownloadAccepted.get(key) || null,
  );
  _flowApiUpscaleDownloadInflight.set(key, pending);
  try {
    return await pending;
  } finally {
    if (_flowApiUpscaleDownloadInflight.get(key) === pending) {
      _flowApiUpscaleDownloadInflight.delete(key);
    }
  }
}
async function _flowApiUpscaleForDownloadOnce(
  input,
  acceptedKey = null,
  acceptedOperation = null,
) {
  const mediaId = input?.mediaId;
  const projectId = input?.projectId;
  const resolution = String(input?.resolution || "");
  const mediaType = input?.mediaType === "video" ? "video" : "image";
  if (!mediaId || !projectId || !resolution)
    return { ok: false, error: "UPSCALE_INPUT_MISSING" };
  console.log("[FlowApiDownload] upscale requested:", {
    mediaType,
    resolution,
    hasMediaId: !!mediaId,
    hasProjectId: !!projectId,
    ratio: input?.ratio || null,
  });
  const acceptedMonitor = !!(
    acceptedOperation?.mediaId && acceptedOperation.expiresAt > Date.now()
  );
  if (!acceptedMonitor && self.flow_uuid_gateway)
    await self.flow_uuid_gateway.requireDownload([mediaId], {
      projectId,
      mediaType,
      apiContext: input,
      operationId: input.operationId,
    });
  const preflight = await _flowApiDownloadPreflight({
    ...input,
    mediaType,
    requireUpscale: true,
    acceptedMonitor,
  });
  if (!preflight?.ok) {
    console.info("[FlowApiDownload] preflight failed:", preflight.error);
    return preflight;
  }
  if (preflight.driver === "v2") {
    const loaded2 = await _flowV2DownloadConfig(input);
    if (!loaded2.ok) return loaded2;
    const config2 = loaded2.config;
    const normalizedResolution = resolution.toLowerCase();
    if (mediaType === "video") {
      if (!["1080p", "4k"].includes(normalizedResolution))
        return { ok: false, error: "V2_VIDEO_UPSCALE_RESOLUTION_UNSUPPORTED" };
      const params = {
        protocol: config2.protocol,
        models: config2.models,
        schema: config2.schema,
        stateMapping: config2.state_mapping,
        runtime: config2.runtime,
        projectId,
        protocolRevision: loaded2.protocolRevision,
        protocolFingerprint: loaded2.protocolFingerprint,
      };
      const timeout = Number(config2.runtime.video_timeout_ms),
        interval = Number(config2.runtime.poll_interval_ms);
      if (
        !Number.isInteger(timeout) ||
        timeout < 1e3 ||
        timeout > 36e5 ||
        !Number.isInteger(interval) ||
        interval < 1
      )
        return { ok: false, error: "V2_UPSCALE_RUNTIME_INVALID" };
      let receipt;
      if (
        acceptedOperation?.mediaId &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_upsampled$/i.test(
          acceptedOperation.mediaId,
        ) &&
        acceptedOperation.expiresAt > Date.now()
      ) {
        receipt = {
          ok: true,
          mediaId: acceptedOperation.mediaId,
          resumed: true,
        };
        console.info("[FlowApiDownload] resuming accepted upscale operation:", {
          mediaType,
          resolution: normalizedResolution,
        });
      } else {
        receipt = await _flowDownloadBridgeRequest("flow_v2_upscale_video", {
          ...params,
          mediaId,
          resolution: normalizedResolution,
        });
      }
      if (
        !receipt?.ok ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_upsampled$/i.test(
          receipt.mediaId || "",
        )
      )
        return {
          ok: false,
          error: receipt?.error || "V2_UPSCALE_RECEIPT_INVALID",
          stage: receipt?.stage || null,
          dispatchStarted:
            typeof receipt?.dispatchStarted === "boolean"
              ? receipt.dispatchStarted
              : null,
          ambiguous: receipt?.ambiguous === true,
          commandLayer: receipt?.commandLayer || null,
          commandRejectReason: receipt?.commandRejectReason || null,
          grpcCode: Number.isInteger(receipt?.grpcCode)
            ? receipt.grpcCode
            : null,
          grpcReason: receipt?.grpcReason || null,
          providerErrorCodes: Array.isArray(receipt?.providerErrorCodes)
            ? receipt.providerErrorCodes
            : [],
        };
      const deadline =
        acceptedOperation?.expiresAt > Date.now()
          ? acceptedOperation.expiresAt
          : Date.now() + timeout;
      if (acceptedKey && receipt.resumed !== true) {
        if (
          _flowApiUpscaleDownloadAccepted.size >= 256 &&
          !_flowApiUpscaleDownloadAccepted.has(acceptedKey)
        ) {
          _flowApiUpscaleDownloadAccepted.delete(
            _flowApiUpscaleDownloadAccepted.keys().next().value,
          );
        }
        _flowApiUpscaleDownloadAccepted.set(acceptedKey, {
          mediaId: receipt.mediaId,
          expiresAt: deadline,
        });
      }
      while (Date.now() < deadline) {
        const poll = await _flowDownloadBridgeRequest(
          "flow_v2_poll_operations",
          {
            ...params,
            operationIds: [receipt.mediaId],
            acceptedOperationIds: [receipt.mediaId],
          },
        );
        if (!poll?.ok)
          return {
            ok: false,
            error: poll?.error || "V2_UPSCALE_POLL_FAILED",
            mediaId: receipt.mediaId,
            stage: "accepted_poll",
            dispatchStarted: true,
            retryable: poll?.retryable === true,
            grpcCode: poll?.grpcCode ?? null,
            grpcReason: poll?.grpcReason || null,
            providerErrorCodes: poll?.providerErrorCodes || [],
          };
        const output = poll.outputs?.[0];
        if (
          poll.outputs?.length !== 1 ||
          output?.operationId !== receipt.mediaId ||
          (output?.projectId !== projectId &&
            !(output?.state === "failed" && output?.projectId === null))
        )
          return { ok: false, error: "V2_UPSCALE_LINEAGE_MISMATCH" };
        if (output.state === "failed") {
          const failureDetail = output.failureDetail || null;
          const isCompactFailure =
            output.compact === true ||
            (output.compact == null &&
              output.projectId === null &&
              output.generationId == null &&
              output.model == null);
          const hasFailureEvidence =
            !!output.grpcReason ||
            (Array.isArray(output.providerErrorCodes) &&
              output.providerErrorCodes.length > 0) ||
            Number.isInteger(output.grpcCode) ||
            Number.isInteger(failureDetail?.statusCode) ||
            !!failureDetail?.message ||
            (typeof output.error === "string" &&
              output.error !== "V2_GENERATION_FAILED" &&
              output.error !== "V2_UPSCALE_FAILED");
          if (!isCompactFailure || hasFailureEvidence) {
            if (acceptedKey)
              _flowApiUpscaleDownloadAccepted.delete(acceptedKey);
            return {
              ok: false,
              error: output.error || "V2_UPSCALE_FAILED",
              mediaId: receipt.mediaId,
              stage: "terminal",
              dispatchStarted: true,
              providerErrorCodes: output.providerErrorCodes || [],
              grpcCode: output.grpcCode ?? failureDetail?.statusCode ?? null,
              grpcReason: output.grpcReason || null,
            };
          }
          console.info(
            "[FlowApiDownload] provisional compact upscale state; polling again:",
            { mediaType, resolution },
          );
        }
        if (output.state === "completed") {
          const resolved = await _flowDownloadBridgeRequest(
            "flow_v2_resolve_media",
            { ...params, mediaId: receipt.mediaId },
          );
          if (
            !resolved?.ok ||
            resolved.output?.mediaId !== receipt.mediaId ||
            resolved.output?.projectId !== projectId ||
            !resolved.output?.url
          )
            return {
              ok: false,
              error: resolved?.error || "V2_UPSCALE_RESOLVE_FAILED",
            };
          if (acceptedKey) _flowApiUpscaleDownloadAccepted.delete(acceptedKey);
          return {
            ok: true,
            route: "api-v2-video-upscale",
            videoUrl: resolved.output.url,
            mediaId: receipt.mediaId,
          };
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(interval, deadline - Date.now())),
        );
      }
      if (acceptedKey) _flowApiUpscaleDownloadAccepted.delete(acceptedKey);
      return {
        ok: false,
        error: "V2_UPSCALE_TIMEOUT",
        mediaId: receipt.mediaId,
        stage: "accepted_poll",
        dispatchStarted: true,
      };
    }
    if (!["2k", "4k"].includes(normalizedResolution))
      return { ok: false, error: "V2_IMAGE_UPSCALE_RESOLUTION_UNSUPPORTED" };
    const result2 = await _flowDownloadBridgeRequest("flow_v2_upscale_image", {
      protocol: config2.protocol,
      models: config2.models,
      schema: config2.schema,
      stateMapping: config2.state_mapping,
      runtime: config2.runtime,
      mediaId,
      projectId,
      operationId: input.operationId,
      protocolRevision: loaded2.protocolRevision,
      protocolFingerprint: loaded2.protocolFingerprint,
      resolution: normalizedResolution,
    });
    if (!result2?.ok || !result2.base64) {
      const diagnostic = {
        error: result2?.error || "V2_IMAGE_UPSCALE_FAILED",
        commandLayer: result2?.commandLayer || "unknown_or_old_bridge",
        commandRejectReason: result2?.commandRejectReason || null,
        stage: result2?.stage || null,
        ambiguous: result2?.ambiguous === true,
      };
      console.warn(
        "[FlowV2UpscaleDownloadFailure]",
        JSON.stringify(diagnostic),
      );
      return { ok: false, ...diagnostic };
    }
    return {
      ok: true,
      route: "api-v2-image-upscale",
      base64: result2.base64,
      mime: result2.mime,
      mediaId: result2.mediaId,
    };
  }
  const loaded = await _flowDownloadConfig();
  if (!loaded?.ok) {
    console.info("[FlowApiDownload] config failed:", loaded.error);
    return loaded;
  }
  console.log("[FlowApiDownload] config source:", loaded.source || "merged");
  const config = loaded.config;
  const tierResult = await _flowDownloadBridgeRequest("flow_resolve_tier", {
    config,
  });
  const tier = tierResult?.tier;
  if (!tier || typeof tier !== "string") {
    console.info(
      "[FlowApiDownload] tier failed:",
      tierResult?.error || "FLOW_TIER_MISSING",
    );
    return { ok: false, error: tierResult?.error || "FLOW_TIER_MISSING" };
  }
  if (mediaType === "image") {
    const map = config.api_image_upsample_resolutions || {};
    const targetResolution = map[resolution] || map[resolution.toLowerCase()];
    if (!targetResolution)
      return { ok: false, error: "UPSAMPLE_RESOLUTION_UNMAPPED" };
    const result2 = await _flowDownloadBridgeRequest("flow_upscale_image", {
      config,
      input: { mediaId, projectId, tier, targetResolution },
    });
    if (!result2?.ok || !result2.base64)
      return { ok: false, error: result2?.error || "UPSAMPLE_FAILED" };
    return {
      ok: true,
      route: "api-image-upscale",
      base64: result2.base64,
      mime: result2.mime || "image/png",
    };
  }
  const ratioMap = config.api_video_ratio_mapping || {};
  const resolutionMap = config.api_video_resolutions || {};
  const ratio = String(input?.ratio || "");
  const ratioEnum = ratioMap[ratio] || ratioMap[ratio.toLowerCase()];
  const resolutionEnum =
    resolutionMap[resolution] || resolutionMap[resolution.toLowerCase()];
  const upModelKey = config.api_video_model_keys?.upscale?.[resolutionEnum];
  if (!ratioEnum) return { ok: false, error: "VIDEO_RATIO_UNMAPPED" };
  if (!resolutionEnum || !upModelKey)
    return { ok: false, error: "VIDEO_UPSCALE_CONFIG_MISSING" };
  console.log("[FlowApiDownload] video upscale resolved:", {
    resolutionEnum,
    upModelKey,
    ratioEnum,
  });
  const result = await _flowDownloadBridgeRequest("flow_upscale_video", {
    config,
    input: { mediaId, projectId, tier, ratioEnum, resolutionEnum, upModelKey },
  });
  if (!result?.ok) {
    console.info(
      "[FlowApiDownload] bridge upscale failed:",
      result?.error || "UPSCALE_FAILED",
    );
    return { ok: false, error: result?.error || "UPSCALE_FAILED" };
  }
  if (result.videoUrl)
    return { ok: true, route: "api-video-upscale", videoUrl: result.videoUrl };
  if (result.videoBase64)
    return {
      ok: true,
      route: "api-video-upscale",
      base64: result.videoBase64,
      mime: "video/mp4",
    };
  return { ok: false, error: "UPSCALE_MEDIA_MISSING" };
}
const _wmMaskCache = new Map();
const _wmRecentCleanHashes = new Map();
const _WM_RECENT_CLEAN_TTL_MS = 5 * 60 * 1e3;
let _wmConfigCache = null;
let _wmConfigAt = 0;
let _wmConfigInflight = null;
let _wmConfigEpoch = 0;
const _WM_CONFIG_TTL_MS = 60 * 60 * 1e3;
async function _wmBase64Hash(base64) {
  const raw = String(base64 || "").includes(",")
    ? String(base64).split(",").pop()
    : String(base64 || "");
  if (!raw || !self.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(raw);
  const digest = new Uint8Array(
    await self.crypto.subtle.digest("SHA-256", bytes),
  );
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
function _wmPruneRecentClean(now = Date.now()) {
  for (const [hash, expiresAt] of _wmRecentCleanHashes) {
    if (expiresAt <= now) _wmRecentCleanHashes.delete(hash);
  }
}
async function _wmGetConfig() {
  try {
    await ProtectedConfigClient.ready();
  } catch (error) {
    return { cfg: null, error: error.code || "CONFIG_ACCESS_REQUIRED" };
  }
  if (_wmConfigCache && Date.now() - _wmConfigAt < _WM_CONFIG_TTL_MS)
    return { cfg: _wmConfigCache, error: null };
  if (_wmConfigInflight) return _wmConfigInflight;
  const epoch = ++_wmConfigEpoch;
  _wmConfigInflight = (async () => {
    try {
      const store = await new Promise((r) =>
        chrome.storage.local.get(["af_auth"], r),
      );
      const token = store?.af_auth?.token;
      if (!token) {
        console.warn(
          "[Watermark] ch\u01B0a \u0111\u0103ng nh\u1EADp \u2192 kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c c\u1EA5u h\xECnh",
        );
        return { cfg: null, error: "AUTH_REQUIRED" };
      }
      const baseUrl = getApiBaseUrl();
      const resp = await _signedFetch(
        `${baseUrl}/providers/private-configs?keys=watermark_removal,watermark_removal_video`,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "X-Extension-Id": chrome.runtime.id,
          },
          cache: "no-store",
        },
      );
      if (!resp.ok) {
        let code = `HTTP_${resp.status}`;
        try {
          code = (await resp.clone().json())?.error?.code || code;
        } catch (_) {}
        console.warn(
          "[Watermark] kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c c\u1EA5u h\xECnh:",
          code,
        );
        return { cfg: null, error: code };
      }
      const json = await resp.json();
      const _rows = json?.success ? json.data?.flow?.configs : null;
      const cfg = _rows?.watermark_removal || null;
      if (cfg && _rows?.watermark_removal_video)
        cfg.video = _rows.watermark_removal_video;
      if (!cfg) {
        const granted = json?.meta?.granted || [];
        if (
          granted.includes("watermark_removal_video") &&
          !granted.includes("watermark_removal")
        ) {
          console.warn(
            "[Watermark] g\xF3i c\xF3 quy\u1EC1n video nh\u01B0ng KH\xD4NG c\xF3 quy\u1EC1n \u1EA3nh \u2014 video c\u1EA7n tham s\u1ED1 chung \u1EDF row \u1EA3nh, xem l\u1EA1i /admin/plans",
          );
        }
        const why = granted.includes("watermark_removal")
          ? "CONFIG_MISSING"
          : "PLAN_REQUIRED";
        console.warn("[Watermark] kh\xF4ng c\xF3 c\u1EA5u h\xECnh \u2014", why);
        return { cfg: null, error: why };
      }
      if (epoch !== _wmConfigEpoch) {
        console.log(
          "[Watermark] b\u1ECF c\u1EA5u h\xECnh v\u1EEBa t\u1EA3i (epoch l\u1EC7ch)",
        );
        return { cfg: null, error: "STALE" };
      }
      _wmConfigCache = cfg;
      _wmConfigAt = Date.now();
      return { cfg, error: null };
    } catch (e) {
      console.warn(
        "[Watermark] l\u1ED7i l\u1EA5y c\u1EA5u h\xECnh:",
        e?.message,
      );
      return { cfg: null, error: "NETWORK" };
    } finally {
      if (epoch === _wmConfigEpoch) _wmConfigInflight = null;
    }
  })();
  return _wmConfigInflight;
}
function _queueDownloadRename(filename, url, requestId = null) {
  if (!filename) return;
  const _isFlat = !filename.includes("/");
  const _canQueue =
    typeof url === "string" &&
    (url.startsWith("blob:") || url.startsWith("data:"));
  if (_isFlat && !_canQueue) return;
  const lastSlash = filename.lastIndexOf("/");
  const base = lastSlash >= 0 ? filename.substring(lastSlash + 1) : filename;
  _pendingDownloadRenames.push({
    requestId,
    folder: lastSlash >= 0 ? filename.substring(0, lastSlash) : "",
    filename: base,
    identifier: base,
    expires: Date.now() + 3e5,
  });
  _persistPendingRenames();
}
async function _wmAutoOn(kind = "image") {
  try {
    const st = await new Promise((r) =>
      chrome.storage.local.get(["af_settings"], r),
    );
    const v =
      st.af_settings?.[
        kind === "video" ? "autoRemoveWatermarkVideo" : "autoRemoveWatermark"
      ];
    return v === true || v === "1" || v === 1;
  } catch (_) {
    return false;
  }
}
async function _wmCleanBlob(blob, kind = "image") {
  try {
    if (!blob || !(await _wmGateAllowed(kind)) || !(await _wmAutoOn(kind)))
      return blob;
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192)
      bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    const r = await _removeWatermarkFromSource({
      base64: btoa(bin),
      mime: blob.type || "image/png",
    });
    if (!r?.success || !r.applied) return blob;
    const outBin = atob(r.base64);
    const outBytes = new Uint8Array(outBin.length);
    for (let i = 0; i < outBin.length; i++) outBytes[i] = outBin.charCodeAt(i);
    return new Blob([outBytes], { type: r.mime || blob.type || "image/png" });
  } catch (e) {
    console.warn("[Watermark] _wmCleanBlob l\u1ED7i:", e?.message);
    return blob;
  }
}
function _wmInvalidate(reason) {
  _wmConfigEpoch++;
  _wmConfigInflight = null;
  _wmConfigCache = null;
  _wmConfigAt = 0;
  _wmMaskCache.clear();
  if (reason)
    console.log("[Watermark] xo\xE1 cache c\u1EA5u h\xECnh \u2014", reason);
}
async function _wmSourceToImageData(message) {
  let blob = null;
  if (message.base64) {
    const b64 = String(message.base64).includes(",")
      ? String(message.base64).split(",")[1]
      : message.base64;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    blob = new Blob([bytes], { type: message.mime || "image/png" });
  } else if (message.url) {
    if (!_isAllowedUrl(message.url)) return { error: "URL_NOT_ALLOWED" };
    let resp = await fetch(message.url, { cache: "no-store" });
    if (!resp.ok && resp.status >= 400 && resp.status < 500) {
      try {
        resp = await fetch(message.url, {
          cache: "no-store",
          credentials: "include",
        });
      } catch (_) {}
    }
    if (!resp.ok) {
      console.warn(
        `[Watermark] fetch ${resp.status} \u2014 url=${_safeUrlForLog(message.url)}`,
      );
      return { error: `HTTP_${resp.status}` };
    }
    const ct = resp.headers.get("content-type") || "";
    if (!ct.startsWith("image/")) {
      console.warn(
        `[WM] \u2717 n\u1ED9i dung KH\xD4NG ph\u1EA3i \u1EA3nh: content-type=${ct} url=${_safeUrlForLog(message.url)}`,
      );
      return { error: `NOT_IMAGE:${ct}` };
    }
    blob = await resp.blob();
    console.log(
      `[WM] \u2713 t\u1EA3i xong: ${Math.round(blob.size / 1024)}KB ${ct} (${Date.now() - _t0}ms)`,
    );
  } else {
    return { error: "NO_SOURCE" };
  }
  const bmp = await createImageBitmap(blob);
  const oc = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = oc.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return {
    imageData: ctx.getImageData(0, 0, oc.width, oc.height),
    srcMime: blob.type || "",
  };
}
const _wmGateCache = {
  image: { at: 0, ok: false },
  video: { at: 0, ok: false },
};
function _wmAuthScope(value) {
  return JSON.stringify({
    authenticated: !!value?.token,
    userId: value?.user?.id == null ? null : String(value.user.id),
  });
}
function _wmEntitlementScope(value) {
  const entitlements = value?.entitlements || {};
  const read = (key) => entitlements?.[key]?.value ?? null;
  return JSON.stringify({
    userId: value?.user_id == null ? null : String(value.user_id),
    plan: value?.plan?.id ?? value?.plan?.slug ?? null,
    image: read("image_remove_watermark_enabled"),
    video: read("video_remove_watermark_enabled"),
  });
}
function _wmSystemScope(value) {
  return JSON.stringify({
    removeWatermark: value?.remove_watermark_enabled ?? null,
  });
}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const resetGate = () => {
      _wmGateCache.image = { at: 0, ok: false };
      _wmGateCache.video = { at: 0, ok: false };
    };
    const systemChanged =
      !!changes.af_system_settings &&
      _wmSystemScope(changes.af_system_settings.oldValue) !==
        _wmSystemScope(changes.af_system_settings.newValue);
    const entitlementChanged =
      !!changes.af_entitlements &&
      _wmEntitlementScope(changes.af_entitlements.oldValue) !==
        _wmEntitlementScope(changes.af_entitlements.newValue);
    const authChanged =
      !!changes.af_auth &&
      _wmAuthScope(changes.af_auth.oldValue) !==
        _wmAuthScope(changes.af_auth.newValue);
    if (systemChanged || entitlementChanged) {
      resetGate();
      _wmInvalidate(
        "quy\u1EC1n ho\u1EB7c c\xE0i \u0111\u1EB7t h\u1EC7 th\u1ED1ng \u0111\u1ED5i",
      );
    }
    if (authChanged) {
      resetGate();
      _wmInvalidate("phi\xEAn \u0111\u0103ng nh\u1EADp \u0111\u1ED5i");
    }
    if (systemChanged || entitlementChanged || authChanged) {
      _notifyInterceptConfigChanged();
    }
  });
} catch (_) {}
function _notifyInterceptConfigChanged() {
  try {
    chrome.tabs.query(
      {
        url: [
          "https://labs.google/fx/*",
          "https://flow.google.com/*",
          "*://gemini.google.com/*",
        ],
      },
      (tabs) => {
        for (const t of tabs || []) {
          chrome.tabs.sendMessage(
            t.id,
            { action: "wm:interceptConfigChanged" },
            () => void chrome.runtime.lastError,
          );
        }
      },
    );
  } catch (e) {
    console.warn(
      "[WM] kh\xF4ng b\xE1o \u0111\u01B0\u1EE3c tab v\u1EC1 \u0111\u1ED5i c\u1EA5u h\xECnh ch\u1EB7n:",
      e?.message,
    );
  }
}
async function _wmGateAllowed(kind = "image") {
  const k = kind === "video" ? "video" : "image";
  const now = Date.now();
  const slot = _wmGateCache[k];
  if (now - slot.at < 3e4) return slot.ok;
  let ok = true;
  try {
    const store = await new Promise((r) =>
      chrome.storage.local.get(["af_system_settings", "af_entitlements"], r),
    );
    const sys = store?.af_system_settings;
    if (
      sys &&
      Object.prototype.hasOwnProperty.call(sys, "remove_watermark_enabled")
    ) {
      const v = sys.remove_watermark_enabled;
      if (!(v === true || v === "1" || v === 1)) {
        console.warn("[Watermark] admin \u0111\xE3 t\u1EAFt t\xEDnh n\u0103ng");
        ok = false;
      }
    }
    const ent =
      store?.af_entitlements?.entitlements?.[`${k}_remove_watermark_enabled`];
    if (ok && ent) {
      const v = ent.value;
      if (!(v === "1" || v === 1 || v === true)) {
        console.warn(
          "[Watermark] g\xF3i hi\u1EC7n t\u1EA1i kh\xF4ng c\xF3 quy\u1EC1n",
        );
        ok = false;
      }
    }
  } catch (e) {
    console.warn(
      "[Watermark] kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c tr\u1EA1ng th\xE1i c\u1EE5c b\u1ED9:",
      e?.message,
    );
  }
  _wmGateCache[k] = { at: now, ok };
  return ok;
}
async function _removeWatermarkFromSource(message) {
  const _t02 = Date.now();
  const _kind0 = message.mediaType === "video" ? "video" : "image";
  const _sourceKind = message.sourceMediaType === "image" ? "image" : _kind0;
  const _src = message.base64
    ? `base64(${Math.round((message.base64.length * 3) / 4 / 1024)}KB)`
    : message.url
      ? `url(${String(message.url).substring(0, 110)})`
      : "KH\xD4NG C\xD3 NGU\u1ED2N";
  console.log(
    `[WM] \u25B6 b\u1EAFt \u0111\u1EA7u \u2014 profile=${_kind0} bytes=${_sourceKind} ngu\u1ED3n=${_src}`,
  );
  const _inputHash =
    _sourceKind === "image" && message.base64
      ? await _wmBase64Hash(message.base64).catch(() => null)
      : null;
  _wmPruneRecentClean();
  if (_inputHash && _wmRecentCleanHashes.has(_inputHash)) {
    console.log(
      "[WM] \u2713 b\u1ECF qua byte \u0111\u1EA7u ra \u0111\xE3 s\u1EA1ch quay l\u1EA1i (recent_clean_output)",
    );
    return {
      success: true,
      applied: false,
      reason: "already_clean_output",
      clean: true,
    };
  }
  const tAll = Date.now();
  const _kind = message.mediaType === "video" ? "video" : "image";
  const _gateOk = await _wmGateAllowed(_kind);
  console.log(
    `[WM] gate c\u1EE5c b\u1ED9 (${_kind}): ${_gateOk ? "CHO QUA" : "CH\u1EB6N"}`,
  );
  if (!_gateOk) return { success: false, error: "NOT_ALLOWED" };
  let { cfg, error: cfgErr } = await _wmGetConfig();
  if (!cfg && cfgErr === "STALE")
    ({ cfg, error: cfgErr } = await _wmGetConfig());
  console.log(
    `[WM] config: ${cfg ? `C\xD3 (variants=${cfg.variants?.length || 0} video=${cfg.video?.logo_types?.length || 0} ng\u01B0\u1EE1ng=${cfg.detect?.ncc_threshold})` : `THI\u1EBEU (${cfgErr})`}`,
  );
  if (!cfg) return { success: false, error: cfgErr || "NO_CONFIG" };
  if (_sourceKind === "video") {
    console.warn(
      "[WM] \u2717 VIDEO kh\xF4ng xo\xE1 \u0111\u01B0\u1EE3c \u1EDF service worker \u2014 u\u1EF7 th\xE1c VideoWmClient ho\u1EB7c gi\u1EEF b\u1EA3n g\u1ED1c",
    );
    return { success: false, error: "VIDEO_NOT_SUPPORTED_HERE" };
  }
  const tFetch = Date.now();
  const src = await _wmSourceToImageData(message);
  if (src.error) {
    console.warn(
      `[WM] \u2717 kh\xF4ng l\u1EA5y \u0111\u01B0\u1EE3c bytes: ${src.error}`,
    );
    return { success: false, error: src.error };
  }
  const decodeMs = Date.now() - tFetch;
  const { imageData } = src;
  const WR = self.WatermarkRemover;
  if (!WR) {
    console.warn(
      "[WM] \u2717 l\xF5i WatermarkRemover ch\u01B0a n\u1EA1p trong service worker",
    );
    return { success: false, error: "CORE_NOT_LOADED" };
  }
  const mediaType = message.mediaType === "video" ? "video" : "image";
  const result = await WR.process(imageData, cfg, _wmMaskCache, mediaType);
  if (!result.applied) {
    console.warn(
      `[WM] \u2717 KH\xD4NG xo\xE1: l\xFD do=${result.reason}` +
        (result.ncc != null ? ` ncc=${Number(result.ncc).toFixed(3)}` : "") +
        (result.nccAfter != null
          ? ` sau=${Number(result.nccAfter).toFixed(3)}`
          : "") +
        (result.variantId ? ` logo=${result.variantId}` : "") +
        (result.missing ? ` thi\u1EBFu=[${result.missing.join(",")}]` : "") +
        ` (${Date.now() - _t02}ms)`,
    );
    return {
      success: true,
      applied: false,
      reason: result.reason,
      ncc: result.ncc ?? null,
      threshold: cfg.detect?.ncc_threshold ?? null,
      timings: { decode: decodeMs, total: Date.now() - tAll },
    };
  }
  const tEnc = Date.now();
  const wantJpeg =
    /jpe?g/i.test(message.mime || src.srcMime || "") &&
    cfg.output?.format !== "png";
  const oc = new OffscreenCanvas(imageData.width, imageData.height);
  oc.getContext("2d").putImageData(imageData, 0, 0);
  const outBlob = wantJpeg
    ? await oc.convertToBlob({
        type: "image/jpeg",
        quality: cfg.output?.jpeg_quality ?? 0.95,
      })
    : await oc.convertToBlob({ type: "image/png" });
  const buf = new Uint8Array(await outBlob.arrayBuffer());
  let binStr = "";
  for (let i = 0; i < buf.length; i += 8192)
    binStr += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
  const encodeMs = Date.now() - tEnc;
  const _outputBase64 = btoa(binStr);
  const _outputHash = await _wmBase64Hash(_outputBase64).catch(() => null);
  if (_outputHash)
    _wmRecentCleanHashes.set(_outputHash, Date.now() + _WM_RECENT_CLEAN_TTL_MS);
  console.log(
    `[WM] \u2705 XO\xC1 TH\xC0NH C\xD4NG \u2014 logo=${result.variantId} ncc=${Number(result.ncc).toFixed(3)} sau=${Number(result.nccAfter).toFixed(3)} gain=${result.gain?.toFixed?.(2)}` +
      (result.denoise?.applied
        ? ` denoise=YES(luma=${Number(result.denoise.backgroundLuma).toFixed(1)},strength=${Number(result.denoise.strength).toFixed(2)})`
        : ` denoise=NO(${result.denoise?.reason || "n/a"})`) +
      ` (${Date.now() - _t02}ms)`,
  );
  return {
    success: true,
    applied: true,
    base64: _outputBase64,
    mime: outBlob.type,
    variantId: result.variantId,
    ncc: result.ncc,
    nccAfter: result.nccAfter,
    threshold: cfg.detect?.ncc_threshold ?? null,
    gain: result.gain,
    clean: result.clean,
    pos: result.pos,
    timings: {
      decode: decodeMs,
      ...result.timings,
      encode: encodeMs,
      total: Date.now() - tAll,
    },
  };
}
const _CONFIGS_READY_KEY = "_tobyConfigsReady";
const _CONFIGS_READY_TTL_MS = 3e4;
let _prefetchPromise = null;
function _notifyProtectedConfigReady() {
  const message = { type: "CONFIG_ACCESS_RECOVERED" };
  chrome.runtime.sendMessage(message).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs)
      if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
  });
}
async function _prefetchAllConfigs() {
  if (_prefetchPromise) {
    console.log("[Background] Config fetch already in progress, waiting...");
    return _prefetchPromise;
  }
  _prefetchPromise = (async () => {
    try {
      const results = await Promise.all([
        _fetchProviderConfigs(),
        _fetchApiConfigs(),
        ProtectedConfigClient.fetch("private"),
        ProtectedConfigClient.fetch("models"),
        _fetchExecutionConfig(),
        _aiToolsGetConfig(),
      ]);
      if (!results[0] || !results[1] || !ProtectedConfigClient.status().ready)
        return false;
      if (!(await ProtectedConfigClient.markReady())) return false;
      console.log(
        "[Background] Protected configs pre-fetched, signaled _tobyConfigsReady",
      );
      _notifyProtectedConfigReady();
      return true;
    } catch (e) {
      console.warn(
        "[Background] Pre-fetch configs failed:",
        e.code || e.message,
      );
      return false;
    } finally {
      _prefetchPromise = null;
    }
  })();
  return _prefetchPromise;
}
async function _claimAndPrefetchAtStartup() {
  try {
    const auth = (await chrome.storage.local.get("af_auth")).af_auth;
    if (!auth?.token || !auth?.user?.id) return false;
    const claimed = await ProtectedConfigClient.claim();
    if (claimed.data?.registered !== true) return false;
    return await _prefetchAllConfigs();
  } catch (error) {
    console.warn(
      "[ConfigAccess] Startup claim:",
      error?.code || error?.message || "CONFIG_ACCESS_REQUIRED",
    );
    return false;
  }
}
const I2P_CONTEXT_MENU_ID = "tobyflow-i2p-analyze";
const I2P_REGION_MENU_ID = "tobyflow-i2p-region";
const I2P_SEND_GEN_MENU_ID = "tobyflow-i2p-send-gen";
async function _featureAllowed(featureKey) {
  const isOn = (f) =>
    !!f && (f.value === "1" || f.value === 1 || f.value === true);
  try {
    const store = await new Promise((r) =>
      chrome.storage.local.get(["af_auth", "af_entitlements"], r),
    );
    const loggedIn = !!(store.af_auth && store.af_auth.token);
    const cached = store.af_entitlements?.entitlements;
    if (cached && cached[featureKey])
      return { loggedIn, allowed: isOn(cached[featureKey]) };
    try {
      const r = await _signedFetch(`${getApiBaseUrl()}/entitlements`, {
        method: "GET",
        headers: {
          "X-Extension-Id": chrome.runtime.id,
          Accept: "application/json",
        },
      });
      const json = await r.json();
      const features = json?.data?.features || json?.features || {};
      return { loggedIn, allowed: isOn(features[featureKey]) };
    } catch (_) {
      return { loggedIn, allowed: false };
    }
  } catch (e) {
    return { loggedIn: false, allowed: false };
  }
}
let _aiToolsCache = null;
let _aiToolsAt = 0;
let _aiToolsInflight = null;
let _aiToolsEpoch = 0;
async function _aiToolsGetConfig() {
  const result = await ProtectedConfigClient.fetch("aiTools");
  if (!result.data?.i2p || !result.data?.pa)
    throw Object.assign(new Error("CONFIG_RESPONSE_INVALID"), {
      code: "CONFIG_RESPONSE_INVALID",
    });
  _aiToolsCache = result.data;
  _aiToolsAt = Date.now();
  return result.data;
}
async function _i2pGetConfig() {
  const c = (await _aiToolsGetConfig())?.i2p;
  if (!c)
    return {
      defaultProvider: "chatgpt",
      promptTemplate: "",
      maxImagePx: 1536,
      deleteAfter: false,
      timeoutMs: 18e4,
    };
  return {
    defaultProvider: c.default_provider || "chatgpt",
    promptTemplate: c.prompt_template || "",
    maxImagePx: Number(c.max_image_px) || 1536,
    deleteAfter: c.delete_after === true,
    timeoutMs: Number(c.timeout_ms) || 18e4,
  };
}
async function _paGetConfig() {
  const c = (await _aiToolsGetConfig())?.pa;
  if (!c)
    return {
      defaultProvider: "chatgpt",
      deleteAfter: false,
      promptTemplate: "",
      maxCount: 50,
      defaults: {},
    };
  const d = c.defaults || {};
  return {
    defaultProvider: c.default_provider || "chatgpt",
    deleteAfter: c.delete_after === true,
    promptTemplate: c.prompt_template || "",
    maxCount: Number(c.max_count) > 0 ? Number(c.max_count) : 50,
    defaults: {
      media_type: d.media_type || "image",
      count: d.count != null ? String(d.count) : "auto",
      language: d.language || "en",
      style: d.style || "cinematic",
      aspect_ratio: d.aspect_ratio || "16:9",
      detail_level: d.detail_level || "concise",
      clip_duration: d.clip_duration || "auto",
      total_duration: d.total_duration != null ? String(d.total_duration) : "",
      seconds_per_image:
        d.seconds_per_image != null ? String(d.seconds_per_image) : "",
      numbered: d.numbered !== false,
      sequential: d.sequential !== false,
      consistency: d.consistency !== false,
      auto_script: d.auto_script === true,
      render_sub: d.render_sub === true,
    },
  };
}
let _paFormatsCache = null;
let _paFormatsAt = 0;
async function _paGetFormats() {
  const now = Date.now();
  if (_paFormatsCache && now - _paFormatsAt < 60 * 1e3) return _paFormatsCache;
  try {
    let _paAuthToken = null;
    try {
      const a = await new Promise((r) =>
        chrome.storage.local.get(["af_auth"], (x) => r(x.af_auth || {})),
      );
      _paAuthToken = a.token || null;
    } catch (_) {}
    const resp = await _signedFetch(`${getApiBaseUrl()}/pa-content-formats`, {
      method: "GET",
      headers: {
        "X-Extension-Id": chrome.runtime.id,
        Accept: "application/json",
        ...(_paAuthToken ? { Authorization: `Bearer ${_paAuthToken}` } : {}),
      },
    });
    const json = await resp.json();
    const list = Array.isArray(json?.data)
      ? json.data
      : Array.isArray(json)
        ? json
        : [];
    _paFormatsCache = list;
    _paFormatsAt = now;
  } catch (e) {
    console.warn("[PA] getFormats fail:", e.message);
    if (!_paFormatsCache) _paFormatsCache = [];
  }
  return _paFormatsCache;
}
const I2P_SITE_PATTERNS = ["http://*/*", "https://*/*"];
const I2P_PARENT_ID = "tobyflow-i2p-parent";
const I2P_REGION_PAGE_ID = "tobyflow-i2p-region-page";
const I2P_MENU_TITLES = {
  vi: "Ph\xE2n t\xEDch \u1EA3nh \u2192 Prompt",
  en: "Analyze image \u2192 Prompt",
  ja: "\u753B\u50CF\u3092\u30D7\u30ED\u30F3\u30D7\u30C8\u306B\u5909\u63DB",
  th: "\u0E27\u0E34\u0E40\u0E04\u0E23\u0E32\u0E30\u0E2B\u0E4C\u0E23\u0E39\u0E1B\u0E40\u0E1B\u0E47\u0E19\u0E1E\u0E23\u0E2D\u0E21\u0E15\u0E4C",
};
const I2P_REGION_TITLES = {
  vi: "Ch\u1ECDn v\xF9ng \u2192 Prompt",
  en: "Select area \u2192 Prompt",
  ja: "\u7BC4\u56F2\u9078\u629E \u2192 \u30D7\u30ED\u30F3\u30D7\u30C8",
  th: "\u0E40\u0E25\u0E37\u0E2D\u0E01\u0E1E\u0E37\u0E49\u0E19\u0E17\u0E35\u0E48 \u2192 \u0E1E\u0E23\u0E2D\u0E21\u0E15\u0E4C",
};
const I2P_SEND_GEN_TITLES = {
  vi: "G\u1EEDi \u1EA3nh \u2192 T\u1EA1o (\u1EA3nh tham chi\u1EBFu)",
  en: "Send image \u2192 Generate (reference)",
  ja: "\u753B\u50CF\u3092\u751F\u6210\u3078\u9001\u308B\uFF08\u53C2\u7167\uFF09",
  th: "\u0E2A\u0E48\u0E07\u0E23\u0E39\u0E1B \u2192 \u0E2A\u0E23\u0E49\u0E32\u0E07 (\u0E2D\u0E49\u0E32\u0E07\u0E2D\u0E34\u0E07)",
};
function _i2pParentTitle(appName) {
  return `${appName || "Toby Flow"} Tools`;
}
function _i2pMenuTitle(locale) {
  return I2P_MENU_TITLES[locale] || I2P_MENU_TITLES.vi;
}
function _i2pRegionTitle(locale) {
  return I2P_REGION_TITLES[locale] || I2P_REGION_TITLES.vi;
}
function _i2pSendGenTitle(locale) {
  return I2P_SEND_GEN_TITLES[locale] || I2P_SEND_GEN_TITLES.vi;
}
function _i2pSetupContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.storage.local.get(["af_locale", "af_system_settings"], (r) => {
    const loc = r?.af_locale;
    const appName = r?.af_system_settings?.app_name || "Toby Flow";
    try {
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create(
          {
            id: I2P_PARENT_ID,
            title: _i2pParentTitle(appName),
            contexts: ["image"],
            documentUrlPatterns: I2P_SITE_PATTERNS,
          },
          () => void chrome.runtime.lastError,
        );
        chrome.contextMenus.create(
          {
            id: I2P_CONTEXT_MENU_ID,
            parentId: I2P_PARENT_ID,
            title: _i2pMenuTitle(loc),
            contexts: ["image"],
            documentUrlPatterns: I2P_SITE_PATTERNS,
          },
          () => void chrome.runtime.lastError,
        );
        chrome.contextMenus.create(
          {
            id: I2P_REGION_MENU_ID,
            parentId: I2P_PARENT_ID,
            title: _i2pRegionTitle(loc),
            contexts: ["image"],
            documentUrlPatterns: I2P_SITE_PATTERNS,
          },
          () => void chrome.runtime.lastError,
        );
        chrome.contextMenus.create(
          {
            id: I2P_SEND_GEN_MENU_ID,
            parentId: I2P_PARENT_ID,
            title: _i2pSendGenTitle(loc),
            contexts: ["image"],
            documentUrlPatterns: I2P_SITE_PATTERNS,
          },
          () => void chrome.runtime.lastError,
        );
        chrome.contextMenus.create(
          {
            id: I2P_REGION_PAGE_ID,
            title: _i2pRegionTitle(loc),
            contexts: ["page", "frame", "selection", "link"],
            documentUrlPatterns: I2P_SITE_PATTERNS,
          },
          () => void chrome.runtime.lastError,
        );
      });
    } catch (e) {
      console.warn("[I2P] setupContextMenu fail:", e.message);
    }
  });
}
if (chrome.contextMenus && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.af_locale || changes.af_system_settings)) {
      chrome.storage.local.get(["af_locale", "af_system_settings"], (r) => {
        const loc = r?.af_locale;
        const appName = r?.af_system_settings?.app_name || "Toby Flow";
        try {
          chrome.contextMenus.update(
            I2P_PARENT_ID,
            { title: _i2pParentTitle(appName) },
            () => void chrome.runtime.lastError,
          );
        } catch (_) {}
        try {
          chrome.contextMenus.update(
            I2P_CONTEXT_MENU_ID,
            { title: _i2pMenuTitle(loc) },
            () => void chrome.runtime.lastError,
          );
        } catch (_) {}
        try {
          chrome.contextMenus.update(
            I2P_REGION_MENU_ID,
            { title: _i2pRegionTitle(loc) },
            () => void chrome.runtime.lastError,
          );
        } catch (_) {}
        try {
          chrome.contextMenus.update(
            I2P_SEND_GEN_MENU_ID,
            { title: _i2pSendGenTitle(loc) },
            () => void chrome.runtime.lastError,
          );
        } catch (_) {}
        try {
          chrome.contextMenus.update(
            I2P_REGION_PAGE_ID,
            { title: _i2pRegionTitle(loc) },
            () => void chrome.runtime.lastError,
          );
        } catch (_) {}
      });
    }
  });
}
if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const isAnalyze = info.menuItemId === I2P_CONTEXT_MENU_ID;
    const isRegion =
      info.menuItemId === I2P_REGION_MENU_ID ||
      info.menuItemId === I2P_REGION_PAGE_ID;
    const isSendGen = info.menuItemId === I2P_SEND_GEN_MENU_ID;
    if ((!isAnalyze && !isRegion && !isSendGen) || !tab?.id) return;
    if (isSendGen) {
      try {
        if (chrome.sidePanel?.open)
          await chrome.sidePanel.open({ tabId: tab.id });
      } catch (_) {}
      await _sendImageToGenTab(info.srcUrl);
      return;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["i2p-content.js"],
      });
    } catch (e) {
      console.warn("[I2P] inject i2p-content failed:", e.message);
    }
    const msg = isRegion
      ? { action: "i2p:regionMode" }
      : { action: "i2p:showCard", srcUrl: info.srcUrl };
    chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
  });
}
async function _fetchImageAsBase64(srcUrl, maxPx, quality) {
  try {
    const resp = await fetch(srcUrl);
    if (!resp.ok) return null;
    let blob = await resp.blob();
    blob = await _wmCleanBlob(blob, "image");
    const srcType = blob.type || "";
    const isPng = srcType.includes("png");
    let outBlob = blob;
    try {
      const bmp = await createImageBitmap(blob);
      const scale = Math.min(1, maxPx / Math.max(bmp.width, bmp.height));
      if (scale < 1) {
        const cw = Math.max(1, Math.round(bmp.width * scale));
        const ch = Math.max(1, Math.round(bmp.height * scale));
        const oc = new OffscreenCanvas(cw, ch);
        const ctx = oc.getContext("2d");
        if (!isPng) {
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, cw, ch);
        }
        ctx.drawImage(bmp, 0, 0, cw, ch);
        outBlob = isPng
          ? await oc.convertToBlob({ type: "image/png" })
          : await oc.convertToBlob({
              type: "image/jpeg",
              quality: quality || 0.92,
            });
      }
    } catch (_) {}
    const buf = await outBlob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    const type = outBlob.type || (isPng ? "image/png" : "image/jpeg");
    const ext = type.includes("png")
      ? "png"
      : type.includes("webp")
        ? "webp"
        : "jpg";
    return { base64: btoa(bin), name: `gen_ref_${Date.now()}.${ext}`, type };
  } catch (_) {
    return null;
  }
}
async function _dispatchLocalImageToGen(img) {
  if (!img?.base64) return;
  try {
    const st = await chrome.storage.local.get(["_pendingLocalToGenTab"]);
    const pend = st._pendingLocalToGenTab || [];
    pend.push({
      base64: img.base64,
      name: img.name,
      type: img.type,
      addedAt: Date.now(),
    });
    while (pend.length > 5) pend.shift();
    await chrome.storage.local.set({ _pendingLocalToGenTab: pend });
  } catch (_) {}
  try {
    chrome.runtime.sendMessage(
      { action: "drainLocalToGenTab" },
      () => void chrome.runtime.lastError,
    );
  } catch (_) {}
}
async function _sendImageToGenTab(srcUrl) {
  if (!srcUrl) return;
  const img = await _fetchImageAsBase64(srcUrl, 2048, 0.92);
  if (!img) return;
  await _dispatchLocalImageToGen(img);
}
async function _i2pEnsureProviderTab(provider, { focusWindow = true } = {}) {
  const cfg = PROVIDER_URLS[provider];
  if (!cfg) throw new Error("UNKNOWN_PROVIDER");
  const tabs = await chrome.tabs.query({ url: cfg.tabQuery });
  let tab = tabs && tabs.length ? tabs.find((t) => t.active) || tabs[0] : null;
  let created = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: cfg.createUrl, active: true });
    created = true;
  } else {
    try {
      await chrome.tabs.update(tab.id, { active: true });
    } catch (_) {}
    try {
      if (focusWindow && tab.windowId != null)
        await chrome.windows.update(tab.windowId, { focused: true });
    } catch (_) {}
  }
  return { tabId: tab.id, created };
}
async function _getProviderTextStartupTimeout(provider) {
  const config =
    !_executionConfigCache ||
    Date.now() - _executionConfigCacheTime > _EXECUTION_CONFIG_CACHE_TTL_MS
      ? await _fetchExecutionConfig()
      : _executionConfigCache;
  const value =
    config?.parallel?.[`provider_web_${provider}_startup_timeout_ms`];
  return Number.isInteger(value) && value >= 1e4 && value <= 12e4 ? value : 6e4;
}
const _motionTranscriptTasks = new Map();
const _motionTranscriptCleanupJobs = new Map();
async function _enqueueMotionTranscriptCleanup(message, sender) {
  let caller;
  try {
    caller = new URL(sender.url);
  } catch (_) {
    return { success: false, error: "MOTION_SENDER_INVALID" };
  }
  const base = new URL(chrome.runtime.getURL("motion-editor.html"));
  const runner = new URL(chrome.runtime.getURL("motion-runner.html"));
  if (
    sender.id !== chrome.runtime.id ||
    caller.protocol !== base.protocol ||
    caller.origin !== base.origin ||
    caller.host !== base.host ||
    ![base.pathname, runner.pathname].includes(caller.pathname)
  )
    return { success: false, error: "MOTION_SENDER_INVALID" };
  const receipt = message.receipt;
  let target;
  try {
    target = new URL(receipt?.expectedConversationUrl);
  } catch (_) {
    return { success: false, error: "CLEANUP_RECEIPT_MISSING" };
  }
  const provider = receipt?.provider,
    configured = PROVIDER_URLS[provider];
  if (
    !["chatgpt", "gemini"].includes(provider) ||
    !Number.isInteger(receipt.tabId) ||
    !configured ||
    target.protocol !== "https:" ||
    target.origin !== new URL(configured.createUrl).origin
  )
    return { success: false, error: "CLEANUP_RECEIPT_MISSING" };
  const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
  if (!auth?.token || !auth.user?.id)
    return { success: false, error: "ACCOUNT_SCOPE_CHANGED" };
  const key = JSON.stringify([
    auth.user.id,
    provider,
    receipt.tabId,
    target.href,
  ]);
  if (_motionTranscriptCleanupJobs.has(key))
    return { success: true, accepted: true };
  const requestedAt =
    Number.isFinite(message.requestedAt) &&
    message.requestedAt > 0 &&
    message.requestedAt <= Date.now()
      ? message.requestedAt
      : Date.now();
  const report = (state, code = null) =>
    console.info(
      "[MotionTranscriptCleanup]",
      JSON.stringify({
        operationId: /^[0-9a-f-]{36}$/i.test(String(message.operationId || ""))
          ? message.operationId
          : null,
        frameId: /^[A-Za-z0-9_-]{1,80}$/.test(String(message.frameId || ""))
          ? message.frameId
          : null,
        provider,
        state,
        elapsedMs: Date.now() - requestedAt,
        ...(code && {
          code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(code))
            ? code
            : "MOTION_CLEANUP_UNCONFIRMED",
        }),
      }),
    );
  const job = Promise.resolve()
    .then(async () => {
      const currentAuth = (await chrome.storage.local.get("af_auth"))?.af_auth;
      if (
        currentAuth?.token !== auth.token ||
        currentAuth?.user?.id !== auth.user.id
      ) {
        report("skipped", "ACCOUNT_SCOPE_CHANGED");
        return;
      }
      const tab = await chrome.tabs.get(receipt.tabId).catch(() => null);
      if (!tab || tab.url !== target.href) {
        report("skipped", tab ? "CONVERSATION_CHANGED" : "TAB_CLOSED");
        return;
      }
      report("requested");
      let timer;
      try {
        const removal =
          provider === "chatgpt"
            ? _deleteChatGptConversationWithReloadFallback(receipt.tabId, {
                expectedConversationUrl: target.href,
                focusWindow: false,
                skipReload: true,
                requestedAt,
              })
            : chrome.tabs.sendMessage(receipt.tabId, {
                action: "gemini:deleteCurrentConversation",
                expectedConversationUrl: target.href,
                requestedAt,
                cleanupDeadline: requestedAt + 1e4,
              });
        const result = await Promise.race([
          removal,
          new Promise((resolve) => {
            timer = setTimeout(
              () =>
                resolve({ success: false, error: "CLEANUP_DEADLINE_EXCEEDED" }),
              1e4,
            );
          }),
        ]);
        report(
          result?.success === true ? "verified" : "unconfirmed",
          result?.error ||
            (result?.success === true ? null : "MOTION_CLEANUP_UNCONFIRMED"),
        );
      } finally {
        clearTimeout(timer);
      }
    })
    .catch((error) => report("failed", error?.code || error?.message))
    .finally(() => {
      if (_motionTranscriptCleanupJobs.get(key) === job)
        _motionTranscriptCleanupJobs.delete(key);
    });
  _motionTranscriptCleanupJobs.set(key, job);
  report("queued");
  return { success: true, accepted: true };
}
function _motionTranscriptSenderKey(sender) {
  try {
    const actual = new URL(sender.url),
      expected = new URL(chrome.runtime.getURL("motion-editor.html"));
    if (
      sender.id !== chrome.runtime.id ||
      actual.protocol !== expected.protocol ||
      actual.host !== expected.host ||
      actual.pathname !== expected.pathname
    )
      return null;
    return JSON.stringify([
      sender.id,
      sender.documentId || null,
      sender.tab?.id ?? null,
      sender.url,
    ]);
  } catch (_) {
    return null;
  }
}
function _beginMotionTranscriptTask(message, sender) {
  const owner = _motionTranscriptSenderKey(sender);
  if (!owner) throw new Error("MOTION_SENDER_INVALID");
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(message.operationId || ""),
    )
  )
    return null;
  if (_motionTranscriptTasks.has(message.operationId))
    throw new Error("MOTION_TRANSCRIPT_ALREADY_RUNNING");
  let resolve;
  const task = {
    owner,
    provider: message.provider,
    tabId: null,
    cancelled: false,
    dispatched: false,
    cancellation: new Promise((done) => {
      resolve = done;
    }),
  };
  task.cancel = () => {
    task.cancelled = true;
    resolve({ success: false, error: "MOTION_CANCELLED" });
  };
  _motionTranscriptTasks.set(message.operationId, task);
  return task;
}
async function _cancelMotionTranscriptTask(operationId, sender) {
  const owner = _motionTranscriptSenderKey(sender);
  if (!owner) return { success: false, error: "MOTION_SENDER_INVALID" };
  const task = _motionTranscriptTasks.get(operationId);
  if (!task) return { success: true, active: false };
  if (task.owner !== owner)
    return { success: false, error: "MOTION_SENDER_INVALID" };
  task.cancel();
  if (task.dispatched && Number.isInteger(task.tabId)) {
    const result = await chrome.tabs
      .sendMessage(task.tabId, {
        action: `${task.provider}:abort`,
        motionOperationId: operationId,
        requestedAt: Date.now(),
      })
      .catch(() => null);
    return {
      success: true,
      active: true,
      abortReceived: result?.abortReceived === true,
      providerStopped: result?.providerStopped === true,
    };
  }
  return { success: true, active: true, notDispatched: true };
}
async function _i2pSendAnalyze(tabId, payload, created, control = null) {
  const maxTries = created ? 25 : 6;
  const budget =
    Number.isInteger(payload?.waitForEditorMs) &&
    payload.waitForEditorMs >= 1e4 &&
    payload.waitForEditorMs <= 12e4
      ? payload.waitForEditorMs
      : null;
  const deadline = budget === null ? null : Date.now() + budget;
  for (
    let i = 0;
    deadline === null ? i < maxTries : i === 0 || Date.now() < deadline;
    i++
  ) {
    if (control?.cancelled)
      return { success: false, error: "MOTION_CANCELLED" };
    const response = new Promise((resolve) => {
      try {
        if (control) control.dispatched = true;
        chrome.tabs.sendMessage(tabId, payload, (resp) => {
          if (chrome.runtime.lastError) resolve({ __noReceiver: true });
          else resolve(resp);
        });
      } catch (_) {
        resolve({ __noReceiver: true });
      }
    });
    const r = await (control
      ? Promise.race([response, control.cancellation])
      : response);
    if (control?.cancelled)
      return { success: false, error: "MOTION_CANCELLED" };
    if (r && !r.__noReceiver) return r;
    const delay = created ? 1200 : 600;
    if (deadline === null || Date.now() < deadline)
      await new Promise((rr) =>
        setTimeout(
          rr,
          deadline === null
            ? delay
            : Math.min(delay, Math.max(0, deadline - Date.now())),
        ),
      );
  }
  return {
    success: false,
    error: "PROVIDER_NOT_READY",
    reason: "NO_PROVIDER_RESPONSE",
  };
}
async function _retryChatGptTextTaskAfterReadiness(
  tabId,
  payload,
  result,
  provider,
  owner,
) {
  const retryablePreSubmitErrors = new Set([
    "EDITOR_NOT_FOUND",
    "NEW_CHAT_NOT_READY",
    "CHAT_MODE_NOT_READY",
  ]);
  if (
    provider !== "chatgpt" ||
    payload?.action !== "provider:textTask" ||
    result?.retryable !== true ||
    !retryablePreSubmitErrors.has(result?.error)
  )
    return result;
  console.warn(
    `[${owner}] ${result.error} tr\u01B0\u1EDBc submit \u2192 ch\u1EDD composer hydrate + retry \u0111\xFAng 1 l\u1EA7n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return _i2pSendAnalyze(tabId, payload, true);
}
async function _retryChatGptTextTaskAfterSubmitLost(
  tabId,
  payload,
  result,
  owner,
) {
  if (
    result?.error !== "SUBMIT_LOST" ||
    payload?.action !== "provider:textTask"
  )
    return result;
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return result;
  }
  const isChatGptHomepage = /^https:\/\/chatgpt\.com\/?(?:[?#]|$)/i.test(
    tab?.url || "",
  );
  if (!isChatGptHomepage) {
    console.warn(
      `[${owner}] SUBMIT_LOST nh\u01B0ng tab \u0111\xE3 r\u1EDDi homepage \u2192 kh\xF4ng replay \u0111\u1EC3 tr\xE1nh g\u1EEDi tr\xF9ng`,
    );
    return result;
  }
  console.warn(
    `[${owner}] ChatGPT SUBMIT_LOST tr\xEAn homepage \u2192 reload tab + retry \u0111\xFAng 1 l\u1EA7n`,
  );
  try {
    await chrome.tabs.reload(tabId);
  } catch (_) {
    return result;
  }
  return _i2pSendAnalyze(tabId, payload, true);
}
async function _sendChatGptDeleteCommand(tabId, payload, maxTries = 1) {
  for (let attempt = 0; attempt < maxTries; attempt++) {
    const response = await new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, payload, (result) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: "CONTENT_SCRIPT_NOT_READY",
              reloadSafe: true,
            });
            return;
          }
          resolve(
            result || {
              success: false,
              error: "NO_RESPONSE",
              reloadSafe: true,
            },
          );
        });
      } catch (_) {
        resolve({
          success: false,
          error: "CONTENT_SCRIPT_NOT_READY",
          reloadSafe: true,
        });
      }
    });
    if (
      response.error !== "CONTENT_SCRIPT_NOT_READY" ||
      attempt === maxTries - 1
    )
      return response;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    success: false,
    error: "CONTENT_SCRIPT_NOT_READY",
    reloadSafe: true,
  };
}
async function _waitChatGptReloadComplete(
  tabId,
  expectedConversationUrl,
  timeoutMs = 2e4,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (_) {
      return { success: false, error: "TAB_CLOSED" };
    }
    if (expectedConversationUrl && tab.url !== expectedConversationUrl) {
      return { success: false, error: "CONVERSATION_CHANGED" };
    }
    if (tab.status === "complete") return { success: true, tab };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { success: false, error: "RELOAD_TIMEOUT" };
}
async function _deleteChatGptConversationWithReloadFallback(
  tabId,
  options = {},
) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return { success: false, error: "TAB_CLOSED" };
  }
  const expectedConversationUrl =
    options.expectedConversationUrl || tab?.url || null;
  if (
    !expectedConversationUrl ||
    !/^https:\/\/chatgpt\.com\//i.test(expectedConversationUrl)
  ) {
    return { success: false, error: "INVALID_CONVERSATION_URL" };
  }
  if (tab.url !== expectedConversationUrl)
    return { success: false, error: "CONVERSATION_CHANGED" };
  const runDeleteAttempt = async (payload, maxTries = 1) => {
    const current2 = await chrome.tabs.get(tabId).catch(() => null);
    if (!current2 || current2.url !== expectedConversationUrl)
      return {
        success: false,
        error: current2 ? "CONVERSATION_CHANGED" : "TAB_CLOSED",
      };
    if (options.focusWindow === false)
      return _sendChatGptDeleteCommand(tabId, payload, maxTries);
    const previous = await chrome.windows.getLastFocused().catch(() => null);
    try {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(current2.windowId, { focused: true });
    } catch (_) {
      return { success: false, error: "CLEANUP_WINDOW_FOCUS_FAILED" };
    }
    try {
      return await _sendChatGptDeleteCommand(tabId, payload, maxTries);
    } finally {
      if (Number.isInteger(previous?.id) && previous.id !== current2.windowId) {
        const focused = await chrome.windows.getLastFocused().catch(() => null);
        if (focused?.id === current2.windowId)
          await chrome.windows
            .update(previous.id, { focused: true })
            .catch(() => {});
      }
    }
  };
  const direct = await runDeleteAttempt({
    action: "chatgpt:deleteLastMessage",
    expectedConversationUrl,
    cleanupDeadline: Date.now() + 8e3,
    domWaitMs: 3e3,
    requestedAt: options.requestedAt,
  });
  if (direct?.success) return { ...direct, reloaded: false };
  if (options.skipReload === true) return direct;
  if (direct?.reloadSafe !== true) return direct;
  let current;
  try {
    current = await chrome.tabs.get(tabId);
  } catch (_) {
    return { success: false, error: "TAB_CLOSED" };
  }
  if (current.url !== expectedConversationUrl)
    return { success: false, error: "CONVERSATION_CHANGED" };
  console.warn(
    "[ChatGPT-delete] Delete DOM missing \u2192 reload pinned conversation and retry",
  );
  try {
    await chrome.tabs.reload(tabId);
  } catch (error) {
    return { success: false, error: error?.message || "RELOAD_FAILED" };
  }
  const loaded = await _waitChatGptReloadComplete(
    tabId,
    expectedConversationUrl,
    2e4,
  );
  if (!loaded.success) return loaded;
  const retried = await runDeleteAttempt(
    {
      action: "chatgpt:deleteLastMessage",
      expectedConversationUrl,
      cleanupDeadline: Date.now() + 25e3,
      domWaitMs: 15e3,
    },
    30,
  );
  return {
    ...retried,
    reloaded: true,
    initialError: direct?.error || "DELETE_DOM_NOT_FOUND",
  };
}
async function _finalizeChatGptTextTaskCleanup(
  tabId,
  payload,
  result,
  provider,
  owner,
) {
  if (
    provider !== "chatgpt" ||
    payload?.deleteAfter !== true ||
    !result?.success
  )
    return result;
  const cleanupEligible = result.cleanupEligible === true;
  const expectedConversationUrl = result.cleanupConversationUrl || null;
  delete result.cleanupEligible;
  delete result.cleanupConversationUrl;
  if (!cleanupEligible || !expectedConversationUrl) {
    console.warn(
      `[${owner}] cleanup skipped \u2014 isolated conversation receipt unavailable`,
    );
    return result;
  }
  console.log(
    `[${owner}] cleanup deferred until consumer validates provider output`,
  );
  return {
    ...result,
    cleanupReceipt: { provider: "chatgpt", tabId, expectedConversationUrl },
  };
}
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log("[Background] onInstalled:", details.reason);
  if (typeof _autoInjectContentScripts === "function")
    _autoInjectContentScripts();
  _injectRefBridgeIntoExistingLabsTabs();
  try {
    await new Promise((r) =>
      chrome.storage.local.remove("tobyflow_extension_not_authorized", r),
    );
    chrome.runtime
      .sendMessage({ type: "EXTENSION_AUTHORIZED" })
      .catch(() => {});
    console.log(
      "[Auth] \u{1F504} Extension reloaded \u2014 flag cleared, fresh check",
    );
  } catch (_) {}
  const _curVersion = chrome.runtime.getManifest().version;
  const _isRealUpdate =
    details.reason === "update" &&
    details.previousVersion &&
    details.previousVersion !== _curVersion;
  if (details.reason === "install") {
    await new Promise((r) =>
      chrome.storage.local.remove(
        [
          "toby_provider_models",
          "toby_provider_api_configs",
          "toby_provider_dom_selectors",
          _CONFIGS_READY_KEY,
        ],
        r,
      ),
    );
    console.log("[TobyFlow] Empty install cache initialized");
  } else {
    console.log(
      "[TobyFlow] Update/reload v" +
        _curVersion +
        " \u2014 GI\u1EEE cache warm, prefetch refresh n\u1EC1n",
      _isRealUpdate ? `(from ${details.previousVersion})` : "",
    );
  }
  const startupRefresh = (async () => {
    await _ensureEnrollment().catch(() => {});
    await _claimAndPrefetchAtStartup();
    await _syncFlowApiMaintenanceSetting();
  })();
  if (details.reason === "install") {
    chrome.tabs.create({
      url: getProviderUrl("flow", "createUrl") || PROVIDER_URLS.flow.createUrl,
    });
  }
  _i2pSetupContextMenu();
  await startupRefresh;
});
chrome.runtime.onStartup.addListener(async () => {
  _pruneExpiredTrackerHistory().catch(() => {});
  console.log("[Background] onStartup");
  _injectRefBridgeIntoExistingLabsTabs();
  await _ensureEnrollment().catch(() => {});
  await _claimAndPrefetchAtStartup();
  await _syncFlowApiMaintenanceSetting();
  _selfHealProbe();
  _i2pSetupContextMenu();
});
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.action === "FETCH_CONFIGS_IF_NEEDED") {
    (async () => {
      try {
        const completed = await _prefetchAllConfigs();
        sendResponse(
          completed
            ? { success: true }
            : {
                success: false,
                error: {
                  code:
                    ProtectedConfigClient.status().code ||
                    "CONFIG_ACCESS_REQUIRED",
                },
              },
        );
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true;
  }
});
async function _fetchFlowPreviewImageBytes(url, maxBytes = 0, timeoutMs = 0) {
  const controller = new AbortController();
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  let stream;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return { ok: false, error: "HTTP_" + resp.status };
    const declaredSize = Number(resp.headers.get("content-length"));
    if (maxBytes && declaredSize > maxBytes) {
      await resp.body?.cancel();
      return { ok: false, error: "PREVIEW_TOO_LARGE" };
    }
    let blob;
    if (maxBytes && resp.body?.getReader) {
      stream = resp.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const chunk = await stream.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          await stream.cancel();
          return { ok: false, error: "PREVIEW_TOO_LARGE" };
        }
        chunks.push(chunk.value);
      }
      blob = new Blob(chunks, {
        type: resp.headers.get("content-type") || "image/jpeg",
      });
    } else {
      blob = await resp.blob();
      if (maxBytes && blob.size > maxBytes)
        return { ok: false, error: "PREVIEW_TOO_LARGE" };
    }
    if (controller.signal.aborted)
      return { ok: false, error: "PREVIEW_TIMEOUT" };
    let base64;
    if (typeof FileReader !== "undefined") {
      base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        const abort = () => {
          reader.abort();
          reject(new Error("PREVIEW_TIMEOUT"));
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        const cleanup = () =>
          controller.signal.removeEventListener("abort", abort);
        reader.onload = () => {
          cleanup();
          resolve(String(reader.result).split(",")[1]);
        };
        reader.onerror = () => {
          cleanup();
          reject(new Error("READ_ERROR"));
        };
        reader.onabort = cleanup;
        reader.readAsDataURL(blob);
      });
    } else {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(
          ...bytes.subarray(offset, offset + 32768),
        );
      }
      base64 = btoa(binary);
    }
    return {
      ok: true,
      base64,
      contentType: blob.type || "image/jpeg",
      size: blob.size,
    };
  } catch (error) {
    return {
      ok: false,
      error: controller.signal.aborted
        ? "PREVIEW_TIMEOUT"
        : error.message || "FETCH_EXCEPTION",
    };
  } finally {
    if (timer) clearTimeout(timer);
    stream?.releaseLock();
  }
}
function _invalidateProtectedRuntime() {
  _flowDownloadPrivateEpoch++;
  _serverUrlsCache = {};
  _privateProviderUrlsCache = {};
  _executionConfigCache = null;
  _executionConfigCacheTime = 0;
  _aiToolsCache = null;
  _aiToolsAt = 0;
  _aiToolsEpoch++;
  _flowDownloadPrivateCache = null;
  _flowDownloadPrivateAt = 0;
  _flowDownloadPrivateToken = null;
  _wmConfigCache = null;
  _wmConfigAt = 0;
  _wmConfigEpoch++;
}
const _CONFIG_RECOVERY_KEY = "toby_config_access_recovery";
const _CONFIG_RECOVERY_ALARM = "tobyConfigAccessRecovery";
let _configRecoveryTimer = null;
async function _protectedConfigOwner() {
  const enrollment = await _getEnrollment();
  const stored = await chrome.storage.local.get(["af_auth", "apiBaseUrl"]);
  const auth = stored.af_auth;
  if (!auth?.token || !auth.user?.id || !enrollment?.client_id) return null;
  const audience = String(
    auth.apiBaseUrl || stored.apiBaseUrl || getApiBaseUrl(),
  ).replace(/\/$/, "");
  return [
    audience,
    auth.user.id,
    await _sha256Hex(auth.token),
    enrollment.client_id,
  ].join("|");
}
ConfigAccessRecovery.configure({
  owner: _protectedConfigOwner,
  read: async () =>
    (await chrome.storage.session.get(_CONFIG_RECOVERY_KEY))[
      _CONFIG_RECOVERY_KEY
    ] || null,
  write: async (journal) => {
    if (journal)
      await chrome.storage.session.set({ [_CONFIG_RECOVERY_KEY]: journal });
    else await chrome.storage.session.remove(_CONFIG_RECOVERY_KEY);
  },
  cancel: async () => {
    clearTimeout(_configRecoveryTimer);
    _configRecoveryTimer = null;
    await chrome.alarms.clear(_CONFIG_RECOVERY_ALARM);
  },
  schedule: async (when) => {
    await chrome.alarms.create(_CONFIG_RECOVERY_ALARM, { when });
    if (when - Date.now() < 25e3)
      _configRecoveryTimer = setTimeout(
        () => {
          ConfigAccessRecovery.run().catch((error) =>
            console.warn(
              "[ConfigAccess] Recovery:",
              error.code || "CONFIG_FETCH_FAILED",
            ),
          );
        },
        Math.max(0, when - Date.now()),
      );
  },
  admit: () => ({
    retryAfterMs: Math.max(
      0,
      (globalThis._protectedConfigRateLimitedUntil || 0) - Date.now(),
      _apiNetworkCircuit.openUntil - Date.now(),
    ),
  }),
  claim: (checkExisting, owner) =>
    ProtectedConfigClient.claim(checkExisting, owner),
  recheckKey: async () => {
    const enrollment = await _getEnrollment();
    if (!enrollment?.client_id) return false;
    const records = await Promise.all([
      DeviceKeyStore.get(),
      DeviceKeyStore.get("pending_rotation"),
    ]);
    return records.some(
      (record) =>
        record?.client_id === enrollment.client_id &&
        record.key_id &&
        record.privateKey?.type === "private" &&
        record.privateKey.extractable === false,
    );
  },
  prefetch: async () => {
    if (!(await _prefetchAllConfigs())) {
      const status = ProtectedConfigClient.status();
      throw Object.assign(
        new Error(status.code || "CONFIG_FETCH_FAILED"),
        status,
        { code: status.code || "CONFIG_FETCH_FAILED" },
      );
    }
  },
  recovered: () => {
    _notifyProtectedConfigReady();
  },
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === _CONFIG_RECOVERY_ALARM)
    ConfigAccessRecovery.run().catch(() => {});
});
const _protectedBootPromise = ProtectedConfigClient.invalidate(
  "CONFIG_SCOPE_CHANGED",
).then(() => ConfigAccessRecovery.restore());
_protectedBootPromise.catch((error) =>
  console.warn(
    "[ConfigAccess] Recovery journal:",
    error.code || "LOCAL_STORAGE_UNAVAILABLE",
  ),
);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const auth = changes.af_auth;
  const authChanged =
    auth &&
    (auth.oldValue?.token !== auth.newValue?.token ||
      String(auth.oldValue?.user?.id) !== String(auth.newValue?.user?.id) ||
      auth.oldValue?.apiBaseUrl !== auth.newValue?.apiBaseUrl);
  const client = changes[ENROLLMENT_KEY];
  const clientChanged =
    client && client.oldValue?.client_id !== client.newValue?.client_id;
  if (!authChanged && !clientChanged && !changes.apiBaseUrl) return;
  ConfigAccessRecovery.reset()
    .then(() => ProtectedConfigClient.invalidate("CONFIG_SCOPE_CHANGED"))
    .then(async () => {
      const auth2 = (await chrome.storage.local.get("af_auth")).af_auth;
      if (!auth2?.token || !auth2.user?.id) return;
      const claimed = await ProtectedConfigClient.claim();
      if (claimed.data?.registered === true) await _prefetchAllConfigs();
    })
    .catch((error) =>
      console.warn(
        "[ConfigAccess] Scope initialization:",
        error.code || "CONFIG_ACCESS_REQUIRED",
      ),
    );
});
async function _readOperationalSnapshot(keys, callback) {
  const list = Array.isArray(keys) ? keys : [keys];
  const required = new Set();
  if (list.includes("toby_provider_configs")) required.add("dom");
  if (
    list.some((key) =>
      [
        "toby_provider_api_configs",
        "af_chatgpt_config",
        "af_grok_config",
      ].includes(key),
    )
  )
    required.add("api");
  if (list.includes("af_execution_config")) required.add("execution");
  let permitted = false;
  const responses = {};
  try {
    await Promise.all(
      [...required].map(async (operation) => {
        responses[operation] = await ProtectedConfigClient.fetch(operation);
      }),
    );
    permitted = true;
  } catch (_) {}
  const stored = await chrome.storage.local.get([
    ...list,
    "toby_config_access_scope",
  ]);
  const access = ProtectedConfigClient.status();
  const sidecar = stored.toby_config_access_scope;
  const scopeFields = [
    "contract",
    "audience",
    "auth_epoch",
    "user_id",
    "product_id",
    "client_id",
    "key_id",
    "key_revision",
    "token_hash",
  ];
  const matchesScope = (scope) =>
    !!scope &&
    scopeFields.every((field) => scope[field] === access.scope?.[field]);
  const sameScope = permitted && access.ready && matchesScope(sidecar);
  const output = Object.fromEntries(
    list.map((key) => [
      key,
      sameScope && (!stored[key]?.scope || matchesScope(stored[key].scope))
        ? stored[key]
        : void 0,
    ]),
  );
  if (sameScope) {
    for (const [key, operation] of [
      ["toby_provider_configs", "dom"],
      ["toby_provider_api_configs", "api"],
    ]) {
      const flow = responses[operation]?.data?.flow;
      if (output[key]?.data && flow)
        output[key] = { ...output[key], data: { ...output[key].data, flow } };
    }
  }
  callback?.(output);
  return output;
}
