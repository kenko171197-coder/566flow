class GenBatchAdmission {
  static _validateApiRefIdentity(batch, names, thumbnails) {
    const resolve = window.FlowApiAdapter?._resolveRefUuid;
    const accepts = window.FlowApiV2Driver?._referenceId;
    if (!resolve || !accepts)
      throw new Error("BATCH_API_REF_POLICY_UNAVAILABLE");
    for (const item of batch.items)
      for (const id of item.refKeys || []) {
        const source = {
          refFileNames: names,
          refThumbnails: thumbnails,
          mentionData: item.mentionData || null,
        };
        const identity = resolve.call(window.FlowApiAdapter, source, id) || id;
        if (!accepts.call(window.FlowApiV2Driver, identity))
          throw new Error("BATCH_API_REF_IDENTITY_UNAVAILABLE");
      }
  }
  static _scopeMatches(batch) {
    return (
      String(window.authManager?.getUser?.()?.id || "") ===
        String(batch.userId) &&
      String(window._currentProjectId || "") === String(batch.projectId)
    );
  }
  static _validate(batch, { allowPending = false } = {}) {
    if (!this._scopeMatches(batch)) throw new Error("BATCH_SCOPE_CHANGED");
    if (!window.PromptQueue?.isEnabled?.())
      throw new Error("PIPELINE_QUEUE_DISABLED");
    const limit = window.GenBatchDraftBuilder.checkLimit(batch.items.length);
    if (!limit?.allowed) throw new Error("BATCH_LIMIT_CHANGED");
    const settings = batch.settingsSnapshot || {};
    if (!window.ModelRegistry?.findModel?.("flow", settings.model))
      throw new Error("BATCH_MODEL_UNAVAILABLE");
    const media = settings.genType === "Video" ? "video" : "image";
    if (
      !window.ModelRegistry?.safeGetModelsSync?.("flow", media)?.some(
        (model) => model.value === settings.model,
      )
    )
      throw new Error("BATCH_MODEL_MEDIA_MISMATCH");
    if (
      !settings.ratio ||
      !["api", "web", "auto"].includes(batch.flowExecutionMode)
    )
      throw new Error("BATCH_SETTINGS_INVALID");
    if (
      batch.autoDownload &&
      window.featureGate?.canUse?.("auto_download") !== true
    )
      throw new Error("BATCH_AUTO_DOWNLOAD_UNAVAILABLE");
    for (const [field, mode] of [
      ["downloadResolution", "image"],
      ["videoDownloadResolution", "video"],
    ]) {
      if (!settings[field]) continue;
      const options =
        window.ProviderConfigManager?.getDownloadResolutionsSync?.(
          "flow",
          mode,
        );
      if (
        !Array.isArray(options) ||
        !options.some((entry) => entry.value === settings[field])
      )
        throw new Error("BATCH_DOWNLOAD_RESOLUTION_UNAVAILABLE");
    }
    if (
      (batch.items || []).some(
        (item) =>
          !String(item.prompt || "").trim() ||
          item.mentionData?.hasUnresolvedMentions === true,
      )
    )
      throw new Error("BATCH_ITEM_NEEDS_REVIEW");
    if (
      (batch.items || []).some((item) =>
        (item.refKeys || []).some(
          (id) => !id || (!allowPending && id.startsWith("upload_")),
        ),
      )
    )
      throw new Error("BATCH_REF_NOT_UPLOADED");
    if (batch.refMode === "frames") {
      const pairs = Array.isArray(batch.frameFileIds)
        ? batch.frameFileIds
        : batch.items.map(() => batch.frameFileIds);
      if (
        pairs.length !== batch.items.length ||
        pairs.some(
          (pair, index) =>
            !pair?.frame1 &&
            !(
              batch.settingsSnapshot?.chain?.kind === "video_last_frame" &&
              index > 0
            ),
        )
      )
        throw new Error("BATCH_FRAMES_MISSING");
    }
  }
  static async _validateItems(batch, ratiosByMode = new Map()) {
    const adapter = window.ProviderRegistry?.get?.("flow");
    const quantityRange =
      window.ProviderConfigManager?.safeGetQuantityRangeSync?.("flow");
    if (
      !quantityRange ||
      !Number.isInteger(quantityRange.min) ||
      !Number.isInteger(quantityRange.max)
    )
      throw new Error("BATCH_QUANTITY_POLICY_UNAVAILABLE");
    const pool = new Set((batch.refPool || []).map((ref) => ref.refKey));
    for (const [itemIndex, item] of batch.items.entries()) {
      const override = item.settingsOverride || {};
      if (
        Object.keys(override).some(
          (key) =>
            ![
              "genType",
              "model",
              "ratio",
              "quantity",
              "isFrames",
              "flowVideoDuration",
              "flowVideoResolution",
              "flowThinkingLevel",
              "videoInputType",
            ].includes(key),
        )
      )
        throw new Error("BATCH_ITEM_OVERRIDE_INVALID");
      const settings = { ...batch.settingsSnapshot, ...override };
      if (
        settings.genType !== batch.settingsSnapshot.genType ||
        settings.isFrames !== batch.settingsSnapshot.isFrames ||
        settings.videoInputType !== batch.settingsSnapshot.videoInputType
      )
        throw new Error("BATCH_ITEM_ROUTE_CONFLICT");
      if (!window.ModelRegistry?.findModel?.("flow", settings.model))
        throw new Error("BATCH_MODEL_UNAVAILABLE");
      const mode = settings.genType === "Video" ? "video" : "image";
      const hasVideoRef =
        mode === "video" &&
        (item.refKeys || []).some(
          (key) =>
            batch.refPool?.find((ref) => ref.refKey === key)?.mediaType ===
            "video",
        );
      if (
        !window.ModelRegistry?.safeGetModelsSync?.("flow", mode)?.some(
          (model) => model.value === settings.model,
        )
      )
        throw new Error("BATCH_MODEL_MEDIA_MISMATCH");
      if (
        !Number.isInteger(Number(settings.quantity)) ||
        Number(settings.quantity) < quantityRange.min ||
        Number(settings.quantity) > quantityRange.max
      )
        throw new Error("BATCH_QUANTITY_INVALID");
      if (batch.settingsSnapshot?.chain && Number(settings.quantity) !== 1)
        throw new Error("BATCH_CHAIN_QUANTITY_ONE");
      if (
        batch.refMode === "frames" &&
        !(item.refKeys || [])[0] &&
        !(
          batch.settingsSnapshot?.chain?.kind === "video_last_frame" &&
          itemIndex > 0
        )
      )
        throw new Error("BATCH_FRAMES_MISSING");
      if (mode === "image")
        window.ModelRegistry?.getThinkingLevelValue?.(
          "flow",
          settings.model,
          settings.flowThinkingLevel,
        );
      if (mode === "video") {
        const model = window.ModelRegistry.findModel("flow", settings.model);
        const tier = model?.config?.duration_tier || "default";
        const durations =
          window.ProviderConfigManager?.safeGetVideoDurationsSync?.(
            "flow",
            tier,
          ) || [];
        if (
          !hasVideoRef &&
          settings.flowVideoDuration &&
          durations.length &&
          !durations.includes(settings.flowVideoDuration)
        )
          throw new Error("BATCH_VIDEO_DURATION_UNAVAILABLE");
        const resolutions =
          window.ModelRegistry?.getGenerationResolutionConfig?.(
            "flow",
            settings.model,
          );
        if (
          settings.flowVideoResolution &&
          resolutions?.options?.length &&
          !resolutions.options.some(
            (entry) => entry.value === settings.flowVideoResolution,
          )
        )
          throw new Error("BATCH_VIDEO_RESOLUTION_UNAVAILABLE");
      }
      if (!ratiosByMode.has(mode))
        ratiosByMode.set(
          mode,
          await window.ProviderConfigManager?.getRatios?.("flow", mode),
        );
      const ratios = ratiosByMode.get(mode);
      if (
        !Array.isArray(ratios) ||
        !ratios.some(
          (entry) =>
            (typeof entry === "string" ? entry : entry.value) ===
            settings.ratio,
        )
      )
        throw new Error("BATCH_RATIO_UNAVAILABLE");
      const refs = [...new Set(item.refKeys || [])];
      if (refs.some((key) => !pool.has(key)))
        throw new Error("BATCH_REF_IDENTITY_MISSING");
      const forcedDuration =
        mode === "video" &&
        adapter?.getDurationOverride?.({
          modelValue: settings.model,
          hasRef: refs.length > 0,
          hasRefVideo: refs.some(
            (key) =>
              batch.refPool?.find((ref) => ref.refKey === key)?.mediaType ===
              "video",
          ),
          inputType: settings.isFrames ? "Frames" : "Ingredients",
        });
      if (
        !hasVideoRef &&
        forcedDuration &&
        settings.flowVideoDuration !== forcedDuration
      )
        throw new Error("BATCH_DURATION_OVERRIDE_REQUIRED");
      window.GenBatchDraftBuilder.validateRefSelection(
        refs,
        batch.refPool,
        settings,
      );
      if (
        batch.settingsSnapshot?.chain?.kind === "video_last_frame" &&
        itemIndex > 0
      )
        window.GenBatchDraftBuilder.validateVideoChainEndRef(
          refs,
          settings,
          batch.refPool,
        );
      if (
        refs.length &&
        adapter?.supportsRefImages?.(settings.model, {
          inputType: settings.isFrames
            ? "Frames"
            : mode === "video"
              ? "Ingredients"
              : void 0,
          duration: settings.flowVideoDuration || void 0,
        }) === false
      )
        throw new Error("BATCH_MODEL_REF_UNSUPPORTED");
    }
  }
  static async _resolveAssets(batch, store) {
    const assets = await store.getAssetsForBatch(
      batch.userId,
      batch.projectId,
      batch.batchId,
    );
    if (!assets.length) return batch;
    if (typeof window.uploadPendingFiles !== "function")
      throw new Error("BATCH_UPLOAD_UNAVAILABLE");
    const pending = [
      ...new Set(
        (batch.refPool || [])
          .map((ref) => ref.refKey)
          .filter((id) => id.startsWith("upload_")),
      ),
    ];
    if (
      pending.length !== assets.length ||
      pending.some((key) => !assets.some((asset) => asset.refKey === key))
    )
      throw new Error("BATCH_ASSET_SET_MISMATCH");
    window.pendingUploadFiles || (window.pendingUploadFiles = new Map());
    const aliases = new Map();
    for (const asset of assets) {
      const file =
        asset.file instanceof File
          ? asset.file
          : new File([asset.file], asset.name || asset.refKey, {
              type: asset.type || asset.file.type,
            });
      const alias = `upload_${crypto.randomUUID()}`;
      aliases.set(asset.refKey, alias);
      window.pendingUploadFiles.set(alias, { file });
    }
    let exactMapping;
    try {
      await window.uploadPendingFiles([...aliases.values()].join(", "), {
        surface: "batch",
      });
      exactMapping = { ...(window._lastUploadKeyMapping || {}) };
    } finally {
      for (const alias of aliases.values())
        window.pendingUploadFiles.delete(alias);
    }
    const mapping = Object.fromEntries(
      pending.map((key) => [key, exactMapping?.[aliases.get(key)]]),
    );
    if (
      pending.some(
        (key) => !mapping[key] || String(mapping[key]).startsWith("upload_"),
      )
    )
      throw new Error("BATCH_UPLOAD_INCOMPLETE");
    const metadata = Object.fromEntries(
      pending.map((key) => {
        const identity =
          window.MediaRegistry?.getRefIdentity?.(mapping[key]) || {};
        return [
          key,
          {
            fileName: identity.file_name || null,
            mediaUuid: identity.media_uuid || null,
            mediaType: identity.type || null,
          },
        ];
      }),
    );
    return store.applyUploadedRefs(
      batch.userId,
      batch.projectId,
      batch.batchId,
      batch.revision,
      mapping,
      metadata,
    );
  }
  static async admit(
    batch,
    onAdmission,
    store = window.GenBatchQueueStore,
    runSource = null,
    runOriginId = null,
    generationProcessId = null,
  ) {
    generationProcessId || (generationProcessId = crypto.randomUUID());
    const resumeIndexes = batch.resumeItemIndexes;
    if (
      resumeIndexes &&
      (!Array.isArray(resumeIndexes) ||
        !resumeIndexes.length ||
        resumeIndexes.some(
          (index) =>
            !Number.isInteger(index) ||
            index < 0 ||
            index >= batch.items.length ||
            batch.items[index].hidden,
        ) ||
        new Set(resumeIndexes).size !== resumeIndexes.length)
    )
      throw new Error("BATCH_RESUME_MAPPING_INVALID");
    const selected = (source) =>
      resumeIndexes
        ? {
            ...source,
            items: resumeIndexes.map((index) => source.items[index]),
            frameFileIds: Array.isArray(source.frameFileIds)
              ? resumeIndexes.map((index) => source.frameFileIds[index])
              : source.frameFileIds,
          }
        : source;
    this._validate(selected(batch), { allowPending: true });
    const target = await window.MessageBridge?.getLiveTargetContext?.();
    if (target?.projectId !== batch.projectId)
      throw new Error("BATCH_FLOW_PROJECT_MISMATCH");
    const settingsAtAdd = batch.settingsSnapshot;
    const mode = settingsAtAdd.genType === "Video" ? "video" : "image";
    const ratios = await window.ProviderConfigManager?.getRatios?.(
      "flow",
      mode,
    );
    if (
      !Array.isArray(ratios) ||
      !ratios.some(
        (entry) =>
          (typeof entry === "string" ? entry : entry.value) ===
          settingsAtAdd.ratio,
      )
    ) {
      throw new Error("BATCH_RATIO_UNAVAILABLE");
    }
    await this._validateItems(selected(batch), new Map([[mode, ratios]]));
    if (batch.flowExecutionMode === "api") {
      if (
        !window.featureGate?.canUse?.("flow_api_enabled") ||
        window.SystemConfig?.get?.("flow_api_driver", null) === "disabled"
      )
        throw new Error("BATCH_API_UNAVAILABLE");
      if (
        settingsAtAdd.voice?.search_value ||
        settingsAtAdd.character?.search_value ||
        selected(batch).items.some((item) =>
          window.MentionParser?.hasComponents?.(item.prompt),
        )
      )
        throw new Error("BATCH_API_WEB_COMPONENT_CONFLICT");
      const session = await window.FlowApiSessionCoordinator?.check?.({
        surface: "gen",
        mediaType: mode,
        force: true,
        passive: true,
      });
      if (session?.ready !== true)
        throw new Error("BATCH_API_SESSION_UNAVAILABLE");
    }
    const resolved = await this._resolveAssets(batch, store);
    const current = selected(resolved);
    this._validate(current);
    await this._validateItems(current);
    const liveTarget = await window.MessageBridge?.getLiveTargetContext?.();
    if (liveTarget?.projectId !== current.projectId)
      throw new Error("BATCH_FLOW_PROJECT_MISMATCH");
    const settings = current.settingsSnapshot;
    let admittedChain = settings.chain || null;
    if (admittedChain) {
      const prompts = current.items.map((item) => item.prompt);
      const componentChecks = {
        voicePayload: !!settings.voice?.search_value,
        characterPayload: !!settings.character?.search_value,
        promptMentions: prompts.some((prompt) =>
          window.MentionParser?.hasComponents?.(prompt),
        ),
      };
      const routeCheck = await window.GenTab?._validateChain?.(
        prompts,
        settings.genType,
        "flow",
        current.flowExecutionMode === "web" ? "web" : null,
        {
          chain: admittedChain,
          route: current.flowExecutionMode,
          quantity: settings.quantity,
          videoInputType: settings.videoInputType,
          hasRefs: current.refPool?.length > 0,
          settings: window.storageSettings?.getSettings?.() || {},
          componentState: {
            checks: componentChecks,
            hasWebOnlyComponents: Object.values(componentChecks).some(Boolean),
          },
          skipLongWarning: true,
        },
      );
      if (!routeCheck?.ok)
        throw new Error(routeCheck?.message || "BATCH_CHAIN_UNAVAILABLE");
      admittedChain = routeCheck.chain;
    }
    const refs = (current.refPool || []).map((ref) => ref.refKey);
    const refFileNames = Object.fromEntries(
      (current.refPool || [])
        .filter((ref) => ref.fileName || ref.mediaUuid)
        .map((ref) => [ref.refKey, ref.mediaUuid || ref.fileName]),
    );
    const refThumbnails = Object.fromEntries(
      refs
        .map((id) => [id, window.MediaRegistry?.getRefIdentity?.(id) || null])
        .filter(([, identity]) => identity),
    );
    if (current.flowExecutionMode === "api" || admittedChain?.engine === "api")
      this._validateApiRefIdentity(current, refFileNames, refThumbnails);
    const effectiveRefMode =
      current.refMode === "frames"
        ? Array.isArray(current.frameFileIds)
          ? "sequential"
          : "all"
        : current.refMode;
    const refPerPrompt = current.items.map((item) => [
      ...new Set(item.refKeys || []),
    ]);
    const payload = {
      prompts: current.items.map((item) => item.prompt),
      genType: settings.genType,
      modelName: settings.model,
      aspectRatio: settings.ratio,
      quantity: settings.quantity,
      autoDownload: current.autoDownload,
    };
    const pipelineStartedAt = Date.now();
    let admitted = false;
    let result;
    const gate = await window.ExecutionGate.request(
      "generate",
      payload.prompts.length,
      {
        owner: "prompts",
        label: current.displayName,
        provider: "flow",
        media_type: mode,
        has_ref: refs.length > 0,
        ref_count: refs.length,
      },
    );
    if (!gate?.allowed || !gate.token) {
      window.ExecutionGate.showDeniedDialog?.(gate, "Generate");
      throw new Error(gate?.reason || "BATCH_ADMISSION_DENIED");
    }
    try {
      window.UsageSync?.trackEvent?.("gen_start", {
        prompt_count: payload.prompts.length,
        has_ref: refs.length > 0,
        pipeline: true,
      });
      result = await window.PromptQueue.getInstance().submitJob({
        generationProcessId,
        owner: "prompts",
        label: current.displayName,
        prompts: payload.prompts,
        settings: {
          genType: settings.genType,
          ratio: settings.ratio,
          model: settings.model,
          quantity: settings.quantity,
          isFrames: settings.isFrames,
          videoInputType: settings.videoInputType,
          flowVideoDuration: settings.flowVideoDuration,
          flowVideoResolution: settings.flowVideoResolution,
          flowThinkingLevel:
            settings.genType === "Image"
              ? window.ModelRegistry?.getThinkingLevelValue?.(
                  "flow",
                  settings.model,
                  settings.flowThinkingLevel,
                )
              : null,
          flowExecutionMode: current.flowExecutionMode,
          manualSubmitMode: false,
          refVideoIds: (current.refPool || [])
            .filter((ref) => ref.mediaType === "video")
            .map((ref) => ref.refKey),
        },
        itemOverrides: current.items.map((item) => item.settingsOverride || {}),
        refFileIds: refs,
        refFileNames,
        refThumbnails,
        refImageMode: effectiveRefMode,
        refFileIdsPerPrompt: effectiveRefMode === "all" ? null : refPerPrompt,
        resolvedRefFileIdsPerPrompt: refPerPrompt,
        refImagesPerPrompt: current.refImagesPerPrompt,
        mentionData: current.items.map((item) => item.mentionData || null),
        autoDownload: current.autoDownload,
        downloadResolution: settings.downloadResolution,
        videoDownloadResolution: settings.videoDownloadResolution,
        taskName: settings.taskName,
        voice: settings.voice,
        character: settings.character,
        chain: admittedChain,
        sequentialMode: current.sequentialMode,
        promptIndices: resumeIndexes || current.items.map((_, index) => index),
        projectId: current.projectId,
        sourceBatchId: current.batchId,
        sourceBatchName: current.displayName || null,
        runSource,
        historySourceId:
          runSource === "BATCH_LIST_RERUN_MCP" ? runOriginId : null,
        _executionToken: gate.token,
        onQueueAdmitted(receipt) {
          admitted = true;
          onAdmission(receipt);
        },
      });
    } catch (error) {
      if (!admitted && window.ExecutionGate._activeTokens?.has?.(gate.token))
        await window.ExecutionGate.cancel(gate.token, {
          waitForSettlement: true,
        });
      if (admitted) {
        try {
          window.GenTab?._finalizeFlowPipelineError?.(error, {
            payload,
            pipelineRefFileIds: refs,
            projectId: current.projectId,
            sourceBatchId: current.batchId,
            historySource: runSource === "BATCH_LIST_RERUN_MCP" ? "mcp" : null,
            historySourceId:
              runSource === "BATCH_LIST_RERUN_MCP" ? runOriginId : null,
            pipelineStartedAt,
            clearToken: false,
            resetControls: false,
          });
        } catch (finalizerError) {
          console.error(
            "[GenBatchAdmission] error UI failed",
            finalizerError?.message || finalizerError,
          );
        }
      }
      throw error;
    }
    if (!admitted && window.ExecutionGate._activeTokens?.has?.(gate.token))
      await window.ExecutionGate.cancel(gate.token, {
        waitForSettlement: true,
      });
    if (admitted) {
      try {
        window.GenTab?._finalizeFlowPipelineSuccess?.(result, {
          payload,
          pipelineRefFileIds: refs,
          projectId: current.projectId,
          manualSubmitMode: false,
          clearToken: false,
          resetControls: false,
          showFailedPromptModal: false,
        });
      } catch (error) {
        console.error(
          "[GenBatchAdmission] completion UI failed",
          error?.message || error,
        );
      }
    }
    return result;
  }
}
window.GenBatchAdmission = GenBatchAdmission;
