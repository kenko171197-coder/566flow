var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) =>
  key in obj
    ? __defProp(obj, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      })
    : (obj[key] = value);
var __publicField = (obj, key, value) =>
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class MuseApiFacade {
  static _trace(stage, handle, fields = {}) {
    try {
      const tag = (value) =>
        typeof value === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(value)
          ? value
          : null;
      const row = {
        stage: tag(stage),
        commandId: tag(handle?.commandId),
        genMode: "api",
        at: Date.now(),
      };
      for (const key of [
        "method",
        "status",
        "error",
        "reason",
        "nativeSource",
        "nativeMethod",
        "nativeKind",
        "nativeCode",
      ])
        row[key] = tag(fields[key]);
      for (const key of [
        "elapsedMs",
        "resourceIndex",
        "bytes",
        "attempt",
        "limit",
        "offset",
        "total",
        "nativeHttpStatus",
        "nativeCloseCode",
      ])
        if (Number.isSafeInteger(fields[key]) && fields[key] >= 0)
          row[key] = fields[key];
      for (const key of ["ok", "nativeRetryable", "nativeRequestTimedOut"])
        if (typeof fields[key] === "boolean") row[key] = fields[key];
      console.info("[MuseApiTrace]", JSON.stringify(row));
    } catch (_) {}
  }
  static _nativeTraceFields(response) {
    const native = response?.nativeError || response?.receipt?.nativeError;
    if (!native || !["rpc", "history"].includes(native.source)) return {};
    return {
      nativeSource: native.source,
      nativeMethod: native.method,
      nativeKind: native.kind,
      nativeCode: native.code,
      nativeHttpStatus: native.httpStatus,
      nativeCloseCode: native.closeCode,
      nativeRetryable: native.retryable,
      nativeRequestTimedOut: native.requestTimedOut,
    };
  }
  static mode(settings = {}) {
    const mode = settings.museGenMode;
    if (mode === void 0 || mode === null || mode === "") return "web";
    if (!["web", "api"].includes(mode)) throw new Error("MUSE_MODE_INVALID");
    return mode;
  }
  static effectiveMode(settings = {}) {
    const requested = this.mode(settings);
    return requested === "api" &&
      window.featureGate?.canUse?.("muse_api_enabled") !== true
      ? "web"
      : requested;
  }
  static route(settings = {}) {
    const initialGenMode = settings.museRequestedMode || this.mode(settings);
    const genMode =
      settings.museModeResolved === true
        ? this.mode(settings)
        : this.effectiveMode(settings);
    return {
      genMode,
      initialGenMode,
      fallbackReason:
        initialGenMode === "api" && genMode === "web"
          ? "muse_api_permission_disabled"
          : null,
    };
  }
  static workflowMode() {
    return this.mode(window.storageSettings?.getSettings?.() || {});
  }
  static workflowEffectiveMode() {
    return this.effectiveMode({ museGenMode: this.workflowMode() });
  }
  static async workflowHeaderStatus() {
    await window.featureGate?.init?.();
    if (!this._workflowHeaderBound && window.eventBus?.on) {
      this._workflowHeaderBound = true;
      const invalidate = () => {
        this._workflowHeaderEpoch = (this._workflowHeaderEpoch || 0) + 1;
        this._workflowHeaderCache = null;
      };
      window.eventBus.on("provider:api_config_updated", (event) => {
        if (!event?.provider || event.provider === "muse") invalidate();
      });
      window.eventBus.on("bridge:changed", invalidate);
      globalThis.chrome?.tabs?.onRemoved?.addListener((tabId) => {
        if (tabId === this._workflowHeaderTabId) invalidate();
      });
      globalThis.chrome?.tabs?.onUpdated?.addListener((tabId, change) => {
        if (
          tabId === this._workflowHeaderTabId &&
          (change.url || ["loading", "complete"].includes(change.status))
        )
          invalidate();
      });
    }
    const selected = this.workflowMode(),
      effective = this.workflowEffectiveMode();
    const auth = window.authManager;
    const key = JSON.stringify([
      auth?.getUser?.()?.id ?? auth?.user?.id ?? null,
      auth?.getToken?.() ?? auth?.token ?? null,
      selected,
      effective,
      this._workflowHeaderEpoch || 0,
    ]);
    const ttl = window.FlowApiSessionCoordinator?.HEALTH_TTL_MS;
    if (
      Number.isSafeInteger(ttl) &&
      ttl > 0 &&
      this._workflowHeaderCache?.key === key &&
      Date.now() - this._workflowHeaderCache.at < ttl
    )
      return this._workflowHeaderCache.status;
    if (this._workflowHeaderFlight?.key === key)
      return this._workflowHeaderFlight.promise;
    const task = (async () => {
      let status;
      if (selected !== "api")
        status = { selected, apiMode: false, ready: false, error: null };
      else if (effective !== "api")
        status = {
          selected,
          apiMode: false,
          ready: false,
          error: "MUSE_API_FEATURE_REQUIRED",
        };
      else {
        const result = await this.ensureReady();
        if (Number.isInteger(result?.tabId))
          this._workflowHeaderTabId = result.tabId;
        const error =
          typeof result?.error === "string" &&
          /^[A-Z][A-Z0-9_]{1,90}$/.test(result.error)
            ? result.error
            : null;
        status = {
          selected,
          apiMode: true,
          ready: result?.ready === true,
          checking: false,
          error: error || (result?.ready ? null : "MUSE_API_NOT_READY"),
        };
      }
      status = Object.freeze(status);
      this._workflowHeaderCache = { key, at: Date.now(), status };
      return status;
    })();
    const promise = task.finally(() => {
      if (this._workflowHeaderFlight?.promise === promise)
        this._workflowHeaderFlight = null;
    });
    this._workflowHeaderFlight = { key, promise };
    return promise;
  }
  static nodeReadinessEntries(
    nodes = [],
    { includeDisabled = false, edges = [] } = {},
  ) {
    return nodes
      .filter(
        (node) =>
          (node.node_type || node.class) === "muse" &&
          (node.enabled !== false || includeDisabled),
      )
      .map((node) => ({
        museGenMode: this.workflowMode(),
        mode: node.media_type === "Video" ? "video" : "image",
        quantity: node.quantity ?? 1,
        deleteAfterGen: node.muse_delete_after_gen === true,
        museVideoRefCount:
          String(node.ref_file_ids || "")
            .split(",")
            .map((id) => id.trim())
            .filter(
              (id) =>
                id &&
                (node._museVideoPortRefIds?.has(id) ||
                  node.ref_thumbnails?.[id]?.type === "video" ||
                  node.ref_thumbnails?.[id]?.video_url),
            ).length ||
          (edges.some(
            (edge) =>
              edge.target_node_id === node.node_id &&
              edge.target_port === "video_ref",
          )
            ? 1
            : 0),
        refs: String(node.ref_file_ids || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      }));
  }
  static taskReadinessEntry(task = {}) {
    return {
      museGenMode: task.muse_gen_mode || "web",
      mode: task.media_type === "Video" ? "video" : "image",
      quantity: task.quantity ?? 1,
      deleteAfterGen:
        typeof task.muse_delete_after_gen === "boolean"
          ? task.muse_delete_after_gen
          : window.storageSettings?.getSettings?.()?.museDeleteAfterGen ===
            true,
      refs:
        task.ref_image_mode === "none"
          ? []
          : String(task.ref_file_ids || "")
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
    };
  }
  static async checkReadiness({
    entries = [],
    checkWeb,
    reload = false,
    activateTab = false,
  } = {}) {
    if (reload) {
      let navigation;
      try {
        navigation = await window.MuseSession.reloadForReadiness();
      } catch (_) {
        return { ready: false, error: "MUSE_RELOAD_FAILED" };
      }
      if (!navigation?.success)
        return {
          ready: false,
          error: navigation?.error || "NEW_CHAT_NAVIGATION_FAILED",
          tabId: navigation?.tabId,
        };
      entries = entries.map((entry) => ({
        ...entry,
        museTabId: navigation.tabId,
      }));
    }
    const api = entries.filter((entry) => this.route(entry).genMode === "api");
    const webRequired = !entries.length || api.length < entries.length;
    if (!api.length)
      return { ...(await checkWeb()), genMode: "web", apiMode: false };
    let checked;
    const checks = new Map();
    try {
      for (const entry of api) {
        const key = JSON.stringify([
          entry.mode,
          entry.deleteAfterGen === true,
          !!entry.refs?.length,
          entry.museVideoRefCount > 0,
        ]);
        if (!checks.has(key))
          checks.set(
            key,
            this.ensureReady({
              settings: { ...entry, museRefCount: entry.refs?.length || 0 },
              activateTab,
            }),
          );
        checked = await checks.get(key);
        if (!checked.ready) break;
        this.validateInput(
          { settings: entry, refs: entry.refs || [] },
          checked.policy,
        );
      }
    } catch (error) {
      checked = {
        ready: false,
        error: error?.code || error?.message || "MUSE_API_NOT_READY",
      };
    }
    const web = webRequired ? await checkWeb() : null;
    return {
      ready: checked?.ready === true && (!webRequired || web?.ready === true),
      genMode: webRequired ? "mixed" : "api",
      apiMode: true,
      tabId: checked?.tabId ?? web?.tabId,
      tabOpen: Number.isInteger(checked?.tabId) || web?.tabOpen === true,
      bridgeVersion: checked?.bridgeVersion || null,
      error:
        checked?.ready !== true
          ? checked?.error || "MUSE_API_NOT_READY"
          : webRequired && !web?.ready
            ? web?.error || "MUSE_NOT_READY"
            : null,
    };
  }
  static readinessLabel(name, health) {
    if (health?.genMode === "api") return `${name} API`;
    const translatedWeb = window.I18n?.t?.("museApi.webTitle");
    const web =
      typeof translatedWeb === "string" &&
      translatedWeb &&
      translatedWeb !== "museApi.webTitle"
        ? translatedWeb
        : "";
    if (health?.genMode === "mixed")
      return web ? `${name} \xB7 ${web} / API` : `${name} API`;
    return web ? `${name} \xB7 ${web}` : name;
  }
  static errorMessage(error, translate) {
    const t = translate || ((key) => window.I18n?.t?.(key));
    const code = String(error?.code || error?.message || error || "").trim();
    const keys = /^MUSE_[A-Z0-9_]+$/.test(code)
      ? [`museErrors.${code}`, `museErrors.${code.replace(/\d+$/, "")}`]
      : [];
    for (const key of [...keys, "museErrors.unknown", "museApi.unavailable"]) {
      const value = t?.(key);
      if (typeof value === "string" && value && value !== key) return value;
    }
    return "";
  }
  static errorHtml(error) {
    const span = document.createElement("span");
    span.textContent = this.errorMessage(error);
    return span.innerHTML;
  }
  static readinessRecoveryHtml(error) {
    const connect = error === "MUSE_COMPOSER_AMBIGUOUS";
    if (!connect && error !== "MUSE_SCRIPT_INJECTION_FAILED") return "";
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.reloadMuse = "";
    button.className = "provider-status-reload";
    const connectKey = "museErrors.connect";
    const connectText = connect ? window.I18n?.t?.(connectKey) : null;
    button.title = connect
      ? connectText && connectText !== connectKey
        ? connectText
        : this.errorMessage(error)
      : window.I18n?.t?.("common.retry") || "";
    button.setAttribute("aria-label", button.title);
    button.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;width:25px;height:25px;padding:0;border:0;background:transparent;color:inherit;cursor:pointer";
    button.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 3V8M3 8H8M3 8L6 5.29168C7.59227 3.86656 9.69494 3 12 3C16.9706 3 21 7.02944 21 12C21 16.9706 16.9706 21 12 21C7.71683 21 4.13247 18.008 3.22302 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (connect) {
      button.textContent = button.title;
      button.dataset.connectMuse = "";
      button.style.width = "auto";
      button.style.textDecoration = "underline";
    }
    return button.outerHTML;
  }
  static activeTaskMode(taskId) {
    return this._activeTaskLanes.get(String(taskId))?.mode || null;
  }
  static trackTaskLane(taskId, mode) {
    const key = String(taskId),
      owner = { mode };
    this._activeTaskLanes.set(key, owner);
    return () => {
      if (this._activeTaskLanes.get(key) === owner)
        this._activeTaskLanes.delete(key);
    };
  }
  static _owner() {
    const userId = window.authManager?.getUser?.()?.id;
    if (!userId) throw new Error("MUSE_OWNER_REQUIRED");
    return `toby-user:${userId}`;
  }
  static async policy() {
    if (window.featureGate?.canUse?.("muse_api_enabled") !== true)
      throw new Error("MUSE_API_FEATURE_REQUIRED");
    await window.ProviderConfigManager.fetchPrivateConfigs();
    const runtime = window.ProviderConfigManager.getApiConfigValueSync(
      "muse",
      "muse_api_runtime",
    );
    const composer = await window.ProviderConfigManager.get(
      "muse",
      "api_native_composer",
    );
    if (
      runtime?.version !== 1 ||
      runtime.driver !== "native-page-v1" ||
      !composer?.selectors?.length
    )
      throw new Error("MUSE_API_CONFIG_REQUIRED");
    const policy = {
      ...structuredClone(runtime),
      composerSelectors: [...composer.selectors],
    };
    if (
      runtime.media_transfer &&
      (await window.BridgeClient?.ping?.())?.capabilities?.includes(
        "muse_media_chunk_1m_v1",
      )
    ) {
      const size = runtime.media_transfer.chunk_bytes;
      if (!Number.isSafeInteger(size) || size <= 0 || size > 1048576)
        throw new Error("MUSE_MEDIA_TRANSFER_CONFIG_REQUIRED");
      policy.chunk_bytes = size;
    }
    return Object.freeze(policy);
  }
  static validateInput({ settings = {}, refs = [] }, policy) {
    if (policy?.enabled !== true) throw new Error("MUSE_API_DISABLED");
    if (
      !["video", "image"].includes(settings.mode) ||
      !policy.media_types?.includes(settings.mode) ||
      policy.quantity !== 1 ||
      Number(settings.quantity ?? 1) !== 1 ||
      settings.newChat === false
    )
      throw new Error("MUSE_API_INPUT_UNSUPPORTED");
    if (
      refs.length &&
      window.featureGate?.canUseProviderRefImages?.("muse") !== true
    )
      throw new Error("MUSE_REF_IMAGES_NOT_ALLOWED");
  }
  static _refMime(ref) {
    const blob = ref instanceof Blob ? ref : ref?.blob;
    const embedded =
      typeof ref?.base64 === "string" &&
      ref.base64.match(/^data:([^;]+);base64,/);
    const declared =
      typeof ref?.type === "string" && ref.type.includes("/")
        ? ref.type
        : ref?.mime_type;
    return String(blob?.type || (embedded && embedded[1]) || declared || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
  }
  static async _mediaRefs(refs) {
    return Promise.all(
      refs.map(async (ref) => {
        let base64 = ref?.base64,
          mime = this._refMime(ref);
        const blob = ref instanceof Blob ? ref : ref?.blob;
        if (blob instanceof Blob) {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let text = "";
          for (let i = 0; i < bytes.length; i += 8192)
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
          base64 = btoa(text);
        }
        const embedded =
          typeof base64 === "string" &&
          base64.match(/^data:([^;]+);base64,(.+)$/s);
        if (embedded) base64 = embedded[2];
        const video = /^video\/[a-z0-9.+-]+$/.test(mime);
        if (
          (!["image/png", "image/jpeg", "image/webp"].includes(mime) &&
            !video) ||
          typeof base64 !== "string" ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) ||
          base64.length % 4 !== 0
        )
          throw new Error("MUSE_IMAGE_REFS_INVALID");
        return {
          type: video ? "file" : "image",
          mime_type: mime,
          data_base64: base64,
          filename:
            typeof ref?.name === "string"
              ? ref.name.slice(0, 200)
              : "reference",
        };
      }),
    );
  }
  static async _payloadHash(prompt, refs) {
    return Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            refs.length ? JSON.stringify({ prompt, refs }) : prompt,
          ),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  static async runBatch(
    count,
    run,
    { mode = "video", shouldStop = () => false } = {},
  ) {
    await window.ExecutionConfig.getConfig();
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error("MUSE_EXECUTION_CONFIG_REQUIRED");
    const monitorLimit = () =>
      mode === "video"
        ? window.ExecutionConfig.getQueueVideoMaxMonitor()
        : window.ExecutionConfig.getQueueMaxMonitor();
    return new Promise((resolve, reject) => {
      let next = 0,
        active = 0,
        failure = null,
        closed = false,
        unsubscribe;
      const pump = () => {
        if (closed) return;
        let limit;
        try {
          limit = monitorLimit();
          if (!Number.isSafeInteger(limit) || limit <= 0)
            throw new Error("MUSE_EXECUTION_CONFIG_REQUIRED");
        } catch (error) {
          failure || (failure = error);
        }
        while (!failure && !shouldStop() && next < count && active < limit) {
          const index = next++;
          active++;
          Promise.resolve()
            .then(() => run(index))
            .catch((error) => {
              failure || (failure = error);
            })
            .finally(() => {
              active--;
              pump();
            });
        }
        if (!active && (failure || shouldStop() || next >= count)) {
          closed = true;
          if (typeof unsubscribe === "function") unsubscribe();
          else window.eventBus?.off?.("execution_config:refreshed", pump);
          if (failure) reject(failure);
          else resolve();
        }
      };
      unsubscribe = window.eventBus?.on?.("execution_config:refreshed", pump);
      pump();
    });
  }
  static async ensureReady({
    settings = {},
    shouldStop = null,
    activateTab = false,
  } = {}) {
    let readinessStage = "permission",
      bridgeVersion = null;
    try {
      if (shouldStop?.()) return { ready: false, error: "CANCELLED" };
      if (window.featureGate?.canUse?.("muse_api_enabled") !== true)
        return { ready: false, error: "MUSE_API_FEATURE_REQUIRED" };
      readinessStage = "private_policy";
      const policy = await this.policy();
      if (policy.enabled !== true)
        return { ready: false, error: "MUSE_API_DISABLED" };
      readinessStage = "bridge_ping";
      const ping = await window.BridgeClient.ping();
      bridgeVersion = ping.version || null;
      if (!ping.installed)
        return {
          ready: false,
          error: ping.error || "BRIDGE_NOT_INSTALLED",
          readinessStage,
        };
      if (
        ![
          "muse_prepare_command",
          "muse_submit",
          "muse_poll_result",
          "muse_read_media_chunk",
        ].every((method) => ping.capabilities?.includes(method))
      )
        return { ready: false, error: "MUSE_BRIDGE_UPDATE_REQUIRED" };
      if (
        policy.confirmation?.enabled === true &&
        !ping.capabilities?.includes("muse_confirmation_v1")
      )
        return { ready: false, error: "MUSE_BRIDGE_UPDATE_REQUIRED" };
      if (
        settings.museVideoRefCount > 0 &&
        !ping.capabilities?.includes("muse_video_refs_v1")
      )
        return { ready: false, error: "MUSE_BRIDGE_UPDATE_REQUIRED" };
      if (
        settings.museRefCount > 0 &&
        !ping.capabilities?.includes("muse_image_refs_v1")
      )
        return { ready: false, error: "MUSE_BRIDGE_UPDATE_REQUIRED" };
      if (
        (settings.mode === "image" &&
          !ping.capabilities?.includes("muse_image_result_v1")) ||
        (settings.deleteAfterGen === true &&
          !ping.capabilities?.includes("muse_cleanup"))
      )
        return { ready: false, error: "MUSE_BRIDGE_UPDATE_REQUIRED" };
      readinessStage = "prepare_session";
      const result = await window.BridgeClient.request("muse_prepare_session", {
        policy,
        ...(Number.isInteger(settings.museTabId)
          ? { tabId: settings.museTabId }
          : {}),
      });
      if (!result?.ok && result?.diagnostic)
        console.warn(
          "[MuseReadinessFailure]",
          JSON.stringify({
            stage: readinessStage,
            error: result.error,
            reason: result.diagnostic.reason,
            script: result.diagnostic.script,
          }),
        );
      if (result?.ok && activateTab) {
        readinessStage = "activate_tab";
        if (shouldStop?.())
          return { ready: false, error: "CANCELLED", readinessStage };
        const activation = await window.MuseSession?.activateProbedTab?.(
          result.tabId,
        );
        if (activation?.success !== true)
          return {
            ready: false,
            error: activation?.error || "MUSE_TAB_ACTIVATION_UNCONFIRMED",
            readinessStage,
            tabId: result.tabId,
          };
      }
      return result?.ok
        ? {
            ready: true,
            policy,
            scope: result.scope,
            tabId: result.tabId,
            documentId: result.documentId,
            bridgeVersion: ping.version || null,
          }
        : {
            ready: false,
            error: result?.error || "MUSE_API_NOT_READY",
            readinessStage,
            bridgeVersion,
            nativeError: result?.nativeError || null,
            executorVersion: Number.isSafeInteger(result?.executorVersion)
              ? result.executorVersion
              : null,
            executorProtocol: Number.isSafeInteger(result?.executorProtocol)
              ? result.executorProtocol
              : null,
            tabId: Number.isInteger(result?.tabId) ? result.tabId : void 0,
          };
    } catch (error) {
      return {
        ready: false,
        error: error?.code || error?.message || "MUSE_API_NOT_READY",
        readinessStage,
        bridgeVersion,
      };
    }
  }
  static async _remember(handle, patch = {}) {
    const owner = this._owner();
    const work = this._write
      .catch(() => {})
      .then(async () => {
        const key = `${this._RUNS_KEY}:${owner}:${handle.commandId}`;
        const row = (await chrome.storage.local.get(key))[key] || {};
        if (owner !== this._owner() || owner !== handle.ownerScope)
          throw new Error("MUSE_OWNER_CHANGED");
        await chrome.storage.local.set({
          [key]: { ...row, ...handle, ...patch, updatedAt: Date.now() },
        });
      });
    this._write = work.catch(() => {});
    return work;
  }
  static async listRuns() {
    const owner = this._owner();
    const rows = await chrome.storage.local.get(null);
    if (owner !== this._owner()) throw new Error("MUSE_OWNER_CHANGED");
    return Object.entries(rows)
      .filter(
        ([key, row]) =>
          key.startsWith(`${this._RUNS_KEY}:${owner}:`) &&
          row?.ownerScope === owner,
      )
      .map(([, row]) => row)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  static async _getRun(commandId) {
    const owner = this._owner(),
      key = `${this._RUNS_KEY}:${owner}:${commandId}`;
    const row = (await chrome.storage.local.get(key))[key];
    if (owner !== this._owner()) throw new Error("MUSE_OWNER_CHANGED");
    return row?.ownerScope === owner && row.commandId === commandId
      ? row
      : null;
  }
  static async _request(method, handle, policy, extra = {}) {
    if (handle.ownerScope !== this._owner())
      throw new Error("MUSE_OWNER_CHANGED");
    const traced = [
      "muse_submit",
      "muse_get_receipt",
      "muse_stop",
      "muse_cleanup",
      "muse_release_media",
    ].includes(method);
    const started = Date.now();
    if (traced) this._trace("rpc_started", handle, { method });
    try {
      const result = await window.BridgeClient.request(method, {
        commandId: handle.commandId,
        ownerScope: handle.ownerScope,
        tabId: handle.tabId,
        documentId: handle.documentId,
        scope: handle.scope,
        policy,
        ...extra,
      });
      if (!traced && result?.error === "MUSE_DOCUMENT_CHANGED")
        this._trace("rpc_read_failed", handle, {
          method,
          error: result.error,
          reason: result.documentChangeReason,
        });
      if (traced)
        this._trace("rpc_completed", handle, {
          method,
          ok: result?.ok === true,
          status: result?.receipt?.status || result?.cleanupStatus,
          error: result?.error,
          elapsedMs: Date.now() - started,
          ...this._nativeTraceFields(result),
        });
      return result;
    } catch (error) {
      if (traced)
        this._trace("rpc_failed", handle, {
          method,
          error: error?.code,
          elapsedMs: Date.now() - started,
        });
      throw error;
    }
  }
  static async submit({
    prompt,
    refs = [],
    settings = {},
    shouldStop = null,
    onProgress = null,
  } = {}) {
    let handle,
      policy,
      stopTimer,
      dispatchRequested = false,
      accountingAttempted = false;
    let errorDetails = [];
    const stopped = () => shouldStop?.() === true;
    try {
      if (stopped())
        return { success: false, error: "CANCELLED", noRetry: true };
      const ownerScope = this._owner();
      const ready = await this.ensureReady({
        settings: {
          ...settings,
          museRefCount: refs.length,
          museVideoRefCount: refs.filter((ref) =>
            this._refMime(ref).startsWith("video/"),
          ).length,
        },
        shouldStop,
        activateTab: settings.source === "workflow",
      });
      if (!ready.ready)
        throw Object.assign(new Error(ready.error), {
          errorDetails: this.nativeErrorDetails(ready),
        });
      if (ownerScope !== this._owner()) throw new Error("MUSE_OWNER_CHANGED");
      policy = ready.policy;
      this.validateInput({ settings, refs }, policy);
      const imageRefs = await this._mediaRefs(refs);
      if (ownerScope !== this._owner()) throw new Error("MUSE_OWNER_CHANGED");
      const refBytes = imageRefs.reduce(
        (total, ref) =>
          total +
          (ref.data_base64.length / 4) * 3 -
          (ref.data_base64.endsWith("==")
            ? 2
            : ref.data_base64.endsWith("=")
              ? 1
              : 0),
        0,
      );
      if (
        imageRefs.length &&
        (!Number.isSafeInteger(policy.max_media_bytes) ||
          refBytes > policy.max_media_bytes)
      )
        throw new Error("MUSE_IMAGE_REFS_TOO_LARGE");
      if (
        typeof settings.executionToken !== "string" ||
        !settings.executionToken ||
        !window.ExecutionGate?.recordMuseApiIntent
      )
        throw new Error("MUSE_EXISTING_RESERVATION_REQUIRED");
      const execution = await window.ExecutionConfig.getConfig();
      const readMonitorLimit = () =>
        settings.mode === "video"
          ? window.ExecutionConfig.getQueueVideoMaxMonitor()
          : window.ExecutionConfig.getQueueMaxMonitor();
      let monitorLimit = readMonitorLimit();
      const timeout = Number(
        window.ProviderConfigManager.getApiConfigValueSync(
          "muse",
          "timeouts",
        )?.[settings.mode === "image" ? "image_ms" : "video_ms"],
      );
      if (
        !Number.isSafeInteger(monitorLimit) ||
        monitorLimit <= 0 ||
        !Number.isSafeInteger(timeout) ||
        timeout <= 0 ||
        !Number.isSafeInteger(execution?.workflow?.max_retries) ||
        execution.workflow.max_retries < 0 ||
        !Number.isSafeInteger(policy.poll_interval_ms) ||
        policy.poll_interval_ms <= 0
      )
        throw new Error("MUSE_EXECUTION_CONFIG_REQUIRED");
      const payloadHash = await this._payloadHash(prompt, imageRefs);
      if (ownerScope !== this._owner()) throw new Error("MUSE_OWNER_CHANGED");
      handle = Object.freeze({
        provider: "muse",
        genMode: "api",
        commandId: `muse-${crypto.randomUUID()}`,
        payloadHash,
        ownerScope,
        scope: ready.scope,
        tabId: ready.tabId,
        documentId: ready.documentId,
        bridgeVersion: ready.bridgeVersion,
        requestedInput: {
          mediaType: settings.mode,
          ratio: settings.ratio ?? null,
          model: settings.model ?? null,
          quantity: Number(settings.quantity ?? 1),
        },
        deadlineAt: Date.now() + timeout,
        requestedMode: "api",
        source: settings.source || null,
        sourceId: settings.sourceId || null,
      });
      await this._remember(handle, { status: "prepared" });
      let stopSent = false;
      const sendStop = () => {
        if (!stopped() || stopSent) return;
        stopSent = true;
        this._request("muse_stop", handle, policy).catch(() => {});
      };
      stopTimer = setInterval(sendStop, policy.poll_interval_ms);
      if (stopped())
        return {
          success: false,
          error: "CANCELLED",
          noRetry: true,
          apiHandle: handle,
        };
      let response;
      do {
        if (stopped()) {
          sendStop();
          return {
            success: false,
            error: "CANCELLED",
            noRetry: true,
            apiHandle: handle,
          };
        }
        if (Date.now() >= handle.deadlineAt)
          throw new Error("MUSE_QUEUE_WAIT_TIMEOUT");
        monitorLimit = readMonitorLimit();
        if (!Number.isSafeInteger(monitorLimit) || monitorLimit <= 0)
          throw new Error("MUSE_EXECUTION_CONFIG_REQUIRED");
        response = await this._request("muse_prepare_command", handle, policy, {
          text: prompt,
          mode: settings.mode,
          newChat: true,
          expectedOutputs: 1,
          refs: imageRefs,
          confirmationLimit: execution.workflow.max_retries,
          monitorLimit,
          deadlineAt: handle.deadlineAt,
        });
        if (response.error !== "MUSE_QUEUE_FULL") break;
        if (Date.now() >= handle.deadlineAt)
          throw new Error("MUSE_QUEUE_WAIT_TIMEOUT");
        await new Promise((resolve) =>
          setTimeout(resolve, policy.poll_interval_ms),
        );
      } while (true);
      if (!response.ok)
        throw new Error(response.error || "MUSE_PREPARE_COMMAND_FAILED");
      this._trace("dispatch_prepared", handle, {
        status: response.receipt?.status,
      });
      accountingAttempted = true;
      const intent = await window.ExecutionGate.recordMuseApiIntent(
        settings.executionToken,
        handle.commandId,
        payloadHash,
        "dispatch_intent",
      );
      if (
        !["dispatch_intent", "accepted", "uncertain"].includes(
          (intent?.data || intent)?.state,
        )
      )
        throw new Error("MUSE_DISPATCH_GRANT_REQUIRED");
      if (stopped()) {
        sendStop();
        await window.ExecutionGate.recordMuseApiIntent(
          settings.executionToken,
          handle.commandId,
          payloadHash,
          "known_undelivered",
        );
        return {
          success: false,
          error: "CANCELLED",
          apiHandle: handle,
          noRetry: true,
        };
      }
      dispatchRequested = true;
      response = await this._request("muse_submit", handle, policy, {
        text: prompt,
        mode: settings.mode,
        newChat: true,
        expectedOutputs: 1,
        refs: imageRefs,
        confirmationLimit: execution.workflow.max_retries,
        monitorLimit,
        deadlineAt: handle.deadlineAt,
        dispatchAuthorized: true,
      });
      errorDetails = this.mergeErrorDetails(
        errorDetails,
        this.nativeErrorDetails(response),
      );
      const accountingState =
        response.knownUndelivered ||
        response.receipt?.status === "known_undelivered"
          ? "known_undelivered"
          : response.receipt?.status === "accepted"
            ? "accepted"
            : "uncertain";
      try {
        await window.ExecutionGate.recordMuseApiIntent(
          settings.executionToken,
          handle.commandId,
          payloadHash,
          accountingState,
        );
      } catch (_) {}
      if (!response.ok && response.knownUndelivered)
        throw new Error(response.error || "MUSE_SUBMIT_UNDELIVERED");
      await this._remember(handle, {
        status: response.receipt?.status || "uncertain",
      });
      return await this._monitor(
        handle,
        policy,
        execution.workflow.max_retries,
        stopped,
        onProgress,
        errorDetails,
        { executionToken: settings.executionToken },
      );
    } catch (error) {
      if (handle && policy && !dispatchRequested) {
        try {
          await this._request("muse_stop", handle, policy);
        } catch (_) {}
        if (accountingAttempted)
          try {
            await window.ExecutionGate.recordMuseApiIntent(
              settings.executionToken,
              handle.commandId,
              handle.payloadHash,
              "known_undelivered",
            );
          } catch (_) {}
        try {
          await this._remember(handle, { status: "known_undelivered" });
        } catch (_) {}
      }
      return {
        success: false,
        error: error?.code || error?.message || "MUSE_API_FAILED",
        noRetry: true,
        genMode: "api",
        errorDetails: this.mergeErrorDetails(errorDetails, error?.errorDetails),
        ...(handle ? { apiHandle: handle } : {}),
      };
    } finally {
      clearInterval(stopTimer);
    }
  }
  static nativeErrorDetails(response) {
    const native = response?.nativeError || response?.receipt?.nativeError;
    if (!native || !["rpc", "history"].includes(native.source)) return [];
    const keys = [
      "source",
      "method",
      "kind",
      "code",
      "message",
      "httpStatus",
      "retryable",
      "deliveryState",
      "requestTimedOut",
      "closeCode",
      "hasResult",
      "assistantStatus",
      "hasContent",
    ];
    const museError = Object.fromEntries(
      keys
        .filter((key) => native[key] !== void 0)
        .map((key) => [key, native[key]]),
    );
    const code =
      response.error ||
      response.receipt?.error ||
      (native.source === "history"
        ? "MUSE_GENERATION_FAILED"
        : "MUSE_NATIVE_RPC_FAILED");
    return [{ promptIndex: 0, provider: "muse", code, museError }];
  }
  static mergeErrorDetails(...groups) {
    const unique = [
      ...new Map(
        groups
          .flatMap((group) => (Array.isArray(group) ? group : []))
          .map((detail) => [JSON.stringify(detail), detail]),
      ).values(),
    ];
    return unique.length <= 8 ? unique : [unique[0], ...unique.slice(-7)];
  }
  static async _monitor(
    handle,
    policy,
    readBudget,
    stopped = () => false,
    onProgress = null,
    errorDetails = [],
    authorization = null,
  ) {
    let failures = 0;
    let observedStatus = null;
    while (Date.now() < handle.deadlineAt) {
      if (stopped())
        return {
          success: false,
          error: "CANCELLED",
          noRetry: true,
          genMode: "api",
          apiHandle: handle,
          errorDetails,
        };
      let response;
      try {
        response = await this._request("muse_poll_result", handle, policy);
      } catch (error) {
        error.errorDetails = this.mergeErrorDetails(
          errorDetails,
          error.errorDetails,
        );
        throw error;
      }
      errorDetails = this.mergeErrorDetails(
        errorDetails,
        this.nativeErrorDetails(response),
      );
      if (!response?.ok) {
        this._trace("monitor_read_failed", handle, {
          error: response?.error,
          ...this._nativeTraceFields(response),
        });
        if (
          [
            "MUSE_ACCOUNT_OR_VM_CHANGED",
            "MUSE_HISTORY_SCOPE_MISMATCH",
            "MUSE_SESSION_CONTAMINATED",
          ].includes(response?.error) ||
          failures++ >= readBudget
        )
          throw Object.assign(
            new Error(response?.error || "MUSE_READ_FAILED"),
            { errorDetails },
          );
      } else {
        const receipt = response.receipt;
        if (observedStatus !== receipt.status) {
          observedStatus = receipt.status;
          this._trace("monitor_status", handle, { status: receipt.status });
        }
        await this._remember(handle, { status: receipt.status, errorDetails });
        if (receipt.status === "media_ready")
          return this.materialize(
            handle,
            receipt,
            policy,
            stopped,
            false,
            onProgress,
          );
        if (receipt.status === "awaiting_confirmation") {
          const review = async (reason) => {
            this._trace("confirmation_review", handle, { error: reason });
            await this._remember(handle, {
              status: "awaiting_confirmation",
              confirmationReviewReason: reason,
            });
            return {
              success: false,
              error: "MUSE_CONFIRMATION_REVIEW_REQUIRED",
              confirmationPending: true,
              confirmationReason: reason,
              noRetry: true,
              genMode: "api",
              apiHandle: handle,
              errorDetails,
            };
          };
          const question = receipt.confirmation;
          const turn = receipt.confirmationTurns?.find(
            (item) => item.questionId === question?.questionId,
          );
          if (
            !question ||
            question.requiresReview ||
            !authorization?.executionToken
          )
            return review("MUSE_CONFIRMATION_REVIEW_REQUIRED");
          if (turn?.state === "known_undelivered")
            return review("MUSE_CONFIRMATION_REPLY_UNDELIVERED");
          if (!turn || turn.state === "intent") {
            const params = {
              questionId: question.questionId,
              questionHash: question.questionHash,
            };
            const prepared = await this._request(
              "muse_prepare_confirmation",
              handle,
              policy,
              params,
            );
            if (prepared?.receipt?.status === "media_ready")
              return this.materialize(
                handle,
                prepared.receipt,
                policy,
                stopped,
                false,
                onProgress,
              );
            if (!prepared?.ok)
              return review(
                prepared?.error || "MUSE_CONFIRMATION_REVIEW_REQUIRED",
              );
            if (prepared.confirmationIntent?.state === "intent") {
              if (stopped())
                return {
                  success: false,
                  error: "CANCELLED",
                  noRetry: true,
                  apiHandle: handle,
                  genMode: "api",
                };
              try {
                const grant = await window.ExecutionGate.recordMuseApiIntent(
                  authorization.executionToken,
                  handle.commandId,
                  handle.payloadHash,
                  "dispatch_intent",
                  { continuation: true },
                );
                if (
                  !["dispatch_intent", "accepted", "uncertain"].includes(
                    (grant?.data || grant)?.state,
                  )
                )
                  return review("MUSE_DISPATCH_GRANT_REQUIRED");
              } catch (_) {
                return review("MUSE_DISPATCH_GRANT_REQUIRED");
              }
              if (stopped())
                return {
                  success: false,
                  error: "CANCELLED",
                  noRetry: true,
                  apiHandle: handle,
                  genMode: "api",
                };
              try {
                const sent = await this._request(
                  "muse_reply_confirmation",
                  handle,
                  policy,
                  { ...params, dispatchAuthorized: true },
                );
                this._trace("confirmation_reply", handle, {
                  status: sent?.confirmationIntent?.state,
                  error: sent?.error,
                });
                if (sent?.receipt?.status === "media_ready")
                  return this.materialize(
                    handle,
                    sent.receipt,
                    policy,
                    stopped,
                    false,
                    onProgress,
                  );
                if (
                  sent?.knownUndelivered ||
                  sent?.confirmationIntent?.state === "known_undelivered"
                )
                  return review("MUSE_CONFIRMATION_REPLY_UNDELIVERED");
                if (!sent?.ok && !sent?.deliveryUncertain)
                  return review(
                    sent?.error || "MUSE_CONFIRMATION_REVIEW_REQUIRED",
                  );
              } catch (_) {}
            }
          }
        }
        if (receipt.status === "generation_failed")
          throw Object.assign(
            new Error(receipt.error || "MUSE_GENERATION_FAILED"),
            { errorDetails },
          );
        if (receipt.status === "known_undelivered")
          throw Object.assign(
            new Error(receipt.error || "MUSE_KNOWN_UNDELIVERED"),
            { errorDetails },
          );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, policy.poll_interval_ms),
      );
    }
    if (observedStatus === "awaiting_confirmation") {
      await this._remember(handle, {
        status: "awaiting_confirmation",
        confirmationReviewReason: "MUSE_MONITOR_TIMEOUT",
        errorDetails,
      });
      return {
        success: false,
        error: "MUSE_CONFIRMATION_REVIEW_REQUIRED",
        confirmationReason: "MUSE_MONITOR_TIMEOUT",
        confirmationPending: true,
        noRetry: true,
        genMode: "api",
        apiHandle: handle,
        errorDetails,
      };
    }
    await this._remember(handle, { status: "unresolved", errorDetails });
    return {
      success: false,
      error: "MUSE_MONITOR_TIMEOUT",
      noRetry: true,
      genMode: "api",
      apiHandle: handle,
      errorDetails,
    };
  }
  static _workflowMediaOwner(run) {
    if (run?.source !== "workflow" || run.ownerScope !== this._owner())
      return null;
    const linked = run.workflowResultOwner;
    if (
      typeof linked?.workflowId === "string" &&
      linked.workflowId &&
      typeof linked.nodeId === "string" &&
      linked.nodeId &&
      run.sourceId === `${linked.workflowId}:${linked.nodeId}`
    )
      return linked;
    const parts = /^([A-Za-z0-9_-]{1,200}):([A-Za-z0-9_-]{1,200})$/.exec(
      run.sourceId || "",
    );
    return parts ? { workflowId: parts[1], nodeId: parts[2] } : null;
  }
  static async workflowMediaWorkflowIds() {
    return [
      ...new Set(
        (await this.listRuns())
          .filter(
            (run) => run.status === "persisted" && !run.workflowMediaDiscarded,
          )
          .map((run) => this._workflowMediaOwner(run)?.workflowId)
          .filter(Boolean),
      ),
    ];
  }
  static async checkpointWorkflowResult(result, workflowId, nodeId, fileIds) {
    const handle = result?.apiHandle;
    if (!handle) return;
    const run = await this._getRun(handle.commandId);
    if (
      run?.source !== "workflow" ||
      run.ownerScope !== this._owner() ||
      run.sourceId !== `${workflowId}:${nodeId}` ||
      typeof workflowId !== "string" ||
      !workflowId ||
      typeof nodeId !== "string" ||
      !nodeId ||
      run.status !== "persisted" ||
      !Array.isArray(fileIds) ||
      !fileIds.length ||
      fileIds.some((id) => typeof id !== "string" || !id)
    )
      throw new Error("MUSE_WORKFLOW_RESULT_OWNER_MISMATCH");
    await this._remember(run, {
      workflowResultOwner: { workflowId, nodeId },
      workflowResultFileIds: [...fileIds],
    });
  }
  static async _discardWorkflowMedia(run, before = Infinity) {
    if (!this._workflowMediaOwner(run) || run.status !== "persisted") return;
    const removed = await window.MuseApiMediaStore.delete(run, 0, before);
    if (!removed && (await window.MuseApiMediaStore.get(run, 0))) return;
    await this._remember(run, { workflowMediaDiscarded: true });
    this._trace("workflow_media_discarded", run);
  }
  static async discardWorkflowMediaFiles(
    workflowId,
    nodeId,
    fileIds,
    userId,
    before = Infinity,
  ) {
    if (String(userId) !== String(window.authManager?.getUser?.()?.id))
      throw new Error("MUSE_OWNER_CHANGED");
    const deleted = new Set(fileIds);
    for (const run of await this.listRuns()) {
      const owner = this._workflowMediaOwner(run);
      if (
        owner?.workflowId !== workflowId ||
        owner.nodeId !== nodeId ||
        run.workflowMediaDiscarded ||
        !run.workflowResultFileIds?.some((id) => deleted.has(id))
      )
        continue;
      await this._discardWorkflowMedia(run, before);
    }
  }
  static async reconcileWorkflowMedia(workflowId, workflow, before) {
    if (!Number.isFinite(before)) return;
    const nodes = new Map(
      (workflow?.nodes || []).map((node) => [String(node.node_id), node]),
    );
    for (const run of await this.listRuns()) {
      const owner = this._workflowMediaOwner(run);
      if (
        owner?.workflowId !== workflowId ||
        run.status !== "persisted" ||
        run.workflowMediaDiscarded ||
        !Number.isFinite(run.updatedAt) ||
        run.updatedAt >= before
      )
        continue;
      const node = nodes.get(owner.nodeId);
      if (
        node &&
        (!["pending", "completed", "failed", "skipped"].includes(node.status) ||
          !Object.hasOwn(node, "result_file_ids"))
      )
        continue;
      const keep = new Set(
        String(node?.result_file_ids || "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      );
      const checkpointed =
        Array.isArray(run.workflowResultFileIds) &&
        run.workflowResultFileIds.length;
      if (
        !node ||
        (!keep.size && (checkpointed || run.cleanupStatus === "confirmed")) ||
        (checkpointed && !run.workflowResultFileIds.some((id) => keep.has(id)))
      )
        await this._discardWorkflowMedia(run, before);
    }
  }
  static async recover(
    handle,
    { tabId = null, shouldStop = null, expectedInput = null } = {},
  ) {
    if (handle?.ownerScope !== this._owner())
      throw new Error("MUSE_OWNER_CHANGED");
    const retained = await this._getRun(handle.commandId);
    if (expectedInput) {
      const currentHash = await this._payloadHash(
        expectedInput.prompt,
        await this._mediaRefs(expectedInput.refs || []),
      );
      const requested = handle.requestedInput;
      if (
        currentHash !== handle.payloadHash ||
        !requested ||
        requested.mediaType !== expectedInput.settings.mode ||
        requested.model !== expectedInput.settings.model ||
        requested.ratio !== expectedInput.settings.ratio ||
        requested.quantity !== Number(expectedInput.settings.quantity ?? 1)
      )
        return {
          success: false,
          error: "MUSE_CONFIRMATION_INPUT_CHANGED",
          confirmationPending: true,
          noRetry: true,
          genMode: "api",
          apiHandle: handle,
        };
    }
    if (retained?.workflowMediaDiscarded)
      return {
        success: false,
        error: "MUSE_WORKFLOW_RESULT_DISCARDED",
        noRetry: true,
      };
    const saved = retained
      ? await window.MuseApiMediaStore.get(retained, 0)
      : null;
    if (saved?.blob instanceof Blob) {
      const media =
        retained.media?.length === 1
          ? retained.media
          : [
              {
                index: 0,
                bytes: saved.blob.size,
                mime: saved.blob.type,
                width: null,
                height: null,
              },
            ];
      return this.materialize(
        retained,
        {
          status: "media_ready",
          media,
          sessionId: retained.sessionId,
          acceptedUserMessageId: retained.acceptedUserMessageId,
        },
        null,
        shouldStop || (() => false),
        true,
      );
    }
    const policy = await this.policy();
    if (retained?.cleanupStatus)
      return {
        success: false,
        noRetry: true,
        error: "MUSE_CLEANED_LOCAL_ASSET_MISSING",
        apiHandle: retained,
      };
    const execution = await window.ExecutionConfig.getConfig();
    const target = Object.freeze({
      ...handle,
      ...(Number.isInteger(tabId) ? { tabId } : {}),
    });
    const response = await this._request("muse_poll_result", target, policy);
    const errorDetails = this.mergeErrorDetails(
      retained?.errorDetails,
      this.nativeErrorDetails(response),
    );
    if (!response?.ok)
      return {
        success: false,
        error: response?.error || "MUSE_RECOVERY_FAILED",
        apiHandle: target,
        noRetry: true,
        errorDetails,
      };
    if (response.receipt.status === "media_ready")
      return this.materialize(
        target,
        response.receipt,
        policy,
        shouldStop || (() => false),
      );
    if (response.receipt.status === "generation_failed")
      return {
        success: false,
        error: response.receipt.error || "MUSE_GENERATION_FAILED",
        genMode: "api",
        apiHandle: target,
        noRetry: true,
        errorDetails,
      };
    if (
      response.receipt.status === "awaiting_confirmation" ||
      retained?.confirmationReviewReason
    )
      return {
        success: false,
        error: "MUSE_CONFIRMATION_REVIEW_REQUIRED",
        confirmationPending: true,
        genMode: "api",
        apiHandle: target,
        noRetry: true,
        errorDetails,
      };
    return this._monitor(
      target,
      policy,
      execution.workflow.max_retries,
      shouldStop || (() => false),
      null,
      errorDetails,
    );
  }
  static async materialize(
    handle,
    receipt,
    policy,
    stopped = () => false,
    localOnly = false,
    onProgress = null,
  ) {
    const started = Date.now();
    const progress = (fields) => {
      try {
        onProgress?.({ phase: "downloading", ...fields });
      } catch (_) {}
    };
    const mediaUrls = [],
      fetchedMedia = [];
    try {
      if (
        receipt?.status !== "media_ready" ||
        !Array.isArray(receipt.media) ||
        receipt.media.length !== 1 ||
        receipt.media.some(
          (resource) =>
            resource.index !== 0 ||
            !(handle.requestedInput?.mediaType === "image"
              ? ["image/webp", "image/png", "image/jpeg"].includes(
                  resource.mime,
                )
              : resource.mime === "video/mp4") ||
            !Number.isSafeInteger(resource.bytes) ||
            resource.bytes <= 0 ||
            (!localOnly && resource.bytes > policy.max_media_bytes),
        )
      )
        throw new Error("MUSE_MEDIA_RECEIPT_INVALID");
      for (const resource of receipt.media) {
        this._trace("media_local_read_started", handle, {
          resourceIndex: resource.index,
          bytes: resource.bytes,
        });
        progress({ bytes: 0, total: resource.bytes });
        let saved = await window.MuseApiMediaStore.get(handle, resource.index);
        this._trace("media_local_read_completed", handle, {
          resourceIndex: resource.index,
          ok: !!saved,
          elapsedMs: Date.now() - started,
        });
        if (!saved) {
          if (localOnly) throw new Error("MUSE_LOCAL_ASSET_MISSING");
          const chunks = [];
          let offset = 0,
            expectedHash = null;
          let documentReadFailures = 0,
            documentReadBudget = null,
            lastProgressAt = 0;
          this._trace("media_transfer_started", handle, {
            resourceIndex: resource.index,
            bytes: resource.bytes,
          });
          while (offset < resource.bytes) {
            if (stopped())
              return {
                success: false,
                error: "CANCELLED",
                apiHandle: handle,
                noRetry: true,
              };
            const readStarted = Date.now();
            if (offset === 0)
              this._trace("media_first_chunk_started", handle, {
                resourceIndex: resource.index,
              });
            const result = await this._request(
              "muse_read_media_chunk",
              handle,
              policy,
              { resourceIndex: resource.index, offset },
            );
            if (offset === 0 || !result?.ok)
              this._trace("media_chunk_read_completed", handle, {
                resourceIndex: resource.index,
                offset,
                ok: result?.ok === true,
                error: result?.error,
                elapsedMs: Date.now() - readStarted,
              });
            if (
              result?.error === "MUSE_DOCUMENT_CHANGED" &&
              Date.now() < handle.deadlineAt
            ) {
              if (documentReadBudget === null) {
                const config = await window.ExecutionConfig.getConfig();
                documentReadBudget = config?.workflow?.max_retries;
                if (
                  !Number.isSafeInteger(documentReadBudget) ||
                  documentReadBudget < 0
                )
                  throw new Error("MUSE_EXECUTION_CONFIG_REQUIRED");
              }
              if (documentReadFailures++ < documentReadBudget) {
                this._trace("media_read_retry", handle, {
                  error: result.error,
                  attempt: documentReadFailures,
                  limit: documentReadBudget,
                  offset,
                });
                await new Promise((resolve) =>
                  setTimeout(resolve, policy.poll_interval_ms),
                );
                continue;
              }
            }
            if (
              result?.error === "MUSE_MEDIA_CACHE_BUSY" &&
              Date.now() < handle.deadlineAt
            ) {
              await new Promise((resolve) =>
                setTimeout(resolve, policy.poll_interval_ms),
              );
              continue;
            }
            if (
              !result?.ok ||
              result.offset !== offset ||
              result.total !== resource.bytes ||
              result.mime !== resource.mime ||
              !Number.isSafeInteger(result.length) ||
              result.length <= 0 ||
              result.length > policy.chunk_bytes ||
              offset + result.length > resource.bytes ||
              typeof result.base64 !== "string" ||
              result.base64.length !== 4 * Math.ceil(result.length / 3) ||
              !/^[a-f0-9]{64}$/.test(result.sha256 || "") ||
              (expectedHash && expectedHash !== result.sha256)
            )
              throw Object.assign(
                new Error(result?.error || "MUSE_CHUNK_INVALID"),
                { errorDetails: this.nativeErrorDetails(result) },
              );
            expectedHash = result.sha256;
            const text = atob(result.base64),
              bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
            if (
              bytes.length !== result.length ||
              result.done !== (offset + bytes.length === resource.bytes)
            )
              throw new Error("MUSE_CHUNK_INVALID");
            chunks.push(bytes);
            offset += bytes.length;
            if (
              !lastProgressAt ||
              Date.now() - lastProgressAt >= 1e3 ||
              offset === resource.bytes
            ) {
              lastProgressAt = Date.now();
              this._trace("media_transfer_progress", handle, {
                resourceIndex: resource.index,
                offset,
                total: resource.bytes,
                elapsedMs: Date.now() - started,
              });
              progress({ bytes: offset, total: resource.bytes });
            }
          }
          this._trace("media_verify_started", handle, {
            resourceIndex: resource.index,
            bytes: resource.bytes,
          });
          const blob = new Blob(chunks, { type: resource.mime });
          const hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
            ),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          if (hash !== expectedHash)
            throw new Error("MUSE_TRANSFER_INTEGRITY_FAILED");
          this._trace("media_commit_started", handle, {
            resourceIndex: resource.index,
            bytes: resource.bytes,
          });
          await window.MuseApiMediaStore.put(
            handle,
            resource.index,
            blob,
            hash,
          );
          saved = { blob, sha256: hash };
        }
        if (
          saved.blob.size !== resource.bytes ||
          saved.blob.type !== resource.mime
        )
          throw new Error("MUSE_LOCAL_ASSET_INVALID");
        await this._remember(handle, {
          status: "persisted",
          media: receipt.media,
          sessionId: receipt.sessionId,
          acceptedUserMessageId: receipt.acceptedUserMessageId,
        });
        this._trace("media_persisted", handle, {
          resourceIndex: resource.index,
          bytes: resource.bytes,
        });
        if (stopped()) {
          mediaUrls.forEach((url2) => URL.revokeObjectURL(url2));
          return {
            success: false,
            error: "CANCELLED",
            apiHandle: handle,
            noRetry: true,
          };
        }
        if (!localOnly)
          try {
            await this._request("muse_release_media", handle, policy, {
              resourceIndex: resource.index,
            });
          } catch (_) {}
        let base64, poster;
        if (resource.mime.startsWith("image/")) {
          const bytes = new Uint8Array(await saved.blob.arrayBuffer());
          let text = "";
          for (let i = 0; i < bytes.length; i += 8192)
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
          base64 = `data:${resource.mime};base64,${btoa(text)}`;
        }
        if (resource.mime.startsWith("video/")) {
          try {
            poster = await window.ImmediateUploader?._portableVideoThumbnail?.(
              saved.blob,
              200,
              { representativeFrame: true },
            );
          } catch (_) {}
          if (!poster)
            this._trace("poster_unavailable", handle, {
              resourceIndex: resource.index,
            });
        }
        if (handle.ownerScope !== this._owner())
          throw new Error("MUSE_OWNER_CHANGED");
        if (stopped())
          return {
            success: false,
            error: "CANCELLED",
            apiHandle: handle,
            noRetry: true,
          };
        const url = URL.createObjectURL(saved.blob);
        mediaUrls.push(url);
        fetchedMedia.push({
          url,
          blob: saved.blob,
          ...(base64 ? { base64 } : {}),
          ...(poster ? { poster } : {}),
          sha256: saved.sha256,
          resourceIndex: resource.index,
        });
      }
      return {
        success: true,
        mediaType:
          handle.requestedInput?.mediaType === "image" ? "image" : "video",
        mediaUrls,
        fetchedMedia,
        genMode: "api",
        apiHandle: handle,
        requestedInput: handle.requestedInput,
        actualMedia: receipt.media.map((resource) => ({
          index: resource.index,
          width: resource.width,
          height: resource.height,
          bytes: resource.bytes,
          mime: resource.mime,
        })),
        provider: "muse",
        noRetry: true,
        apiReceipt: {
          commandId: handle.commandId,
          sessionId: receipt.sessionId,
          acceptedUserMessageId: receipt.acceptedUserMessageId,
          status: receipt.status,
        },
      };
    } catch (error) {
      this._trace("media_materialize_failed", handle, {
        error: error?.code || error?.message,
        elapsedMs: Date.now() - started,
      });
      mediaUrls.forEach((url) => URL.revokeObjectURL(url));
      return {
        success: false,
        generationSucceeded: true,
        error: error?.message || "MUSE_MEDIA_DOWNLOAD_FAILED",
        genMode: "api",
        apiHandle: handle,
        noRetry: true,
        errorDetails: error?.errorDetails || [],
      };
    }
  }
  static async cleanup(result) {
    try {
      const handle = result?.apiHandle;
      if (!result?.success || result.genMode !== "api" || !handle)
        throw new Error("MUSE_CLEANUP_NOT_READY");
      const saved = await window.MuseApiMediaStore.get(handle, 0);
      if (!(saved?.blob instanceof Blob) || !saved.blob.size)
        throw new Error("MUSE_CLEANUP_NOT_PERSISTED");
      const policy = await this.policy();
      const response = await this._request("muse_cleanup", handle, policy, {
        persisted: true,
      });
      await this._remember(handle, {
        cleanupStatus: response.cleanupStatus || "unconfirmed",
      });
      return {
        success: response.ok === true,
        error: response.error,
        cleanupStatus: response.cleanupStatus,
      };
    } catch (error) {
      return { success: false, error: error?.message || "MUSE_CLEANUP_FAILED" };
    }
  }
  static async download(result, url, filename, waitForComplete = false) {
    try {
      if (result?.apiHandle?.ownerScope !== this._owner())
        throw new Error("MUSE_OWNER_CHANGED");
    } catch (error) {
      return { success: false, error: error?.message || "MUSE_OWNER_REQUIRED" };
    }
    const fetched = result.fetchedMedia?.find((item) => item.url === url);
    if (!(fetched?.blob instanceof Blob))
      return { success: false, error: "MUSE_LOCAL_ASSET_MISSING" };
    const extension = {
      "image/webp": "webp",
      "image/png": "png",
      "image/jpeg": "jpg",
    }[fetched.blob.type];
    if (extension)
      filename = /\.[^/.]+$/.test(filename)
        ? filename.replace(/\.[^/.]+$/, `.${extension}`)
        : `${filename}.${extension}`;
    return window.DownloadHelper.downloadExternalMedia({
      blob: fetched.blob,
      filename,
      mediaType: result.mediaType === "image" ? "image" : "video",
      waitForComplete,
    });
  }
  static async localAsset(commandId, resourceIndex = 0) {
    const handle = await this._getRun(commandId);
    if (!handle) throw new Error("MUSE_LOCAL_ASSET_OWNER_REQUIRED");
    const saved = await window.MuseApiMediaStore.get(handle, resourceIndex);
    if (!saved?.blob) throw new Error("MUSE_LOCAL_ASSET_MISSING");
    return { ...saved, handle };
  }
}
__publicField(MuseApiFacade, "_RUNS_KEY", "toby_muse_api_client_runs_v1");
__publicField(MuseApiFacade, "_write", Promise.resolve());
__publicField(MuseApiFacade, "_activeTaskLanes", new Map());
window.MuseApiFacade = MuseApiFacade;
