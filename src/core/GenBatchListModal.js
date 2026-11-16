class GenBatchListModal {
  constructor() {
    this.store = window.GenBatchQueueStore;
    this.queue = window.PromptQueue?.getInstance?.();
    this.listButton = document.getElementById("genBatchListBtn");
    this.addButton = document.getElementById("genBatchAddBtn");
    this.badge = document.getElementById("genBatchBadge");
    this.batches = [];
    this.snapshot = null;
    this.cachedJobs = [];
    this._showAllItems = new Set();
    this._cards = new Map();
    this._assetUrls = new Map();
    this._resultRepairs = new Map();
    this._resultRepairing = new Set();
    this._refThumbRepairs = new Map();
    this._refThumbRepairing = new Set();
    this._failedRefThumbUrls = new Set();
    this._failedRefThumbKeys = new Map();
    this._mediaCatalogEpoch = 0;
    this._videoPreviewObserver = null;
    this._activeDownload = null;
    this._downloadPollTimer = null;
    this._progressPollTimer = null;
    this._elapsedTimer = null;
    this._progressPollBusy = false;
    this._activeCoordinatorLease = null;
    this._busy = false;
    this._open = false;
    this._opening = false;
    this._instanceId = Math.random().toString(36).slice(2, 10);
    this._lastScrolledActiveBatchId = null;
    this._renderQueued = false;
    this._listRefHydrationEpoch = 0;
    this._refCatalogHydrationQueued = false;
    this._runConfirmCheckEpoch = 0;
    this._runConfirmCheckInFlight = null;
    this._view = "flow";
    this._itemLayout = "list";
    this._itemLayoutTouched = false;
    this._storageScanPromise = null;
    this.webView = window.ProviderWebBatchView
      ? new window.ProviderWebBatchView(this)
      : null;
    this.scheduler = new window.GenBatchScheduler({
      store: this.store,
      queue: this.queue,
      scope: () => this._scope(),
      admit: (
        batch,
        onAdmission,
        runSource,
        runOriginId,
        generationProcessId,
      ) =>
        window.GenBatchAdmission.admit(
          batch,
          onAdmission,
          void 0,
          runSource,
          runOriginId,
          generationProcessId,
        ),
      onChange: () => {
        this.reload().catch((error) => this._error(error));
      },
      onError: (error) => this._error(error),
    });
    this._create();
    this._bind();
    this._loadItemLayout();
    this._toggleProvider();
    this.reload().catch((error) => this._error(error));
  }
  _t(key, fallback, params = {}) {
    const translationKey = `genBatch.${key}`;
    const translated = window.I18n?.t?.(translationKey, params);
    if (translated && translated !== translationKey) return translated;
    if (key === "close") {
      const shared = window.I18n?.t?.("common.close");
      if (shared && shared !== "common.close") return shared;
    }
    if (key === "addToReferences" || key === "addResultsToReferences") {
      const shared = window.I18n?.t?.("gen.addRef");
      if (shared && shared !== "gen.addRef") return shared;
    }
    return fallback !== void 0 ? fallback : translated || translationKey;
  }
  _modeSettingsLabel() {
    const translate = (key, fallback) => {
      const value = window.I18n?.t?.(key);
      return value && value !== key ? value : fallback;
    };
    return `${translate("settings.title", "Settings")} \xB7 ${translate("settings.subMaxSpeed", "Max Speed")}`;
  }
  _layoutText(key, fallback) {
    const name = `genBatch.${key}`;
    const value = window.I18n?.t?.(name);
    return value && value !== name ? value : fallback;
  }
  _refreshBatchStorageUsage() {
    if (this._storageScanPromise) return this._storageScanPromise;
    this._storageScanPromise = this._readBatchStorageUsage()
      .then((bytes) => {
        if (!this._open) return;
        const label = this.overlay.querySelector(".gen-batch-storage-size");
        if (label) label.textContent = this._formatStorageBytes(bytes);
        this._syncBatchStorageLabel();
      })
      .catch((error) => {
        console.warn(
          "[GenBatchListModal] Batch storage estimate unavailable:",
          error?.message || error,
        );
        if (this._open) {
          const label = this.overlay.querySelector(".gen-batch-storage-size");
          if (label) label.textContent = "\u2014";
          this._syncBatchStorageLabel();
        }
      })
      .finally(() => {
        this._storageScanPromise = null;
      });
    return this._storageScanPromise;
  }
  _formatStorageBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(2)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }
  _syncBatchStorageLabel() {
    const button = this.overlay.querySelector(".gen-batch-storage-usage");
    if (!button) return;
    const translated = window.I18n?.t?.("settings.storage");
    const storageLabel =
      translated && translated !== "settings.storage" ? translated : "Storage";
    const tooltip = window.I18n?.t?.("albums.storageBarTooltip");
    const storageTooltip =
      tooltip && tooltip !== "albums.storageBarTooltip"
        ? tooltip
        : "Storage usage \u2014 click to open Settings";
    const batchTitle = this._t("title", "Batch list");
    button.setAttribute(
      "aria-label",
      `${batchTitle} \xB7 ${storageLabel}: ${button.querySelector(".gen-batch-storage-size").textContent}. ${storageTooltip}`,
    );
    button.dataset.tooltip = storageTooltip;
    button.removeAttribute("title");
  }
  async _readBatchStorageUsage() {
    const usage = await window.LocalStorageUsage.scanBatch();
    return usage.bytes;
  }
  async _loadItemLayout() {
    try {
      const stored = await chrome.storage.local.get(
        "tobyflow_batch_list_item_layout",
      );
      const value = stored?.tobyflow_batch_list_item_layout;
      if (!this._itemLayoutTouched && ["list", "grid"].includes(value)) {
        this._itemLayout = value;
        this._syncItemLayout();
      }
    } catch (error) {
      console.warn(
        "[GenBatchListModal] Item layout load:",
        error?.message || error,
      );
    }
  }
  _syncItemLayout() {
    if (!this.overlay) return;
    this.body.dataset.itemLayout = this._itemLayout;
    const trigger = this.overlay.querySelector(
      '[data-action="item-layout-toggle"]',
    );
    if (trigger) {
      const nextLayout = this._itemLayout === "list" ? "grid" : "list";
      const nextLabel = this._layoutText(
        nextLayout === "grid" ? "itemLayoutGrid" : "itemLayoutList",
        nextLayout === "grid" ? "Thumbnail grid" : "List",
      );
      const label = `${this._layoutText("itemLayout", "Prompt layout")}: ${nextLabel}`;
      trigger.setAttribute("aria-label", label);
      trigger.dataset.tooltip = label;
      trigger.dataset.layout = this._itemLayout;
    }
  }
  _scope() {
    const userId = window.authManager?.getUser?.()?.id;
    const projectId = window._currentProjectId;
    return userId && projectId ? { userId, projectId } : null;
  }
  _queuedCount() {
    const scope = this._scope();
    if (!scope) return 0;
    return this.batches.filter(
      (batch) =>
        String(batch.userId) === String(scope.userId) &&
        String(batch.projectId) === String(scope.projectId) &&
        ["queued", "needs_review"].includes(batch.status),
    ).length;
  }
  _escape(value) {
    return String(value ?? "").replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[char],
    );
  }
  _modelBrandIcon(provider) {
    const icon = window.ProviderBrandIcons?.get?.(provider) || "";
    return icon
      ? `<span class="gen-batch-item-brand" data-provider="${this._escape(provider)}" aria-hidden="true">${icon}</span>`
      : "";
  }
  _emptyState(provider, label) {
    const icon = this.overlay.querySelector(
      `.gen-batch-provider-tabs [data-view="${provider}"] .gen-batch-provider-icon`,
    );
    const source =
      icon?.firstElementChild ||
      document.querySelector(
        `#genProviderTabs .provider-tab[data-provider="${provider}"] .provider-tab-icon`,
      );
    return `<div class="gen-batch-empty" data-provider="${provider}"><span class="gen-batch-empty-icon" aria-hidden="true">${source?.outerHTML || ""}</span><p>${this._escape(label)}</p></div>`;
  }
  _setHeaderMode(badge, label, state) {
    const dot = document.createElement("span");
    dot.className = "gen-batch-header-mode-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = label;
    badge.replaceChildren(dot, text);
    badge.dataset.state = state;
  }
  _setModeSettingsAccess(badge, enabled) {
    if (enabled) {
      const label = this._modeSettingsLabel();
      badge.dataset.action = "flow-settings";
      badge.dataset.tooltip = label;
      badge.setAttribute("role", "button");
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("aria-label", label);
    } else {
      delete badge.dataset.action;
      badge.removeAttribute("role");
      badge.removeAttribute("tabindex");
      badge.removeAttribute("aria-label");
    }
  }
  _statusLabel(state) {
    const key = String(state || "").toLowerCase();
    const labels = {
      queued: "Queued",
      admitting: "Admitting",
      running: "Running",
      paused: "Paused",
      completed: "Completed",
      failed: "Failed",
      stopped: "Stopped",
      needs_review: "Needs review",
      pending: "Pending",
      submitting: "Submitting",
      submitted: "Submitted",
      monitoring: "Monitoring",
      partial_fail: "Partial",
      cancelled: "Cancelled",
      blocked: "Blocked",
      recovery_required: "Recovery required",
      waiting_user: "Waiting for user",
      waiting_provider: "Waiting for Flow",
      retry_submit: "Queued to retry",
      waiting_dependency: "Waiting for previous result",
    };
    const translationKey = `genBatch.status_${key}`;
    const translated = window.I18n?.t?.(translationKey);
    return translated && translated !== translationKey
      ? translated
      : labels[key] || state || "";
  }
  _itemErrorText(item) {
    const raw = typeof item?.error === "string" ? item.error.trim() : "";
    if (raw) {
      const translated = window.FlowApiAdapter?.formatError?.(raw) || raw;
      return translated !== raw && /^[A-Za-z][A-Za-z0-9_]{2,119}$/.test(raw)
        ? `${translated} (${raw})`
        : translated;
    }
    return typeof item?.errorDisplay === "string"
      ? item.errorDisplay.trim()
      : "";
  }
  _resultEvidenceNodes(results) {
    return (results || [])
      .map((result, resultIndex) => {
        if (result.unavailable) return "";
        const url = result.video
          ? result.playUrl || (result.poster ? null : result.url)
          : result.url;
        const thumb = result.video
          ? result.poster === true
            ? result.thumbnail || result.sourceThumbnail
            : null
          : result.thumbnail || result.url;
        if (thumb && /^https?:\/\//.test(thumb))
          return /^https?:\/\//.test(url || "")
            ? `<button type="button" class="gen-batch-editor-result" data-action="view" data-result-index="${resultIndex}" data-url="${this._escape(url)}" data-media-type="${result.video ? "video" : "image"}" data-poster="${result.video ? this._escape(thumb) : ""}" aria-label="${this._escape(this._t(result.video ? "playVideo" : "viewResult"))}"><img src="${this._escape(thumb)}" loading="lazy" decoding="async" alt=""></button>`
            : `<span class="gen-batch-editor-result" data-media-type="${result.video ? "video" : "image"}"><img src="${this._escape(thumb)}" loading="lazy" decoding="async" alt=""></span>`;
        return result.video && /^https?:\/\//.test(url || "")
          ? `<button type="button" class="gen-batch-editor-result gen-batch-editor-video is-preview-loading" data-action="view" data-result-index="${resultIndex}" data-url="${this._escape(url)}" data-media-type="video" aria-label="${this._escape(this._t("playVideo"))}"><video muted playsinline preload="metadata" data-preview-src="${this._escape(url)}" aria-hidden="true"></video></button>`
          : "";
      })
      .filter(Boolean);
  }
  _resultEvidenceHtml(results) {
    return this._resultEvidenceNodes(results).join("");
  }
  _itemEvidenceHtml(item, { downloadable = false } = {}) {
    const previews = this._resultEvidenceHtml(item?.results);
    const error = this._itemErrorText(item);
    if (!previews && !error) return "";
    const errorLabel = window.I18n?.t?.("common.error") || "Error";
    return `<section class="gen-batch-editor-evidence" aria-label="${this._escape(this._statusLabel(item.state || item.status))}">
      ${previews ? `<div class="gen-batch-editor-results">${previews}</div>${downloadable ? `<button type="button" class="gen-batch-editor-download" data-action="download-editor-result"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/></svg><span>${this._escape(this._t("download"))}</span></button>` : ""}` : ""}
      ${error ? `<div class="gen-batch-editor-error"><strong>${this._escape(errorLabel)}</strong><p>${this._escape(error)}</p></div>` : ""}
    </section>`;
  }
  _itemEvidenceForEditor(item, batch, index) {
    if (!batch) return item;
    return {
      ...item,
      results: (item.results || []).map((result, resultIndex) => {
        const repair = this._resultRepairs.get(
          `${batch.batchId}|${index}|${resultIndex}`,
        );
        return repair?._sourceResultKey === this._resultSignature(result)
          ? repair
          : result;
      }),
    };
  }
  _batchItemResultsForEditor(batch, index) {
    const rootId = this._batchRuntimeRootId(batch, index);
    const job = this._jobForBatchItem(batch, index);
    const runtime = this._runtimeItemByRoot(job?.items, rootId);
    const results = runtime?.results?.length
      ? runtime.results
      : this._receiptResults(batch, index);
    return this._itemEvidenceForEditor({ results }, batch, index).results;
  }
  _batchResultReferences(batch, onlyIndex = null) {
    const references = [],
      seen = new Set();
    const indices =
      onlyIndex == null
        ? (batch?.items || []).map((_, index) => index)
        : [onlyIndex];
    for (const index of indices) {
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= (batch?.items?.length || 0)
      )
        continue;
      if (batch.items[index]?.hidden) continue;
      for (const result of this._batchItemResultsForEditor(batch, index)) {
        this._appendResultReference(references, seen, result);
      }
    }
    return references;
  }
  _directResultReferences(job, onlyIndex = null) {
    const references = [],
      seen = new Set();
    const items =
      onlyIndex == null ? job?.items || [] : [job?.items?.[onlyIndex]];
    for (const item of items) {
      for (const result of item?.results || [])
        this._appendResultReference(references, seen, result);
    }
    return references;
  }
  _appendResultReference(references, seen, result) {
    const fileId =
      result?.tileId ||
      result?.fileName ||
      result?.mediaUuid ||
      result?.mediaId;
    if (typeof fileId !== "string" || !fileId.trim() || seen.has(fileId.trim()))
      return;
    seen.add(fileId.trim());
    references.push({
      fileId: fileId.trim(),
      file_name: result.fileName || null,
      media_uuid: result.mediaUuid || result.media_uuid || null,
      thumbnail:
        result.thumbnail ||
        result.sourceThumbnail ||
        (!result.video ? result.url : null) ||
        null,
      type: result.video ? "video" : "image",
      video_url: result.video ? result.playUrl || result.url || null : null,
    });
  }
  _modeLabel(mode, count) {
    const labels = {
      all: "All refs",
      sequential: "Sequential refs",
      mention: "@Mention",
      none: "No refs",
      frames: "Frames",
    };
    const label = this._t(`mode_${mode}`, labels[mode] || mode || "");
    return mode === "sequential" ? `${label} \xB7 ${count || 1}` : label;
  }
  _currentRunRoute() {
    const settings = window.storageSettings?.getSettings?.() || {};
    const selected = settings.defaultGenMode || settings.gen_mode || "ui";
    return selected === "ui" ? "web" : selected;
  }
  _currentHeaderMode() {
    const settings = window.storageSettings?.getSettings?.() || {};
    const apiEnabled =
      settings.apiModeEnabled === true ||
      settings.apiModeEnabled === "true" ||
      settings.apiModeEnabled === 1;
    return apiEnabled &&
      window.SystemConfig?.get?.("flow_api_driver", null) !== "disabled"
      ? "api"
      : "web";
  }
  _notify(message, type = "warning") {
    window.showNotification?.(message, type, 4500);
  }
  _syncDownloadUi() {
    const task = this._activeDownload;
    const visible = task && task.projectId === this._scope()?.projectId;
    const labels = {
      running: ["Active", "Downloading"],
      done: ["Completed", "Done"],
      failed: ["Failed", "Error"],
      cancelled: ["Cancelled", "Cancelled"],
    };
    for (const card of this.body?.querySelectorAll(".gen-batch-card") || []) {
      const selected = visible && card.dataset.cardKey === task.cardKey;
      for (const row of card.querySelectorAll(".gen-batch-item")) {
        const status = row.querySelector(".gen-batch-item-status");
        if (!status) continue;
        const index = Number(row.dataset.itemIndex);
        const item = selected
          ? task.itemStates?.find((entry) => entry.promptIndex === index)
          : null;
        let state = item?.state;
        if (state === "pending")
          state =
            task.state === "running" && index === task.currentPromptIndex
              ? "running"
              : null;
        if (!state && status.dataset.downloadState) {
          status.textContent = status.dataset.downloadOriginalText;
          status.dataset.state = status.dataset.downloadOriginalState;
          delete status.dataset.downloadState;
          delete status.dataset.downloadOriginalText;
          delete status.dataset.downloadOriginalState;
        }
        if (state) {
          if (!status.dataset.downloadState) {
            status.dataset.downloadOriginalText = status.textContent;
            status.dataset.downloadOriginalState = status.dataset.state;
          }
          const [key, fallback] = labels[state] || labels.failed;
          const i18nKey = `queue.download${key}`;
          const translated = window.I18n?.t?.(i18nKey);
          status.textContent =
            translated && translated !== i18nKey ? translated : fallback;
          status.dataset.downloadState = state;
        }
        row.classList.toggle("is-downloading", state === "running");
      }
    }
    for (const button of this.overlay?.querySelectorAll(
      '[data-action="download-item"], [data-action="download-batch"], [data-action="download-editor-result"]',
    ) || [])
      button.disabled = !!visible && task.state === "running";
  }
  _trackDownload(response, batch, cardKey, sources) {
    if (!response?.downloadId) return;
    const prompts = Object.fromEntries(
      sources.map((source) => [
        source.promptIndex,
        String(source.prompt || "").trim(),
      ]),
    );
    this._activeDownload = {
      downloadId: response.downloadId,
      projectId: batch.projectId,
      cardKey,
      prompts,
      firstPromptIndex: sources[0]?.promptIndex ?? null,
      currentPromptIndex: sources[0]?.promptIndex ?? null,
      state: "running",
      completed: 0,
      total: response.total || 0,
      failed: 0,
      itemStates: sources.map((source, index) => ({
        promptIndex: source.promptIndex,
        state: index === 0 ? "running" : "pending",
      })),
      pollErrors: 0,
    };
    this._syncDownloadUi();
    clearInterval(this._downloadPollTimer);
    this._downloadPollTimer = setInterval(() => this._pollDownload(), 800);
    this._pollDownload();
  }
  async _requestDownload(action, payload, batch, cardKey, sources) {
    if (this._activeDownload?.state === "running")
      throw new Error("BATCH_DOWNLOAD_BUSY");
    this._activeDownload = {
      projectId: batch.projectId,
      cardKey,
      prompts: Object.fromEntries(
        sources.map((source) => [
          source.promptIndex,
          String(source.prompt || "").trim(),
        ]),
      ),
      firstPromptIndex: sources[0]?.promptIndex ?? null,
      currentPromptIndex: sources[0]?.promptIndex ?? null,
      state: "running",
      preparing: true,
      completed: 0,
      total: sources.reduce((sum, source) => sum + source.results.length, 0),
      itemStates: sources.map((source, index) => ({
        promptIndex: source.promptIndex,
        state: index === 0 ? "running" : "pending",
      })),
    };
    this._syncDownloadUi();
    try {
      const response = await window.MessageBridge?.sendToContentScript?.(
        action,
        payload,
      );
      if (response?.success !== true)
        throw new Error(response?.error || "BATCH_DOWNLOAD_SOURCE_UNAVAILABLE");
      this._trackDownload(response, batch, cardKey, sources);
    } catch (error) {
      this._activeDownload = null;
      this._syncDownloadUi();
      throw error;
    }
  }
  async _pollDownload() {
    const task = this._activeDownload;
    if (!task || task.polling || task.state !== "running") return;
    task.polling = true;
    try {
      const status = await window.MessageBridge.sendToContentScript(
        "genBatchDownloadStatus",
        { projectId: task.projectId, downloadId: task.downloadId },
      );
      if (this._activeDownload !== task) return;
      if (status?.success !== true)
        throw new Error(status?.error || "BATCH_DOWNLOAD_STATUS_UNAVAILABLE");
      task.pollErrors = 0;
      task.state = status.state;
      task.completed = status.completed;
      task.total = status.total;
      task.failed = status.failed;
      task.currentPromptIndex = status.currentPromptIndex;
      task.itemStates = status.items || task.itemStates;
      this._syncDownloadUi();
      if (task.state !== "running") {
        clearInterval(this._downloadPollTimer);
        this._downloadPollTimer = null;
        const summary = `${status.succeeded}/${status.total}`;
        this._notify(
          `${window.I18n?.t?.(task.state === "done" ? "queue.downloadCompleted" : "queue.downloadFailed") || (task.state === "done" ? "Done" : "Error")} \xB7 ${summary}`,
          task.state === "done" ? "success" : "error",
        );
        setTimeout(() => {
          if (this._activeDownload === task) {
            this._activeDownload = null;
            this._syncDownloadUi();
          }
        }, 5e3);
      }
    } catch (error) {
      if (this._activeDownload !== task) return;
      if (++task.pollErrors >= 3) {
        clearInterval(this._downloadPollTimer);
        this._downloadPollTimer = null;
        task.state = "failed";
        task.itemStates = task.itemStates?.map((item) =>
          item.state === "running" ? { ...item, state: "failed" } : item,
        );
        this._syncDownloadUi();
        this._error(error);
      }
    } finally {
      task.polling = false;
    }
  }
  _error(error) {
    const rawMessage = String(error?.message || error || "BATCH_ERROR");
    const serverCode =
      typeof error?.code === "string" &&
      /^[A-Z][A-Z0-9_]{2,100}$/.test(error.code)
        ? error.code
        : null;
    const code =
      serverCode && [403, 409].includes(Number(error.httpStatus))
        ? `${serverCode} (HTTP ${Number(error.httpStatus)})`
        : rawMessage;
    const message =
      code === "BATCH_LIMIT_EXCEEDED"
        ? this._t(
            "limitExceeded",
            `${error.count} prompts; maximum ${error.limit} per batch`,
            { count: error.count, limit: error.limit },
          )
        : code === "BATCH_QUEUE_FULL"
          ? Number(error?.limit) === 0
            ? this._t("queueDisabled")
            : this._t("queueFull", "", { limit: error?.limit })
          : [
                "BATCH_ENTITLEMENT_UNAVAILABLE",
                "BATCH_ENTITLEMENT_OR_QUEUE_UNAVAILABLE",
              ].includes(code)
            ? this._t(
                "entitlementUnavailable",
                "Cannot verify your Flow queue entitlement. Check the connection and try again.",
              )
            : code === "BATCH_QUEUE_ENTITLEMENT_UNAVAILABLE"
              ? this._t(
                  "entitlementUnavailable",
                  "Cannot verify your Flow queue entitlement. Check the connection and try again.",
                )
              : code === "BATCH_ITEM_ROUTE_CONFLICT"
                ? this._t(
                    "routeConflict",
                    "This input type would change the batch route. Edit the batch before admission.",
                  )
                : code === "BATCH_PROMPT_EMPTY"
                  ? window.I18n?.t?.("gen.noPromptWarning") ||
                    "Please enter at least 1 prompt!"
                  : code === "BATCH_LAST_PROMPT_REQUIRED"
                    ? this._t(
                        "deleteLastPrompt",
                        "A batch needs at least one prompt",
                      )
                    : code === "BATCH_CHAIN_FRAME_REF_LIMIT"
                      ? this._t(
                          "chainFrameRefLimit",
                          "Each following clip can use one Frame 2 image only when the model supports it alongside the previous last frame.",
                        )
                      : (() => {
                          const reason = ["muse", "chatgpt", "gemini"].includes(
                            this._view,
                          )
                            ? this.webView?._errorText(code) || code
                            : window.FlowApiAdapter?.formatError?.(code) ||
                              code;
                          return this._t("error", `Batch list: ${reason}`, {
                            reason,
                          });
                        })();
    this._notify(message, "error");
  }
  _create() {
    const overlay = document.createElement("div");
    const closeIcon =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg>';
    overlay.className = "gen-batch-modal-overlay hidden";
    overlay.innerHTML = `
      <section class="gen-batch-modal" role="dialog" aria-modal="true" aria-labelledby="genBatchTitle">
        <header class="gen-batch-modal-header">
          <div class="gen-batch-modal-brand"><img class="tobyflow-header-logo-img" src="icons/icon-32.png" alt="Toby Flow"><div><div class="gen-batch-brand-title-row"><h2 id="genBatchTitle" class="tobyflow-header-title">Toby Flow</h2><span class="gen-batch-header-mode" data-mode="web" data-action="flow-settings" role="button" tabindex="0" aria-label="${this._escape(this._modeSettingsLabel())}" data-tooltip="${this._escape(this._modeSettingsLabel())}">Web</span></div><span class="gen-batch-count"></span></div></div>
          <div class="gen-batch-header-actions"><button type="button" class="gen-batch-header-icon gen-batch-layout-trigger" data-action="item-layout-toggle" aria-label="Prompt layout"><svg class="gen-batch-layout-icon-grid" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg><svg class="gen-batch-layout-icon-list" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/></svg></button><button type="button" class="gen-batch-header-icon" data-action="clear-all" aria-label="${this._escape(this._t("clearAll"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg></button>
          <button type="button" class="gen-batch-modal-close" data-action="close" aria-label="${this._escape(this._t("close"))}">${closeIcon}</button></div>
        </header>
        <nav class="gen-batch-provider-tabs" aria-label="Batch provider">
          <button type="button" data-action="batch-view" data-view="flow"><span class="gen-batch-provider-icon" aria-hidden="true"></span><span>Flow</span></button>
          <button type="button" data-action="batch-view" data-view="muse"><span class="gen-batch-provider-icon" aria-hidden="true"></span><span>Muse</span></button>
          <button type="button" data-action="batch-view" data-view="chatgpt"><span class="gen-batch-provider-icon" aria-hidden="true"></span><span>ChatGPT</span></button>
          <button type="button" data-action="batch-view" data-view="gemini"><span class="gen-batch-provider-icon" aria-hidden="true"></span><span>Gemini</span></button>
        </nav>
        <div class="gen-batch-modal-body" tabindex="0"></div>
        <footer class="gen-batch-modal-footer">
          <div class="gen-batch-run-controls">
            <button type="button" data-action="run-all"></button>
            <button type="button" data-action="pause"></button>
            <button type="button" data-action="resume"></button>
            <button type="button" data-action="stop"></button>
          </div>
          <div class="gen-batch-clear-controls">
            <button type="button" data-action="clear-queued"></button>
            <button type="button" data-action="clear-history"></button>
          </div>
        </footer>
      </section>
      <section class="gen-batch-run-confirm hidden" role="dialog" aria-modal="true" aria-labelledby="genBatchRunTitle">
        <div class="confirm-run-modal gen-batch-run-panel">
          <div class="confirm-run-header"><span class="confirm-run-title" id="genBatchRunTitle"></span>
            <button type="button" class="confirm-run-close" data-action="run-confirm-no" aria-label="${this._escape(this._t("close"))}">${closeIcon}</button></div>
          <div class="confirm-run-body">
            <div class="confirm-run-stat"><span class="confirm-run-stat-label gen-batch-confirm-prompts-label"></span><span class="confirm-run-stat-value gen-batch-confirm-prompts"></span></div>
            <div class="confirm-run-provider-status gen-batch-confirm-provider" role="status" aria-live="polite">
              <span class="confirm-provider-info"><span class="confirm-provider-logo gen-batch-confirm-logo"></span><span class="confirm-run-provider-label gen-batch-confirm-provider-name">Google Flow</span><span class="confirm-gentype-chip gen-batch-confirm-media"></span></span>
              <span class="confirm-run-provider-badge is-checking gen-batch-confirm-badge"><svg class="badge-icon badge-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span class="badge-text"></span></span>
            </div>
            <div class="confirm-run-info-row"><span class="confirm-run-info-label gen-batch-confirm-batches-label"></span><span class="confirm-run-info-value gen-batch-confirm-batches"></span></div>
            <div class="confirm-flow-tabs-warning hidden gen-batch-confirm-tabs-warning" role="status"></div>
          </div>
          <div class="confirm-run-footer"><button type="button" class="confirm-run-cancel" data-action="run-confirm-no"></button>
            <button type="button" class="confirm-run-submit" data-action="run-confirm-yes"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg><span></span></button></div>
        </div>
      </section>
      <section class="gen-batch-editor hidden" role="dialog" aria-modal="true" aria-label="${this._escape(this._t("editPrompt"))}">
        <header><span class="gen-batch-editor-heading"><span class="gen-batch-editor-brand" aria-hidden="true"></span><h3 class="gen-batch-editor-title"></h3></span><button type="button" class="gen-batch-editor-close" data-action="editor-cancel" aria-label="${this._escape(this._t("close"))}">${closeIcon}</button></header>
        <div class="gen-batch-editor-fields"></div>
        <footer><button type="button" class="gen-batch-editor-back" data-action="editor-cancel" aria-label="${this._escape(this._t("close"))}" data-tooltip="${this._escape(this._t("close"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><span class="gen-batch-editor-footer-spacer"></span><button type="button" class="gen-batch-editor-cancel" data-action="editor-cancel"></button><button type="button" class="gen-batch-editor-save" data-action="editor-save"></button></footer>
      </section>
      <section class="gen-batch-download-overlay hidden" role="dialog" aria-modal="true" aria-label="${this._escape(this._t("download"))}">
        <div class="gen-batch-download-panel">
          <header><h3></h3><button type="button" class="gen-batch-download-close" aria-label="${this._escape(this._t("close"))}">${closeIcon}</button></header>
          <div class="gen-batch-download-content"></div>
          <footer><button type="button" class="gen-batch-download-cancel"></button><button type="button" class="gen-batch-download-submit"></button></footer>
        </div>
      </section>`;
    const storageButton = document.createElement("button");
    storageButton.type = "button";
    storageButton.className = "gen-batch-storage-usage";
    storageButton.dataset.action = "storage-settings";
    storageButton.dataset.tooltipPlacement = "bottom";
    storageButton.innerHTML =
      '<span class="gen-batch-storage-size">\u2014</span><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>';
    overlay.querySelector(".gen-batch-header-mode").after(storageButton);
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.body = overlay.querySelector(".gen-batch-modal-body");
    this._syncItemLayout();
  }
  _bind() {
    this.overlay.addEventListener(
      "load",
      (event) => {
        const image = event.target;
        if (!image?.matches?.(".gen-batch-result img[data-repair-key]")) return;
        if (image.naturalWidth > 0)
          image.parentElement?.classList.remove("is-preview-loading");
      },
      true,
    );
    this.overlay.addEventListener(
      "error",
      (event) => {
        const media = event.target;
        if (media?.matches?.("img[data-ref-repair-key]")) {
          this._recoverRefThumbnail(media).catch((error) =>
            console.warn(
              "[GenBatch] Reference preview recovery failed:",
              error?.message || error,
            ),
          );
          return;
        }
        if (
          !media?.matches?.(
            ".gen-batch-result img[data-repair-key], .gen-batch-result video[data-repair-key]",
          )
        )
          return;
        this._recoverResultThumbnail(media).catch((error) =>
          console.warn(
            "[GenBatch] Result preview recovery failed:",
            error?.message || error,
          ),
        );
      },
      true,
    );
    this.overlay.addEventListener(
      "loadeddata",
      (event) => {
        if (
          event.target?.matches?.(
            ".gen-batch-result video, .gen-batch-editor-result video",
          )
        )
          event.target.parentElement?.classList.remove("is-preview-loading");
      },
      true,
    );
    this.listButton?.addEventListener("click", () => this.open());
    this.addButton?.addEventListener("click", () => this.add());
    this.overlay.addEventListener("click", (event) => {
      if (
        this._downloadResolve &&
        event.target ===
          this.overlay.querySelector(".gen-batch-download-overlay")
      )
        return this._finishDownloadOptions(null);
      if (
        this._downloadResolve &&
        event.target.closest?.(
          ".gen-batch-download-close, .gen-batch-download-cancel",
        )
      )
        return this._finishDownloadOptions(null);
      if (
        this._downloadResolve &&
        event.target.closest?.(".gen-batch-download-submit")
      )
        return this._finishDownloadOptions(this._downloadSelection);
      const option =
        this._downloadResolve &&
        event.target.closest?.(".gen-batch-download-choice");
      if (option) {
        if (option.dataset.locked === "true") {
          chrome.runtime
            .sendMessage({ action: "showUpgradeModal" })
            .catch(() => {});
          return;
        }
        const kind = option.dataset.kind;
        this._downloadSelection[kind] = option.dataset.value;
        this.overlay
          .querySelectorAll(`.gen-batch-download-choice[data-kind="${kind}"]`)
          .forEach((node) =>
            node.setAttribute("aria-pressed", String(node === option)),
          );
        return;
      }
      if (event.target === this.overlay) this.close("backdrop");
      const button = event.target.closest?.("[data-action]");
      if (
        !button?.matches(
          '[data-action="batch-menu"], [data-action="item-menu"], [data-action="web-item-menu"]',
        )
      )
        for (const menu of this.overlay.querySelectorAll(
          ".gen-batch-action-menu:not([hidden])",
        )) {
          menu.hidden = true;
          menu.previousElementSibling?.setAttribute("aria-expanded", "false");
        }
      if (!button || !this.overlay.contains(button)) return;
      event.stopPropagation();
      this._action(button).catch((error) => this._error(error));
    });
    this.overlay.addEventListener("keydown", (event) => {
      if (
        ["Enter", " "].includes(event.key) &&
        event.target.matches?.('[data-action="batch-frame-source-select"]')
      ) {
        event.preventDefault();
        this._selectBatchFrameSource(event.target.dataset.refKey);
        return;
      }
      if (
        !["Enter", " "].includes(event.key) ||
        !event.target.matches?.(
          '.gen-batch-header-mode[data-action="flow-settings"]',
        )
      )
        return;
      event.preventDefault();
      this._action(event.target).catch((error) => this._error(error));
    });
    this.overlay.addEventListener("dragstart", (event) => {
      const row = event.target.closest?.(
        ".gen-batch-editor .gen-batch-ref-row",
      );
      if (this._editor?.kind !== "batch" || !row) return;
      this._dragRefRow = row;
      row.classList.add("dragging");
      event.dataTransfer?.setData("text/plain", row.dataset.refKey);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    this.overlay.addEventListener("dragover", (event) => {
      if (
        this._dragRefRow?.classList.contains("frame-source-thumb") &&
        event.target.closest?.(".gen-batch-editor .gen-batch-batch-frame-slot")
      ) {
        event.preventDefault();
        event.target
          .closest(".gen-batch-batch-frame-slot")
          .classList.add("frame-drag-over");
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        return;
      }
      const row = event.target.closest?.(
        ".gen-batch-editor .gen-batch-ref-row",
      );
      if (
        !this._dragRefRow ||
        !row ||
        row === this._dragRefRow ||
        row.parentElement !== this._dragRefRow.parentElement
      )
        return;
      event.preventDefault();
      row.classList.add("drag-over");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    this.overlay.addEventListener("dragleave", (event) => {
      event.target
        .closest?.(".gen-batch-ref-row")
        ?.classList.remove("drag-over");
      event.target
        .closest?.(".gen-batch-batch-frame-slot")
        ?.classList.remove("frame-drag-over");
    });
    this.overlay.addEventListener("drop", (event) => {
      const frameSlot = event.target.closest?.(
        ".gen-batch-editor .gen-batch-batch-frame-slot",
      );
      if (
        frameSlot &&
        this._dragRefRow?.classList.contains("frame-source-thumb")
      ) {
        event.preventDefault();
        frameSlot.classList.remove("frame-drag-over");
        this._setBatchFrameSlot(
          Number(frameSlot.dataset.originalIndex),
          frameSlot.dataset.frameName,
          this._dragRefRow.dataset.refKey,
        );
        return;
      }
      const target = event.target.closest?.(
        ".gen-batch-editor .gen-batch-ref-row",
      );
      const dragged = this._dragRefRow;
      if (
        !target ||
        !dragged ||
        target === dragged ||
        target.parentElement !== dragged.parentElement
      )
        return;
      event.preventDefault();
      const rows = [...target.parentElement.children];
      const from = rows.indexOf(dragged),
        to = rows.indexOf(target);
      if (from < to) target.after(dragged);
      else target.before(dragged);
      [...target.parentElement.children].forEach((row, index) => {
        const thumb = row.matches(".ref-thumb")
          ? row
          : row.querySelector(".ref-thumb");
        if (thumb) thumb.dataset.index = String(index + 1);
        row.classList.remove("drag-over");
      });
      this._refreshBatchPreview();
    });
    this.overlay.addEventListener("dragend", () => {
      this._dragRefRow?.classList.remove("dragging");
      this._dragRefRow = null;
      this.overlay
        .querySelectorAll(".gen-batch-ref-row.drag-over")
        .forEach((row) => row.classList.remove("drag-over"));
      this.overlay
        .querySelectorAll(".gen-batch-batch-frame-slot.frame-drag-over")
        .forEach((slot) => slot.classList.remove("frame-drag-over"));
    });
    this.body.addEventListener(
      "scroll",
      () => {
        for (const menu of this.overlay.querySelectorAll(
          ".gen-batch-action-menu:not([hidden])",
        )) {
          menu.hidden = true;
          menu.previousElementSibling?.setAttribute("aria-expanded", "false");
        }
      },
      { passive: true },
    );
    document.addEventListener("keydown", (event) => {
      if (document.querySelector(".cdialog-overlay, .imgpicker-overlay"))
        return;
      if (event.key === "Escape" && this._open && !this._renameInput) {
        if (this._runConfirmResolve) this._finishRunConfirm(false);
        else if (this._downloadResolve) this._finishDownloadOptions(null);
        else if (this.webView?.editing) this.webView._closeEdit();
        else if (this._editor) this._closeEditor();
        else this.close("escape");
      }
      if (event.key === "Tab" && this._open) {
        const region = this._downloadResolve
          ? this.overlay.querySelector(".gen-batch-download-overlay")
          : this._runConfirmResolve
            ? this.overlay.querySelector(".gen-batch-run-confirm")
            : this._editor || this.webView?.editing
              ? this.overlay.querySelector(".gen-batch-editor")
              : this.overlay.querySelector(".gen-batch-modal");
        const controls = [
          ...region.querySelectorAll(
            "button, input, select, textarea, [tabindex]",
          ),
        ].filter(
          (node) =>
            !node.disabled &&
            node.tabIndex >= 0 &&
            node.getClientRects().length,
        );
        if (!controls.length) return;
        const first = controls[0],
          last = controls.at(-1);
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            !region.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !region.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    window.eventBus?.on?.("queue:state_changed", (snapshot) => {
      this._traceQueueBatchVisibility(snapshot);
      this.snapshot = snapshot;
      this.scheduler.observe(snapshot);
      this.scheduler.observeRegen(snapshot);
      this._scheduleRender();
    });
    for (const name of [
      "project:changed",
      "auth:login",
      "auth:logout",
      "auth:restored",
    ]) {
      window.eventBus?.on?.(name, () => {
        if (this._runConfirmResolve) this._finishRunConfirm(false);
        if (this._downloadResolve) this._finishDownloadOptions(null);
        this.reload().catch((error) => this._error(error));
      });
    }
    window.eventBus?.on?.("provider:changed", () => this._toggleProvider());
    window.eventBus?.on?.("execution_config:refreshed", () => {
      this._toggleProvider();
      this._scheduleRender();
    });
    window.eventBus?.on?.("provider_web:changed", (event) => {
      if (this._matchesProviderWebChange(event))
        this.reload().catch((error) => this._error(error));
    });
    window.eventBus?.on?.("flow:video_identities_updated", (event) =>
      this._onMediaCatalogUpdated(event),
    );
    window.eventBus?.on?.("featuregate:refreshed", () =>
      this._scheduleRender(),
    );
    window.eventBus?.on?.("storageSettings:loaded", () =>
      this._scheduleRender(),
    );
    for (const name of ["i18n:changed", "i18n:reloaded"])
      window.eventBus?.on?.(name, () => this._scheduleRender());
    chrome.runtime.onMessage?.addListener?.((message) => {
      if (
        message?.action === "genBatch:changed" &&
        message.projectId === this._scope()?.projectId
      )
        this.reload().catch((error) => this._error(error));
      if (
        message?.action === "providerWeb:changed" &&
        this._matchesProviderWebChange(message)
      )
        this.reload().catch((error) => this._error(error));
    });
    window.addEventListener("pagehide", () => {
      if (this._open)
        console.info(
          "[GenBatchListModal] pagehide",
          JSON.stringify({ instanceId: this._instanceId, view: this._view }),
        );
    });
    window.addEventListener("focus", () => {
      if (this._open)
        console.info(
          "[GenBatchListModal] focus",
          JSON.stringify({
            instanceId: this._instanceId,
            view: this._view,
            overlayHidden: this.overlay.classList.contains("hidden"),
          }),
        );
    });
  }
  _matchesProviderWebChange(event) {
    return (
      !!event &&
      ((event.projectId != null &&
        event.projectId === this._scope()?.projectId) ||
        (!!event.runId &&
          (this.webView?.runs.has(event.runId) ||
            this.webView?.batches?.some(
              (batch) =>
                batch.source === "mcp_direct" &&
                batch.manualRuns?.some((entry) => entry.runId === event.runId),
            ))))
    );
  }
  _traceQueueBatchVisibility(snapshot) {
    const webBatches = (this.webView?.batches || []).map((batch) => ({
      id: batch.id,
      runId: batch.runId || null,
      provider: batch.provider,
      projectId: batch.projectId,
      status: batch.status,
    }));
    if (!webBatches.length) return;
    const state = {
      stage: "flow_queue_changed",
      projectId: this._scope()?.projectId || null,
      batchView: this._view,
      genProvider: document.getElementById("genProvider")?.value || null,
      flowJobs: (snapshot?.jobs || []).map((job) => ({
        id: job.id,
        projectId: job.projectId || null,
        status: job.status || job.state || null,
      })),
      webBatches: webBatches.slice(0, 20),
    };
    const signature = JSON.stringify(state);
    if (signature === this._lastQueueVisibilityTrace) return;
    this._lastQueueVisibilityTrace = signature;
    console.info("[GenFlowBatchVisibility]", signature);
  }
  _toggleProvider() {
    const provider = document.getElementById("genProvider")?.value;
    const webProvider = ["muse", "chatgpt", "gemini"].includes(provider);
    const listVisible = provider === "flow" || webProvider;
    const addVisible = listVisible;
    for (const [button, visible] of [
      [this.listButton, listVisible],
      [this.addButton, addVisible],
    ]) {
      if (!button) continue;
      button.classList.toggle("hidden", !visible);
      button.tabIndex = visible ? 0 : -1;
      button.setAttribute("aria-hidden", visible ? "false" : "true");
    }
    if (this.addButton) {
      if (webProvider) {
        const enabled2 =
          !this._busy &&
          !!this._scope() &&
          window.featureGate?.canUse?.(`${provider}_enabled`);
        this.addButton.disabled = false;
        this.addButton.setAttribute(
          "aria-disabled",
          enabled2 ? "false" : "true",
        );
        this.addButton.dataset.tooltip = enabled2
          ? this._t("add", "Add to queue")
          : this._t("addUnavailable", "Provider queue is unavailable");
        return;
      }
      let entitlementReady = false;
      try {
        entitlementReady =
          window.GenBatchDraftBuilder.checkLimit(1)?.allowed === true;
      } catch (_) {}
      let queueLimit = null;
      try {
        queueLimit = window.GenBatchDraftBuilder.getQueueLimit();
      } catch (_) {}
      const queued = this._queuedCount();
      const queueFull =
        queueLimit !== null && queueLimit !== -1 && queued >= queueLimit;
      const enabled =
        addVisible &&
        !this._busy &&
        !!this._scope() &&
        window.PromptQueue?.isEnabled?.() === true &&
        entitlementReady &&
        queueLimit !== null &&
        !queueFull;
      this.addButton.disabled = false;
      this.addButton.setAttribute("aria-disabled", enabled ? "false" : "true");
      this.addButton.dataset.tooltip = enabled
        ? this._t("add", "Add to queue")
        : queueFull
          ? queueLimit === 0
            ? this._t("queueDisabled")
            : this._t("queueFull", "", { limit: queueLimit })
          : this._t("addUnavailable", "Flow queue is unavailable");
    }
  }
  async reload() {
    const requestId = (this._reloadSeq || 0) + 1;
    this._reloadSeq = requestId;
    const owner = this._scope();
    if (this.webView && ["muse", "chatgpt", "gemini"].includes(this._view)) {
      await this.webView.reload();
      if (
        requestId !== this._reloadSeq ||
        String(this._scope()?.userId || "") !== String(owner?.userId || "") ||
        this._scope()?.projectId !== owner?.projectId
      )
        return;
      this._scheduleRender();
      return;
    }
    let batches = owner
      ? await this.store.list(owner.userId, owner.projectId)
      : [];
    const assetGroups =
      this._open && owner && this.store.getAssetsForBatch
        ? await Promise.all(
            batches
              .filter((batch) =>
                ["queued", "needs_review", "admitting"].includes(batch.status),
              )
              .map((batch) =>
                this.store.getAssetsForBatch(
                  owner.userId,
                  owner.projectId,
                  batch.batchId,
                ),
              ),
          )
        : [];
    let cachedJobs = [];
    if (this._open && owner) {
      try {
        const response = await chrome.runtime.sendMessage({
          action: "ft:getProjectHistory",
          projectId: owner.projectId,
        });
        if (
          response?.ok &&
          response.record?.data?.projectId === owner.projectId
        )
          cachedJobs = (response.record.data.sessions || []).flatMap(
            (session) =>
              (session.jobs || []).map((job) => ({
                ...job,
                projectId: job.projectId || response.record.data.projectId,
                sessionId: job.sessionId || session.id,
              })),
          );
      } catch (_) {}
    }
    if (
      owner &&
      cachedJobs.some(
        (job) => job.owner === "prompts" && job.regenDisplay?.jobId,
      )
    ) {
      this.scheduler.observeRegen({ jobs: cachedJobs }, { notify: false });
      await this.scheduler._regenReceiptSync;
      batches = await this.store.list(owner.userId, owner.projectId);
    }
    if (
      owner &&
      (await this._adoptMcpJobs(
        [...cachedJobs, ...(this.queue?.getSnapshot?.()?.jobs || [])],
        owner,
        batches,
      ))
    )
      batches = await this.store.list(owner.userId, owner.projectId);
    const currentOwner = this._scope();
    if (
      requestId !== this._reloadSeq ||
      String(currentOwner?.userId || "") !== String(owner?.userId || "") ||
      currentOwner?.projectId !== owner?.projectId
    )
      return;
    this.batches = batches.map((batch) => {
      if (batch.hiddenPromptIndexes?.length)
        batch = {
          ...batch,
          items: batch.items.map((item, index) =>
            batch.hiddenPromptIndexes.includes(index)
              ? { ...item, hidden: true }
              : item,
          ),
        };
      if (batch.status !== "queued" || batch.refMode !== "sequential")
        return batch;
      const pool = (batch.refPool || []).map((ref) => ref.refKey);
      return {
        ...batch,
        items: (batch.items || []).map((item, index) =>
          item.refOverride === true
            ? item
            : {
                ...item,
                refKeys: window.GenBatchDraftBuilder.sequentialRefs(
                  pool,
                  index,
                  batch.refImagesPerPrompt,
                ),
              },
        ),
      };
    });
    this.cachedJobs =
      window.TrackerRegenProjection?.batchJobs?.(cachedJobs) || cachedJobs;
    const used = new Set();
    for (const assets of assetGroups)
      for (const asset of assets) {
        const key = `${asset.batchId}\0${asset.refKey}`;
        used.add(key);
        if (!this._assetUrls.has(key) && asset.file instanceof Blob)
          this._assetUrls.set(key, URL.createObjectURL(asset.file));
      }
    for (const [key, url] of this._assetUrls)
      if (!used.has(key)) {
        URL.revokeObjectURL(url);
        this._assetUrls.delete(key);
      }
    this.snapshot = this.queue?.getSnapshot?.() || this.snapshot;
    if (this._open && owner && window.flow_uuid_gateway) {
      const gateway = window.flow_uuid_gateway,
        entries = [],
        originals = new Map();
      for (const batch of this.batches) {
        if ((batch.provider || "flow") !== "flow") continue;
        for (let index = 0; index < (batch.items || []).length; index++) {
          this._receiptResults(batch, index).forEach((result, resultIndex) => {
            const id = `${batch.batchId}|${index}|${resultIndex}`;
            const record = gateway.resultMetadata(result);
            originals.set(id, {
              result,
              record,
              signature: this._resultSignature(result),
            });
            entries.push({ id, record });
          });
        }
      }
      if (entries.length) {
        try {
          const prepared = await gateway.prepareMetadata(entries, {
            projectId: owner.projectId,
          });
          if (
            requestId !== this._reloadSeq ||
            this._scope()?.projectId !== owner.projectId ||
            String(this._scope()?.userId) !== String(owner.userId)
          )
            return;
          for (const [id, { result, record, signature }] of originals) {
            const metadata = prepared.records[id];
            if (
              !metadata ||
              metadata === record ||
              this._resultSignature(result) !== signature
            )
              continue;
            this._resultRepairs.set(id, {
              ...gateway.applyResultMetadata(result, metadata),
              _sourceResultKey: signature,
            });
          }
        } catch (error) {
          console.warn(
            "[GenBatch] Shared metadata preparation failed:",
            error?.code || error?.message,
          );
        }
      }
    }
    if (this._open && this._view === "flow") {
      this._listRefHydrationEpoch++;
      this._queueRefCatalogHydration();
    }
    this._scheduleRender();
  }
  _scheduleRender() {
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }
  async add() {
    if (this._busy) return;
    const selectedProvider = document.getElementById("genProvider")?.value;
    if (["muse", "chatgpt", "gemini"].includes(selectedProvider)) {
      if (
        this.addButton?.getAttribute("aria-disabled") === "true" ||
        !this.webView
      )
        return this._error("PROVIDER_BATCH_ADMISSION_UNAVAILABLE");
      this._busy = true;
      try {
        await this.webView.add(selectedProvider);
      } catch (error) {
        this._error(error);
      } finally {
        this._busy = false;
        this._toggleProvider();
      }
      return;
    }
    if (this.addButton?.getAttribute("aria-disabled") === "true") {
      try {
        const limit = window.GenBatchDraftBuilder.getQueueLimit();
        const count = this._queuedCount();
        if (limit !== -1 && count >= limit) {
          const error = new Error("BATCH_QUEUE_FULL");
          error.limit = limit;
          this._error(error);
          return;
        }
      } catch (_) {}
      this._error("BATCH_ENTITLEMENT_OR_QUEUE_UNAVAILABLE");
      return;
    }
    this._busy = true;
    this._toggleProvider();
    const originalPrompt = window.GenTab.promptsArea?.value;
    try {
      const { draft, assets, userId, projectId } =
        await window.GenBatchDraftBuilder.collect(window.GenTab);
      const beforeSave = this._scope();
      if (
        String(beforeSave?.userId || "") !== String(userId) ||
        beforeSave?.projectId !== projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      const savedBatch = await this.store.add(
        userId,
        projectId,
        draft,
        assets,
        window.GenBatchDraftBuilder.getQueueLimit(),
      );
      const afterSave = this._scope();
      const sameScope =
        String(afterSave?.userId || "") === String(userId) &&
        afterSave?.projectId === projectId;
      if (
        sameScope &&
        document.getElementById("genProvider")?.value === "flow" &&
        window.GenTab.promptsArea.value === originalPrompt
      ) {
        window.GenTab.promptsArea.value = "";
        window.GenTab.promptsArea.dispatchEvent(
          new Event("input", { bubbles: true }),
        );
      }
      await this.reload();
      if (sameScope) {
        await this.open();
        this._highlightAddedBatch(savedBatch?.batchId || draft.batchId);
        this._notify(this._t("added", "Batch saved to queue"), "success");
      } else {
        this._notify(
          this._t(
            "savedOtherScope",
            "Batch saved under the previous account and project",
          ),
          "warning",
        );
      }
    } catch (error) {
      this._error(error);
    } finally {
      this._busy = false;
      this._toggleProvider();
    }
  }
  _formatItemElapsed(startedAt, now = Date.now()) {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1e3));
    const pad = (value) => String(value).padStart(2, "0");
    return seconds >= 3600
      ? `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
      : `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
  }
  _loadingIndicator(startedAt) {
    const start = Number(startedAt) > 0 ? Number(startedAt) : Date.now();
    return `<span class="gen-batch-loading-indicator"><span class="gen-batch-loading-spinner" style="animation-delay:-${Date.now() % 600}ms" aria-hidden="true"></span><span class="gen-batch-elapsed" data-started-at="${start}">${this._formatItemElapsed(start)}</span></span>`;
  }
  _updateElapsedTimers() {
    if (!this._open) return;
    const now = Date.now();
    for (const el of this.body.querySelectorAll(
      ".gen-batch-elapsed[data-started-at]",
    )) {
      el.textContent = this._formatItemElapsed(
        Number(el.dataset.startedAt),
        now,
      );
    }
  }
  _startProgressPoll() {
    if (!this._elapsedTimer)
      this._elapsedTimer = setInterval(() => this._updateElapsedTimers(), 1e3);
    if (this._progressPollTimer) return;
    this._progressPollTimer = setInterval(() => {
      this._pollVisibleBatchProgress().catch((error) =>
        console.warn(
          "[GenBatchListModal] progress refresh failed:",
          error?.message || error,
        ),
      );
    }, 1500);
  }
  async _pollVisibleBatchProgress() {
    if (
      !this._open ||
      this._opening ||
      this._view !== "flow" ||
      this._progressPollBusy
    )
      return;
    const owner = this._scope();
    if (!owner) return;
    this._progressPollBusy = true;
    try {
      const [batches, lease] = await Promise.all([
        this.store.list(owner.userId, owner.projectId),
        this.store.getActiveLease?.(owner.userId, owner.projectId) || null,
      ]);
      if (
        !this._open ||
        this._view !== "flow" ||
        String(this._scope()?.userId) !== String(owner.userId) ||
        this._scope()?.projectId !== owner.projectId
      )
        return;
      const changed =
        batches.length !== this.batches.length ||
        batches.some(
          (batch, index) =>
            batch.batchId !== this.batches[index]?.batchId ||
            batch.revision !== this.batches[index]?.revision,
        );
      const leaseChanged =
        lease?.ownerId !== this._activeCoordinatorLease?.ownerId ||
        lease?.expiresAt !== this._activeCoordinatorLease?.expiresAt;
      this._activeCoordinatorLease = lease;
      if (changed) this.batches = batches;
      if (changed || leaseChanged) this._scheduleRender();
    } finally {
      this._progressPollBusy = false;
    }
  }
  async open(providerOverride = null) {
    const selectedProvider =
      providerOverride || document.getElementById("genProvider")?.value;
    if (["muse", "chatgpt", "gemini", "flow"].includes(selectedProvider))
      this._view = selectedProvider;
    this._returnFocus = document.activeElement;
    this._open = true;
    this._startProgressPoll();
    const openSeq = (this._openSeq = (this._openSeq || 0) + 1);
    console.info(
      "[GenBatchListModal] open",
      JSON.stringify({ instanceId: this._instanceId, view: this._view }),
    );
    this._opening = true;
    this.overlay.classList.remove("hidden");
    const loading = document.createElement("div");
    loading.className = "gen-batch-empty";
    const spinner = document.createElement("span");
    spinner.className = "gen-batch-loading-spinner";
    const label = document.createElement("p");
    label.textContent = window.I18n?.t?.("common.loading") || "Loading\u2026";
    loading.append(spinner, label);
    this.body.replaceChildren(loading);
    console.info(
      "[GenBatchListModal] open_visible",
      JSON.stringify({ instanceId: this._instanceId, view: this._view }),
    );
    try {
      await this.reload();
    } catch (error) {
      if (openSeq === this._openSeq && this._open) {
        this._opening = false;
        label.textContent = String(
          error?.message || error || "BATCH_LOAD_FAILED",
        );
        spinner.remove();
        this._error(error);
      }
      return false;
    }
    if (openSeq !== this._openSeq || !this._open) return false;
    this._opening = false;
    this._render();
    this._pollVisibleBatchProgress().catch((error) =>
      console.warn(
        "[GenBatchListModal] initial progress refresh failed:",
        error?.message || error,
      ),
    );
    this.overlay.querySelector(".gen-batch-storage-size").textContent =
      "\u2026";
    this._syncBatchStorageLabel();
    this._refreshBatchStorageUsage();
    this._refreshWebWorkerGate();
    this.body.scrollTop = this._listScrollTop || 0;
    console.info(
      "[GenBatchListModal] open_ready",
      JSON.stringify({ instanceId: this._instanceId, view: this._view }),
    );
    this._scrollToActiveBatch();
    this.overlay.querySelector(".gen-batch-modal-close")?.focus();
    this._hydrateListRefThumbs(++this._listRefHydrationEpoch).catch(() => {});
    return true;
  }
  _refreshWebWorkerGate() {
    if (!this._open || !["muse", "chatgpt", "gemini"].includes(this._view))
      return;
    Promise.resolve()
      .then(() => window.ExecutionConfig.getConfig(true))
      .then(() => {
        if (this._open) this._scheduleRender();
      })
      .catch((error) => {
        console.warn(
          "[GenBatch] Web worker gate refresh failed:",
          error?.message || error,
        );
        if (this._open) this._scheduleRender();
      });
  }
  async openProviderRun(provider, runId) {
    if (!["muse", "chatgpt", "gemini"].includes(provider) || !runId)
      return false;
    this._view = provider;
    if (this.webView) {
      this.webView.highlightBatchId = runId;
      this.webView.highlightStartedAt = 0;
    }
    try {
      await this.open(provider);
    } catch (error) {
      if (this.webView?.highlightBatchId === runId) {
        this.webView.highlightBatchId = null;
        this.webView.highlightStartedAt = 0;
      }
      throw error;
    }
    if (!this._open || this._view !== provider) {
      if (this.webView?.highlightBatchId === runId) {
        this.webView.highlightBatchId = null;
        this.webView.highlightStartedAt = 0;
      }
      return false;
    }
    this.body.scrollTop = 0;
    const card = [...this.body.querySelectorAll(".gen-batch-web-card")].find(
      (node) => node.dataset.webBatch === runId,
    );
    if (!card) {
      if (this.webView?.highlightBatchId === runId) {
        this.webView.highlightBatchId = null;
        this.webView.highlightStartedAt = 0;
      }
      return false;
    }
    if (this.webView) this.webView.highlightStartedAt = Date.now();
    card.classList.add("is-just-added");
    window.setTimeout(() => {
      if (this.webView?.highlightBatchId === runId) {
        this.webView.highlightBatchId = null;
        this.webView.highlightStartedAt = 0;
      }
      [...this.body.querySelectorAll(".gen-batch-web-card")]
        .find((node) => node.dataset.webBatch === runId)
        ?.classList.remove("is-just-added");
    }, 2500);
    return true;
  }
  close(reason = "action") {
    console.info(
      "[GenBatchListModal] close",
      JSON.stringify({
        instanceId: this._instanceId,
        view: this._view,
        reason,
      }),
    );
    if (this._runConfirmResolve) this._finishRunConfirm(false);
    if (this._downloadResolve) this._finishDownloadOptions(null);
    if (this._editor) this._closeEditor();
    if (this.webView?.editing) this.webView._closeEdit();
    this._open = false;
    if (this._elapsedTimer) clearInterval(this._elapsedTimer);
    this._elapsedTimer = null;
    if (this._progressPollTimer) clearInterval(this._progressPollTimer);
    this._progressPollTimer = null;
    this._activeCoordinatorLease = null;
    this._openSeq = (this._openSeq || 0) + 1;
    this._opening = false;
    this._videoPreviewObserver?.disconnect();
    this._videoPreviewObserver = null;
    this._lastScrolledActiveBatchId = null;
    this._listRefHydrationEpoch++;
    this.overlay.classList.add("hidden");
    this._listScrollTop = this.body.scrollTop;
    this.body.replaceChildren();
    this._cards.clear();
    this._liveJobsCache = null;
    for (const url of this._assetUrls.values()) URL.revokeObjectURL(url);
    this._assetUrls.clear();
    this._resultRepairs.clear();
    this._resultRepairing.clear();
    this._refThumbRepairs.clear();
    this._refThumbRepairing.clear();
    this._failedRefThumbUrls.clear();
    this._failedRefThumbKeys.clear();
    this.webView?.clearUrls();
    (this._returnFocus?.isConnected
      ? this._returnFocus
      : this.listButton
    )?.focus?.();
  }
  _liveJobs() {
    const projectId = this._scope()?.projectId;
    const userId = window.authManager?.getUser?.()?.id;
    const cached = this._liveJobsCache;
    if (
      cached &&
      cached.snapshot === this.snapshot &&
      cached.projectId === projectId &&
      String(cached.userId || "") === String(userId || "")
    )
      return cached.jobs;
    const raw = (this.snapshot?.jobs || []).filter(
      (job) =>
        (job.owner === "prompts" ||
          (job.owner === "mcp" &&
            job.mcpJobId &&
            String(job.mcpUserId) === String(userId))) &&
        job.projectId === projectId,
    );
    const jobs = window.TrackerRegenProjection?.batchJobs?.(raw) || raw;
    this._liveJobsCache = { snapshot: this.snapshot, projectId, userId, jobs };
    return jobs;
  }
  _runtimeItemByRoot(items, rootId) {
    if (!rootId) return null;
    return (
      items?.find(
        (entry) =>
          entry.id === rootId ||
          entry._regenSlotRoot === rootId ||
          entry.regenOf === rootId,
      ) || null
    );
  }
  _batchRuntimeRootId(batch, index) {
    return (
      batch?.runtimeItemIds?.[index] ||
      batch?.terminalItems?.[index]?.id ||
      null
    );
  }
  _cachedJobForBatch(
    batch,
    jobId = batch?.jobId,
    sessionId = batch?.trackerSessionId,
  ) {
    if (!batch?.projectId || !jobId) return null;
    const matches = this.cachedJobs.filter(
      (entry) => entry.id === jobId && entry.projectId === batch.projectId,
    );
    return (
      matches.find((entry) => entry.sessionId === sessionId) ||
      matches.at(-1) ||
      null
    );
  }
  _jobForBatchItem(batch, index) {
    const rootId = this._batchRuntimeRootId(batch, index);
    if (!rootId) return null;
    const segments = [
      { jobId: batch.jobId, trackerSessionId: batch.trackerSessionId },
      ...(batch.executionSegments || []).slice().reverse(),
    ];
    for (const segment of segments) {
      if (
        segment.runtimeItemIds?.[index] &&
        segment.runtimeItemIds[index] !== rootId
      )
        continue;
      const job =
        this._liveJobs().find(
          (entry) =>
            entry.id === segment.jobId && entry.projectId === batch.projectId,
        ) ||
        this._cachedJobForBatch(batch, segment.jobId, segment.trackerSessionId);
      if (this._runtimeItemByRoot(job?.items, rootId)) return job;
    }
    return null;
  }
  _historySegments(batch) {
    const unique = new Map();
    for (const segment of [
      ...(batch.executionSegments || []),
      { jobId: batch.jobId, trackerSessionId: batch.trackerSessionId },
    ]) {
      if (segment.jobId && segment.trackerSessionId)
        unique.set(`${segment.trackerSessionId}|${segment.jobId}`, segment);
    }
    return [...unique.values()];
  }
  _resultSignature(result) {
    return JSON.stringify([
      result?.tileId,
      result?.mediaUuid,
      result?.mediaId,
      result?.url,
      result?.thumbnail,
      result?.playUrl,
    ]);
  }
  _directRef(item, id) {
    const stored = item?.refThumbnails?.[id];
    const identity = window.MediaRegistry?.getRefIdentity?.(id);
    const thumbnail =
      typeof stored === "string"
        ? stored
        : stored?.thumbnail ||
          stored?.thumbnail_url ||
          stored?.source_thumbnail ||
          "";
    return {
      refKey: id,
      fileName:
        item?.refFileNames?.[id] ||
        stored?.file_name ||
        identity?.file_name ||
        null,
      mediaUuid:
        item?.refMediaUuids?.[id] ||
        stored?.media_uuid ||
        stored?.mediaUuid ||
        identity?.media_uuid ||
        null,
      mediaType:
        stored?.type || identity?.media_type || identity?.type || "image",
      thumbnail,
    };
  }
  _receiptResults(batch, index) {
    const receipt = batch?.terminalItems?.[index];
    if (receipt?.results?.length) return receipt.results;
    if (receipt?.resultIdentity?.length) return receipt.resultIdentity;
    return (receipt?.resultIds || []).map((tileId) => ({
      tileId,
      video:
        String(batch.settingsSnapshot?.genType || "").toLowerCase() === "video",
    }));
  }
  _onMediaCatalogUpdated(event) {
    const projectId = this._scope()?.projectId;
    if (
      !this._open ||
      !projectId ||
      String(event?.projectId || "").toLowerCase() !==
        String(projectId).toLowerCase()
    )
      return;
    this._mediaCatalogEpoch++;
    for (const [key, repair] of this._resultRepairs)
      if (
        repair.unavailable ||
        (repair.video && !repair.playUrl && (repair.poster || !repair.url))
      )
        this._resultRepairs.delete(key);
    for (const [key, url] of this._failedRefThumbKeys || [])
      this._recoverRefThumbnail({
        dataset: { refRepairKey: key },
        currentSrc: url,
        src: url,
        catalogOnly: true,
      }).catch((error) =>
        console.warn(
          "[GenBatch] Reference preview recovery failed:",
          error?.message || error,
        ),
      );
    this._queueRefCatalogHydration();
    this._scheduleRender();
  }
  _queueRefCatalogHydration() {
    if (!this._refCatalogHydrationQueued) {
      this._refCatalogHydrationQueued = true;
      Promise.resolve()
        .then(() => {
          this._refCatalogHydrationQueued = false;
          if (this._open)
            return this._hydrateListRefThumbs(this._listRefHydrationEpoch, {
              catalogOnly: true,
            });
        })
        .catch((error) =>
          console.warn(
            "[GenBatch] Reference catalog hydration failed:",
            error?.message || error,
          ),
        );
    }
  }
  async _recoverRefThumbnail(image) {
    const key = image?.dataset?.refRepairKey;
    const divider = key?.indexOf("|") ?? -1;
    if (divider < 1 || !this._open) return;
    const batchId = key.slice(0, divider),
      refKey = key.slice(divider + 1);
    const owner = this._scope();
    let batch = this.batches.find((entry) => entry.batchId === batchId);
    let ref = batch?.refPool?.find((entry) => entry.refKey === refKey);
    if (!batch && batchId.startsWith("direct:") && owner) {
      const jobId = batchId.slice("direct:".length);
      const job = [...this._liveJobs(), ...this.cachedJobs].find(
        (entry) =>
          entry.id === jobId &&
          ["prompts", "mcp"].includes(entry.owner) &&
          entry.projectId === owner.projectId &&
          (entry.owner !== "mcp" ||
            String(entry.mcpUserId || "") === String(owner.userId)) &&
          !entry.sourceBatchId,
      );
      const item = job?.items?.find((entry) =>
        (entry.refFileIds || []).includes(refKey),
      );
      if (item) {
        ref = this._directRef(item, refKey);
        batch = {
          batchId,
          projectId: job.projectId,
          userId: owner.userId,
          refPool: [ref],
        };
      }
    }
    if (
      !ref ||
      !owner ||
      batch.projectId !== owner.projectId ||
      String(batch.userId) !== String(owner.userId)
    ) {
      console.info(
        "[GenBatchRefThumbnail]",
        JSON.stringify({
          stage: "recover_skipped",
          reason: "reference_or_scope_changed",
          referenceFound: !!ref,
        }),
      );
      return;
    }
    const oldUrl = image.currentSrc || image.src || ref.thumbnail || "";
    if (!/^https?:\/\//.test(oldUrl)) return;
    if (image.style) image.style.display = "none";
    this._failedRefThumbUrls.add(oldUrl);
    if (this._failedRefThumbUrls.size > 512)
      this._failedRefThumbUrls.delete(
        this._failedRefThumbUrls.values().next().value,
      );
    this._failedRefThumbKeys.set(key, oldUrl);
    this._scheduleRender();
    if (this._refThumbRepairing.has(key)) return;
    this._refThumbRepairing.add(key);
    const gateway = window.flow_uuid_gateway;
    const record = gateway.referenceMetadata(
      {
        ...ref,
        fileId: refKey,
        type:
          String(ref.mediaType || "").toLowerCase() === "video"
            ? "video"
            : "image",
      },
      refKey,
    );
    let recovered = null,
      catalogProjectMismatch = false;
    const recoveryAudit = {
      stage: "recover",
      catalogOnly: image.catalogOnly === true,
      uuidAvailable: !!record.media_uuid,
      aliasAvailable: gateway.isAsb(record.persistent_media_id),
    };
    const catalogEpoch = this._mediaCatalogEpoch;
    try {
      const response = await gateway.recoverMetadata([{ id: refKey, record }], {
        projectId: batch.projectId,
        surface: "gen",
        catalogOnly: image.catalogOnly === true,
        rejectedUrls: [...this._failedRefThumbUrls],
        fields: ["thumbnail"],
        allowLocal: false,
        abortFn: () =>
          !this._open ||
          this._scope()?.projectId !== batch.projectId ||
          String(this._scope()?.userId) !== String(batch.userId),
      });
      const info = response.records[refKey];
      if (
        gateway.usableUrl(info?.thumbnail, {
          rejectedUrls: [...this._failedRefThumbUrls],
          allowLocal: false,
        })
      )
        recovered = info.thumbnail;
      recoveryAudit.stages = [
        ...new Set(response.stages.map((item) => item.stage)),
      ];
      if (
        recovered &&
        !this._failedRefThumbUrls.has(recovered) &&
        this._failedRefThumbKeys.get(key) === oldUrl &&
        this._open &&
        this._scope()?.projectId === batch.projectId &&
        String(this._scope()?.userId) === String(batch.userId) &&
        (batchId.startsWith("direct:")
          ? [...this._liveJobs(), ...this.cachedJobs].some(
              (entry) =>
                `direct:${entry.id}` === batchId &&
                entry.projectId === batch.projectId &&
                !entry.sourceBatchId,
            )
          : this.batches.some((entry) => entry.batchId === batchId))
      ) {
        this._refThumbRepairs.set(key, {
          url: recovered,
          identity: JSON.stringify([
            ref.refKey,
            ref.mediaUuid,
            ref.fileName,
            ref.thumbnail,
          ]),
        });
        this._failedRefThumbKeys.delete(key);
        for (const preview of this.overlay?.querySelectorAll?.(
          "img[data-ref-repair-key]",
        ) || []) {
          if (preview.dataset.refRepairKey !== key) continue;
          preview.style.display = "";
          if (preview.src !== recovered) preview.src = recovered;
        }
        this._scheduleRender();
        if (this._editor?.kind === "batch" && this._editor.batchId === batchId)
          this._refreshBatchPreview();
      }
    } catch (error) {
      catalogProjectMismatch = [
        "PROJECT_MISMATCH",
        "FLOW_EXECUTION_TARGET_CHANGED",
      ].includes(error?.code);
      console.warn("[GenBatchRefThumbnail] shared recovery unavailable", {
        code: error?.code || "METADATA_READ_FAILED",
      });
    } finally {
      console.info(
        "[GenBatchRefThumbnail]",
        JSON.stringify({
          ...recoveryAudit,
          catalogProjectMismatch,
          recovered: !!recovered,
          applied:
            this._refThumbRepairs.get(key)?.url === recovered && !!recovered,
        }),
      );
      this._refThumbRepairing.delete(key);
      if (
        this._editor?.kind === "batch" &&
        this._editor.batchId === batchId &&
        this._scope()?.projectId === batch.projectId &&
        String(this._scope()?.userId) === String(batch.userId)
      )
        this._renderBatchRefCards(
          batch,
          this._editor.pickerRefs || batch.refPool || [],
        );
      if (
        catalogEpoch !== this._mediaCatalogEpoch &&
        this._failedRefThumbKeys.has(key)
      )
        queueMicrotask(() =>
          this._recoverRefThumbnail({
            dataset: { refRepairKey: key },
            currentSrc: this._failedRefThumbKeys.get(key),
            src: this._failedRefThumbKeys.get(key),
            catalogOnly: true,
          }).catch((error) =>
            console.warn(
              "[GenBatch] Reference preview recovery failed:",
              error?.message || error,
            ),
          ),
        );
    }
  }
  async _recoverResultThumbnail(image) {
    const key = image.dataset.repairKey;
    if (!key || this._resultRepairing.has(key) || !this._open) return;
    const [batchId, indexText, resultText] = key.split("|");
    const batch = this.batches.find((entry) => entry.batchId === batchId);
    const index = Number(indexText),
      resultIndex = Number(resultText);
    if (!batch || !Number.isInteger(index) || !Number.isInteger(resultIndex))
      return;
    const job = this._jobForBatchItem(batch, index);
    const rootId = batch.runtimeItemIds?.[index];
    const item = this._runtimeItemByRoot(job?.items, rootId);
    const result =
      item?.results?.[resultIndex] ||
      this._receiptResults(batch, index)[resultIndex];
    if (!result) return;
    this._resultRepairing.add(key);
    const catalogEpoch = this._mediaCatalogEpoch;
    const currentUrl = image.currentSrc || image.src;
    const gateway = window.flow_uuid_gateway;
    const uuid = gateway.identity(result, result.tileId || result.mediaId);
    const identities = [...gateway.aliases(result, result.tileId)];
    const signature = this._resultSignature(result),
      ownerUser = this._scope()?.userId;
    let recovered = null,
      catalogDiagnostic = { outcome: "unresolved" },
      recoverySource = "none";
    try {
      const record = gateway.resultMetadata(result),
        id = uuid || result.mediaId || result.tileId;
      const response = await gateway.recoverMetadata(
        [
          {
            id,
            record,
            fields: result.video ? ["video_url"] : ["thumbnail"],
            rejectedUrls: [currentUrl].filter(Boolean),
          },
        ],
        {
          projectId: batch.projectId,
          surface: "gen",
          allowLocal: false,
          abortFn: () =>
            !this._open ||
            this._scope()?.projectId !== batch.projectId ||
            this._scope()?.userId !== ownerUser ||
            this._resultSignature(result) !== signature,
        },
      );
      const info = response.records[id];
      if (
        !response.unresolved.includes(id) ||
        (result.video &&
          gateway.usableUrl(info?.thumbnail, {
            allowLocal: false,
            rejectedUrls: [currentUrl],
          }))
      ) {
        const metadata = result.video
          ? gateway.videoPresentation(record, info, {
              rejectedUrls: [currentUrl],
            }) || info
          : info;
        if (metadata)
          recovered = gateway.applyResultMetadata(result, metadata, {
            rejectedUrls: [currentUrl],
          });
      }
      catalogDiagnostic = {
        outcome: recovered ? "verified_match" : "unresolved",
      };
      recoverySource =
        response.stages.filter((item2) => item2.id === id).at(-1)?.stage ||
        "none";
      if (result.video)
        console.info(
          "[GenBatchVideoRecovery]",
          JSON.stringify({
            batchId,
            promptIndex: index,
            resultIndex,
            receiptUuid: !!uuid,
            receiptAsb: identities.some(
              (value) =>
                /^[A-Za-z0-9_-]{32,1024}$/.test(value) &&
                !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value),
            ),
            hadPoster: result.poster === true && !!result.thumbnail,
            hadPlayback: !!result.playUrl,
            catalog: catalogDiagnostic,
            recoverySource,
            recoveredPoster: !!recovered?.thumbnail,
            recoveredPlayback: !!recovered?.playUrl,
          }),
        );
      if (
        this._open &&
        this._resultSignature(result) === signature &&
        this._scope()?.userId === ownerUser &&
        this._scope()?.projectId === batch.projectId &&
        this.batches.some((entry) => entry.batchId === batchId)
      ) {
        if (recovered || catalogEpoch === this._mediaCatalogEpoch)
          this._resultRepairs.set(key, {
            ...(recovered || { ...result, unavailable: true }),
            _sourceResultKey: signature,
          });
        if (this._editor?.kind === "batch" && this._editor.batchId === batchId)
          this._refreshBatchPreview();
        this._scheduleRender();
      }
    } catch (error) {
      if (
        error?.name !== "AbortError" &&
        this._open &&
        catalogEpoch === this._mediaCatalogEpoch &&
        this._resultSignature(result) === signature &&
        this._scope()?.userId === ownerUser &&
        this._scope()?.projectId === batch.projectId
      ) {
        this._resultRepairs.set(key, {
          ...result,
          unavailable: true,
          _sourceResultKey: signature,
        });
        this._scheduleRender();
      }
    } finally {
      this._resultRepairing.delete(key);
      if (catalogEpoch !== this._mediaCatalogEpoch && !recovered)
        this._scheduleRender();
    }
  }
  _badgeCount(jobs) {
    const terminal = new Set([
      "COMPLETED",
      "PARTIAL_FAIL",
      "FAILED",
      "CANCELLED",
      "BLOCKED",
    ]);
    const liveBatchIds = new Set(
      jobs.map((job) => job.sourceBatchId).filter(Boolean),
    );
    const queued = this.batches
      .filter(
        (batch) =>
          !batch.hiddenFromBatchList &&
          (batch.status === "queued" ||
            (["needs_review", "admitting", "running", "paused"].includes(
              batch.status,
            ) &&
              !liveBatchIds.has(batch.batchId))),
      )
      .reduce((sum, batch) => {
        const cache = this._cachedJobForBatch(batch);
        return (
          sum +
          batch.items.filter(
            (item, index) =>
              !item.hidden &&
              !batch.hiddenPromptIndexes?.includes(index) &&
              batch.terminalItems?.[index]?.state !== "COMPLETED" &&
              this._runtimeItemByRoot(
                cache?.items,
                batch.runtimeItemIds?.[index],
              )?.state !== "COMPLETED",
          ).length
        );
      }, 0);
    const live = jobs
      .filter(
        (job) =>
          !["completed", "stopped", "failed"].includes(job.status) &&
          !this.batches.some(
            (batch) =>
              batch.hiddenFromBatchList &&
              (batch.jobId === job.id || batch.batchId === job.sourceBatchId),
          ),
      )
      .reduce(
        (sum, job) =>
          sum +
          (job.items || []).filter((item) => !terminal.has(item.state)).length,
        0,
      );
    return queued + live;
  }
  _render() {
    this._toggleProvider();
    this._syncItemLayout();
    this._syncBatchStorageLabel();
    for (const tab of this.overlay.querySelectorAll(
      ".gen-batch-provider-tabs button",
    )) {
      tab.setAttribute("aria-pressed", String(tab.dataset.view === this._view));
      if (tab.dataset.view !== "all") {
        const source = document.querySelector(
          `#genProviderTabs .provider-tab[data-provider="${tab.dataset.view}"] .provider-tab-icon`,
        );
        const icon = tab.querySelector(".gen-batch-provider-icon");
        if (source && icon && icon.dataset.sourceHtml !== source.outerHTML) {
          icon.replaceChildren(source.cloneNode(true));
          icon.dataset.sourceHtml = source.outerHTML;
        }
      }
      tab.hidden = false;
    }
    if (
      this._open &&
      ["muse", "chatgpt", "gemini"].includes(this._view) &&
      this.webView
    ) {
      const sidebarTitle2 = document.querySelector(
        ".tobyflow-header .tobyflow-header-title",
      );
      const appName2 =
        sidebarTitle2?.textContent ||
        window.SystemConfig?.get?.("app_name") ||
        "Toby Flow";
      this.overlay.querySelector("#genBatchTitle").textContent = appName2;
      const sidebarLogo2 = document.querySelector(".tobyflow-header-logo img");
      const batchLogo2 = this.overlay.querySelector(
        ".gen-batch-modal-brand > img",
      );
      if (sidebarLogo2?.src && batchLogo2.src !== sidebarLogo2.src)
        batchLogo2.src = sidebarLogo2.src;
      batchLogo2.alt = appName2;
      const closeLabel2 = this._t("close");
      for (const control of this.overlay.querySelectorAll(
        ".gen-batch-modal-close, .confirm-run-close, .gen-batch-editor-close, .gen-batch-editor-back, .gen-batch-download-close",
      )) {
        control.setAttribute("aria-label", closeLabel2);
        if (control.hasAttribute("data-tooltip"))
          control.dataset.tooltip = closeLabel2;
      }
      const modeBadge2 = this.overlay.querySelector(".gen-batch-header-mode");
      const gate = this.webView._workerGate();
      if (gate.apiMode) {
        let limits = null;
        try {
          limits = {
            video: window.ExecutionConfig.getQueueVideoMaxMonitor(),
            image: window.ExecutionConfig.getQueueMaxMonitor(),
          };
        } catch (_) {
          if (!this._headerQueueConfigRefresh) {
            this._headerQueueConfigRefresh = Promise.resolve()
              .then(() => window.ExecutionConfig.getConfig())
              .then(() => {
                if (this._open) this._scheduleRender();
              })
              .catch((error) =>
                console.warn(
                  "[GenBatch] API header config unavailable:",
                  error?.code || error?.name,
                ),
              )
              .finally(() => {
                this._headerQueueConfigRefresh = null;
              });
          }
        }
        this._setHeaderMode(modeBadge2, "API", gate.enabled ? "on" : "off");
        modeBadge2.dataset.tooltip =
          gate.reason ||
          (limits
            ? window.I18n?.t?.("museApi.monitorLimit", {
                count: limits.video,
                imageCount: limits.image,
              })
            : "") ||
          "";
        modeBadge2.dataset.mode = "api";
        this._setModeSettingsAccess(modeBadge2, true);
      } else {
        let cap = 1;
        try {
          cap =
            window.ExecutionConfig.getProviderWebWorkers().maxConcurrentWorkers;
        } catch (_) {}
        this._setHeaderMode(
          modeBadge2,
          this._view.toUpperCase(),
          gate.enabled ? "on" : "off",
        );
        modeBadge2.dataset.tooltip =
          gate.reason ||
          `${window.ProviderWebScheduler?._busyWorkers || 0}/${cap} active workers \xB7 shared across providers`;
        modeBadge2.dataset.mode = "web";
        this._setModeSettingsAccess(modeBadge2, false);
      }
      const clearAll = this.overlay.querySelector('[data-action="clear-all"]');
      clearAll.hidden = false;
      clearAll.disabled = !this.webView.batches.length || this._busy;
      clearAll.dataset.tooltip = this._t("clearAll");
      this.webView.render();
      return;
    }
    this.overlay.querySelector('[data-action="clear-all"]').hidden = false;
    const jobs = this._liveJobs();
    const count = this._badgeCount(jobs);
    if (this.badge) {
      this.badge.textContent = count > 99 ? "99+" : String(count);
      this.badge.classList.toggle("hidden", count === 0);
    }
    if (!this._open) return;
    const mode = this._currentHeaderMode();
    const modeBadge = this.overlay.querySelector(".gen-batch-header-mode");
    modeBadge.dataset.mode = mode;
    this._setHeaderMode(modeBadge, mode === "api" ? "API" : "WEB", "on");
    this._setModeSettingsAccess(modeBadge, true);
    const sidebarTitle = document.querySelector(
      ".tobyflow-header .tobyflow-header-title",
    );
    const appName =
      sidebarTitle?.textContent ||
      window.SystemConfig?.get?.("app_name") ||
      "Toby Flow";
    this.overlay.querySelector("#genBatchTitle").textContent = appName;
    const sidebarLogo = document.querySelector(".tobyflow-header-logo img");
    const batchLogo = this.overlay.querySelector(
      ".gen-batch-modal-brand > img",
    );
    if (sidebarLogo?.src && batchLogo.src !== sidebarLogo.src)
      batchLogo.src = sidebarLogo.src;
    batchLogo.alt = appName;
    const closeLabel = this._t("close");
    for (const control of this.overlay.querySelectorAll(
      ".gen-batch-modal-close, .confirm-run-close, .gen-batch-editor-close, .gen-batch-editor-back, .gen-batch-download-close",
    )) {
      control.setAttribute("aria-label", closeLabel);
      if (control.hasAttribute("data-tooltip"))
        control.dataset.tooltip = closeLabel;
    }
    this.overlay
      .querySelector(".gen-batch-editor")
      .setAttribute("aria-label", this._t("editPrompt"));
    const usedJobs = new Set();
    const cards = [];
    for (const batch of this.batches) {
      if (batch.hiddenFromBatchList) continue;
      const job =
        (batch.status !== "queued" &&
          jobs.find((entry) => entry.id === batch.jobId)) ||
        jobs.find(
          (entry) =>
            entry.sourceBatchId === batch.batchId &&
            !["completed", "stopped", "failed"].includes(entry.status),
        );
      if (job) usedJobs.add(job.id);
      const cachedJob = !job && batch.jobId && this._cachedJobForBatch(batch);
      cards.push({ key: batch.batchId, batch, job, cachedJob });
    }
    const knownBatchJobs = new Set(
      this.batches.flatMap((batch) =>
        [
          batch.jobId,
          typeof batch.batchId === "string" &&
          batch.batchId.startsWith("history:")
            ? batch.batchId.slice(batch.batchId.lastIndexOf(":") + 1)
            : null,
          ...(batch.executionSegments || []).map((segment) => segment.jobId),
        ].filter(Boolean),
      ),
    );
    const directJobs = new Map();
    for (const cachedJob of this.cachedJobs)
      if (
        (cachedJob.owner === "prompts" ||
          (cachedJob.owner === "mcp" &&
            cachedJob.mcpJobId &&
            String(cachedJob.mcpUserId) === String(this._scope()?.userId))) &&
        cachedJob.projectId === this._scope()?.projectId &&
        cachedJob.sourceBatchId === null &&
        !cachedJob.regenDisplay?.jobId &&
        !knownBatchJobs.has(cachedJob.id)
      ) {
        directJobs.set(cachedJob.id, {
          key: `direct:${cachedJob.id}`,
          batch: null,
          cachedJob,
        });
      }
    for (const job of jobs)
      if (
        !usedJobs.has(job.id) &&
        !job.sourceBatchId &&
        !job.regenDisplay?.jobId &&
        !knownBatchJobs.has(job.id)
      ) {
        directJobs.set(job.id, { key: `direct:${job.id}`, batch: null, job });
      }
    cards.push(...directJobs.values());
    const cardTime = (card) => {
      const readOnlyImport =
        card.batch?.batchId?.startsWith("history:") &&
        card.batch.revision === 1;
      const value =
        (readOnlyImport ? card.batch.createdAt : null) ??
        card.batch?.updatedAt ??
        card.batch?.completedAt ??
        card.batch?.createdAt ??
        card.job?.startedAt ??
        card.cachedJob?.startedAt ??
        card.batch?.order;
      const time = Number(value);
      if (value != null && Number.isFinite(time)) return time;
      const parsed = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
    };
    cards.sort((left, right) => {
      const activeId = this.scheduler?.activeBatchId;
      const active = (card) =>
        !!(
          card.batch &&
          (card.batch.batchId === activeId ||
            (["admitting", "running", "paused"].includes(card.batch.status) &&
              this._activeCoordinatorLease))
        );
      const leftActive = active(left),
        rightActive = active(right);
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      return (
        cardTime(right) - cardTime(left) ||
        String(right.key).localeCompare(String(left.key))
      );
    });
    const summaryKey = cards.length === 1 ? "summaryOne" : "summary";
    const summary = this._t(summaryKey, "", {
      batches: cards.length,
      prompts: count,
    });
    const summaryText =
      summary === `genBatch.${summaryKey}`
        ? this._t(
            "summary",
            `${cards.length} batches \xB7 ${count} unfinished prompts`,
            { batches: cards.length, prompts: count },
          )
        : summary;
    let queueText = "";
    try {
      const limit = window.GenBatchDraftBuilder.getQueueLimit();
      const queued = this._queuedCount();
      queueText = this._t("queueCount", "", {
        count: queued,
        limit: limit === -1 ? "\u221E" : limit,
      });
    } catch (_) {}
    const countText = queueText
      ? `${summaryText} \xB7 ${queueText}`
      : summaryText;
    const countEl = this.overlay.querySelector(".gen-batch-count");
    const unlimitedAt = queueText.includes("\u221E")
      ? countText.lastIndexOf("\u221E")
      : -1;
    if (unlimitedAt >= 0) {
      countEl.textContent = countText.slice(0, unlimitedAt);
      const unlimited = document.createElement("span");
      unlimited.className = "gen-batch-count-unlimited";
      unlimited.textContent = "\u221E";
      countEl.append(unlimited, countText.slice(unlimitedAt + 1));
    } else {
      countEl.textContent = countText;
    }
    const keys = new Set(cards.map((card) => card.key));
    for (const [key, element] of this._cards)
      if (!keys.has(key)) {
        element
          .querySelectorAll("video[data-preview-src]")
          .forEach((video) => this._videoPreviewObserver?.unobserve(video));
        element.remove();
        this._cards.delete(key);
      }
    if (cards.length) this.body.querySelector(".gen-batch-empty")?.remove();
    let insertionPoint = this.body.firstElementChild;
    for (const card of cards) {
      let element = this._cards.get(card.key);
      if (!element) {
        element = document.createElement("article");
        element.className = "gen-batch-card";
        element.dataset.cardKey = card.key;
        element.innerHTML =
          '<div class="gen-batch-card-header"></div><div class="gen-batch-card-items"></div>';
        this._cards.set(card.key, element);
      }
      if (element !== insertionPoint)
        this.body.insertBefore(element, insertionPoint);
      insertionPoint = element.nextElementSibling;
      this._renderCard(element, card);
    }
    if (!cards.length)
      this.body.innerHTML = this._emptyState("flow", this._t("empty"));
    else
      for (const node of [...this.body.childNodes])
        if (node.nodeType === 3) node.remove();
    this._renderControls();
    this._syncDownloadUi();
    this._scrollToActiveBatch();
  }
  _scrollToActiveBatch() {
    if (
      !this._open ||
      this._opening ||
      this.overlay.classList.contains("hidden")
    )
      return;
    const batchId =
      this.scheduler.activeBatchId ||
      this.batches.find(
        (batch) =>
          ["admitting", "running", "paused"].includes(batch.status) &&
          this._activeCoordinatorLease,
      )?.batchId;
    if (!batchId) {
      this._lastScrolledActiveBatchId = null;
      return;
    }
    if (batchId === this._lastScrolledActiveBatchId) return;
    const card = this._cards.get(batchId);
    if (!card?.isConnected) return;
    const top =
      this.body.scrollTop +
      card.getBoundingClientRect().top -
      this.body.getBoundingClientRect().top;
    this.body.scrollTop = Math.max(0, top);
    this._lastScrolledActiveBatchId = batchId;
  }
  _highlightAddedBatch(batchId) {
    if (!this._open) return;
    this.body.scrollTop = 0;
    const card = batchId && this._cards.get(batchId);
    if (!card?.isConnected) return;
    card.classList.add("is-just-added");
    window.setTimeout(() => card.classList.remove("is-just-added"), 2500);
  }
  _displayItems(batch, displayJob, job) {
    return batch
      ? batch.items.map((item, index) => {
          const receipt = batch.terminalItems?.[index];
          const rootId = this._batchRuntimeRootId(batch, index);
          const runtime =
            this._runtimeItemByRoot(displayJob?.items, rootId) ||
            this._runtimeItemByRoot(
              this._jobForBatchItem(batch, index)?.items,
              rootId,
            ) ||
            (!rootId && displayJob?.sourceBatchId === batch.batchId
              ? displayJob?.items?.find(
                  (entry) =>
                    entry.promptIndex === index &&
                    entry.prompt === item.prompt &&
                    !entry.regenOf &&
                    !entry._regenSlotRoot,
                )
              : null);
          const durableResults = this._receiptResults(batch, index);
          const hasRuntimeResults = !!runtime?.results?.length;
          return runtime
            ? {
                ...receipt,
                ...item,
                ...runtime,
                prompt: item.prompt,
                state: (!job && receipt?.state) || runtime.state,
                error: runtime.error || receipt?.error || item.error,
                errorDisplay:
                  runtime.errorDisplay ||
                  receipt?.errorDisplay ||
                  item.errorDisplay,
                genMode: hasRuntimeResults ? runtime.genMode : receipt?.genMode,
                results: hasRuntimeResults ? runtime.results : durableResults,
              }
            : {
                ...receipt,
                ...item,
                state:
                  receipt?.state ||
                  (["queued", "admitting", "running", "paused"].includes(
                    batch.status,
                  )
                    ? "PENDING"
                    : item.state),
                error: receipt?.error || item.error,
                errorDisplay: receipt?.errorDisplay || item.errorDisplay,
                results: durableResults,
              };
        })
      : displayJob?.items || [];
  }
  _observeVideoPreviews(root) {
    const videos = root.querySelectorAll(
      ".gen-batch-result video[data-preview-src], .gen-batch-editor-result video[data-preview-src]",
    );
    if (!videos.length) return;
    const load = (video) => {
      const src = video.dataset.previewSrc;
      if (!src || !video.isConnected || !this._open) return;
      video.removeAttribute("data-preview-src");
      video.src = src;
    };
    if (!window.IntersectionObserver) {
      videos.forEach(load);
      return;
    }
    if (!this._videoPreviewObserver)
      this._videoPreviewObserver = new window.IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            this._videoPreviewObserver?.unobserve(entry.target);
            load(entry.target);
          }
        },
        { rootMargin: "100px" },
      );
    videos.forEach((video) => this._videoPreviewObserver.observe(video));
  }
  _renderCard(element, { batch, job, cachedJob }) {
    const key = element.dataset.cardKey;
    let limitExceeded = false;
    if (batch?.status === "queued") {
      try {
        limitExceeded =
          window.GenBatchDraftBuilder.checkLimit(batch.items.length).allowed !==
          true;
      } catch (_) {}
    }
    const runtimeMissing =
      !job &&
      ["admitting", "running", "paused"].includes(batch?.status) &&
      this.scheduler?.activeBatchId !== batch?.batchId &&
      !this._activeCoordinatorLease;
    let status =
      job?.status ||
      (batch
        ? limitExceeded || runtimeMissing
          ? "needs_review"
          : batch.status
        : ["running", "paused"].includes(cachedJob?.status)
          ? "needs_review"
          : cachedJob?.status) ||
      "queued";
    element.classList.toggle(
      "is-processing",
      ["admitting", "running"].includes(status),
    );
    const displayJob = job || cachedJob;
    const mcpReadOnly = !batch && displayJob?.owner === "mcp";
    const items = this._displayItems(batch, displayJob, job);
    const visible = items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ index }) =>
          !batch?.items?.[index]?.hidden &&
          !batch?.hiddenPromptIndexes?.includes(index),
      );
    const done = visible.filter(({ item }) =>
      ["COMPLETED", "PARTIAL_FAIL", "completed"].includes(
        item.state || item.status,
      ),
    ).length;
    if (
      ["running", "admitting", "needs_review"].includes(status) &&
      visible.length &&
      visible.every(({ item }) =>
        [
          "COMPLETED",
          "PARTIAL_FAIL",
          "FAILED",
          "CANCELLED",
          "BLOCKED",
          "NEEDS_REVIEW",
          "SUCCESS",
        ].includes(String(item.state || item.status).toUpperCase()),
      )
    ) {
      status = visible.some(
        ({ item }) =>
          String(item.state || item.status).toUpperCase() === "NEEDS_REVIEW",
      )
        ? "needs_review"
        : visible.every(({ item }) =>
              ["COMPLETED", "SUCCESS"].includes(
                String(item.state || item.status).toUpperCase(),
              ),
            )
          ? "completed"
          : done
            ? "partial_fail"
            : visible.every(
                  ({ item }) =>
                    String(item.state || item.status).toUpperCase() ===
                    "CANCELLED",
                )
              ? "stopped"
              : "failed";
      element.classList.remove("is-processing");
    }
    const title =
      batch?.displayName ||
      (mcpReadOnly
        ? `MCP \xB7 ${displayJob.mcpBatchName || displayJob.label || displayJob.mcpJobId}`
        : displayJob?.label || this._t("direct", "Run now"));
    const head = element.querySelector(".gen-batch-card-header");
    const rename = head.querySelector("input.gen-batch-rename");
    if (!head.querySelector(".gen-batch-name") && !rename) {
      head.innerHTML = `<span class="gen-batch-name" data-action="rename" tabindex="${batch ? 0 : -1}">${this._escape(title)}</span>
        <span class="gen-batch-status" data-state="${this._escape(status)}"><span class="gen-batch-status-dot" aria-hidden="true"></span><span class="gen-batch-status-text">${this._escape(this._statusLabel(status))} \xB7 ${done}/${visible.length}</span></span>
        <div class="gen-batch-card-actions"></div>`;
    } else {
      head.querySelector(".gen-batch-status-text").textContent =
        `${this._statusLabel(status)} \xB7 ${done}/${visible.length}`;
      head.querySelector(".gen-batch-status").dataset.state = status;
      if (!rename) head.querySelector(".gen-batch-name").textContent = title;
    }
    head.querySelector(".gen-batch-status").dataset.tooltip = runtimeMissing
      ? this._t(
          "runtimeMissing",
          "Runtime receipt is unavailable. Check Flow before taking further action.",
        )
      : limitExceeded
        ? this._t(
            "limitExceeded",
            "This batch exceeds the current plan limit",
            {
              count: batch.items.length,
              limit: window.featureGate?.getPromptBatchLimit?.() ?? "?",
            },
          )
        : batch?.admissionError || this._statusLabel(status);
    const actions = head.querySelector(".gen-batch-card-actions");
    const live =
      job && !["completed", "stopped", "failed"].includes(job.status);
    const manualJob =
      job?.manualRegenActive && job.manualRegenJobId
        ? this.queue.getJob?.(job.manualRegenJobId)
        : null;
    const manualActions =
      manualJob && !["completed", "stopped", "failed"].includes(manualJob.state)
        ? `<button type="button" data-action="${manualJob.state === "paused" ? "manual-resume" : "manual-pause"}">${this._escape(this._t("manualAttempt", "Regen"))} \xB7 ${this._escape(manualJob.state === "paused" ? this._t("resume", "Resume") : this._t("pause", "Pause"))}</button>
         <button type="button" data-action="manual-stop">${this._escape(this._t("manualAttempt", "Regen"))} \xB7 ${this._escape(this._t("stop", "Stop"))}</button>`
        : "";
    const schedulerActive = ["running", "paused"].includes(
      this.scheduler.state,
    );
    const alreadyNext =
      this.batches.find((entry) => entry.status === "queued")?.batchId ===
      batch?.batchId;
    const canRecover =
      !!batch?.jobId &&
      !live &&
      ["admitting", "running", "paused", "needs_review", "stopped"].includes(
        batch.status,
      ) &&
      !batch.settingsSnapshot?.chain &&
      visible.some(({ item }) => item.state !== "COMPLETED");
    const canReconcile =
      !!batch?.jobId &&
      !live &&
      ["admitting", "running", "paused", "needs_review"].includes(
        batch.status,
      ) &&
      visible.length > 0 &&
      visible.every(({ item }) => item.state === "COMPLETED");
    const downloadBatch = batch || this._directDownloadBatch(displayJob);
    const downloadAction =
      downloadBatch && this._downloadResults(downloadBatch).length
        ? `<button type="button" data-action="download-batch">${this._escape(this._t("download"))}</button>`
        : "";
    const referenceResults = batch
      ? this._batchResultReferences(batch)
      : this._directResultReferences(displayJob);
    const addResultsAction =
      batch ||
      (displayJob &&
        (!mcpReadOnly || ["completed", "failed", "stopped"].includes(status)))
        ? `<button type="button" data-action="add-results-to-references" ${referenceResults.length ? "" : "disabled"}>${this._escape(this._t("addResultsToReferences"))}</button>`
        : "";
    const actionHtml =
      batch?.status === "needs_review" && batch.jobId
        ? `${canRecover ? `<button type="button" data-action="recover-batch">${this._escape(this._t("resumeUnfinished", "Resume unfinished prompts"))}</button>` : canReconcile ? `<button type="button" data-action="reconcile-batch">${this._escape(this._t("markComplete", "Mark complete"))}</button>` : ""}`
        : batch?.status === "needs_review"
          ? `<button type="button" data-action="retry">${this._escape(this._t("retry", "Retry"))}</button>`
          : batch?.status === "queued"
            ? `${!schedulerActive || !alreadyNext ? `<button type="button" data-action="next">${this._escape(this._t("next", "Run next"))}</button>` : ""}
         `
            : live
              ? `<button type="button" data-action="${job.status === "paused" ? "job-resume" : "job-pause"}">${this._escape(job.status === "paused" ? this._t("resume", "Resume") : this._t("pause", "Pause"))}</button>
         <button type="button" data-action="job-stop">${this._escape(this._t("stop", "Stop"))}</button>${manualActions}`
              : canRecover && batch.status !== "stopped"
                ? `<button type="button" data-action="recover-batch">${this._escape(this._t("resumeUnfinished", "Resume unfinished prompts"))}</button>`
                : canReconcile
                  ? `<button type="button" data-action="reconcile-batch">${this._escape(this._t("markComplete", "Mark complete"))}</button>`
                  : batch &&
                      !["admitting", "running", "paused"].includes(batch.status)
                    ? `${canRecover ? `<button type="button" data-action="recover-batch">${this._escape(this._t("resumeUnfinished", "Resume unfinished prompts"))}</button>` : ""}
         ${batch.jobId && batch.trackerSessionId && visible.length ? `<button type="button" data-action="regen-batch">${this._escape(this._t("regenBatch"))}</button>` : ""}`
                    : "";
    const primaryActions =
      batch?.status === "queued"
        ? `<button type="button" class="gen-batch-icon-action gen-batch-run-action" data-action="run-batch" data-tooltip="${this._escape(this._t("runBatch"))}" aria-label="${this._escape(this._t("runBatch"))}" ${this._busy || ["running", "paused"].includes(this.scheduler.state) ? "disabled" : ""}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg></button>`
        : live
          ? `<button type="button" class="gen-batch-icon-action gen-batch-runtime-action" data-action="${job.status === "paused" ? "job-resume" : "job-pause"}" data-tooltip="${this._escape(this._t(job.status === "paused" ? "resume" : "pause"))}" aria-label="${this._escape(this._t(job.status === "paused" ? "resume" : "pause"))}">${job.status === "paused" ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>' : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>'}</button>
        <button type="button" class="gen-batch-icon-action gen-batch-runtime-action" data-action="job-stop" data-tooltip="${this._escape(this._t("stop"))}" aria-label="${this._escape(this._t("stop"))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>`
          : canRecover && batch.status !== "stopped"
            ? `<button type="button" class="gen-batch-icon-action gen-batch-run-action" data-action="recover-batch" data-tooltip="${this._escape(this._t("resumeUnfinished", "Resume unfinished prompts"))}" aria-label="${this._escape(this._t("resumeUnfinished", "Resume unfinished prompts"))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg></button>`
            : batch && ["completed", "failed", "stopped"].includes(batch.status)
              ? `${this._downloadResults(batch).length ? `<button type="button" class="gen-batch-icon-action gen-batch-download-action" data-action="download-batch" data-tooltip="${this._escape(this._t("download"))}" aria-label="${this._escape(this._t("download"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg></button>` : ""}
          `
              : "";
    const deleteAction = batch
      ? `<button type="button" data-action="delete">${this._escape(this._t("delete", "Delete"))}</button>`
      : "";
    const directTerminal =
      !batch &&
      displayJob &&
      ["completed", "failed", "stopped"].includes(status);
    const directCanResume =
      directTerminal &&
      !displayJob.chain &&
      (displayJob.items || []).some(
        (item) =>
          !["COMPLETED", "completed"].includes(item.state || item.status),
      );
    const directActions =
      !batch && displayJob?.sessionId
        ? `${directCanResume ? `<button type="button" data-action="recover-direct">${this._escape(this._t("resumeUnfinished", "Resume unfinished prompts"))}</button>` : ""}
         ${(displayJob.items || []).length ? `<button type="button" data-action="regen-direct">${this._escape(this._t("regenBatch"))}</button>` : ""}
         <button type="button" data-action="edit-direct-batch">${this._escape(this._t("editBatch", "Edit batch"))}</button>`
        : "";
    const directDeleteAction =
      !batch && displayJob
        ? `<button type="button" data-action="delete-direct" ${displayJob.sessionId ? "" : "disabled"}>${this._escape(this._t("delete", "Delete"))}</button>`
        : "";
    const canEditBatch = !!batch;
    const editAction = canEditBatch
      ? `<button type="button" data-action="edit-batch">${this._escape(this._t("editBatch", "Edit batch"))}</button>`
      : "";
    let menuActions =
      (live ? manualActions : actionHtml) +
      addResultsAction +
      downloadAction +
      editAction +
      deleteAction +
      directActions +
      directDeleteAction;
    if (batch && !menuActions.includes('data-action="regen-batch"'))
      menuActions += `<button type="button" data-action="regen-batch">${this._escape(this._t("regenBatch"))}</button>`;
    const mcpMenuActions = mcpReadOnly
      ? addResultsAction + downloadAction + directDeleteAction
      : "";
    const shownMenuActions = mcpReadOnly
      ? mcpMenuActions +
        `<button type="button" data-action="edit-direct-batch">${this._escape(this._t("editBatch", "Edit batch"))}</button><button type="button" data-action="regen-direct">${this._escape(this._t("regenBatch"))}</button>`
      : menuActions;
    const cardActions = `${mcpReadOnly ? "" : primaryActions}${shownMenuActions ? `<button type="button" class="gen-batch-menu-trigger" data-action="batch-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this._escape(this._t("moreActions"))}"><svg width="14" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg></button><div class="gen-batch-action-menu" role="menu" hidden>${this._decorateMenu(shownMenuActions)}</div>` : ""}`;
    if (actions.dataset.html !== cardActions) {
      actions.innerHTML = cardActions;
      actions.dataset.html = cardActions;
    }
    const body = element.querySelector(".gen-batch-card-items");
    const showAll = this._showAllItems.has(key);
    const shown = showAll ? visible : visible.slice(0, 5);
    const html =
      shown
        .map(({ item, index }) =>
          this._itemHtml(item, batch, index, displayJob),
        )
        .join("") +
      (visible.length > 5
        ? `<button type="button" class="gen-batch-show-more" data-action="show-items"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${showAll ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}"/></svg><span>${this._escape(this._t(showAll ? "showLess" : "showMore", "", { count: visible.length - 5 }))}</span></button>`
        : "");
    if (body.dataset.html !== html) {
      body
        .querySelectorAll("video[data-preview-src]")
        .forEach((video) => this._videoPreviewObserver?.unobserve(video));
      body.innerHTML = html;
      body.dataset.html = html;
      body
        .querySelectorAll(".gen-batch-result.is-preview-loading img")
        .forEach((image) => {
          if (image.complete && image.naturalWidth > 0)
            image.parentElement.classList.remove("is-preview-loading");
        });
    }
    this._observeVideoPreviews(body);
    if (batch)
      for (const { item, index } of shown) {
        (item.results || []).forEach((result, resultIndex) => {
          const needsPlayback =
            result.video &&
            !result.playUrl &&
            (result.poster === true || !result.url);
          if (
            !needsPlayback &&
            (result.url || result.thumbnail || result.playUrl)
          )
            return;
          const key2 = `${batch.batchId}|${index}|${resultIndex}`;
          if (this._resultRepairs.has(key2) || this._resultRepairing.has(key2))
            return;
          queueMicrotask(() =>
            this._recoverResultThumbnail({
              dataset: { repairKey: key2 },
              currentSrc: "",
              src: "",
            }).catch((error) =>
              console.warn(
                "[GenBatch] Result identity recovery failed:",
                error?.message || error,
              ),
            ),
          );
        });
      }
  }
  _itemHtml(item, batch, index, job) {
    const prompt = item.prompt || "";
    const itemSettings = batch?.items?.[index]?.settingsOverride || {};
    const modelValue =
      item.model ||
      item.settings?.model ||
      itemSettings.model ||
      batch?.settingsSnapshot?.model ||
      job?.settings?.model ||
      "";
    const modelConfig = modelValue
      ? window.ModelRegistry?.findModel?.("flow", modelValue)
      : null;
    const modelLabel = modelConfig?.name || modelConfig?.label || modelValue;
    const ratio =
      item.ratio ||
      item.settings?.ratio ||
      itemSettings.ratio ||
      batch?.settingsSnapshot?.ratio ||
      job?.settings?.ratio ||
      "";
    const metadataHtml =
      modelLabel || ratio
        ? `<div class="gen-batch-item-meta">
      ${modelLabel ? `${this._modelBrandIcon("flow")}<span class="gen-batch-item-model" title="${this._escape(modelLabel)}">${this._escape(modelLabel)}</span>` : ""}
      ${ratio ? `<span class="gen-batch-item-ratio">${this._escape(ratio)}</span>` : ""}
    </div>`
        : "";
    const rawQuantity = batch
      ? (batch.items?.[index]?.settingsOverride?.quantity ??
        batch.settingsSnapshot?.quantity)
      : (item.quantity ?? item.settings?.quantity ?? job?.settings?.quantity);
    const quantity = Number(rawQuantity);
    const displayPrompt =
      Number.isSafeInteger(quantity) && quantity > 1
        ? `${quantity}\xD7 ${prompt}`
        : prompt;
    const state = item.state || item.status || "queued";
    const pausedProviderWait =
      String(state).toUpperCase() === "WAITING_PROVIDER" &&
      (job?.status === "paused" || item.statusKind === "paused");
    const visibleStatus = pausedProviderWait
      ? item.statusLabel || this._statusLabel("paused")
      : this._statusLabel(state);
    const resultMode = ["api", "web"].includes(item.genMode)
      ? item.genMode
      : null;
    const modeBadge = resultMode
      ? `<span class="gen-batch-result-mode" data-mode="${resultMode}" aria-hidden="true">${resultMode.toUpperCase()}</span>`
      : "";
    const refThumbs = (
      item.refKeys?.length ? item.refKeys : item.refFileIds || []
    )
      .map((id, slot) => {
        const ref =
          batch?.refPool?.find((entry) => entry.refKey === id) ||
          (batch ? { refKey: id } : this._directRef(item, id));
        const refBatch =
          batch || (job?.id ? { batchId: `direct:${job.id}` } : null);
        const url = this._refThumbUrl(refBatch, ref);
        const label =
          batch?.refMode === "frames"
            ? `Frame ${slot + 1}`
            : /^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(ref.name || "")
              ? "Reference"
              : ref.name || "Reference";
        return url
          ? `<img class="gen-batch-ref-mini" src="${this._escape(url)}" loading="lazy" decoding="async" ${refBatch ? `data-ref-repair-key="${this._escape(`${refBatch.batchId}|${id}`)}"` : ""} alt="${this._escape(label)}" title="${this._escape(label)}">`
          : `<span class="gen-batch-ref-mini gen-batch-ref-placeholder" title="${this._escape(label)}" aria-label="${this._escape(label)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span>`;
      })
      .join("");
    const outputNodes = (item.results || [])
      .map((savedResult, resultIndex) => {
        const repairKey = `${batch?.batchId || ""}|${index}|${resultIndex}`;
        const repair = this._resultRepairs.get(repairKey);
        const result =
          repair?._sourceResultKey === this._resultSignature(savedResult)
            ? repair
            : savedResult;
        if (result.unavailable) return "";
        const url = result.video
          ? result.playUrl || (result.poster ? null : result.url)
          : result.url;
        const thumb = result.video
          ? result.poster === true
            ? result.thumbnail || result.sourceThumbnail
            : null
          : result.thumbnail || result.url;
        if (thumb && /^https?:\/\//.test(thumb))
          return /^https?:\/\//.test(url || "")
            ? `<button type="button" class="gen-batch-result is-preview-loading" data-action="view" data-result-index="${resultIndex}" data-url="${this._escape(url)}" data-media-type="${result.video ? "video" : "image"}" data-poster="${result.video ? this._escape(thumb) : ""}" aria-label="${this._escape(this._t("viewResult"))}"><img src="${this._escape(thumb)}" loading="lazy" decoding="async" data-repair-key="${this._escape(repairKey)}" alt="">${modeBadge}</button>`
            : `<span class="gen-batch-result is-preview-loading" data-media-type="${result.video ? "video" : "image"}" aria-label="${this._escape(this._t("previewOnly"))}"><img src="${this._escape(thumb)}" loading="lazy" decoding="async" data-repair-key="${this._escape(repairKey)}" alt="">${modeBadge}</span>`;
        return result.video && url && /^https?:\/\//.test(url)
          ? `<button type="button" class="gen-batch-result is-preview-loading" data-action="view" data-result-index="${resultIndex}" data-url="${this._escape(url)}" data-media-type="video" aria-label="${this._escape(this._t("playVideo"))}"><video muted playsinline preload="metadata" data-preview-src="${this._escape(url)}" data-repair-key="${this._escape(repairKey)}" aria-hidden="true"></video>${modeBadge}</button>`
          : "";
      })
      .filter(Boolean);
    const source = batch && this.queue.getJob?.(batch.jobId);
    const originalId = batch?.runtimeItemIds?.[index];
    const sourceItem = source?.items?.find((entry) => entry.id === originalId);
    const removable = !!batch;
    const cachedSource = !sourceItem && this._cachedRegenSource(batch, index);
    const regenModel =
      item.settingsOverride?.model || batch?.settingsSnapshot?.model;
    const modelAvailable = !!window.ModelRegistry?.findModel?.(
      "flow",
      regenModel,
    );
    const canRegen = !this._isItemProcessing(item);
    const isVideo =
      String(
        item.genType ||
          item.mediaType ||
          item.settings?.genType ||
          batch?.settingsSnapshot?.genType ||
          "",
      ).toLowerCase() === "video" ||
      (item.results || []).some((result) => result.video);
    const mediaIcon = isVideo
      ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
      : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    const mediaLabel =
      window.I18n?.t?.(isVideo ? "gen.typeVideo" : "gen.typeImage") ||
      (isVideo ? "Video" : "Image");
    const loading =
      this._isItemProcessing(item) ||
      String(state).toUpperCase() === "DOWNLOADING";
    const recoveringPreview =
      String(state).toUpperCase() === "COMPLETED" &&
      !outputNodes.length &&
      (item.results || []).some((result, resultIndex) => {
        const repair = this._resultRepairs.get(
          `${batch?.batchId || ""}|${index}|${resultIndex}`,
        );
        return (
          !repair?.unavailable &&
          !result.url &&
          !result.thumbnail &&
          !result.playUrl &&
          (result.tileId ||
            result.mediaId ||
            result.mediaUuid ||
            result.fileName)
        );
      });
    const loadingIndicator = loading
      ? this._loadingIndicator(item.flowApiDispatchedAt || item.submittedAt)
      : "";
    const placeholderContent = loading
      ? loadingIndicator
      : recoveringPreview
        ? ""
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mediaIcon}</svg>`;
    const placeholder = `<span class="gen-batch-result-placeholder${loading ? " is-loading" : ""}${recoveringPreview ? " is-preview-loading" : ""}" aria-label="${this._escape(mediaLabel)}">${placeholderContent}</span>`;
    const downloadBatch = batch || this._directDownloadBatch(job);
    const canAddReference =
      (batch
        ? this._batchResultReferences(batch, index)
        : this._directResultReferences(job, index)
      ).length > 0;
    const itemActions = `${batch?.status === "queued" && !batch.resumeItemIndexes && !batch.settingsSnapshot?.chain && !item.hidden ? `<button type="button" data-action="gen-item" ${this._busy || ["running", "paused"].includes(this.scheduler.state) ? "disabled" : ""}>${this._escape(this._t("runItem"))}</button>` : ""}
        <button type="button" data-action="edit-item" ${this._isItemProcessing(item) ? "disabled" : ""}>${this._escape(this._t("editPrompt"))}</button>
        ${canAddReference ? `<button type="button" data-action="add-item-to-references">${this._escape(this._t("addToReferences"))}</button>` : ""}
        ${downloadBatch && this._downloadResults(downloadBatch, index).length ? `<button type="button" data-action="download-item">${this._escape(this._t("download"))}</button>` : ""}
        ${batch ? `<button type="button" data-action="regen-item" ${canRegen ? "" : "disabled"} data-tooltip="${this._escape(canRegen ? this._t("regen") : this._t("regenUnavailable"))}">${this._escape(this._t("regen"))}</button>` : ""}
        ${removable ? `<button type="button" data-action="delete-item">${this._escape(this._t("delete"))}</button>` : ""}`;
    const directEditable = !batch && job && !!job.sessionId && !!item.id;
    const directDownloadable =
      !batch &&
      downloadBatch &&
      this._downloadResults(downloadBatch, index).length > 0;
    const menu =
      batch || directEditable || directDownloadable || canAddReference
        ? `<button type="button" class="gen-batch-menu-trigger" data-action="item-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this._escape(this._t("moreActions"))}"><svg width="14" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg></button>
      <div class="gen-batch-action-menu" role="menu" hidden>
        ${this._decorateMenu(batch ? itemActions : `${directEditable ? `<button type="button" data-action="edit-direct-item" ${this._isItemProcessing(item) ? "disabled" : ""}>${this._escape(this._t("editPrompt"))}</button>` : ""}${directEditable ? `<button type="button" data-action="regen-direct-item" ${canRegen ? "" : "disabled"}>${this._escape(this._t("regen"))}</button>` : ""}${canAddReference ? `<button type="button" data-action="add-item-to-references">${this._escape(this._t("addToReferences"))}</button>` : ""}${directDownloadable ? `<button type="button" data-action="download-item">${this._escape(this._t("download"))}</button>` : ""}${directEditable ? `<button type="button" data-action="delete-direct-item">${this._escape(this._t("delete"))}</button>` : ""}`)}
      </div>`
        : "";
    const error = ["FAILED", "PARTIAL_FAIL", "BLOCKED"].includes(
      String(state).toUpperCase(),
    )
      ? this._itemErrorText(item)
      : "";
    return `<div class="gen-batch-item${outputNodes.length > 1 ? " has-multiple-results" : ""}" data-item-index="${index}" data-item-id="${this._escape(item.id || batch?.runtimeItemIds?.[index] || "")}">
      <div class="gen-batch-item-thumb"${loading ? ' aria-busy="true"' : ""}${outputNodes.length > 1 ? ` data-result-count="${outputNodes.length}"` : ""}>${outputNodes.length ? outputNodes.join("") : placeholder}${loading && outputNodes.length ? `<span class="gen-batch-regen-loading">${loadingIndicator}</span>` : ""}</div>
      <div class="gen-batch-item-main">
        ${batch ? `<button type="button" class="gen-batch-prompt" ${this._isItemProcessing(item) ? "disabled" : ""} data-action="edit-item" title="${this._escape(displayPrompt)}">${this._escape(displayPrompt)}</button>` : directEditable ? `<button type="button" class="gen-batch-prompt" ${this._isItemProcessing(item) ? "disabled" : ""} data-action="edit-direct-item" title="${this._escape(displayPrompt)}">${this._escape(displayPrompt)}</button>` : `<span class="gen-batch-prompt" title="${this._escape(displayPrompt)}">${this._escape(displayPrompt)}</span>`}
        ${metadataHtml || refThumbs ? `<div class="gen-batch-item-detail">${metadataHtml}${refThumbs ? `<div class="gen-batch-ref-thumbs">${refThumbs}</div>` : ""}</div>` : ""}
      </div>
      <span class="gen-batch-item-status" data-state="${this._escape(state)}"${error ? ` data-tooltip="${this._escape(error)}" tabindex="0"` : ""}>${this._escape(visibleStatus)}</span>
      <div class="gen-batch-item-menu">${menu}</div>
    </div>`;
  }
  _decorateMenu(html) {
    const rotate =
      '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>';
    const paths = {
      "gen-item": '<path d="m8 5 11 7-11 7z"/>',
      next: '<path d="M4 7h15M4 12h11M4 17h7"/><path d="m15 14 4-2-4-2"/>',
      retry:
        '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2M18.5 15a7 7 0 0 1-12 2"/>',
      "recover-batch": '<path d="m8 5 11 7-11 7z"/>',
      "recover-direct": '<path d="m8 5 11 7-11 7z"/>',
      "reconcile-batch": '<path d="M4 12l5 5L20 6"/>',
      "edit-batch": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "edit-direct-batch": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "edit-item": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "edit-direct-item": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "web-edit-batch": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "web-mcp-edit-batch": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "web-mcp-edit-item": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "web-run-item": '<path d="m8 5 11 7-11 7z"/>',
      "web-edit": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "web-edit-copy": '<path d="M12 20h9M16 4l4 4L9 19l-5 1 1-5z"/>',
      "web-detail":
        '<path d="M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 17v-4"/><circle cx="12" cy="12" r="9"/>',
      "web-download": '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
      "web-download-batch":
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
      "download-item": '<path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/>',
      "download-batch":
        '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/>',
      "regen-item": rotate,
      "regen-batch": rotate,
      "regen-direct": rotate,
      "regen-direct-item": rotate,
      "web-regen-item": rotate,
      "web-regen-batch": rotate,
      "web-mcp-rerun-item": rotate,
      "web-mcp-rerun-batch": rotate,
      "web-run-unfinished": '<path d="m7 5 10 7-10 7z"/><path d="M20 5v14"/>',
      "web-mcp-rerun-unfinished":
        '<path d="m7 5 10 7-10 7z"/><path d="M20 5v14"/>',
      "manual-pause": '<path d="M7 4v16M17 4v16"/>',
      "manual-resume": '<path d="m8 5 11 7-11 7z"/>',
      "manual-stop": '<rect x="5" y="5" width="14" height="14" rx="2"/>',
      delete: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "delete-direct":
        '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "delete-direct-item":
        '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "delete-item": '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "web-delete": '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "web-delete-item":
        '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "web-mcp-delete-batch":
        '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
      "web-mcp-delete-item":
        '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/>',
    };
    return html.replace(
      /(<button\b[^>]*data-action="([^"]+)"[^>]*>)/g,
      (tag, opening, action) => {
        if (
          [
            "add-results-to-references",
            "add-item-to-references",
            "web-add-results-to-references",
            "web-add-item-to-references",
          ].includes(action)
        )
          return `${opening}<svg width="16" height="16" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.25 1.5H3.9C3.05992 1.5 2.63988 1.5 2.31901 1.66349C2.03677 1.8073 1.8073 2.03677 1.66349 2.31901C1.5 2.63988 1.5 3.05992 1.5 3.9V8.1C1.5 8.94008 1.5 9.36012 1.66349 9.68099C1.8073 9.96323 2.03677 10.1927 2.31901 10.3365C2.63988 10.5 3.05992 10.5 3.9 10.5H8.5C8.96499 10.5 9.19748 10.5 9.38823 10.4489C9.90587 10.3102 10.3102 9.90587 10.4489 9.38823C10.5 9.19748 10.5 8.96499 10.5 8.5M9.5 4V1M8 2.5H11M5.25 4.25C5.25 4.80228 4.80228 5.25 4.25 5.25C3.69772 5.25 3.25 4.80228 3.25 4.25C3.25 3.69772 3.69772 3.25 4.25 3.25C4.80228 3.25 5.25 3.69772 5.25 4.25ZM7.49502 5.95907L3.26557 9.80402C3.02768 10.0203 2.90873 10.1284 2.89821 10.2221C2.88909 10.3033 2.92023 10.3838 2.98159 10.4378C3.05239 10.5 3.21314 10.5 3.53464 10.5H8.22799C8.94757 10.5 9.30736 10.5 9.58996 10.3791C9.94472 10.2274 10.2274 9.94472 10.3791 9.58996C10.5 9.30736 10.5 8.94757 10.5 8.22799C10.5 7.98587 10.5 7.86482 10.4735 7.75208C10.4403 7.61039 10.3765 7.47768 10.2866 7.3632C10.2151 7.2721 10.1206 7.19647 9.93154 7.04523L8.53291 5.92633C8.34369 5.77495 8.24908 5.69927 8.1449 5.67256C8.05307 5.64901 7.95643 5.65206 7.86627 5.68135C7.76397 5.71457 7.67432 5.79607 7.49502 5.95907Z"/></svg>`;
        const path = paths[action];
        const width = [
          "regen-item",
          "regen-batch",
          "regen-direct",
          "web-regen-item",
          "web-regen-batch",
          "web-mcp-rerun-item",
          "web-mcp-rerun-batch",
        ].includes(action)
          ? "2"
          : "1.8";
        return path
          ? `${opening}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
          : opening;
      },
    );
  }
  _cachedRegenSource(batch, index) {
    if (!batch || !["completed", "failed", "stopped"].includes(batch.status))
      return null;
    const job = this._jobForBatchItem(batch, index);
    const rootId = batch.runtimeItemIds?.[index];
    if (!rootId || batch.settingsSnapshot?.chain) return null;
    const cachedReady =
      job &&
      !job.chain &&
      ["completed", "failed", "stopped"].includes(job.status);
    const cachedItem = cachedReady
      ? this._runtimeItemByRoot(job.items, rootId)
      : null;
    const receipt = batch.terminalItems?.[index];
    const durable =
      !cachedItem &&
      receipt?.id === rootId &&
      ["COMPLETED", "PARTIAL_FAIL", "FAILED", "CANCELLED", "BLOCKED"].includes(
        receipt.state,
      );
    const refs = batch.items[index]?.refKeys || [];
    const pool = batch.refPool || [];
    const refFileNames = Object.fromEntries(
      refs.map((id) => [
        id,
        pool.find((ref) => ref.refKey === id)?.fileName || id,
      ]),
    );
    const refThumbnails = Object.fromEntries(
      refs.map((id) => [
        id,
        pool.find((ref) => ref.refKey === id)?.thumbnail || null,
      ]),
    );
    const item =
      cachedItem ||
      (durable
        ? {
            id: rootId,
            state: receipt.state,
            projectId: batch.projectId,
            promptIndex: index,
            refFileIds: refs,
            refFileNames,
            refThumbnails,
            refImageMode: batch.refMode,
            mentionData: batch.items[index]?.mentionData || null,
            autoDownload: batch.autoDownload === true,
            downloadResolution:
              batch.settingsSnapshot?.downloadResolution || null,
            videoDownloadResolution:
              batch.settingsSnapshot?.videoDownloadResolution || null,
          }
        : null);
    if (
      !item ||
      !["COMPLETED", "PARTIAL_FAIL", "FAILED", "CANCELLED", "BLOCKED"].includes(
        item.state,
      ) ||
      item.projectId !== batch.projectId
    )
      return null;
    const settings = {
      ...(batch.settingsSnapshot || {}),
      ...(job?.settings || {}),
      ...(item.settings || {}),
      ...(item.model ? { model: item.model } : {}),
      ...(item.ratio ? { ratio: item.ratio } : {}),
      ...(item.genType ? { genType: item.genType } : {}),
      ...(item.quantity != null ? { quantity: item.quantity } : {}),
      ...(batch.items[index]?.settingsOverride || {}),
    };
    if (
      !settings.model ||
      !settings.ratio ||
      !settings.genType ||
      !Number.isInteger(Number(settings.quantity))
    )
      return null;
    if (!window.ModelRegistry?.findModel?.("flow", settings.model)) return null;
    if (
      (item.genMode || job?.modeType || batch.flowExecutionMode) !== "web" &&
      refs.length
    ) {
      try {
        window.GenBatchAdmission._validateApiRefIdentity(
          {
            items: [
              {
                refKeys: batch.items[index]?.refKeys || item.refFileIds,
                mentionData:
                  batch.items[index]?.mentionData || item.mentionData,
              },
            ],
          },
          item.refFileNames || {},
          item.refThumbnails || {},
        );
      } catch (_) {
        return null;
      }
    }
    const segment = (batch.executionSegments || []).find(
      (entry) => entry.runtimeItemIds?.[index] === rootId,
    );
    return {
      job: job || {
        id: segment?.jobId || batch.jobId,
        owner: "prompts",
        projectId: batch.projectId,
        status: batch.status,
        label: batch.displayName,
        startedAt: batch.createdAt,
        effectiveRunMode: batch.sequentialMode ? "sequential" : "parallel",
      },
      item,
      settings,
    };
  }
  _renderControls() {
    this.overlay.querySelector(".gen-batch-clear-controls").hidden = false;
    const drafts = this.batches.filter((batch) => batch.status === "queued");
    let draftPolicyReady = false;
    try {
      draftPolicyReady = drafts.every(
        (batch) =>
          window.GenBatchDraftBuilder.checkLimit(
            batch.items.filter((item) => !item.hidden).length,
          ).allowed === true,
      );
    } catch (_) {}
    const ambiguous = this.batches.some((batch) =>
      this.store.isPossiblyLive(batch),
    );
    const state = this.scheduler.state;
    const activeJobPaused =
      this.scheduler.activeJobId &&
      this.queue.getJob?.(this.scheduler.activeJobId)?.state === "paused";
    const labels = {
      "run-all": this._t("runAll", "Run all"),
      pause: this._t("pause", "Pause"),
      resume: this._t("resume", "Resume"),
      stop: this._t("stop", "Stop"),
      "clear-queued": this._t("clearQueued", "Clear queued"),
      "clear-all": this._t("clearAll", "Clear all"),
      "clear-history": this._t("clearHistory", "Clear project history"),
    };
    const icons = {
      "run-all":
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>',
      pause:
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
      resume:
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>',
      stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
      "clear-queued":
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h11M4 11h8M4 16h7"/><path d="m16 14 5 5m0-5-5 5"/></svg>',
      "clear-all":
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg>',
      "clear-history":
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 1 9 9"/><path d="M3 5v7h7M12 7v5l3 2"/><path d="m3 18 4 4m0-4-4 4"/></svg>',
    };
    for (const [action, label] of Object.entries(labels)) {
      const button = this.overlay.querySelector(`[data-action="${action}"]`);
      button.innerHTML = `<span aria-hidden="true">${icons[action]}</span>${action === "run-all" ? `<span>${this._escape(label)}</span>` : ""}`;
      button.setAttribute("aria-label", label);
      button.dataset.tooltip = label;
    }
    const runButton = this.overlay.querySelector('[data-action="run-all"]');
    runButton.disabled =
      !drafts.length ||
      ambiguous ||
      this._busy ||
      this.batches.some(
        (batch) => batch.status === "needs_review" && !batch.completedAt,
      ) ||
      ["running", "paused"].includes(state) ||
      window.PromptQueue?.isEnabled?.() !== true ||
      !draftPolicyReady;
    if (runButton.disabled)
      runButton.dataset.tooltip = ambiguous
        ? this._t("resumeUnfinished", "Resume unfinished prompts")
        : !draftPolicyReady
          ? this._t(
              "entitlementUnavailable",
              "Cannot verify this batch against your plan.",
            )
          : this._t("runUnavailable", "No runnable queued batch is available");
    this.overlay.querySelector('[data-action="pause"]').disabled =
      state !== "running" || activeJobPaused;
    this.overlay.querySelector('[data-action="resume"]').disabled =
      state !== "paused" && !activeJobPaused;
    this.overlay.querySelector('[data-action="stop"]').disabled = ![
      "running",
      "paused",
    ].includes(state);
    const controls = this.overlay.querySelector(".gen-batch-run-controls");
    controls.querySelector('[data-action="pause"]').hidden =
      state !== "running" || activeJobPaused;
    controls.querySelector('[data-action="resume"]').hidden =
      state !== "paused" && !activeJobPaused;
    controls.querySelector('[data-action="stop"]').hidden = ![
      "running",
      "paused",
    ].includes(state);
    controls.classList.toggle(
      "is-idle",
      !["running", "paused"].includes(state),
    );
    const clearQueued = this.overlay.querySelector(
      '[data-action="clear-queued"]',
    );
    clearQueued.disabled = !drafts.length || this._busy;
    if (clearQueued.disabled)
      clearQueued.dataset.tooltip = this._t(
        "nothingQueued",
        "No queued batches to clear",
      );
    const clearAll = this.overlay.querySelector('[data-action="clear-all"]');
    clearAll.disabled =
      (!this.batches.some((batch) => !batch.hiddenFromBatchList) &&
        !this._directJobsForDeletion().length) ||
      this._busy;
    if (clearAll.disabled)
      clearAll.dataset.tooltip = !this.batches.length
        ? this._t("nothingToClear", "Batch list is empty")
        : this._t(
            "liveClearBlocked",
            "Finish or stop the active batch before clearing",
          );
    this.overlay.querySelector('[data-action="clear-history"]').disabled =
      this._busy || this.queue?.isRunning || this.queue?.activeJobCount > 0;
  }
  async _confirm(message) {
    return window.customDialog?.confirm
      ? window.customDialog.confirm(message, {
          title: this._t("title", "Batch list"),
          type: "warning",
        })
      : window.confirm(message);
  }
  async _confirmDelete(message, title = this._t("delete"), itemName = "") {
    return window.customDialog?.confirmDangerous
      ? window.customDialog.confirmDangerous(message, {
          title,
          itemName,
          confirmText: this._t("delete"),
          cancelText: this._t("cancel"),
          closeText: this._t("close"),
          showClose: true,
          confirmIcon: "delete",
        })
      : window.confirm(message);
  }
  async _recoverBatch(batch) {
    if (
      this._busy ||
      this._liveJobs().some(
        (job) =>
          job.id === batch.jobId &&
          !["completed", "failed", "stopped"].includes(job.status),
      ) ||
      ["running", "paused"].includes(this.scheduler.state) ||
      this.queue?.isRunning ||
      this.queue?.activeJobCount > 0
    )
      throw new Error("BATCH_RECOVERY_RUNTIME_ACTIVE");
    const owner = this._scope();
    if (
      String(owner?.userId) !== String(batch.userId) ||
      owner?.projectId !== batch.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    const current = await this.store.get(
      owner.userId,
      owner.projectId,
      batch.batchId,
    );
    if (!current || current.revision !== batch.revision)
      throw new Error("BATCH_REVISION_CONFLICT");
    const completedEvidence = this._completedEvidence(current);
    const completedIds = new Set(completedEvidence.map((item) => item.id));
    const pending = current.items.filter(
      (item, index) =>
        !item.hidden &&
        current.terminalItems?.[index]?.state !== "COMPLETED" &&
        !completedIds.has(current.runtimeItemIds?.[index]),
    ).length;
    if (!pending) throw new Error("BATCH_RECOVERY_NOTHING_PENDING");
    if (
      !(await this._confirm(
        this._t(
          "resumeUnfinishedConfirm",
          "The previous Flow job may still finish after reload. Check Flow first. Resume {count} unfinished prompts in this batch? Completed results will stay here.",
          { count: pending },
        ),
      ))
    )
      return;
    if (
      String(this._scope()?.userId) !== String(owner.userId) ||
      this._scope()?.projectId !== owner.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    if (
      this._liveJobs().some(
        (job) =>
          job.id === batch.jobId &&
          !["completed", "failed", "stopped"].includes(job.status),
      ) ||
      this.queue?.isRunning ||
      this.queue?.activeJobCount > 0
    )
      throw new Error("BATCH_RECOVERY_RUNTIME_ACTIVE");
    this._busy = true;
    let recovered;
    try {
      recovered = await this.store.recoverUnfinished(
        owner.userId,
        owner.projectId,
        current.batchId,
        current.revision,
        completedEvidence,
      );
      await this.reload();
    } finally {
      this._busy = false;
      this._renderControls();
    }
    return this._runConfirmed(current.batchId);
  }
  _completedEvidence(batch) {
    const job =
      this._liveJobs().find(
        (entry) =>
          entry.id === batch.jobId &&
          entry.projectId === batch.projectId &&
          ["completed", "failed", "stopped"].includes(entry.status),
      ) || this._cachedJobForBatch(batch);
    const knownIds = new Set(batch.runtimeItemIds || []);
    return (job?.items || []).filter(
      (item) =>
        knownIds.has(item.id) &&
        item.state === "COMPLETED" &&
        (!item.projectId || item.projectId === batch.projectId),
    );
  }
  async _reconcileBatch(batch) {
    if (
      this._busy ||
      ["running", "paused"].includes(this.scheduler.state) ||
      this.queue?.isRunning ||
      this.queue?.activeJobCount > 0 ||
      this._liveJobs().some(
        (job) =>
          job.id === batch.jobId &&
          !["completed", "failed", "stopped"].includes(job.status),
      )
    )
      throw new Error("BATCH_RECOVERY_RUNTIME_ACTIVE");
    const owner = this._scope();
    if (
      String(owner?.userId) !== String(batch.userId) ||
      owner?.projectId !== batch.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    const current = await this.store.get(
      owner.userId,
      owner.projectId,
      batch.batchId,
    );
    if (!current || current.revision !== batch.revision)
      throw new Error("BATCH_REVISION_CONFLICT");
    this._busy = true;
    try {
      await this.store.reconcileCompleted(
        owner.userId,
        owner.projectId,
        current.batchId,
        current.revision,
        this._completedEvidence(current),
      );
      await this.reload();
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  _downloadReceiptOf(result) {
    let urlUuid = null;
    for (const value of [
      result.url,
      result.thumbnail,
      result.sourceThumbnail,
    ]) {
      try {
        const url = new URL(value);
        if (
          !["flow-content.google", "labs.google", "flow.google.com"].includes(
            url.hostname,
          )
        )
          continue;
        urlUuid =
          url.pathname.match(
            /\/(?:image|video)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:\/|$)/i,
          )?.[1] || null;
        if (urlUuid) break;
      } catch (_) {}
    }
    return {
      video: result.video === true,
      mediaUuid: result.mediaUuid || result.media_uuid || urlUuid || null,
      mediaId:
        result.mediaId || result.media_id || result.persistent_media_id || null,
      tileId: result.tileId || result.tile_id || null,
      fileName: result.fileName || result.file_name || null,
    };
  }
  _downloadResults(batch, index = null) {
    const indices =
      index == null ? batch.items.map((_, position) => position) : [index];
    return indices.flatMap((position) => {
      const job = this._jobForBatchItem(batch, position);
      const rootId = this._batchRuntimeRootId(batch, position);
      const item = this._runtimeItemByRoot(job?.items, rootId);
      if (Array.isArray(item?.results) && item.results.length)
        return item.results;
      if (!rootId) return [];
      return this._receiptResults(batch, position).filter((result) => {
        const receipt = this._downloadReceiptOf(result);
        const identities = [
          receipt.mediaUuid,
          receipt.mediaId,
          receipt.tileId,
          receipt.fileName,
        ];
        return identities.some(
          (value) =>
            typeof value === "string" &&
            (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ||
              (result.video === true &&
                /^[A-Za-z0-9_-]{32,1024}$/.test(value))),
        );
      });
    });
  }
  _directDownloadBatch(job) {
    if (
      !job?.id ||
      !job.sessionId ||
      !job.projectId ||
      !Array.isArray(job.items)
    )
      return null;
    return {
      projectId: job.projectId,
      jobId: job.id,
      trackerSessionId: job.sessionId,
      flowExecutionMode: job.modeType === "api" ? "api" : "web",
      items: job.items,
      runtimeItemIds: job.items.map((item) => item.id),
    };
  }
  _downloadSource(batch, index) {
    const itemId = this._batchRuntimeRootId(batch, index);
    if (!itemId || !this._downloadResults(batch, index).length) return null;
    const sourceJob = this._jobForBatchItem(batch, index);
    const segment = (batch.executionSegments || []).find(
      (entry) => entry.runtimeItemIds?.[index] === itemId,
    );
    return {
      jobId: sourceJob?.id || segment?.jobId || batch.jobId,
      sessionId:
        sourceJob?.sessionId ||
        segment?.trackerSessionId ||
        batch.trackerSessionId,
      itemId,
      promptIndex: index,
      prompt: batch.items[index]?.prompt || "",
      genMode: batch.flowExecutionMode,
      results: this._downloadResults(batch, index).map((result) =>
        this._downloadReceiptOf(result),
      ),
    };
  }
  async _askDownloadOptions(batch, index = null) {
    if (this._downloadResolve) return null;
    const results = this._downloadResults(batch, index);
    if (!results.length) throw new Error("BATCH_DOWNLOAD_SOURCE_UNAVAILABLE");
    const isVideo = results.every((result) => result.video === true);
    const resolutions =
      window.ProviderConfigManager?.getDownloadResolutionsSync?.(
        "flow",
        isVideo ? "video" : "image",
      );
    if (!Array.isArray(resolutions) || !resolutions.length)
      throw new Error("BATCH_DOWNLOAD_CONFIG_UNAVAILABLE");
    const data = await chrome.storage.local.get([
      "af_settings",
      "af_system_settings",
      "af_entitlements",
    ]);
    if (!this._open || this._scope()?.projectId !== batch.projectId)
      throw new Error("BATCH_SCOPE_CHANGED");
    const truthy = (value) => value === true || value === 1 || value === "1";
    const wmEnabled = truthy(data.af_system_settings?.remove_watermark_enabled);
    const canClean =
      wmEnabled &&
      truthy(
        data.af_entitlements?.entitlements?.image_remove_watermark_enabled
          ?.value,
      );
    const preferred =
      wmEnabled && truthy(data.af_settings?.autoRemoveWatermark) && canClean
        ? "clean"
        : wmEnabled
          ? "original"
          : "inherit";
    const saved = isVideo
      ? data.af_settings?.videoDownloadResolution
      : data.af_settings?.downloadResolution;
    const resolution =
      resolutions.find((entry) => entry.value === saved)?.value ||
      resolutions[0].value;
    const selection = {
      mode: preferred,
      resolution,
      resolutionMedia: isVideo ? "video" : "image",
    };
    const sheet = this.overlay.querySelector(".gen-batch-download-overlay");
    const translate = (key, fallback) => {
      const value = window.I18n?.t?.(key);
      return value && value !== key ? value : fallback;
    };
    sheet.querySelector("h3").textContent =
      results.length > 1
        ? `${this._t("download")} \xB7 ${results.length}`
        : this._t("download");
    sheet.querySelector(".gen-batch-download-cancel").textContent =
      this._t("cancel");
    sheet.querySelector(".gen-batch-download-submit").textContent =
      this._t("download");
    const choices = (kind, entries, chosen) =>
      entries
        .map(
          (entry) =>
            `<button type="button" class="gen-batch-download-choice" data-kind="${kind}" data-value="${this._escape(entry.value)}" aria-pressed="${entry.value === chosen}" ${entry.locked ? 'data-locked="true"' : ""}>${this._escape(entry.label)}${entry.locked ? " \u265B" : ""}</button>`,
        )
        .join("");
    sheet.querySelector(".gen-batch-download-content").innerHTML = `${
      wmEnabled
        ? `<label>${this._escape(translate("tasks.wmLabel", "Version"))}</label><div class="gen-batch-download-options">${choices(
            "mode",
            [
              {
                value: "original",
                label: translate("tasks.wmOriginal", "Original"),
              },
              {
                value: "clean",
                label: translate("tasks.wmClean", "Watermark removed"),
                locked: !canClean,
              },
            ],
            selection.mode,
          )}</div>`
        : ""
    }
      <label>${this._escape(translate("tasks.resolution", "Resolution"))}</label><div class="gen-batch-download-options">${choices(
        "resolution",
        resolutions.map((entry) => ({
          value: entry.value,
          label: entry.menu_label || entry.value,
        })),
        selection.resolution,
      )}</div>`;
    this._downloadSelection = selection;
    sheet.classList.remove("hidden");
    this._downloadFocus = document.activeElement;
    sheet.querySelector(".gen-batch-download-close").focus();
    return new Promise((resolve) => {
      this._downloadResolve = resolve;
    });
  }
  _finishDownloadOptions(selection) {
    if (!this._downloadResolve) return;
    const resolve = this._downloadResolve;
    this._downloadResolve = null;
    this.overlay
      .querySelector(".gen-batch-download-overlay")
      .classList.add("hidden");
    this._downloadSelection = null;
    this._downloadFocus?.focus?.();
    resolve(selection ? { ...selection } : null);
  }
  async _downloadItem(downloadBatch, index, cardKey) {
    const itemId = this._batchRuntimeRootId(downloadBatch, index);
    if (!downloadBatch || !itemId)
      throw new Error("BATCH_DOWNLOAD_SOURCE_UNAVAILABLE");
    const source = this._downloadSource(downloadBatch, index);
    if (!source) throw new Error("BATCH_DOWNLOAD_SOURCE_UNAVAILABLE");
    const downloadSelection = await this._askDownloadOptions(
      downloadBatch,
      index,
    );
    if (!downloadSelection) return;
    return this._requestDownload(
      "genBatchDownloadItem",
      {
        projectId: downloadBatch.projectId,
        jobId: source.jobId,
        itemId,
        source,
        downloadSelection,
      },
      downloadBatch,
      cardKey,
      [source],
    );
  }
  async _downloadEditorResult() {
    const editor = this._editor;
    if (!editor || !["item", "direct-item"].includes(editor.kind)) return;
    if (editor.kind === "item") {
      const batch = this.batches.find(
        (entry) => entry.batchId === editor.batchId,
      );
      if (!batch || batch.projectId !== this._scope()?.projectId)
        throw new Error("BATCH_DOWNLOAD_SOURCE_UNAVAILABLE");
      return this._downloadItem(batch, editor.index, batch.batchId);
    }
    const job = [...this._liveJobs(), ...this.cachedJobs].find(
      (entry) =>
        entry.id === editor.jobId &&
        entry.sessionId === editor.sessionId &&
        entry.projectId === editor.projectId,
    );
    const downloadBatch = this._directDownloadBatch(job);
    const index =
      job?.items?.findIndex((item) => item.id === editor.itemId) ?? -1;
    return this._downloadItem(downloadBatch, index, `direct:${editor.jobId}`);
  }
  async _action(button) {
    var _a;
    const action = button.dataset.action;
    if (action === "item-layout-toggle") {
      const layout = this._itemLayout === "list" ? "grid" : "list";
      this._itemLayoutTouched = true;
      this._itemLayout = layout;
      this._syncItemLayout();
      await chrome.storage.local.set({
        tobyflow_batch_list_item_layout: layout,
      });
      return;
    }
    if (action === "batch-view") {
      this._view = button.dataset.view;
      this.body.replaceChildren();
      this._cards.clear();
      await this.reload();
      this._render();
      this._refreshWebWorkerGate();
      return;
    }
    if (action?.startsWith("web-")) return this.webView?.action(button);
    if (
      ["muse", "chatgpt", "gemini"].includes(this._view) &&
      ["clear-queued", "clear-history"].includes(action)
    )
      return;
    if (
      ["muse", "chatgpt", "gemini"].includes(this._view) &&
      action === "clear-all"
    )
      return this.webView?.action({ dataset: { action: "web-clear-all" } });
    if (
      ["muse", "chatgpt", "gemini"].includes(this._view) &&
      action === "run-all"
    )
      return this.webView?.action({ dataset: { action: "web-run-all" } });
    if (
      ["muse", "chatgpt", "gemini"].includes(this._view) &&
      action === "pause"
    )
      return this.webView?.action({ dataset: { action: "web-pause-all" } });
    if (
      ["muse", "chatgpt", "gemini"].includes(this._view) &&
      action === "resume"
    )
      return this.webView?.action({ dataset: { action: "web-resume-all" } });
    if (["muse", "chatgpt", "gemini"].includes(this._view) && action === "stop")
      return this.webView?.action({ dataset: { action: "web-stop-all" } });
    if (action === "run-confirm-no") return this._finishRunConfirm(false);
    if (action === "run-confirm-yes") return this._finishRunConfirm(true);
    if (action === "quantity-minus" || action === "quantity-plus") {
      const input = button.parentElement?.querySelector(
        'input[name="quantity"]',
      );
      if (!input || input.disabled) return;
      if (action === "quantity-minus") input.stepDown();
      else input.stepUp();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (action === "ref-count-minus" || action === "ref-count-plus") {
      const input = button.parentElement?.querySelector(
        'input[name="refCount"]',
      );
      if (!input || input.disabled) return;
      if (action === "ref-count-minus") input.stepDown();
      else input.stepUp();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (action === "batch-media-type") {
      if (this._busy) return;
      const select = this.overlay.querySelector(
        '.gen-batch-editor [name="genType"]',
      );
      const option = [...(select?.options || [])].find(
        (entry) => entry.value === button.dataset.value,
      );
      if (!option || option.disabled) return;
      select.value = option.value;
      for (const control of select
        .closest(".gen-batch-media-field")
        .querySelectorAll('[data-action="batch-media-type"]')) {
        const active = control === button;
        control.classList.toggle("active", active);
        control.setAttribute("aria-pressed", String(active));
      }
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    if (action === "close") return this.close();
    if (action === "flow-settings")
      return chrome.runtime.sendMessage({
        action: "openSettings",
        tab: "max-speed",
      });
    if (action === "storage-settings")
      return chrome.runtime.sendMessage({
        action: "openSettings",
        tab: "storage",
      });
    if (action === "download-editor-result")
      return this._downloadEditorResult();
    if (action === "view") {
      const url = button.dataset.url;
      let onDownload = null;
      let navigation = null;
      if (
        button
          .closest(".gen-batch-editor-evidence")
          ?.querySelector('[data-action="download-editor-result"]')
      ) {
        onDownload = () =>
          this._downloadEditorResult().catch((error) => this._error(error));
      } else {
        const row = button.closest(".gen-batch-item");
        const card3 = row?.closest(".gen-batch-card");
        const batch3 = this.batches.find(
          (entry) => entry.batchId === card3?.dataset.cardKey,
        );
        const directJob2 =
          !batch3 && card3?.dataset.cardKey?.startsWith("direct:")
            ? [...this._liveJobs(), ...this.cachedJobs].find(
                (entry) => `direct:${entry.id}` === card3.dataset.cardKey,
              )
            : null;
        const downloadBatch2 = batch3 || this._directDownloadBatch(directJob2);
        const index = Number(row?.dataset.itemIndex);
        if (
          downloadBatch2 &&
          Number.isInteger(index) &&
          this._downloadResults(downloadBatch2, index).length
        )
          onDownload = () =>
            this._downloadItem(
              downloadBatch2,
              index,
              card3.dataset.cardKey,
            ).catch((error) => this._error(error));
      }
      const card2 = button.closest(".gen-batch-card");
      const batchId = card2?.dataset.cardKey || this._editor?.batchId;
      const batch2 = this.batches.find((entry) => entry.batchId === batchId);
      if (batch2) {
        const liveJob = this._liveJobs().find(
          (entry) =>
            entry.id === batch2.jobId || entry.sourceBatchId === batch2.batchId,
        );
        const items = this._displayItems(
          batch2,
          liveJob || this._cachedJobForBatch(batch2),
          liveJob,
        );
        const gallery = items.flatMap((item, promptIndex) =>
          batch2.items[promptIndex]?.hidden
            ? []
            : (item.results || []).flatMap((savedResult, resultIndex) => {
                const repairKey = `${batch2.batchId}|${promptIndex}|${resultIndex}`;
                const repair = this._resultRepairs.get(repairKey);
                const result =
                  repair?._sourceResultKey ===
                  this._resultSignature(savedResult)
                    ? repair
                    : savedResult;
                const src = result.video
                  ? result.playUrl || (result.poster ? null : result.url)
                  : result.url;
                if (result.unavailable || !/^https?:\/\//.test(src || ""))
                  return [];
                const poster = result.video
                  ? result.thumbnail || result.sourceThumbnail
                  : null;
                return [
                  {
                    src,
                    type: result.video ? "video" : "image",
                    poster: /^https?:\/\//.test(poster || "") ? poster : null,
                    promptIndex,
                    resultIndex,
                  },
                ];
              }),
        );
        const currentPromptIndex = Number(
          button.closest(".gen-batch-item")?.dataset.itemIndex ??
            this._editor?.index,
        );
        const clickedResultIndex = Number(button.dataset.resultIndex);
        const selected = gallery.findIndex(
          (entry) =>
            entry.src === url &&
            entry.promptIndex === currentPromptIndex &&
            (!Number.isInteger(clickedResultIndex) ||
              entry.resultIndex === clickedResultIndex),
        );
        if (selected >= 0) {
          const resolve = async (index) => ({
            ...gallery[index],
            onDownload: this._downloadResults(
              batch2,
              gallery[index].promptIndex,
            ).length
              ? () =>
                  this._downloadItem(
                    batch2,
                    gallery[index].promptIndex,
                    batch2.batchId,
                  ).catch((error) => this._error(error))
              : null,
          });
          navigation = { index: selected, count: gallery.length, resolve };
          onDownload = this._downloadResults(batch2, currentPromptIndex).length
            ? () =>
                this._downloadItem(
                  batch2,
                  currentPromptIndex,
                  batch2.batchId,
                ).catch((error) => this._error(error))
            : null;
        }
      }
      if (
        /^https?:\/\//.test(url || "") &&
        typeof WorkflowEditor !== "undefined"
      )
        WorkflowEditor.showMediaViewer({
          src: url,
          type: button.dataset.mediaType === "video" ? "video" : "image",
          poster: /^https?:\/\//.test(button.dataset.poster || "")
            ? button.dataset.poster
            : null,
          onDownload,
          navigation,
        });
      return;
    }
    const card = button.closest(".gen-batch-card");
    const batch = this.batches.find(
      (entry) => entry.batchId === card?.dataset.cardKey,
    );
    const job = this._liveJobs().find(
      (entry) =>
        entry.id === batch?.jobId ||
        `direct:${entry.id}` === card?.dataset.cardKey,
    );
    const directJob =
      !batch && card?.dataset.cardKey?.startsWith("direct:")
        ? job ||
          this.cachedJobs.find(
            (entry) => `direct:${entry.id}` === card.dataset.cardKey,
          )
        : null;
    const downloadBatch = batch || this._directDownloadBatch(directJob);
    if (
      ["add-results-to-references", "add-item-to-references"].includes(
        action,
      ) &&
      (batch || directJob)
    ) {
      const scope = this._scope();
      const projectId = batch?.projectId || directJob.projectId;
      if (
        !scope ||
        scope.projectId !== projectId ||
        (batch && String(scope.userId) !== String(batch.userId)) ||
        (directJob?.userId &&
          String(scope.userId) !== String(directJob.userId)) ||
        (directJob?.mcpUserId &&
          String(scope.userId) !== String(directJob.mcpUserId))
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      const index =
        action === "add-item-to-references"
          ? Number(button.closest(".gen-batch-item")?.dataset.itemIndex)
          : null;
      if (
        action === "add-item-to-references" &&
        (!Number.isInteger(index) || index < 0)
      )
        throw new Error("BATCH_ITEM_NOT_FOUND");
      const references = batch
        ? this._batchResultReferences(batch, index)
        : this._directResultReferences(directJob, index);
      if (!references.length) throw new Error("NO_REFERENCE_MEDIA_ID");
      const added = await window.GenTab.addTrackerReferences(
        references,
        projectId,
      );
      this.close("add-results-to-references");
      window.showNotification?.(
        window.I18n?.t?.(
          added > 0 ? "gen.refImageAddedCount" : "gen.refImageAlreadyAdded",
          { count: added },
        ),
        added > 0 ? "success" : "info",
      );
      return;
    }
    if (action === "show-items") {
      if (this._showAllItems.has(card.dataset.cardKey))
        this._showAllItems.delete(card.dataset.cardKey);
      else this._showAllItems.add(card.dataset.cardKey);
      this._render();
      return;
    }
    if (action === "batch-menu" || action === "item-menu") {
      const menu = button.nextElementSibling;
      if (menu) {
        for (const other of this.overlay.querySelectorAll(
          ".gen-batch-action-menu:not([hidden])",
        ))
          if (other !== menu) {
            other.hidden = true;
            other.previousElementSibling?.setAttribute(
              "aria-expanded",
              "false",
            );
          }
        menu.hidden = !menu.hidden;
        button.setAttribute("aria-expanded", String(!menu.hidden));
        if (!menu.hidden) {
          const box = button.getBoundingClientRect();
          menu.style.position = "fixed";
          menu.style.right = `${Math.max(6, window.innerWidth - box.right)}px`;
          const menuHeight = menu.getBoundingClientRect().height;
          menu.style.top = `${box.bottom + menuHeight + 8 > window.innerHeight ? Math.max(6, box.top - menuHeight - 4) : box.bottom + 4}px`;
          menu
            .querySelector("button:not(:disabled)")
            ?.focus({ preventScroll: true });
        }
      }
      return;
    }
    if (action === "rename" && batch) return this._rename(card, batch);
    if (action === "editor-cancel") return this._closeEditor();
    if (action === "editor-save") return this._saveEditor();
    if (action === "remove-item-ref" && this._editor?.kind === "item") {
      const choices = button.closest(".gen-batch-ref-choices");
      button.remove();
      if (choices && !choices.children.length) {
        const empty = document.createElement("p");
        empty.className = "gen-batch-ref-empty";
        empty.textContent = this._t("noReferences");
        choices.after(empty);
      }
      return;
    }
    if (action === "batch-editor-delete-item")
      return this._deleteBatchEditorPrompt(button);
    if (action === "batch-pick-refs") return this._pickBatchReferences();
    if (action === "item-pick-refs") return this._pickItemReferences();
    if (action === "batch-frame-bulk" || action === "item-frame-bulk")
      return this._assignEditorFrameSources(button.dataset.frameBulk);
    if (action === "batch-frame-target") {
      this._editor.activeFrame = {
        index: Number(button.dataset.originalIndex),
        name: button.dataset.frameName,
      };
      this._renderBatchFramePairs(
        this.batches.find((entry) => entry.batchId === this._editor.batchId),
      );
      return;
    }
    if (action === "batch-frame-source-select")
      return this._selectBatchFrameSource(button.dataset.refKey);
    if (action === "item-frame-target") {
      this._editor.activeFrameName = button.dataset.frameName;
      this.overlay
        .querySelectorAll(".gen-batch-item-frame-slots .frame-slot")
        .forEach((slot) => slot.classList.toggle("is-active", slot === button));
      return;
    }
    if (action === "item-frame-select")
      return this._selectEditorFrameSource(button);
    if (action === "item-frame-remove") {
      const key = button.dataset.refKey;
      (_a = this._editor).hiddenFrameSources ||
        (_a.hiddenFrameSources = new Set());
      this._editor.hiddenFrameSources.add(key);
      const sheet = this.overlay.querySelector(".gen-batch-editor");
      for (const name of ["frame1", "frame2"]) {
        const select = sheet.querySelector(`[name="${name}"]`);
        if (select?.value === key) {
          select.value = "";
          this._updateFramePreview(select);
        }
      }
      const batch2 = this.batches.find(
        (entry) => entry.batchId === this._editor.batchId,
      );
      if (batch2) this._renderItemFrameSources(batch2);
      return;
    }
    if (action === "ref-rescan") {
      const editor = this._editor;
      const target = this.batches.find(
        (entry) => entry.batchId === editor?.batchId,
      );
      if (!target || !editor) return;
      button.disabled = true;
      button.classList.add("ref-thumb-rescan-btn--loading");
      try {
        await this._hydrateBatchRefThumbs(target, editor, {
          deep: true,
          refKey: button.dataset.refKey,
        });
      } finally {
        button.disabled = false;
        button.classList.remove("ref-thumb-rescan-btn--loading");
      }
      return;
    }
    if (action === "ref-remove") {
      if (this._editor?.kind === "batch" && batch?.refMode === "frames")
        this._pruneEditorFramePairs(
          batch,
          new Set(
            [
              ...button
                .closest(".gen-batch-ref-list")
                .querySelectorAll(".gen-batch-ref-row"),
            ]
              .filter((row) => row !== button.closest(".gen-batch-ref-row"))
              .map((row) => row.dataset.refKey),
          ),
        );
      button.closest(".gen-batch-ref-row")?.remove();
      this._refreshBatchPreview();
      return;
    }
    if (action === "run-all") return this._runConfirmed();
    if (action === "run-batch" && batch)
      return this._runConfirmed(batch.batchId);
    if (action === "gen-item" && batch) {
      const index = Number(
        button.closest(".gen-batch-item")?.dataset.itemIndex,
      );
      return this._runConfirmed(batch.batchId, index);
    }
    if (action === "pause") {
      if (!(await this.scheduler.pause()))
        throw new Error("BATCH_PAUSE_REJECTED");
      return;
    }
    if (action === "resume") {
      if (!(await this.scheduler.resume())) {
        const active =
          this.scheduler.activeJobId &&
          this.queue.getJob?.(this.scheduler.activeJobId);
        throw new Error(
          this.queue?._lastResumeError ||
            active?._lastResumeError ||
            "BATCH_RESUME_REJECTED",
        );
      }
      return;
    }
    if (action === "stop") return this.scheduler.stop();
    if (
      action === "manual-pause" ||
      action === "manual-resume" ||
      action === "manual-stop"
    ) {
      const manualId = job?.manualRegenActive && job.manualRegenJobId;
      const manualJob = manualId && this.queue.getJob?.(manualId);
      if (!manualJob) throw new Error("BATCH_MANUAL_JOB_UNAVAILABLE");
      if (action === "manual-stop")
        return this.queue.stopJob(manualId, {
          stopOrigin: "user",
          stopSource: "BATCH_LIST_MANUAL_STOP",
        });
      if (action === "manual-pause") {
        this.queue.pauseJob(manualId, "manual", "BATCH_LIST_MANUAL_PAUSE");
        if (this.queue.getJob?.(manualId)?.state !== "paused")
          throw new Error("BATCH_PAUSE_REJECTED");
        return;
      }
      if (!(await this.queue.resumeJob(manualId)))
        throw new Error(
          this.queue?._lastResumeError || "BATCH_RESUME_REJECTED",
        );
      return;
    }
    if (action === "job-pause" && job) {
      const id = job.executionJobId || job.id;
      const active = id === this.scheduler.activeJobId;
      const paused = active
        ? await this.scheduler.pause()
        : (this.queue.pauseJob(id, "manual", "BATCH_LIST_JOB_PAUSE"),
          this.queue.getJob?.(id)?.state === "paused");
      if (!paused) throw new Error("BATCH_PAUSE_REJECTED");
      this._renderControls();
      return;
    }
    if (action === "job-resume" && job) {
      const id = job.executionJobId || job.id;
      const ok = await (id === this.scheduler.activeJobId
        ? this.scheduler.resume()
        : this.queue.resumeJob(id));
      if (!ok)
        this._error(this.queue?._lastResumeError || "BATCH_RESUME_REJECTED");
      this._renderControls();
      return;
    }
    if (action === "job-stop" && job)
      return (job.executionJobId || job.id) === this.scheduler.activeJobId
        ? this.scheduler.stop()
        : this.queue.stopJob(job.executionJobId || job.id, {
            stopOrigin: "user",
            stopSource: "BATCH_LIST_JOB_STOP",
          });
    if (action === "next" && batch) {
      if (!["running", "paused"].includes(this.scheduler.state))
        return this._runConfirmed(batch.batchId);
      const first = this.batches.find((entry) => entry.status === "queued");
      if (first?.batchId === batch.batchId) return;
      const firstOrder = Number.isFinite(first?.order)
        ? first.order
        : Date.now();
      await this.store.update(
        batch.userId,
        batch.projectId,
        batch.batchId,
        batch.revision,
        (record) => ({ ...record, order: firstOrder - 1 }),
      );
      await this.reload();
      return;
    }
    if (action === "retry" && batch) {
      if (batch.status !== "needs_review" || batch.jobId)
        throw new Error("BATCH_RETRY_UNSAFE");
      window.GenBatchAdmission._validate(batch, { allowPending: true });
      await window.GenBatchAdmission._validateItems(batch);
      await this.store.update(
        batch.userId,
        batch.projectId,
        batch.batchId,
        batch.revision,
        (record) => ({ ...record, status: "queued", admissionError: null }),
      );
      await this.reload();
      return;
    }
    if (action === "recover-batch" && batch) return this._recoverBatch(batch);
    if (action === "reconcile-batch" && batch)
      return this._reconcileBatch(batch);
    if (action === "delete" && batch) return this._deleteBatch(batch);
    if (action === "delete-direct" && directJob)
      return this._deleteDirectJob(directJob);
    if (action === "edit-direct-batch" && directJob) {
      const imported = await this._adoptDirectJob(directJob);
      this._editBatch(imported);
      return;
    }
    if (action === "recover-direct" && directJob) {
      const imported = await this._adoptDirectJob(directJob);
      return this._recoverBatch(imported);
    }
    if (action === "edit-batch" && batch) return this._editBatch(batch);
    if (action === "clear-queued") return this._clearQueued();
    if (action === "clear-all") return this._clearAll();
    if (action === "clear-history") {
      return this._clearHistory();
    }
    if (action === "edit-item")
      return this._editItem(card, batch, button.closest(".gen-batch-item"));
    if (action === "delete-direct-item" && directJob) {
      const row = button.closest(".gen-batch-item");
      const imported = await this._adoptDirectJob(directJob, { reload: false });
      const index = imported.runtimeItemIds.indexOf(row?.dataset.itemId);
      if (index < 0) throw new Error("BATCH_ITEM_NOT_FOUND");
      return this._deleteItem(imported, {
        dataset: { itemIndex: String(index) },
      });
    }
    if (
      (action === "edit-direct-item" || action === "regen-direct-item") &&
      directJob
    ) {
      const row = button.closest(".gen-batch-item");
      const item = directJob.items?.find(
        (entry) => entry.id === row?.dataset.itemId,
      );
      if (!item || this._isItemProcessing(item))
        throw new Error("BATCH_ITEM_IN_FLIGHT");
      const imported = await this._adoptDirectJob(directJob);
      const index = imported.runtimeItemIds.indexOf(item.id);
      if (index < 0) throw new Error("BATCH_ITEM_NOT_FOUND");
      const target = { dataset: { itemIndex: String(index) } };
      return action === "edit-direct-item"
        ? this._editItem(null, imported, target)
        : this._regenItem(imported, target);
    }
    if (action === "download-item") {
      const row = button.closest(".gen-batch-item");
      const index = Number(row?.dataset.itemIndex);
      return this._downloadItem(downloadBatch, index, card.dataset.cardKey);
    }
    if (action === "regen-batch") return this._rerunSavedBatch(batch);
    if (action === "regen-direct" && directJob)
      return this._rerunSavedBatch(await this._adoptDirectJob(directJob));
    if (
      action === "download-batch" ||
      action === "regen-failed" ||
      action === "regen-direct"
    ) {
      const actionBatch =
        action === "download-batch" || action === "regen-direct"
          ? downloadBatch
          : batch;
      if (
        !actionBatch ||
        (action !== "download-batch" &&
          (!actionBatch.jobId || !actionBatch.trackerSessionId))
      )
        throw new Error("BATCH_ACTION_SOURCE_UNAVAILABLE");
      const downloadSelection =
        action === "download-batch"
          ? await this._askDownloadOptions(actionBatch)
          : null;
      if (action === "download-batch" && !downloadSelection) return;
      let regenConfirmation = null;
      if (action === "regen-direct" || action === "regen-failed") {
        const preview = await window.MessageBridge?.sendToContentScript?.(
          "genBatchBatchAction",
          {
            projectId: actionBatch.projectId,
            jobId: actionBatch.jobId,
            sessionId: actionBatch.trackerSessionId,
            batchAction:
              action === "regen-failed"
                ? "regen-failed-preview"
                : "regen-all-preview",
          },
        );
        if (
          preview?.success !== true ||
          !Number.isInteger(preview.promptCount) ||
          preview.promptCount < 1
        )
          throw new Error(preview?.error || "BATCH_REGEN_SOURCE_UNAVAILABLE");
        const route = this._currentRunRoute();
        const owner = this._scope();
        if (
          !["web", "api", "auto"].includes(route) ||
          (action === "regen-direct" &&
            (!directJob || directJob.projectId !== owner?.projectId)) ||
          (action === "regen-direct" &&
            directJob?.userId != null &&
            String(directJob.userId) !== String(owner?.userId)) ||
          (action !== "regen-direct" &&
            String(owner?.userId) !== String(batch.userId)) ||
          owner?.projectId !== actionBatch.projectId
        )
          throw new Error("BATCH_SCOPE_CHANGED");
        const details = {
          batches: 1,
          prompts: preview.promptCount,
          route,
          userId: owner.userId,
          projectId: owner.projectId,
          mediaType: /^video$/i.test(
            batch?.settingsSnapshot?.genType ||
              directJob?.items?.[0]?.genType ||
              "",
          )
            ? "video"
            : "image",
        };
        if (!(await this._confirmRun(details, "regenBatch"))) return;
        if (
          String(this._scope()?.userId) !== String(owner.userId) ||
          this._scope()?.projectId !== owner.projectId
        )
          throw new Error("BATCH_SCOPE_CHANGED");
        regenConfirmation = {
          settingsOverrides: { image: {}, video: {} },
          executionMode: route,
          effectiveExecutionMode: details.effectiveRoute || route,
          promptCount: preview.promptCount,
        };
      }
      const itemSources =
        action === "download-batch"
          ? actionBatch.items
              .map((_, index) => this._downloadSource(actionBatch, index))
              .filter(Boolean)
          : null;
      const request = {
        projectId: actionBatch.projectId,
        jobId: actionBatch.jobId,
        sessionId: actionBatch.trackerSessionId,
        batchAction:
          action === "download-batch"
            ? "download"
            : action === "regen-failed"
              ? "regen-failed"
              : "regen-all",
        downloadSelection,
        itemSources,
        regenConfirmation,
      };
      if (action === "download-batch")
        return this._requestDownload(
          "genBatchBatchAction",
          request,
          actionBatch,
          card.dataset.cardKey,
          itemSources,
        );
      const response = await window.MessageBridge?.sendToContentScript?.(
        "genBatchBatchAction",
        request,
      );
      if (response?.success !== true)
        throw new Error(response?.error || "BATCH_ACTION_SOURCE_UNAVAILABLE");
      return;
    }
    if (action === "delete-item")
      return this._deleteItem(batch, button.closest(".gen-batch-item"));
    if (action === "regen-item")
      return this._regenItem(batch, button.closest(".gen-batch-item"));
  }
  async _queueUserTake(batch, indexes, options = {}) {
    const owner = this._scope();
    if (
      String(owner?.userId) !== String(batch.userId) ||
      owner?.projectId !== batch.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    const route = options.effectiveRoute || this._currentRunRoute();
    if (!["web", "api", "auto"].includes(route))
      throw new Error("BATCH_ROUTE_UNAVAILABLE");
    const details = {
      batches: 1,
      prompts: indexes.length,
      route,
      userId: owner.userId,
      projectId: owner.projectId,
      mediaType: batch.settingsSnapshot.genType === "Video" ? "video" : "image",
    };
    if (
      options.skipConfirmation !== true &&
      !(await this._confirmRun(details, "regenBatch"))
    )
      return;
    const assertScope = () => {
      const current = this._scope();
      if (
        String(current?.userId) !== String(owner.userId) ||
        current?.projectId !== owner.projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
    };
    assertScope();
    const latest = await this.store.get(
      owner.userId,
      owner.projectId,
      batch.batchId,
    );
    if (
      !latest ||
      this._batchEditorSource(latest) !== this._batchEditorSource(batch)
    )
      throw new Error("BATCH_REVISION_CONFLICT");
    if (options.singleItem) {
      const index = indexes[0],
        rootId = latest.runtimeItemIds?.[index];
      const item =
        this._runtimeItemByRoot(
          this._jobForBatchItem(latest, index)?.items,
          rootId,
        ) ||
        latest.terminalItems?.[index] ||
        latest.items[index];
      if (this._isItemProcessing(item)) throw new Error("BATCH_ITEM_IN_FLIGHT");
    }
    const draft = structuredClone(latest);
    draft.batchId = crypto.randomUUID();
    draft.items = indexes
      .map((index) => structuredClone(latest.items[index]))
      .filter((item) => item && !item.hidden);
    if (!draft.items.length) throw new Error("BATCH_RERUN_UNAVAILABLE");
    if (Array.isArray(draft.frameFileIds))
      draft.frameFileIds = indexes.map((index) => draft.frameFileIds[index]);
    if (indexes.length === 1 && draft.settingsSnapshot.chain) {
      delete draft.settingsSnapshot.chain;
      const runtime = this._runtimeItemByRoot(
        this._jobForBatchItem(batch, indexes[0])?.items,
        batch.runtimeItemIds?.[indexes[0]],
      );
      if (runtime?.refFileIds?.length && !draft.items[0].refOverride) {
        draft.items[0].refKeys = [...runtime.refFileIds];
      }
      if (draft.refMode === "frames") {
        const pair =
          (Array.isArray(draft.frameFileIds)
            ? draft.frameFileIds[0]
            : draft.frameFileIds) || {};
        const frame1 = pair.frame1 || runtime?.refFileIds?.[0];
        if (!frame1) throw new Error("BATCH_FRAMES_MISSING");
        draft.frameFileIds = { frame1, frame2: pair.frame2 || "" };
        draft.items[0].refKeys = [frame1, pair.frame2].filter(Boolean);
        draft.items[0].refOverride = true;
      }
      for (const id of draft.items[0].refKeys || [])
        if (!draft.refPool.some((ref) => ref.refKey === id)) {
          const ref = this._directRef(runtime, id);
          draft.refPool.push({ ...ref, refKey: id });
        }
    }
    draft.flowExecutionMode =
      route === "auto" && details.effectiveRoute === "web" ? "web" : route;
    draft.settingsSnapshot.flowExecutionMode = draft.flowExecutionMode;
    const assets = [];
    for (const ref of draft.refPool || [])
      if (ref.refKey?.startsWith("upload_")) {
        const asset = await this.store.getAsset(
          owner.userId,
          owner.projectId,
          latest.batchId,
          ref.refKey,
        );
        if (!asset?.file) throw new Error("BATCH_ASSET_MISSING");
        assets.push(asset);
      }
    assertScope();
    const saved = await this.store.add(
      owner.userId,
      owner.projectId,
      draft,
      assets,
      window.GenBatchDraftBuilder.getQueueLimit(),
    );
    await options.onPersisted?.({ batchId: saved.batchId });
    assertScope();
    const result = this.scheduler.queueExplicit(
      saved.batchId,
      options.mcpOrigin ? "BATCH_LIST_RERUN_MCP" : "BATCH_LIST_RERUN_BATCH",
      options.mcpJobId || null,
    );
    options.onAdmission?.({ ok: true, queued: true, batchId: saved.batchId });
    try {
      await this.reload();
    } catch (error) {
      console.warn("[GenBatchList] queued take refresh deferred", {
        batchId: saved.batchId,
        code: error?.code || error?.name,
      });
    }
    return { ...result, started: false, batchId: saved.batchId };
  }
  async _rerunSavedBatch(batch, options = {}) {
    return this._queueUserTake(
      batch,
      batch.items
        .map((item, index) => (!item.hidden ? index : null))
        .filter((index) => index !== null),
      options,
    );
  }
  _confirmRun(details, titleKey = "runAll") {
    if (this._runConfirmResolve) return Promise.resolve(false);
    const sheet = this.overlay.querySelector(".gen-batch-run-confirm");
    const runLabel = window.I18n?.t?.("common.run") || "common.run";
    sheet.querySelector("#genBatchRunTitle").textContent =
      titleKey === "regenConfirm" ? runLabel : this._t(titleKey);
    const values =
      typeof details === "string"
        ? { prompts: "\u2014", batches: "\u2014", route: "web" }
        : details;
    sheet.querySelector(".gen-batch-confirm-prompts-label").textContent =
      this._t("totalPrompts");
    sheet.querySelector(".gen-batch-confirm-prompts").textContent = String(
      values.prompts,
    );
    sheet.querySelector(".gen-batch-confirm-batches-label").textContent =
      this._t("batchCount");
    sheet.querySelector(".gen-batch-confirm-batches").textContent = String(
      values.batches,
    );
    sheet.querySelector(".gen-batch-confirm-logo").innerHTML =
      window.ProviderBrandIcons?.get?.("flow") || "";
    this._setRunProviderMode(
      values.route === "api" ? "API" : values.route === "web" ? "Web" : "",
    );
    const media = sheet.querySelector(".gen-batch-confirm-media");
    media.textContent =
      values.mediaType === "video"
        ? window.I18n?.t?.("workflow.genTypeVideo") || "Video"
        : window.I18n?.t?.("workflow.genTypeImage") || "Image";
    media.classList.toggle("hidden", !values.mediaType);
    sheet.querySelector(".confirm-run-cancel").textContent = this._t("cancel");
    sheet.querySelector(".confirm-run-submit span").textContent = runLabel;
    const submit = sheet.querySelector(".confirm-run-submit");
    submit.disabled = typeof details !== "string";
    submit.setAttribute("aria-disabled", String(submit.disabled));
    const badge = sheet.querySelector(".gen-batch-confirm-badge");
    badge.className =
      "confirm-run-provider-badge is-checking gen-batch-confirm-badge";
    badge.querySelector(".badge-text").textContent =
      window.I18n?.t?.("gen.providerStatusChecking") || "Checking...";
    sheet
      .querySelector(".gen-batch-confirm-tabs-warning")
      .classList.add("hidden");
    sheet.classList.remove("hidden");
    this._runConfirmFocus = document.activeElement;
    const decision = new Promise((resolve) => {
      this._runConfirmResolve = resolve;
    });
    sheet.querySelector(".confirm-run-cancel").focus();
    if (typeof details !== "string") {
      const epoch = ++this._runConfirmCheckEpoch;
      this._runConfirmProjectRepairAttempted = false;
      this._runConfirmActivationPromise = Promise.resolve().then(() =>
        chrome.runtime.sendMessage({
          action: "ensureFlowTabActive",
          focusWindow: true,
        }),
      );
      const check = () => this._checkRunProvider(values, epoch);
      check();
      this._runConfirmStatusTimer = setInterval(check, 3e3);
    }
    return decision;
  }
  _setRunProviderMode(mode) {
    const label = this.overlay.querySelector(
      ".gen-batch-confirm-provider-name",
    );
    const name = window.ProviderMeta?.getSync?.("flow")?.name;
    label.textContent =
      typeof name === "string" && name.trim()
        ? name + (mode ? ` \xB7 ${mode}` : "")
        : "";
  }
  async _checkRunProvider(details, epoch) {
    if (this._runConfirmCheckInFlight === epoch) return;
    this._runConfirmCheckInFlight = epoch;
    const sheet = this.overlay.querySelector(".gen-batch-run-confirm");
    const current = () =>
      this._runConfirmResolve &&
      epoch === this._runConfirmCheckEpoch &&
      !sheet.classList.contains("hidden") &&
      String(this._scope()?.userId) === String(details.userId) &&
      String(this._scope()?.projectId) === String(details.projectId);
    const setStatus = (ready, message) => {
      if (!current()) return;
      const badge = sheet.querySelector(".gen-batch-confirm-badge");
      badge.className = `confirm-run-provider-badge ${ready ? "is-ready" : "is-warning"} gen-batch-confirm-badge`;
      badge.innerHTML = `<svg class="badge-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">${ready ? '<polyline points="20 6 9 17 4 12"/>' : '<path d="M12 3 2 21h20L12 3zM12 9v5m0 3h.01"/>'}</svg><span class="badge-text">${this._escape(message)}</span>`;
      const submit = sheet.querySelector(".confirm-run-submit");
      submit.disabled = !ready;
      submit.setAttribute("aria-disabled", String(!ready));
    };
    try {
      const activation = await Promise.resolve(
        this._runConfirmActivationPromise,
      ).catch(() => null);
      if (!current()) return;
      const activationMatches =
        activation?.ok === true &&
        !!activation.projectId &&
        String(activation.projectId) === String(details.projectId);
      window.MessageBridge?.renderFlowProjectTabsAdvisory?.(
        sheet.querySelector(".gen-batch-confirm-tabs-warning"),
      )?.catch?.(() => {});
      const shouldRepair =
        activationMatches && this._runConfirmProjectRepairAttempted !== true;
      this._runConfirmProjectRepairAttempted = true;
      const response = await chrome.runtime.sendMessage({
        action: "checkFlowTabOpen",
        passive: !shouldRepair,
        readOnly: !shouldRepair,
        readinessScope: "project",
        targetTabId: activationMatches ? activation.tabId : void 0,
      });
      if (!current()) return;
      if (
        (response?.ready ?? response?.isOpen) !== true ||
        (!activationMatches &&
          String(response?.projectId || "") !== String(details.projectId)) ||
        (response?.projectId &&
          String(response.projectId) !== String(details.projectId))
      ) {
        setStatus(
          false,
          response?.isOpen === false
            ? window.I18n?.t?.("workflow.providerNoTab") || "Tab not opened"
            : response?.error === "CONTENT_REVISION_MISMATCH" ||
                response?.contentReady === false
              ? window.I18n?.t?.("app.refreshFlowTab") ||
                "Refresh the Google Flow tab and try again."
              : window.I18n?.t?.("workflow.projectNotReady") ||
                "Flow project not ready",
        );
        return;
      }
      const apiIntended =
        window.FlowApiAdapter?.isApiModeIntended?.({
          executionMode: details.route,
        }) === true;
      if (details.route === "api" && !apiIntended) {
        this._setRunProviderMode("API");
        setStatus(
          false,
          window.I18n?.t?.("gen.bridgeNotReady") || "Bridge not ready",
        );
        return;
      }
      if (
        apiIntended &&
        (details.route === "api" || details.route === "auto")
      ) {
        const api = await window.FlowApiSessionCoordinator?.check?.({
          surface: "gen",
          mediaType: details.mediaType || "image",
          force: details._apiChecked !== true,
          passive: true,
        });
        details._apiChecked = true;
        if (!current()) return;
        if (api?.ready === true) {
          details.effectiveRoute = details.route;
          this._setRunProviderMode("API");
          setStatus(
            true,
            window.I18n?.t?.("gen.providerStatusReady") || "Ready",
          );
          return;
        }
        if (details.route === "api") {
          this._setRunProviderMode("API");
          setStatus(
            false,
            window.I18n?.t?.("gen.bridgeNotReady") || "Bridge not ready",
          );
          return;
        }
      }
      details.effectiveRoute = "web";
      this._setRunProviderMode("Web");
      setStatus(true, window.I18n?.t?.("gen.providerStatusReady") || "Ready");
    } catch (error) {
      setStatus(
        false,
        window.I18n?.t?.("workflow.projectNotReady") ||
          "Flow project not ready",
      );
    } finally {
      if (this._runConfirmCheckInFlight === epoch)
        this._runConfirmCheckInFlight = null;
    }
  }
  _finishRunConfirm(accepted, afterFeedback = false) {
    const submit = this.overlay.querySelector(
      ".gen-batch-run-confirm .confirm-run-submit",
    );
    if (accepted && !afterFeedback && submit.disabled) return;
    if (accepted && !afterFeedback) {
      if (this._runConfirmFeedbackTimer) return;
      if (this._runConfirmStatusTimer)
        clearInterval(this._runConfirmStatusTimer);
      this._runConfirmStatusTimer = null;
      this._runConfirmCheckEpoch++;
      submit.classList.add("is-click-confirmed");
      this._runConfirmFeedbackTimer = setTimeout(
        () => {
          this._runConfirmFeedbackTimer = null;
          this._finishRunConfirm(true, true);
        },
        window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches
          ? 300
          : 500,
      );
      return;
    }
    clearTimeout(this._runConfirmFeedbackTimer);
    this._runConfirmFeedbackTimer = null;
    submit.classList.remove("is-click-confirmed");
    if (this._runConfirmStatusTimer) clearInterval(this._runConfirmStatusTimer);
    this._runConfirmStatusTimer = null;
    this._runConfirmActivationPromise = null;
    this._runConfirmCheckEpoch++;
    this.overlay
      .querySelector(".gen-batch-run-confirm")
      .classList.add("hidden");
    const resolve = this._runConfirmResolve;
    this._runConfirmResolve = null;
    resolve?.(accepted);
    if (this._runConfirmFocus?.isConnected) this._runConfirmFocus.focus();
  }
  async _runConfirmed(onlyBatchId = null, onlyItemIndex = null) {
    if (this._busy) return;
    if (["running", "paused"].includes(this.scheduler.state))
      throw new Error("BATCH_ALREADY_RUNNING");
    const owner = this._scope();
    if (!owner) throw new Error("BATCH_SCOPE_REQUIRED");
    const drafts = (
      await this.store.list(owner.userId, owner.projectId)
    ).filter(
      (batch) =>
        batch.status === "queued" &&
        (!onlyBatchId || batch.batchId === onlyBatchId),
    );
    if (!drafts.length) return;
    if (
      onlyItemIndex !== null &&
      (drafts.length !== 1 ||
        !Number.isInteger(onlyItemIndex) ||
        onlyItemIndex < 0 ||
        !drafts[0].items[onlyItemIndex] ||
        drafts[0].items[onlyItemIndex].hidden ||
        drafts[0].settingsSnapshot?.chain ||
        drafts[0].resumeItemIndexes)
    )
      throw new Error("BATCH_ITEM_RUN_UNAVAILABLE");
    const route = this._currentRunRoute();
    if (!["web", "api", "auto"].includes(route))
      throw new Error("BATCH_ROUTE_UNAVAILABLE");
    const prompts =
      onlyItemIndex !== null
        ? 1
        : drafts.reduce(
            (sum, batch) =>
              sum +
              (batch.resumeItemIndexes?.length ??
                batch.items.filter((item) => !item.hidden).length),
            0,
          );
    const sequential = window.GenTab?.runMode === "sequential";
    const mediaTypes = new Set(
      drafts.map((batch) =>
        String(batch.settingsSnapshot?.genType || "").toLowerCase(),
      ),
    );
    const runDetails = {
      batches: drafts.length,
      prompts,
      route,
      userId: owner.userId,
      projectId: owner.projectId,
      mediaType: mediaTypes.size === 1 ? [...mediaTypes][0] : null,
    };
    const confirmed = await this._confirmRun(
      runDetails,
      onlyItemIndex !== null ? "runItem" : onlyBatchId ? "runBatch" : "runAll",
    );
    if (!confirmed) return;
    const currentOwner = this._scope();
    if (
      String(currentOwner?.userId) !== String(owner.userId) ||
      currentOwner?.projectId !== owner.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    if (["running", "paused"].includes(this.scheduler.state))
      throw new Error("BATCH_ALREADY_RUNNING");
    this._busy = true;
    try {
      let targetBatchId = onlyBatchId;
      if (onlyItemIndex !== null && drafts[0].items.length > 1) {
        const latest = await this.store.get(
          owner.userId,
          owner.projectId,
          drafts[0].batchId,
        );
        if (
          !latest ||
          latest.revision !== drafts[0].revision ||
          latest.status !== "queued"
        )
          throw new Error("BATCH_REVISION_CONFLICT");
        const extracted = await this.store.extractItem(
          owner.userId,
          owner.projectId,
          latest.batchId,
          latest.revision,
          onlyItemIndex,
        );
        targetBatchId = extracted.batchId;
        drafts[0] = extracted;
      }
      for (const draft of drafts) {
        const current = await this.store.get(
          owner.userId,
          owner.projectId,
          draft.batchId,
        );
        if (!current || current.status !== "queued")
          throw new Error("BATCH_STATE_CHANGED");
        const admittedRoute =
          route === "auto" && runDetails.effectiveRoute === "web"
            ? "web"
            : route;
        await this.store.update(
          owner.userId,
          owner.projectId,
          current.batchId,
          current.revision,
          (record) => ({
            ...record,
            flowExecutionMode: admittedRoute,
            settingsSnapshot: {
              ...record.settingsSnapshot,
              flowExecutionMode: admittedRoute,
            },
            sequentialMode: !!record.settingsSnapshot?.chain || sequential,
          }),
        );
      }
      await this.reload();
      const afterUpdate = this._scope();
      if (
        String(afterUpdate?.userId) !== String(owner.userId) ||
        afterUpdate?.projectId !== owner.projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      return targetBatchId
        ? this.scheduler.runOne(
            targetBatchId,
            onlyItemIndex !== null
              ? "BATCH_LIST_RUN_PROMPT"
              : "BATCH_LIST_RUN_BATCH",
          )
        : this.scheduler.runAll();
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  _rename(card, batch) {
    if (this._renameInput) return;
    const label = card.querySelector(".gen-batch-name");
    const input = document.createElement("input");
    input.className = "gen-batch-rename";
    input.value = batch.displayName;
    label.replaceWith(input);
    this._renameInput = input;
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      this._renameInput = null;
      const restored = document.createElement("span");
      restored.className = "gen-batch-name";
      restored.dataset.action = "rename";
      restored.tabIndex = 0;
      restored.textContent = batch.displayName;
      input.replaceWith(restored);
      if (
        save &&
        input.value.trim() &&
        input.value.trim() !== batch.displayName
      ) {
        try {
          await this.store.rename(
            batch.userId,
            batch.projectId,
            batch.batchId,
            batch.revision,
            input.value,
          );
        } catch (error) {
          this._error(error);
        }
      }
      await this.reload();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }
  async _purgeDeletedBatch(batch, owner) {
    const candidate = this.queue.getJob?.(batch.jobId);
    const job = candidate?.id === batch.jobId ? candidate : null;
    if (
      this.store.isPossiblyLive(batch) ||
      (job &&
        !["completed", "failed", "stopped"].includes(job.state || job.status))
    )
      return;
    try {
      for (const itemId of batch.jobId ? batch.runtimeItemIds || [] : []) {
        if (
          itemId &&
          this.queue.removeTrackerItem(owner.projectId, batch.jobId, itemId) !==
            true
        )
          throw new Error("BATCH_RUNTIME_HISTORY_CLEAR_FAILED");
      }
      for (const segment of this._historySegments(batch)) {
        const response = await chrome.runtime.sendMessage({
          action: "ft:removeHistoryJob",
          projectId: batch.projectId,
          sessionId: segment.trackerSessionId,
          jobId: segment.jobId,
          allSessions: batch.batchId.startsWith("history:"),
          queueRemovalConfirmed: true,
        });
        if (!response?.ok)
          throw new Error(response?.error || "BATCH_HISTORY_REMOVE_FAILED");
      }
      await this.store.deleteBatch(
        batch.userId,
        batch.projectId,
        batch.batchId,
        ["queued", "needs_review", "completed", "stopped", "failed"],
      );
    } catch (error) {
      console.warn(
        "[GenBatch] Deleted list entry; execution data retained:",
        error?.message,
      );
    }
  }
  async _deleteBatch(batch) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (
        !(await this._confirmDelete(
          this._t(
            "deleteConfirm",
            `Delete ${batch.items.length} prompts in this batch?`,
            { count: batch.items.length },
          ),
          this._t("delete"),
          batch.displayName || "",
        ))
      )
        return;
      const owner = this._scope();
      if (
        !owner ||
        String(owner.userId) !== String(batch.userId) ||
        owner.projectId !== batch.projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      await this.store.hideBatchListEntry(
        owner.userId,
        owner.projectId,
        batch.batchId,
      );
      const current = await this.store.get(
        owner.userId,
        owner.projectId,
        batch.batchId,
      );
      if (current) await this._purgeDeletedBatch(current, owner);
      await this.reload();
      this._notify(this._t("batchDeleted", "Batch deleted"), "success");
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  async _adoptMcpJobs(jobs, owner, batches) {
    if (!owner || !this.store?.adoptHistory) return false;
    const knownImportedJobs = new Set(
      (batches || [])
        .filter(
          (batch) =>
            typeof batch.batchId === "string" &&
            batch.batchId.startsWith("history:"),
        )
        .map((batch) =>
          batch.batchId.slice(batch.batchId.lastIndexOf(":") + 1),
        ),
    );
    const known = new Set(
      (batches || []).flatMap((batch) =>
        [
          { jobId: batch.jobId, trackerSessionId: batch.trackerSessionId },
          ...(batch.executionSegments || []),
        ]
          .filter((segment) => segment.jobId && segment.trackerSessionId)
          .map((segment) => `${segment.trackerSessionId}|${segment.jobId}`),
      ),
    );
    let changed = false;
    for (const job of jobs || []) {
      if (
        job?.owner !== "mcp" ||
        !job.mcpJobId ||
        !job.sessionId ||
        job.sourceBatchId ||
        job.regenDisplay?.jobId ||
        job.projectId !== owner.projectId ||
        String(job.mcpUserId || "") !== String(owner.userId) ||
        !["completed", "failed", "stopped"].includes(job.status) ||
        knownImportedJobs.has(job.id) ||
        known.has(`${job.sessionId}|${job.id}`)
      )
        continue;
      try {
        await this._adoptDirectJob(job, { reload: false });
        knownImportedJobs.add(job.id);
        known.add(`${job.sessionId}|${job.id}`);
        changed = true;
      } catch (error) {
        console.warn(
          "[GenBatchListModal] MCP history adoption skipped:",
          error?.message || error,
        );
      }
    }
    return changed;
  }
  async syncMcpHistory() {
    const owner = this._scope();
    if (!owner) return false;
    const batches = await this.store.list(owner.userId, owner.projectId);
    let cachedJobs = [];
    try {
      const response = await chrome.runtime.sendMessage({
        action: "ft:getProjectHistory",
        projectId: owner.projectId,
      });
      if (response?.ok && response.record?.data?.projectId === owner.projectId)
        cachedJobs = (response.record.data.sessions || []).flatMap((session) =>
          (session.jobs || []).map((job) => ({
            ...job,
            projectId: job.projectId || owner.projectId,
            sessionId: job.sessionId || session.id,
          })),
        );
    } catch (_) {}
    const changed = await this._adoptMcpJobs(
      [...cachedJobs, ...(this.queue?.getSnapshot?.()?.jobs || [])],
      owner,
      batches,
    );
    if (changed && this._open) {
      await this.reload();
      this._hydrateListRefThumbs(++this._listRefHydrationEpoch).catch(() => {});
    }
    return changed;
  }
  async _adoptDirectJob(job, { reload = true } = {}) {
    const owner = this._scope();
    if (
      !owner ||
      job?.projectId !== owner.projectId ||
      !job.id ||
      !job.sessionId ||
      (job.owner === "mcp" &&
        (!job.mcpJobId ||
          String(job.mcpUserId || "") !== String(owner.userId))) ||
      !Array.isArray(job.items) ||
      !job.items.length
    )
      throw new Error("BATCH_HISTORY_IMPORT_UNAVAILABLE");
    const settingsOf = (item) => {
      const source = item.settings || {};
      const rawType = item.genType || source.genType;
      return {
        model: item.model || source.model,
        ratio: item.ratio || source.ratio,
        genType: /^video$/i.test(rawType || "")
          ? "Video"
          : /^image$/i.test(rawType || "")
            ? "Image"
            : null,
        quantity: Number(item.quantity ?? source.quantity ?? 1),
        isFrames: source.isFrames === true,
        videoInputType: source.videoInputType || null,
        flowVideoDuration: source.flowVideoDuration || null,
        flowVideoResolution: source.flowVideoResolution || null,
        flowThinkingLevel: source.flowThinkingLevel || null,
        voice: source.voice || null,
        character: source.character || null,
      };
    };
    const first = settingsOf(job.items[0]);
    if (
      !first.model ||
      !first.ratio ||
      !first.genType ||
      !Number.isSafeInteger(first.quantity) ||
      first.quantity < 1 ||
      job.items.some((item) => !item.id || !String(item.prompt || "").trim())
    )
      throw new Error("BATCH_HISTORY_SETTINGS_UNAVAILABLE");
    const refs = new Map();
    const items = job.items.map((item) => {
      const settings = settingsOf(item);
      const refKeys = [...new Set((item.refFileIds || []).filter(Boolean))];
      for (const key of refKeys)
        if (!refs.has(key)) {
          const stored = item.refThumbnails?.[key];
          const identity = stored && typeof stored === "object" ? stored : {};
          const thumbnail =
            typeof stored === "string"
              ? stored
              : identity.thumbnail ||
                identity.thumbnail_url ||
                identity.source_thumbnail ||
                "";
          refs.set(key, {
            refKey: key,
            name: item.refFileNames?.[key] || key,
            fileName: identity.file_name || item.refFileNames?.[key] || key,
            mediaUuid: identity.media_uuid || identity.mediaUuid || null,
            mediaType: identity.type || "image",
            thumbnail: /^https?:\/\//.test(thumbnail) ? thumbnail : null,
          });
        }
      return {
        prompt: item.prompt,
        refKeys,
        refOverride: true,
        settingsOverride: Object.fromEntries(
          [
            "model",
            "ratio",
            "quantity",
            "flowVideoDuration",
            "flowVideoResolution",
            "flowThinkingLevel",
          ]
            .filter(
              (key) => settings[key] != null && settings[key] !== first[key],
            )
            .map((key) => [key, settings[key]]),
        ),
        mentionData: item.mentionData || null,
      };
    });
    const terminalItems = job.items.map((item) => ({
      id: item.id,
      state: item.state || "CANCELLED",
      genMode: ["api", "web"].includes(item.genMode) ? item.genMode : null,
      results: (item.results || [])
        .map((result) => ({
          tileId: result.tileId || null,
          mediaId: result.mediaId || null,
          mediaUuid: result.mediaUuid || null,
          fileName: result.fileName || null,
          video: result.video === true,
        }))
        .filter(
          (result) =>
            result.tileId ||
            result.mediaId ||
            result.mediaUuid ||
            result.fileName,
        ),
    }));
    const record = {
      jobId: job.id,
      trackerSessionId: job.sessionId,
      displayName:
        job.owner === "mcp"
          ? `MCP \xB7 ${job.mcpBatchName || job.label || job.mcpJobId}`
          : job.label || this._t("direct", "Run now"),
      status: job.status,
      createdAt: job.startedAt || Date.now(),
      settingsSnapshot: { ...first, chain: job.chain || null },
      flowExecutionMode: job.modeType === "api" ? "api" : "web",
      sequentialMode: job.effectiveRunMode === "sequential",
      refMode: refs.size ? "all" : "none",
      refPool: [...refs.values()],
      refImagesPerPrompt: refs.size
        ? Math.max(1, ...items.map((item) => item.refKeys.length))
        : null,
      autoDownload: job.items[0].autoDownload === true,
      items,
      runtimeItemIds: job.items.map((item) => item.id),
      terminalItems,
    };
    const saved = await this.store.adoptHistory(
      owner.userId,
      owner.projectId,
      record,
    );
    if (reload) await this.reload();
    return saved;
  }
  async _deleteDirectJob(job) {
    if (this._busy) return;
    const owner = this._scope();
    if (
      !owner ||
      job.projectId !== owner.projectId ||
      !job.id ||
      !job.sessionId
    )
      throw new Error("BATCH_HISTORY_REMOVE_UNAVAILABLE");
    this._busy = true;
    try {
      if (
        !(await this._confirmDelete(
          this._t(
            "deleteConfirm",
            `Delete ${job.items?.length || 0} prompts in this batch?`,
            { count: job.items?.length || 0 },
          ),
          this._t("delete"),
          job.label || "",
        ))
      )
        return;
      const currentOwner = this._scope();
      if (
        !currentOwner ||
        String(currentOwner.userId) !== String(owner.userId) ||
        currentOwner.projectId !== owner.projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      const adopted = await this._persistDirectDeletion(job, owner);
      await this._purgeDeletedBatch(adopted, owner);
      await this.reload();
      this._notify(this._t("batchDeleted", "Batch deleted"), "success");
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  async _clearQueued() {
    if (this._busy) return;
    const drafts = this.batches.filter((batch) => batch.status === "queued");
    if (!drafts.length) return;
    const prompts = drafts.reduce((sum, batch) => sum + batch.items.length, 0);
    this._busy = true;
    this._renderControls();
    try {
      if (
        !(await this._confirmDelete(
          this._t(
            "clearQueuedConfirm",
            `Delete ${drafts.length} queued batches (${prompts} prompts) in this project?`,
            { batches: drafts.length, prompts },
          ),
          this._t("clearQueued"),
        ))
      )
        return;
      const owner = this._scope();
      if (
        !owner ||
        drafts.some(
          (batch) =>
            String(batch.userId) !== String(owner.userId) ||
            batch.projectId !== owner.projectId,
        )
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      await this.store.deleteQueuedForProject(owner.userId, owner.projectId);
      await this.reload();
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  _directJobsForDeletion() {
    const owner = this._scope();
    if (!owner) return [];
    const known = new Set(
      this.batches
        .flatMap((batch) => [
          batch.jobId,
          ...(batch.executionSegments || []).map((segment) => segment.jobId),
        ])
        .filter(Boolean),
    );
    const jobs = new Map();
    for (const job of [
      ...(this.cachedJobs || []),
      ...(this._liveJobs?.() || []),
    ]) {
      if (
        !job.id ||
        !job.sessionId ||
        job.projectId !== owner.projectId ||
        job.sourceBatchId ||
        job.regenDisplay?.jobId ||
        known.has(job.id) ||
        !(
          job.owner === "prompts" ||
          (job.owner === "mcp" &&
            job.mcpJobId &&
            String(job.mcpUserId) === String(owner.userId))
        )
      )
        continue;
      jobs.set(job.id, job);
    }
    return [...jobs.values()];
  }
  async _persistDirectDeletion(job, owner) {
    if (
      job.projectId !== owner.projectId ||
      !job.sessionId ||
      !(
        job.owner === "prompts" ||
        (job.owner === "mcp" &&
          job.mcpJobId &&
          String(job.mcpUserId) === String(owner.userId))
      )
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    const adopted = await this.store.adoptHistory(
      owner.userId,
      owner.projectId,
      {
        jobId: job.id,
        trackerSessionId: job.sessionId,
        status: job.status,
        createdAt: job.startedAt,
        displayName: job.label,
        items: (job.items || []).map(() => ({ prompt: "" })),
        runtimeItemIds: (job.items || []).map((item) => item.id || null),
        hiddenFromBatchList: true,
      },
    );
    await this.store.hideBatchListEntry(
      owner.userId,
      owner.projectId,
      adopted.batchId,
    );
    return adopted;
  }
  async _clearAll() {
    if (this._busy) return;
    const batches = this.batches.filter((batch) => !batch.hiddenFromBatchList);
    const directJobs = this._directJobsForDeletion();
    const count = batches.length + directJobs.length;
    const promptCount =
      batches.reduce((sum, batch) => sum + batch.items.length, 0) +
      directJobs.reduce((sum, job) => sum + (job.items?.length || 0), 0);
    this._busy = true;
    this._renderControls();
    try {
      if (
        !(await this._confirmDelete(
          this._t(
            "clearAllConfirm",
            `Delete ${count} batches (${promptCount} prompts) and their tracker tiles in this project?`,
            { batches: count, prompts: promptCount },
          ),
          this._t("clearAll"),
        ))
      )
        return;
      const owner = this._scope();
      if (
        !owner ||
        batches.some(
          (batch) =>
            String(batch.userId) !== String(owner.userId) ||
            batch.projectId !== owner.projectId,
        )
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      for (const batch of batches) {
        await this.store.hideBatchListEntry(
          owner.userId,
          owner.projectId,
          batch.batchId,
        );
        const current = await this.store.get(
          owner.userId,
          owner.projectId,
          batch.batchId,
        );
        if (current) await this._purgeDeletedBatch(current, owner);
      }
      for (const job of directJobs) {
        const adopted = await this._persistDirectDeletion(job, owner);
        await this._purgeDeletedBatch(adopted, owner);
      }
      await this.reload();
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  async _clearHistory() {
    if (this._busy || this.queue?.isRunning || this.queue?.activeJobCount > 0)
      throw new Error("BATCH_HISTORY_REQUIRES_IDLE");
    const owner = this._scope();
    if (!owner) throw new Error("BATCH_SCOPE_REQUIRED");
    const terminal = this.batches.filter((batch) =>
      ["completed", "stopped", "failed"].includes(batch.status),
    );
    this._busy = true;
    try {
      if (
        !(await this._confirmDelete(
          this._t(
            "clearHistoryConfirm",
            `Clear tracker history, including direct Gen tiles, and ${terminal.length} terminal batches in this project?`,
            { batches: terminal.length },
          ),
          this._t("clearHistory"),
        ))
      )
        return;
      const currentOwner = this._scope();
      if (
        !currentOwner ||
        String(currentOwner.userId) !== String(owner.userId) ||
        currentOwner.projectId !== owner.projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      if (this.queue?.isRunning || this.queue?.activeJobCount > 0)
        throw new Error("BATCH_HISTORY_REQUIRES_IDLE");
      const ok = await this.queue.clearTrackerHistory(owner.projectId, {
        force: false,
      });
      if (!ok) throw new Error("BATCH_RUNTIME_HISTORY_CLEAR_FAILED");
      const response = await chrome.runtime.sendMessage({
        action: "ft:clearProjectHistory",
        projectId: owner.projectId,
      });
      if (!response?.ok)
        throw new Error(
          response?.error || "BATCH_TRACKER_HISTORY_CLEAR_FAILED",
        );
      for (const batch of terminal)
        await this.store.deleteBatch(
          owner.userId,
          owner.projectId,
          batch.batchId,
          ["completed", "stopped", "failed"],
        );
      await this.reload();
    } finally {
      this._busy = false;
      this._renderControls();
    }
  }
  async _deleteItem(batch, row) {
    if (!batch || !row || this._busy) return;
    const index = Number(row.dataset.itemIndex);
    const itemId = row.dataset.itemId || batch.runtimeItemIds?.[index] || null;
    if (!batch.items[index]) throw new Error("BATCH_ITEM_NOT_FOUND");
    this._busy = true;
    try {
      if (
        !(await this._confirmDelete(
          this._t("deleteItemConfirm", "Delete this prompt from Batch list?"),
        ))
      )
        return;
      const owner = this._scope();
      if (
        !owner ||
        String(owner.userId) !== String(batch.userId) ||
        owner.projectId !== batch.projectId
      )
        throw new Error("BATCH_SCOPE_CHANGED");
      const latest = await this.store.get(
        owner.userId,
        owner.projectId,
        batch.batchId,
      );
      if (!latest) throw new Error("BATCH_ITEM_NOT_FOUND");
      if (latest.status !== "queued") {
        await this.store.hideBatchListEntry(
          owner.userId,
          owner.projectId,
          latest.batchId,
          index,
        );
        const current = await this.store.get(
          owner.userId,
          owner.projectId,
          latest.batchId,
        );
        if (current?.hiddenFromBatchList)
          await this._purgeDeletedBatch(current, owner);
        await this.reload();
        this._notify(this._t("promptDeleted", "Prompt deleted"), "success");
        return;
      }
      if (latest.revision !== batch.revision)
        throw new Error("BATCH_REVISION_CONFLICT");
      const visibleCount = latest.items.filter((item) => !item.hidden).length;
      if (visibleCount === 1) {
        await this.store.deleteBatch(
          owner.userId,
          owner.projectId,
          latest.batchId,
          ["queued", "completed", "failed", "stopped"],
        );
      } else if (latest.status === "queued") {
        await this.store.updateDraft(
          owner.userId,
          owner.projectId,
          latest.batchId,
          latest.revision,
          (value) => {
            value.items.splice(index, 1);
            window.GenBatchDraftBuilder.remapDraft(value);
            return value;
          },
        );
      }
      await this.reload();
      this._notify(this._t("promptDeleted", "Prompt deleted"), "success");
    } finally {
      this._busy = false;
    }
  }
  async _regenItem(batch, row, options = {}) {
    if (!batch || !row) return;
    const index = Number(row.dataset.itemIndex);
    const item = batch.items[index];
    if (
      !window.ModelRegistry?.findModel?.(
        "flow",
        item.settingsOverride?.model || batch.settingsSnapshot?.model,
      )
    )
      throw new Error("BATCH_MODEL_UNAVAILABLE");
    const sourceJob = this._jobForBatchItem(batch, index);
    const job = this.queue.getJob?.(sourceJob?.id || batch.jobId);
    const itemId = batch.runtimeItemIds?.[index];
    const source = job?.items?.find((entry) => entry.id === itemId);
    const cached = !source && this._cachedRegenSource(batch, index);
    const evidence = source || batch.terminalItems?.[index] || item;
    if (this._isItemProcessing(evidence))
      throw new Error("BATCH_ITEM_IN_FLIGHT");
    if (
      (item.refKeys || []).some((key) => key.startsWith("upload_")) ||
      (!cached && (!source || job.chain || !source.isTerminal))
    )
      return this._queueUserTake(batch, [index], {
        ...options,
        singleItem: true,
      });
    const route = this._currentRunRoute();
    if (!["web", "api", "auto"].includes(route))
      throw new Error("BATCH_ROUTE_UNAVAILABLE");
    const owner = this._scope();
    if (
      !owner ||
      String(owner.userId) !== String(batch.userId) ||
      owner.projectId !== batch.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    const runDetails = {
      batches: 1,
      prompts: 1,
      route,
      userId: owner.userId,
      projectId: owner.projectId,
      mediaType:
        (item.settingsOverride?.genType || batch.settingsSnapshot?.genType) ===
        "Video"
          ? "video"
          : "image",
    };
    if (
      options.skipConfirmation !== true &&
      !(await this._confirmRun(runDetails, "regenConfirm"))
    )
      return;
    if (
      String(this._scope()?.userId) !== String(owner.userId) ||
      this._scope()?.projectId !== owner.projectId
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    const effectiveRoute =
      options.effectiveRoute || runDetails.effectiveRoute || route;
    if (
      job?.state === "paused" &&
      this.scheduler.activeBatchId === batch.batchId &&
      this.scheduler.state === "running"
    )
      await this.scheduler.pause();
    const cachedPayload = cached && {
      regenOf: cached.item._regenSlotRoot || cached.item.regenOf || null,
      state: cached.item.state,
      projectId: batch.projectId,
      settings: cached.settings,
      prompt: item.prompt,
      refFileIds: item.refKeys || cached.item.refFileIds || [],
      refFileNames: cached.item.refFileNames || {},
      refThumbnails: cached.item.refThumbnails || {},
      refImageMode: cached.item.refImageMode || batch.refMode,
      mentionData: item.mentionData || cached.item.mentionData || null,
      mentionCandidates:
        item.mentionData?.refImages || cached.item.mentionData?.refImages || [],
      autoDownload: cached.item.autoDownload === true,
      downloadResolution: cached.item.downloadResolution || null,
      videoDownloadResolution: cached.item.videoDownloadResolution || null,
      taskName: cached.item.taskName || null,
      sequentialMode: cached.job.effectiveRunMode === "sequential",
      promptIndex: Number.isFinite(cached.item.promptIndex)
        ? cached.item.promptIndex
        : index,
    };
    const displayJob = job || cached?.job;
    const accepted = this.queue.requestTrackerRegenItem({
      jobId: sourceJob?.id || cached?.job?.id || batch.jobId,
      itemId: source ? itemId : cached.item.id,
      prompt: item.prompt,
      settingsOverride: {
        ...(item.settingsOverride || {}),
        flowExecutionMode: effectiveRoute,
      },
      payload: {
        ...cachedPayload,
        batchPromptIndex: index,
        regenDisplay: {
          jobId: displayJob.id,
          sessionId:
            displayJob.sessionId ||
            (batch.executionSegments || []).find(
              (entry) => entry.jobId === displayJob.id,
            )?.trackerSessionId ||
            batch.trackerSessionId ||
            "",
          label: displayJob.label || batch.displayName,
          owner: displayJob.owner,
          startedAt: displayJob.startedAt || null,
        },
      },
      onAdmission: (ack) => {
        options.onAdmission?.(ack);
        if (!ack?.ok) this._error(ack?.error || "BATCH_REGEN_REJECTED");
      },
      ...(typeof options.onSettled === "function"
        ? { onSettled: options.onSettled }
        : {}),
      ...(typeof options.onFinalSettled === "function"
        ? { onFinalSettled: options.onFinalSettled }
        : {}),
    });
    if (!accepted)
      throw new Error(this.queue._lastRegenError || "BATCH_REGEN_REJECTED");
    return accepted;
  }
  _openEditor(editor, title, fields) {
    this._editor = editor;
    this._editorFocus = document.activeElement;
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    sheet.querySelector(".gen-batch-editor-title").textContent = title;
    this._setEditorBrand("flow");
    sheet.querySelector(".gen-batch-editor-fields").innerHTML = fields;
    if (editor.kind === "item" || editor.kind === "direct-item")
      this._bindEditorPromptResizer(
        sheet.querySelector('textarea[name="prompt"]'),
      );
    sheet.querySelector("footer .gen-batch-editor-cancel").textContent =
      this._t("cancel", "Cancel");
    sheet.querySelector("footer .gen-batch-editor-save").innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h14l2 2v14H4zM7 4v6h10V4M8 20v-7h8v7"/></svg><span>${this._escape(this._t("save", "Save"))}</span>`;
    sheet.classList.remove("hidden");
    this._observeVideoPreviews(sheet);
    if (editor.kind === "item" || editor.kind === "direct-item") {
      sheet
        .querySelector('[name="model"]')
        ?.addEventListener("change", () => this._refreshVideoItemOptions());
      for (const name of ["frame1", "frame2"])
        sheet
          .querySelector(`[name="${name}"]`)
          ?.addEventListener("change", (event) =>
            this._updateFramePreview(event.target),
          );
      for (const name of ["frame1", "frame2"])
        this._updateFramePreview(sheet.querySelector(`[name="${name}"]`));
      if (
        editor.kind === "item" &&
        sheet.querySelector(".gen-batch-item-frame-slots")
      ) {
        editor.activeFrameName = sheet.querySelector('[name="frame1"]')
          ? "frame1"
          : "frame2";
        sheet
          .querySelector(
            `.frame-slot[data-frame-name="${editor.activeFrameName}"]`,
          )
          ?.classList.add("is-active");
        const panel = sheet.querySelector(".gen-batch-item-frame-source-panel");
        panel.addEventListener("dragstart", (event) => {
          const source = event.target.closest(
            ".gen-batch-item-frame-list .frame-source-thumb",
          );
          if (!source) return;
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(
            "application/x-toby-frame-id",
            source.dataset.refKey,
          );
          source.classList.add("dragging");
        });
        panel.addEventListener("dragend", (event) =>
          event.target
            .closest(".frame-source-thumb")
            ?.classList.remove("dragging"),
        );
        panel.addEventListener("dragover", (event) => {
          const slot = event.target.closest(
            ".gen-batch-item-frame-slots .frame-slot",
          );
          if (
            !slot ||
            !event.dataTransfer.types.includes("application/x-toby-frame-id")
          )
            return;
          event.preventDefault();
          slot.classList.add("frame-drag-over");
        });
        panel.addEventListener("dragleave", (event) =>
          event.target
            .closest(".gen-batch-item-frame-slots .frame-slot")
            ?.classList.remove("frame-drag-over"),
        );
        panel.addEventListener("drop", (event) => {
          const slot = event.target.closest(
            ".gen-batch-item-frame-slots .frame-slot",
          );
          if (!slot) return;
          event.preventDefault();
          slot.classList.remove("frame-drag-over");
          const key = event.dataTransfer.getData("application/x-toby-frame-id");
          if (
            !key ||
            ![
              ...panel.querySelectorAll(
                ".gen-batch-item-frame-list [data-ref-key]",
              ),
            ].some((source) => source.dataset.refKey === key)
          )
            return;
          editor.activeFrameName = slot.dataset.frameName;
          this._selectEditorFrameSource({ dataset: { refKey: key } });
        });
      }
    } else if (editor.kind === "batch") {
      for (const [kind, Picker] of [
        ["voice", window.VoicePicker],
        ["character", window.CharacterPicker],
      ]) {
        if (!Picker) continue;
        const input = sheet.querySelector(`[name="${kind}"]`);
        const picker = new Picker({
          triggerEl: sheet.querySelector(
            `[data-batch-${kind}] .voice-picker-trigger`,
          ),
          thumbEl: sheet.querySelector(`#genBatch${kind}Thumb`),
          labelEl: sheet.querySelector(`#genBatch${kind}Label`),
          hiddenSelectEl: input,
          getSelected: () => input?.value || "",
          onChange: () => this._refreshBatchPreview(),
          ...(kind === "voice" ? { providerSlug: "flow" } : {}),
        });
        picker.init();
        editor[`${kind}Picker`] = picker;
      }
      sheet
        .querySelector(".gen-batch-editor-fields")
        ?.addEventListener("change", (event) => {
          if (event.target?.name === "genType")
            this._refreshBatchModelOptions();
          if (
            event.target?.name === "genType" ||
            event.target?.name === "model"
          )
            this._refreshBatchVideoOptions();
          if (event.target?.name === "refMode") {
            const batch = this.batches.find(
              (entry) => entry.batchId === this._editor?.batchId,
            );
            if (batch)
              this._renderBatchRefCards(
                batch,
                this._batchEditorRefs(sheet, batch),
              );
          }
          this._refreshBatchPreview();
        });
      sheet
        .querySelector(".gen-batch-editor-fields")
        ?.addEventListener("input", () => this._refreshBatchPreview());
      this._refreshBatchVideoOptions();
      this._refreshBatchPreview();
    }
    (editor.kind === "batch"
      ? sheet.querySelector(".gen-batch-type-toggle button:not(:disabled)")
      : sheet.querySelector("textarea, select, input")
    )?.focus();
  }
  _bindEditorPromptResizer(textarea) {
    if (
      !textarea ||
      textarea.nextElementSibling?.classList.contains("gen-prompt-resizer")
    )
      return;
    const handle = document.createElement("div");
    handle.className = "gen-prompt-resizer";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "horizontal");
    handle.setAttribute("aria-label", "Resize prompt");
    handle.setAttribute("aria-valuemin", "180");
    handle.setAttribute("aria-valuemax", "600");
    const height = () => textarea.getBoundingClientRect().height || 180;
    handle.setAttribute("aria-valuenow", String(Math.round(height())));
    let drag = null;
    const resize = (value) => {
      const next = Math.round(Math.max(180, Math.min(600, value)));
      textarea.style.height = `${next}px`;
      handle.setAttribute("aria-valuenow", String(next));
    };
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || textarea.disabled || textarea.readOnly) return;
      event.preventDefault();
      event.stopPropagation();
      drag = { id: event.pointerId, y: event.clientY, height: height() };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      resize(drag.height + event.clientY - drag.y);
    });
    const end = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      drag = null;
      if (handle.hasPointerCapture(event.pointerId))
        handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", () => {
      drag = null;
    });
    handle.addEventListener("keydown", (event) => {
      if (
        textarea.disabled ||
        textarea.readOnly ||
        !["ArrowUp", "ArrowDown"].includes(event.key)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      resize(height() + (event.key === "ArrowDown" ? 20 : -20));
    });
    textarea.after(handle);
  }
  _bindItemMentionMenu(batch) {
    const editor = this._editor;
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const textarea = sheet.querySelector('textarea[name="prompt"]');
    if (!textarea || !window.MentionMenu || editor?.kind !== "item") return;
    const MM = window.MentionMenu;
    const isFrames = batch.refMode === "frames";
    const refEntries = () => {
      const seen = new Set();
      return [...(batch.refPool || []), ...(editor.pickerRefs || [])].flatMap(
        (ref) => {
          const name = String(ref.name || "").trim();
          if (!name || seen.has(name.toLowerCase())) return [];
          seen.add(name.toLowerCase());
          return [
            {
              label: name,
              value: name,
              fileId: ref.refKey,
              mediaType: ref.mediaType === "video" ? "video" : "image",
              thumbnail: this._refThumbUrl(batch, ref) || null,
              iconSvg: MM.ICONS.ref,
            },
          ];
        },
      );
    };
    const model = () =>
      window.ModelRegistry?.findModel?.(
        "flow",
        sheet.querySelector('[name="model"]')?.value ||
          batch.settingsSnapshot?.model,
      );
    const media =
      batch.settingsSnapshot?.genType === "Video" ? "video" : "image";
    const caps = () =>
      window.ImagePickerModal?.resolveCapsMulti?.({
        provider: "flow",
        mode: media,
        isFrames,
        modelValue:
          sheet.querySelector('[name="model"]')?.value ||
          batch.settingsSnapshot?.model,
        duration:
          media === "video"
            ? sheet.querySelector('[name="duration"]')?.value ||
              batch.settingsSnapshot?.flowVideoDuration
            : void 0,
      });
    const budget = ({ text, cursor, atPos }) => {
      const resolved = caps();
      if (!resolved || !Number.isInteger(resolved.image)) return null;
      return MM.flowRefBudget({
        text,
        cursor,
        atPos,
        items: refEntries(),
        caps: resolved,
        isFrames,
        characterSelection:
          window.CharacterRegistry?.selectionValue?.(
            batch.settingsSnapshot?.character,
          ) || "",
        multiPrompt: false,
      });
    };
    editor.getMentionRefBudget = budget;
    editor.getMentionCaps = caps;
    editor.mentionMenu = new MM(textarea, {
      getRefBudget: budget,
      getTabs: () => {
        const tabs = [];
        if (
          batch.refMode === "mention" &&
          !isFrames &&
          refEntries().length &&
          budget({
            text: textarea.value,
            cursor: textarea.selectionStart,
            atPos: -1,
          })
        )
          tabs.push({
            id: "ref",
            label: window.I18n?.t?.("mention.tabRef") || "Ref image",
            iconSvg: MM.ICONS.ref,
            getItems: refEntries,
            buildInsert: (item) => MM.wrapName(item.value, ""),
          });
        if (
          !isFrames &&
          media === "video" &&
          model()?.config?.supports_voice === true
        )
          tabs.push(MM.voiceTab());
        if (!isFrames && model()?.config?.supports_character === true)
          tabs.push(MM.charTab());
        return tabs;
      },
      defaultTabId: () =>
        batch.refMode === "mention" && refEntries().length ? "ref" : "char",
    });
    if (window.MentionChips)
      editor.mentionChips = new window.MentionChips(textarea, {
        getRefBudgets: () => {
          const value = budget({
            text: textarea.value,
            cursor: textarea.value.length,
            atPos: -1,
          });
          return value ? [{ ...value, promptIndex: 0 }] : [];
        },
        includeComponents: () => !isFrames,
        includeRefs: () => batch.refMode === "mention",
        resolveRef: (name) => {
          const ref = refEntries().find(
            (entry) => entry.value.toLowerCase() === String(name).toLowerCase(),
          );
          return { found: !!ref, thumbnail: ref?.thumbnail || null };
        },
      });
    const refresh = () => {
      editor.mentionMenu?.hide();
      editor.mentionChips?.render();
    };
    for (const name of ["model", "duration"])
      sheet
        .querySelector(`[name="${name}"]`)
        ?.addEventListener("change", refresh);
  }
  _updateFramePreview(select) {
    if (!select) return;
    const preview = select
      .closest(".gen-batch-frame-field")
      ?.querySelector(".gen-batch-frame-preview");
    if (!preview) return;
    const batch = this.batches.find(
      (entry) => entry.batchId === this._editor?.batchId,
    );
    const key = select.value;
    const ref =
      this._editor?.pickerRefs?.find((entry) => entry.refKey === key) ||
      batch?.refPool?.find((entry) => entry.refKey === key);
    const url = this._refThumbUrl(batch, ref || { refKey: key });
    preview.replaceChildren();
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      img.dataset.refRepairKey = `${batch?.batchId || ""}|${key}`;
      preview.appendChild(img);
    } else if (key) preview.textContent = "\u25A7";
    else if (preview.closest(".gen-batch-item-frame-slots"))
      preview.innerHTML = `<svg class="frame-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg><span class="frame-dropzone-text">${this._escape(window.I18n?.t?.("gen.addFrame") || "Add")}</span>`;
  }
  _refreshVideoItemOptions() {
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const modelValue = sheet.querySelector('[name="model"]')?.value;
    const model = window.ModelRegistry?.findModel?.("flow", modelValue);
    const thinkingSelect = sheet.querySelector('[name="flowThinkingLevel"]');
    window.ModelRegistry?.renderThinkingLevelSelect?.(
      thinkingSelect,
      thinkingSelect?.closest("label"),
      modelValue,
      thinkingSelect?.value,
      sheet.querySelector('[name="genType"]')?.value === "Image",
    );
    const sets = [
      [
        "duration",
        window.ProviderConfigManager?.safeGetVideoDurationsSync?.(
          "flow",
          model?.config?.duration_tier || "default",
        ) || [],
      ],
      [
        "videoResolution",
        window.ModelRegistry?.getGenerationResolutionConfig?.(
          "flow",
          modelValue,
        )?.options || [],
      ],
    ];
    for (const [name, entries] of sets) {
      const select = sheet.querySelector(`[name="${name}"]`);
      if (!select) continue;
      const previous = select.value;
      const values = entries
        .map((entry) =>
          typeof entry === "string" ? { value: entry, label: entry } : entry,
        )
        .filter((entry) => entry?.value);
      select.replaceChildren(
        ...values.map((entry) => {
          const option = document.createElement("option");
          option.value = entry.value;
          option.textContent = entry.label || entry.value;
          return option;
        }),
      );
      select.value = values.some((entry) => entry.value === previous)
        ? previous
        : values[0]?.value || "";
      select.disabled = !values.length;
      select.closest("label").hidden = !values.length;
    }
  }
  _mapVideoChainDraftFrames(draft, originalBatch) {
    if (typeof window.GenTab?._videoChainFramePairs !== "function")
      throw new Error("BATCH_CHAIN_REF_MAPPER_UNAVAILABLE");
    const original = Array.isArray(originalBatch?.frameFileIds)
      ? originalBatch.frameFileIds[0]
      : originalBatch?.frameFileIds;
    const current = Array.isArray(draft.frameFileIds)
      ? draft.frameFileIds[0]
      : draft.frameFileIds;
    const start = current?.frame1 || original?.frame1 || "";
    const refIds = (draft.refPool || [])
      .filter((ref) => ref.mediaType !== "video")
      .map((ref) => ref.refKey);
    const mode = draft.settingsSnapshot?.chainRefMode || "none";
    const priorIds = (originalBatch?.refPool || [])
      .filter((ref) => ref.mediaType !== "video")
      .map((ref) => ref.refKey);
    const sameRefs = JSON.stringify(refIds) === JSON.stringify(priorIds);
    const currentPairs = Array.isArray(draft.frameFileIds)
      ? draft.frameFileIds
      : [draft.frameFileIds || {}];
    const keepExplicit = mode === "none" || sameRefs;
    const selected = new Set(refIds);
    const framePairs = draft.items.map((_, index) => ({
      frame1: index === 0 ? start : "",
      frame2:
        keepExplicit && selected.has(currentPairs[index]?.frame2)
          ? currentPairs[index].frame2
          : "",
    }));
    draft.frameFileIds = window.GenTab._videoChainFramePairs(
      framePairs,
      refIds,
      mode,
      draft.items.length,
    );
  }
  _refreshBatchPreview() {
    if (this._editor?.kind !== "batch") return;
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    this._refreshBatchFieldVisibility(sheet);
    const output = sheet.querySelector(".gen-batch-preview");
    const batch = this.batches.find(
      (entry) => entry.batchId === this._editor.batchId,
    );
    if (!output || !batch) return;
    this._renderBatchFramePairs(batch);
    try {
      const draft = structuredClone(batch);
      const keptIndexes = batch.items
        .map((_, index) => index)
        .filter(
          (index) =>
            !batch.items[index]?.hidden &&
            !this._editor.deletedIndexes?.has(index),
        );
      draft.items = keptIndexes.map((index) => draft.items[index]);
      if (Array.isArray(draft.frameFileIds))
        draft.frameFileIds = keptIndexes.map(
          (index) => draft.frameFileIds[index],
        );
      if (draft.refMode === "frames" && Array.isArray(this._editor.framePairs))
        draft.frameFileIds = keptIndexes.map((index) => ({
          ...this._editor.framePairs[index],
        }));
      if (
        draft.refMode === "frames" &&
        draft.settingsSnapshot?.chain?.kind === "video_last_frame" &&
        keptIndexes[0] > 0 &&
        Array.isArray(draft.frameFileIds)
      )
        draft.frameFileIds[0] = {
          frame1:
            this._editor.framePairs?.[0]?.frame1 ||
            batch.frameFileIds?.[0]?.frame1 ||
            "",
          frame2: draft.frameFileIds[0]?.frame2 || "",
        };
      draft.settingsSnapshot.genType =
        sheet.querySelector('[name="genType"]').value;
      draft.settingsSnapshot.model =
        sheet.querySelector('[name="model"]').value;
      draft.settingsSnapshot.ratio =
        sheet.querySelector('[name="ratio"]').value;
      draft.settingsSnapshot.flowThinkingLevel =
        draft.settingsSnapshot.genType === "Image"
          ? window.ModelRegistry?.getThinkingLevelValue?.(
              "flow",
              draft.settingsSnapshot.model,
              sheet.querySelector('[name="flowThinkingLevel"]')?.value,
            )
          : null;
      draft.settingsSnapshot.flowVideoDuration =
        draft.settingsSnapshot.genType === "Video"
          ? sheet.querySelector('[name="flowVideoDuration"]')?.value || null
          : null;
      draft.settingsSnapshot.flowVideoResolution =
        draft.settingsSnapshot.genType === "Video"
          ? sheet.querySelector('[name="flowVideoResolution"]')?.value || null
          : null;
      for (const item of draft.items) {
        for (const key of ["genType", "model", "ratio"])
          delete item.settingsOverride?.[key];
        if (
          draft.settingsSnapshot.genType !== batch.settingsSnapshot.genType ||
          draft.settingsSnapshot.model !== batch.settingsSnapshot.model
        )
          for (const key of [
            "isFrames",
            "videoInputType",
            "flowVideoDuration",
            "flowVideoResolution",
            "flowThinkingLevel",
          ])
            delete item.settingsOverride?.[key];
      }
      draft.refMode = sheet.querySelector('[name="refMode"]').value;
      draft.refImagesPerPrompt = window.RefImageAssignment.count(
        sheet.querySelector('[name="refCount"]').value,
      );
      draft.refPool =
        draft.refMode === "none" && batch.refMode !== "none"
          ? []
          : this._batchEditorRefs(sheet, batch);
      if (
        draft.refMode === "frames" &&
        draft.settingsSnapshot?.genType === "Video"
      ) {
        const first = Array.isArray(draft.frameFileIds)
          ? draft.frameFileIds[0]
          : draft.frameFileIds;
        if (sheet.querySelector('[name="chain"]')?.checked) {
          if (
            !batch.settingsSnapshot?.chain &&
            draft.settingsSnapshot.chainRefMode === "none"
          )
            draft.settingsSnapshot.chainRefMode = "all";
          this._mapVideoChainDraftFrames(draft, batch);
        } else if (draft.settingsSnapshot?.chain?.kind === "video_last_frame")
          draft.frameFileIds = draft.items.map(() => ({
            frame1: first?.frame1 || "",
            frame2: first?.frame2 || "",
          }));
      }
      window.GenBatchDraftBuilder.remapDraft(draft);
      const video = draft.settingsSnapshot?.genType === "Video";
      const mediaIcon = video
        ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
        : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
      output.innerHTML = draft.items
        .map((item, index) => {
          const previewNodes = this._resultEvidenceNodes(
            this._batchItemResultsForEditor(batch, keptIndexes[index]),
          );
          const previews = previewNodes.join("");
          const framePair = Array.isArray(draft.frameFileIds)
            ? draft.frameFileIds[index]
            : draft.frameFileIds;
          const slots =
            draft.refMode === "frames" && video
              ? [
                  {
                    key: framePair?.frame1 || "",
                    label: this._t("frame1", "Frame 1"),
                  },
                  {
                    key: framePair?.frame2 || "",
                    label: this._t("frame2", "Frame 2"),
                  },
                ]
              : (item.refKeys || []).map((key) => ({ key, label: "" }));
          const refs = slots
            .map(({ key, label }) => {
              const ref = draft.refPool.find((entry) => entry.refKey === key);
              const url = this._refThumbUrl(batch, ref || { refKey: key });
              const name = /^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(ref?.name || "")
                ? "Reference"
                : ref?.name || "Reference";
              const thumb = url
                ? `<img class="gen-batch-ref-mini" src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch.batchId}|${key}`)}" alt="${this._escape(name)}" title="${this._escape(name)}">`
                : `<span class="gen-batch-ref-mini gen-batch-ref-placeholder" title="${this._escape(name)}" aria-label="${this._escape(name)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg></span>`;
              return label
                ? `<span class="gen-batch-preview-frame-slot"><small>${this._escape(label)}</small>${thumb}</span>`
                : thumb;
            })
            .join("");
          return `<div class="gen-batch-item gen-batch-preview-item${previewNodes.length > 1 ? " has-multiple-results" : ""}">
          <span class="gen-batch-item-thumb">${previews || `<span class="gen-batch-result-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mediaIcon}</svg></span>`}</span>
          <span class="gen-batch-item-main"><span class="gen-batch-prompt" title="${this._escape(item.prompt)}">${this._escape(item.prompt)}</span>${refs ? `<span class="gen-batch-ref-thumbs">${refs}</span>` : ""}</span>
          <span class="gen-batch-preview-index">#${index + 1}</span>
          <button type="button" class="gen-batch-preview-delete" data-action="batch-editor-delete-item" data-original-index="${keptIndexes[index]}" aria-label="${this._escape(this._t("delete", "Delete"))}" data-tooltip="${this._escape(this._t("delete", "Delete"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg></button>
        </div>`;
        })
        .join("");
    } catch (error) {
      output.textContent = error?.message || "BATCH_PREVIEW_UNAVAILABLE";
    }
  }
  async _deleteBatchEditorPrompt(button) {
    const editor = this._editor;
    if (editor?.kind !== "batch" || this._busy) return;
    const batch = this.batches.find(
      (entry) => entry.batchId === editor.batchId,
    );
    const index = Number(button.dataset.originalIndex);
    if (
      !batch?.items?.[index] ||
      batch.items[index].hidden ||
      editor.deletedIndexes?.has(index)
    )
      return;
    if (batch.status !== "queued") {
      const itemId =
        batch.runtimeItemIds?.[index] || batch.terminalItems?.[index]?.id || "";
      await this._deleteItem(batch, {
        dataset: { itemIndex: String(index), itemId },
      });
      if (this._editor !== editor) return;
      const updated = this.batches.find(
        (entry) => entry.batchId === batch.batchId,
      );
      if (!updated || updated.hiddenFromBatchList) return this._closeEditor();
      this._refreshBatchPreview();
      if (updated.revision !== editor.revision) {
        editor.revision = updated.revision;
        this._refreshBatchPreview();
      }
      return;
    }
    if (batch.status !== "queued") return;
    if (batch.items.length - (editor.deletedIndexes?.size || 0) <= 1)
      return this._notify(
        this._t("deleteLastPrompt", "A batch needs at least one prompt"),
        "warning",
      );
    if (
      !(await this._confirmDelete(
        this._t(
          "removePromptDraftConfirm",
          "Remove this prompt? Save to apply the change.",
        ),
      ))
    )
      return;
    if (
      this._editor !== editor ||
      this._busy ||
      this._scope()?.projectId !== batch.projectId ||
      String(this._scope()?.userId || "") !== String(batch.userId || "")
    )
      return;
    editor.deletedIndexes || (editor.deletedIndexes = new Set());
    editor.deletedIndexes.add(index);
    this._refreshBatchPreview();
  }
  _refreshBatchFieldVisibility(sheet) {
    const mode = sheet.querySelector('[name="refMode"]')?.value;
    const hasRefs = mode !== "none";
    const chainEnabled =
      sheet.querySelector('[name="chain"]')?.checked === true;
    const video = sheet.querySelector('[name="genType"]')?.value === "Video";
    const downloading =
      sheet.querySelector('[name="download"]')?.checked === true;
    const model = window.ModelRegistry?.findModel?.(
      "flow",
      sheet.querySelector('[name="model"]')?.value,
    );
    const componentsAllowed = mode !== "frames";
    for (const [selector, visible] of [
      ["[data-batch-ref-count]", mode === "sequential"],
      [
        "[data-batch-ref-pool]",
        mode === "frames" ||
          (hasRefs && !!sheet.querySelector(".gen-batch-ref-row")),
      ],
      ["[data-batch-add-refs]", true],
      ["[data-batch-chain-policy]", chainEnabled && !video],
      ["[data-batch-download-details]", downloading],
      ["[data-batch-image-resolution]", downloading && !video],
      ["[data-batch-video-resolution]", downloading && video],
      ["[data-batch-video-mode]", video],
      [
        "[data-batch-voice]",
        componentsAllowed && video && model?.config?.supports_voice === true,
      ],
      [
        "[data-batch-character]",
        componentsAllowed && model?.config?.supports_character === true,
      ],
    ]) {
      const node = sheet.querySelector(selector);
      if (node) node.hidden = !visible;
    }
  }
  _closeEditor() {
    this._editor?.mentionMenu?.destroy();
    this._editor?.mentionChips?.destroy();
    for (const key of this._editor?.pickerPendingKeys || [])
      window.pendingUploadFiles?.delete(key);
    this._editor?.voicePicker?.destroy();
    this._editor?.characterPicker?.destroy();
    this._dragRefRow = null;
    this.overlay.querySelector(".gen-batch-editor").classList.add("hidden");
    this._editor = null;
    if (this._editorFocus?.isConnected) this._editorFocus.focus();
  }
  _setEditorBrand(provider) {
    const brand = this.overlay.querySelector(".gen-batch-editor-brand");
    if (!brand) return;
    brand.dataset.provider = provider;
    brand.innerHTML = window.ProviderBrandIcons?.get?.(provider) || "";
  }
  _batchEditorRefs(sheet, batch) {
    const refs = this._editor?.pickerRefs || batch.refPool || [];
    const byKey = new Map(refs.map((ref) => [ref.refKey, ref]));
    return [...sheet.querySelectorAll(".gen-batch-ref-row[data-ref-key]")]
      .map((row) => byKey.get(row.dataset.refKey))
      .filter(Boolean);
  }
  _frameSourceActionsHtml(kind = this._editor?.kind) {
    const startIcon =
      '<svg class="frame-slot-icon" viewBox="0 0 11 10" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5L8.9 7.5C9.46005 7.5 9.74008 7.5 9.95399 7.39101C10.1422 7.29513 10.2951 7.14215 10.391 6.95399C10.5 6.74008 10.5 6.46005 10.5 5.9V4.1C10.5 3.53995 10.5 3.25992 10.391 3.04601C10.2951 2.85785 10.1422 2.70487 9.95399 2.60899C9.74008 2.5 9.46005 2.5 8.9 2.5L5 2.5M3 7.5H2.1C1.53995 7.5 1.25992 7.5 1.04601 7.39101C0.857847 7.29513 0.704867 7.14215 0.608994 6.95399C0.5 6.74008 0.5 6.46005 0.5 5.9V4.1C0.5 3.53995 0.5 3.25992 0.608994 3.04601C0.704867 2.85785 0.857847 2.70487 1.04601 2.60899C1.25992 2.5 1.53995 2.5 2.1 2.5H3M3 0.5L3 9.5M1.75 9.5L4.25 9.5M1.75 0.499996L4.25 0.5"></path></svg>';
    const buttons = [
      ["start", "gen.frameAssignStart", "Assign to Start", ""],
      [
        "pairs",
        "gen.frameAssignPairs",
        "Assign pairs",
        '<rect x="2.5" y="5" width="7" height="6" rx="1"/><rect x="14.5" y="5" width="7" height="6" rx="1"/><path d="M9.5 8h5"/><rect x="2.5" y="15" width="7" height="6" rx="1"/><rect x="14.5" y="15" width="7" height="6" rx="1"/><path d="M9.5 18h5"/>',
      ],
      [
        "chain",
        "gen.frameBuildChain",
        "Build A \u2192 B chain",
        '<rect x="3" y="5" width="6" height="6" rx="1"/><rect x="15" y="13" width="6" height="6" rx="1"/><path d="M9 8h4a4 4 0 0 1 4 4v1"/><path d="m14 11 3 3 3-3"/>',
      ],
      [
        "clear",
        "common.clear",
        "Clear frames",
        '<path d="M4 7h16"/><path d="m9 7 1-2h4l1 2"/><path d="m6 7 1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
      ],
    ];
    return `<div class="frame-source-actions">${buttons.map(([mode, key, fallback, paths]) => `<button type="button" data-action="${kind === "batch" ? "batch-frame-bulk" : "item-frame-bulk"}" data-frame-bulk="${mode}">${mode === "start" ? startIcon : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${paths}</svg>`}<span>${this._escape(window.I18n?.t?.(key) || fallback)}</span></button>`).join("")}</div>`;
  }
  _frameSourceThumbHtml(batch, ref, index) {
    const key = this._escape(ref.refKey);
    const url = this._refThumbUrl(batch, ref);
    const local = ref.refKey.startsWith("upload_");
    const label = local
      ? window.I18n?.t?.("gen.uploadQueued") || "Waiting"
      : "Flow";
    const removeLabel = this._escape(
      window.I18n?.t?.("workflow.mediaModal.removeImage") || "Remove image",
    );
    return `<div class="gen-batch-ref-row ref-thumb frame-source-thumb ${local ? "ref-thumb-pending is-local" : "is-flow"}" data-ref-key="${key}" data-index="${index + 1}" draggable="true">
      <div class="ref-thumb-inner frame-source-thumb-inner" data-action="batch-frame-source-select" data-ref-key="${key}" role="button" tabindex="0">${url ? `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch.batchId}|${ref.refKey}`)}" alt="${this._escape(ref.name || "")}">` : `<span>${this._escape(ref.refKey.slice(0, 8))}</span>`}
        <span class="ref-thumb-badge ${local ? "" : "frame-source-flow-badge"}">${this._escape(label)}</span></div>
      <button type="button" class="frame-source-remove" data-action="ref-remove"
        aria-label="${removeLabel}" data-tooltip="${removeLabel}">\xD7</button></div>`;
  }
  _assignEditorFrameSources(mode) {
    var _a, _b, _c, _d, _e;
    const editor = this._editor;
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    if (!editor || !["start", "pairs", "chain", "clear"].includes(mode)) return;
    const ids = [
      ...sheet.querySelectorAll(
        editor.kind === "item"
          ? ".gen-batch-item-frame-list > .frame-source-thumb[data-ref-key]"
          : ".gen-batch-ref-row[data-ref-key]",
      ),
    ].map((row) => row.dataset.refKey);
    if (editor.kind === "item") {
      const first = sheet.querySelector('[name="frame1"]');
      const second = sheet.querySelector('[name="frame2"]');
      if (mode === "chain" && first && !ids[1]) return;
      if (mode === "clear") {
        if (first) first.value = "";
        if (second) second.value = "";
      } else if (ids[0]) {
        if (first) first.value = ids[0];
        if (second && mode !== "start")
          second.value = first ? ids[1] || "" : ids[0];
      }
      for (const select of [first, second]) this._updateFramePreview(select);
      return;
    }
    if (editor.kind !== "batch") return;
    const batch = this.batches.find(
      (entry) => entry.batchId === editor.batchId,
    );
    if (!batch || batch.refMode !== "frames") return;
    const source = editor.framePairs || batch.frameFileIds;
    const shared = !Array.isArray(source);
    const base = shared ? [source || {}] : source;
    const pairs = batch.items.map((_, index) => ({
      frame1: (base[index] || (shared && base[0]))?.frame1 || "",
      frame2: (base[index] || (shared && base[0]))?.frame2 || "",
    }));
    for (let index = 0; index < pairs.length; index++) {
      if (mode === "clear") pairs[index] = { frame1: "", frame2: "" };
      else if (mode === "start" && ids[index])
        (_a = pairs[index]).frame1 || (_a.frame1 = ids[index]);
      else if (mode === "pairs" && ids[index * 2]) {
        (_b = pairs[index]).frame1 || (_b.frame1 = ids[index * 2]);
        (_c = pairs[index]).frame2 || (_c.frame2 = ids[index * 2 + 1] || "");
      } else if (mode === "chain" && ids[index + 1]) {
        (_d = pairs[index]).frame1 || (_d.frame1 = ids[index]);
        (_e = pairs[index]).frame2 || (_e.frame2 = ids[index + 1] || "");
      }
    }
    editor.framePairs = pairs;
    this._refreshBatchPreview();
  }
  _renderBatchFramePairs(batch) {
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const container = sheet?.querySelector(".gen-batch-editor-frame-pairs");
    if (!container || !batch) return;
    const mode = sheet.querySelector('[name="refMode"]')?.value;
    container.hidden = mode !== "frames";
    if (mode !== "frames") {
      container.replaceChildren();
      return;
    }
    const editor = this._editor;
    const source = editor.framePairs || batch.frameFileIds;
    const pairs = Array.isArray(source) ? source : [source || {}];
    const selectedRefs = this._batchEditorRefs(sheet, batch);
    const byKey = new Map(selectedRefs.map((ref) => [ref.refKey, ref]));
    const chain = sheet.querySelector('[name="chain"]')?.checked;
    const slot = (index, name, key, automatic) => {
      const label = this._escape(
        window.I18n?.t?.(
          name === "frame1" ? "gen.frameStart" : "gen.frameEnd",
        ) || (name === "frame1" ? "Start" : "End"),
      );
      const ref = byKey.get(key);
      const url = key ? this._refThumbUrl(batch, ref || { refKey: key }) : "";
      const preview = url
        ? `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch.batchId}|${key}`)}" alt="${label}">`
        : key
          ? `<span class="frame-thumb-fallback">${this._escape(key.slice(0, 12))}</span>`
          : `<svg class="frame-dropzone-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg><span class="frame-dropzone-text">${this._escape(automatic ? this._t("previousResult", "Previous result") : window.I18n?.t?.("gen.addFrame") || "Add")}</span>`;
      const active =
        editor.activeFrame?.index === index &&
        editor.activeFrame?.name === name;
      return `<button type="button" class="frame-slot gen-batch-batch-frame-slot${active ? " is-active" : ""}"
        data-action="batch-frame-target" data-original-index="${index}" data-frame-name="${name}"
        ${automatic ? "disabled" : ""}><span class="frame-slot-header"><span class="frame-slot-label">${label}</span></span>
        <span class="frame-slot-body"><span class="gen-batch-frame-preview">${preview}</span></span></button>`;
    };
    container.innerHTML = batch.items
      .map((item, index) => {
        if (item.hidden || editor.deletedIndexes?.has(index)) return "";
        const pair =
          pairs[index] || (Array.isArray(source) ? {} : pairs[0]) || {};
        const automatic = chain && index > 0;
        return `<div class="per-prompt-frame-pair" data-original-index="${index}">
        <div class="per-prompt-frame-header"><span class="per-prompt-frame-index">${index + 1}</span>
          <span class="per-prompt-frame-prompt-preview">${this._escape(item.prompt || "")}</span></div>
        <div class="per-prompt-frame-slots">${slot(index, "frame1", automatic ? "" : pair.frame1 || "", automatic)}
          ${slot(index, "frame2", pair.frame2 || "", false)}</div></div>`;
      })
      .join("");
  }
  _setBatchFrameSlot(index, name, key) {
    const editor = this._editor;
    const batch = this.batches.find(
      (entry) => entry.batchId === editor?.batchId,
    );
    if (
      editor?.kind !== "batch" ||
      batch?.refMode !== "frames" ||
      !batch.items[index] ||
      batch.items[index].hidden ||
      editor.deletedIndexes?.has(index) ||
      !["frame1", "frame2"].includes(name)
    )
      return;
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    if (
      name === "frame1" &&
      index > 0 &&
      sheet.querySelector('[name="chain"]')?.checked
    )
      return;
    if (
      key &&
      ![
        ...sheet.querySelectorAll(
          ".gen-batch-frame-source-panel .gen-batch-ref-row",
        ),
      ].some((row) => row.dataset.refKey === key)
    )
      return;
    const source = editor.framePairs || batch.frameFileIds;
    const shared = !Array.isArray(source);
    const base = shared ? [source || {}] : source;
    editor.framePairs = batch.items.map((_, i) => ({
      frame1: (base[i] || (shared && base[0]))?.frame1 || "",
      frame2: (base[i] || (shared && base[0]))?.frame2 || "",
    }));
    editor.framePairs[index][name] = key || "";
    editor.activeFrame = { index, name };
    this._refreshBatchPreview();
  }
  _pruneEditorFramePairs(batch, selected) {
    const source = this._editor.framePairs || batch.frameFileIds;
    const shared = !Array.isArray(source);
    const base = shared ? [source || {}] : source;
    this._editor.framePairs = batch.items.map((_, index) => ({
      frame1: selected.has((base[index] || (shared && base[0]))?.frame1)
        ? (base[index] || base[0]).frame1
        : "",
      frame2: selected.has((base[index] || (shared && base[0]))?.frame2)
        ? (base[index] || base[0]).frame2
        : "",
    }));
  }
  _selectBatchFrameSource(key) {
    const editor = this._editor;
    const batch = this.batches.find(
      (entry) => entry.batchId === editor?.batchId,
    );
    if (editor?.kind !== "batch" || batch?.refMode !== "frames") return;
    let target = editor.activeFrame;
    if (!target) {
      const index = batch.items.findIndex(
        (item, i) => !item.hidden && !editor.deletedIndexes?.has(i),
      );
      target = { index, name: "frame1" };
    }
    this._setBatchFrameSlot(target.index, target.name, key);
  }
  _selectEditorFrameSource(button) {
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const name =
      this._editor?.activeFrameName ||
      (sheet.querySelector('[name="frame1"]') ? "frame1" : "frame2");
    const select = sheet.querySelector(`[name="${name}"]`);
    if (!select) return;
    select.value = button.dataset.refKey || "";
    this._updateFramePreview(select);
    if (name === "frame1" && sheet.querySelector('[name="frame2"]'))
      this._editor.activeFrameName = "frame2";
    sheet
      .querySelectorAll(".gen-batch-item-frame-slots .frame-slot")
      .forEach((slot) =>
        slot.classList.toggle(
          "is-active",
          slot.dataset.frameName === this._editor.activeFrameName,
        ),
      );
  }
  _itemFrameEditorHtml(
    batch,
    item,
    chainLaterFrame,
    frameOptions,
    allowPicker = true,
  ) {
    const sourceLabel = this._escape(
      window.I18n?.t?.("gen.refImages") || "Source images",
    );
    const pickerLabel = this._escape(
      window.I18n?.t?.("gen.selectUploadImage") || "Select image / Drag here",
    );
    const slot = (
      name,
      selected,
    ) => `<div class="frame-slot gen-batch-frame-field"
      data-action="item-frame-target" data-frame-name="${name}">
      <div class="frame-slot-header"><span class="frame-slot-label">${this._escape(window.I18n?.t?.(name === "frame1" ? "gen.frameStart" : "gen.frameEnd") || this._t(name, name === "frame1" ? "Start" : "End"))}</span></div>
      <div class="frame-slot-body"><span class="gen-batch-frame-preview" aria-hidden="true"></span></div>
      ${`<select name="${name}" hidden>${frameOptions(selected)}</select>`}</div>`;
    return `<div class="frame-source-panel gen-batch-item-frame-source-panel">
      <div class="frame-source-head"><span>${sourceLabel} (<span data-frame-source-count>0</span>)</span></div>
      ${allowPicker ? `<button type="button" data-action="item-pick-refs" class="ref-btn-upload ref-btn-upload--wide frame-source-dropzone"><svg class="ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M15 8h.01"/><path d="M12.5 21h-6.5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v6.5"/><path d="M3 16l5-5c.928-.893 2.072-.893 3 0l3.5 3.5"/><path d="M19 22v-6"/><path d="M22 19l-3-3-3 3"/></svg><span class="ref-btn-text">${pickerLabel}</span></button>` : ""}
      <div class="frame-source-list gen-batch-item-frame-list"></div>
      ${this._frameSourceActionsHtml("item")}
      <div class="per-prompt-frame-slots gen-batch-item-frame-slots">
        ${chainLaterFrame ? "" : slot("frame1", item.refKeys?.[0])}
        ${slot("frame2", item.refKeys?.[chainLaterFrame ? 0 : 1])}
      </div></div>`;
  }
  _renderItemFrameSources(batch) {
    const panel = this.overlay.querySelector(
      ".gen-batch-editor .gen-batch-item-frame-source-panel",
    );
    if (!panel) return;
    const refs = new Map(
      [...(batch.refPool || []), ...(this._editor?.pickerRefs || [])]
        .filter(
          (ref) =>
            ref.mediaType !== "video" &&
            !this._editor?.hiddenFrameSources?.has(ref.refKey),
        )
        .map((ref) => [ref.refKey, ref]),
    );
    const list = panel.querySelector(".gen-batch-item-frame-list");
    list.innerHTML = [...refs.values()]
      .map((ref, index) => {
        const url = this._refThumbUrl(batch, ref);
        const local = ref.refKey.startsWith("upload_");
        const label = local
          ? window.I18n?.t?.("gen.uploadQueued") || "Waiting"
          : "Flow";
        const key = this._escape(ref.refKey);
        const removeLabel = this._escape(
          window.I18n?.t?.("workflow.mediaModal.removeImage") || "Remove image",
        );
        return `<div class="ref-thumb frame-source-thumb ${local ? "ref-thumb-pending is-local" : "is-flow"}" data-ref-key="${key}"
        data-index="${index + 1}" draggable="true">
        <button type="button" class="ref-thumb-inner frame-source-thumb-inner gen-batch-frame-source-select"
          data-action="item-frame-select" data-ref-key="${key}">${url ? `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch.batchId}|${ref.refKey}`)}" alt="${this._escape(ref.name || "")}">` : `<span>${this._escape(ref.refKey.slice(0, 8))}</span>`}
          <span class="ref-thumb-badge ${local ? "" : "frame-source-flow-badge"}">${this._escape(label)}</span></button>
        <button type="button" class="frame-source-remove" data-action="item-frame-remove"
          data-ref-key="${key}" aria-label="${removeLabel}" data-tooltip="${removeLabel}">\xD7</button></div>`;
      })
      .join("");
    panel.querySelector("[data-frame-source-count]").textContent = String(
      refs.size,
    );
    const actions = panel.querySelector(".frame-source-actions");
    if (actions) {
      actions.hidden = refs.size === 0;
      const chain = actions.querySelector('[data-frame-bulk="chain"]');
      if (chain)
        chain.disabled =
          refs.size < (panel.querySelector('[name="frame1"]') ? 2 : 1);
    }
  }
  _refThumbUrl(batch, ref) {
    const key = ref?.refKey;
    if (!key) return "";
    const repair = this._refThumbRepairs.get(`${batch?.batchId}|${key}`);
    const identity = JSON.stringify([
      ref.refKey,
      ref.mediaUuid,
      ref.fileName,
      ref.thumbnail,
    ]);
    const registry = window.MediaRegistry?.getRefIdentity?.(key);
    const candidates = [
      this._editor?.pickerThumbs?.get(key),
      this._assetUrls.get(`${batch?.batchId}\0${key}`),
      repair?.identity === identity ? repair.url : null,
      ref?.thumbnail,
      window.GenTab?.thumbnailCache?.[key],
      window.MediaRegistry?.getThumb?.(key),
      registry?.thumbnail,
      registry?.thumbnail_url,
      registry?.source_thumbnail,
    ];
    const url =
      candidates.find((url2) => this._isRefThumbnailUsable(url2)) || "";
    return window.flow_uuid_gateway?.displayThumbnailUrl?.(url) || url;
  }
  _isRefThumbnailUsable(url) {
    return window.flow_uuid_gateway.usableUrl(url, {
      rejectedUrls: [...this._failedRefThumbUrls],
    });
  }
  _itemRefChoiceHtml(batch, ref, label) {
    const url = this._refThumbUrl(batch, ref);
    const icon =
      ref.mediaType === "video"
        ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
        : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    const thumb = url
      ? `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch?.batchId || ""}|${ref.refKey}`)}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icon}</svg>`;
    const remove = window.I18n?.t?.("common.delete") || "Delete";
    return `<button type="button" class="gen-batch-ref-choice" data-action="remove-item-ref" data-ref-key="${this._escape(ref.refKey)}" aria-label="${this._escape(`${remove}: ${label}`)}"><span class="gen-batch-ref-choice-thumb">${thumb}</span><span class="gen-batch-ref-choice-remove" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg></span></button>`;
  }
  async _hydrateListRefThumbs(epoch, { catalogOnly = false } = {}) {
    if (
      catalogOnly
        ? !window.MessageBridge?.lookupFlowMediaCatalog
        : !window.MessageBridge?.getThumbnailsByIds
    )
      return;
    const owner = this._scope();
    if (!owner) return;
    const refBatches = [...this.batches];
    const directJobs = new Map();
    for (const job of [...this.cachedJobs, ...this._liveJobs()]) {
      if (
        !["prompts", "mcp"].includes(job.owner) ||
        !job.id ||
        job.sourceBatchId ||
        job.projectId !== owner.projectId ||
        (job.owner === "mcp" &&
          String(job.mcpUserId || "") !== String(owner.userId))
      )
        continue;
      directJobs.set(job.id, job);
    }
    for (const job of directJobs.values()) {
      const refs = new Map();
      for (const item of job.items || [])
        for (const id of item.refFileIds || [])
          if (!refs.has(id)) refs.set(id, this._directRef(item, id));
      refBatches.push({
        batchId: `direct:${job.id}`,
        projectId: job.projectId,
        userId: owner.userId,
        refPool: [...refs.values()],
        items: (job.items || []).map((item) => ({
          refKeys: item.refFileIds || [],
        })),
      });
    }
    const gateway = window.flow_uuid_gateway;
    const missing = new Map();
    for (const batch of refBatches) {
      if (
        batch.projectId !== owner.projectId ||
        String(batch.userId) !== String(owner.userId)
      )
        continue;
      const used = new Set(
        (batch.items || []).flatMap((item) => item.refKeys || []),
      );
      for (const ref of batch.refPool || []) {
        const thumbnail = this._refThumbUrl(batch, ref);
        if (
          used.has(ref.refKey) &&
          !ref.refKey.startsWith("upload_") &&
          (gateway.isUuid(ref.mediaUuid || ref.media_uuid || ref.refKey) ||
            !thumbnail ||
            thumbnail.startsWith("blob:"))
        )
          missing.set(ref.refKey, ref);
      }
    }
    if (!missing.size) return;
    const hydrationStarted = Date.now();
    const recovered = await gateway
      .recoverMetadata(
        [...missing].map(([id, ref]) => ({
          id,
          record: gateway.referenceMetadata(
            {
              ...ref,
              fileId: id,
              type:
                String(ref.mediaType || "").toLowerCase() === "video"
                  ? "video"
                  : "image",
            },
            id,
          ),
        })),
        {
          projectId: owner.projectId,
          catalogOnly,
          allowApi: false,
          allowLocal: false,
          fields: ["thumbnail"],
          deep: false,
          rejectedUrls: [...this._failedRefThumbUrls],
          abortFn: () =>
            !this._open ||
            epoch !== this._listRefHydrationEpoch ||
            this._scope()?.projectId !== owner.projectId ||
            String(this._scope()?.userId) !== String(owner.userId),
        },
      )
      .catch(() => null);
    const current = this._scope();
    if (
      !this._open ||
      epoch !== this._listRefHydrationEpoch ||
      current?.projectId !== owner.projectId ||
      String(current?.userId || "") !== String(owner.userId) ||
      (recovered?.target?.projectId &&
        String(recovered.target.projectId) !== String(owner.projectId))
    )
      return;
    let changed = false,
      resolved = 0;
    for (const id of missing.keys()) {
      if (!recovered || recovered.unresolved.includes(id)) continue;
      const ref = missing.get(id);
      const info = recovered?.records?.[id];
      if (
        !gateway.metadataMatches(gateway.referenceMetadata(ref, id), info, {
          projectId: owner.projectId,
        })
      )
        continue;
      const url = info?.thumbnail;
      if (!this._isRefThumbnailUsable(url)) continue;
      window.MediaRegistry?.setRefIdentity?.(id, info);
      window.MediaRegistry?.setThumb?.(id, url);
      for (const batch of refBatches) {
        if (
          batch.projectId !== owner.projectId ||
          String(batch.userId) !== String(owner.userId)
        )
          continue;
        const batchRef = batch.refPool?.find((entry) => entry.refKey === id);
        if (
          !batchRef ||
          !gateway.metadataMatches(
            gateway.referenceMetadata(batchRef, id),
            info,
            { projectId: owner.projectId },
          )
        )
          continue;
        this._refThumbRepairs.set(`${batch.batchId}|${id}`, {
          url,
          identity: JSON.stringify([
            batchRef.refKey,
            batchRef.mediaUuid,
            batchRef.fileName,
            batchRef.thumbnail,
          ]),
        });
      }
      changed = true;
      resolved++;
    }
    console.info(
      "[GenBatchRefThumbnail]",
      JSON.stringify({
        stage: "list_hydrate",
        catalogOnly,
        requested: missing.size,
        resolved,
        unresolved: missing.size - resolved,
        uuidAvailable: [...missing.values()].filter((ref) => !!ref.mediaUuid)
          .length,
        sharedLookup: !!recovered,
        elapsedMs: Date.now() - hydrationStarted,
      }),
    );
    if (changed) this._scheduleRender();
  }
  async _hydrateBatchRefThumbs(
    batch,
    editor,
    { deep = false, refKey = null } = {},
  ) {
    const missing = (batch.refPool || []).filter(
      (ref) =>
        (!refKey || ref.refKey === refKey) &&
        !ref.refKey.startsWith("upload_") &&
        !this._refThumbUrl(batch, ref),
    );
    if (!missing.length || !window.MessageBridge?.getThumbnailsByIds) return;
    const gateway = window.flow_uuid_gateway;
    const recovery = await gateway.recoverMetadata(
      missing.map((ref) => ({
        id: ref.refKey,
        record: gateway.referenceMetadata(
          {
            ...ref,
            type:
              String(ref.mediaType || "").toLowerCase() === "video"
                ? "video"
                : "image",
          },
          ref.refKey,
        ),
      })),
      {
        projectId: batch.projectId,
        deep,
        allowApi: false,
        fields: ["thumbnail"],
        allowLocal: false,
        rejectedUrls: [...this._failedRefThumbUrls],
        abortFn: () =>
          this._editor !== editor ||
          this._scope()?.projectId !== batch.projectId ||
          String(this._scope()?.userId) !== String(batch.userId),
      },
    );
    if (
      this._editor !== editor ||
      this._scope()?.projectId !== batch.projectId ||
      String(this._scope()?.userId || "") !== String(batch.userId || "") ||
      (recovery?.target?.projectId &&
        String(recovery.target.projectId) !== String(batch.projectId))
    )
      return;
    for (const ref of missing) {
      if (recovery.unresolved.includes(ref.refKey)) continue;
      const info = recovery.records[ref.refKey];
      if (
        !gateway.metadataMatches(
          gateway.referenceMetadata(ref, ref.refKey),
          info,
          { projectId: batch.projectId },
        )
      )
        continue;
      const url = info?.thumbnail;
      if (!/^https?:\/\//.test(url || "")) continue;
      window.MediaRegistry?.setThumb?.(ref.refKey, url);
      editor.pickerRefs ||
        (editor.pickerRefs = (batch.refPool || []).map((entry) => ({
          ...entry,
        })));
      const editableRef = editor.pickerRefs.find(
        (entry) => entry.refKey === ref.refKey,
      );
      if (editableRef) editableRef.thumbnail = url;
      const list = this.overlay.querySelector(
        ".gen-batch-editor .gen-batch-ref-list",
      );
      const row = [
        ...(list?.querySelectorAll(".gen-batch-ref-row") || []),
      ].find((node) => node.dataset.refKey === ref.refKey);
      const thumb = row?.querySelector(".ref-thumb-inner");
      if (thumb) {
        thumb.innerHTML = `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch.batchId}|${ref.refKey}`)}" alt="">`;
        row.querySelector('[data-action="ref-rescan"]')?.remove();
      }
    }
    this._refreshBatchPreview();
    this._renderItemFrameSources(batch);
    for (const name of ["frame1", "frame2"])
      this._updateFramePreview(
        this.overlay.querySelector(`.gen-batch-editor [name="${name}"]`),
      );
  }
  _refreshBatchModelOptions() {
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const video = sheet.querySelector('[name="genType"]')?.value === "Video";
    const models =
      window.ModelRegistry?.safeGetModelsSync?.(
        "flow",
        video ? "video" : "image",
      ) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.(
        "flow",
        video ? "video" : "image",
      ) || [];
    for (const [name, entries] of [
      ["model", models],
      ["ratio", ratios],
    ]) {
      const select = sheet.querySelector(`[name="${name}"]`);
      const previous = select?.value;
      if (!select || !entries.length)
        throw new Error("BATCH_CONFIG_UNAVAILABLE");
      select.replaceChildren(
        ...entries.map((entry) => {
          const option = document.createElement("option");
          option.value = typeof entry === "string" ? entry : entry.value;
          option.textContent =
            typeof entry === "string"
              ? entry
              : entry.name || entry.label || entry.value;
          if (name === "ratio")
            option.textContent =
              `${window.GenTab?._ratioIcon?.(option.value) || ""} ${option.textContent}`.trim();
          return option;
        }),
      );
      select.value = entries.some(
        (entry) =>
          (typeof entry === "string" ? entry : entry.value) === previous,
      )
        ? previous
        : select.options[0].value;
    }
  }
  _refreshBatchVideoOptions() {
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    if (!sheet || this._editor?.kind !== "batch") return;
    const modelValue = sheet.querySelector('[name="model"]')?.value;
    const model = window.ModelRegistry?.findModel?.("flow", modelValue);
    const sets = [
      [
        "flowVideoDuration",
        window.ProviderConfigManager?.safeGetVideoDurationsSync?.(
          "flow",
          model?.config?.duration_tier || "default",
        ) || [],
      ],
      [
        "flowVideoResolution",
        window.ModelRegistry?.getGenerationResolutionConfig?.(
          "flow",
          modelValue,
        )?.options || [],
      ],
    ];
    for (const [name, entries] of sets) {
      const select = sheet.querySelector(`[name="${name}"]`);
      if (!select) continue;
      const previous = select.value;
      const values = entries
        .map((entry) =>
          typeof entry === "string" ? { value: entry, label: entry } : entry,
        )
        .filter((entry) => entry?.value);
      if (!values.length) {
        select.disabled = true;
        select.closest("label").hidden = true;
        continue;
      }
      select.replaceChildren(
        ...values.map((entry) => {
          const option = document.createElement("option");
          option.value = entry.value;
          option.textContent = entry.label || entry.value;
          return option;
        }),
      );
      select.value = values.some((entry) => entry.value === previous)
        ? previous
        : values[0]?.value || "";
      select.disabled = false;
      select.closest("label").hidden =
        sheet.querySelector('[name="genType"]')?.value !== "Video";
    }
  }
  async _pickBatchReferences() {
    const editor = this._editor;
    if (editor?.kind !== "batch" || editor.pickerBusy || this._busy) return;
    if (
      !window.imagePickerModal?.open ||
      !window.ImagePickerModal?.resolveCapsMulti
    )
      throw new Error("BATCH_REF_PICKER_UNAVAILABLE");
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const batch = this.batches.find(
      (entry) => entry.batchId === editor.batchId,
    );
    if (!batch) throw new Error("BATCH_REVISION_CONFLICT");
    const refs = this._batchEditorRefs(sheet, batch);
    const mode =
      sheet.querySelector('[name="genType"]').value === "Video"
        ? "video"
        : "image";
    const model = sheet.querySelector('[name="model"]').value;
    const refMode = sheet.querySelector('[name="refMode"]').value;
    const caps = window.ImagePickerModal.resolveCapsMulti({
      provider: "flow",
      mode,
      isFrames: refMode === "frames",
      modelValue: model,
      duration:
        sheet.querySelector('[name="flowVideoDuration"]')?.value ||
        batch.settingsSnapshot?.flowVideoDuration ||
        void 0,
    });
    if (!caps || caps.image == null)
      throw new Error("BATCH_REF_POLICY_UNAVAILABLE");
    const existingMedia = {},
      existingFileTypes = {};
    for (const ref of refs) {
      const key = ref.refKey;
      existingFileTypes[key] = ref.mediaType || "image";
      const thumbnail = this._refThumbUrl(batch, ref);
      existingMedia[key] = {
        thumbnail,
        source_thumbnail: thumbnail,
        file_name: ref.fileName || "",
        media_uuid: ref.mediaUuid || "",
        type: ref.mediaType || "image",
        name: ref.name || key,
      };
    }
    window.imagePickerModal.open({
      refAuditContext: { surface: "gen" },
      existingFileIds: refs.map((ref) => ref.refKey),
      existingFileTypes,
      existingMedia,
      mediaFilter: "image",
      allowVideo:
        mode === "video" &&
        window.ProviderRegistry?.get?.("flow")?.supportsRefVideo?.(model) ===
          true,
      maxSelections:
        refMode === "all" || refMode === "frames" ? caps.image : null,
      maxImageSelections:
        refMode === "all" || refMode === "frames" ? caps.image : null,
      maxVideoSelections:
        refMode === "all" || refMode === "frames"
          ? caps.video || 0
          : Number.MAX_SAFE_INTEGER,
      maxTotalSelections:
        refMode === "all" || refMode === "frames" ? caps.total : null,
      noRefSupportContext:
        caps.image === 0
          ? {
              provider: "flow",
              modelValue: model,
              mediaType: mode,
              inputType: refMode === "frames" ? "Frames" : "Ingredients",
            }
          : null,
      onConfirm: (images) =>
        this._applyBatchPickerSelection(editor, batch, images).catch((error) =>
          this._error(error),
        ),
    });
  }
  async _pickItemReferences() {
    const editor = this._editor;
    if (
      editor?.kind !== "item" ||
      editor.runtime ||
      editor.pickerBusy ||
      this._busy
    )
      return;
    if (
      !window.imagePickerModal?.open ||
      !window.ImagePickerModal?.resolveCapsMulti
    )
      throw new Error("BATCH_REF_PICKER_UNAVAILABLE");
    const batch = this.batches.find(
      (entry) => entry.batchId === editor.batchId,
    );
    if (!batch || batch.refMode === "none")
      throw new Error("BATCH_REVISION_CONFLICT");
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    const model = sheet.querySelector('[name="model"]')?.value;
    const mode =
      batch.settingsSnapshot?.genType === "Video" ? "video" : "image";
    const caps = window.ImagePickerModal.resolveCapsMulti({
      provider: "flow",
      mode,
      isFrames: batch.refMode === "frames",
      modelValue: model,
      duration:
        sheet.querySelector('[name="duration"]')?.value ||
        batch.settingsSnapshot?.flowVideoDuration ||
        void 0,
    });
    if (!caps || caps.image == null)
      throw new Error("BATCH_REF_POLICY_UNAVAILABLE");
    const refs = [...(batch.refPool || []), ...(editor.pickerRefs || [])];
    const byKey = new Map(refs.map((ref) => [ref.refKey, ref]));
    const keys =
      batch.refMode === "frames"
        ? [
            sheet.querySelector('[name="frame1"]')?.value,
            sheet.querySelector('[name="frame2"]')?.value,
          ].filter(Boolean)
        : [
            ...sheet.querySelectorAll(
              ".gen-batch-ref-choices .gen-batch-ref-choice",
            ),
          ].map((button) => button.dataset.refKey);
    const existingMedia = {},
      existingFileTypes = {};
    for (const key of keys) {
      const ref = byKey.get(key);
      if (!ref) continue;
      existingFileTypes[key] = ref.mediaType || "image";
      const thumbnail = this._refThumbUrl(batch, ref);
      existingMedia[key] = {
        thumbnail,
        source_thumbnail: thumbnail,
        file_name: ref.fileName || "",
        media_uuid: ref.mediaUuid || "",
        type: ref.mediaType || "image",
        name: ref.name || key,
      };
    }
    const chainLater =
      batch.settingsSnapshot?.chain?.kind === "video_last_frame" &&
      editor.index > 0;
    const pickerMax = chainLater ? Math.min(caps.image, 1) : caps.image;
    window.imagePickerModal.open({
      refAuditContext: { surface: "gen" },
      existingFileIds: keys,
      existingFileTypes,
      existingMedia,
      mediaFilter: "image",
      allowVideo:
        batch.refMode !== "frames" &&
        mode === "video" &&
        window.ProviderRegistry?.get?.("flow")?.supportsRefVideo?.(model) ===
          true,
      maxSelections: pickerMax,
      maxImageSelections: pickerMax,
      maxVideoSelections: batch.refMode === "frames" ? 0 : caps.video || 0,
      maxTotalSelections: chainLater
        ? Math.min(caps.total ?? 1, 1)
        : caps.total,
      noRefSupportContext:
        caps.image === 0
          ? {
              provider: "flow",
              modelValue: model,
              mediaType: mode,
              inputType: batch.refMode === "frames" ? "Frames" : "Ingredients",
            }
          : null,
      onConfirm: (images) =>
        this._applyItemPickerSelection(editor, batch, images).catch((error) =>
          this._error(error),
        ),
    });
  }
  async _applyItemPickerSelection(editor, batch, images) {
    editor.pickerBusy = true;
    try {
      const previous = new Map(
        [...(batch.refPool || []), ...(editor.pickerRefs || [])].map((ref) => [
          ref.refKey,
          ref,
        ]),
      );
      const refs = [],
        assets = new Map(),
        thumbs = new Map(),
        pendingKeys = new Set();
      for (const image of images || []) {
        let key = image.fileId;
        let file = image.file;
        let prepared = null;
        if (image.source === "album") {
          prepared =
            await window.ImagePickerModal.prepareAlbumImageForRef(image);
          if (!prepared) throw new Error("BATCH_ASSET_MISSING");
          key = prepared.key;
          file = window.pendingUploadFiles?.get(key)?.file;
          if (key?.startsWith("upload_")) pendingKeys.add(key);
        }
        if (image.source === "upload" && file instanceof Blob)
          key = key?.startsWith("upload_")
            ? key
            : `upload_${crypto.randomUUID()}`;
        if (!key) throw new Error("BATCH_REF_IDENTITY_MISSING");
        if (key.startsWith("upload_") && !previous.has(key)) {
          file || (file = window.pendingUploadFiles?.get(key)?.file);
          if (!(file instanceof Blob) || !file.size)
            throw new Error("BATCH_ASSET_MISSING");
          assets.set(key, {
            refKey: key,
            file,
            name: file.name || image.name || key,
          });
        }
        if (editor.pickerAssets?.has(key))
          assets.set(key, editor.pickerAssets.get(key));
        if (editor.pickerPendingKeys?.has(key)) pendingKeys.add(key);
        const identity = window.MediaRegistry?.getRefIdentity?.(key) || {};
        const old = previous.get(key);
        const ref = old
          ? { ...old }
          : {
              refKey: key,
              name:
                image.name ||
                image.file_name ||
                file?.name ||
                identity.name ||
                key,
              fileName:
                prepared?.file_name ||
                image.file_name ||
                identity.file_name ||
                null,
              mediaUuid: image.media_uuid || identity.media_uuid || null,
              mediaType:
                image.type === "video" || file?.type?.startsWith("video/")
                  ? "video"
                  : "image",
            };
        const thumb =
          prepared?.thumbnail_url ||
          image.thumbnail_url ||
          image.thumbnail ||
          image.source_thumbnail ||
          editor.pickerThumbs?.get(key) ||
          "";
        if (
          /^(?:https?:|blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/.test(
            thumb,
          )
        )
          thumbs.set(key, thumb);
        if (/^https?:\/\//.test(thumb)) ref.thumbnail = thumb;
        refs.push(ref);
      }
      if (this._editor !== editor) {
        for (const key of pendingKeys) window.pendingUploadFiles?.delete(key);
        return;
      }
      for (const key of editor.pickerPendingKeys || [])
        if (!pendingKeys.has(key)) window.pendingUploadFiles?.delete(key);
      editor.pickerRefs = refs;
      editor.pickerAssets = assets;
      editor.pickerThumbs = thumbs;
      editor.pickerPendingKeys = pendingKeys;
      for (const ref of refs) editor.hiddenFrameSources?.delete(ref.refKey);
      const sheet = this.overlay.querySelector(".gen-batch-editor");
      const selected = new Set(refs.map((ref) => ref.refKey));
      if (batch.refMode === "frames") {
        const options = [
          sheet.querySelector('[name="frame1"]'),
          sheet.querySelector('[name="frame2"]'),
        ];
        for (const select of options) {
          if (!select) continue;
          for (const ref of refs)
            if (
              ![...select.options].some((option) => option.value === ref.refKey)
            )
              select.add(new Option(ref.name || ref.refKey, ref.refKey));
        }
        options.forEach((select, index) => {
          if (select) select.value = refs[options[0] ? index : 0]?.refKey || "";
        });
        options.forEach((select) => this._updateFramePreview(select));
        this._renderItemFrameSources(batch);
      } else {
        const choices = sheet.querySelector(".gen-batch-ref-choices");
        if (choices)
          choices.innerHTML = refs
            .map((ref) =>
              this._itemRefChoiceHtml(batch, ref, ref.name || ref.refKey),
            )
            .join("");
        sheet.querySelector(".gen-batch-ref-empty")?.remove();
        if (!selected.size && choices) {
          const empty = document.createElement("p");
          empty.className = "gen-batch-ref-empty";
          empty.textContent = this._t("noReferences");
          choices.after(empty);
        }
      }
      editor.mentionChips?.render();
    } finally {
      editor.pickerBusy = false;
    }
  }
  async _applyBatchPickerSelection(editor, batch, images) {
    editor.pickerBusy = true;
    try {
      const previous = new Map(
        (editor.pickerRefs || batch.refPool || []).map((ref) => [
          ref.refKey,
          ref,
        ]),
      );
      const refs = [],
        assets = new Map(),
        thumbs = new Map(),
        pendingKeys = new Set();
      for (const image of images || []) {
        let key = image.fileId;
        let file = image.file;
        let prepared = null;
        if (image.source === "album") {
          prepared =
            await window.ImagePickerModal.prepareAlbumImageForRef(image);
          if (!prepared) throw new Error("BATCH_ASSET_MISSING");
          key = prepared.key;
          file = window.pendingUploadFiles?.get(key)?.file;
          if (key?.startsWith("upload_")) pendingKeys.add(key);
        }
        if (image.source === "upload" && file instanceof Blob)
          key = key?.startsWith("upload_")
            ? key
            : `upload_${crypto.randomUUID()}`;
        if (!key) throw new Error("BATCH_REF_IDENTITY_MISSING");
        if (key.startsWith("upload_") && !previous.has(key)) {
          file || (file = window.pendingUploadFiles?.get(key)?.file);
          if (!(file instanceof Blob) || !file.size)
            throw new Error("BATCH_ASSET_MISSING");
          assets.set(key, {
            refKey: key,
            file,
            name: file.name || image.name || key,
          });
        }
        if (editor.pickerAssets?.has(key))
          assets.set(key, editor.pickerAssets.get(key));
        if (editor.pickerPendingKeys?.has(key)) pendingKeys.add(key);
        const identity = window.MediaRegistry?.getRefIdentity?.(key) || {};
        const old = previous.get(key);
        const ref = old
          ? { ...old }
          : {
              refKey: key,
              name:
                image.name ||
                image.file_name ||
                file?.name ||
                identity.name ||
                key,
              fileName:
                prepared?.file_name ||
                image.file_name ||
                identity.file_name ||
                null,
              mediaUuid: image.media_uuid || identity.media_uuid || null,
              mediaType:
                image.type === "video" || file?.type?.startsWith("video/")
                  ? "video"
                  : "image",
            };
        const thumb =
          prepared?.thumbnail_url ||
          image.thumbnail_url ||
          image.thumbnail ||
          image.source_thumbnail ||
          editor.pickerThumbs?.get(key) ||
          "";
        if (
          /^(?:https?:|blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/.test(
            thumb,
          )
        )
          thumbs.set(key, thumb);
        if (/^https?:\/\//.test(thumb)) ref.thumbnail = thumb;
        refs.push(ref);
      }
      if (this._editor !== editor) {
        for (const key of pendingKeys) window.pendingUploadFiles?.delete(key);
        return;
      }
      for (const key of editor.pickerPendingKeys || [])
        if (!pendingKeys.has(key)) window.pendingUploadFiles?.delete(key);
      editor.pickerRefs = refs;
      editor.pickerAssets = assets;
      editor.pickerThumbs = thumbs;
      editor.pickerPendingKeys = pendingKeys;
      if (batch.refMode === "frames")
        this._pruneEditorFramePairs(
          batch,
          new Set(refs.map((ref) => ref.refKey)),
        );
      if (
        refs.length &&
        this.overlay.querySelector('.gen-batch-editor [name="refMode"]')
          ?.value === "none"
      )
        this.overlay.querySelector('.gen-batch-editor [name="refMode"]').value =
          "all";
      this._renderBatchRefCards(batch, refs);
      this._refreshBatchPreview();
    } finally {
      editor.pickerBusy = false;
    }
  }
  _renderBatchRefCards(batch, refs) {
    const list = this.overlay.querySelector(
      ".gen-batch-editor .gen-batch-ref-list",
    );
    if (!list) return;
    if (batch.refMode === "frames") {
      const panel = list.closest("[data-batch-ref-pool]");
      panel.classList.add("frame-source-panel", "gen-batch-frame-source-panel");
      const picker = this.overlay.querySelector(
        ".gen-batch-editor [data-batch-add-refs]",
      );
      if (picker && picker.parentElement !== panel)
        panel.insertBefore(picker, list);
      picker?.classList.add("frame-source-dropzone");
      list.classList.add("frame-source-list");
      const legend = panel.querySelector("legend");
      if (legend)
        legend.textContent =
          window.I18n?.t?.("gen.refImages") || "Source images";
      if (!panel.querySelector(".frame-source-actions"))
        panel.insertAdjacentHTML("beforeend", this._frameSourceActionsHtml());
      list.innerHTML = refs
        .filter((ref) => ref.mediaType !== "video")
        .map((ref, index) => this._frameSourceThumbHtml(batch, ref, index))
        .join("");
      if (legend) legend.textContent += ` (${list.children.length})`;
      const count = this.overlay.querySelector(
        ".gen-batch-editor [data-frame-source-count]",
      );
      if (count) count.textContent = String(list.children.length);
      const actions = panel.querySelector(".frame-source-actions");
      if (actions) {
        actions.hidden = list.children.length === 0;
        const chain = actions.querySelector('[data-frame-bulk="chain"]');
        if (chain) chain.disabled = list.children.length < 2;
      }
      this._refreshBatchFieldVisibility(
        this.overlay.querySelector(".gen-batch-editor"),
      );
      return;
    }
    const showNames =
      this.overlay.querySelector('.gen-batch-editor [name="refMode"]')
        ?.value === "mention";
    list.innerHTML = refs
      .map((ref, index) => {
        const url = this._refThumbUrl(batch, ref);
        const icon =
          ref.mediaType === "video"
            ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
            : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
        const name = this._escape(ref.name || ref.refKey);
        const removeLabel = this._escape(
          window.I18n?.t?.("workflow.mediaModal.removeImage") || "Remove image",
        );
        return `<div class="gen-batch-ref-row" data-ref-key="${this._escape(ref.refKey)}" draggable="true"><div class="ref-thumb" data-index="${index + 1}"><div class="ref-thumb-inner">${url ? `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`${batch.batchId}|${ref.refKey}`)}" alt="">` : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${icon}</svg>`}</div>${!url && !ref.refKey.startsWith("upload_") ? `<button type="button" class="ref-thumb-rescan-btn" data-action="ref-rescan" data-ref-key="${this._escape(ref.refKey)}" aria-label="${this._escape(window.I18n?.t("workflow.thumbBrokenRescan") || "Rescan from Flow")}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9a7 7 0 0 1 12-2M18.5 15a7 7 0 0 1-12 2"/></svg></button>` : ""}<button type="button" class="ref-thumb-remove gen-batch-ref-remove" data-action="ref-remove" aria-label="${removeLabel}" data-tooltip="${removeLabel}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M5 5 19 19M19 5 5 19"/></svg></button></div>${showNames ? `<span class="gen-batch-ref-name" title="${name}">${name}</span>` : ""}</div>`;
      })
      .join("");
    this._refreshBatchFieldVisibility(
      this.overlay.querySelector(".gen-batch-editor"),
    );
  }
  _batchEditorSource(batch) {
    return JSON.stringify([
      batch.items,
      batch.settingsSnapshot,
      batch.refMode,
      batch.refPool,
      batch.frameFileIds,
      batch.autoDownload,
      batch.jobId,
      batch.runtimeItemIds,
    ]);
  }
  _isItemProcessing(item) {
    return [
      "PREPARING",
      "SUBMITTING",
      "SUBMITTED",
      "MONITORING",
      "GENERATING",
      "RUNNING",
    ].includes(String(item?.state || item?.status || "").toUpperCase());
  }
  _editBatch(batch) {
    const media =
      batch.settingsSnapshot?.genType === "Video" ? "video" : "image";
    const models =
      window.ModelRegistry?.safeGetModelsSync?.("flow", media) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.("flow", media) || [];
    if (!models.length || !ratios.length)
      throw new Error("BATCH_CONFIG_UNAVAILABLE");
    const option = (value, label, selected) =>
      `<option value="${this._escape(value)}"${selected ? " selected" : ""}>${this._escape(label)}</option>`;
    const imageDownloads =
      window.ProviderConfigManager?.getDownloadResolutionsSync?.(
        "flow",
        "image",
      ) || [];
    const videoDownloads =
      window.ProviderConfigManager?.getDownloadResolutionsSync?.(
        "flow",
        "video",
      ) || [];
    const downloadOptions = (entries, selected) =>
      entries
        .map((entry) =>
          option(
            entry.value,
            entry.label || entry.menu_label || entry.value,
            entry.value === selected,
          ),
        )
        .join("");
    const mode = batch.refMode;
    const typeIcon = (value) => {
      const icon = document.querySelector(
        `#genTypeToggle .gen-type-btn[data-value="${value}"] svg`,
      );
      if (!icon) throw new Error("BATCH_GENTAB_TYPE_ICON_UNAVAILABLE");
      return icon.outerHTML;
    };
    const selectUi = (name, options, extraClass = "") =>
      `<span class="input-group select-group compact-select ${extraClass}">${name === "refMode" ? '<svg class="ref-mode-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><g fill="currentColor"><path d="M9 5.62a2.38 2.38 0 1 1 0 4.76 2.38 2.38 0 0 1 0-4.76"/><path fill-rule="evenodd" d="M16.19 2C19.83 2 22 4.17 22 7.81v8.38c0 3.64-2.17 5.81-5.81 5.81H7.81c-2.39 0-4.157-.94-5.078-2.623l-.172-.347a5 5 0 0 1-.171-.422l-.022-.062C2.126 17.855 2 17.069 2 16.19V7.81C2 4.17 4.17 2 7.81 2zM7.81 3.5C4.99 3.5 3.5 4.99 3.5 7.81v8.38c0 .76.13 1.41.35 1.97l3.74-2.51c.8-.54 1.93-.48 2.64.14l.34.28c.78.67 2.04.67 2.82 0l4.16-3.57c.78-.67 2.04-.67 2.82 0l.13.11v-4.8c0-2.82-1.49-4.31-4.31-4.31z" clip-rule="evenodd"/></g></svg>' : ""}<select name="${name}">${options}</select><svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    const toggle = (name, label, checked) =>
      `<label class="toolbar-toggle wm-toggle gen-batch-edit-check"><input name="${name}" type="checkbox" ${checked ? "checked" : ""}><span class="toggle-track"><span class="toggle-thumb"></span></span><span class="toggle-label">${this._escape(label)}</span></label>`;
    const componentPicker = (
      kind,
      title,
      placeholder,
      value,
      icon,
    ) => `<div class="gen-batch-component-field" data-batch-${kind}>
      <span>${this._escape(title)}</span><button type="button" class="voice-picker-trigger" title="${this._escape(title)}">
        <span class="voice-picker-trigger-thumb-svg" id="genBatch${kind}Thumb">${icon}</span>
        <span class="voice-picker-label" id="genBatch${kind}Label">${this._escape(placeholder)}</span>
        <svg class="voice-picker-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button><input type="hidden" name="${kind}" value="${this._escape(value || "")}"></div>`;
    const componentText = (key, fallback) => {
      const value = window.I18n?.t?.(key);
      return value && value !== key ? value : fallback;
    };
    const characterValue =
      window.CharacterRegistry?.selectionValue?.(
        batch.settingsSnapshot?.character,
      ) || "";
    this._openEditor(
      {
        kind: "batch",
        batchId: batch.batchId,
        revision: batch.revision,
        sourceFingerprint: this._batchEditorSource(batch),
      },
      this._t("editBatch", "Edit batch"),
      `
      <section class="gen-batch-edit-section"><h4>${this._escape(this._t("prompts", "Prompts"))}</h4><div class="gen-batch-preview"></div></section>
      <section class="gen-batch-edit-section"><h4>${this._escape(this._t("settings", "Settings"))}</h4>
        <div class="gen-batch-edit-grid">
          <div class="gen-batch-media-field"><span>${this._escape(this._t("mediaType", "Type"))}</span><div class="gen-type-toggle gen-batch-type-toggle" role="group" aria-label="${this._escape(this._t("mediaType", "Type"))}"><button type="button" class="gen-type-btn${media === "image" ? " active" : ""}" data-action="batch-media-type" data-value="Image" aria-label="${this._escape(this._t("image", "Image"))}" aria-pressed="${media === "image"}" ${mode === "frames" ? "disabled" : ""}>${typeIcon("Image")}</button><button type="button" class="gen-type-btn${media === "video" ? " active" : ""}" data-action="batch-media-type" data-value="Video" aria-label="${this._escape(this._t("video", "Video"))}" aria-pressed="${media === "video"}">${typeIcon("Video")}</button></div><select name="genType" hidden>${option("Image", this._t("image", "Image"), media === "image") + option("Video", this._t("video", "Video"), media === "video")}</select></div>
          <label>${this._escape(this._t("model", "Model"))}${selectUi("model", (!models.some((entry) => entry.value === batch.settingsSnapshot.model) ? option(batch.settingsSnapshot.model, batch.settingsSnapshot.model, true) : "") + models.map((entry) => option(entry.value, entry.name || entry.label || entry.value, entry.value === batch.settingsSnapshot.model)).join(""))}</label>
          <label>${this._escape(this._t("ratio", "Ratio"))}${selectUi(
            "ratio",
            (!ratios.some(
              (entry) =>
                (typeof entry === "string" ? entry : entry.value) ===
                batch.settingsSnapshot.ratio,
            )
              ? option(
                  batch.settingsSnapshot.ratio,
                  batch.settingsSnapshot.ratio,
                  true,
                )
              : "") +
              ratios
                .map((entry) => {
                  const value = typeof entry === "string" ? entry : entry.value;
                  const label =
                    typeof entry === "string"
                      ? entry
                      : entry.label || entry.value;
                  return option(
                    value,
                    `${window.GenTab?._ratioIcon?.(value) || ""} ${label}`.trim(),
                    value === batch.settingsSnapshot.ratio,
                  );
                })
                .join(""),
          )}</label>
          <label data-batch-video-mode>${this._escape(this._t("inputType", "Mode"))}<span class="input-group select-group compact-select"><select name="videoInputType" disabled>
            ${option(mode === "frames" ? "Frames" : "Ingredients", mode === "frames" ? "Frames" : "Ingredients", true)}
          </select></span></label>
          <label class="hidden">${this._escape(window.I18n?.t("flow.thinkingLevel") || "")}${selectUi("flowThinkingLevel", option(batch.settingsSnapshot?.flowThinkingLevel || "", batch.settingsSnapshot?.flowThinkingLevel || "", true))}</label>
          <label data-batch-video-duration>${this._escape(this._t("duration", "Duration"))}${selectUi("flowVideoDuration", option(batch.settingsSnapshot?.flowVideoDuration || "", batch.settingsSnapshot?.flowVideoDuration || "", true))}</label>
          <label data-batch-video-generation-resolution>${this._escape(this._t("videoResolution", "Video resolution"))}${selectUi("flowVideoResolution", option(batch.settingsSnapshot?.flowVideoResolution || "", batch.settingsSnapshot?.flowVideoResolution || "", true))}</label>
          ${componentPicker("voice", componentText("voice.title", "Voice"), componentText("voice.random", "Random voice"), batch.settingsSnapshot?.voice?.slug, '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M1.5 5L1.5 7M3.75 5.5V6.5M6 3V9M8.25 1.5V10.5M10.5 5V7"/></svg>')}
          ${componentPicker("character", componentText("character.title", "Character"), componentText("character.none", "Character"), characterValue, '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>')}
        </div>
      </section>
      <section class="gen-batch-edit-section"><h4>${this._escape(this._t("references", "References"))}</h4>
        <div class="gen-batch-edit-grid">
          <label>${this._escape(this._t("refMode", "Ref mode"))}${selectUi("refMode", (mode === "frames" ? ["frames"] : ["all", "sequential", "mention", "none"]).map((v) => option(v, this._modeLabel(v), mode === v)).join(""), "ref-mode-select")}</label>
          <label data-batch-ref-count>${this._escape(this._t("refsPerPrompt", "Refs per prompt"))}<span class="input-group compact-qty"><button type="button" class="compact-qty-btn" data-action="ref-count-minus" aria-label="${this._escape(this._t("refsPerPrompt"))} \u2212">\u2212</button><input name="refCount" type="number" min="1" step="1" value="${this._escape(batch.refImagesPerPrompt || 1)}"><button type="button" class="compact-qty-btn" data-action="ref-count-plus" aria-label="${this._escape(this._t("refsPerPrompt"))} +">+</button></span></label>
          <fieldset data-batch-ref-pool><legend>${this._escape(this._t("refPool", "Ref pool"))}</legend><div class="gen-batch-ref-list"></div></fieldset>
          <button type="button" data-action="batch-pick-refs" data-batch-add-refs class="ref-btn-upload ref-btn-upload--wide gen-batch-ref-upload"><svg class="ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 8h.01"/><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"/><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"/><path d="M19 22v-6"/><path d="M22 19l-3 -3l-3 3"/></svg><span class="ref-btn-text">${this._escape(this._t("addReferences", "Add references"))}</span></button>
          <div class="gen-batch-editor-frame-pairs" hidden></div>
        </div>
      </section>
      <section class="gen-batch-edit-section"><h4>${this._escape(this._t("chain", "Continue from previous result"))}</h4>
        <div class="gen-batch-edit-grid">
          ${toggle("chain", this._t("chain", "Continue from previous result"), !!batch.settingsSnapshot?.chain)}
          <label data-batch-chain-policy>${this._escape(this._t("chainPolicy", "Chain references"))}${selectUi("chainPolicy", option("generated_only", this._t("generatedOnly", "Previous result only"), batch.settingsSnapshot?.chain?.refPolicy !== "generated_plus_mapped") + option("generated_plus_mapped", this._t("generatedPlusMapped", "Previous result and mapped refs"), batch.settingsSnapshot?.chain?.refPolicy === "generated_plus_mapped"))}</label>
        </div>
      </section>
      <section class="gen-batch-edit-section"><h4>${this._escape(this._t("download", "Download"))}</h4>
        <div class="gen-batch-edit-grid">
          ${toggle("download", this._t("autoDownload", "Auto download"), batch.autoDownload)}
          <div class="gen-batch-edit-grid gen-batch-edit-download-details" data-batch-download-details>
            <label>${this._escape(this._t("folder", "Folder"))}<span class="gen-batch-folder-control"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><input name="folder" value="${this._escape(batch.settingsSnapshot?.taskName || "")}"></span></label>
            <label data-batch-image-resolution>${this._escape(this._t("imageResolution", "Image download resolution"))}${selectUi("downloadResolution", downloadOptions(imageDownloads, batch.settingsSnapshot?.downloadResolution))}</label>
            <label data-batch-video-resolution>${this._escape(this._t("videoResolution", "Video download resolution"))}${selectUi("videoDownloadResolution", downloadOptions(videoDownloads, batch.settingsSnapshot?.videoDownloadResolution))}</label>
          </div>
        </div>
      </section>`,
    );
    this._renderBatchRefCards(batch, batch.refPool || []);
    if (batch.refMode === "frames")
      this.overlay.querySelector(
        '.gen-batch-editor [name="genType"] option[value="Image"]',
      ).disabled = true;
    this._refreshBatchPreview();
    this._hydrateBatchRefThumbs(batch, this._editor).catch(() => {});
  }
  _editDirectItem(job, row) {
    const itemId = row?.dataset.itemId;
    const item = job?.items?.find((entry) => entry.id === itemId);
    if (!item || !job.sessionId || job.projectId !== this._scope()?.projectId)
      throw new Error("BATCH_ITEM_IN_FLIGHT");
    const settings = { ...(job.settings || {}), ...(item.settings || {}) };
    const genType = item.genType || settings.genType || "Image";
    const media = String(genType).toLowerCase() === "video" ? "video" : "image";
    const model = item.model || settings.model || "";
    const ratio = item.ratio || settings.ratio || "";
    const quantity = Number(item.quantity || settings.quantity || 1);
    const models =
      window.ModelRegistry?.safeGetModelsSync?.("flow", media) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.("flow", media) || [];
    const range =
      window.ProviderConfigManager?.safeGetQuantityRangeSync?.("flow");
    const option = (value, label, selected) =>
      `<option value="${this._escape(value)}"${selected ? " selected" : ""}>${this._escape(label)}</option>`;
    const selectUi = (name, options) =>
      `<span class="input-group select-group compact-select"><select name="${name}">${options}</select><svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    const modelOptions = (
      models.some((entry) => entry.value === model)
        ? []
        : [{ value: model, name: model }]
    )
      .concat(models)
      .map((entry) =>
        option(
          entry.value,
          entry.name || entry.label || entry.value,
          entry.value === model,
        ),
      )
      .join("");
    const ratioOptions =
      ratios
        .map((entry) => {
          const value = typeof entry === "string" ? entry : entry.value;
          const label =
            typeof entry === "string" ? entry : entry.label || value;
          return option(
            value,
            `${window.GenTab?._ratioIcon?.(value) || ""} ${label}`.trim(),
            value === ratio,
          );
        })
        .join("") +
      (ratios.some(
        (entry) => (typeof entry === "string" ? entry : entry.value) === ratio,
      )
        ? ""
        : option(ratio, ratio, true));
    const modelConfig =
      models.find((entry) => entry.value === model)?.config || {};
    const durations =
      media === "video"
        ? window.ProviderConfigManager?.safeGetVideoDurationsSync?.(
            "flow",
            modelConfig.duration_tier || "default",
          ) || []
        : [];
    const resolutions =
      media === "video"
        ? window.ModelRegistry?.getGenerationResolutionConfig?.("flow", model)
            ?.options || []
        : [];
    const refIds = [...new Set((item.refFileIds || []).filter(Boolean))];
    const refs = refIds
      .map((id, index) => {
        const url = this._refThumbUrl(
          { batchId: `direct:${job.id}` },
          this._directRef(item, id),
        );
        const label = this._escape(
          item.refFileNames?.[id] || `Reference ${index + 1}`,
        );
        return `<span class="gen-batch-ref-choice" data-ref-key="${this._escape(id)}" aria-label="${label}"><span class="gen-batch-ref-choice-thumb">${url ? `<img src="${this._escape(url)}" data-ref-repair-key="${this._escape(`direct:${job.id}|${id}`)}" alt="">` : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>'}</span></span>`;
      })
      .join("");
    this._openEditor(
      {
        kind: "direct-item",
        projectId: job.projectId,
        sessionId: job.sessionId,
        jobId: job.id,
        itemId,
        originalPrompt: item.prompt || item.promptText || "",
        genType,
        originalSettings: {
          model,
          ratio,
          quantity,
          flowVideoDuration: settings.flowVideoDuration || null,
          flowVideoResolution: settings.flowVideoResolution || null,
          flowThinkingLevel: settings.flowThinkingLevel || null,
        },
        refIds,
        refFileNames: { ...(item.refFileNames || {}) },
        refThumbnails: { ...(item.refThumbnails || {}) },
        refImageMode: item.refImageMode || "none",
        mentionData: item.mentionData || null,
      },
      this._t("editPrompt", "Edit prompt"),
      `<label>${this._escape(this._t("prompt", "Prompt"))}<span class="prompt-editor-wrapper"><textarea name="prompt" rows="6">${this._escape(item.prompt || item.promptText || "")}</textarea></span></label>
      <label>${this._escape(this._t("model", "Model"))}${selectUi("model", modelOptions)}</label>
      <label>${this._escape(this._t("ratio", "Ratio"))}${selectUi("ratio", ratioOptions)}</label>
      <label>${this._escape(this._t("quantity", "Quantity"))}<span class="input-group compact-qty"><button type="button" class="compact-qty-btn" data-action="quantity-minus" aria-label="${this._escape(this._t("quantity", "Quantity"))} \u2212">\u2212</button><input name="quantity" type="number" min="1" ${range?.max ? `max="${this._escape(range.max)}"` : ""} value="${this._escape(quantity)}"><button type="button" class="compact-qty-btn" data-action="quantity-plus" aria-label="${this._escape(this._t("quantity", "Quantity"))} +">+</button></span></label>
      ${
        media === "image" &&
        window.ModelRegistry?.getThinkingLevelConfig?.("flow", model)
          ? `<label>${this._escape(window.I18n?.t("flow.thinkingLevel") || "")}${selectUi(
              "flowThinkingLevel",
              window.ModelRegistry.getThinkingLevelConfig("flow", model)
                .options.map((o) =>
                  option(
                    o.value,
                    o.label,
                    o.value ===
                      (settings.flowThinkingLevel ||
                        window.ModelRegistry.getThinkingLevelConfig(
                          "flow",
                          model,
                        ).default),
                  ),
                )
                .join(""),
            )}</label>`
          : ""
      }
      ${
        media === "video"
          ? `<label ${durations.length ? "" : "hidden"}>${this._escape(this._t("duration", "Duration"))}${selectUi("duration", durations.map((value) => option(value, value, value === settings.flowVideoDuration)).join(""))}</label>
        <label ${resolutions.length ? "" : "hidden"}>${this._escape(this._t("videoResolution", "Video resolution"))}${selectUi("videoResolution", resolutions.map((entry) => option(entry.value, entry.label || entry.value, entry.value === settings.flowVideoResolution)).join(""))}</label>`
          : ""
      }
      ${refs ? `<fieldset class="gen-batch-item-refs"><legend>${this._escape(this._t("references", "References"))}</legend><div class="gen-batch-ref-choices">${refs}</div></fieldset>` : ""}
      ${this._itemEvidenceHtml(item, {
        downloadable:
          this._downloadResults(
            this._directDownloadBatch(job),
            job.items.findIndex((entry) => entry.id === itemId),
          ).length > 0,
      })}`,
    );
  }
  async _saveDirectItemEditor(editor, sheet) {
    const prompt = sheet.querySelector('[name="prompt"]')?.value.trim();
    if (!prompt) throw new Error("BATCH_PROMPT_EMPTY");
    const model = sheet.querySelector('[name="model"]')?.value || "";
    const ratio = sheet.querySelector('[name="ratio"]')?.value || "";
    const quantity = Number(sheet.querySelector('[name="quantity"]')?.value);
    if (!model || !ratio || !Number.isSafeInteger(quantity) || quantity < 1)
      throw new Error("BATCH_ITEM_SETTINGS_INVALID");
    const duration =
      sheet.querySelector('[name="duration"]')?.value ||
      editor.originalSettings.flowVideoDuration ||
      null;
    const videoResolution =
      sheet.querySelector('[name="videoResolution"]')?.value ||
      editor.originalSettings.flowVideoResolution ||
      null;
    const flowThinkingLevel =
      editor.genType === "Image"
        ? window.ModelRegistry?.getThinkingLevelValue?.(
            "flow",
            model,
            sheet.querySelector('[name="flowThinkingLevel"]')?.value ||
              editor.originalSettings.flowThinkingLevel,
          )
        : null;
    const owner = this._scope();
    if (!owner || owner.projectId !== editor.projectId)
      throw new Error("BATCH_SCOPE_CHANGED");
    const job = this.queue.getJob?.(editor.jobId);
    if (
      job &&
      (job.projectId !== editor.projectId ||
        job.owner !== "prompts" ||
        !job.items?.some((item) => item.id === editor.itemId))
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    let queueAck;
    if (job) {
      const source = {
        prompt,
        settingsOverride: {
          model,
          ratio,
          quantity,
          flowVideoDuration: duration,
          flowVideoResolution: videoResolution,
          flowThinkingLevel,
        },
        refFileIds: editor.refIds,
        refFileNames: editor.refFileNames,
        refThumbnails: editor.refThumbnails,
        refImageMode: editor.refImageMode,
        mentionData: editor.mentionData,
      };
      if (
        job.items.find((item) => item.id === editor.itemId)?.state === "PENDING"
      ) {
        queueAck = await this.queue.updatePendingPromptItem(
          editor.projectId,
          editor.jobId,
          editor.itemId,
          source,
        );
        if (!queueAck?.ok && queueAck?.error !== "PROMPT_ITEM_IN_FLIGHT")
          throw new Error(queueAck?.error || "PROMPT_SAVE_FAILED");
      }
      if (!queueAck?.ok)
        queueAck = {
          ok: this.queue.updateTerminalPromptSource(
            editor.projectId,
            editor.jobId,
            editor.itemId,
            source,
          ),
        };
    } else {
      queueAck = await this.queue.updateTrackerPrompt(
        editor.projectId,
        editor.jobId,
        editor.itemId,
        prompt,
      );
    }
    if (!queueAck?.ok) throw new Error(queueAck?.error || "PROMPT_SAVE_FAILED");
    const cacheAck = await chrome.runtime.sendMessage({
      action: "ft:updateHistoryItem",
      projectId: editor.projectId,
      sessionId: editor.sessionId,
      jobId: editor.jobId,
      itemId: editor.itemId,
      patch: {
        prompt,
        model,
        ratio,
        quantity,
        genType: editor.genType,
        flowVideoDuration: duration,
        flowVideoResolution: videoResolution,
        flowThinkingLevel,
        refFileIds: editor.refIds,
        refFileNames: editor.refFileNames,
        refThumbnails: editor.refThumbnails,
        refImageMode: editor.refImageMode,
        mentionData: editor.mentionData,
      },
    });
    if (
      !cacheAck?.ok ||
      (cacheAck.cached === false && queueAck.cachedOnly === true)
    ) {
      this._closeEditor();
      await this.reload();
      throw new Error(cacheAck?.error || "CACHE_SAVE_FAILED");
    }
    this._closeEditor();
    await this.reload();
    this._notify(window.I18n?.t?.("common.saved") || "Saved", "success");
  }
  _editItem(card, batch, row) {
    if (!batch || !row) return;
    const index = Number(row.dataset.itemIndex);
    const item = batch.items[index];
    if (!item) return;
    const live = this._liveJobs().find((job) => job.id === batch.jobId);
    const rootId = batch.runtimeItemIds?.[index];
    const runtimeItem =
      this._runtimeItemByRoot(live?.items, rootId) ||
      this._runtimeItemByRoot(
        this._jobForBatchItem(batch, index)?.items,
        rootId,
      );
    const receipt = batch.terminalItems?.[index];
    const evidenceItem = {
      ...receipt,
      ...item,
      ...runtimeItem,
      state: runtimeItem?.state || receipt?.state || item.state,
      error: runtimeItem?.error || receipt?.error || item.error,
      results: runtimeItem?.results?.length
        ? runtimeItem.results
        : this._receiptResults(batch, index),
    };
    if (this._isItemProcessing(evidenceItem))
      throw new Error("BATCH_ITEM_IN_FLIGHT");
    const runtimeState = runtimeItem?.state;
    const runtimeEditing =
      runtimeItem?.id === rootId &&
      runtimeState === "PENDING" &&
      ["running", "paused"].includes(batch.status);
    const runtimeTerminal = [
      "COMPLETED",
      "PARTIAL_FAIL",
      "FAILED",
      "CANCELLED",
      "BLOCKED",
    ].includes(evidenceItem.state);
    const settings = batch.settingsSnapshot || {};
    const media = settings.genType === "Video" ? "video" : "image";
    const models =
      window.ModelRegistry?.safeGetModelsSync?.("flow", media) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.("flow", media) || [];
    const range =
      window.ProviderConfigManager?.safeGetQuantityRangeSync?.("flow");
    if (!models.length || !ratios.length || !range)
      throw new Error("BATCH_CONFIG_UNAVAILABLE");
    const currentModel = item.settingsOverride?.model || settings.model;
    const currentRatio = item.settingsOverride?.ratio || settings.ratio;
    const option = (value, label, selected) =>
      `<option value="${this._escape(value)}"${selected ? " selected" : ""}>${this._escape(label)}</option>`;
    const selectUi = (name, options, attrs = "") =>
      `<span class="input-group select-group compact-select"><select name="${name}" ${attrs}>${options}</select><svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    const ratioLabel = (value, label) =>
      `${typeof window.GenTab?._ratioIcon === "function" ? window.GenTab._ratioIcon(value) : ""} ${label}`.trim();
    const terminal =
      runtimeTerminal ||
      (!runtimeEditing &&
        (batch.status !== "queued" || !!batch.resumeItemIndexes));
    if (
      !terminal &&
      (!models.some((model) => model.value === currentModel) ||
        !ratios.some(
          (entry) =>
            (typeof entry === "string" ? entry : entry.value) === currentRatio,
        ))
    )
      throw new Error("BATCH_MODEL_OR_RATIO_UNAVAILABLE");
    const modelOptions = (
      models.some((model) => model.value === currentModel)
        ? []
        : [{ value: currentModel, name: currentModel }]
    )
      .concat(models)
      .map((model) =>
        option(
          model.value,
          model.name || model.label || model.value,
          model.value === currentModel,
        ),
      )
      .join("");
    const ratioOptions =
      ratios
        .map((entry) => {
          const value = typeof entry === "string" ? entry : entry.value;
          return option(
            value,
            ratioLabel(
              value,
              typeof entry === "string" ? entry : entry.label || value,
            ),
            value === currentRatio,
          );
        })
        .join("") +
      (ratios.some(
        (entry) =>
          (typeof entry === "string" ? entry : entry.value) === currentRatio,
      )
        ? ""
        : option(currentRatio, ratioLabel(currentRatio, currentRatio), true));
    const chosenModel = models.find((model) => model.value === currentModel);
    const durations =
      media === "video"
        ? window.ProviderConfigManager?.safeGetVideoDurationsSync?.(
            "flow",
            chosenModel?.config?.duration_tier || "default",
          ) || []
        : [];
    const resolutionConfig =
      media === "video"
        ? window.ModelRegistry?.getGenerationResolutionConfig?.(
            "flow",
            currentModel,
          )
        : null;
    const durationValue =
      item.settingsOverride?.flowVideoDuration ||
      settings.flowVideoDuration ||
      "";
    const resolutionValue =
      item.settingsOverride?.flowVideoResolution ||
      settings.flowVideoResolution ||
      "";
    const inputTypeValue =
      item.settingsOverride?.videoInputType || settings.videoInputType || "";
    const inputTypes = [...(window.GenTab?.videoInputTypeSelect?.options || [])]
      .filter((entry) => entry.value && !entry.disabled && !entry.hidden)
      .map((entry) => ({
        value: entry.value,
        label: entry.textContent || entry.value,
      }));
    if (
      inputTypeValue &&
      !inputTypes.some((entry) => entry.value === inputTypeValue)
    )
      inputTypes.unshift({ value: inputTypeValue, label: inputTypeValue });
    const videoFields =
      media === "video"
        ? `
      <label data-tooltip="${this._escape(this._t("routeConflict", "Input type belongs to the batch route"))}">${this._escape(this._t("inputType", "Mode"))}${selectUi("inputType", inputTypes.map((entry) => option(entry.value, entry.label, entry.value === inputTypeValue)).join(""), "disabled")}</label>
      <label ${durations.length ? "" : "hidden"}>${this._escape(this._t("duration", "Duration"))}${selectUi("duration", durations.map((value) => option(value, value, value === durationValue)).join(""), durations.length ? "" : "disabled")}</label>
      <label ${resolutionConfig?.options?.length ? "" : "hidden"}>${this._escape(this._t("videoResolution", "Video resolution"))}${selectUi("videoResolution", (resolutionConfig?.options || []).map((entry) => option(entry.value, entry.label || entry.value, entry.value === resolutionValue)).join(""), resolutionConfig?.options?.length ? "" : "disabled")}</label>`
        : "";
    const references = (batch.refPool || [])
      .filter((ref) => item.refKeys?.includes(ref.refKey))
      .map((ref, slot) => {
        const label = /^[a-f\d]{8}-[a-f\d-]{27,}$/i.test(ref.name || "")
          ? `Reference ${slot + 1}`
          : ref.name || `Reference ${slot + 1}`;
        return this._itemRefChoiceHtml(batch, ref, label);
      })
      .join("");
    const chainLaterFrame =
      batch.refMode === "frames" &&
      settings.chain?.kind === "video_last_frame" &&
      index > 0;
    const frameOptions = (selected) =>
      option("", "\u2014", !selected) +
      (batch.refPool || [])
        .filter((ref) => ref.mediaType !== "video")
        .map((ref) =>
          option(ref.refKey, ref.name || ref.refKey, ref.refKey === selected),
        )
        .join("");
    this._openEditor(
      {
        kind: "item",
        batchId: batch.batchId,
        revision: batch.revision,
        sourceFingerprint: this._batchEditorSource(batch),
        index,
        itemId: runtimeItem?.id || batch.runtimeItemIds?.[index] || null,
        runtime: runtimeEditing && !runtimeTerminal,
        terminal,
      },
      this._t("editPrompt", "Edit prompt"),
      `
      <label>${this._escape(this._t("prompt", "Prompt"))}<span class="prompt-editor-wrapper"><textarea name="prompt" rows="6">${this._escape(item.prompt)}</textarea></span></label>
      <label>${this._escape(this._t("model", "Model"))}${selectUi("model", modelOptions)}</label>
      <label>${this._escape(this._t("ratio", "Ratio"))}${selectUi("ratio", ratioOptions)}</label>
      <label>${this._escape(this._t("quantity", "Quantity"))}<span class="input-group compact-qty"><button type="button" class="compact-qty-btn" data-action="quantity-minus" aria-label="${this._escape(this._t("quantity", "Quantity"))} \u2212">\u2212</button><input name="quantity" type="number" min="${this._escape(range.min)}" max="${this._escape(range.max)}" value="${this._escape(item.settingsOverride?.quantity || settings.quantity || 1)}"><button type="button" class="compact-qty-btn" data-action="quantity-plus" aria-label="${this._escape(this._t("quantity", "Quantity"))} +">+</button></span></label>
      ${videoFields}
      ${batch.refMode === "frames" ? this._itemFrameEditorHtml(batch, item, chainLaterFrame, frameOptions, true) : `<fieldset class="gen-batch-item-refs"><legend>${this._escape(this._t("references", "References"))}</legend><div class="gen-batch-ref-choices">${references}</div>${references ? "" : `<p class="gen-batch-ref-empty">${this._escape(this._t("noReferences"))}</p>`}</fieldset>`}
      ${batch.refMode !== "frames" ? `<button type="button" data-action="item-pick-refs" class="ref-btn-upload ref-btn-upload--wide gen-batch-ref-upload gen-batch-item-add-refs"><svg class="ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 8h.01"/><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"/><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"/><path d="M19 22v-6"/><path d="M22 19l-3 -3l-3 3"/></svg><span class="ref-btn-text">${this._escape(this._t("addReferences", "Add references"))}</span></button>` : ""}
      ${this._itemEvidenceHtml(this._itemEvidenceForEditor(evidenceItem, batch, index), { downloadable: this._downloadResults(batch, index).length > 0 })}`,
    );
    if (batch.refMode === "frames") {
      this._renderItemFrameSources(batch);
      this._hydrateBatchRefThumbs(batch, this._editor).catch(() => {});
    }
    this._bindItemMentionMenu(batch);
  }
  async _resolveTerminalBatchRefs(next, assets) {
    const pending = (next.refPool || []).filter((ref) =>
      ref.refKey?.startsWith("upload_"),
    );
    if (!pending.length) return;
    if (typeof window.uploadPendingFiles !== "function")
      throw new Error("BATCH_UPLOAD_UNAVAILABLE");
    const byKey = new Map((assets || []).map((asset) => [asset.refKey, asset]));
    const aliases = new Map();
    window.pendingUploadFiles || (window.pendingUploadFiles = new Map());
    try {
      for (const ref of pending) {
        const asset = byKey.get(ref.refKey);
        if (!(asset?.file instanceof Blob) || !asset.file.size)
          throw new Error("BATCH_ASSET_MISSING");
        const alias = `upload_${crypto.randomUUID()}`;
        aliases.set(ref.refKey, alias);
        window.pendingUploadFiles.set(alias, { file: asset.file });
      }
      await window.uploadPendingFiles([...aliases.values()].join(", "), {
        surface: "batch",
      });
      const uploaded = window._lastUploadKeyMapping || {};
      const replacements = new Map();
      for (const ref of pending) {
        const id = uploaded[aliases.get(ref.refKey)];
        if (!id || String(id).startsWith("upload_"))
          throw new Error("BATCH_UPLOAD_INCOMPLETE");
        const identity = window.MediaRegistry?.getRefIdentity?.(id) || {};
        replacements.set(ref.refKey, id);
        ref.refKey = id;
        ref.fileName = identity.file_name || ref.fileName || null;
        ref.mediaUuid = identity.media_uuid || ref.mediaUuid || null;
        ref.mediaType = identity.type || ref.mediaType || "image";
      }
      for (const item of next.items)
        item.refKeys = (item.refKeys || []).map(
          (key) => replacements.get(key) || key,
        );
      const remapFrame = (frame) =>
        frame && typeof frame === "object"
          ? {
              ...frame,
              frame1: replacements.get(frame.frame1) || frame.frame1,
              frame2: replacements.get(frame.frame2) || frame.frame2,
            }
          : frame;
      next.frameFileIds = Array.isArray(next.frameFileIds)
        ? next.frameFileIds.map(remapFrame)
        : remapFrame(next.frameFileIds);
    } finally {
      for (const alias of aliases.values())
        window.pendingUploadFiles.delete(alias);
    }
  }
  async _syncTerminalBatchSources(batch, next) {
    const rootJob = this.queue.getJob?.(batch.jobId);
    for (let index = 0; index < next.items.length; index++) {
      const item = next.items[index];
      if (item.hidden) continue;
      const itemId = batch.runtimeItemIds?.[index];
      if (!itemId) continue;
      const effective = { ...next.settingsSnapshot, ...item.settingsOverride };
      const refs = (next.refPool || []).filter((ref) =>
        item.refKeys?.includes(ref.refKey),
      );
      const refFileNames = Object.fromEntries(
        refs
          .filter((ref) => ref.fileName || ref.mediaUuid)
          .map((ref) => [ref.refKey, ref.mediaUuid || ref.fileName]),
      );
      const refThumbnails = Object.fromEntries(
        refs
          .map((ref) => [
            ref.refKey,
            window.MediaRegistry?.getRefIdentity?.(ref.refKey) ||
              rootJob?.items?.find((entry) => entry.id === itemId)
                ?.refThumbnails?.[ref.refKey] ||
              null,
          ])
          .filter(([, identity]) => identity),
      );
      const refImageMode =
        next.refMode === "frames"
          ? Array.isArray(next.frameFileIds)
            ? "sequential"
            : "all"
          : next.refMode;
      const runtime = rootJob?.items?.find((entry) => entry.id === itemId);
      if (runtime && !runtime.isTerminal) continue;
      if (runtime) {
        const ok = this.queue.updateTerminalPromptSource(
          batch.projectId,
          batch.jobId,
          itemId,
          {
            prompt: item.prompt,
            settingsOverride: effective,
            refFileIds: item.refKeys || [],
            refFileNames,
            refThumbnails,
            refImageMode,
            mentionData: item.mentionData || null,
            autoDownload: next.autoDownload,
            downloadResolution: effective.downloadResolution,
            videoDownloadResolution: effective.videoDownloadResolution,
            taskName: effective.taskName,
          },
        );
        if (!ok) throw new Error("BATCH_LOCAL_SAVED_REGEN_SOURCE_UNAVAILABLE");
      }
      if (!batch.trackerSessionId) continue;
      const cache = await chrome.runtime.sendMessage({
        action: "ft:updateHistoryItem",
        projectId: batch.projectId,
        sessionId: batch.trackerSessionId,
        jobId: batch.jobId,
        itemId,
        skipBatchSync: true,
        patch: {
          prompt: item.prompt,
          model: effective.model,
          ratio: effective.ratio,
          genType: effective.genType,
          quantity: effective.quantity,
          refFileIds: item.refKeys || [],
          refFileNames,
          refThumbnails,
          refImageMode,
          mentionData: item.mentionData || null,
          flowVideoDuration: effective.flowVideoDuration || null,
          flowVideoResolution: effective.flowVideoResolution || null,
          flowThinkingLevel: effective.flowThinkingLevel || null,
          voice: effective.voice || null,
          character: effective.character || null,
          autoDownload: next.autoDownload,
          downloadResolution: effective.downloadResolution,
          videoDownloadResolution: effective.videoDownloadResolution,
          taskName: effective.taskName,
        },
      });
      if (!cache?.ok)
        throw new Error(
          `BATCH_LOCAL_SAVED_TRACKER_CACHE_FAILED:${cache?.error || "NO_ACK"}`,
        );
    }
  }
  async _saveEditor() {
    const editor = this._editor;
    if (!editor || this._busy || editor.pickerBusy) return;
    const sheet = this.overlay.querySelector(".gen-batch-editor");
    if (editor.kind === "direct-item") {
      this._busy = true;
      try {
        await this._saveDirectItemEditor(editor, sheet);
      } finally {
        this._busy = false;
      }
      return;
    }
    const field = (name) => sheet.querySelector(`[name="${name}"]`);
    const owner = this._scope();
    const batch = await this.store.get(
      owner.userId,
      owner.projectId,
      editor.batchId,
    );
    if (
      !batch ||
      (batch.revision !== editor.revision &&
        (!editor.sourceFingerprint ||
          editor.sourceFingerprint !== this._batchEditorSource(batch)))
    )
      throw new Error("BATCH_REVISION_CONFLICT");
    this._busy = true;
    try {
      if (editor.kind === "batch") {
        const terminalEdit =
          batch.status !== "queued" || !!batch.resumeItemIndexes;
        const route = this._currentRunRoute();
        const mode = field("refMode").value;
        if (batch.refMode === "frames" && mode !== "frames")
          throw new Error("BATCH_FRAMES_MODE_REQUIRED");
        const selectedRefs = this._batchEditorRefs(sheet, batch);
        const newAssets = selectedRefs
          .map((ref) => editor.pickerAssets?.get(ref.refKey))
          .filter(Boolean);
        const next = structuredClone(batch);
        if (terminalEdit && editor.deletedIndexes?.size)
          throw new Error("BATCH_EDIT_UNAVAILABLE");
        if (!terminalEdit && editor.deletedIndexes?.size) {
          next.items = next.items.filter(
            (_, index) => !editor.deletedIndexes.has(index),
          );
          if (Array.isArray(next.frameFileIds))
            next.frameFileIds = next.frameFileIds.filter(
              (_, index) => !editor.deletedIndexes.has(index),
            );
          if (!next.items.length) throw new Error("BATCH_LAST_PROMPT_REQUIRED");
          if (
            next.refMode === "frames" &&
            next.settingsSnapshot?.chain?.kind === "video_last_frame" &&
            editor.deletedIndexes.has(0) &&
            Array.isArray(next.frameFileIds)
          )
            next.frameFileIds[0] = {
              frame1:
                editor.framePairs?.[0]?.frame1 ||
                batch.frameFileIds?.[0]?.frame1 ||
                "",
              frame2: next.frameFileIds[0]?.frame2 || "",
            };
        }
        if (mode === "frames" && Array.isArray(editor.framePairs))
          next.frameFileIds = batch.items
            .map((_, index) => editor.framePairs[index])
            .filter((_, index) => !editor.deletedIndexes?.has(index))
            .map((pair) => ({
              frame1: pair?.frame1 || "",
              frame2: pair?.frame2 || "",
            }));
        if (
          mode === "frames" &&
          editor.deletedIndexes?.has(0) &&
          batch.settingsSnapshot?.chain?.kind === "video_last_frame" &&
          Array.isArray(next.frameFileIds) &&
          next.frameFileIds[0]
        )
          next.frameFileIds[0].frame1 =
            editor.framePairs?.[0]?.frame1 ||
            batch.frameFileIds?.[0]?.frame1 ||
            "";
        next.refMode = mode;
        next.refPool =
          mode === "none" && batch.refMode !== "none" ? [] : selectedRefs;
        const genType = field("genType").value;
        const model = field("model").value;
        const ratio = field("ratio").value;
        const media = genType === "Video" ? "video" : "image";
        if (
          !["Image", "Video"].includes(genType) ||
          ((genType !== batch.settingsSnapshot.genType ||
            model !== batch.settingsSnapshot.model) &&
            !window.ModelRegistry?.safeGetModelsSync?.("flow", media)?.some(
              (entry) => entry.value === model,
            )) ||
          ((genType !== batch.settingsSnapshot.genType ||
            ratio !== batch.settingsSnapshot.ratio) &&
            !window.ProviderConfigManager?.safeGetRatiosSync?.(
              "flow",
              media,
            )?.some(
              (entry) =>
                (typeof entry === "string" ? entry : entry.value) === ratio,
            ))
        )
          throw new Error("BATCH_MODEL_OR_RATIO_UNAVAILABLE");
        if (mode === "frames" && genType !== "Video")
          throw new Error("BATCH_FRAMES_MODE_REQUIRED");
        next.settingsSnapshot.genType = genType;
        next.settingsSnapshot.model = model;
        next.settingsSnapshot.ratio = ratio;
        const mediaChanged = genType !== batch.settingsSnapshot.genType;
        const modelChanged = model !== batch.settingsSnapshot.model;
        if (mediaChanged) {
          next.settingsSnapshot.isFrames = false;
          next.settingsSnapshot.videoInputType =
            genType === "Video" ? "Ingredients" : null;
          next.settingsSnapshot.flowVideoDuration = null;
          next.settingsSnapshot.flowVideoResolution = null;
          next.settingsSnapshot.voice = null;
        }
        if (genType === "Video") {
          next.settingsSnapshot.isFrames = mode === "frames";
          next.settingsSnapshot.videoInputType =
            mode === "frames" ? "Frames" : "Ingredients";
          next.settingsSnapshot.flowVideoDuration =
            field("flowVideoDuration")?.value || null;
          next.settingsSnapshot.flowVideoResolution =
            field("flowVideoResolution")?.value || null;
        } else {
          next.settingsSnapshot.isFrames = false;
          next.settingsSnapshot.videoInputType = null;
          next.settingsSnapshot.flowVideoDuration = null;
          next.settingsSnapshot.flowVideoResolution = null;
        }
        next.settingsSnapshot.flowThinkingLevel =
          genType === "Image"
            ? window.ModelRegistry?.getThinkingLevelValue?.(
                "flow",
                model,
                field("flowThinkingLevel")?.value,
              )
            : null;
        const componentModel = window.ModelRegistry.findModel("flow", model);
        const voiceSlug = field("voice")?.value || "";
        const characterValue = field("character")?.value || "";
        if (
          mode === "frames" ||
          genType !== "Video" ||
          componentModel?.config?.supports_voice !== true
        ) {
          next.settingsSnapshot.voice = null;
        } else if (!voiceSlug) {
          next.settingsSnapshot.voice = null;
        } else if (voiceSlug === batch.settingsSnapshot?.voice?.slug) {
          next.settingsSnapshot.voice = structuredClone(
            batch.settingsSnapshot.voice,
          );
        } else {
          const voice = window.VoiceRegistry?.findBySlug?.(voiceSlug);
          if (!voice?.search_value) throw new Error("BATCH_VOICE_UNAVAILABLE");
          next.settingsSnapshot.voice = {
            slug: voice.slug,
            search_value: voice.search_value,
          };
        }
        if (
          mode === "frames" ||
          componentModel?.config?.supports_character !== true ||
          !characterValue
        ) {
          next.settingsSnapshot.character = null;
        } else if (
          characterValue ===
          (window.CharacterRegistry?.selectionValue?.(
            batch.settingsSnapshot?.character,
          ) || "")
        ) {
          next.settingsSnapshot.character = structuredClone(
            batch.settingsSnapshot.character,
          );
        } else {
          const character = window.CharacterRegistry?.payload?.(characterValue);
          if (!character?.search_value)
            throw new Error("BATCH_CHARACTER_UNAVAILABLE");
          next.settingsSnapshot.character = character;
        }
        if (
          !terminalEdit &&
          route === "api" &&
          (next.settingsSnapshot.voice?.search_value ||
            next.settingsSnapshot.character?.search_value)
        )
          throw new Error("BATCH_API_WEB_COMPONENT_CONFLICT");
        if (genType === "Video") {
          const modelConfig = window.ModelRegistry.findModel("flow", model);
          const durations =
            window.ProviderConfigManager?.safeGetVideoDurationsSync?.(
              "flow",
              modelConfig?.config?.duration_tier || "default",
            ) || [];
          if (!durations.length)
            throw new Error("BATCH_VIDEO_DURATION_UNAVAILABLE");
          if (!durations.includes(next.settingsSnapshot.flowVideoDuration))
            next.settingsSnapshot.flowVideoDuration = durations[0];
          const forced = window.ProviderRegistry?.get?.(
            "flow",
          )?.getDurationOverride?.({
            modelValue: model,
            hasRef: next.refPool.length > 0,
            hasRefVideo: next.refPool.some((ref) => ref.mediaType === "video"),
            inputType: mode === "frames" ? "Frames" : "Ingredients",
          });
          if (forced) next.settingsSnapshot.flowVideoDuration = forced;
          const resolutions =
            window.ModelRegistry?.getGenerationResolutionConfig?.("flow", model)
              ?.options || [];
          if (
            resolutions.length &&
            !resolutions.some(
              (entry) =>
                entry.value === next.settingsSnapshot.flowVideoResolution,
            )
          )
            next.settingsSnapshot.flowVideoResolution = resolutions[0].value;
        }
        for (const item of next.items) {
          for (const key of ["genType", "model", "ratio"])
            delete item.settingsOverride?.[key];
          if (mediaChanged || modelChanged)
            for (const key of [
              "isFrames",
              "videoInputType",
              "flowVideoDuration",
              "flowVideoResolution",
              "flowThinkingLevel",
            ])
              delete item.settingsOverride?.[key];
        }
        next.refImagesPerPrompt = window.RefImageAssignment.count(
          field("refCount").value,
        );
        next.autoDownload = field("download").checked;
        next.settingsSnapshot.taskName = field("folder").value.trim() || null;
        next.settingsSnapshot.downloadResolution =
          field("downloadResolution").value || null;
        next.settingsSnapshot.videoDownloadResolution =
          field("videoDownloadResolution").value || null;
        if (field("chain").checked) {
          const genType2 = next.settingsSnapshot.genType;
          const chain = {
            enabled: true,
            kind: genType2 === "Video" ? "video_last_frame" : "image_result",
            refPolicy:
              genType2 === "Video"
                ? "generated_plus_mapped"
                : field("chainPolicy").value,
          };
          const userSettings = window.storageSettings?.getSettings?.() || {};
          const componentChecks = {
            voicePayload: !!next.settingsSnapshot.voice?.search_value,
            characterPayload: !!next.settingsSnapshot.character?.search_value,
            promptMentions: next.items.some((item) =>
              window.MentionParser?.hasComponents?.(item.prompt),
            ),
          };
          const validation = await window.GenTab._validateChain(
            next.items.map((item) => item.prompt),
            genType2,
            "flow",
            route === "web" ? "web" : null,
            {
              chain,
              route,
              quantity: next.settingsSnapshot.quantity,
              videoInputType: next.settingsSnapshot.videoInputType,
              hasRefs: next.refPool.length > 0,
              settings: userSettings,
              componentState: {
                checks: componentChecks,
                hasWebOnlyComponents:
                  Object.values(componentChecks).some(Boolean),
              },
            },
          );
          if (!validation?.ok)
            throw new Error(validation?.message || "BATCH_CHAIN_UNAVAILABLE");
          next.settingsSnapshot.chain = validation.chain;
          next.sequentialMode = true;
          if (chain.kind === "video_last_frame" && next.refMode === "frames") {
            if (
              !batch.settingsSnapshot?.chain &&
              (!next.settingsSnapshot.chainRefMode ||
                next.settingsSnapshot.chainRefMode === "none")
            )
              next.settingsSnapshot.chainRefMode = "all";
            this._mapVideoChainDraftFrames(next, batch);
          }
        } else {
          if (
            next.settingsSnapshot.chain?.kind === "video_last_frame" &&
            next.refMode === "frames"
          ) {
            const first = Array.isArray(next.frameFileIds)
              ? next.frameFileIds[0]
              : next.frameFileIds;
            next.frameFileIds = next.items.map(() => ({
              frame1: first?.frame1 || "",
              frame2: first?.frame2 || "",
            }));
          }
          next.settingsSnapshot.chain = null;
        }
        const refsChanged =
          !terminalEdit ||
          next.refMode !== batch.refMode ||
          next.refImagesPerPrompt !== batch.refImagesPerPrompt ||
          JSON.stringify((next.refPool || []).map((ref) => ref.refKey)) !==
            JSON.stringify((batch.refPool || []).map((ref) => ref.refKey));
        window.GenBatchDraftBuilder.remapDraft(next);
        if (terminalEdit && !refsChanged)
          next.items.forEach((item, index) => {
            item.refKeys = [...(batch.items[index].refKeys || [])];
            item.refOverride = batch.items[index].refOverride;
            item.mentionData = structuredClone(
              batch.items[index].mentionData || null,
            );
          });
        if (!terminalEdit) {
          window.GenBatchAdmission._validate(next, { allowPending: true });
          await window.GenBatchAdmission._validateItems(next);
        }
        if (terminalEdit) {
          await this.store.update(
            owner.userId,
            owner.projectId,
            batch.batchId,
            batch.revision,
            (current) => ({
              ...current,
              flowExecutionMode: next.flowExecutionMode,
              sequentialMode: next.sequentialMode,
              refMode: next.refMode,
              refPool: next.refPool,
              refImagesPerPrompt: next.refImagesPerPrompt,
              frameFileIds: next.frameFileIds,
              autoDownload: next.autoDownload,
              settingsSnapshot: next.settingsSnapshot,
              items: next.items,
            }),
            newAssets,
          );
          try {
            await this._syncTerminalBatchSources(batch, next);
          } catch (error) {
            this._closeEditor();
            await this.reload();
            throw error;
          }
        } else {
          await this.store.updateDraft(
            owner.userId,
            owner.projectId,
            batch.batchId,
            batch.revision,
            (current) => ({
              ...current,
              flowExecutionMode: next.flowExecutionMode,
              sequentialMode: next.sequentialMode,
              refMode: next.refMode,
              refPool: next.refPool,
              refImagesPerPrompt: next.refImagesPerPrompt,
              frameFileIds: next.frameFileIds,
              autoDownload: next.autoDownload,
              settingsSnapshot: next.settingsSnapshot,
              items: next.items,
            }),
            mode === "none" ? [] : newAssets,
          );
        }
        for (const key of editor.pickerPendingKeys || [])
          window.pendingUploadFiles?.delete(key);
        editor.pickerPendingKeys?.clear();
      } else {
        const processingRootId = batch.runtimeItemIds?.[editor.index];
        const currentItem =
          this._runtimeItemByRoot(
            this._jobForBatchItem(batch, editor.index)?.items,
            processingRootId,
          ) ||
          batch.terminalItems?.[editor.index] ||
          batch.items[editor.index];
        if (this._isItemProcessing(currentItem))
          throw new Error("BATCH_ITEM_IN_FLIGHT");
        const isDraft = batch.status === "queued" && !batch.resumeItemIndexes;
        const prompt = field("prompt").value.trim();
        if (!prompt) throw new Error("BATCH_PROMPT_EMPTY");
        if (batch.refMode === "mention" && editor.getMentionRefBudget) {
          const budget = editor.getMentionRefBudget?.({
            text: prompt,
            cursor: prompt.length,
            atPos: -1,
          });
          const caps = editor.getMentionCaps?.();
          if (
            !budget ||
            !caps ||
            budget.images > caps.image ||
            budget.videos > caps.video ||
            (Number.isInteger(budget.max) && budget.used > budget.max)
          )
            throw new Error("BATCH_REF_LIMIT_EXCEEDED");
        }
        const next = structuredClone(batch);
        const selectedRefKeys = new Set(
          field("frame1") || field("frame2")
            ? [field("frame1")?.value, field("frame2")?.value].filter(Boolean)
            : [
                ...sheet.querySelectorAll(
                  ".gen-batch-ref-choices .gen-batch-ref-choice",
                ),
              ].map((button) => button.dataset.refKey),
        );
        const addedRefs = (editor.pickerRefs || []).filter(
          (ref) =>
            selectedRefKeys.has(ref.refKey) &&
            !(next.refPool || []).some(
              (existing) => existing.refKey === ref.refKey,
            ),
        );
        next.refPool || (next.refPool = []);
        next.refPool.push(...addedRefs);
        const addedThumbs = addedRefs.map(
          (ref) => editor.pickerThumbs?.get(ref.refKey) || "",
        );
        const newAssets = addedRefs
          .map((ref) => editor.pickerAssets?.get(ref.refKey))
          .filter(Boolean);
        const item = next.items[editor.index];
        item.prompt = prompt;
        const model = field("model").value;
        const ratio = field("ratio").value;
        const quantity = Number(field("quantity").value);
        const terminalEdit =
          editor.terminal === true ||
          (!editor.runtime &&
            (next.status !== "queued" || !!next.resumeItemIndexes));
        const originalModel =
          item.settingsOverride?.model || batch.settingsSnapshot?.model;
        if (
          (!window.ModelRegistry?.findModel?.("flow", model) &&
            !(terminalEdit && model === originalModel)) ||
          !ratio ||
          !Number.isInteger(quantity) ||
          quantity < 1
        )
          throw new Error("BATCH_ITEM_SETTINGS_INVALID");
        item.settingsOverride = { model, ratio, quantity };
        if (field("inputType"))
          item.settingsOverride.videoInputType = field("inputType").value;
        if (field("flowThinkingLevel"))
          item.settingsOverride.flowThinkingLevel =
            field("flowThinkingLevel").value || null;
        if (field("duration"))
          item.settingsOverride.flowVideoDuration =
            field("duration").value || null;
        if (field("videoResolution"))
          item.settingsOverride.flowVideoResolution =
            field("videoResolution").value || null;
        if (sheet.querySelector(".gen-batch-ref-choices")) {
          const keys = [
            ...sheet.querySelectorAll(
              ".gen-batch-ref-choices .gen-batch-ref-choice",
            ),
          ].map((button) => button.dataset.refKey);
          item.refOverride =
            item.refOverride === true ||
            JSON.stringify(keys) !== JSON.stringify(item.refKeys);
          item.refKeys = keys;
        }
        if (field("frame1") || field("frame2")) {
          const chainLater =
            next.settingsSnapshot?.chain?.kind === "video_last_frame" &&
            editor.index > 0;
          const frame1 = chainLater ? "" : field("frame1")?.value || "";
          const frame2 = field("frame2")?.value || "";
          if (!chainLater && !frame1) throw new Error("BATCH_FRAMES_MISSING");
          item.refOverride = true;
          item.refKeys = [frame1, frame2].filter(Boolean);
          if (Array.isArray(next.frameFileIds))
            next.frameFileIds[editor.index] = { frame1, frame2 };
          else next.frameFileIds = { frame1, frame2 };
        }
        if (!isDraft && batch.refMode !== "mention") item.refOverride = true;
        if (addedRefs.length) item.refOverride = true;
        if (isDraft) {
          window.GenBatchDraftBuilder.remapDraft(next);
        } else {
          const previousItems = batch.items;
          window.GenBatchDraftBuilder.remapDraft(next);
          next.items = previousItems.map((previous, index) =>
            index === editor.index ? next.items[index] : previous,
          );
        }
        if (isDraft)
          window.GenBatchAdmission._validate(next, { allowPending: true });
        if (!terminalEdit) await window.GenBatchAdmission._validateItems(next);
        const editedItem = next.items[editor.index];
        const refFileNames = Object.fromEntries(
          (next.refPool || [])
            .filter((ref) => ref.fileName || ref.mediaUuid)
            .map((ref) => [ref.refKey, ref.mediaUuid || ref.fileName]),
        );
        const rootId = batch.runtimeItemIds?.[editor.index] || editor.itemId;
        const cacheItem = this._runtimeItemByRoot(
          this._cachedJobForBatch(batch)?.items,
          rootId,
        );
        const liveItem = this.queue
          .getJob?.(batch.jobId)
          ?.items?.find((entry) => entry.id === rootId);
        const refThumbnails = Object.fromEntries(
          (next.refPool || [])
            .map((ref) => [
              ref.refKey,
              window.MediaRegistry?.getRefIdentity?.(ref.refKey) ||
                liveItem?.refThumbnails?.[ref.refKey] ||
                cacheItem?.refThumbnails?.[ref.refKey] ||
                null,
            ])
            .filter(([, identity]) => identity),
        );
        let pendingSaved = false;
        let saveSourceOnly = terminalEdit;
        if (editor.runtime && !newAssets.length) {
          const ack = await this.queue.updatePendingPromptItem(
            owner.projectId,
            batch.jobId,
            editor.itemId,
            {
              prompt,
              settingsOverride: editedItem.settingsOverride,
              refFileIds: editedItem.refKeys || [],
              refFileNames,
              refThumbnails,
              refImageMode:
                batch.refMode === "frames"
                  ? Array.isArray(batch.frameFileIds)
                    ? "sequential"
                    : "all"
                  : batch.refMode,
              mentionData: editedItem.mentionData || null,
              commit: () =>
                this.store.update(
                  owner.userId,
                  owner.projectId,
                  batch.batchId,
                  batch.revision,
                  (current) => ({
                    ...current,
                    refPool: next.refPool,
                    frameFileIds: next.frameFileIds,
                    items: next.items,
                  }),
                ),
            },
          );
          if (!ack?.ok)
            throw new Error(
              ack?.error === "PROMPT_ITEM_IN_FLIGHT"
                ? "BATCH_ITEM_IN_FLIGHT"
                : ack?.error || "BATCH_RUNTIME_EDIT_FAILED",
            );
          pendingSaved = true;
        }
        if (!pendingSaved) {
          await (isDraft ? this.store.updateDraft : this.store.update).call(
            this.store,
            owner.userId,
            owner.projectId,
            batch.batchId,
            batch.revision,
            (current) => ({
              ...current,
              refPool: next.refPool,
              frameFileIds: next.frameFileIds,
              items: next.items,
            }),
            newAssets,
          );
        }
        if (saveSourceOnly && this.queue.getJob?.(batch.jobId)) {
          const edited = next.items[editor.index];
          const synced = this.queue.updateTerminalPromptSource(
            owner.projectId,
            batch.jobId,
            batch.runtimeItemIds?.[editor.index] || editor.itemId,
            {
              prompt,
              settingsOverride: edited.settingsOverride,
              refFileIds: edited.refKeys || [],
              refFileNames,
              refThumbnails,
              refImageMode:
                batch.refMode === "frames"
                  ? Array.isArray(batch.frameFileIds)
                    ? "sequential"
                    : "all"
                  : batch.refMode,
              mentionData: edited.mentionData || null,
            },
          );
          if (!synced) {
            this._closeEditor();
            await this.reload();
            throw new Error("BATCH_LOCAL_SAVED_REGEN_SOURCE_UNAVAILABLE");
          }
        }
        if (batch.trackerSessionId && editor.itemId && !isDraft) {
          const edited = next.items[editor.index];
          const effective = {
            ...batch.settingsSnapshot,
            ...edited.settingsOverride,
          };
          const cache = await chrome.runtime.sendMessage({
            action: "ft:updateHistoryItem",
            projectId: owner.projectId,
            sessionId: batch.trackerSessionId,
            jobId: batch.jobId,
            itemId: editor.itemId,
            prompt,
            skipBatchSync: true,
            patch: {
              prompt,
              model: effective.model,
              ratio: effective.ratio,
              quantity: effective.quantity,
              refFileIds: edited.refKeys || [],
              refFileNames,
              refThumbnails,
              flowVideoDuration: effective.flowVideoDuration || null,
              flowVideoResolution: effective.flowVideoResolution || null,
              flowThinkingLevel: effective.flowThinkingLevel || null,
              refImageMode:
                batch.refMode === "frames"
                  ? Array.isArray(batch.frameFileIds)
                    ? "sequential"
                    : "all"
                  : batch.refMode,
              mentionData: edited.mentionData || null,
            },
          });
          if (!cache?.ok) {
            this._closeEditor();
            await this.reload();
            throw new Error(
              `BATCH_LOCAL_SAVED_TRACKER_CACHE_FAILED:${cache?.error || "NO_ACK"}`,
            );
          }
        }
        for (const [index, ref] of addedRefs.entries()) {
          const thumbnail = addedThumbs[index];
          if (
            thumbnail &&
            /^(?:https?:|blob:|data:image\/(?:png|jpeg|webp|gif);base64,)/.test(
              thumbnail,
            )
          )
            window.MediaRegistry?.setThumb?.(ref.refKey, thumbnail);
        }
        for (const key of editor.pickerPendingKeys || [])
          window.pendingUploadFiles?.delete(key);
        editor.pickerPendingKeys?.clear();
      }
      this._closeEditor();
      await this.reload();
      if (this._open)
        this._hydrateListRefThumbs(++this._listRefHydrationEpoch).catch(
          () => {},
        );
      this._notify(window.I18n?.t?.("common.saved") || "Saved", "success");
    } finally {
      this._busy = false;
    }
  }
}
window.GenBatchListModal = GenBatchListModal;
