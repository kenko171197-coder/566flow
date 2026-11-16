class ProviderWebBatchView {
  get provider() {
    return ["muse", "chatgpt", "gemini"].includes(this.host._view)
      ? this.host._view
      : "muse";
  }
  constructor(host) {
    this.host = host;
    this.batches = [];
    this._loadedProvider = null;
    this._reloadSeq = 0;
    this.availableProviders = new Set();
    this.runs = new Map();
    this.urls = new Map();
    this._derivedVideoPosters = new Map();
    this._videoPosterFlights = new Map();
    this._urlEpoch = 0;
    this.showAll = new Set();
    this.visibleCount = 20;
    this.editing = null;
    this.running = new Set();
    this.paused = new Set();
    this.downloading = new Set();
    this.assetObserver = null;
    this.highlightBatchId = null;
    this.highlightStartedAt = 0;
    this._runAllEpoch = new Map();
    this._prunedScopes = new Set();
  }
  _t(key, fallback, params = {}, provider = this.provider) {
    const shared =
      provider !== "muse" &&
      [
        "summary",
        "empty",
        "runAll",
        "confirmTitle",
        "checking",
        "notReady",
        "deleteConfirm",
      ].includes(key);
    const name = `providerWebBatch.${shared ? `${key}Provider` : key}`;
    const value = window.I18n?.t?.(name, params);
    return value && value !== name ? value : fallback;
  }
  _batchT(key, fallback, params = {}) {
    const name = `genBatch.${key}`;
    const value = window.I18n?.t?.(name, params);
    if (value && value !== name) return value;
    if (key === "addToReferences" || key === "addResultsToReferences") {
      const shared = window.I18n?.t?.("gen.addRef");
      if (shared && shared !== "gen.addRef") return shared;
    }
    return fallback;
  }
  _errorText(error) {
    const raw = String(error || "").trim();
    const code = /^([A-Z][A-Z0-9_]{2,119})(?: \(HTTP [1-5][0-9]{2}\))?$/.exec(
      raw,
    )?.[1];
    if (!code) return raw;
    if (code.startsWith("MUSE_"))
      return window.MuseApiFacade?.errorMessage?.(code) || "";
    const key = `providerWebErrors.codes.${code}`;
    const translated = window.I18n?.t?.(key);
    if (translated && translated !== key) return `${translated} (${raw})`;
    const unknownKey = "providerWebErrors.unknown";
    const unknown = window.I18n?.t?.(unknownKey, { code: raw });
    return unknown && unknown !== unknownKey ? unknown : raw;
  }
  _providerLabel(provider = this.provider) {
    return { muse: "Muse", chatgpt: "ChatGPT", gemini: "Gemini" }[provider];
  }
  _maxRefs(mediaType, model) {
    const adapter = window.ProviderRegistry?.get?.(this.provider);
    return this.provider === "chatgpt"
      ? adapter?.capabilities?.maxRefImages
      : adapter?.getMaxRefImages?.({ mode: mediaType, modelValue: model });
  }
  _ratioValue(entry) {
    if (typeof entry === "string") return entry;
    return this.provider === "chatgpt" ? entry.ui_name : entry.value;
  }
  _ratioIcon(entry) {
    const ratio = typeof entry === "string" ? entry : entry?.value;
    return window.GenTab?._ratioIcon?.(ratio) || "";
  }
  _ratioMatches(entry, current) {
    return (
      this._ratioValue(entry) === current ||
      (typeof entry === "object" &&
        entry !== null &&
        (entry.value === current || entry.ui_name === current))
    );
  }
  _scope() {
    return this.host._scope();
  }
  _esc(value) {
    return this.host._escape(value);
  }
  _controlState(batch) {
    const runId = this.runs.get(batch.id)?.manualActiveRunId || batch.runId;
    return window.ProviderWebScheduler.getRunControlState?.(runId) || null;
  }
  _isRunning(batch) {
    return (
      this.running.has(batch.id) || this._controlState(batch)?.active === true
    );
  }
  _isItemProcessing(item) {
    return ["PREPARING", "SUBMITTING", "MONITORING"].includes(item?.state);
  }
  _retryQueued(batch, item, snapshot = this.runs.get(batch.id)) {
    const active = item.manualRunId
      ? item.retryLeaseActive === true
      : snapshot?.run.status !== "SETTLED" &&
        (this._isRunning(batch) || snapshot?.leaseActive === true);
    return (
      item.retryPending === true &&
      ["FAILED", "QUEUED"].includes(item.state) &&
      active
    );
  }
  _displayStatus(batch, snapshot = this.runs.get(batch.id)) {
    const items = (snapshot?.items || []).filter((item) => !item.hidden);
    if (!items.length) return "QUEUED";
    const processing = items.some((item) => this._isItemProcessing(item));
    const queued = items.some(
      (item) =>
        item.state === "QUEUED" || this._retryQueued(batch, item, snapshot),
    );
    if (
      (processing || queued) &&
      (this._controlState(batch)?.paused || this.paused.has(batch.id))
    )
      return "PAUSED";
    if (processing) return "RUNNING";
    if (queued) return "QUEUED";
    if (items.some((item) => item.state === "NEEDS_REVIEW"))
      return "NEEDS_REVIEW";
    const done = items.filter((item) => item.state === "COMPLETED").length;
    if (
      done !== items.length &&
      items.some(
        (item) => item.state === "CANCELLED" && item.error === "USER_CANCELLED",
      )
    )
      return "STOPPED";
    return done === items.length
      ? "COMPLETED"
      : done
        ? "PARTIAL_FAIL"
        : items.every((item) => item.state === "CANCELLED")
          ? "STOPPED"
          : "FAILED";
  }
  _visibleRunning() {
    return this.batches.filter((batch) => this._isRunning(batch));
  }
  _visiblePaused() {
    return this.batches.filter((batch) => {
      const state = this._controlState(batch);
      return !state?.active && (this.paused.has(batch.id) || state?.paused);
    });
  }
  _workerGate(provider = this.provider, settings = null) {
    if (
      provider === "muse" &&
      settings?.museDirect === true &&
      settings.museGenMode === "web"
    ) {
      const enabled = window.featureGate?.canUse?.("muse_enabled") === true;
      return {
        enabled,
        reason: enabled
          ? null
          : window.MuseApiFacade.errorMessage("MUSE_FEATURE_REQUIRED"),
      };
    }
    if (
      provider === "muse" &&
      window.MuseApiFacade?.effectiveMode({
        museGenMode:
          settings?.museGenMode ??
          window.storageSettings?.getSettings?.()?.museGenMode ??
          "web",
      }) === "api"
    ) {
      const policy = window.ProviderConfigManager?.getApiConfigValueSync?.(
        "muse",
        "muse_api_runtime",
      );
      return {
        enabled: policy?.enabled === true,
        reason:
          policy?.enabled === true
            ? null
            : window.MuseModeSettings?.t?.("disabled"),
        apiMode: true,
      };
    }
    try {
      const config = window.ExecutionConfig.getProviderWebWorkers(provider);
      if (config.parallelEnabled !== true)
        return {
          enabled: false,
          reason: this._t("parallelOff", "Parallel workers off"),
        };
      if (!config.enabledProviders.includes(provider))
        return {
          enabled: false,
          reason: this._t(
            "providerDisabled",
            `${this._providerLabel(provider)} is not enabled for Web workers`,
            { provider: this._providerLabel(provider) },
          ),
        };
      return { enabled: true, reason: null };
    } catch (error) {
      const field = /missing_or_invalid:(provider_web_[a-z0-9_]+)/.exec(
        error?.message || "",
      )?.[1];
      const reason = this._t(
        "workerConfigUnavailable",
        "Web worker settings unavailable",
      );
      return {
        enabled: false,
        reason: field ? `${reason} (${field})` : reason,
      };
    }
  }
  _workerEnabled(provider = this.provider, settings = null) {
    return this._workerGate(provider, settings).enabled;
  }
  async _probeReady(provider = this.provider) {
    if (provider === "muse") return window.MuseSession.probeReady();
    const session =
      provider === "chatgpt" ? window.ChatGPTSession : window.GeminiSession;
    if (!session) return { ready: false, error: "SESSION_NOT_LOADED" };
    return session.ensureReady({
      createIfMissing: false,
      activate: false,
      forceCheck: true,
      waitForEditorMs: 12e3,
      silent: true,
    });
  }
  _queuedEditCurrent(edit, current) {
    if (current?.status !== "QUEUED" || current.scope !== edit.batch.scope)
      throw new Error("PROVIDER_BATCH_REVISION_CONFLICT");
    if (
      current.revision !== edit.sourceRevision &&
      (JSON.stringify(current.prompts) !== edit.sourcePrompts ||
        JSON.stringify(current.settingsSnapshot) !== edit.sourceSettings)
    )
      throw new Error("PROVIDER_BATCH_REVISION_CONFLICT");
    return current;
  }
  async reload() {
    if (this.host._view === "flow") return;
    const requestId = ++this._reloadSeq;
    const provider = this.provider;
    const scope = this._scope();
    if (scope)
      window.ProviderWebScheduler.publishPending(scope.userId).catch(() => {});
    const allBatches = scope
      ? await window.ProviderWebQueueStore.listBatches(
          scope.userId,
          scope.projectId,
        )
      : [];
    const allRuns = scope
      ? await window.ProviderWebQueueStore.listRuns(
          scope.userId,
          scope.projectId,
        )
      : [];
    const userId = window.authManager?.getUser?.()?.id;
    const mcpRuns =
      userId && window.ProviderWebQueueStore.listMcpRuns
        ? await window.ProviderWebQueueStore.listMcpRuns(userId)
        : [];
    const availableProviders = new Set(
      [...allBatches, ...allRuns, ...mcpRuns].map((entry) => entry.provider),
    );
    const storedBatches = allBatches.filter(
      (batch) => batch.provider === provider && !batch.hiddenFromBatchList,
    );
    const direct = allRuns.filter(
      (run) =>
        run.provider === provider &&
        run.source === "gentab_direct" &&
        !run.manualRegen &&
        !run.hiddenFromBatchList,
    );
    const mcp = mcpRuns
      .filter((run) => run.provider === provider && !run.hiddenFromBatchList)
      .map((run) => ({
        id: run.id,
        runId: run.id,
        provider: run.provider,
        scope: run.scope,
        userId: run.userId,
        projectId: null,
        ownerScope: run.ownerScope,
        source: "mcp_direct",
        status: run.status,
        revision: run.revision,
        createdAt: run.createdAt,
        batchName: run.displayName || run.batchName,
        mcpJobId: run.mcpJobId,
        runnerId: run.runnerId,
        settingsSnapshot: run.settingsSnapshot,
        prompts: [],
        manualRuns: run.manualRuns || [],
      }));
    const batches = [
      ...storedBatches,
      ...mcp,
      ...direct.map((run) => ({
        id: run.id,
        runId: run.id,
        provider: run.provider,
        scope: run.scope,
        userId: run.userId,
        projectId: run.projectId,
        source: "gentab_direct",
        status: run.status,
        createdAt: run.createdAt,
        revision: run.revision,
        displayName: run.displayName,
        settingsSnapshot: run.displaySettingsSnapshot || run.settingsSnapshot,
        prompts: [],
        manualRuns: run.manualRuns || [],
      })),
    ].sort((a, b) => b.createdAt - a.createdAt);
    const runs = new Map();
    await Promise.all(
      batches
        .filter((batch) => batch.runId)
        .map(async (batch) => {
          const result = await window.ProviderWebQueueStore.getRun(batch.runId);
          if (result?.run?.scope !== batch.scope) return;
          const display = {
            ...result,
            definitionItems: result.items,
            items: result.items.map((item) => ({ ...item })),
            manualActiveRunId: null,
            manualUnsettledRunId: null,
            manualLatestRunId: null,
            manualLatestStatus: null,
            manualAssetProjects: new Map(),
          };
          for (const manual of batch.manualRuns || []) {
            const child = await window.ProviderWebQueueStore.getRun(
              manual.runId,
            );
            const linked =
              batch.source === "mcp_direct"
                ? child?.run?.mcpParentRunId === batch.id &&
                  child.run.userId === String(batch.userId)
                : child?.run?.scope === batch.scope &&
                  (batch.source === "gentab_direct"
                    ? child.run.parentRunId === batch.id
                    : child.run.batchId === batch.id);
            if (!linked) continue;
            display.manualLatestRunId = child.run.id;
            display.manualLatestStatus = child.run.status;
            if (child.run.status !== "SETTLED")
              display.manualUnsettledRunId = child.run.id;
            const reviewIdle =
              child.run.status === "RUNNING" &&
              child.historyPublished &&
              child.historyStatus === "needs_review" &&
              !child.leaseActive &&
              !child.items.some(
                (item) =>
                  !item.hidden &&
                  ["PREPARING", "SUBMITTING", "MONITORING"].includes(
                    item.state,
                  ),
              );
            if (child.run.status !== "SETTLED" && !reviewIdle)
              display.manualActiveRunId = child.run.id;
            child.items.forEach((item) => {
              if (batch.source === "mcp_direct") {
                for (const key of [
                  ...(item.refKeys || []),
                  ...(item.displayRefKeys || []),
                  ...(item.resultReceipts || []).flatMap((receipt) => [
                    receipt.assetKey,
                    receipt.posterAssetKey,
                  ]),
                ])
                  if (key)
                    display.manualAssetProjects.set(key, child.run.projectId);
              }
              const originalIndex = manual.originalIndexes?.[item.promptIndex];
              const target = display.items.find(
                (entry) => entry.promptIndex === originalIndex,
              );
              if (!target || item.hidden) return;
              Object.assign(target, {
                state: item.state,
                attemptId: item.attemptId,
                resultReceipts: item.resultReceipts,
                error: item.error,
                downloadState: item.downloadState,
                retryPending: item.retryPending,
                retryLeaseActive: child.leaseActive === true,
                retrySubmitCount: Number.isInteger(item.retrySubmitCount)
                  ? item.retrySubmitCount
                  : Number(child.run.retryCount) || 0,
                manualRunId: child.run.id,
                ...(batch.source === "mcp_direct"
                  ? {
                      refKeys: item.refKeys,
                      displayRefKeys:
                        result.items.find(
                          (entry) => entry.promptIndex === originalIndex,
                        )?.displayRefKeys ||
                        item.displayRefKeys ||
                        item.refKeys,
                    }
                  : {}),
              });
            });
          }
          const hidden = new Set(
            batch.hiddenPromptIndexes || result.run.hiddenPromptIndexes || [],
          );
          for (const item of display.items)
            if (hidden.has(item.promptIndex)) item.hidden = true;
          runs.set(batch.id, display);
        }),
    );
    const currentScope = this._scope();
    if (
      requestId !== this._reloadSeq ||
      provider !== this.provider ||
      String(currentScope?.userId || "") !== String(scope?.userId || "") ||
      currentScope?.projectId !== scope?.projectId ||
      String(window.authManager?.getUser?.()?.id || "") !== String(userId || "")
    )
      return;
    this.availableProviders = availableProviders;
    this.batches = batches;
    this.runs = runs;
    this._loadedProvider = provider;
    const listState = JSON.stringify([
      scope?.userId,
      scope?.projectId,
      provider,
      batches.map((batch) => [batch.id, batch.status]),
      [...runs].map(([id, data]) => [id, data.items.map((item) => item.state)]),
    ]);
    if (this._lastListState !== listState) {
      this._lastListState = listState;
      console.info(
        "[ProviderWebBatchView] list_snapshot",
        JSON.stringify({
          provider,
          projectId: scope?.projectId || null,
          batchCount: batches.length,
          runningCount: batches.filter((batch) =>
            runs
              .get(batch.id)
              ?.items.some((item) =>
                ["PREPARING", "SUBMITTING", "MONITORING"].includes(item.state),
              ),
          ).length,
          runIds: [...runs.values()].map((data) => data.run.id),
        }),
      );
    }
    if (scope) {
      const scopeKey = `${scope.userId}\0${scope.projectId}`;
      if (!this._prunedScopes.has(scopeKey)) {
        this._prunedScopes.add(scopeKey);
        window.ProviderWebQueueStore.pruneSupersededAssets(
          scope.userId,
          scope.projectId,
        ).catch((error) => {
          this._prunedScopes.delete(scopeKey);
          console.warn(
            "[ProviderWebBatchView] Result asset cleanup:",
            error?.message || error,
          );
        });
      }
    }
  }
  async _refNames(batch, keys) {
    const names = {};
    await Promise.all(
      keys.map(async (key) => {
        const owner = this._assetOwner(batch, key);
        const found = await window.ProviderWebQueueStore.getAssetNames(
          batch.userId,
          owner.projectId,
          [key],
          owner.ownerScope,
        );
        if (found[key]) names[key] = found[key];
      }),
    );
    return names;
  }
  _assetOwner(batch, key) {
    if (batch.source === "mcp_direct") {
      const projectId = this.runs.get(batch.id)?.manualAssetProjects?.get(key);
      if (projectId) return { projectId, ownerScope: null };
    }
    return {
      projectId: batch.projectId ?? null,
      ownerScope: batch.ownerScope || null,
    };
  }
  async _assetUrl(batch, key) {
    const mapKey = `${batch.scope}:${key}`;
    if (this.urls.has(mapKey)) return this.urls.get(mapKey);
    const epoch = this._urlEpoch;
    const owner = this._assetOwner(batch, key);
    const asset = await window.ProviderWebQueueStore.getAsset(
      batch.userId,
      owner.projectId,
      key,
      owner.ownerScope,
    );
    if (!asset?.blob || epoch !== this._urlEpoch) return null;
    const url = URL.createObjectURL(asset.blob);
    this.urls.set(mapKey, url);
    return url;
  }
  async _videoPosterFromAsset(batch, key) {
    const mapKey = `${batch.scope}:${key}`;
    if (this._derivedVideoPosters.has(mapKey))
      return this._derivedVideoPosters.get(mapKey);
    if (this._videoPosterFlights.has(mapKey))
      return this._videoPosterFlights.get(mapKey);
    const epoch = this._urlEpoch;
    const flight = (async () => {
      const owner = this._assetOwner(batch, key);
      const asset = await window.ProviderWebQueueStore.getAsset(
        batch.userId,
        owner.projectId,
        key,
        owner.ownerScope,
      );
      if (!asset?.blob || !asset.blob.type.startsWith("video/")) return null;
      const poster = await window.ImmediateUploader?._portableVideoThumbnail?.(
        asset.blob,
        200,
        { representativeFrame: true },
      );
      if (
        epoch !== this._urlEpoch ||
        !/^data:image\/[a-z0-9.+-]+;base64,/i.test(poster || "")
      )
        return null;
      if (this._derivedVideoPosters.size >= 64)
        this._derivedVideoPosters.delete(
          this._derivedVideoPosters.keys().next().value,
        );
      this._derivedVideoPosters.set(mapKey, poster);
      return poster;
    })();
    this._videoPosterFlights.set(mapKey, flight);
    try {
      return await flight;
    } finally {
      if (this._videoPosterFlights.get(mapKey) === flight)
        this._videoPosterFlights.delete(mapKey);
    }
  }
  async _addResultsToReferences(batch, promptIndex = null) {
    const scope = this._scope();
    const provider = this.provider;
    if (
      !scope ||
      String(scope.userId) !== String(batch.userId) ||
      batch.provider !== provider ||
      (batch.source !== "mcp_direct" && scope.projectId !== batch.projectId)
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    const snapshot = this.runs.get(batch.id);
    if (!snapshot || snapshot.run?.scope !== batch.scope)
      throw new Error("PROVIDER_RESULT_ASSET_MISSING");
    const seen = new Set();
    const receipts = (snapshot.items || [])
      .filter(
        (item) =>
          !item.hidden &&
          (promptIndex == null || item.promptIndex === promptIndex),
      )
      .flatMap((item) => item.resultReceipts || [])
      .filter(
        (receipt) =>
          receipt?.assetKey &&
          !seen.has(receipt.assetKey) &&
          seen.add(receipt.assetKey),
      );
    if (!receipts.length) throw new Error("PROVIDER_RESULT_ASSET_MISSING");
    if (!window.GenTab?.addUploadRefImages || !window.GenTab.fileIdsInput)
      throw new Error("GEN_REFERENCES_NOT_READY");
    const items = [];
    for (const receipt of receipts) {
      const owner = this._assetOwner(batch, receipt.assetKey);
      const asset = await window.ProviderWebQueueStore.getAsset(
        batch.userId,
        owner.projectId,
        receipt.assetKey,
        owner.ownerScope,
      );
      const type = asset?.blob?.type || asset?.type || "";
      const mediaType = receipt.mediaType === "video" ? "video" : "image";
      if (!asset?.blob?.size || !type.startsWith(`${mediaType}/`))
        throw new Error("PROVIDER_RESULT_ASSET_MISSING");
      let file,
        thumbnail = null;
      if (mediaType === "video") {
        const poster = receipt.posterAssetKey
          ? await window.ProviderWebQueueStore.getAsset(
              batch.userId,
              owner.projectId,
              receipt.posterAssetKey,
              owner.ownerScope,
            )
          : null;
        const posterType = poster?.blob?.type || poster?.type || "";
        if (poster?.blob?.size && posterType.startsWith("image/")) {
          file = new File(
            [poster.blob],
            poster.name || `${provider}_frame_${items.length + 1}`,
            { type: posterType },
          );
        } else {
          const video = new File(
            [asset.blob],
            asset.name || `${provider}_result_${items.length + 1}`,
            { type },
          );
          const frame =
            await window.imagePickerModal?._createThumbnail?.(video);
          if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(frame || ""))
            throw new Error("PROVIDER_RESULT_REFERENCE_FRAME_UNAVAILABLE");
          const response = await fetch(frame);
          const bytes = await response.arrayBuffer();
          file = new File(
            [bytes],
            `${video.name.replace(/\.[^.]+$/, "")}_frame.jpg`,
            { type: "image/jpeg" },
          );
          thumbnail = frame;
        }
      } else {
        file = new File(
          [asset.blob],
          asset.name || `${provider}_result_${items.length + 1}`,
          { type },
        );
      }
      try {
        thumbnail ||
          (thumbnail =
            (await window.imagePickerModal?._createThumbnail?.(file)) || null);
      } catch (_) {}
      items.push({
        file,
        thumbnail,
        type: file.type,
        name: file.name,
        sourceKey: `provider-web:${batch.scope}:${receipt.assetKey}`,
      });
    }
    const currentScope = this._scope();
    if (
      !this.host._open ||
      provider !== this.provider ||
      !this.batches.some(
        (entry) => entry.id === batch.id && entry.scope === batch.scope,
      ) ||
      String(currentScope?.userId) !== String(scope.userId) ||
      currentScope?.projectId !== scope.projectId
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    const added = window.GenTab.addUploadRefImages(items);
    this.host.close("add-results-to-references");
    window.showNotification?.(
      window.I18n?.t?.(
        added > 0 ? "gen.refImageAddedCount" : "gen.refImageAlreadyAdded",
        { count: added },
      ),
      added > 0 ? "success" : "info",
    );
    return added;
  }
  clearUrls() {
    this._urlEpoch++;
    this.assetObserver?.disconnect();
    this.assetObserver = null;
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this._derivedVideoPosters.clear();
    this._videoPosterFlights.clear();
  }
  _revokeAssets(batch, keys) {
    this._urlEpoch++;
    for (const key of keys) {
      const mapKey = `${batch.scope}:${key}`;
      const url = this.urls.get(mapKey);
      if (url) URL.revokeObjectURL(url);
      this.urls.delete(mapKey);
      this._derivedVideoPosters.delete(mapKey);
    }
  }
  _canEditUnsettled(batch, snapshot = this.runs.get(batch.id)) {
    if (
      this._isRunning(batch) ||
      snapshot?.manualActiveRunId ||
      snapshot?.run.status !== "RUNNING"
    )
      return false;
    const visible = snapshot.items.filter((item) => !item.hidden);
    return (
      visible.length > 0 &&
      snapshot.historyPublished &&
      snapshot.historyStatus === "needs_review" &&
      !snapshot.leaseActive &&
      !visible.some((item) =>
        ["PREPARING", "SUBMITTING", "MONITORING"].includes(item.state),
      )
    );
  }
  _canRetryUnadmitted(batch, snapshot = this.runs.get(batch.id)) {
    return (
      (batch.source === "gentab_direct"
        ? batch.status === "QUEUED"
        : batch.status === "RUNNING") &&
      batch.runId === snapshot?.run?.id &&
      snapshot.run.status === "QUEUED" &&
      !snapshot.reservation &&
      !snapshot.leaseActive &&
      !snapshot.manualActiveRunId &&
      !this._isRunning(batch) &&
      snapshot.items.length > 0 &&
      snapshot.items.every(
        (item) =>
          item.state === "QUEUED" &&
          !item.attemptId &&
          !item.resultReceipts?.length,
      )
    );
  }
  _canDelete(batch) {
    return !!batch;
  }
  _canPurge(batch, snapshot = this.runs.get(batch.id)) {
    if (this._isRunning(batch) || snapshot?.manualUnsettledRunId) return false;
    if (window.MuseApiBatchRunner?.intended(batch))
      return snapshot?.run.status === "SETTLED";
    if (batch.source === "gentab_direct")
      return (
        snapshot?.run.status === "SETTLED" ||
        (snapshot?.run.status === "QUEUED" &&
          !snapshot.reservation &&
          !snapshot.leaseActive)
      );
    return (
      (batch.status === "QUEUED" && !batch.runId) ||
      snapshot?.run.status === "SETTLED" ||
      (batch.status === "RUNNING" && this._canEditUnsettled(batch, snapshot))
    );
  }
  _assertDeleteScope(batch) {
    const scope = this._scope();
    if (
      String(scope?.userId) !== String(batch.userId) ||
      (batch.source !== "mcp_direct" && scope?.projectId !== batch.projectId)
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
  }
  async _deleteCurrent(batch) {
    this._assertDeleteScope(batch);
    await window.ProviderWebQueueStore.hideBatchListEntry(
      batch.userId,
      batch.projectId,
      batch.id,
      batch.source || "batch",
    );
    if (batch.source !== "mcp_direct" && this._canPurge(batch)) {
      try {
        await this._purgeCurrent(batch);
      } catch (error) {
        console.warn(
          "[ProviderWebBatch] Deleted list entry; execution data retained:",
          error?.message,
        );
      }
    }
  }
  async _purgeCurrent(batch) {
    if (!this._canPurge(batch))
      throw new Error("PROVIDER_BATCH_DELETE_CONFLICT");
    if (batch.source === "gentab_direct") {
      const current2 = await window.ProviderWebQueueStore.getRun(batch.runId);
      if (
        current2?.run?.scope !== batch.scope ||
        current2.run.source !== "gentab_direct" ||
        current2.run.provider !== batch.provider ||
        JSON.stringify(current2.run.manualRuns || []) !==
          JSON.stringify(batch.manualRuns || []) ||
        !["QUEUED", "SETTLED"].includes(current2.run.status)
      )
        throw new Error("PROVIDER_RUN_DELETE_CONFLICT");
      return window.ProviderWebQueueStore.deleteRun(
        batch.userId,
        batch.projectId,
        batch.runId,
        current2.run.revision,
      );
    }
    const current = (
      await window.ProviderWebQueueStore.listBatches(
        batch.userId,
        batch.projectId,
      )
    ).find((entry) => entry.id === batch.id);
    const idleReview =
      current?.status === "RUNNING" && this._canEditUnsettled(batch);
    if (
      current?.scope !== batch.scope ||
      current.provider !== batch.provider ||
      current.runId !== batch.runId ||
      !(["QUEUED", "SETTLED"].includes(current.status) || idleReview) ||
      JSON.stringify(current.prompts) !== JSON.stringify(batch.prompts) ||
      JSON.stringify(current.settingsSnapshot) !==
        JSON.stringify(batch.settingsSnapshot) ||
      JSON.stringify(current.manualRuns || []) !==
        JSON.stringify(batch.manualRuns || [])
    )
      throw new Error("PROVIDER_BATCH_REVISION_CONFLICT");
    return window.ProviderWebQueueStore.deleteBatch(
      batch.userId,
      batch.projectId,
      batch.id,
      current.revision,
      idleReview
        ? {
            allowIdleReview: true,
            runRevision: this.runs.get(batch.id)?.run.revision,
          }
        : void 0,
    );
  }
  _card(batch) {
    if (batch.source === "mcp_direct") return this._mcpCard(batch);
    const run = this.runs.get(batch.id);
    const retryUnadmitted = this._canRetryUnadmitted(batch, run);
    const displaySettings =
      run?.run.displaySettingsSnapshot || batch.settingsSnapshot;
    const model = displaySettings.model;
    const modelConfig = window.ModelRegistry?.findModel?.(this.provider, model);
    const modelLabel = modelConfig?.name || modelConfig?.label || model;
    const sourceItems = (run?.items || batch.prompts).filter(
      (item) => !item.hidden,
    );
    const all = this.showAll.has(batch.id);
    const visible = all ? sourceItems : sourceItems.slice(0, 5);
    const done = sourceItems.filter(
      (item) => item.state === "COMPLETED",
    ).length;
    const title =
      batch.displayName ||
      `${batch.source === "gentab_direct" ? this._t("direct", "Direct run") : this._t("batch", "Batch")} ${new Date(batch.createdAt).toLocaleString()}`;
    const receiptStatus = run?.reservation?.receipt?.status;
    const controlState = this._controlState(batch);
    const running =
      this._isRunning(batch) &&
      !(
        run?.run.status === "SETTLED" &&
        !run.manualUnsettledRunId &&
        !run.manualActiveRunId
      );
    const settledStatus =
      receiptStatus === "success"
        ? "COMPLETED"
        : receiptStatus === "partial"
          ? "PARTIAL_FAIL"
          : receiptStatus === "failed"
            ? "FAILED"
            : receiptStatus === "cancelled"
              ? "STOPPED"
              : "NEEDS_REVIEW";
    const stoppedByUser = run?.items.some(
      (item) => item.state === "CANCELLED" && item.error === "USER_CANCELLED",
    );
    const manualStates = sourceItems.map((item) => item.state);
    const safeItem = (item) =>
      ["COMPLETED", "PARTIAL_FAIL", "FAILED", "CANCELLED"].includes(
        item.state,
      ) ||
      (item.state === "QUEUED" && !item.attemptId);
    const failedPendingItem = (item) =>
      safeItem(item) &&
      ["FAILED", "PARTIAL_FAIL", "QUEUED"].includes(item.state);
    const rerunCount = sourceItems.filter(failedPendingItem).length;
    const reviewCount = sourceItems.filter(
      (item) => item.state === "NEEDS_REVIEW",
    ).length;
    const rerunHint = reviewCount
      ? this._t(
          "reviewExcluded",
          `${reviewCount} unverified prompt(s) excluded to avoid duplicate generation`,
          { count: reviewCount },
        )
      : "";
    const manualStatus = !run?.manualLatestRunId
      ? null
      : manualStates.every((state) => state === "COMPLETED")
        ? "COMPLETED"
        : manualStates.some((state) => state === "NEEDS_REVIEW")
          ? done
            ? "PARTIAL_FAIL"
            : "FAILED"
          : manualStates.some(
                (state) => state === "FAILED" || state === "PARTIAL_FAIL",
              )
            ? manualStates.some((state) => state === "COMPLETED")
              ? "PARTIAL_FAIL"
              : "FAILED"
            : manualStates.some((state) => state === "CANCELLED")
              ? "STOPPED"
              : settledStatus;
    const status = this._displayStatus(batch, run);
    const rows = visible
      .map((item, index) => {
        const results = item.resultReceipts || [];
        const refs = item.displayRefKeys || item.refKeys || [];
        const itemSettings =
          item.displaySettingsOverride || item.settingsOverride || {};
        const itemModel = itemSettings.model || model;
        const itemModelConfig = window.ModelRegistry?.findModel?.(
          this.provider,
          itemModel,
        );
        const itemModelLabel =
          itemModelConfig?.name || itemModelConfig?.label || itemModel;
        const state = item.state || status;
        const displayState = this._retryQueued(batch, item, run)
          ? "RETRY_QUEUED"
          : state === "QUEUED" && item.manualRunId && running
            ? "PREPARING"
            : state === "NEEDS_REVIEW"
              ? "FAILED"
              : state;
        const download =
          this.downloading.has(`${batch.id}:${item.promptIndex ?? index}`) ||
          item.downloadState === "downloading"
            ? "running"
            : item.downloadState === "completed"
              ? "done"
              : item.downloadState === "failed"
                ? "failed"
                : null;
        const statusText =
          download === "running"
            ? this._t("downloading", "Downloading")
            : download === "failed"
              ? this._t("downloadFailed", "Download failed")
              : displayState === "RETRY_QUEUED"
                ? this._t("retryQueued", "Waiting to retry")
                : displayState === "MONITORING"
                  ? this._batchT("status_monitoring", "Generating")
                  : this._t(
                      String(displayState).toLowerCase(),
                      this.host._statusLabel(displayState),
                    );
        const refsHtml = refs
          .map(
            (key) =>
              `<span class="gen-batch-ref-mini is-preview-loading"><img data-web-asset="${this._esc(key)}" data-web-batch="${this._esc(batch.id)}" loading="lazy" alt=""></span>`,
          )
          .join("");
        const resultsHtml = results
          .map(
            (result) =>
              `<button type="button" class="gen-batch-result${result.mediaType === "video" && !result.posterAssetKey ? "" : " is-preview-loading"}" data-media-type="${result.mediaType === "video" ? "video" : "image"}" data-action="web-preview" data-asset="${this._esc(result.assetKey)}" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}" aria-label="${this._esc(this._t("preview", "Preview result"))}">${result.mediaType === "video" && !result.posterAssetKey ? "" : `<img data-web-asset="${this._esc(result.mediaType === "video" ? result.posterAssetKey : result.assetKey)}" data-web-batch="${this._esc(batch.id)}" loading="lazy" alt="">`}<span class="gen-batch-result-mode" data-mode="${run?.run?.settingsSnapshot?.museGenMode === "api" ? "api" : "web"}" aria-hidden="true">${run?.run?.settingsSnapshot?.museGenMode === "api" ? "API" : "WEB"}</span></button>`,
          )
          .join("");
        const mediaIcon =
          displaySettings.mediaType === "video"
            ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
            : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
        const loading = [
          "PREPARING",
          "SUBMITTING",
          "MONITORING",
          "RETRY_QUEUED",
        ].includes(displayState);
        const loadingIndicator =
          this.host._loadingIndicator?.(
            item.processingStartedAt || item.updatedAt,
          ) ||
          '<span class="gen-batch-loading-spinner" aria-hidden="true"></span>';
        const placeholder = `<span class="gen-batch-result-placeholder${loading ? " is-loading" : ""}" aria-label="${this._esc(displaySettings.mediaType)}">${loading ? loadingIndicator : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mediaIcon}</svg>`}</span>`;
        const errorTooltip = item.error
          ? `${this._t(state === "NEEDS_REVIEW" ? "unverifiedError" : "errorDetail", state === "NEEDS_REVIEW" ? "Result not confirmed" : "Error details")}: ${this._errorText(item.error)}`
          : "";
        const reviewEditable =
          this._canEditUnsettled(batch, run) &&
          ["NEEDS_REVIEW", "FAILED", "PARTIAL_FAIL"].includes(state);
        const reviewRun =
          run?.run.status === "RUNNING" && this._canEditUnsettled(batch, run);
        const editable = !this._isItemProcessing(item);
        const canRegen = !this._isItemProcessing(item);
        const canRunPrompt = canRegen && state !== "COMPLETED";
        const itemMenu = `<button type="button" class="gen-batch-menu-trigger" data-action="web-item-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this._esc(this._t("moreActions", "More actions"))}"><svg width="14" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg></button>
        <div class="gen-batch-action-menu" role="menu" hidden>
          ${canRunPrompt ? `<button type="button" role="menuitem" data-action="web-run-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}">${this._esc(this._batchT("runItem", "Run prompt"))}</button>` : ""}
          ${editable ? `<button type="button" role="menuitem" data-action="web-edit" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}">${this._esc(this._t("edit", "Edit prompt"))}</button>` : `<button type="button" role="menuitem" data-action="web-detail" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}">${this._esc(this._t("details", "Details"))}</button>`}
          ${results.length ? `<button type="button" role="menuitem" data-action="web-add-item-to-references" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}">${this._esc(this._batchT("addToReferences", "Add to references"))}</button>` : ""}
          ${results.length ? `<button type="button" role="menuitem" data-action="web-download" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}">${this._esc(this._t("download", "Download"))}</button>` : ""}
          ${run && state !== "QUEUED" && !canRunPrompt ? `<button type="button" role="menuitem" data-action="web-regen-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}" ${canRegen ? "" : `disabled data-tooltip="${this._esc(this._batchT("regenUnavailable", "Regeneration unavailable until this run is confirmed"))}"`}>${this._esc(this._batchT("regen", "Regenerate"))}</button>` : ""}
          <button type="button" role="menuitem" data-action="web-delete-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}">${this._esc(this._batchT("delete", "Delete"))}</button>
        </div>`;
        const promptText = item.displayPrompt || item.prompt || item.text || "";
        const promptAction = editable ? "web-edit" : "web-detail";
        return `<div class="gen-batch-item${results.length > 1 ? " has-multiple-results" : ""}" data-item-index="${item.promptIndex ?? index}">
        <div class="gen-batch-item-thumb"${loading ? ' aria-busy="true"' : ""}${results.length > 1 ? ` data-result-count="${results.length}"` : ""}>${resultsHtml || placeholder}${loading && results.length ? `<span class="gen-batch-regen-loading">${loadingIndicator}</span>` : ""}</div>
        <div class="gen-batch-item-main"><button type="button" class="gen-batch-prompt" data-action="${promptAction}" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex ?? index}" title="${this._esc(promptText)}">${this._esc(item.quantity > 1 ? `${item.quantity}\xD7 ${promptText}` : promptText)}</button>
        <div class="gen-batch-item-detail"><div class="gen-batch-item-meta">${this.host._modelBrandIcon?.(this.provider) || ""}<span class="gen-batch-item-model" title="${this._esc(itemModelLabel)}">${this._esc(itemModelLabel)}</span><span class="gen-batch-item-ratio">${this._esc(itemSettings.ratio || displaySettings.ratio)}</span>${Number(item.retrySubmitCount) > 0 ? `<span class="gen-batch-item-retry-count">${this._esc(this._t("retryCount", `Retry ${item.retrySubmitCount}`, { count: item.retrySubmitCount }))}</span>` : ""}</div>${refsHtml ? `<span class="gen-batch-ref-thumbs">${refsHtml}</span>` : ""}</div></div>
        <span class="gen-batch-item-status" data-state="${this._esc(displayState === "NEEDS_REVIEW" ? "needs_review" : String(displayState))}" ${download ? `data-download-state="${download}"` : ""} ${errorTooltip ? `data-tooltip="${this._esc(errorTooltip)}" tabindex="0"` : ""}>${this._esc(statusText)}</span>
        <div class="gen-batch-item-menu">${this.host._decorateMenu(itemMenu)}</div>
      </div>`;
      })
      .join("");
    const highlighted = this.highlightBatchId === batch.id;
    const highlightDelay =
      highlighted && this.highlightStartedAt
        ? ` style="animation-delay:-${Math.min(2400, Math.max(0, Date.now() - this.highlightStartedAt))}ms"`
        : "";
    const canEditBatch = true;
    const canRerunBatch = sourceItems.length > 0;
    const canDeleteBatch = this._canDelete(batch, run);
    const unavailableHint = this._esc(
      this._t(
        "actionUnavailable",
        "This action is unavailable in the current batch state.",
      ),
    );
    return `<article class="gen-batch-card gen-batch-web-card${highlighted ? " is-just-added" : ""}"${highlightDelay} data-web-batch="${this._esc(batch.id)}">
      <div class="gen-batch-card-header"><span class="gen-batch-name" data-action="web-rename" data-batch="${this._esc(batch.id)}" tabindex="0">${this._esc(title)}</span>
        <span class="gen-batch-status" data-state="${this._esc(["RUNNING", "PAUSED", "STOPPED", "NEEDS_REVIEW"].includes(status) ? status.toLowerCase() : status)}"><span class="gen-batch-status-dot" aria-hidden="true"></span><span>${this._esc(this._t(String(status).toLowerCase(), this.host._statusLabel(status)))} \xB7 ${done}/${sourceItems.length}</span></span>
        <div class="gen-batch-card-actions">
        ${(batch.status === "QUEUED" && !run && batch.source !== "gentab_direct") || retryUnadmitted ? `<button type="button" class="gen-batch-icon-action gen-batch-run-action" data-action="web-run" data-batch="${this._esc(batch.id)}" aria-label="${this._esc(this._t("run", "Run batch"))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg></button>` : ""}
        ${run?.items.some((item) => !item.hidden && item.resultReceipts?.length) ? `<button type="button" class="gen-batch-icon-action gen-batch-download-action" data-action="web-download-batch" data-batch="${this._esc(batch.id)}" data-tooltip="${this._esc(this._t("download", "Download"))}" aria-label="${this._esc(this._t("download", "Download"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg></button>` : ""}
        ${running ? `<button type="button" class="gen-batch-icon-action gen-batch-runtime-action" data-action="web-stop" data-batch="${this._esc(batch.id)}" aria-label="${this._esc(this._t("stop", "Stop batch"))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>` : ""}
        ${running ? `<button type="button" class="gen-batch-icon-action gen-batch-runtime-action" data-action="web-pause" data-batch="${this._esc(batch.id)}" aria-label="${this._esc(this._t("pause", "Pause batch"))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></button>` : ""}
        <button type="button" class="gen-batch-menu-trigger" data-action="web-item-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this._esc(this._t("moreActions", "More actions"))}"><svg width="14" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg></button><div class="gen-batch-action-menu" role="menu" hidden>
          ${retryUnadmitted ? this.host._decorateMenu(`<button type="button" role="menuitem" data-action="web-run" data-batch="${this._esc(batch.id)}">${this._esc(this._t("run", "Run batch"))}</button>`) : ""}
          ${this.host._decorateMenu(`<button type="button" role="menuitem" data-action="web-edit-batch" data-batch="${this._esc(batch.id)}" ${canEditBatch ? "" : `disabled data-tooltip="${unavailableHint}"`}>${this._esc(this._batchT("editBatch", "Edit batch"))}</button>`)}
          ${this.host._decorateMenu(`<button type="button" role="menuitem" data-action="web-add-results-to-references" data-batch="${this._esc(batch.id)}" ${sourceItems.some((item) => item.resultReceipts?.length) ? "" : "disabled"}>${this._esc(this._batchT("addResultsToReferences", "Add results to references"))}</button>`)}
          ${run ? this.host._decorateMenu(`<button type="button" role="menuitem" data-action="web-run-unfinished" data-batch="${this._esc(batch.id)}" ${canRerunBatch && rerunCount ? "" : "disabled"} ${rerunHint || !canRerunBatch ? `data-tooltip="${this._esc(rerunHint || this._t("actionUnavailable", "This action is unavailable in the current batch state."))}"` : ""}>${this._esc(this._t("runFailedPending", "Run failed/pending prompts"))} (${rerunCount})</button>`) : ""}
          ${this.host._decorateMenu(`<button type="button" role="menuitem" data-action="web-regen-batch" data-batch="${this._esc(batch.id)}" ${canRerunBatch ? "" : `disabled data-tooltip="${unavailableHint}"`}>${this._esc(batch.source === "gentab_direct" ? this._batchT("regen", "Regenerate") : this._batchT("regenBatch", "Regenerate batch"))} (${sourceItems.length})</button>`)}
          ${this.host._decorateMenu(`<button type="button" role="menuitem" data-action="web-delete" data-batch="${this._esc(batch.id)}" ${canDeleteBatch ? "" : `disabled data-tooltip="${unavailableHint}"`}>${this._esc(this._t("delete", "Delete batch"))}</button>`)}</div>
      </div></div><div class="gen-batch-card-items">${rows}
      ${sourceItems.length > 5 ? `<button type="button" class="gen-batch-show-more" data-action="web-more" data-batch="${this._esc(batch.id)}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${all ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"}"/></svg><span>${this._esc(all ? this._t("less", "Show less") : this._t("more", `Show ${sourceItems.length - 5} more prompts`, { count: sourceItems.length - 5 }))}</span></button>` : ""}
    </div></article>`;
  }
  _mcpCard(batch) {
    const snapshot = this.runs.get(batch.id);
    const rerunDisabled = false;
    const items = (snapshot?.items || []).filter((item) => !item.hidden);
    const done = items.filter((item) => item.state === "COMPLETED").length;
    const shown = this.showAll.has(batch.id) ? items : items.slice(0, 5);
    const title = batch.batchName || new Date(batch.createdAt).toLocaleString();
    const status = this._displayStatus(batch, snapshot);
    const effectiveRunStatus = status;
    const mediaType =
      (snapshot?.run.displaySettingsSnapshot || batch.settingsSnapshot)
        ?.mediaType === "video"
        ? "video"
        : "image";
    const mediaIcon =
      mediaType === "video"
        ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
        : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    const rows = shown
      .map((item) => {
        const state = item.state || "QUEUED";
        const results = item.resultReceipts || [];
        const resultCount = results.length;
        const displayState = this._retryQueued(batch, item, snapshot)
          ? "RETRY_QUEUED"
          : state;
        const label =
          displayState === "RETRY_QUEUED"
            ? this._t("retryQueued", "Waiting to retry")
            : displayState === "MONITORING"
              ? this._batchT("status_monitoring", "Generating")
              : this._t(
                  displayState.toLowerCase(),
                  this.host._statusLabel(displayState),
                );
        const resultsHtml = results
          .map(
            (result) =>
              `<button type="button" class="gen-batch-result${result.mediaType === "video" && !result.posterAssetKey ? "" : " is-preview-loading"}" data-media-type="${result.mediaType === "video" ? "video" : "image"}" data-action="web-preview" data-asset="${this._esc(result.assetKey)}" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}" aria-label="${this._esc(this._t("preview", "Preview result"))}">${result.mediaType === "video" && !result.posterAssetKey ? "" : `<img data-web-asset="${this._esc(result.mediaType === "video" ? result.posterAssetKey : result.assetKey)}" data-web-batch="${this._esc(batch.id)}" loading="lazy" alt="">`}<span class="gen-batch-result-mode" data-mode="${snapshot?.run?.settingsSnapshot?.museGenMode === "api" ? "api" : "web"}" aria-hidden="true">${snapshot?.run?.settingsSnapshot?.museGenMode === "api" ? "API" : "WEB"}</span></button>`,
          )
          .join("");
        const loading = [
          "PREPARING",
          "SUBMITTING",
          "MONITORING",
          "RETRY_QUEUED",
        ].includes(displayState);
        const loadingIndicator =
          this.host._loadingIndicator?.(
            item.processingStartedAt || item.updatedAt,
          ) ||
          '<span class="gen-batch-loading-spinner" aria-hidden="true"></span>';
        const placeholder = `<span class="gen-batch-result-placeholder${loading ? " is-loading" : ""}" aria-label="${this._esc(mediaType)}">${loading ? loadingIndicator : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mediaIcon}</svg>`}</span>`;
        const error = item.error
          ? ` data-tooltip="${this._esc(this._errorText(item.error))}" tabindex="0"`
          : "";
        return `<div class="gen-batch-item${resultCount > 1 ? " has-multiple-results" : ""}" data-item-index="${item.promptIndex}">
        <div class="gen-batch-item-thumb"${loading ? ' aria-busy="true"' : ""}${resultCount > 1 ? ` data-result-count="${resultCount}"` : ""}>${resultsHtml || placeholder}${loading && resultCount ? `<span class="gen-batch-regen-loading">${loadingIndicator}</span>` : ""}</div>
          <div class="gen-batch-item-main"><button type="button" class="gen-batch-prompt" data-action="web-mcp-edit-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}" ${this._isItemProcessing(item) ? "disabled" : ""} title="${this._esc(item.displayPrompt || item.prompt)}">${this._esc(item.displayPrompt || item.prompt)}</button>
          <div class="gen-batch-item-detail"><div class="gen-batch-item-meta">${this.host._modelBrandIcon?.(this.provider) || ""}<span class="gen-batch-item-model">${this._esc(item.displaySettingsOverride?.model || item.settingsOverride?.model || snapshot?.run.displaySettingsSnapshot?.model || batch.settingsSnapshot?.model || "")}</span><span class="gen-batch-item-ratio">${this._esc(item.displaySettingsOverride?.ratio || item.settingsOverride?.ratio || snapshot?.run.displaySettingsSnapshot?.ratio || batch.settingsSnapshot?.ratio || "")}</span></div></div></div>
        <span class="gen-batch-item-status" data-state="${this._esc(displayState === "NEEDS_REVIEW" ? "needs_review" : displayState)}"${error}>${this._esc(label)}</span>
        <div class="gen-batch-item-menu">${this.host
          ._decorateMenu(`<button type="button" class="gen-batch-menu-trigger" data-action="web-item-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this._esc(this._t("moreActions", "More actions"))}"><svg width="14" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg></button>
          <div class="gen-batch-action-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-action="web-mcp-edit-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}" ${this._isItemProcessing(item) ? "disabled" : ""}>${this._esc(this._t("edit", "Edit prompt"))}</button>
            ${resultCount ? `<button type="button" role="menuitem" data-action="web-add-item-to-references" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}">${this._esc(this._batchT("addToReferences", "Add to references"))}</button>` : ""}
            ${resultCount ? `<button type="button" role="menuitem" data-action="web-download" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}">${this._esc(this._t("download", "Download"))}</button>` : ""}
            <button type="button" role="menuitem" data-action="web-mcp-rerun-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}" ${this._isItemProcessing(item) ? "disabled" : ""}>${this._esc(this._batchT("regen", "Run again"))}</button>
            <button type="button" role="menuitem" data-action="web-mcp-delete-item" data-batch="${this._esc(batch.id)}" data-index="${item.promptIndex}">${this._esc(this._batchT("delete", "Delete"))}</button>
          </div>`)}</div>
      </div>`;
      })
      .join("");
    return `<article class="gen-batch-card gen-batch-web-card gen-batch-mcp-card" data-web-batch="${this._esc(batch.id)}">
      <div class="gen-batch-card-header"><span class="gen-batch-name" data-action="web-rename" data-batch="${this._esc(batch.id)}" tabindex="0" title="${this._esc(batch.mcpJobId || "")}">MCP \xB7 ${this._esc(title)}</span>
        <span class="gen-batch-status" data-state="${this._esc(["RUNNING", "PAUSED", "STOPPED", "NEEDS_REVIEW"].includes(status) ? status.toLowerCase() : status)}"><span class="gen-batch-status-dot" aria-hidden="true"></span><span>${this._esc(this._t(status.toLowerCase(), this.host._statusLabel(status)))} \xB7 ${done}/${items.length}</span></span>
        <div class="gen-batch-card-actions">${snapshot?.manualLatestStatus === "QUEUED" && !this._isRunning(batch) ? `<button type="button" class="gen-batch-icon-action gen-batch-run-action" data-action="web-mcp-resume" data-batch="${this._esc(batch.id)}" aria-label="${this._esc(this._t("run", "Run batch"))}"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg></button>` : ""}${items.some((item) => item.resultReceipts?.length) ? `<button type="button" class="gen-batch-icon-action gen-batch-download-action" data-action="web-download-batch" data-batch="${this._esc(batch.id)}" data-tooltip="${this._esc(this._t("download", "Download"))}" aria-label="${this._esc(this._t("download", "Download"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5M12 15V3"/></svg></button>` : ""}${this
          .host
          ._decorateMenu(`<button type="button" class="gen-batch-menu-trigger" data-action="web-item-menu" aria-haspopup="menu" aria-expanded="false" aria-label="${this._esc(this._t("moreActions", "More actions"))}"><svg width="14" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="8" cy="3" r="1.5"/><circle cx="8" cy="8" r="1.5"/><circle cx="8" cy="13" r="1.5"/></svg></button>
          <div class="gen-batch-action-menu" role="menu" hidden>
            <button type="button" role="menuitem" data-action="web-mcp-edit-batch" data-batch="${this._esc(batch.id)}">${this._esc(this._batchT("editBatch", "Edit batch"))}</button>
            <button type="button" role="menuitem" data-action="web-add-results-to-references" data-batch="${this._esc(batch.id)}" ${items.some((item) => item.resultReceipts?.length) ? "" : "disabled"}>${this._esc(this._batchT("addResultsToReferences", "Add results to references"))}</button>
            ${items.some((item) => item.resultReceipts?.length) ? `<button type="button" role="menuitem" data-action="web-download-batch" data-batch="${this._esc(batch.id)}">${this._esc(this._t("download", "Download"))}</button>` : ""}
            <button type="button" role="menuitem" data-action="web-mcp-rerun-unfinished" data-batch="${this._esc(batch.id)}" ${!rerunDisabled && items.some((item) => ["FAILED", "PARTIAL_FAIL", "QUEUED"].includes(item.state)) ? "" : "disabled"}>${this._esc(this._t("runFailedPending", "Run failed/pending prompts"))} (${items.filter((item) => ["FAILED", "PARTIAL_FAIL", "QUEUED"].includes(item.state)).length})</button>
            <button type="button" role="menuitem" data-action="web-mcp-rerun-batch" data-batch="${this._esc(batch.id)}" ${!rerunDisabled && items.length ? "" : "disabled"}>${this._esc(this._batchT("regenBatch", "Run again"))} (${items.length})</button>
            <button type="button" role="menuitem" data-action="web-mcp-delete-batch" data-batch="${this._esc(batch.id)}">${this._esc(this._batchT("delete", "Delete batch"))}</button>
          </div>`)}</div></div>
      <div class="gen-batch-card-items">${rows}${items.length > 5 ? `<button type="button" class="gen-batch-show-more" data-action="web-more" data-batch="${this._esc(batch.id)}">${this._esc(this.showAll.has(batch.id) ? this._t("less", "Show less") : this._t("more", `Show ${items.length - 5} more prompts`, { count: items.length - 5 }))}</button>` : ""}</div>
    </article>`;
  }
  render() {
    const host = this.host;
    if (this._loadedProvider && this._loadedProvider !== this.provider) {
      this.batches = [];
      this.runs.clear();
    }
    const scope = this._scope();
    const count = this.batches.filter(
      (batch) => batch.source !== "mcp_direct" && batch.status === "QUEUED",
    ).length;
    host.overlay.querySelector(".gen-batch-count").textContent = this._t(
      "summary",
      `${this.batches.length} ${this._providerLabel()} batches \xB7 ${count} queued`,
      {
        batches: this.batches.length,
        queued: count,
        provider: this._providerLabel(),
      },
    );
    host.body.innerHTML = this.batches.length
      ? this.batches
          .slice(0, this.visibleCount)
          .map((batch) => this._card(batch))
          .join("") +
        (this.batches.length > this.visibleCount
          ? `<button type="button" class="gen-batch-show-more" data-action="web-more-batches"><span>${this._esc(this._t("moreBatches", "Show more batches"))}</span></button>`
          : "")
      : host._emptyState(
          this.provider,
          this._t("empty", `No ${this._providerLabel()} batches`, {
            provider: this._providerLabel(),
          }),
        );
    const gate = this._workerGate();
    for (const button of host.body.querySelectorAll(
      '[data-action="web-run"], [data-action="web-run-item"], [data-action="web-resume"]',
    )) {
      const batch = this.batches.find(
        (entry) => entry.id === button.dataset.batch,
      );
      if (batch && this._workerEnabled(batch.provider, batch.settingsSnapshot))
        continue;
      if (
        button.dataset.action === "web-run-item" &&
        this.runs.has(button.dataset.batch)
      )
        continue;
      button.disabled = true;
      button.dataset.tooltip = batch
        ? this._workerGate(batch.provider, batch.settingsSnapshot).reason
        : gate.reason;
    }
    const controls = host.overlay.querySelector(".gen-batch-run-controls");
    controls.hidden = false;
    const running = this._visibleRunning().length > 0;
    const paused = this._visiblePaused();
    const resumable = !running && paused.length === 1;
    const icons = {
      play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>',
      pause:
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
      stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>',
    };
    const runAll = controls.querySelector('[data-action="run-all"]');
    const runLabel = this._t("runAll", `Run ${this._providerLabel()} batches`, {
      provider: this._providerLabel(),
    });
    runAll.innerHTML = `<span aria-hidden="true">${icons.play}</span><span>${this._esc(runLabel)}</span>`;
    runAll.setAttribute("aria-label", runLabel);
    runAll.dataset.tooltip = gate.reason || runLabel;
    runAll.disabled =
      !count ||
      !scope ||
      running ||
      paused.length > 0 ||
      !this.batches.some(
        (batch) =>
          batch.status === "QUEUED" &&
          this._workerEnabled(batch.provider, batch.settingsSnapshot),
      );
    const pause = controls.querySelector('[data-action="pause"]');
    const pauseLabel = this._t("pause", "Pause");
    pause.innerHTML = `<span aria-hidden="true">${icons.pause}</span>`;
    pause.setAttribute("aria-label", pauseLabel);
    pause.dataset.tooltip = pauseLabel;
    pause.hidden = !running;
    pause.disabled = !running;
    const resume = controls.querySelector('[data-action="resume"]');
    const resumeLabel = this._t("resume", "Resume");
    resume.innerHTML = `<span aria-hidden="true">${icons.play}</span>`;
    resume.setAttribute("aria-label", resumeLabel);
    resume.dataset.tooltip = resumeLabel;
    resume.hidden = !resumable;
    resume.disabled = !resumable || !this._workerEnabled();
    const stop = controls.querySelector('[data-action="stop"]');
    const stopLabel = this._t("stop", "Stop");
    stop.innerHTML = `<span aria-hidden="true">${icons.stop}</span>`;
    stop.setAttribute("aria-label", stopLabel);
    stop.dataset.tooltip = stopLabel;
    stop.hidden = !running;
    stop.disabled = !running;
    controls.classList.toggle("is-idle", !running && !resumable);
    host.overlay.querySelector(".gen-batch-clear-controls").hidden = true;
    this._hydrate().catch((error) =>
      console.warn(
        "[ProviderWebBatchView] Thumbnail:",
        error?.message || error,
      ),
    );
  }
  async _hydrate() {
    if (this.provider === "gemini" || this.provider === "muse") {
      for (const button of this.host.overlay.querySelectorAll(
        '[data-action="web-preview"][data-media-type="video"][data-asset]',
      )) {
        const batch = this.batches.find(
          (entry) => entry.id === button.dataset.batch,
        );
        const receipt = this.runs
          .get(batch?.id)
          ?.items.flatMap((item) => item.resultReceipts || [])
          .find((entry) => entry.assetKey === button.dataset.asset);
        if (receipt?.posterFrameVersion === 2) continue;
        const image =
          button.querySelector("img") || document.createElement("img");
        image.dataset.webVideoAsset = button.dataset.asset;
        image.dataset.webBatch = button.dataset.batch;
        image.loading = "lazy";
        image.alt = "";
        if (!image.isConnected) button.prepend(image);
        button.classList.add("is-preview-loading");
      }
    }
    const nodes = [
      ...this.host.overlay.querySelectorAll(
        "img[data-web-asset], img[data-web-video-asset]",
      ),
    ];
    const load = async (image) => {
      if (!image.isConnected) return;
      const batch = this.batches.find(
        (entry) => entry.id === image.dataset.webBatch,
      );
      if (!batch) return;
      const url = image.dataset.webVideoAsset
        ? (await this._videoPosterFromAsset(
            batch,
            image.dataset.webVideoAsset,
          )) ||
          (image.dataset.webAsset
            ? await this._assetUrl(batch, image.dataset.webAsset)
            : null)
        : await this._assetUrl(batch, image.dataset.webAsset);
      if (image.isConnected && url) {
        image.onload = () =>
          image
            .closest(".is-preview-loading")
            ?.classList.remove("is-preview-loading");
        image.src = url;
        if (image.complete && image.naturalWidth > 0) image.onload();
      }
    };
    this.assetObserver?.disconnect();
    if (typeof IntersectionObserver === "undefined") {
      await Promise.all(nodes.map(load));
      return;
    }
    this.assetObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            this.assetObserver?.unobserve(entry.target);
            load(entry.target).catch((error) =>
              console.warn(
                "[ProviderWebBatchView] Thumbnail:",
                error?.message || error,
              ),
            );
          }
      },
      { root: null, rootMargin: "120px" },
    );
    for (const image of nodes) this.assetObserver.observe(image);
  }
  async add(provider = this.provider) {
    if (!["muse", "chatgpt", "gemini"].includes(provider))
      throw new Error("PROVIDER_BATCH_INVALID");
    const snapshot = await window.GenTab._buildProviderWebSnapshot(
      provider,
      window.GenTab.promptsArea?.value?.trim() || "",
    );
    if (
      provider === "muse" &&
      snapshot.settingsSnapshot.mediaType === "video"
    ) {
      const mode = window.MuseApiFacade.effectiveMode(
        snapshot.settingsSnapshot,
      );
      snapshot.settingsSnapshot.museGenMode = mode;
      if (mode === "web") {
        await window.ExecutionConfig.getConfig();
        const workers = window.ExecutionConfig.getProviderWebWorkers("muse");
        snapshot.settingsSnapshot.museDirect =
          workers.parallelEnabled === false ||
          !workers.enabledProviders.includes("muse");
      }
    }
    const scope = this._scope();
    if (
      String(scope?.userId) !== String(snapshot.userId) ||
      scope?.projectId !== snapshot.projectId
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    const id = crypto.randomUUID();
    await window.ProviderWebQueueStore.createBatch({
      id,
      userId: snapshot.userId,
      projectId: snapshot.projectId,
      provider,
      settingsSnapshot: snapshot.settingsSnapshot,
      prompts: snapshot.prompts,
      refAssets: snapshot.refAssets,
    });
    this.host._view = provider;
    this.highlightBatchId = id;
    this.highlightStartedAt = 0;
    await this.host.reload();
    await this.host.open();
    this.host._view = provider;
    this.highlightStartedAt = Date.now();
    this.host._render();
    this.host.body.scrollTop = 0;
    const card = this.host.body.querySelector(`[data-web-batch="${id}"]`);
    card?.classList.add("is-just-added");
    window.setTimeout(() => {
      if (this.highlightBatchId === id) {
        this.highlightBatchId = null;
        this.highlightStartedAt = 0;
      }
      this.host.body
        .querySelector(`[data-web-batch="${id}"]`)
        ?.classList.remove("is-just-added");
    }, 2500);
  }
  async _run(
    batch,
    { skipConfirm = false, selectedPromptIndex = null, runAction = null } = {},
  ) {
    const provider = batch.provider;
    if (!this._workerEnabled(provider, batch.settingsSnapshot))
      throw new Error("PROVIDER_WEB_NOT_ROLLED_OUT");
    const retryUnadmitted = this._canRetryUnadmitted(batch);
    if (
      (batch.status !== "QUEUED" && !retryUnadmitted) ||
      this._isRunning(batch)
    )
      return;
    const scope = this._scope();
    if (
      String(scope?.userId) !== String(batch.userId) ||
      scope?.projectId !== batch.projectId
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    if (
      !skipConfirm &&
      !(await this._confirm(
        1,
        selectedPromptIndex === null
          ? batch.prompts.length || this.runs.get(batch.id)?.items.length || 0
          : 1,
        provider,
        [batch],
      ))
    )
      return;
    if (provider === "muse") {
      const ready = window.MuseApiBatchRunner?.applies(batch)
        ? await window.MuseApiBatchRunner.readiness([batch])
        : await window.MuseSession.probeReady();
      if (!ready.ready)
        throw new Error(ready.error || "MUSE_SESSION_NOT_READY");
    }
    if (!window.MuseApiBatchRunner?.applies(batch))
      await window.ProviderWebScheduler._config(
        provider,
        batch.settingsSnapshot,
      );
    const runId = retryUnadmitted
      ? batch.runId
      : batch.source === "gentab_direct"
        ? batch.runId
        : crypto.randomUUID();
    if (!retryUnadmitted && batch.source !== "gentab_direct")
      await window.ProviderWebQueueStore.createRun({
        id: runId,
        batchId: batch.id,
        userId: batch.userId,
        projectId: batch.projectId,
        provider,
        source: "batch",
        settingsSnapshot: batch.settingsSnapshot,
        prompts: batch.prompts,
        selectedPromptIndex,
        batchName: batch.displayName || null,
        runAction:
          runAction ||
          (selectedPromptIndex === null
            ? "BATCH_LIST_RUN_BATCH"
            : "BATCH_LIST_RUN_PROMPT"),
      });
    this.running.add(batch.id);
    this.host.reload().catch((error) => this.host._error(error));
    try {
      const outcome = await window.ProviderWebScheduler.run(runId);
      if (outcome.status === "paused") this.paused.add(batch.id);
      return outcome;
    } catch (error) {
      if (
        (error?.httpStatus === 403 ||
          error?.code === "PROVIDER_WEB_TIMEOUT_CONFIG_MISSING") &&
        batch.source !== "gentab_direct"
      ) {
        await window.ProviderWebQueueStore.discardDeniedUnadmittedBatchRun(
          batch.userId,
          batch.projectId,
          batch.id,
          runId,
        );
      }
      throw error;
    } finally {
      window.ProviderWebScheduler.forgetStop(runId);
      this.running.delete(batch.id);
      await this.host.reload();
    }
  }
  async _mcpRerun(batch, options = {}) {
    return this._rerunSelection(batch, options);
  }
  async _resumeMcpManual(batch) {
    const runId = this.runs.get(batch.id)?.manualLatestRunId;
    if (
      !runId ||
      this.runs.get(batch.id)?.manualLatestStatus !== "QUEUED" ||
      this._isRunning(batch)
    )
      throw new Error("PROVIDER_RUN_NOT_READY");
    const scope = this._scope();
    const snapshot = await window.ProviderWebQueueStore.getRun(runId);
    if (
      String(scope?.userId) !== String(batch.userId) ||
      snapshot?.run?.userId !== String(batch.userId) ||
      snapshot.run.mcpParentRunId !== batch.id ||
      snapshot.run.provider !== batch.provider ||
      snapshot.run.status !== "QUEUED"
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    const ready = await this._probeReady(batch.provider);
    if (!ready.ready)
      throw new Error(ready.error || "PROVIDER_SESSION_NOT_READY");
    if (String(this._scope()?.userId) !== String(batch.userId))
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    this.running.add(batch.id);
    try {
      await this.host.reload();
      return await window.ProviderWebScheduler.run(runId);
    } finally {
      window.ProviderWebScheduler.forgetStop(runId);
      this.running.delete(batch.id);
      await this.host.reload();
    }
  }
  _mcpEdit(batch, promptIndex = null) {
    return promptIndex === null
      ? this._editBatch(batch)
      : this._edit(batch, promptIndex);
  }
  async _regen(batch, promptIndex = null, options = {}) {
    return this._rerunSelection(batch, { ...options, promptIndex });
  }
  async _rerunSelection(
    batch,
    {
      promptIndex = null,
      failedPendingOnly = false,
      fullBatchRerun = false,
      skipConfirm = false,
      expectedRevision = null,
      runId: requestedRunId = null,
      onAccepted = null,
    } = {},
  ) {
    const snapshot = this.runs.get(batch.id);
    if (!snapshot?.run)
      return this._run(batch, {
        skipConfirm,
        selectedPromptIndex: promptIndex,
      });
    const scope = this._scope();
    if (
      String(scope?.userId) !== String(batch.userId) ||
      !scope?.projectId ||
      (batch.source !== "mcp_direct" && scope.projectId !== batch.projectId)
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    const items = snapshot.items.filter(
      (item) =>
        !item.hidden &&
        (promptIndex === null || item.promptIndex === promptIndex) &&
        (!failedPendingOnly ||
          ["FAILED", "PARTIAL_FAIL"].includes(item.state) ||
          (item.state === "QUEUED" && !item.attemptId)),
    );
    if (!items.length) throw new Error("PROVIDER_REGEN_SOURCE_UNAVAILABLE");
    if (
      promptIndex !== null &&
      items.some((item) => this._isItemProcessing(item))
    )
      throw new Error("PROVIDER_ITEM_IN_FLIGHT");
    if (
      !skipConfirm &&
      !(await this._confirm(1, items.length, batch.provider, [batch]))
    )
      return;
    const ready = window.MuseApiBatchRunner?.applies(batch)
      ? await window.MuseApiBatchRunner.readiness([batch])
      : await this._probeReady(batch.provider);
    if (!ready.ready)
      throw new Error(ready.error || "PROVIDER_SESSION_NOT_READY");
    const settings =
      snapshot.run.displaySettingsSnapshot || snapshot.run.settingsSnapshot;
    if (!window.MuseApiBatchRunner?.applies(batch))
      await window.ProviderWebScheduler._config(batch.provider, settings);
    const refs = new Map();
    for (const key of new Set(
      items.flatMap((item) => item.displayRefKeys || item.refKeys || []),
    )) {
      const owner = this._assetOwner(batch, key);
      const asset = await window.ProviderWebQueueStore.getAsset(
        batch.userId,
        owner.projectId,
        key,
        owner.ownerScope,
      );
      if (!(asset?.blob instanceof Blob))
        throw new Error("PROVIDER_REGEN_REF_UNAVAILABLE");
      refs.set(key, {
        id: crypto.randomUUID(),
        blob: asset.blob,
        name: asset.name,
        mentionName: asset.mentionName || null,
        type: asset.type,
      });
    }
    if (
      String(this._scope()?.userId) !== String(batch.userId) ||
      this._scope()?.projectId !== scope.projectId
    )
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    const runId = requestedRunId || crypto.randomUUID();
    await window.ProviderWebQueueStore.createUserRerun({
      id: runId,
      parentId: batch.id,
      source:
        batch.source === "mcp_direct" || batch.source === "gentab_direct"
          ? "web_run"
          : "web_batch",
      userId: batch.userId,
      projectId: scope.projectId,
      expectedRevision,
      settingsSnapshot:
        batch.provider === "muse" &&
        window.MuseVideoContinuity?.enabled(settings) &&
        !(promptIndex === null && (!failedPendingOnly || fullBatchRerun))
          ? {
              ...settings,
              chainParents: items.map(
                (item) =>
                  settings.chainParents?.[item.promptIndex] ||
                  (item.promptIndex > 0
                    ? {
                        runId: snapshot.run.id,
                        promptIndex: item.promptIndex - 1,
                      }
                    : null),
              ),
            }
          : settings,
      fullBatchRerun:
        promptIndex === null && (!failedPendingOnly || fullBatchRerun),
      originalIndexes: items.map((item) => item.promptIndex),
      refAssets: [...refs.values()],
      prompts: items.map((item) => ({
        text: item.displayPrompt || item.prompt,
        quantity: item.quantity || 1,
        refKeys: (item.displayRefKeys || item.refKeys || []).map(
          (key) => refs.get(key).id,
        ),
        settingsOverride:
          item.displaySettingsOverride || item.settingsOverride || {},
      })),
    });
    if (onAccepted) await onAccepted(runId);
    await this.host.reload();
    try {
      return await window.ProviderWebScheduler.run(runId);
    } finally {
      window.ProviderWebScheduler.forgetStop(runId);
      await this.host.reload();
    }
  }
  async _runItem(batch, promptIndex) {
    if (window.MuseApiBatchRunner?.intended(batch) && batch.runId) {
      const item = this.runs
        .get(batch.id)
        ?.items.find((entry) => entry.promptIndex === promptIndex);
      if (item?.musePreSubmitFailure) return this._resume(batch);
      if (item && ["FAILED", "PARTIAL_FAIL", "COMPLETED"].includes(item.state))
        return this._regen(batch, promptIndex);
      return this._resume(batch);
    }
    const provider = batch.provider;
    const scope = this._scope();
    if (
      String(scope?.userId) !== String(batch.userId) ||
      scope?.projectId !== batch.projectId
    )
      throw new Error("PROVIDER_BATCH_RUN_ITEM_UNAVAILABLE");
    if (this.runs.has(batch.id)) return this._regen(batch, promptIndex);
    if (!this._workerEnabled(provider, batch.settingsSnapshot))
      throw new Error("PROVIDER_WEB_NOT_ROLLED_OUT");
    if (batch.status !== "QUEUED")
      throw new Error("PROVIDER_BATCH_RUN_ITEM_UNAVAILABLE");
    if (!(await this._confirm(1, 1, provider, [batch]))) return;
    const ready = window.MuseApiBatchRunner?.applies(batch)
      ? await window.MuseApiBatchRunner.readiness([batch])
      : await this._probeReady(provider);
    if (!ready.ready)
      throw new Error(ready.error || "PROVIDER_SESSION_NOT_READY");
    const current = (
      await window.ProviderWebQueueStore.listBatches(
        batch.userId,
        batch.projectId,
      )
    ).find((entry) => entry.id === batch.id);
    if (
      current?.revision !== batch.revision ||
      current.status !== "QUEUED" ||
      !current.prompts[promptIndex] ||
      String(this._scope()?.userId) !== String(batch.userId) ||
      this._scope()?.projectId !== batch.projectId
    )
      throw new Error("PROVIDER_BATCH_RUN_ITEM_UNAVAILABLE");
    return this._run(current, {
      skipConfirm: true,
      selectedPromptIndex: promptIndex,
    });
  }
  async _confirm(
    batchCount,
    promptCount,
    provider = this.provider,
    batches = null,
  ) {
    const host = this.host;
    if (host._runConfirmResolve) return false;
    const sheet = host.overlay.querySelector(".gen-batch-run-confirm");
    sheet.querySelector("#genBatchRunTitle").textContent = this._t(
      "confirmTitle",
      `Run ${this._providerLabel(provider)} batches`,
      { provider: this._providerLabel(provider) },
      provider,
    );
    sheet.querySelector(".gen-batch-confirm-prompts-label").textContent =
      this._t("promptCount", "Prompts");
    sheet.querySelector(".gen-batch-confirm-prompts").textContent =
      String(promptCount);
    sheet.querySelector(".gen-batch-confirm-batches-label").textContent =
      this._t("batchCount", "Batches");
    sheet.querySelector(".gen-batch-confirm-batches").textContent =
      String(batchCount);
    sheet.querySelector(".gen-batch-confirm-provider-name").textContent =
      this._providerLabel(provider);
    sheet.querySelector(".gen-batch-confirm-logo").innerHTML =
      window.ProviderBrandIcons?.get?.(provider) || "";
    sheet.querySelector(".gen-batch-confirm-media").classList.add("hidden");
    sheet
      .querySelector(".gen-batch-confirm-tabs-warning")
      .classList.add("hidden");
    sheet.querySelector(".confirm-run-cancel").textContent = this._t(
      "cancel",
      "Cancel",
    );
    sheet.querySelector(".confirm-run-submit span").textContent = this._t(
      "run",
      "Run",
    );
    const submit = sheet.querySelector(".confirm-run-submit");
    submit.disabled = true;
    submit.setAttribute("aria-disabled", "true");
    const badge = sheet.querySelector(".gen-batch-confirm-badge");
    badge.className =
      "confirm-run-provider-badge is-checking gen-batch-confirm-badge";
    badge.innerHTML =
      '<svg class="badge-icon badge-icon-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg><span class="badge-text"></span>';
    badge.querySelector(".badge-text").textContent = this._t(
      "checking",
      `Checking ${this._providerLabel(provider)}\u2026`,
      { provider: this._providerLabel(provider) },
      provider,
    );
    sheet.classList.remove("hidden");
    host._runConfirmFocus = document.activeElement;
    const epoch = ++host._runConfirmCheckEpoch;
    const promise = new Promise((resolve) => {
      host._runConfirmResolve = resolve;
    });
    sheet.querySelector(".confirm-run-cancel").focus();
    const current = () =>
      !!host._runConfirmResolve &&
      host._runConfirmCheckEpoch === epoch &&
      !sheet.classList.contains("hidden");
    const renderStatus = (result) => {
      if (!current()) return;
      if (provider === "muse" && window.MuseApiFacade?.readinessLabel)
        sheet.querySelector(".gen-batch-confirm-provider-name").textContent =
          window.MuseApiFacade.readinessLabel(
            this._providerLabel(provider),
            result,
          );
      const ready = result?.ready === true;
      const checking = !ready && result?.error === "MUSE_TAB_LOADING";
      badge.className = `confirm-run-provider-badge ${ready ? "is-ready" : checking ? "is-checking" : "is-warning"} gen-batch-confirm-badge`;
      badge.innerHTML = `<svg class="badge-icon${checking ? " badge-icon-spin" : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true">${ready ? '<polyline points="20 6 9 17 4 12"/>' : checking ? '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>' : '<path d="M12 3 2 21h20L12 3zM12 9v5m0 3h.01"/>'}</svg><span class="badge-text"></span>`;
      badge.querySelector(".badge-text").textContent = ready
        ? this._t("ready", "Ready")
        : checking
          ? this._t(
              "checking",
              `Checking ${this._providerLabel(provider)}\u2026`,
              { provider: this._providerLabel(provider) },
              provider,
            )
          : result?.error &&
              ![
                "NOT_MUSE_URL",
                "NOT_CHATGPT_URL",
                "NOT_GEMINI_URL",
                "NO_TAB",
              ].includes(result.error)
            ? this._errorText(result.error)
            : this._t(
                "notReady",
                `Open and sign in to ${this._providerLabel(provider)}`,
                { provider: this._providerLabel(provider) },
                provider,
              );
      submit.disabled = !ready;
      submit.setAttribute("aria-disabled", String(!ready));
    };
    let inFlight = false;
    const check = async (initial = false) => {
      if (!current() || inFlight) return;
      inFlight = true;
      try {
        const result = await (provider === "muse" &&
        batches?.some((batch) => window.MuseApiBatchRunner?.applies(batch))
          ? window.MuseApiBatchRunner.readiness(batches)
          : initial && provider === "muse"
            ? window.MuseSession.ensureReady({
                createIfMissing: true,
                activate: true,
                waitForComposer: true,
                silent: true,
              })
            : initial && (provider === "chatgpt" || provider === "gemini")
              ? window[
                  provider === "chatgpt" ? "ChatGPTSession" : "GeminiSession"
                ]?.ensureReady({
                  createIfMissing: true,
                  activate: true,
                  forceCheck: true,
                  waitForEditorMs: 12e3,
                  silent: true,
                }) ||
                Promise.resolve({ ready: false, error: "SESSION_NOT_LOADED" })
              : this._probeReady(provider));
        renderStatus(result);
      } catch (_) {
        renderStatus({ ready: false });
      } finally {
        inFlight = false;
      }
    };
    void check(true);
    if (host._runConfirmStatusTimer) clearInterval(host._runConfirmStatusTimer);
    host._runConfirmStatusTimer = setInterval(() => {
      void check();
    }, 3e3);
    return promise;
  }
  async _resume(batch) {
    if (window.MuseApiBatchRunner?.intended(batch)) {
      this.running.add(batch.id);
      this.paused.delete(batch.id);
      try {
        const outcome = await window.MuseApiBatchRunner.run(batch.runId);
        if (outcome.status === "paused") this.paused.add(batch.id);
        return outcome;
      } finally {
        this.running.delete(batch.id);
        await this.host.reload();
      }
    }
    const provider = batch.provider;
    if (!this._workerEnabled(provider, batch.settingsSnapshot))
      throw new Error("PROVIDER_WEB_NOT_ROLLED_OUT");
    const scope = this._scope();
    const manualId = this.runs.get(batch.id)?.manualActiveRunId;
    if (manualId) {
      if (
        String(scope?.userId) !== String(batch.userId) ||
        scope?.projectId !== batch.projectId
      )
        throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
      const manual = await window.ProviderWebQueueStore.getRun(manualId);
      if (
        manual?.run?.status === "SETTLED" ||
        manual?.items.some((item) => item.state === "NEEDS_REVIEW")
      )
        throw new Error("PROVIDER_REGEN_RESUME_UNAVAILABLE");
      const pending2 = manual.items.filter(
        (item) => item.state === "QUEUED",
      ).length;
      if (!pending2 || !(await this._confirm(1, pending2, provider))) return;
      const ready2 = await this._probeReady(provider);
      if (!ready2.ready)
        throw new Error(ready2.error || "PROVIDER_SESSION_NOT_READY");
      if (!window.MuseApiBatchRunner?.applies(batch))
        await window.ProviderWebScheduler._config(provider);
      this.running.add(batch.id);
      try {
        await window.ProviderWebScheduler.run(manualId);
      } finally {
        window.ProviderWebScheduler.forgetStop(manualId);
        this.running.delete(batch.id);
        await this.host.reload();
      }
      return;
    }
    if (
      (!this.paused.has(batch.id) && batch.status !== "RUNNING") ||
      !batch.runId ||
      String(scope?.userId) !== String(batch.userId) ||
      scope?.projectId !== batch.projectId
    )
      throw new Error("PROVIDER_BATCH_RESUME_UNAVAILABLE");
    const pending =
      this.runs.get(batch.id)?.items.filter((item) => item.state === "QUEUED")
        .length || 0;
    if (!(await this._confirm(1, pending, provider))) return;
    const ready = await this._probeReady(provider);
    if (!ready.ready)
      throw new Error(ready.error || "PROVIDER_SESSION_NOT_READY");
    if (!window.MuseApiBatchRunner?.applies(batch))
      await window.ProviderWebScheduler._config(provider);
    this.paused.delete(batch.id);
    this.running.add(batch.id);
    try {
      const outcome = await window.ProviderWebScheduler.run(batch.runId);
      if (outcome.status === "paused") this.paused.add(batch.id);
    } finally {
      window.ProviderWebScheduler.forgetStop(batch.runId);
      this.running.delete(batch.id);
      await this.host.reload();
    }
  }
  async _download(batch, index) {
    const item = this.runs
      .get(batch.id)
      ?.items.find((entry) => entry.promptIndex === index);
    if (!item?.resultReceipts?.length) return;
    const key = `${batch.id}:${index}`;
    if (this.downloading.has(key)) return;
    this.downloading.add(key);
    this.render();
    try {
      const settings = await window.DownloadHelper.getSettings();
      const mcpSettings =
        batch.source === "mcp_direct"
          ? await window.McpExecutor._getMcpDownloadSettings()
          : null;
      const taskName = mcpSettings
        ? window.McpExecutor._mcpDownloadTaskName(
            mcpSettings.downloadFolder,
            batch.batchName,
          )
        : batch.settingsSnapshot.downloadSubFolder || "";
      const downloadIndex = index + 1;
      for (const receipt of item?.resultReceipts || []) {
        const url = await this._assetUrl(batch, receipt.assetKey);
        if (!url) throw new Error("PROVIDER_RESULT_ASSET_MISSING");
        const owner = this._assetOwner(batch, receipt.assetKey);
        const asset = await window.ProviderWebQueueStore.getAsset(
          batch.userId,
          owner.projectId,
          receipt.assetKey,
          owner.ownerScope,
        );
        if (!asset?.blob?.size)
          throw new Error("PROVIDER_RESULT_ASSET_MISSING");
        const isVideo = receipt.mediaType === "video";
        const ext = isVideo
          ? { "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv" }[
              asset.blob.type
            ]
          : batch.settingsSnapshot?.museGenMode === "api"
            ? { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }[
                asset.blob.type
              ]
            : "jpg";
        if (!ext) throw new Error("PROVIDER_RESULT_VIDEO_FORMAT_UNKNOWN");
        const filename = window.DownloadHelper.buildFilename({
          template: settings.template,
          project: settings.project || window._currentProjectName || "flow",
          prompt: item.prompt,
          index: downloadIndex + (receipt.index || 0),
          taskName,
          folder: settings.folder,
          ext,
        });
        let response;
        if (isVideo) {
          if (batch.provider === "gemini") {
            response = await window.DownloadHelper.downloadStoredProviderVideo({
              blob: asset.blob,
              filename,
              waitForComplete: true,
              watermarkEnabled:
                batch.settingsSnapshot.geminiRemoveWatermarkVideo,
            });
          } else {
            response = await new Promise((resolve) =>
              chrome.runtime.sendMessage(
                {
                  action: "chromeDownload",
                  url,
                  filename,
                  waitForComplete: true,
                },
                (value) =>
                  resolve(
                    chrome.runtime.lastError
                      ? {
                          success: false,
                          error: chrome.runtime.lastError.message,
                        }
                      : value,
                  ),
              ),
            );
          }
        } else {
          if (batch.provider === "gemini") {
            response = await window.DownloadHelper.downloadStoredProviderImage({
              blob: asset.blob,
              filename,
              waitForComplete: true,
              watermarkEnabled: batch.settingsSnapshot.geminiRemoveWatermark,
            });
          } else {
            if (!/^image\//.test(asset.blob.type))
              throw new Error("PROVIDER_RESULT_IMAGE_INVALID");
            const dataUrl = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result);
              reader.onerror = () =>
                reject(
                  reader.error || new Error("PROVIDER_RESULT_READ_FAILED"),
                );
              reader.readAsDataURL(asset.blob);
            });
            response = await window.DownloadHelper.downloadImageAsJpeg({
              dataUrl,
              filename,
              waitForComplete: true,
            });
          }
        }
        if (!response?.success)
          throw new Error(response?.error || "PROVIDER_RESULT_DOWNLOAD_FAILED");
      }
    } finally {
      this.downloading.delete(key);
      this.render();
    }
  }
  async _downloadBatch(batch) {
    const items = this.runs.get(batch.id)?.items || [];
    for (const item of items) {
      if (!item.hidden && item.resultReceipts?.length)
        await this._download(batch, item.promptIndex);
    }
  }
  async action(button) {
    const action = button.dataset.action;
    const batch = this.batches.find(
      (entry) => entry.id === button.dataset.batch,
    );
    if (action === "web-add-results-to-references" && batch)
      return this._addResultsToReferences(batch);
    if (action === "web-add-item-to-references" && batch) {
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || index < 0)
        throw new Error("PROVIDER_ITEM_NOT_FOUND");
      return this._addResultsToReferences(batch, index);
    }
    if (action === "web-rename" && batch) return this._rename(button, batch);
    if (action === "web-more" && batch) {
      if (this.showAll.has(batch.id)) this.showAll.delete(batch.id);
      else this.showAll.add(batch.id);
      this.render();
      return;
    }
    if (action === "web-more-batches") {
      this.visibleCount += 20;
      this.render();
      return;
    }
    if (action === "web-clear-all") {
      const scope = this._scope();
      const deletable = this.batches;
      if (!scope) throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
      const count = deletable.length;
      if (
        !count ||
        !(await this.host._confirmDelete(
          this._batchT(
            "clearAllConfirm",
            `Delete ${count} ${this._providerLabel()} batches in this project?`,
            {
              batches: count,
              provider: this._providerLabel(),
              prompts: deletable.reduce(
                (sum, batch2) =>
                  sum +
                  (this.runs.get(batch2.id)?.items.length ||
                    batch2.prompts.length),
                0,
              ),
            },
          ),
          this._batchT("clearAll", "Clear all"),
        ))
      )
        return;
      if (
        String(this._scope()?.userId) !== String(scope.userId) ||
        this._scope()?.projectId !== scope.projectId
      )
        throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
      try {
        for (const batch2 of deletable) await this._deleteCurrent(batch2);
      } finally {
        this.clearUrls();
        await this.host.reload();
      }
      return;
    }
    if (action === "web-item-menu") {
      const menu = button.nextElementSibling;
      if (!menu) return;
      const open = menu.hidden;
      for (const other of this.host.overlay.querySelectorAll(
        ".gen-batch-action-menu:not([hidden])",
      )) {
        other.hidden = true;
        other.previousElementSibling?.setAttribute("aria-expanded", "false");
      }
      menu.hidden = !open;
      button.setAttribute("aria-expanded", String(open));
      if (open) {
        const box = button.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.right = `${Math.max(6, window.innerWidth - box.right)}px`;
        const menuHeight = menu.getBoundingClientRect().height;
        menu.style.top = `${box.bottom + menuHeight + 8 > window.innerHeight ? Math.max(6, box.top - menuHeight - 4) : box.bottom + 4}px`;
        menu
          .querySelector("button:not(:disabled)")
          ?.focus({ preventScroll: true });
      }
      return;
    }
    if (action === "web-run" && batch) return this._run(batch);
    if (action === "web-run-item" && batch)
      return this._runItem(batch, Number(button.dataset.index));
    if (action === "web-pause" && batch) {
      window.ProviderWebScheduler.pause(
        this.runs.get(batch.id)?.manualActiveRunId || batch.runId,
      );
      this.paused.add(batch.id);
      this.render();
      return;
    }
    if (action === "web-resume" && batch) return this._resume(batch);
    if (action === "web-run-all") {
      const provider = this.provider;
      const queue = this.batches
        .filter(
          (entry) => entry.source !== "mcp_direct" && entry.status === "QUEUED",
        )
        .reverse();
      const total = queue.reduce(
        (sum, entry) =>
          sum +
          (entry.prompts.length || this.runs.get(entry.id)?.items.length || 0),
        0,
      );
      if (
        queue.some(
          (entry) => !this._workerEnabled(provider, entry.settingsSnapshot),
        )
      )
        throw new Error("PROVIDER_WEB_NOT_ROLLED_OUT");
      if (
        !queue.length ||
        !(await this._confirm(queue.length, total, provider, queue))
      )
        return;
      const epoch = (this._runAllEpoch.get(provider) || 0) + 1;
      this._runAllEpoch.set(provider, epoch);
      for (const next of queue) {
        if (this._runAllEpoch.get(provider) !== epoch) break;
        const outcome = await this._run(next, {
          skipConfirm: true,
          runAction: "BATCH_LIST_RUN_ALL",
        });
        if (
          this._runAllEpoch.get(provider) !== epoch ||
          ["paused", "stopped"].includes(outcome?.status)
        )
          break;
      }
      return;
    }
    if (action === "web-pause-all") {
      this._runAllEpoch.set(
        this.provider,
        (this._runAllEpoch.get(this.provider) || 0) + 1,
      );
      for (const batch2 of this._visibleRunning()) {
        window.ProviderWebScheduler.pause(
          this.runs.get(batch2.id)?.manualActiveRunId || batch2.runId,
        );
      }
      return;
    }
    if (action === "web-resume-all") {
      const paused = this._visiblePaused();
      if (paused.length === 1) return this._resume(paused[0]);
      return;
    }
    if (action === "web-stop" && batch)
      return window.ProviderWebScheduler.stop(
        this.runs.get(batch.id)?.manualActiveRunId || batch.runId,
        "BATCH_LIST_STOP",
      );
    if (action === "web-stop-all") {
      this._runAllEpoch.set(
        this.provider,
        (this._runAllEpoch.get(this.provider) || 0) + 1,
      );
      await Promise.all(
        this._visibleRunning().map((batch2) =>
          window.ProviderWebScheduler.stop(
            this.runs.get(batch2.id)?.manualActiveRunId || batch2.runId,
            "BATCH_LIST_STOP_ALL",
          ),
        ),
      );
      return;
    }
    if (action === "web-download" && batch)
      return this._download(batch, Number(button.dataset.index));
    if (action === "web-download-batch" && batch)
      return this._downloadBatch(batch);
    if (batch?.source === "mcp_direct") {
      if (action === "web-mcp-resume") return this._resumeMcpManual(batch);
      if (action === "web-mcp-edit-batch") return this._mcpEdit(batch);
      if (action === "web-mcp-edit-item")
        return this._mcpEdit(batch, Number(button.dataset.index));
      if (action === "web-mcp-rerun-batch") return this._mcpRerun(batch);
      if (action === "web-mcp-rerun-unfinished")
        return this._mcpRerun(batch, { failedPendingOnly: true });
      if (action === "web-mcp-rerun-item")
        return this._mcpRerun(batch, {
          promptIndex: Number(button.dataset.index),
        });
      if (
        action === "web-mcp-delete-batch" ||
        action === "web-mcp-delete-item"
      ) {
        const index =
          action === "web-mcp-delete-item"
            ? Number(button.dataset.index)
            : null;
        if (index !== null && (!Number.isInteger(index) || index < 0))
          throw new Error("PROVIDER_MCP_DELETE_CONFLICT");
        if (
          !(await this.host._confirmDelete(
            index === null
              ? this._batchT("deleteConfirm", "Delete this batch?")
              : this._batchT("deleteItemConfirm", "Delete this prompt?"),
            this._batchT("delete", "Delete"),
          ))
        )
          return;
        this._assertDeleteScope(batch);
        await window.ProviderWebQueueStore.hideBatchListEntry(
          batch.userId,
          batch.projectId,
          batch.id,
          batch.source,
          index,
        );
        return this.host.reload();
      }
    }
    if (action === "web-mcp-detail-batch" && batch?.source === "mcp_direct")
      return this._detailMcpBatch(batch);
    if (action === "web-edit-batch" && batch) return this._editBatch(batch);
    if (action === "web-regen-item" && batch)
      return this._regen(batch, Number(button.dataset.index));
    if (action === "web-regen-batch" && batch)
      return this._regen(batch, null, { fullBatchRerun: true });
    if (action === "web-run-unfinished" && batch)
      return this._regen(batch, null, { failedPendingOnly: true });
    if (action === "web-batch-media-type") {
      const sheet = this.host.overlay.querySelector(".gen-batch-editor");
      const select = sheet.querySelector('[name="webMediaType"]');
      if (!select || select.value === button.dataset.value) return;
      const previous = select.value;
      select.value = button.dataset.value;
      if (!this._refreshBatchSettings(select.value)) {
        select.value = previous;
        throw new Error("PROVIDER_BATCH_CONFIG_UNAVAILABLE");
      }
      sheet.dataset.webMediaType = select.value;
      for (const control of sheet.querySelectorAll(
        '[data-action="web-batch-media-type"]',
      )) {
        const active = control.dataset.value === select.value;
        control.classList.toggle("active", active);
        control.setAttribute("aria-pressed", String(active));
      }
      return;
    }
    if (action === "web-batch-remove-prompt")
      return this._removeBatchPrompt(button);
    if (action === "web-preview" && batch) {
      if (typeof WorkflowEditor === "undefined") return;
      const results = (this.runs.get(batch.id)?.items || [])
        .filter((item) => !item.hidden)
        .flatMap((item) =>
          (item.resultReceipts || []).map((receipt) => ({
            receipt,
            promptIndex: item.promptIndex,
          })),
        );
      const selected = results.findIndex(
        (entry) =>
          entry.receipt.assetKey === button.dataset.asset &&
          entry.promptIndex === Number(button.dataset.index),
      );
      if (selected < 0) return;
      const resolve = async (index) => {
        const entry = results[index];
        const src = await this._assetUrl(batch, entry.receipt.assetKey);
        if (!src) return null;
        const poster =
          entry.receipt.mediaType === "video" && entry.receipt.posterAssetKey
            ? await this._assetUrl(batch, entry.receipt.posterAssetKey)
            : null;
        return {
          src,
          type: entry.receipt.mediaType || "image",
          poster,
          ...(batch.source === "mcp_direct"
            ? {}
            : {
                onDownload: () =>
                  this._download(batch, entry.promptIndex).catch((error) =>
                    this.host._error(error),
                  ),
              }),
        };
      };
      const current = await resolve(selected);
      if (current)
        WorkflowEditor.showMediaViewer({
          ...current,
          navigation: { index: selected, count: results.length, resolve },
        });
      return;
    }
    if (action === "web-delete" && batch) {
      if (!this._canDelete(batch))
        throw new Error("PROVIDER_BATCH_DELETE_CONFLICT");
      if (
        !(await this.host._confirmDelete(
          this._batchT("deleteConfirm", "Delete this batch?", {
            count:
              this.runs.get(batch.id)?.items.length || batch.prompts.length,
          }),
          this._batchT("delete", "Delete"),
        ))
      )
        return;
      const keys = (this.runs.get(batch.id)?.items || []).flatMap((item) => [
        ...(item.refKeys || []),
        ...(item.resultReceipts || []).flatMap((receipt) =>
          [receipt.assetKey, receipt.posterAssetKey].filter(Boolean),
        ),
      ]);
      keys.push(...batch.prompts.flatMap((item) => item.refKeys || []));
      await this._deleteCurrent(batch);
      this._revokeAssets(batch, keys);
      this.showAll.delete(batch.id);
      this.paused.delete(batch.id);
      return this.host.reload();
    }
    if (action === "web-delete-item" && batch) {
      const index = Number(button.dataset.index);
      if (!Number.isInteger(index) || index < 0)
        throw new Error("PROVIDER_ITEM_DELETE_CONFLICT");
      this._assertDeleteScope(batch);
      if (
        !(await this.host._confirmDelete(
          this._batchT("deleteItemConfirm", "Delete this prompt?"),
          this._batchT("delete", "Delete"),
        ))
      )
        return;
      if (
        batch.status === "QUEUED" &&
        !batch.runId &&
        batch.source !== "gentab_direct"
      ) {
        const current = (
          await window.ProviderWebQueueStore.listBatches(
            batch.userId,
            batch.projectId,
          )
        ).find((entry) => entry.id === batch.id);
        if (
          current?.revision !== batch.revision ||
          index >= current.prompts.length
        )
          throw new Error("PROVIDER_BATCH_REVISION_CONFLICT");
        if (current.prompts.length === 1) {
          await window.ProviderWebQueueStore.deleteBatch(
            batch.userId,
            batch.projectId,
            batch.id,
            current.revision,
          );
          this._revokeAssets(batch, current.prompts[0].refKeys || []);
        } else {
          const prompts = current.prompts.filter(
            (_, itemIndex) => itemIndex !== index,
          );
          const removedRefs = current.prompts[index].refKeys || [];
          await window.ProviderWebQueueStore.editBatch(
            batch.userId,
            batch.projectId,
            batch.id,
            current.revision,
            { settingsSnapshot: current.settingsSnapshot, prompts },
          );
          const retained = new Set(
            prompts.flatMap((item) => item.refKeys || []),
          );
          this._revokeAssets(
            batch,
            removedRefs.filter((key) => !retained.has(key)),
          );
        }
      } else {
        const storedRun = this.runs.get(batch.id);
        const item = storedRun?.items.find(
          (entry) => entry.promptIndex === index,
        );
        if (!item) throw new Error("PROVIDER_ITEM_DELETE_CONFLICT");
        await window.ProviderWebQueueStore.hideBatchListEntry(
          batch.userId,
          batch.projectId,
          batch.id,
          batch.source || "batch",
          index,
        );
        if (storedRun.items.filter((entry) => !entry.hidden).length === 1) {
          if (this._canPurge(batch)) {
            try {
              await this._purgeCurrent(batch);
            } catch (error) {
              console.warn(
                "[ProviderWebBatch] Prompt removed from list; execution data retained:",
                error?.message,
              );
            }
          }
        } else if (
          storedRun.run.status === "SETTLED" &&
          storedRun.historyPublished
        ) {
          try {
            const keys = await window.ProviderWebQueueStore.deleteItem(
              batch.userId,
              batch.projectId,
              batch.runId,
              index,
              item.revision,
            );
            this._revokeAssets(batch, keys);
          } catch (error) {
            console.warn(
              "[ProviderWebBatch] Prompt removed from list; execution data retained:",
              error?.message,
            );
          }
        }
      }
      return this.host.reload();
    }
    if (action === "web-detail" && batch)
      return this._detail(batch, Number(button.dataset.index));
    if (action === "web-edit" && batch)
      return this._edit(batch, Number(button.dataset.index));
    if (action === "web-edit-save") return this._saveEdit();
    if (action === "web-edit-cancel") return this._closeEdit();
    if (action === "web-ref-remove") {
      button.closest("[data-ref-key]")?.remove();
      this.editing?.mentionChips?.render();
      return;
    }
    if (action === "web-ref-add") return this._pickRefs();
  }
  _rename(label, batch) {
    if (this.host._renameInput) return;
    const input = document.createElement("input");
    input.className = "gen-batch-rename";
    input.value =
      batch.source === "mcp_direct" ? batch.batchName || "" : label.textContent;
    label.replaceWith(input);
    this.host._renameInput = input;
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      this.host._renameInput = null;
      input.replaceWith(label);
      if (
        save &&
        input.value.trim() &&
        input.value.trim() !==
          (batch.source === "mcp_direct" ? batch.batchName : label.textContent)
      ) {
        try {
          if (batch.source === "mcp_direct") {
            const latest = await window.ProviderWebQueueStore.getRun(batch.id);
            if (latest?.run.scope !== batch.scope)
              throw new Error("PROVIDER_MCP_EDIT_CONFLICT");
            await window.ProviderWebQueueStore.editMcpDisplay(
              batch.userId,
              batch.id,
              latest.run.revision,
              { batchName: input.value, promptUpdates: [] },
            );
          } else
            await window.ProviderWebQueueStore.rename(
              batch.userId,
              batch.projectId,
              batch.id,
              batch.revision,
              input.value,
              batch.source === "gentab_direct",
            );
        } catch (error) {
          this.host._error(error);
        }
      }
      await this.host.reload();
    };
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") finish(true);
      if (event.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true), { once: true });
  }
  _edit(batch, index) {
    const snapshot = this.runs.get(batch.id);
    const prompt = snapshot
      ? snapshot.items.find(
          (item) => item.promptIndex === index && !item.hidden,
        )
      : batch.prompts[index];
    if (!prompt || this._isItemProcessing(prompt))
      throw new Error("PROVIDER_ITEM_IN_FLIGHT");
    const settled = !!snapshot,
      review = false;
    this.editing = {
      kind: "item",
      batch,
      index,
      settled,
      review,
      addedAssets: new Map(),
      pendingKeys: new Set(),
      sourceDefinition: snapshot
        ? this._definitionSource(snapshot, index)
        : null,
      sourceRevision: batch.revision,
      sourcePrompts: JSON.stringify(batch.prompts),
      sourceSettings: JSON.stringify(batch.settingsSnapshot),
    };
    const settings =
      this.runs.get(batch.id)?.run.displaySettingsSnapshot ||
      batch.settingsSnapshot;
    const model =
      prompt.displaySettingsOverride?.model ||
      prompt.settingsOverride?.model ||
      settings.model;
    const ratio =
      prompt.displaySettingsOverride?.ratio ||
      prompt.settingsOverride?.ratio ||
      settings.ratio;
    const models =
      window.ModelRegistry?.safeGetModelsSync?.(
        this.provider,
        settings.mediaType,
      ) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.(
        this.provider,
        settings.mediaType,
      ) || [];
    const option = (value, label, selected) =>
      `<option value="${this._esc(value)}"${selected ? " selected" : ""}>${this._esc(label)}</option>`;
    const select = (name, entries, current) =>
      `<span class="input-group select-group compact-select"><select name="${name}">${entries.some((entry) => (name === "webItemRatio" ? this._ratioMatches(entry, current) : entry.value === current)) ? "" : option(current || "", current || "\u2014", true)}${entries
        .map((entry) => {
          const value =
            name === "webItemRatio"
              ? this._ratioValue(entry)
              : typeof entry === "string"
                ? entry
                : entry.value;
          const label =
            typeof entry === "string"
              ? entry
              : entry.name || entry.label || entry.value;
          return option(
            value,
            `${name === "webItemRatio" ? `${this._ratioIcon(entry)} ` : ""}${label}`.trim(),
            name === "webItemRatio"
              ? this._ratioMatches(entry, current)
              : value === current,
          );
        })
        .join(
          "",
        )}</select><svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    sheet.querySelector(".gen-batch-editor-title").textContent = this._t(
      "edit",
      `Edit ${this._providerLabel()} prompt`,
      { provider: this._providerLabel() },
    );
    this.host._setEditorBrand(this.provider);
    const results = settled
      ? (prompt.resultReceipts || [])
          .map(
            (receipt) =>
              `<button type="button" class="gen-batch-editor-result${receipt.mediaType === "video" && !receipt.posterAssetKey ? "" : " is-preview-loading"}" data-media-type="${receipt.mediaType === "video" ? "video" : "image"}" data-action="web-preview" data-batch="${this._esc(batch.id)}" data-asset="${this._esc(receipt.assetKey)}" data-index="${index}" aria-label="${this._esc(this._t("preview", "Preview result"))}">${receipt.mediaType === "video" && !receipt.posterAssetKey ? "" : `<img data-web-asset="${this._esc(receipt.mediaType === "video" ? receipt.posterAssetKey : receipt.assetKey)}" data-web-batch="${this._esc(batch.id)}" alt="">`}</button>`,
          )
          .join("")
      : "";
    sheet.querySelector(".gen-batch-editor-fields").innerHTML = `
      <label>${this._esc(this._t("prompt", "Prompt"))}<span class="prompt-editor-wrapper"><textarea name="webPrompt" rows="6">${this._esc(prompt.displayPrompt ?? prompt.prompt ?? prompt.text)}</textarea></span></label>
      <label>${this._esc(this._batchT("model", "Model"))}${select("webItemModel", models, model)}</label>
      <label>${this._esc(this._batchT("ratio", "Ratio"))}${select("webItemRatio", ratios, ratio)}</label>
      <fieldset class="gen-batch-item-refs"><legend>${this._esc(this._batchT("references", "References"))}</legend><div class="gen-batch-ref-choices gen-batch-web-refs">${(prompt.displayRefKeys || prompt.refKeys || []).map((key) => this._refChoiceHtml(batch, key)).join("")}</div></fieldset>
      <button type="button" class="ref-btn-upload ref-btn-upload--wide gen-batch-ref-upload gen-batch-item-add-refs" data-action="web-ref-add"><svg class="ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 8h.01"/><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"/><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"/><path d="M19 22v-6M22 19l-3 -3-3 3"/></svg><span>${this._esc(this._t("addRefs", "Add references"))}</span></button>
      ${settled && (results || prompt.error) ? `<section class="gen-batch-editor-evidence">${results ? `<div class="gen-batch-editor-results">${results}</div><button type="button" class="gen-batch-editor-download" data-action="web-download" data-batch="${this._esc(batch.id)}" data-index="${index}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/></svg><span>${this._esc(this._t("download", "Download"))}</span></button>` : ""}${prompt.error ? `<div class="gen-batch-editor-error"><strong>${this._esc(this._t("errorDetail", "Error details"))}</strong><p>${this._esc(prompt.error)}</p></div>` : ""}</section>` : ""}`;
    sheet.querySelectorAll('[data-action="editor-cancel"]').forEach((node) => {
      node.dataset.action = "web-edit-cancel";
    });
    sheet.querySelector('[data-action="editor-save"]').dataset.action =
      "web-edit-save";
    sheet.querySelector(".gen-batch-editor-cancel").textContent = this._t(
      "cancel",
      "Cancel",
    );
    sheet.querySelector(".gen-batch-editor-save").innerHTML =
      this._saveButtonHtml();
    sheet.classList.remove("hidden");
    this.host._bindEditorPromptResizer?.(
      sheet.querySelector('textarea[name="webPrompt"]'),
    );
    this._bindWebItemMentionMenu(this.editing, prompt, settings);
    sheet.querySelector('textarea[name="webPrompt"]')?.focus();
    this._hydrate().catch((error) =>
      console.warn(
        "[ProviderWebBatchView] Thumbnail:",
        error?.message || error,
      ),
    );
  }
  _editBatch(batch) {
    const settled = !!this.runs.get(batch.id),
      review = false;
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    sheet.querySelector(".gen-batch-editor-title").textContent = this._batchT(
      "editBatch",
      "Edit batch",
    );
    this.host._setEditorBrand(this.provider);
    const settings =
      this.runs.get(batch.id)?.run.displaySettingsSnapshot ||
      batch.settingsSnapshot;
    const media = settings.mediaType;
    const models =
      window.ModelRegistry?.safeGetModelsSync?.(this.provider, media) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.(this.provider, media) ||
      [];
    if (!models.length || !ratios.length)
      throw new Error("PROVIDER_BATCH_CONFIG_UNAVAILABLE");
    const sourcePrompts =
      settled || review
        ? this.runs.get(batch.id).items.filter((item) => !item.hidden)
        : batch.prompts;
    const refKeys = [
      ...new Set(
        sourcePrompts.flatMap(
          (prompt) => prompt.displayRefKeys || prompt.refKeys || [],
        ),
      ),
    ];
    this.editing = {
      kind: "batch",
      batch,
      settled,
      review,
      addedAssets: new Map(),
      pendingKeys: new Set(),
      refNames: new Map(),
      sourceDefinition: settled
        ? this._definitionSource(this.runs.get(batch.id))
        : null,
      sourceRevision: batch.revision,
      sourcePrompts: JSON.stringify(batch.prompts),
      sourceSettings: JSON.stringify(batch.settingsSnapshot),
      sourceDisplaySettings: JSON.stringify(settings),
    };
    const autoDownloadAllowed =
      window.featureGate?.canUse?.("auto_download") === true;
    const deleteAllowed =
      ["chatgpt", "gemini"].includes(this.provider) ||
      (this.provider === "muse" &&
        window.ProviderRegistry?.get?.(this.provider)?.capabilities
          ?.supportsDeleteAfterGen === true);
    const option = (value, label, selected) =>
      `<option value="${this._esc(value)}"${selected ? " selected" : ""}>${this._esc(label)}</option>`;
    const select = (name, entries, current) =>
      `<span class="input-group select-group compact-select"><select name="${name}">${!entries.some((entry) => (name === "webRatio" ? this._ratioMatches(entry, current) : (typeof entry === "string" ? entry : entry.value) === current)) ? option(current || "", current || "\u2014", true).replace("<option ", "<option disabled ") : ""}${entries
        .map((entry) => {
          const value =
            name === "webRatio"
              ? this._ratioValue(entry)
              : typeof entry === "string"
                ? entry
                : entry.value;
          return option(
            value,
            `${name === "webRatio" ? `${this._ratioIcon(entry)} ` : ""}${typeof entry === "string" ? entry : entry.name || entry.label || entry.value}`.trim(),
            name === "webRatio"
              ? this._ratioMatches(entry, current)
              : value === current,
          );
        })
        .join(
          "",
        )}</select><svg class="select-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg></span>`;
    const typeIcon = (value) =>
      document.querySelector(
        `#genTypeToggle .gen-type-btn[data-value="${value}"] svg`,
      )?.outerHTML || "";
    sheet.querySelector(".gen-batch-editor-fields").innerHTML = `
      <section class="gen-batch-edit-section"><h4>${this._esc(this._batchT("prompts", "Prompts"))}</h4><div class="gen-batch-preview gen-batch-web-batch-prompts">${(settled || review ? this.runs.get(batch.id).items.filter((item) => !item.hidden) : batch.prompts).map((prompt, index) => this._batchPromptRow(prompt, index, batch, settled || review)).join("")}</div></section>
      <section class="gen-batch-edit-section"><h4>${this._esc(this._batchT("settings", "Settings"))}</h4><div class="gen-batch-edit-grid">
        <div class="gen-batch-media-field"><span>${this._esc(this._batchT("mediaType", "Type"))}</span><div class="gen-type-toggle gen-batch-type-toggle" role="group" aria-label="${this._esc(this._batchT("mediaType", "Type"))}"><button type="button" class="gen-type-btn${media === "image" ? " active" : ""}" data-action="web-batch-media-type" data-value="image" aria-label="${this._esc(this._batchT("image", "Image"))}" aria-pressed="${media === "image"}">${typeIcon("Image")}</button>${this.provider === "chatgpt" ? "" : `<button type="button" class="gen-type-btn${media === "video" ? " active" : ""}" data-action="web-batch-media-type" data-value="video" aria-label="${this._esc(this._batchT("video", "Video"))}" aria-pressed="${media === "video"}">${typeIcon("Video")}</button>`}</div><select name="webMediaType" hidden>${option("image", this._batchT("image", "Image"), media === "image")}${this.provider === "chatgpt" ? "" : option("video", this._batchT("video", "Video"), media === "video")}</select></div>
        <label>${this._esc(this._batchT("model", "Model"))}${select("webModel", models, settings.model)}</label>
        <label>${this._esc(this._batchT("ratio", "Ratio"))}${select("webRatio", ratios, settings.ratio)}</label>
      </div></section>
      <section class="gen-batch-edit-section"><h4>${this._esc(this._batchT("references", "References"))}</h4>
        <div class="gen-batch-edit-grid"><label>${this._esc(this._batchT("refMode", "Ref mode"))}${select(
          "webRefMode",
          ["all", "sequential", "mention", "none"].map((value) => ({
            value,
            label: this._batchT(
              `refMode${value[0].toUpperCase()}${value.slice(1)}`,
              value,
            ),
          })),
          settings.refMode || (refKeys.length ? "all" : "none"),
        )}</label>
        <label data-web-ref-count ${settings.refMode === "sequential" ? "" : "hidden"}>${this._esc(this._batchT("refsPerPrompt", "Refs per prompt"))}<input name="webRefCount" type="number" min="1" step="1" value="${this._esc(settings.refImagesPerPrompt || 1)}"></label></div>
        <div class="gen-batch-ref-choices gen-batch-web-refs">${refKeys.map((key) => this._refChoiceHtml(batch, key)).join("")}</div>
        <button type="button" class="ref-btn-upload ref-btn-upload--wide gen-batch-ref-upload gen-batch-item-add-refs" data-action="web-ref-add"><svg class="ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 8h.01"/><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 3h6.5"/><path d="M19 22v-6M22 19l-3 -3-3 3"/></svg><span>${this._esc(this._t("addRefs", "Add references"))}</span></button>
      </section>
      <section class="gen-batch-edit-section"><h4>${this._esc(this._batchT("download", "Download"))}</h4><div class="gen-batch-edit-grid">
        <label class="toolbar-toggle wm-toggle gen-batch-edit-check"><input name="webAutoDownload" type="checkbox" ${settings.autoDownload && autoDownloadAllowed ? "checked" : ""} ${autoDownloadAllowed ? "" : "disabled"}><span class="toggle-track"><span class="toggle-thumb"></span></span><span class="toggle-label">${this._esc(this._batchT("autoDownload", "Auto download"))}</span></label>
        ${deleteAllowed ? `<label class="toolbar-toggle wm-toggle gen-batch-edit-check"><input name="webDeleteAfterGen" type="checkbox" ${settings.deleteAfterGen ? "checked" : ""}><span class="toggle-track"><span class="toggle-thumb"></span></span><span class="toggle-label">${this._esc(this._t("deleteAfterGen", "Delete chat after generation"))}</span></label>` : ""}
        <label>${this._esc(this._batchT("folder", "Folder"))}<input name="webFolder" value="${this._esc(settings.downloadSubFolder || "")}"></label>
      </div></section>`;
    sheet.querySelectorAll('[data-action="editor-cancel"]').forEach((node) => {
      node.dataset.action = "web-edit-cancel";
    });
    sheet.querySelector('[data-action="editor-save"]').dataset.action =
      "web-edit-save";
    sheet.querySelector(".gen-batch-editor-cancel").textContent = this._t(
      "cancel",
      "Cancel",
    );
    sheet.querySelector(".gen-batch-editor-save").innerHTML =
      this._saveButtonHtml();
    sheet
      .querySelector('[name="webRefMode"]')
      ?.addEventListener("change", (event) => {
        sheet.querySelector("[data-web-ref-count]").hidden =
          event.target.value !== "sequential";
      });
    sheet.classList.remove("hidden");
    sheet.dataset.webMediaType = media;
    sheet
      .querySelector('[name="webMediaType"]')
      ?.addEventListener("change", (event) => {
        if (this._refreshBatchSettings(event.target.value))
          sheet.dataset.webMediaType = event.target.value;
        else {
          event.target.value = sheet.dataset.webMediaType;
          this.host._error(new Error("PROVIDER_BATCH_CONFIG_UNAVAILABLE"));
        }
      });
    sheet.querySelector('[name="webMediaType"]')?.focus();
    this._hydrate().catch((error) =>
      console.warn(
        "[ProviderWebBatchView] Thumbnail:",
        error?.message || error,
      ),
    );
  }
  _saveButtonHtml() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h14l2 2v14H4zM7 4v6h10V4M8 20v-7h8v7"/></svg><span>${this._esc(this._t("save", "Save"))}</span>`;
  }
  _refChoiceHtml(batch, key) {
    return `<button type="button" class="gen-batch-ref-choice" data-action="web-ref-remove" data-ref-key="${this._esc(key)}" aria-label="${this._esc(this._t("removeRef", "Remove reference"))}"><span class="gen-batch-ref-choice-thumb"><img data-web-asset="${this._esc(key)}" data-web-batch="${this._esc(batch.id)}" alt=""></span><span class="gen-batch-ref-choice-remove" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg></span></button>`;
  }
  _refreshBatchSettings(media) {
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    const models =
      window.ModelRegistry?.safeGetModelsSync?.(this.provider, media) || [];
    const ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.(this.provider, media) ||
      [];
    if (!models.length || !ratios.length) return false;
    const fill = (name, entries) => {
      const control = sheet.querySelector(`[name="${name}"]`);
      control.replaceChildren(
        ...entries.map((entry) => {
          const option = document.createElement("option");
          option.value =
            name === "webRatio"
              ? this._ratioValue(entry)
              : typeof entry === "string"
                ? entry
                : entry.value;
          const label =
            typeof entry === "string"
              ? entry
              : entry.name || entry.label || entry.value;
          option.textContent =
            name === "webRatio"
              ? `${this._ratioIcon(entry)} ${label}`.trim()
              : label;
          return option;
        }),
      );
    };
    fill("webModel", models);
    fill("webRatio", ratios);
    const path =
      media === "video"
        ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
        : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    for (const svg of sheet.querySelectorAll(
      ".gen-batch-web-batch-prompt .gen-batch-result-placeholder svg",
    ))
      svg.innerHTML = path;
    return true;
  }
  _batchPromptRow(prompt, index, batch = this.editing?.batch, settled = false) {
    const text = prompt.displayPrompt ?? prompt.prompt ?? prompt.text;
    const refs = (prompt.displayRefKeys || prompt.refKeys || [])
      .map(
        (key) =>
          `<span class="gen-batch-ref-mini is-preview-loading"><img data-web-asset="${this._esc(key)}" data-web-batch="${this._esc(batch?.id)}" alt=""></span>`,
      )
      .join("");
    const icon =
      (
        this.runs.get(batch?.id)?.run.displaySettingsSnapshot ||
        batch?.settingsSnapshot
      )?.mediaType === "video"
        ? '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="m16 10 5-3v10l-5-3z"/>'
        : '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>';
    const results = settled ? prompt.resultReceipts || [] : [];
    const thumbnail = results.length
      ? results
          .map(
            (result) =>
              `<span class="gen-batch-result${result.mediaType === "video" && !result.posterAssetKey ? "" : " is-preview-loading"}" data-media-type="${result.mediaType === "video" ? "video" : "image"}">${result.mediaType === "video" && !result.posterAssetKey ? "" : `<img data-web-asset="${this._esc(result.mediaType === "video" ? result.posterAssetKey : result.assetKey)}" data-web-batch="${this._esc(batch?.id)}" alt="">`}</span>`,
          )
          .join("")
      : `<span class="gen-batch-result-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg></span>`;
    return `<div class="gen-batch-item gen-batch-preview-item gen-batch-web-batch-prompt" data-original-index="${settled ? prompt.promptIndex : index}"><span class="gen-batch-item-thumb">${thumbnail}</span>
      <span class="gen-batch-item-main"><span class="gen-batch-prompt" title="${this._esc(text)}">${this._esc(text)}</span>${refs ? `<span class="gen-batch-ref-thumbs">${refs}</span>` : ""}</span>
      <span class="gen-batch-preview-index">#${settled ? prompt.promptIndex + 1 : index + 1}</span>${this.editing?.review ? "" : `<button type="button" class="gen-batch-preview-delete" data-action="web-batch-remove-prompt" aria-label="${this._esc(this._batchT("delete", "Delete"))}" data-tooltip="${this._esc(this._batchT("delete", "Delete"))}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 3v7m4-7v7"/></svg></button>`}</div>`;
  }
  async _removeBatchPrompt(button) {
    if (this.editing?.kind !== "batch") return;
    const row = button.closest(".gen-batch-web-batch-prompt");
    if (!row) return;
    if (!this.editing.settled) {
      if (row.parentElement.children.length > 1) row.remove();
      return;
    }
    const batch = this.editing.batch;
    const run = this.runs.get(batch.id);
    const index = Number(row.dataset.originalIndex);
    const item = run?.items.find(
      (entry) => entry.promptIndex === index && !entry.hidden,
    );
    if (run?.run.status !== "SETTLED" || !item)
      throw new Error("PROVIDER_ITEM_DELETE_CONFLICT");
    if (
      !(await this.host._confirmDelete(
        this._batchT("deleteItemConfirm", "Delete this prompt?"),
        this._batchT("delete", "Delete"),
      ))
    )
      return;
    const remaining = run.items.filter((entry) => !entry.hidden).length;
    if (remaining === 1) {
      if (batch.source === "gentab_direct")
        await window.ProviderWebQueueStore.deleteRun(
          batch.userId,
          batch.projectId,
          batch.runId,
          run.run.revision,
        );
      else
        await window.ProviderWebQueueStore.deleteBatch(
          batch.userId,
          batch.projectId,
          batch.id,
          batch.revision,
        );
    } else {
      const keys = await window.ProviderWebQueueStore.deleteItem(
        batch.userId,
        batch.projectId,
        batch.runId,
        index,
        item.revision,
      );
      this._revokeAssets(batch, keys);
    }
    this._closeEdit();
    await this.host.reload();
    if (remaining > 1) {
      const updated = this.batches.find((entry) => entry.id === batch.id);
      if (updated) await this._editBatch(updated);
    }
  }
  _detailMcpBatch(batch) {
    const snapshot = this.runs.get(batch.id);
    const items = (snapshot?.items || []).filter((item) => !item.hidden);
    const settings =
      snapshot?.run.displaySettingsSnapshot ||
      snapshot?.run.settingsSnapshot ||
      batch.settingsSnapshot ||
      {};
    this.editing = { kind: "detail", batch };
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    sheet.querySelector(".gen-batch-editor-title").textContent = this._t(
      "details",
      "Details",
    );
    sheet.querySelector(".gen-batch-editor-fields").innerHTML = `
      <label>${this._esc(this._t("batch", "Batch"))}<input value="${this._esc(batch.batchName || "")}" disabled></label>
      <label>Job ID<input value="${this._esc(batch.mcpJobId || "")}" disabled></label>
      <label>${this._esc(this._batchT("model", "Model"))}<input value="${this._esc(settings.model || "")}" disabled></label>
      <label>${this._esc(this._batchT("ratio", "Ratio"))}<input value="${this._esc(settings.ratio || "")}" disabled></label>
      <label>${this._esc(this._t("prompt", "Prompt"))}<span class="prompt-editor-wrapper"><textarea readonly rows="${Math.min(12, Math.max(4, items.length * 2))}">${this._esc(items.map((item) => `#${item.promptIndex + 1} ${item.displayPrompt ?? item.prompt ?? ""}`).join("\n\n"))}</textarea></span></label>`;
    sheet.querySelectorAll('[data-action="editor-cancel"]').forEach((node) => {
      node.dataset.action = "web-edit-cancel";
    });
    sheet.querySelector(".gen-batch-editor-save").hidden = true;
    sheet.querySelector(".gen-batch-editor-cancel").textContent = this._t(
      "close",
      "Close",
    );
    sheet.classList.remove("hidden");
  }
  _detail(batch, index) {
    const snapshot = this.runs.get(batch.id);
    const item = snapshot?.items.find((entry) => entry.promptIndex === index);
    if (!item) return;
    const settings =
      snapshot.run.displaySettingsSnapshot ||
      snapshot.run.settingsSnapshot ||
      batch.settingsSnapshot ||
      {};
    const override =
      item.displaySettingsOverride || item.settingsOverride || {};
    this.editing = { kind: "detail", batch, index };
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    sheet.querySelector(".gen-batch-editor-title").textContent = this._t(
      "details",
      "Details",
    );
    const refs = (item.displayRefKeys || item.refKeys || [])
      .map(
        (key) =>
          `<span class="gen-batch-ref-choice"><span class="gen-batch-ref-choice-thumb"><img data-web-asset="${this._esc(key)}" data-web-batch="${this._esc(batch.id)}" alt=""></span></span>`,
      )
      .join("");
    const results = (item.resultReceipts || [])
      .map(
        (receipt) =>
          `<button type="button" class="gen-batch-editor-result${receipt.mediaType === "video" && !receipt.posterAssetKey ? "" : " is-preview-loading"}" data-media-type="${receipt.mediaType === "video" ? "video" : "image"}" data-action="web-preview" data-batch="${this._esc(batch.id)}" data-asset="${this._esc(receipt.assetKey)}" data-index="${index}" aria-label="${this._esc(this._t("preview", "Preview result"))}">${receipt.mediaType === "video" && !receipt.posterAssetKey ? "" : `<img data-web-asset="${this._esc(receipt.mediaType === "video" ? receipt.posterAssetKey : receipt.assetKey)}" data-web-batch="${this._esc(batch.id)}" alt="">`}</button>`,
      )
      .join("");
    sheet.querySelector(".gen-batch-editor-fields").innerHTML = `
      <label>${this._esc(this._t("prompt", "Prompt"))}<span class="prompt-editor-wrapper"><textarea readonly rows="6">${this._esc(item.displayPrompt || item.prompt || item.text || "")}</textarea></span></label>
      <label>${this._esc(this._batchT("model", "Model"))}<input value="${this._esc(override.model || settings.model || "")}" disabled></label>
      <label>${this._esc(this._batchT("ratio", "Ratio"))}<input value="${this._esc(override.ratio || settings.ratio || "")}" disabled></label>
      ${refs ? `<fieldset class="gen-batch-item-refs"><legend>${this._esc(this._batchT("references", "References"))}</legend><div class="gen-batch-ref-choices">${refs}</div></fieldset>` : ""}
      ${results || item.error ? `<section class="gen-batch-editor-evidence">${results ? `<div class="gen-batch-editor-results">${results}</div><button type="button" class="gen-batch-editor-download" data-action="web-download" data-batch="${this._esc(batch.id)}" data-index="${index}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M4 17v4h16v-4"/></svg><span>${this._esc(this._t("download", "Download"))}</span></button>` : ""}${item.error ? `<div class="gen-batch-editor-error"><strong>${this._esc(this._t("errorDetail", "Error details"))}</strong><p>${this._esc(this._errorText(item.error))}</p></div>` : ""}</section>` : ""}`;
    sheet.querySelectorAll('[data-action="editor-cancel"]').forEach((node) => {
      node.dataset.action = "web-edit-cancel";
    });
    sheet.querySelector(".gen-batch-editor-save").hidden = true;
    sheet.querySelector(".gen-batch-editor-cancel").textContent = this._t(
      "close",
      "Close",
    );
    sheet.classList.remove("hidden");
    this._hydrate().catch((error) =>
      console.warn(
        "[ProviderWebBatchView] Thumbnail:",
        error?.message || error,
      ),
    );
  }
  _closeEdit() {
    this.editing?.mentionMenu?.destroy();
    this.editing?.mentionChips?.destroy();
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    sheet.classList.add("hidden");
    sheet
      .querySelectorAll('[data-action="web-edit-cancel"]')
      .forEach((node) => {
        node.dataset.action = "editor-cancel";
      });
    const save = sheet.querySelector('[data-action="web-edit-save"]');
    if (save) save.dataset.action = "editor-save";
    sheet.querySelector(".gen-batch-editor-save").hidden = false;
    for (const key of this.editing?.pendingKeys || [])
      window.pendingUploadFiles?.delete(key);
    if (this.editing?.addedAssets?.size)
      this._revokeAssets(this.editing.batch, [
        ...this.editing.addedAssets.keys(),
      ]);
    this.editing = null;
  }
  _bindWebItemMentionMenu(edit, prompt, settings) {
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    const textarea = sheet.querySelector('textarea[name="webPrompt"]');
    if (!textarea || !window.MentionMenu || settings.refMode !== "mention")
      return;
    const MM = window.MentionMenu;
    const keys = prompt.displayRefKeys || prompt.refKeys || [];
    edit.refNames = new Map();
    this._refNames(edit.batch, keys)
      .then((names) => {
        if (this.editing !== edit) return;
        for (const key of keys)
          if (names[key])
            edit.refNames.set(
              key,
              names[key].mentionName || names[key].name || "",
            );
        edit.mentionChips?.render();
      })
      .catch((error) =>
        console.warn(
          "[ProviderWebBatchView] Ref names:",
          error?.message || error,
        ),
      );
    const entries = () => {
      const seen = new Set();
      return [
        ...sheet.querySelectorAll(".gen-batch-web-refs [data-ref-key]"),
      ].flatMap((row) => {
        const key = row.dataset.refKey;
        const asset = edit.addedAssets.get(key);
        const name = String(
          asset?.mentionName || asset?.name || edit.refNames.get(key) || "",
        ).trim();
        if (!name || seen.has(name.toLowerCase())) return [];
        seen.add(name.toLowerCase());
        return [
          {
            label: name,
            value: name,
            fileId: key,
            mediaType: "image",
            thumbnail: row.querySelector("img")?.src || null,
            iconSvg: MM.ICONS.ref,
          },
        ];
      });
    };
    const cap = () =>
      this._maxRefs(
        settings.mediaType,
        sheet.querySelector('[name="webItemModel"]')?.value || settings.model,
      );
    const budget = ({ text, cursor, atPos }) => {
      const max = cap();
      if (!Number.isInteger(max) || max < 0) return null;
      return MM.flowRefBudget({
        text,
        cursor,
        atPos,
        items: entries(),
        caps: { image: max, video: 0, total: max },
        multiPrompt: false,
      });
    };
    edit.getMentionRefBudget = budget;
    edit.mentionMenu = new MM(textarea, {
      getTabs: () =>
        budget({
          text: textarea.value,
          cursor: textarea.selectionStart,
          atPos: -1,
        }) && entries().length
          ? [
              {
                id: "ref",
                label: window.I18n?.t?.("mention.tabRef") || "Ref image",
                iconSvg: MM.ICONS.ref,
                getItems: entries,
                buildInsert: (item) => MM.wrapName(item.value, ""),
              },
            ]
          : [],
      defaultTabId: () => "ref",
      getRefBudget: budget,
    });
    if (window.MentionChips)
      edit.mentionChips = new window.MentionChips(textarea, {
        includeRefs: () => true,
        includeComponents: () => false,
        getRefBudgets: () => {
          const value = budget({
            text: textarea.value,
            cursor: textarea.value.length,
            atPos: -1,
          });
          return value ? [{ ...value, promptIndex: 0 }] : [];
        },
        resolveRef: (name) => {
          const entry = entries().find(
            (item) => item.value.toLowerCase() === String(name).toLowerCase(),
          );
          return { found: !!entry, thumbnail: entry?.thumbnail || null };
        },
      });
    sheet
      .querySelector('[name="webItemModel"]')
      ?.addEventListener("change", () => {
        edit.mentionMenu?.hide();
        edit.mentionChips?.render();
      });
  }
  _batchRefMapping(edit, sheet, prompts, maxRefs) {
    const mode = sheet.querySelector('[name="webRefMode"]')?.value;
    const count = Number(sheet.querySelector('[name="webRefCount"]')?.value);
    if (
      !["all", "sequential", "mention", "none"].includes(mode) ||
      !Number.isSafeInteger(count) ||
      count < 1
    )
      throw new Error("PROVIDER_REF_POLICY_UNAVAILABLE");
    const pool = [
      ...sheet.querySelectorAll(".gen-batch-web-refs [data-ref-key]"),
    ].map((node) => node.dataset.refKey);
    if (new Set(pool).size !== pool.length)
      throw new Error("PROVIDER_BATCH_ASSET_DUPLICATE");
    const mapped = prompts.map((prompt, index) => {
      let keys = [];
      if (mode === "all") keys = pool;
      if (mode === "sequential")
        keys = window.RefImageAssignment.select(pool, index, count);
      if (mode === "mention") {
        const text = String(
          prompt.displayPrompt ?? prompt.prompt ?? prompt.text ?? "",
        );
        const mentions = new Set(
          (text.match(/@(\[[^\]]+\]|[\p{L}\p{N}_]+)/gu) || []).map((value) =>
            value
              .slice(1)
              .replace(/^\[|\]$/g, "")
              .toLowerCase(),
          ),
        );
        keys = pool.filter((key) => {
          const added = edit.addedAssets.get(key);
          const name =
            added?.mentionName || added?.name || edit.refNames?.get(key) || "";
          return [name, name.replace(/\.[^.]+$/, "")].some(
            (value) => value && mentions.has(value.toLowerCase()),
          );
        });
      }
      if (keys.length > maxRefs) throw new Error("PROVIDER_REF_LIMIT_EXCEEDED");
      return keys;
    });
    return { mode, count, mapped };
  }
  _definitionSource(snapshot, index = null) {
    const items = (snapshot.definitionItems || snapshot.items).filter(
      (item) => index === null || item.promptIndex === index,
    );
    return JSON.stringify([
      snapshot.run.displaySettingsSnapshot || snapshot.run.settingsSnapshot,
      items.map((item) => [
        item.promptIndex,
        item.hidden,
        item.displayPrompt ?? item.prompt,
        item.displayRefKeys,
        item.displaySettingsOverride,
      ]),
    ]);
  }
  async _saveRunPresentation(
    edit,
    {
      settingsSnapshot = null,
      promptUpdates,
      refAssets = [],
      batchEdit = false,
    },
  ) {
    const snapshot = await window.ProviderWebQueueStore.getRun(
      edit.batch.runId || edit.batch.id,
    );
    if (snapshot?.run?.scope !== edit.batch.scope)
      throw new Error("PROVIDER_BATCH_SCOPE_CHANGED");
    if (
      edit.sourceDefinition !==
      this._definitionSource(snapshot, batchEdit ? null : edit.index)
    )
      throw new Error("PROVIDER_BATCH_REVISION_CONFLICT");
    const assets = new Map(refAssets.map((asset) => [asset.id, asset]));
    const copies = new Map();
    for (const key of new Set(
      promptUpdates.flatMap((update) => update.refKeys || []),
    )) {
      if (assets.has(key)) continue;
      const owner = this._assetOwner(edit.batch, key);
      if (
        owner.projectId === (snapshot.run.projectId ?? null) &&
        owner.ownerScope === (snapshot.run.ownerScope || null)
      )
        continue;
      const asset = await window.ProviderWebQueueStore.getAsset(
        edit.batch.userId,
        owner.projectId,
        key,
        owner.ownerScope,
      );
      if (!(asset?.blob instanceof Blob))
        throw new Error("PROVIDER_BATCH_ASSET_MISSING");
      const id = crypto.randomUUID();
      copies.set(key, id);
      assets.set(id, { ...asset, id });
    }
    const updates = promptUpdates.map((update) => ({
      ...update,
      refKeys: update.refKeys.map((key) => copies.get(key) || key),
    }));
    await window.ProviderWebQueueStore.editRunPresentation(
      edit.batch.userId,
      snapshot.run.id,
      snapshot.run.revision,
      {
        projectId: snapshot.run.projectId,
        source: snapshot.run.source,
        settingsSnapshot,
        promptUpdates: updates,
        refAssets: [...assets.values()],
        batchEdit,
      },
    );
  }
  async _saveEdit() {
    const edit = this.editing;
    if (!edit || edit.kind === "detail") return;
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    if (edit.kind === "mcp") {
      const promptUpdates = [
        ...sheet.querySelectorAll('textarea[name="webMcpPrompt"]'),
      ].map((input) => ({
        promptIndex: Number(input.dataset.index),
        text: input.value.trim(),
      }));
      if (
        !promptUpdates.length ||
        promptUpdates.some((entry) => !entry.text) ||
        promptUpdates.some((entry) => !edit.indices.includes(entry.promptIndex))
      )
        throw new Error("PROVIDER_MCP_EDIT_INVALID");
      const latest = await window.ProviderWebQueueStore.getRun(edit.batch.id);
      if (
        latest?.run?.scope !== edit.batch.scope ||
        latest.run.source !== "mcp_direct" ||
        promptUpdates.some((entry) => {
          const current2 = latest.items.find(
            (item) => item.promptIndex === entry.promptIndex && !item.hidden,
          );
          return (
            !current2 ||
            (current2.displayPrompt || current2.prompt) !==
              edit.sourcePrompts.get(entry.promptIndex)
          );
        }) ||
        (edit.promptIndex === null &&
          (latest.run.displayName || latest.run.batchName || "") !==
            edit.sourceBatchName)
      )
        throw new Error("PROVIDER_MCP_EDIT_CONFLICT");
      await window.ProviderWebQueueStore.editMcpDisplay(
        edit.batch.userId,
        edit.batch.id,
        latest.run.revision,
        {
          promptUpdates,
          ...(edit.promptIndex === null
            ? {
                batchName:
                  sheet.querySelector('[name="webMcpBatchName"]')?.value || "",
              }
            : {}),
        },
      );
      this._closeEdit();
      await this.host.reload();
      return;
    }
    if (edit.kind === "batch") {
      const storedRun = this.runs.get(edit.batch.id);
      const current2 = storedRun
        ? storedRun.run
        : (
            await window.ProviderWebQueueStore.listBatches(
              edit.batch.userId,
              edit.batch.projectId,
            )
          ).find((batch) => batch.id === edit.batch.id);
      if (!edit.settled && !edit.review)
        this._queuedEditCurrent(edit, current2);
      const rows = [...sheet.querySelectorAll(".gen-batch-web-batch-prompt")];
      const prompts2 = rows
        .map((row) =>
          edit.settled || edit.review
            ? storedRun?.items.find(
                (item) =>
                  item.promptIndex === Number(row.dataset.originalIndex),
              )
            : current2?.prompts[Number(row.dataset.originalIndex)],
        )
        .filter(Boolean);
      const mediaType2 = sheet.querySelector('[name="webMediaType"]')?.value;
      const model = sheet.querySelector('[name="webModel"]')?.value;
      const ratio = sheet.querySelector('[name="webRatio"]')?.value;
      const models =
        window.ModelRegistry?.safeGetModelsSync?.(this.provider, mediaType2) ||
        [];
      const ratios =
        window.ProviderConfigManager?.safeGetRatiosSync?.(
          this.provider,
          mediaType2,
        ) || [];
      const originalSettings =
        storedRun?.run.displaySettingsSnapshot ||
        current2?.settingsSnapshot ||
        edit.batch.settingsSnapshot;
      if (
        ((mediaType2 !== originalSettings.mediaType ||
          model !== originalSettings.model) &&
          !models.some((entry) => entry.value === model)) ||
        ((mediaType2 !== originalSettings.mediaType ||
          ratio !== originalSettings.ratio) &&
          !ratios.some((entry) => this._ratioValue(entry) === ratio))
      )
        throw new Error("PROVIDER_BATCH_CONFIG_UNAVAILABLE");
      const maxRefs2 = this._maxRefs(mediaType2, model);
      if (!Number.isInteger(maxRefs2) || maxRefs2 < 0)
        throw new Error("PROVIDER_REF_POLICY_UNAVAILABLE");
      if (sheet.querySelector('[name="webRefMode"]')?.value === "mention") {
        const keys2 = [
          ...sheet.querySelectorAll(".gen-batch-web-refs [data-ref-key]"),
        ]
          .map((node) => node.dataset.refKey)
          .filter((key) => !edit.addedAssets.has(key));
        const names = await this._refNames(edit.batch, keys2);
        keys2.forEach((key) => {
          if (names[key])
            edit.refNames.set(key, names[key].mentionName || names[key].name);
        });
      }
      const mapping = this._batchRefMapping(edit, sheet, prompts2, maxRefs2);
      if (
        !mapping ||
        !Array.isArray(mapping.mapped) ||
        mapping.mapped.length !== prompts2.length
      )
        throw new Error("PROVIDER_REF_POLICY_UNAVAILABLE");
      const mappedPrompts = prompts2.map((prompt, index) => ({
        ...prompt,
        refKeys: mapping.mapped[index],
      }));
      const usedKeys = new Set(
        mappedPrompts.flatMap((prompt) => prompt.refKeys || []),
      );
      const refAssets = [...edit.addedAssets.values()].filter((asset) =>
        usedKeys.has(asset.id),
      );
      const settingsSnapshot = {
        ...(storedRun?.run.displaySettingsSnapshot ||
          current2?.settingsSnapshot ||
          edit.batch.settingsSnapshot),
        mediaType: mediaType2,
        model,
        ratio,
        refMode: mapping.mode,
        refImagesPerPrompt: mapping.count,
        autoDownload:
          sheet.querySelector('[name="webAutoDownload"]')?.checked === true &&
          window.featureGate?.canUse?.("auto_download") === true,
        deleteAfterGen:
          sheet.querySelector('[name="webDeleteAfterGen"]')?.checked === true &&
          (["chatgpt", "gemini"].includes(this.provider) ||
            (this.provider === "muse" &&
              window.ProviderRegistry?.get?.(this.provider)?.capabilities
                ?.supportsDeleteAfterGen === true)),
        downloadSubFolder:
          sheet.querySelector('[name="webFolder"]')?.value?.trim() || "",
      };
      if (storedRun) {
        const promptUpdates = rows.map((row, rowIndex) => {
          const item = storedRun.items.find(
            (entry) => entry.promptIndex === Number(row.dataset.originalIndex),
          );
          if (!item) throw new Error("PROVIDER_BATCH_EDIT_INVALID");
          return {
            promptIndex: item.promptIndex,
            text: item.displayPrompt || item.prompt,
            refKeys: mapping.mapped[rowIndex],
          };
        });
        await this._saveRunPresentation(edit, {
          settingsSnapshot,
          promptUpdates,
          refAssets,
          batchEdit: true,
        });
        this._closeEdit();
        await this.host.reload();
        return;
      }
      await window.ProviderWebQueueStore.editBatch(
        edit.batch.userId,
        edit.batch.projectId,
        edit.batch.id,
        current2.revision,
        { settingsSnapshot, prompts: mappedPrompts, refAssets },
      );
      this._closeEdit();
      await this.host.reload();
      return;
    }
    const text = sheet.querySelector('[name="webPrompt"]')?.value?.trim();
    if (!text) throw new Error("PROVIDER_PROMPT_REQUIRED");
    const itemModel = sheet.querySelector('[name="webItemModel"]')?.value;
    const itemRatio = sheet.querySelector('[name="webItemRatio"]')?.value;
    const mediaType = (
      this.runs.get(edit.batch.id)?.run.displaySettingsSnapshot ||
      edit.batch.settingsSnapshot
    ).mediaType;
    const original =
      this.runs
        .get(edit.batch.id)
        ?.items.find((item) => item.promptIndex === edit.index) ||
      edit.batch.prompts?.[edit.index];
    const baseSettings =
      this.runs.get(edit.batch.id)?.run.displaySettingsSnapshot ||
      edit.batch.settingsSnapshot;
    if (
      (itemModel !==
        (original?.displaySettingsOverride?.model ||
          original?.settingsOverride?.model ||
          baseSettings.model) &&
        !(
          window.ModelRegistry?.safeGetModelsSync?.(this.provider, mediaType) ||
          []
        ).some((entry) => entry.value === itemModel)) ||
      (itemRatio !==
        (original?.displaySettingsOverride?.ratio ||
          original?.settingsOverride?.ratio ||
          baseSettings.ratio) &&
        !(
          window.ProviderConfigManager?.safeGetRatiosSync?.(
            this.provider,
            mediaType,
          ) || []
        ).some((entry) => this._ratioValue(entry) === itemRatio))
    )
      throw new Error("PROVIDER_BATCH_CONFIG_UNAVAILABLE");
    const settingsOverride = { model: itemModel, ratio: itemRatio };
    const keys = [...sheet.querySelectorAll("[data-ref-key]")].map(
      (node) => node.dataset.refKey,
    );
    const maxRefs = this._maxRefs(mediaType, itemModel);
    if (!Number.isInteger(maxRefs) || maxRefs < 0)
      throw new Error("PROVIDER_REF_POLICY_UNAVAILABLE");
    if (keys.length > maxRefs) throw new Error("PROVIDER_REF_LIMIT_EXCEEDED");
    if (edit.getMentionRefBudget) {
      const budget = edit.getMentionRefBudget({
        text,
        cursor: text.length,
        atPos: -1,
      });
      if (!budget || budget.images > maxRefs || budget.used > maxRefs)
        throw new Error("PROVIDER_REF_LIMIT_EXCEEDED");
    }
    if (this.runs.has(edit.batch.id)) {
      await this._saveRunPresentation(edit, {
        promptUpdates: [
          { promptIndex: edit.index, text, refKeys: keys, settingsOverride },
        ],
        refAssets: [...edit.addedAssets.values()].filter((asset) =>
          keys.includes(asset.id),
        ),
      });
      this._closeEdit();
      await this.host.reload();
      return;
    }
    const current = (
      await window.ProviderWebQueueStore.listBatches(
        edit.batch.userId,
        edit.batch.projectId,
      )
    ).find((batch) => batch.id === edit.batch.id);
    this._queuedEditCurrent(edit, current);
    const prompts = current.prompts.map((item, index) =>
      index === edit.index
        ? { ...item, text, refKeys: keys, settingsOverride }
        : item,
    );
    await window.ProviderWebQueueStore.editBatch(
      edit.batch.userId,
      edit.batch.projectId,
      edit.batch.id,
      current.revision,
      {
        settingsSnapshot: current.settingsSnapshot,
        prompts,
        refAssets: [...edit.addedAssets.values()].filter((asset) =>
          keys.includes(asset.id),
        ),
      },
    );
    this._closeEdit();
    await this.host.reload();
  }
  async _pickRefs() {
    const edit = this.editing;
    if (!edit || !window.imagePickerModal?.open)
      throw new Error("PROVIDER_REF_PICKER_UNAVAILABLE");
    if (window.featureGate?.canUseProviderRefImages?.(this.provider) !== true)
      throw new Error("MUSE_REF_IMAGES_NOT_ALLOWED");
    const settings =
      this.runs.get(edit.batch.id)?.run.displaySettingsSnapshot ||
      edit.batch.settingsSnapshot;
    const selectedModel =
      this.host.overlay.querySelector('[name="webItemModel"]')?.value ||
      this.host.overlay.querySelector('[name="webModel"]')?.value ||
      settings.model;
    const mediaType =
      this.host.overlay.querySelector('[name="webMediaType"]')?.value ||
      settings.mediaType;
    const perPromptMax = this._maxRefs(mediaType, selectedModel);
    const mode = this.host.overlay.querySelector('[name="webRefMode"]')?.value;
    const promptCount =
      edit.kind === "batch"
        ? this.host.overlay.querySelectorAll(".gen-batch-web-batch-prompt")
            .length
        : 1;
    const max =
      edit.kind === "batch" && mode !== "all" && mode !== "none"
        ? Math.min(200, promptCount * perPromptMax)
        : perPromptMax;
    if (!Number.isInteger(max) || max < 0)
      throw new Error("PROVIDER_REF_POLICY_UNAVAILABLE");
    const selected = this.host.overlay.querySelectorAll(
      ".gen-batch-web-refs [data-ref-key]",
    ).length;
    if (selected >= max) throw new Error("MUSE_REF_LIMIT_EXCEEDED");
    window.imagePickerModal.open({
      refAuditContext: { surface: "gen" },
      mediaFilter: "image",
      allowVideo: false,
      maxSelections: max - selected,
      maxImageSelections: max - selected,
      maxVideoSelections: 0,
      maxTotalSelections: max - selected,
      existingFileIds: [],
      onConfirm: (images) =>
        this._applyRefs(images).catch((error) => this.host._error(error)),
    });
  }
  async _applyRefs(images) {
    const edit = this.editing;
    if (!edit) return;
    const sheet = this.host.overlay.querySelector(".gen-batch-editor");
    const refs = sheet.querySelector(".gen-batch-web-refs");
    const refMode = sheet.querySelector('[name="webRefMode"]');
    if (refMode?.value === "none" && images?.length) refMode.value = "all";
    for (const image of images || []) {
      const localThumbnail =
        typeof image.thumbnail === "string" &&
        image.thumbnail.startsWith("blob:")
          ? fetch(image.thumbnail)
              .then((response) => response.blob())
              .catch(() => null)
          : null;
      let file = image.file;
      if (image.source === "album") {
        const prepared =
          await window.ImagePickerModal.prepareAlbumImageForRef(image);
        file = prepared && window.pendingUploadFiles?.get(prepared.key)?.file;
        if (prepared?.key?.startsWith("upload_"))
          edit.pendingKeys.add(prepared.key);
        if (!file && image.album_image_id)
          file = await window.ImageStore?.getFullBlob?.(image.album_image_id);
      }
      if (!file && image.fileId)
        file = window.pendingUploadFiles?.get(image.fileId)?.file;
      if (!file && localThumbnail) file = await localThumbnail;
      if (!file) {
        const thumbnail =
          image.thumbnail || image.thumbnail_url || image.source_thumbnail;
        const resolved =
          thumbnail &&
          (await window.GenTab?._resolveCrossProviderRefThumbnail?.(thumbnail));
        if (resolved?.success && resolved.base64) {
          const contentType = resolved.contentType?.split(";")[0]?.trim();
          const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,/i.test(
            resolved.base64,
          )
            ? resolved.base64
            : /^image\/[a-z0-9.+-]+$/i.test(contentType || "")
              ? `data:${contentType};base64,${resolved.base64}`
              : null;
          if (dataUrl) file = await (await fetch(dataUrl)).blob();
        }
      }
      if (!(file instanceof Blob) || !file.size || !/^image\//i.test(file.type))
        throw new Error("PROVIDER_REF_ASSET_MISSING");
      const id = crypto.randomUUID();
      edit.addedAssets.set(id, {
        id,
        blob: file,
        name: file.name || image.file_name || image.name || "reference.png",
        mentionName: image.name || null,
        type: file.type,
      });
      const row = document.createElement("button");
      row.type = "button";
      row.className = "gen-batch-ref-choice";
      row.dataset.action = "web-ref-remove";
      row.dataset.refKey = id;
      row.setAttribute("aria-label", this._t("removeRef", "Remove reference"));
      const thumb = document.createElement("span");
      thumb.className = "gen-batch-ref-choice-thumb";
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      img.alt = "";
      this.urls.set(`${edit.batch.scope}:${id}`, img.src);
      thumb.appendChild(img);
      const remove = document.createElement("span");
      remove.className = "gen-batch-ref-choice-remove";
      remove.setAttribute("aria-hidden", "true");
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
      row.append(thumb, remove);
      refs.appendChild(row);
    }
    edit.mentionChips?.render();
  }
}
window.ProviderWebBatchView = ProviderWebBatchView;
