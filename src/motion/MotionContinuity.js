class MotionContinuity {
  static enabled(project) {
    return project?.data_json?.preferences?.continuity_enabled === true;
  }
  static ordered(project) {
    return Object.entries(project?.data_json?.frames || {}).sort(
      (a, b) => Number(a[1].start) - Number(b[1].start),
    );
  }
  static parent(project, frameId) {
    const ordered = this.ordered(project),
      index = ordered.findIndex(([id]) => id === frameId);
    if (index < 0) throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
    return index ? ordered[index - 1] : null;
  }
  static previousError(code, details) {
    const apiDiagnostic = {
      phase: "continuity",
      operation: details.stage,
      eventState: "failed",
      code,
      ...details,
    };
    console.warn("[MotionContinuity]", JSON.stringify(apiDiagnostic));
    return Object.assign(new Error(code), { code, apiDiagnostic });
  }
  static async restorePreviousCheckpoint({
    project,
    frameId,
    restoreGeneratedClip,
    readProject,
    assertScope = async () => {},
    shouldStop = () => false,
  }) {
    if (!this.enabled(project)) return project;
    const parent = this.parent(project, frameId);
    if (!parent) return project;
    const previous = parent[1],
      persist = previous.stages?.persist,
      monitor = previous.stages?.monitor;
    if (monitor?.state !== "ready" || !monitor.provider_media_id) {
      this.identity(...parent);
      return project;
    }
    if (persist?.state === "ready" && persist.artifact_id) return project;
    if (
      typeof restoreGeneratedClip !== "function" ||
      typeof readProject !== "function"
    ) {
      this.identity(...parent);
      return project;
    }
    const expected = {
      sourceRevision: project.data_json.source_revision,
      runId: previous.run_id,
      inputRevision: previous.input_revision,
      mediaId: monitor.provider_media_id,
      operationId: monitor.provider_operation_id,
      nextRunId: project.data_json.frames[frameId]?.run_id,
      nextInputRevision: project.data_json.frames[frameId]?.input_revision,
    };
    await assertScope();
    if (shouldStop()) throw new Error("MOTION_CANCELLED");
    console.info("[MotionContinuity]", {
      frameId,
      previousFrameId: parent[0],
      stage: "restore_previous_checkpoint",
      persistState: persist?.state || null,
    });
    await restoreGeneratedClip(parent[0]);
    await assertScope();
    if (shouldStop()) throw new Error("MOTION_CANCELLED");
    const current = await readProject(),
      saved = current?.data_json?.frames?.[parent[0]],
      next = current?.data_json?.frames?.[frameId];
    await assertScope();
    if (shouldStop()) throw new Error("MOTION_CANCELLED");
    if (
      current?.tool_project_id !== project.tool_project_id ||
      current.flow_project_id !== project.flow_project_id ||
      current.data_json?.source_revision !== expected.sourceRevision ||
      !this.enabled(current) ||
      saved?.run_id !== expected.runId ||
      saved?.input_revision !== expected.inputRevision ||
      saved?.stages?.monitor?.provider_media_id !== expected.mediaId ||
      saved?.stages?.monitor?.provider_operation_id !== expected.operationId ||
      next?.run_id !== expected.nextRunId ||
      next?.input_revision !== expected.nextInputRevision
    )
      throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
    this.identity(parent[0], saved);
    return current;
  }
  static identity(id, frame) {
    if (
      frame?.stages?.persist?.state !== "ready" ||
      frame?.stages?.monitor?.state !== "ready" ||
      !frame.stages.persist.artifact_id ||
      !frame.stages.monitor.provider_media_id
    ) {
      const code =
        frame?.stages?.monitor?.state !== "ready"
          ? "MOTION_CONTINUITY_PREVIOUS_GENERATION_NOT_READY"
          : frame?.stages?.persist?.state !== "ready"
            ? "MOTION_CONTINUITY_PREVIOUS_DOWNLOAD_NOT_READY"
            : "MOTION_CONTINUITY_PREVIOUS_RECEIPT_MISSING";
      const providerCode = frame?.stages?.monitor?.error_code;
      throw this.previousError(code, {
        stage: "previous_checkpoint",
        previousFrameId: id,
        previousRunId: frame?.run_id || null,
        inputRevision: frame?.input_revision ?? null,
        monitorState: frame?.stages?.monitor?.state || null,
        persistState: frame?.stages?.persist?.state || null,
        hasArtifact: !!frame?.stages?.persist?.artifact_id,
        hasMediaIdentity: !!frame?.stages?.monitor?.provider_media_id,
        providerCode: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(providerCode || "")
          ? providerCode
          : null,
      });
    }
    return {
      frame_id: id,
      run_id: frame.run_id,
      input_revision: frame.input_revision,
      artifact_id: frame.stages.persist.artifact_id,
      media_id: frame.stages.monitor.provider_media_id,
    };
  }
  static assertCurrent(project, frameId, binding) {
    if (!this.enabled(project)) {
      if (binding) throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
      return;
    }
    const parent = this.parent(project, frameId);
    if (!parent) {
      if (binding) throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
      return;
    }
    const expected = this.identity(...parent);
    if (
      !binding ||
      Object.keys(expected).some((key) => expected[key] !== binding[key])
    )
      throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
  }
  static validate(project, profile) {
    if (!this.enabled(project)) return;
    const addon = profile?.prompts?.continuity_addon;
    const promptPresent = typeof addon === "string" && addon.trim().length > 0;
    if (!promptPresent || !addon.includes("{continuity_ref}")) {
      console.warn(
        "[MotionContinuity]",
        JSON.stringify({
          stage: "profile_validation",
          outcome: "blocked",
          code: "MOTION_CONTINUITY_PROMPT_UNAVAILABLE",
          reason: promptPresent
            ? "missing_reference_variable"
            : "missing_prompt",
          toolProjectId: project.tool_project_id || null,
          sourceRevision: project.data_json?.source_revision || null,
          profileKey: profile?.profile_key || null,
          profileRevision: profile?.revision || null,
          activeRevision: profile?.active_revision || null,
        }),
      );
      throw new Error("MOTION_CONTINUITY_PROMPT_UNAVAILABLE");
    }
    const refs = project.data_json.references || {},
      model =
        project.data_json?.preferences?.flow_model ||
        profile.settings?.flow_model;
    const adapter = window.ProviderRegistry?.get?.("flow");
    const images =
      MotionCharacterReferences.images(project.data_json).length + 1;
    const imageCap = adapter?.getMaxRefImages?.({
        mode: "video",
        isFrames: false,
        modelValue: model,
      }),
      videoCap = adapter?.getMaxRefVideos?.(model);
    const total = adapter?.getMaxRefImagesTotal?.(model);
    if (
      this.ordered(project).length > 1 &&
      (!Number.isInteger(imageCap) ||
        imageCap < images ||
        !Number.isInteger(videoCap) ||
        videoCap < 1 ||
        (total !== null && (!Number.isInteger(total) || total < images + 1)))
    )
      throw new Error("MOTION_CONTINUITY_REFERENCE_LIMIT");
  }
  static async resolveUploadedReference(
    reference,
    { target, mode, shouldStop, check },
  ) {
    const uuid = (value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    if (
      reference?.type !== "image" ||
      reference.project_id !== target.projectId ||
      (reference.api_driver ? "api" : "web") !== mode
    )
      return null;
    if (uuid(reference.media_uuid)) return reference;
    const gateway = window.flow_uuid_gateway,
      identity = reference.fileId;
    if (!gateway?.isAsb?.(identity) || typeof gateway.resolve !== "function")
      return null;
    await check();
    const resolved = await gateway.resolve([identity], {
      surface: "motion",
      purpose: "reference",
      passive: true,
      mode,
      projectId: target.projectId,
      expectedFlowTarget: target,
      mediaType: "image",
      abortFn: shouldStop,
    });
    await check();
    const entry = resolved?.results?.[identity],
      metadata = entry?.metadata;
    if (
      entry?.ok !== true ||
      !uuid(metadata?.media_uuid) ||
      metadata.type !== "image" ||
      metadata.project_id !== target.projectId
    )
      return null;
    return {
      ...reference,
      fileId: metadata.media_uuid,
      media_uuid: metadata.media_uuid,
      persistent_media_id:
        metadata.persistent_media_id ||
        reference.persistent_media_id ||
        identity,
      file_name: metadata.file_name || reference.file_name || identity,
    };
  }
  static callbacks({
    api,
    endpoint,
    project,
    frameId,
    assertScope = async () => {},
    onChange = async () => {},
    maxRetries = 0,
    waitBeforeRetry = async () => {},
    onProgress = () => {},
  }) {
    const sourceRevision = project.data_json.source_revision,
      frame = project.data_json.frames[frameId];
    const fresh = async () => {
      await assertScope();
      const current = await api("GET", endpoint);
      await assertScope();
      if (
        current.flow_project_id !== project.flow_project_id ||
        current.data_json?.source_revision !== sourceRevision ||
        current.data_json?.frames?.[frameId]?.run_id !== frame.run_id ||
        current.data_json.frames[frameId].input_revision !==
          frame.input_revision
      )
        throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
      return current;
    };
    return {
      assertUploadAllowed: async () => {
        const current = await fresh();
        if (current.data_json?.paused === true)
          throw Object.assign(new Error("MOTION_CANCELLED"), {
            notDispatched: true,
            noRetry: true,
          });
      },
      onStage: async (state, details) => {
        const { uiPhase, ...extra } = details;
        await assertScope();
        const body = {
          source_revision: sourceRevision,
          run_id: frame.run_id,
          input_revision: frame.input_revision,
          stage: "continuity",
          state,
          ...extra,
        };
        let saved;
        try {
          saved = await api(
            "PATCH",
            `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
            body,
          );
        } catch (error) {
          saved = await fresh();
          const stage = saved.data_json.frames[frameId].stages?.continuity;
          if (
            stage?.state !== state ||
            Object.entries(extra).some(([key, value]) => stage[key] !== value)
          )
            throw error;
        }
        await assertScope();
        onProgress({
          frameId,
          stage: "continuity",
          detail: uiPhase || state,
          error: state === "failed" ? extra.error_code : null,
          ...extra,
        });
        await onChange(saved);
      },
      onUploadFailed: async () => {
        for (let attempt = 0; ; attempt++) {
          const current = await fresh();
          if (current.data_json.paused === true) {
            await onChange(current);
            return { paused: true };
          }
          try {
            const saved = await api("PATCH", endpoint, {
              revision: current.revision,
              pause: true,
            });
            if (saved?.data_json?.paused !== true)
              throw new Error("MOTION_CONTINUITY_PAUSE_UNCONFIRMED");
            await onChange(saved);
            return { paused: true };
          } catch (error) {
            const verified = await fresh();
            if (verified.data_json.paused === true) {
              await onChange(verified);
              return { paused: true };
            }
            if (attempt >= maxRetries)
              throw Object.assign(
                new Error("MOTION_CONTINUITY_PAUSE_UNCONFIRMED"),
                { cause: error },
              );
            await waitBeforeRetry({
              frameId,
              stage: "continuity_pause",
              retryCount: attempt + 1,
            });
          }
        }
      },
    };
  }
  static async prepare({
    project,
    profile,
    frameId,
    userId,
    target,
    assertScope = async () => {},
    shouldStop = () => false,
    maxRetries = 0,
    waitBeforeRetry = async () => {},
    onStage = async () => {},
    onUploadFailed = async () => {},
    assertUploadAllowed = async () => {},
    restoreGeneratedClip = null,
  }) {
    if (!this.enabled(project)) return null;
    this.validate(project, profile);
    const parent = this.parent(project, frameId);
    if (!parent) return null;
    const binding = this.identity(...parent),
      sourceRevision = Number(project.data_json.source_revision);
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
      throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
    const failed = async (
      error,
      retryCount = 0,
      receiptUnconfirmed = false,
      retryLimit = maxRetries,
    ) => {
      const raw = String(error?.code || error?.message || "");
      const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
        ? raw
        : "MOTION_CONTINUITY_UPLOAD_UNCONFIRMED";
      let statusError = null;
      try {
        await onStage("failed", {
          error_code: code,
          retry_exhausted: retryCount >= retryLimit,
          retry_count: retryCount,
          retry_limit: retryLimit,
          receipt_unconfirmed: receiptUnconfirmed,
        });
      } catch (e) {
        statusError = e;
      }
      const fence =
        /^(?:ACCOUNT_SCOPE_CHANGED|FLOW_EXECUTION_TARGET_CHANGED|MOTION_CONTINUITY_SCOPE_CHANGED|ABORTED|MOTION_CANCELLED)$/;
      if (fence.test(statusError?.code || statusError?.message || ""))
        throw statusError;
      await assertScope();
      if (shouldStop()) throw new Error("MOTION_CANCELLED");
      let paused = null,
        pauseError = null;
      try {
        paused = await onUploadFailed(error);
      } catch (e) {
        pauseError = e;
      }
      await assertScope();
      if (shouldStop()) throw new Error("MOTION_CANCELLED");
      if (fence.test(pauseError?.code || pauseError?.message || ""))
        throw pauseError;
      const pauseCode = String(pauseError?.code || pauseError?.message || "");
      throw Object.assign(error, {
        motionContinuityUploadFailed: true,
        motionContinuityPauseConfirmed: paused?.paused === true,
        ...((statusError || pauseError) && {
          continuityStatusUnconfirmed: true,
        }),
        ...(pauseError && {
          continuityPauseErrorCode: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(
            pauseCode,
          )
            ? pauseCode
            : "MOTION_CONTINUITY_PAUSE_UNCONFIRMED",
        }),
      });
    };
    const scope = {
      userId,
      toolProjectId: project.tool_project_id,
      sourceRevision,
      frameId: parent[0],
      kind: "generated_clip",
      artifactRevision: parent[1].input_revision,
    };
    const check = async () => {
      await assertScope();
      if (shouldStop()) throw new Error("MOTION_CANCELLED");
      const current = await window.MessageBridge.getTargetContext(target);
      if (
        !current ||
        ["tabId", "projectId", "driverKey", "origin", "routePrefix"].some(
          (key) => (current[key] || null) !== (target[key] || null),
        ) ||
        target.projectId !== project.flow_project_id
      )
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    };
    await check();
    let record = await MotionArtifactStore.get(scope);
    const foreignProject =
      record?.flowProjectId && record.flowProjectId !== target.projectId;
    const foreignMedia =
      record?.media_uuid && record.media_uuid !== binding.media_id;
    const restoreReason =
      foreignProject || foreignMedia
        ? null
        : !record?.blob
          ? "blob_missing"
          : !record.flowProjectId
            ? "project_identity_missing"
            : !record.media_uuid
              ? "media_identity_missing"
              : null;
    if (restoreReason && typeof restoreGeneratedClip === "function") {
      await check();
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        sourceRevision,
        stage: "restore_previous_result",
        reason: restoreReason,
      });
      await restoreGeneratedClip(parent[0]);
      await check();
      record = await MotionArtifactStore.get(scope);
    }
    if (
      !record?.blob ||
      record.flowProjectId !== target.projectId ||
      record.media_uuid !== binding.media_id
    ) {
      const code =
        record && record.flowProjectId !== target.projectId
          ? "MOTION_CONTINUITY_PREVIOUS_PROJECT_MISMATCH"
          : record?.media_uuid && record.media_uuid !== binding.media_id
            ? "MOTION_CONTINUITY_PREVIOUS_MEDIA_MISMATCH"
            : !record?.blob
              ? "MOTION_CONTINUITY_PREVIOUS_LOCAL_MISSING"
              : !record.media_uuid
                ? "MOTION_CONTINUITY_PREVIOUS_IDENTITY_MISSING"
                : "MOTION_CONTINUITY_PREVIOUS_MEDIA_MISMATCH";
      throw this.previousError(code, {
        stage: "previous_local_result",
        frameId,
        previousFrameId: parent[0],
        previousRunId: binding.run_id,
        inputRevision: binding.input_revision,
        sourceRevision,
        model:
          project.data_json?.preferences?.flow_model ||
          profile.settings?.flow_model ||
          null,
        reason:
          record && record.flowProjectId !== target.projectId
            ? "project_mismatch"
            : record?.media_uuid && record.media_uuid !== binding.media_id
              ? "media_identity_mismatch"
              : !record?.blob
                ? "blob_missing"
                : !record.media_uuid
                  ? "media_identity_missing"
                  : "media_identity_mismatch",
      });
    }
    const dependency = JSON.stringify(binding),
      cached = record.continuityReference;
    const watermarkRequested =
      window.WatermarkClient?.enabled?.("video", { scope: "input" }) === true;
    const watermarkCacheMatches = watermarkRequested
      ? cached?.inputWatermark?.requested === true &&
        cached?.inputWatermark?.processed === true
      : cached?.inputWatermark?.requested !== true;
    let inputWatermark = cached?.inputWatermark || {
      requested: watermarkRequested,
      processed: false,
      cleaned: false,
    };
    const write = (next) =>
      MotionArtifactStore.setContinuityReference({
        ...scope,
        expectedOperationId: record.generatedReceiptOperationId || null,
        value: { dependency, inputWatermark, ...next },
      });
    if (cached?.dependency === dependency && !watermarkCacheMatches) {
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        stage: "input_watermark_cache_invalidated",
        requested: watermarkRequested,
        cachedRequested: cached.inputWatermark?.requested ?? null,
        cachedProcessed: cached.inputWatermark?.processed === true,
      });
    }
    if (
      cached?.dependency === dependency &&
      watermarkCacheMatches &&
      cached.state !== "not_dispatched"
    ) {
      if (cached.state === "pending" && cached.reference) {
        let reference = null;
        try {
          reference = await this.resolveUploadedReference(cached.reference, {
            target,
            mode: project.data_json.flow_run_mode,
            shouldStop,
            check,
          });
        } catch (error) {
          await check();
          if (
            [
              "ACCOUNT_SCOPE_CHANGED",
              "FLOW_EXECUTION_TARGET_CHANGED",
              "MOTION_CONTINUITY_SCOPE_CHANGED",
              "ABORTED",
              "MOTION_CANCELLED",
            ].includes(error?.code || error?.message)
          )
            throw error;
        }
        if (reference) {
          await write({
            state: "ready",
            reference,
            retry_count: cached.retry_count || 0,
            retry_limit: cached.retry_limit || 0,
          });
          await onStage("ready", {
            provider_media_id: reference.media_uuid,
            retry_count: cached.retry_count || 0,
            retry_limit: cached.retry_limit || 0,
          });
          console.info("[MotionContinuity]", {
            frameId,
            previousFrameId: parent[0],
            stage: "receipt_reconciled",
            reuploaded: false,
          });
          return { binding, reference };
        }
      }
      if (
        cached.state !== "ready" ||
        cached.reference?.project_id !== target.projectId ||
        cached.reference?.type !== "image" ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          String(cached.reference?.media_uuid || ""),
        )
      ) {
        await check();
        await assertUploadAllowed();
        console.info("[MotionContinuity]", {
          frameId,
          previousFrameId: parent[0],
          sourceRevision,
          stage: "reupload_unconfirmed_reference",
          state: cached.state,
          hasAcceptedIdentity: !!cached.reference?.fileId,
          reason: cached.reference
            ? "identity_unresolved"
            : "accepted_identity_not_recorded",
        });
      } else {
        await check();
        await onStage("ready", {
          provider_media_id: cached.reference.media_uuid,
          retry_count: cached.retry_count || 0,
          retry_limit: cached.retry_limit || 0,
        });
        return { binding, reference: cached.reference };
      }
    }
    let encoded;
    try {
      const timeout = Number(
        window.SystemConfig?.safeGetTimeout?.("api_timeout_ms"),
      );
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error("FLOW_COMMAND_TIMEOUT_CONFIG_UNAVAILABLE");
      const extractStartedAt = Date.now();
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        stage: "extract",
        bytes: record.blob.size,
        transport: "local_blob_worker",
      });
      await onStage("running", {
        uiPhase: "extracting",
        retry_count: 0,
        retry_limit: maxRetries,
      });
      for (let retryCount2 = 0; ; retryCount2++) {
        try {
          encoded = await window.VideoFrameExtractor.extractLastFrameFromBlob(
            record.blob,
            { loadTimeoutMs: timeout, shouldStop },
          );
          break;
        } catch (error) {
          if (
            error?.name === "AbortError" ||
            ["MOTION_CANCELLED", "ABORTED"].includes(
              error?.code || error?.message,
            )
          )
            throw error;
          const code = /^FRAME_VIDEO_[A-Z_]+$/.test(error?.code || "")
            ? error.code
            : "FRAME_VIDEO_DECODE_FAILED";
          if (!shouldStop()) {
            await check();
            const retryable =
              [
                "FRAME_VIDEO_DECODE_TIMEOUT",
                "FRAME_VIDEO_DECODE_FAILED",
              ].includes(error?.code || error?.message) &&
              error?.noRetry !== true &&
              error?.noReplay !== true;
            if (retryable && retryCount2 < maxRetries) {
              await onStage("running", {
                uiPhase: "extracting",
                retry_count: retryCount2 + 1,
                retry_limit: maxRetries,
              });
              console.info("[MotionContinuity]", {
                frameId,
                previousFrameId: parent[0],
                stage: "extract_retry",
                retryCount: retryCount2 + 1,
                maxRetries,
                code,
              });
              await waitBeforeRetry({
                frameId,
                stage: "continuity_extract",
                retryCount: retryCount2 + 1,
              });
              await check();
              continue;
            }
            await onStage("failed", {
              error_code: code,
              retry_count: retryCount2,
              retry_limit: maxRetries,
            });
          }
          throw error;
        }
      }
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        stage: "extracted",
        elapsedMs: Date.now() - extractStartedAt,
      });
      inputWatermark = encoded?.inputWatermark || {
        requested: watermarkRequested,
        processed: encoded?.watermarkRemoved === true,
        cleaned: encoded?.watermarkRemoved === true,
      };
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        stage: "input_watermark",
        requested: inputWatermark.requested,
        processed: inputWatermark.processed,
        cleaned: inputWatermark.cleaned,
        reason: inputWatermark.reason || null,
      });
      await check();
      const base64 = String(encoded?.base64 || "").replace(
        /^data:image\/[a-z0-9.+-]+;base64,/i,
        "",
      );
      if (!base64) throw new Error("MOTION_CONTINUITY_FRAME_EMPTY");
      let uploaded,
        retryCount = 0;
      for (;;) {
        await check();
        await onStage("running", {
          uiPhase: "uploading",
          retry_count: retryCount,
          retry_limit: maxRetries,
        });
        try {
          await write({
            state: "pending",
            retry_count: retryCount,
            retry_limit: maxRetries,
          });
        } catch (error) {
          return failed(error, retryCount);
        }
        let dispatched = false;
        try {
          console.info("[MotionContinuity]", {
            frameId,
            previousFrameId: parent[0],
            stage: "upload",
            retryCount,
            maxRetries,
          });
          uploaded = await window.MessageBridge.uploadFilesToFlow(
            [
              {
                name: `motion-continuity-${parent[0]}-${crypto.randomUUID()}.jpg`,
                type: "image/jpeg",
                base64,
              },
            ],
            {
              surface: "workflow",
              expectedFlowTarget: target,
              abortFn: shouldStop,
              forceDom: project.data_json.flow_run_mode === "web",
              requiredMode: project.data_json.flow_run_mode,
              onBeforeTransport: async () => {
                await check();
                await assertUploadAllowed();
                dispatched = true;
              },
            },
          );
          break;
        } catch (error) {
          const unsent =
            error?.notDispatched === true ||
            (error?.noReplay !== true && !dispatched);
          if (unsent)
            await write({
              state: "not_dispatched",
              retry_count: retryCount,
              retry_limit: maxRetries,
            });
          const transientImageUpload =
            window.FlowApiDownloadRetry?.retryable?.(error) === true;
          if (
            (!unsent && !transientImageUpload) ||
            error?.noRetry === true ||
            error?.noReplay === true ||
            retryCount >= maxRetries ||
            shouldStop()
          )
            return failed(error, retryCount, !unsent);
          retryCount++;
          await waitBeforeRetry({ frameId, stage: "continuity", retryCount });
        }
      }
      await check();
      const detail = uploaded?.tileDetails?.[0],
        identity = detail?.media_uuid || detail?.id;
      const reason = uploaded?.error
        ? "upload_error"
        : uploaded?.tileDetails?.length !== 1
          ? "receipt_count"
          : !identity
            ? "missing_identity"
            : detail.type && detail.type !== "image"
              ? "media_type"
              : detail.project_id && detail.project_id !== target.projectId
                ? "project_mismatch"
                : (detail.api_driver ? "api" : "web") !==
                    project.data_json.flow_run_mode
                  ? "upload_mode"
                  : null;
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        sourceRevision,
        frameRunId: project.data_json.frames[frameId]?.run_id,
        stage: "receipt_validation",
        detailCount: uploaded?.tileDetails?.length || 0,
        reason,
        identityKind: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          String(identity || ""),
        )
          ? "uuid"
          : window.flow_uuid_gateway?.isAsb?.(identity)
            ? "asb"
            : "unknown",
        mode: project.data_json.flow_run_mode,
        driver: detail?.api_driver || null,
      });
      if (reason)
        return failed(
          new Error("MOTION_CONTINUITY_UPLOAD_UNCONFIRMED"),
          retryCount,
          true,
        );
      const receipt = {
        fileId: identity,
        media_uuid: detail.media_uuid || null,
        type: "image",
        project_id: target.projectId,
        file_name: detail.file_name || identity,
        persistent_media_id: detail.persistent_media_id || null,
        ...(detail.display_name && { display_name: detail.display_name }),
        ...(detail.uploadName && { upload_name: detail.uploadName }),
        api_driver: detail.api_driver || null,
        identity_durability: detail.identity_durability || null,
        thumbnail:
          typeof detail.thumbnail === "string" &&
          /^https:\/\//.test(detail.thumbnail)
            ? detail.thumbnail
            : null,
      };
      if (
        !receipt.media_uuid &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(identity))
      )
        receipt.media_uuid = identity;
      try {
        await write({
          state: "pending",
          reference: receipt,
          retry_count: retryCount,
          retry_limit: maxRetries,
        });
      } catch (error) {
        return failed(error, retryCount, true);
      }
      const reference = await this.resolveUploadedReference(receipt, {
        target,
        mode: project.data_json.flow_run_mode,
        shouldStop,
        check,
      });
      if (!reference)
        return failed(
          new Error("MOTION_CONTINUITY_UPLOAD_UNCONFIRMED"),
          retryCount,
          true,
        );
      try {
        await write({
          state: "ready",
          reference,
          retry_count: retryCount,
          retry_limit: maxRetries,
        });
      } catch (error) {
        return failed(error, retryCount);
      }
      await onStage("ready", {
        provider_media_id: reference.media_uuid,
        retry_count: retryCount,
        retry_limit: maxRetries,
      });
      console.info("[MotionContinuity]", {
        frameId,
        previousFrameId: parent[0],
        stage: "ready",
      });
      return { binding, reference };
    } finally {
      if (encoded) encoded.base64 = "";
    }
  }
}
globalThis.MotionContinuity = MotionContinuity;
