class GenBatchDraftBuilder {
  static getQueueLimit() {
    const gate = window.featureGate;
    const value = gate?.entitlements?.gen_batch_queue_max?.value;
    const number = Number(value);
    if (
      gate?._serverFetched !== true ||
      !["number", "string"].includes(typeof value) ||
      String(value).trim() === "" ||
      !Number.isInteger(number) ||
      number < -1
    )
      throw new Error("BATCH_QUEUE_ENTITLEMENT_UNAVAILABLE");
    return number;
  }
  static validateRefSelection(refKeys, refPool, settings) {
    const adapter = window.ProviderRegistry?.get?.("flow");
    const mode = settings.genType === "Video" ? "video" : "image";
    const maxImages = adapter?.getMaxRefImages?.({
      mode,
      isFrames: !!settings.isFrames,
      modelValue: settings.model,
    });
    if (!Number.isInteger(maxImages) || maxImages < 0)
      throw new Error("BATCH_REF_POLICY_UNAVAILABLE");
    const byKey = new Map((refPool || []).map((ref) => [ref.refKey, ref]));
    let imageCount = 0;
    let videoCount = 0;
    for (const key of new Set(refKeys || [])) {
      const ref = byKey.get(key);
      if (!ref) throw new Error("BATCH_REF_IDENTITY_MISSING");
      if (ref.mediaType === "video") videoCount++;
      else imageCount++;
    }
    const maxVideos = videoCount
      ? adapter?.getMaxRefVideos?.(settings.model)
      : 0;
    const total = adapter?.getMaxRefImagesTotal?.(settings.model);
    if (
      imageCount > maxImages ||
      videoCount > maxVideos ||
      (Number.isInteger(total) && imageCount + videoCount > total)
    )
      throw new Error("BATCH_REF_LIMIT_EXCEEDED");
  }
  static validateVideoChainEndRef(refKeys, settings, refPool = []) {
    if (!refKeys?.length) return;
    if (
      (settings.isFrames && refKeys.length !== 1) ||
      refPool.some(
        (ref) => refKeys.includes(ref.refKey) && ref.mediaType === "video",
      )
    )
      throw new Error("BATCH_CHAIN_FRAME_REF_LIMIT");
    const adapter = window.ProviderRegistry?.get?.("flow");
    const useIngredients = refKeys.length > 1;
    const cap = adapter?.getMaxRefImages?.({
      mode: "video",
      isFrames: !useIngredients,
      modelValue: settings.model,
    });
    const total = adapter?.getMaxRefImagesTotal?.(settings.model);
    const required = refKeys.length + 1;
    const ingredientsUnsupported =
      useIngredients &&
      adapter?.supportsRefImages?.(settings.model, {
        inputType: "Ingredients",
        duration: settings.flowVideoDuration || void 0,
      }) === false;
    if (
      !Number.isInteger(cap) ||
      cap < required ||
      (Number.isInteger(total) && total < required) ||
      ingredientsUnsupported
    )
      throw new Error("BATCH_CHAIN_FRAME_REF_LIMIT");
  }
  static checkLimit(count) {
    const gate = window.featureGate;
    const value = gate?.entitlements?.prompts_per_batch?.value;
    const number = Number(value);
    if (
      gate?._serverFetched !== true ||
      !Number.isInteger(number) ||
      (number !== -1 && number < 1)
    )
      throw new Error("BATCH_ENTITLEMENT_UNAVAILABLE");
    const result = gate.checkPromptBatchLimit?.(count);
    if (!result || Number(result.limit) !== number)
      throw new Error("BATCH_ENTITLEMENT_UNAVAILABLE");
    return result;
  }
  static _prompts(gen) {
    const text = String(gen.promptsArea?.value || "").trim();
    if (!text) throw new Error("BATCH_PROMPT_EMPTY");
    const parsed = gen.multiPromptCheck?.checked
      ? text
          .split(/\n\s*\n/)
          .map((value) => value.trim())
          .filter(Boolean)
      : [text];
    const addon = gen._getSelectedAddonPrompt?.();
    return addon?.content
      ? parsed.map(
          (prompt) => `${prompt}

${addon.content}`,
        )
      : parsed;
  }
  static _frames(gen, count) {
    if (
      gen.genTypeSelect?.value !== "Video" ||
      gen.videoInputTypeSelect?.value !== "Frames"
    )
      return null;
    if (
      gen.multiPromptCheck?.checked &&
      count > 1 &&
      gen._perPromptFrameData?.length
    ) {
      return Array.from({ length: count }, (_, index) => ({
        frame1: gen._perPromptFrameData[index]?.frame1 || "",
        frame2: gen._perPromptFrameData[index]?.frame2 || "",
      }));
    }
    return {
      frame1:
        document.getElementById("genTabFrame1FileId")?.value?.trim() || "",
      frame2:
        document.getElementById("genTabFrame2FileId")?.value?.trim() || "",
    };
  }
  static _mapping(
    prompts,
    pool,
    mode,
    count,
    frames,
    mentionData,
    maxRefs = Infinity,
  ) {
    if (frames) {
      const pairs = Array.isArray(frames) ? frames : prompts.map(() => frames);
      return pairs.map((pair) => [pair.frame1, pair.frame2].filter(Boolean));
    }
    if (mode === "none") return prompts.map(() => []);
    if (mode === "all") return prompts.map(() => [...pool]);
    if (mode === "sequential")
      return prompts.map((_, index) => this.sequentialRefs(pool, index, count));
    if (mode === "mention")
      return mentionData.map((entry) =>
        [
          ...new Set(
            (entry.refImages || []).map((ref) => ref.file_id).filter(Boolean),
          ),
        ].slice(0, maxRefs),
      );
    throw new Error("BATCH_REF_MODE_INVALID");
  }
  static sequentialRefs(pool, promptIndex, count) {
    const size = window.RefImageAssignment.count(count);
    return pool.slice(promptIndex * size, (promptIndex + 1) * size);
  }
  static remapDraft(batch) {
    const pool = (batch.refPool || []).map((ref) => ref.refKey);
    const prompts = batch.items.map((item) => item.prompt);
    let mentionData = null;
    if (batch.refMode === "mention") {
      if (!window.MentionParser || typeof ImageNameRegistry === "undefined")
        throw new Error("BATCH_MENTION_PARSER_UNAVAILABLE");
      const previous = window.imageNameRegistry;
      try {
        window.imageNameRegistry = new ImageNameRegistry();
        window.imageNameRegistry.registerFromRefImages(
          (batch.refPool || []).map((ref) => ({
            file_id: ref.refKey,
            name: ref.name,
            file_name: ref.fileName,
            type: ref.refKey.startsWith("upload_") ? "upload" : "flow",
          })),
        );
        mentionData = window.MentionParser.processMultiPrompts(prompts).map(
          (entry) => ({
            originalPrompt: entry.originalPrompt,
            cleanedPrompt: entry.cleanedPrompt,
            hasUnresolvedMentions: entry.hasUnresolvedMentions,
            mentions: entry.mentions.map((value) => ({
              mention: value.mention,
              found: value.found,
            })),
            refImages: entry.refImages.map((ref) => ({
              file_id: ref.file_id,
              name: ref.name,
              file_name: ref.file_name || null,
            })),
          }),
        );
      } finally {
        window.imageNameRegistry = previous;
      }
    }
    const mapping = this._mapping(
      prompts,
      pool,
      batch.refMode,
      window.RefImageAssignment.count(batch.refImagesPerPrompt),
      batch.frameFileIds,
      mentionData,
    );
    const allowed = new Set(pool);
    batch.items = batch.items.map((item, index) => {
      const refKeys = item.refOverride === true ? item.refKeys : mapping[index];
      if (refKeys.some((key) => !allowed.has(key)))
        throw new Error("BATCH_REF_LIMIT_EXCEEDED");
      this.validateRefSelection(refKeys, batch.refPool, {
        ...batch.settingsSnapshot,
        ...(item.settingsOverride || {}),
      });
      if (
        batch.settingsSnapshot?.chain?.kind === "video_last_frame" &&
        index > 0
      )
        this.validateVideoChainEndRef(
          refKeys,
          { ...batch.settingsSnapshot, ...(item.settingsOverride || {}) },
          batch.refPool,
        );
      if (mentionData?.[index]?.hasUnresolvedMentions)
        throw new Error("BATCH_MENTION_UNRESOLVED");
      return {
        ...item,
        refKeys,
        mentionData: mentionData?.[index] || null,
        status: item.status === "needs_review" ? "queued" : item.status,
      };
    });
    return batch;
  }
  static async collect(gen) {
    if (gen.providerSelect?.value !== "flow")
      throw new Error("BATCH_FLOW_ONLY");
    if (!window.PromptQueue?.isEnabled?.())
      throw new Error("PIPELINE_QUEUE_DISABLED");
    const userId = window.authManager?.getUser?.()?.id;
    const projectId = window._currentProjectId;
    if (!window.authManager?.isLoggedIn?.() || !userId)
      throw new Error("BATCH_USER_REQUIRED");
    if (!projectId) throw new Error("BATCH_PROJECT_REQUIRED");
    const prompts = this._prompts(gen);
    const gate = this.checkLimit(prompts.length);
    if (!gate || !gate.allowed) {
      const error = new Error("BATCH_LIMIT_EXCEEDED");
      error.count = prompts.length;
      error.limit = gate?.limit ?? null;
      throw error;
    }
    const genType = gen.genTypeSelect?.value;
    const model =
      genType === "Video"
        ? gen.videoModelSelect?.value
        : gen.imageModelSelect?.value;
    const ratio = gen._resolveFlowRatio?.(gen.aspectRatioSelect?.value);
    if (!model || !window.ModelRegistry?.findModel?.("flow", model) || !ratio) {
      throw new Error("BATCH_MODEL_OR_RATIO_UNAVAILABLE");
    }
    const quantity = Number(gen.quantitySelect?.value);
    const quantityRange =
      window.ProviderConfigManager?.safeGetQuantityRangeSync?.("flow");
    if (
      !quantityRange ||
      !Number.isInteger(quantityRange.min) ||
      !Number.isInteger(quantityRange.max)
    )
      throw new Error("BATCH_QUANTITY_POLICY_UNAVAILABLE");
    if (
      !Number.isInteger(quantity) ||
      quantity < quantityRange.min ||
      quantity > quantityRange.max
    )
      throw new Error("BATCH_QUANTITY_INVALID");
    const settings = window.storageSettings?.getSettings?.() || {};
    const selectedMode = settings.defaultGenMode || settings.gen_mode || "ui";
    const flowExecutionMode = selectedMode === "ui" ? "web" : selectedMode;
    if (!["web", "api", "auto"].includes(flowExecutionMode))
      throw new Error("BATCH_ROUTE_UNAVAILABLE");
    const chainCheck = await gen._validateChain(
      prompts,
      genType,
      "flow",
      flowExecutionMode === "web" ? "web" : null,
    );
    if (
      String(window.authManager?.getUser?.()?.id || "") !== String(userId) ||
      window._currentProjectId !== projectId ||
      gen.providerSelect?.value !== "flow"
    )
      throw new Error("BATCH_SCOPE_CHANGED");
    if (!chainCheck.ok)
      throw new Error(chainCheck.message || "BATCH_CHAIN_INVALID");
    const chain = chainCheck.chain || null;
    let frames = this._frames(gen, prompts.length);
    const chainRefMode =
      chain?.kind === "video_last_frame" &&
      frames &&
      ["all", "sequential"].includes(gen.refImageMode)
        ? gen.refImageMode
        : "none";
    if (chain?.kind === "video_last_frame" && frames) {
      if (typeof gen._videoChainFramePairs !== "function")
        throw new Error("BATCH_CHAIN_REF_MAPPER_UNAVAILABLE");
      const sources = String(gen.fileIdsInput?.value || "")
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id && gen.refMediaTypes?.[id] !== "video");
      frames = gen._videoChainFramePairs(
        frames,
        sources,
        chainRefMode,
        prompts.length,
      );
    }
    if (frames) {
      const missing =
        gen._getMissingStartFrameIndexes?.(prompts.length, genType) || [];
      const required =
        chain?.kind === "video_last_frame"
          ? missing.filter((index) => index === 0)
          : missing;
      if (required.length)
        throw new Error(
          `BATCH_FRAMES_MISSING:${required.map((index) => index + 1).join(",")}`,
        );
    }
    const refMode = frames ? "frames" : gen.refImageMode;
    const pool = frames
      ? [
          ...new Set(
            (Array.isArray(frames) ? frames : [frames])
              .flatMap((pair) => [pair.frame1, pair.frame2])
              .filter(Boolean),
          ),
        ]
      : refMode === "none"
        ? []
        : String(gen.fileIdsInput?.value || "")
            .split(",")
            .map((id) => id.trim())
            .filter(Boolean);
    const refs = [];
    const assets = [];
    const keyMap = new Map();
    for (const rawKey of [...new Set(pool)]) {
      let key = rawKey;
      let identity = null;
      if (rawKey.startsWith("upload_")) {
        const uploaded = window.ImmediateUploader?.getResult?.(rawKey);
        if (uploaded?.tile_id) {
          key = uploaded.tile_id;
          identity = uploaded;
        } else {
          const file = window.pendingUploadFiles?.get(rawKey)?.file;
          if (!(file instanceof Blob) || file.size === 0)
            throw new Error(`BATCH_ASSET_MISSING:${rawKey}`);
          assets.push({
            refKey: rawKey,
            file,
            name: file.name || gen.refImageNames?.[rawKey] || "",
          });
        }
      }
      keyMap.set(rawKey, key);
      identity ||
        (identity = window.MediaRegistry?.getRefIdentity?.(key) || null);
      const thumbnail =
        gen.thumbnailCache?.[rawKey] ||
        window.MediaRegistry?.getThumb?.(key) ||
        identity?.thumbnail ||
        "";
      refs.push({
        refKey: key,
        name:
          gen.refImageNames?.[rawKey] ||
          identity?.name ||
          identity?.file_name ||
          "",
        fileName: identity?.file_name || gen.fileNameCache?.[rawKey] || null,
        mediaUuid: identity?.media_uuid || gen.mediaUuidCache?.[rawKey] || null,
        mediaType:
          identity?.media_type ||
          identity?.type ||
          gen.refMediaTypes?.[rawKey] ||
          (rawKey.startsWith("upload_") &&
          assets
            .find((asset) => asset.refKey === rawKey)
            ?.file?.type?.startsWith("video/")
            ? "video"
            : "image"),
        thumbnail: /^https?:\/\//.test(thumbnail) ? thumbnail : null,
      });
    }
    const mappedPool = pool.map((key) => keyMap.get(key));
    const mappedFrames =
      frames &&
      (Array.isArray(frames)
        ? frames.map((pair) => ({
            frame1: keyMap.get(pair.frame1) || "",
            frame2: keyMap.get(pair.frame2) || "",
          }))
        : {
            frame1: keyMap.get(frames.frame1) || "",
            frame2: keyMap.get(frames.frame2) || "",
          });
    let mentionData = null;
    if (refMode === "mention") {
      if (!window.MentionParser || typeof ImageNameRegistry === "undefined")
        throw new Error("BATCH_MENTION_PARSER_UNAVAILABLE");
      const previousRegistry = window.imageNameRegistry;
      try {
        window.imageNameRegistry = new ImageNameRegistry();
        window.imageNameRegistry.registerFromRefImages(
          refs.map((ref) => ({
            file_id: ref.refKey,
            name: ref.name,
            file_name: ref.fileName,
            type: ref.refKey.startsWith("upload_") ? "upload" : "flow",
          })),
        );
        mentionData = window.MentionParser.processMultiPrompts(prompts).map(
          (entry) => ({
            originalPrompt: entry.originalPrompt,
            cleanedPrompt: entry.cleanedPrompt,
            hasUnresolvedMentions: entry.hasUnresolvedMentions,
            mentions: entry.mentions.map((value) => ({
              mention: value.mention,
              found: value.found,
            })),
            refImages: entry.refImages.map((ref) => ({
              file_id: ref.file_id,
              name: ref.name,
              file_name: ref.file_name || null,
            })),
          }),
        );
      } finally {
        window.imageNameRegistry = previousRegistry;
      }
    }
    const count = window.RefImageAssignment.count(gen.refImagesPerPrompt);
    const mapping = this._mapping(
      prompts,
      mappedPool,
      refMode,
      count,
      mappedFrames,
      mentionData,
    );
    const flowAdapter = window.ProviderRegistry?.get?.("flow");
    for (const [index, ids] of mapping.entries()) {
      this.validateRefSelection(ids, refs, {
        genType,
        model,
        isFrames: !!frames,
      });
      if (chain?.kind === "video_last_frame" && index > 0)
        this.validateVideoChainEndRef(ids, { model, isFrames: !!frames }, refs);
    }
    let duration =
      genType === "Video" ? gen.flowVideoDurationSelect?.value || null : null;
    const forced =
      duration &&
      flowAdapter?.getDurationOverride?.({
        modelValue: model,
        hasRef: mapping.some((ids) => ids.length),
        hasRefVideo: refs.some((ref) => ref.mediaType === "video"),
        inputType: frames ? "Frames" : "Ingredients",
      });
    if (forced) duration = forced;
    if (
      mapping.some((ids) => ids.length) &&
      flowAdapter?.supportsRefImages?.(model, {
        inputType: frames
          ? "Frames"
          : genType === "Video"
            ? "Ingredients"
            : void 0,
        duration: duration || void 0,
      }) === false
    )
      throw new Error("BATCH_MODEL_REF_UNSUPPORTED");
    const voiceSlug =
      document.getElementById("genVideoVoiceSelect")?.value || "";
    const voice =
      voiceSlug && genType === "Video" && !frames
        ? window.VoiceRegistry?.findBySlug?.(voiceSlug)
        : null;
    const characterSlug =
      document.getElementById("genCharacterSelect")?.value || "";
    const character =
      characterSlug && !frames
        ? window.CharacterRegistry?.payload?.(characterSlug)
        : null;
    const autoDownload =
      window.featureGate?.canUse?.("auto_download") === true &&
      document.getElementById("genTabAutoDownload")?.checked === true;
    const settingsSnapshot = {
      genType,
      model,
      ratio,
      quantity,
      isFrames: !!frames,
      videoInputType:
        genType === "Video" ? gen.videoInputTypeSelect?.value || null : null,
      flowVideoDuration: duration,
      flowVideoResolution:
        genType === "Video"
          ? gen.flowVideoResolutionSelect?.value || null
          : null,
      flowThinkingLevel:
        genType === "Image"
          ? window.ModelRegistry?.getThinkingLevelValue?.(
              "flow",
              model,
              document.getElementById("flowThinkingLevel")?.value,
            )
          : null,
      flowExecutionMode,
      manualSubmitMode: false,
      downloadResolution:
        document.getElementById("genTabDownloadResolution")?.value || null,
      videoDownloadResolution:
        document.getElementById("genTabVideoDownloadResolution")?.value || null,
      taskName:
        document.getElementById("genTabSubFolder")?.value?.trim() || null,
      voice: voice?.search_value
        ? { slug: voice.slug, search_value: voice.search_value }
        : null,
      character: character?.search_value ? character : null,
      chain,
      chainRefMode,
    };
    const batchId = crypto.randomUUID();
    const draft = {
      batchId,
      settingsSnapshot,
      flowExecutionMode,
      sequentialMode:
        !!chain ||
        (gen.multiPromptCheck?.checked && gen.runMode === "sequential"),
      refMode,
      refPool: refs,
      refImagesPerPrompt: count,
      frameFileIds: mappedFrames,
      autoDownload,
      items: prompts.map((prompt, index) => ({
        draftItemId: crypto.randomUUID(),
        prompt,
        settingsOverride: {},
        refKeys: mapping[index],
        mentionData: mentionData?.[index] || null,
        status: mentionData?.[index]?.hasUnresolvedMentions
          ? "needs_review"
          : "queued",
      })),
    };
    return { draft, assets, userId, projectId };
  }
}
window.GenBatchDraftBuilder = GenBatchDraftBuilder;
