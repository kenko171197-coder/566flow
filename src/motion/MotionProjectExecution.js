class MotionProjectExecution {
  static async correctSourceReceipt(receipt, target) {
    if (!receipt || receipt.projectId !== target?.projectId)
      throw new Error("MOTION_FLOW_PROJECT_RECEIPT_REQUIRED");
    const sameTarget = (current) =>
      current &&
      ["tabId", "projectId", "driverKey", "origin"].every(
        (key) => current[key] === target[key],
      );
    if (!sameTarget(await MessageBridge.getTargetContext(target)))
      throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    const keys = [
      ...new Set(
        [
          receipt.mediaUuid,
          receipt.mediaId,
          receipt.persistentMediaId,
          receipt.fileName,
        ].filter(Boolean),
      ),
    ];
    const catalog = await MessageBridge.lookupFlowMediaCatalog(keys).catch(
      () => null,
    );
    if (!sameTarget(await MessageBridge.getTargetContext(target)))
      throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    if (catalog?.supported !== true || catalog.projectId !== target.projectId)
      return receipt;
    const identity = keys
      .map((key) => catalog.known?.[key])
      .find((item) => String(item?.type || "").toLowerCase() === "video");
    const uuid = String(identity?.media_uuid || ""),
      asb = String(identity?.persistent_media_id || "");
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid) ||
      !window.flow_uuid_gateway.isAsb(asb)
    )
      return receipt;
    return {
      ...receipt,
      mediaUuid: uuid,
      persistentMediaId: asb,
      fileName: asb,
      ...(identity.display_name && { display_name: identity.display_name }),
    };
  }
  static async correctReferences(references, target, characterCount = 1) {
    const sameTarget = (current) =>
      current &&
      ["tabId", "projectId", "driverKey", "origin"].every(
        (key) => current[key] === target[key],
      );
    if (!sameTarget(await MessageBridge.getTargetContext(target)))
      throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    const output = { ...references };
    for (const kind of [
      "character",
      ...(characterCount === 2 ? ["character2"] : []),
      "background",
    ]) {
      if (kind === "character2" && !Array.isArray(references[kind])) continue;
      output[kind] = [];
      for (const ref of references[kind] || []) {
        const uuid = [ref.media_uuid, ref.fileId].find((value) =>
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            String(value || ""),
          ),
        );
        let corrected = ref;
        if (uuid) {
          const catalog = await MessageBridge.lookupFlowMediaCatalog([
            uuid,
          ]).catch(() => null);
          if (!sameTarget(await MessageBridge.getTargetContext(target)))
            throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
          const info = catalog?.known?.[uuid];
          if (
            catalog?.supported === true &&
            catalog.projectId === target.projectId &&
            String(info?.media_uuid || "").toLowerCase() ===
              uuid.toLowerCase() &&
            String(info?.type || "").toLowerCase() === "image" &&
            window.flow_uuid_gateway.isAsb(info?.persistent_media_id)
          ) {
            corrected = {
              ...ref,
              media_uuid: uuid,
              persistent_media_id: info.persistent_media_id,
              file_name: info.persistent_media_id,
              identity_durability: "durable",
              ...(info.display_name && { display_name: info.display_name }),
              identity_aliases: [
                ...new Set([
                  ...(ref.identity_aliases || []),
                  uuid,
                  info.persistent_media_id,
                ]),
              ],
            };
          }
        }
        output[kind].push(corrected);
      }
    }
    return output;
  }
  static async snapshotSettingsDiagnostic(project, run, expectedFingerprint) {
    const prefs = project.data_json?.preferences || {},
      restored = { ...prefs },
      pinnedFields = [];
    const pins = {
      auto_download_final: run?.autoDownloadFinal,
      use_original_audio: run?.useOriginalAudio,
      continuity_enabled: run?.continuityEnabled,
      ratio: run?.downloadRatio,
      flow_download_resolution: run?.downloadResolution,
      transcription_provider: run?.transcriptSettings?.transcription_provider,
      translate_enabled: run?.transcriptSettings?.translate_enabled,
      target_language: run?.transcriptSettings?.target_language,
    };
    for (const [key, value] of Object.entries(pins)) {
      if (value === void 0 || prefs[key] === value) continue;
      pinnedFields.push(key);
      restored[key] = value;
    }
    const reconstructed = {
      ...project,
      data_json: { ...project.data_json, preferences: restored },
    };
    return {
      pinnedFields,
      matchesSavedFingerprint:
        (await this.settingsFingerprint(reconstructed)) === expectedFingerprint,
    };
  }
  static async settingsFingerprint(project) {
    const canonical = (value2) =>
      Array.isArray(value2)
        ? value2.map(canonical)
        : value2 && typeof value2 === "object"
          ? Object.fromEntries(
              Object.keys(value2)
                .sort()
                .map((key) => [key, canonical(value2[key])]),
            )
          : value2;
    const refs = project.data_json?.references || {};
    const references = { ...refs };
    for (const kind of ["character", "character2", "background"]) {
      if (Array.isArray(refs[kind]))
        references[kind] = refs[kind].map((ref) => {
          if (!ref || typeof ref !== "object") return ref;
          const { thumbnail, display_name, ...identity } = ref;
          return identity;
        });
    }
    const value = JSON.stringify(
      canonical({
        preferences: project.data_json?.preferences || {},
        references,
        mode: project.data_json?.flow_run_mode,
      }),
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  static async run({
    owner,
    project,
    profile,
    flowTarget,
    api,
    journal,
    maxWorkers,
    getVideoMonitorLimit,
    shouldStop,
    waitBeforeRetry,
    waitForSlot,
    assertScope,
    retryable,
    validateReferences,
    queue,
    downloadConfig,
    download,
    hostEpoch,
    flowTabId,
    accountTabId = null,
    screen = {},
    model = null,
    deleteAfter = false,
    signal = null,
    onStage = () => {},
    onQueueAdmitted = () => {},
    isForceStopped = () => false,
    _storageRetries = {},
    _closeRetries = {},
    transcriptOnly = false,
    resumeSubtitleReview = false,
  }) {
    if (
      !owner ||
      !project ||
      !profile ||
      !journal ||
      !flowTarget ||
      !queue ||
      [
        api,
        getVideoMonitorLimit,
        shouldStop,
        waitBeforeRetry,
        waitForSlot,
        assertScope,
        retryable,
        validateReferences,
        download,
        onStage,
      ].some((fn) => typeof fn !== "function")
    )
      throw new Error("MOTION_EXECUTION_CONFIG_INVALID");
    await assertScope();
    const run = await journal.get(owner);
    journal._owned(run, owner);
    const expectedMode =
      run?.preparationSnapshot?.executionMode ??
      (run?.continuityEnabled === true && run.executionMode === "sequential"
        ? "sequential"
        : profile.settings?.execution_mode);
    if (
      run?.runId !== owner.runId ||
      run.state !== "running" ||
      !["parallel", "sequential"].includes(run.executionMode) ||
      typeof run.autoDownloadFinal !== "boolean" ||
      typeof run.retryEnabled !== "boolean" ||
      !Number.isSafeInteger(run.transcriptMaxRetries) ||
      run.transcriptMaxRetries < 0 ||
      profile.revision !== run.profileRevision ||
      expectedMode !== run.executionMode ||
      project.tool_project_id !== owner.toolProjectId ||
      project.flow_project_id !== run.flowProjectId ||
      flowTarget.projectId !== run.flowProjectId ||
      Number(project.data_json?.source_revision) !== run.sourceRevision ||
      (transcriptOnly
        ? run.taskKind !== "transcript_batch"
        : !["web", "api"].includes(project.data_json?.flow_run_mode)) ||
      project.data_json?.requires_resplit
    )
      throw new Error("MOTION_EXECUTION_SCOPE_INVALID");
    if (resumeSubtitleReview && run.subtitleReview === "waiting") {
      await journal.setSubtitleReview(owner, "accepted");
      run.subtitleReview = "accepted";
      console.info("[MotionSubtitleReview]", {
        runId: owner.runId,
        stage: "accepted",
        sourceRevision: run.sourceRevision,
      });
    }
    const fullAudioEnabled =
      run.executionMode === "parallel" &&
      profile.settings.full_audio_transcription === true;
    if ((run.fullAudioTranscription === true) !== fullAudioEnabled)
      throw new Error("MOTION_EXECUTION_SETTINGS_CHANGED");
    const preferences = structuredClone(project.data_json.preferences || {});
    if (
      !transcriptOnly &&
      (run.continuityEnabled === true) !==
        (preferences.continuity_enabled === true)
    )
      throw new Error("MOTION_EXECUTION_SETTINGS_CHANGED");
    if (!transcriptOnly && preferences.continuity_enabled === true)
      MotionContinuity.validate(project, profile);
    if ((preferences.auto_download_final === true) !== run.autoDownloadFinal)
      throw new Error("MOTION_EXECUTION_SETTINGS_CHANGED");
    const resolutions = (
      Array.isArray(downloadConfig?.video) ? downloadConfig.video : []
    ).filter(
      (item) =>
        item &&
        /^[A-Za-z0-9]{1,20}$/.test(item.value) &&
        typeof item.label === "string",
    );
    if (!transcriptOnly && !resolutions.length)
      throw new Error("FLOW_RESOLUTION_CONFIG_INVALID");
    const selectedResolution = transcriptOnly
      ? null
      : resolutions.some(
            (item) => item.value === preferences.flow_download_resolution,
          )
        ? preferences.flow_download_resolution
        : resolutions[0].value;
    if (!transcriptOnly)
      MotionResolutionPolicy.candidates(downloadConfig, selectedResolution);
    const snapshot = await this.settingsFingerprint(project);
    if (
      typeof run.settingsSnapshot !== "string" ||
      run.settingsSnapshot !== snapshot
    )
      throw new Error("MOTION_EXECUTION_SETTINGS_CHANGED");
    const endpoint = `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`;
    const fresh = async (frame) => {
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      const current2 = await api("GET", endpoint);
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      if (
        current2?.tool_project_id !== owner.toolProjectId ||
        current2.flow_project_id !== run.flowProjectId ||
        Number(current2.data_json?.source_revision) !== run.sourceRevision
      )
        throw new Error("MOTION_EXECUTION_SCOPE_CHANGED");
      if ((await this.settingsFingerprint(current2)) !== snapshot) {
        const code = "MOTION_EXECUTION_SETTINGS_CHANGED";
        const currentPreferences = current2.data_json?.preferences || {};
        const changedSettings = [
          ...new Set([
            ...Object.keys(preferences),
            ...Object.keys(currentPreferences),
          ]),
        ].filter(
          (key) =>
            JSON.stringify(preferences[key]) !==
            JSON.stringify(currentPreferences[key]),
        );
        console.warn(
          "[MotionExecutionScope]",
          JSON.stringify({
            runId: owner.runId,
            frameId: frame?.frameId || null,
            code,
            changedSettings,
            modeChanged:
              current2.data_json?.flow_run_mode !==
              project.data_json?.flow_run_mode,
          }),
        );
        try {
          onStage({
            frameId: frame?.frameId || null,
            apiDiagnostic: {
              phase: "execution_scope",
              operation: "settings_check",
              eventState: "failed",
              code,
              sourceRevision: run.sourceRevision,
            },
          });
        } catch (_) {}
        throw new Error(code);
      }
      if (current2.data_json?.requires_resplit)
        throw new Error("MOTION_SOURCE_REQUIRES_RESPLIT");
      if (frame) {
        const saved = current2.data_json?.frames?.[frame.frameId];
        if (
          !saved ||
          saved.run_id !== frame.run_id ||
          saved.input_revision !== frame.input_revision
        )
          throw new Error("MOTION_FRAME_SCOPE_CHANGED");
      }
      return current2;
    };
    const frames = Object.entries(project.data_json?.frames || {})
      .sort((a, b) => Number(a[1].start) - Number(b[1].start))
      .filter(
        ([frameId]) =>
          !transcriptOnly || run.transcriptFrameIds.includes(frameId),
      )
      .map(([frameId, frame]) => ({ ...frame, frameId }));
    for (const frame of frames) {
      if (frame.stages?.persist?.state !== "ready") continue;
      const local = await MotionArtifactStore.get({
        userId: owner.userId,
        toolProjectId: owner.toolProjectId,
        sourceRevision: run.sourceRevision,
        frameId: frame.frameId,
        kind: "generated_clip",
        artifactRevision: frame.input_revision,
      });
      frame._motionComplete =
        !!local?.blob && local.flowProjectId === run.flowProjectId;
    }
    const needsPreparation = (frame) =>
      !frame._motionComplete && frame.stages?.monitor?.state !== "ready";
    if (!transcriptOnly && frames.some(needsPreparation))
      await validateReferences(project, profile);
    const needTranscript = (frame) =>
      transcriptOnly
        ? !(
            frame.stages?.transcribe?.state === "ready" &&
            frame.transcript &&
            (frame.stages.transcribe.worker?.project_run_id === owner.runId ||
              (["audio_track_absent", "silent_verified"].includes(
                frame.stages?.split?.audio_state,
              ) &&
                frame.transcript.has_speech === false))
          )
        : needsPreparation(frame) &&
          (preferences.voice_enabled === true ||
            preferences.subtitle_enabled === true) &&
          (!frame.transcript ||
            ["failed", "needs_review"].includes(
              frame.stages?.transcribe?.state,
            ) ||
            (preferences.translate_enabled === true &&
              frame.transcript.has_speech === true &&
              (frame.transcript.translation_stale === true ||
                !String(frame.transcript.translated_text || "").trim())));
    if (!frames.length) throw new Error("MOTION_SPLIT_NOT_READY");
    for (const frame of frames) {
      if (frame.stages?.split?.state !== "ready")
        frame.preparationError = {
          stage: "source",
          code: frame.stages?.split?.error_code || "MOTION_SPLIT_NOT_READY",
        };
      else if (
        needTranscript(frame) &&
        !["audio_present", "audio_track_absent", "silent_verified"].includes(
          frame.stages?.split?.audio_state,
        )
      )
        frame.preparationError = {
          stage: "transcript",
          code:
            frame.stages?.split?.audio_state === "audio_decode_unsupported"
              ? "AUDIO_DECODE_UNSUPPORTED"
              : "MOTION_AUDIO_STATE_INVALID",
        };
      else if (
        !fullAudioEnabled &&
        needTranscript(frame) &&
        frame.stages?.split?.audio_state === "audio_present"
      ) {
        let audio = await MotionArtifactStore.get({
          userId: owner.userId,
          toolProjectId: owner.toolProjectId,
          sourceRevision: run.sourceRevision,
          frameId: frame.frameId,
          kind: "source_audio",
        });
        if (!audio?.blob && window.MotionAudioRegenerator?.ensureFrameAudio) {
          try {
            const recovered = await MotionAudioRegenerator.ensureFrameAudio({
              project: await fresh(frame),
              userId: owner.userId,
              frameId: frame.frameId,
              api,
              assertScope,
              shouldStop,
              maxRetries: run.retryEnabled ? run.transcriptMaxRetries : 0,
              onProgress: (value) =>
                onStage({
                  frameId: frame.frameId,
                  stage: "audio",
                  detail: value.state,
                }),
            });
            frame.stages.split =
              recovered.data_json.frames[frame.frameId].stages.split;
            audio = await MotionArtifactStore.get({
              userId: owner.userId,
              toolProjectId: owner.toolProjectId,
              sourceRevision: run.sourceRevision,
              frameId: frame.frameId,
              kind: "source_audio",
            });
          } catch (error) {
            const raw = String(error?.code || error?.message || "");
            if (
              shouldStop() ||
              /(?:SCOPE_CHANGED|ACCOUNT_|CANCELLED|ABORTED)/.test(raw)
            )
              throw error;
            frame.preparationError = {
              stage: "transcript",
              code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                ? raw
                : "MOTION_AUDIO_NOT_AVAILABLE",
            };
          }
        }
        if (
          frame.stages.split.audio_state === "audio_present" &&
          (!audio?.blob || audio.flowProjectId !== run.flowProjectId)
        )
          frame.preparationError = {
            stage: "transcript",
            code: "MOTION_AUDIO_NOT_AVAILABLE",
          };
      }
    }
    if (
      frames.some(
        (frame) =>
          !frame.preparationError &&
          needTranscript(frame) &&
          frame.stages?.split?.audio_state === "audio_present",
      )
    ) {
      const settings = run.transcriptSettings;
      if (
        !["chatgpt", "gemini"].includes(run.transcriptionProvider) ||
        settings?.transcription_provider !== run.transcriptionProvider ||
        (preferences.transcription_provider &&
          preferences.transcription_provider !== run.transcriptionProvider) ||
        settings.translate_enabled !==
          (preferences.translate_enabled === true) ||
        (settings.translate_enabled &&
          settings.target_language !== (preferences.target_language || null)) ||
        !Number.isSafeInteger(hostEpoch) ||
        hostEpoch < 1 ||
        !Number.isSafeInteger(flowTabId) ||
        flowTabId !== flowTarget.tabId
      )
        throw new Error("MOTION_AGENT_SETTINGS_UNPINNED");
    }
    const options = { owner, api, journal, assertScope, shouldStop };
    let cleanupAttempted = false;
    const reconcileWorkers = async () => {
      if (run.executionMode !== "parallel")
        return { success: true, pending: [] };
      cleanupAttempted = true;
      const limit = run.retryEnabled ? run.transcriptMaxRetries : 0;
      let result;
      for (let attempt = 0; attempt <= limit; attempt++) {
        try {
          result = await chrome.runtime.sendMessage({
            action: "motionWorker:reconcile",
            hostEpoch,
            toolProjectId: owner.toolProjectId,
            runId: owner.runId,
            ownerId: owner.ownerId,
            epoch: owner.epoch,
          });
          if (
            result?.success === true &&
            Array.isArray(result.pending) &&
            !result.pending.length
          )
            return result;
        } catch (error) {
          result = { error: error?.code || error?.message };
        }
        if (attempt < limit)
          await waitBeforeRetry({
            stage: "worker_reconcile",
            retryCount: attempt + 1,
          });
      }
      throw new Error(result?.error || "MOTION_WORKER_CLOSE_PENDING");
    };
    const fullAudioMembers = frames
      .filter(
        (f) =>
          !f.preparationError &&
          needTranscript(f) &&
          f.stages?.split?.audio_state === "audio_present",
      )
      .sort((a, b) => a.start - b.start)
      .map((f) => ({
        frameId: f.frameId,
        frameRunId: f.run_id,
        inputRevision: f.input_revision,
        start: f.start,
        end: f.end,
      }));
    const fullAudioAttempts = new Map();
    const transcribeFullAudio = (retryCount) => {
      if (!fullAudioAttempts.has(retryCount))
        fullAudioAttempts.set(
          retryCount,
          (async () => {
            const current2 = await fresh();
            const manifest = MotionFullAudioTranscript.manifest(current2);
            const timeline = manifest.frames.map((f) => ({
              frameId: f.frame_id,
              frameRunId: current2.data_json.frames[f.frame_id].run_id,
              inputRevision:
                current2.data_json.frames[f.frame_id].input_revision,
              start: f.start_seconds,
              end: f.end_seconds,
            }));
            const assertCurrent = async () => {
              const latest = await fresh();
              if (
                JSON.stringify(MotionFullAudioTranscript.manifest(latest)) !==
                  JSON.stringify(manifest) ||
                timeline.some(
                  (m) =>
                    latest.data_json.frames[m.frameId]?.run_id !==
                      m.frameRunId ||
                    latest.data_json.frames[m.frameId]?.input_revision !==
                      m.inputRevision,
                )
              )
                throw new Error("MOTION_FRAME_SCOPE_CHANGED");
            };
            await assertCurrent();
            const first = fullAudioMembers[0],
              state = await journal.get(owner);
            journal._owned(state, owner);
            const attempt = {
              ...owner,
              operationId: crypto.randomUUID(),
              workerId: crypto.randomUUID(),
              ...first,
              stage: "transcribe",
              fullAudioFrames: fullAudioMembers,
              fullAudioTimeline: timeline,
            };
            const reservationId =
              state.reservations?.[first.frameId]?.reservationId ||
              crypto.randomUUID();
            console.info(
              "[MotionFullAudioAttempt]",
              JSON.stringify({
                runId: owner.runId,
                attemptId: attempt.operationId,
                sourceRevision: run.sourceRevision,
                frameCount: fullAudioMembers.length,
                timelineFrameCount: timeline.length,
                retryCount,
              }),
            );
            const abort = new AbortController();
            const poll = setInterval(() => {
              if (shouldStop()) abort.abort();
            }, 200);
            try {
              return await MotionTranscriptWorkerDriver.run({
                ...options,
                attempt,
                reservationId,
                hostEpoch,
                flowTabId,
                accountTabId,
                frame: current2.data_json.frames[first.frameId],
                profile,
                preferences,
                model,
                deleteAfter,
                waitForSlot,
                waitBeforeRetry,
                screen,
                onStage,
                fullAudio: {
                  manifest,
                  members: fullAudioMembers,
                  assertCurrent,
                  audio: () =>
                    MotionFullAudioTranscript.audio({
                      scope: {
                        userId: owner.userId,
                        toolProjectId: owner.toolProjectId,
                        flowProjectId: run.flowProjectId,
                        sourceRevision: run.sourceRevision,
                      },
                      duration: manifest.duration_seconds,
                      assertScope: assertCurrent,
                      signal: abort.signal,
                    }),
                },
              });
            } finally {
              clearInterval(poll);
            }
          })(),
        );
      return fullAudioAttempts.get(retryCount);
    };
    let flowAdmissionTail = Promise.resolve();
    const outcome = await MotionProjectRunner.run({
      run,
      profile,
      frames,
      maxWorkers,
      getVideoMonitorLimit,
      shouldStop,
      waitBeforeRetry,
      onStage,
      reviewSubtitle:
        !transcriptOnly &&
        run.executionMode === "parallel" &&
        preferences.review_subtitle === true &&
        (preferences.voice_enabled === true ||
          preferences.subtitle_enabled === true) &&
        run.subtitleReview !== "accepted",
      needsTranscript: needTranscript,
      transcribe: async (frame, { retryCount = 0 } = {}) => {
        const current2 = await fresh(frame);
        const saved = current2.data_json.frames[frame.frameId];
        const audio = saved.stages?.split?.audio_state;
        if (["audio_track_absent", "silent_verified"].includes(audio))
          return MotionSilentTranscript.run({
            ...options,
            frameId: frame.frameId,
            retryable,
            force: transcriptOnly,
          });
        if (audio !== "audio_present")
          throw new Error("MOTION_AUDIO_STATE_INVALID");
        if (fullAudioEnabled) return transcribeFullAudio(retryCount);
        if (run.executionMode === "sequential") {
          return MotionSequentialTranscript.run({
            ...options,
            frameId: frame.frameId,
            profile,
            preferences,
            retryable,
            dispatch: async (payload) => {
              if (shouldStop())
                return {
                  success: false,
                  error: "MOTION_CANCELLED",
                  notDispatched: true,
                };
              const waitForEditorMs =
                await window.ExecutionConfig.getProviderStartupTimeoutMs(
                  run.transcriptionProvider,
                );
              if (shouldStop())
                return {
                  success: false,
                  error: "MOTION_CANCELLED",
                  notDispatched: true,
                };
              return chrome.runtime.sendMessage({
                action: "motionRunner:transcribe",
                ...payload,
                provider: run.transcriptionProvider,
                waitForEditorMs,
                toolProjectId: owner.toolProjectId,
                runId: owner.runId,
                ownerId: owner.ownerId,
                epoch: owner.epoch,
                hostEpoch,
                flowTabId,
                frameId: frame.frameId,
                model,
                deleteAfter,
              });
            },
            cleanup: (receipt, context) =>
              chrome.runtime.sendMessage({
                action: "motion:cleanupTranscript",
                receipt,
                operationId: context.operationId,
                frameId: frame.frameId,
                requestedAt: context.requestedAt,
              }),
          });
        }
        const state = await journal.get(owner);
        journal._owned(state, owner);
        const attempt = {
          ...owner,
          operationId: crypto.randomUUID(),
          workerId: crypto.randomUUID(),
          frameId: frame.frameId,
          frameRunId: frame.run_id,
          inputRevision: frame.input_revision,
          stage: "transcribe",
        };
        const reservationId =
          state.reservations?.[frame.frameId]?.reservationId ||
          crypto.randomUUID();
        return MotionTranscriptWorkerDriver.run({
          ...options,
          attempt,
          reservationId,
          hostEpoch,
          flowTabId,
          accountTabId,
          frame: saved,
          profile,
          preferences,
          model,
          deleteAfter,
          waitForSlot,
          waitBeforeRetry,
          screen,
          onStage,
        });
      },
      getUploadLimit:
        !transcriptOnly &&
        project.data_json.flow_run_mode === "api" &&
        run.continuityEnabled !== true
          ? () => MotionFlowUpload.getUploadConcurrency()
          : null,
      needsUpload: (frame) => !transcriptOnly && needsPreparation(frame),
      upload: async (frame) => {
        await fresh(frame);
        return MotionProjectUpload.run({
          ...options,
          frameId: frame.frameId,
          flowTarget,
          mode: project.data_json.flow_run_mode,
          maxSeconds: Number(profile.settings.max_split_clip_seconds),
          parallelApi:
            run.executionMode === "parallel" &&
            run.continuityEnabled !== true &&
            project.data_json.flow_run_mode === "api",
          maxRetries: run.retryEnabled ? run.transcriptMaxRetries : 0,
          waitBeforeRetry: () =>
            waitBeforeRetry({ frameId: frame.frameId, stage: "upload" }),
          onStage,
        });
      },
      needsFlow: (frame) => !transcriptOnly && !frame._motionComplete,
      generate: async (frame) => {
        const previousAdmission = flowAdmissionTail;
        let releaseAdmission;
        const currentAdmission = new Promise((resolve) => {
          releaseAdmission = resolve;
        });
        flowAdmissionTail = previousAdmission.then(() => currentAdmission);
        try {
          if (isForceStopped(frame.frameId))
            return { state: "failed", error: "MOTION_CANCELLED" };
          const current2 = await fresh(frame);
          if (
            current2.data_json.frames[frame.frameId]?.stages?.monitor?.state !==
            "ready"
          )
            await validateReferences(current2, profile);
          const saved = {
            ...current2.data_json.frames[frame.frameId],
            frameId: frame.frameId,
          };
          if (saved.stages?.monitor?.state === "ready") releaseAdmission();
          if (
            !["running", "ready", "needs_review"].includes(
              saved.stages?.submit?.state,
            ) &&
            saved.stages?.monitor?.state !== "ready"
          )
            await MotionArtifactStore.hydrateUploadReceipt({
              userId: owner.userId,
              project: current2,
              frameId: frame.frameId,
            });
          const source = await MotionArtifactStore.get({
            userId: owner.userId,
            toolProjectId: owner.toolProjectId,
            sourceRevision: run.sourceRevision,
            frameId: frame.frameId,
            kind: "source_clip",
          });
          const index = [...frames]
            .sort((a, b) => Number(a.start) - Number(b.start))
            .findIndex((item) => item.frameId === frame.frameId);
          return await MotionProjectFramePipeline.run({
            frame: saved,
            flowOptions: {
              ...options,
              frameId: frame.frameId,
              profileRevision: run.profileRevision,
              mode: project.data_json.flow_run_mode,
              flowTarget,
              queue,
              onStage,
              waitForAdmission: () => previousAdmission,
              onQueueAdmitted: (entry) => {
                if (!entry.completed) releaseAdmission();
                onQueueAdmitted(entry);
              },
              isForceStopped: () => isForceStopped(frame.frameId),
              buildRequest: async (currentProject) => {
                const voiceSlug =
                  preferences.voice_enabled === true
                    ? preferences.voice_slug
                    : null;
                const resolvedVoice = voiceSlug
                  ? await MotionFlowQueueRequest.resolveVoice(voiceSlug)
                  : null;
                const references = await this.correctReferences(
                  currentProject.data_json.references || {},
                  flowTarget,
                  MotionCharacterReferences.count(currentProject.data_json),
                );
                const uploadReceipt = await this.correctSourceReceipt(
                  source?.uploadReceipt,
                  flowTarget,
                );
                if (uploadReceipt !== source?.uploadReceipt) {
                  await assertScope();
                  journal._owned(await journal.get(owner), owner);
                  await MotionArtifactStore.setUploadReceipt({
                    userId: owner.userId,
                    toolProjectId: owner.toolProjectId,
                    sourceRevision: run.sourceRevision,
                    frameId: frame.frameId,
                    receipt: uploadReceipt,
                  });
                }
                const restoreGeneratedClip = async (parentFrameId) => {
                  const previousResolution =
                    currentProject.data_json.frames[parentFrameId]?.stages
                      ?.persist?.resolution;
                  const restored = await MotionProjectPersist.run({
                    ...options,
                    frameId: parentFrameId,
                    config: downloadConfig,
                    selectedResolution:
                      previousResolution || selectedResolution,
                    requireMediaIdentity: true,
                    retryDownloadOnFailure: true,
                    waitBeforeRetry,
                    onStage,
                  });
                  if (restored?.state === "paused")
                    throw new Error("MOTION_CANCELLED");
                  if (restored?.state !== "ready")
                    throw new Error(
                      restored?.error || "MOTION_FLOW_DOWNLOAD_FAILED",
                    );
                };
                const restoredProject =
                  preferences.continuity_enabled === true
                    ? await MotionContinuity.restorePreviousCheckpoint({
                        project: currentProject,
                        frameId: frame.frameId,
                        restoreGeneratedClip,
                        readProject: () => fresh(frame),
                        assertScope,
                        shouldStop,
                      })
                    : currentProject;
                const correctedProject = {
                  ...restoredProject,
                  data_json: { ...restoredProject.data_json, references },
                };
                const parent =
                  preferences.continuity_enabled === true
                    ? MotionContinuity.parent(correctedProject, frame.frameId)
                    : null;
                const binding = parent
                  ? MotionContinuity.identity(...parent)
                  : null;
                const continuityCallbacks =
                  preferences.continuity_enabled === true
                    ? MotionContinuity.callbacks({
                        api,
                        endpoint,
                        project: correctedProject,
                        frameId: frame.frameId,
                        assertScope,
                        maxRetries: run.retryEnabled
                          ? run.transcriptMaxRetries
                          : 0,
                        waitBeforeRetry,
                        onProgress: onStage,
                      })
                    : {};
                const continuity =
                  preferences.continuity_enabled === true
                    ? await MotionContinuity.prepare({
                        project: correctedProject,
                        profile,
                        frameId: frame.frameId,
                        restoreGeneratedClip,
                        userId: owner.userId,
                        target: flowTarget,
                        shouldStop,
                        maxRetries: run.retryEnabled
                          ? run.transcriptMaxRetries
                          : 0,
                        waitBeforeRetry,
                        ...continuityCallbacks,
                        assertScope: async () => {
                          const latest = await fresh(frame);
                          MotionContinuity.assertCurrent(
                            latest,
                            frame.frameId,
                            binding,
                          );
                        },
                      })
                    : null;
                return MotionFlowQueueRequest.build({
                  project: correctedProject,
                  profile,
                  frameId: frame.frameId,
                  uploadReceipt,
                  frameIndex: index + 1,
                  frameCount: frames.length,
                  resolvedVoice,
                  continuity,
                });
              },
            },
            persistOptions: {
              ...options,
              frameId: frame.frameId,
              config: downloadConfig,
              onStage,
              selectedResolution,
              retryDownloadOnFailure: true,
              waitBeforeRetry,
            },
          });
        } catch (error) {
          if (error?.apiDiagnostic?.phase === "continuity") {
            try {
              onStage({
                frameId: frame.frameId,
                stage: "continuity",
                error: error.code,
                apiDiagnostic: error.apiDiagnostic,
              });
            } catch (_) {}
          }
          if (error?.motionContinuityPauseConfirmed)
            return {
              state: "paused",
              pauseConfirmed: true,
              error: error.code || error.message,
            };
          throw error;
        } finally {
          releaseAdmission();
        }
      },
      finalize: async () => {
        const startedAt = Date.now();
        const finalStep = async (operation, action) => {
          const emit = (eventState, error = null) => {
            try {
              onStage({
                stage: "final",
                detail: eventState === "failed" ? "failed" : "running",
                error,
                apiDiagnostic: {
                  phase: "final",
                  operation,
                  eventState,
                  elapsedMs: Date.now() - startedAt,
                },
              });
            } catch (_) {}
          };
          emit("started");
          try {
            const result2 = await action();
            emit("returned");
            return result2;
          } catch (error) {
            emit(
              "failed",
              error?.code || error?.message || "MOTION_FINAL_UNVERIFIED",
            );
            throw error;
          }
        };
        const current2 = await finalStep("scope_read", () => fresh());
        try {
          await finalStep("worker_reconcile", () => reconcileWorkers());
        } catch (error) {
          return {
            state: "needs_review",
            error:
              error?.code || error?.message || "MOTION_WORKER_CLOSE_PENDING",
          };
        }
        if (transcriptOnly) {
          if (
            frames.length !== run.transcriptFrameIds.length ||
            frames.some((frame) => {
              const saved = current2.data_json.frames?.[frame.frameId];
              return (
                saved?.run_id !== frame.run_id ||
                saved?.input_revision !== frame.input_revision ||
                saved?.stages?.transcribe?.state !== "ready" ||
                !saved.transcript
              );
            })
          )
            throw new Error("MOTION_TRANSCRIPT_BATCH_UNVERIFIED");
          await journal.complete({
            ...owner,
            transcriptsVerified: true,
            sourceRevision: run.sourceRevision,
            transcriptFrameIds: run.transcriptFrameIds,
          });
          return { state: "ready", completedCount: frames.length };
        }
        const result = await MotionProjectFinalize.run({
          ...options,
          download,
          waitBeforeRetry,
          onStage,
          signal,
        });
        if (
          result?.computationFailed === true &&
          !shouldStop() &&
          !signal?.aborted
        ) {
          const saved = await fresh(),
            savedFrames = saved.data_json.frames || {};
          if (
            Object.keys(savedFrames).length !== frames.length ||
            frames.some((frame) => {
              const value = savedFrames[frame.frameId];
              return (
                value?.run_id !== frame.run_id ||
                value.input_revision !== frame.input_revision ||
                value.stages?.persist?.state !== "ready" ||
                !value.stages.persist.artifact_id
              );
            })
          )
            throw new Error("FRAMES_NOT_READY");
          for (const frame of frames) {
            const local = await MotionArtifactStore.get({
              userId: owner.userId,
              toolProjectId: owner.toolProjectId,
              sourceRevision: run.sourceRevision,
              frameId: frame.frameId,
              kind: "generated_clip",
              artifactRevision: frame.input_revision,
            });
            if (!local?.blob?.size || local.flowProjectId !== run.flowProjectId)
              throw new Error("MOTION_RESULT_LOCAL_MISSING");
          }
          const frameVersions = Object.fromEntries(
            frames.map((frame) => [
              frame.frameId,
              {
                run_id: frame.run_id,
                input_revision: frame.input_revision,
                artifact_id:
                  savedFrames[frame.frameId].stages.persist.artifact_id,
              },
            ]),
          );
          const mergeError = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(
            result.error || "",
          )
            ? result.error
            : "MOTION_FINAL_UNVERIFIED";
          if (shouldStop() || signal?.aborted) return { state: "paused" };
          let completion;
          try {
            completion = await finalStep("generation_complete", () =>
              api("POST", `${endpoint}/generation-complete`, {
                revision: saved.revision,
                source_revision: run.sourceRevision,
                frames: frameVersions,
                merge_error: mergeError,
              }),
            );
          } catch (error) {
            const latest = await fresh().catch(() => null);
            if (
              !journal.isGenerationComplete(latest?.data_json) ||
              !Object.keys(frameVersions).every((id) =>
                ["run_id", "input_revision", "artifact_id"].every(
                  (key) =>
                    latest.data_json.generation_completion.frames[id]?.[key] ===
                    frameVersions[id][key],
                ),
              )
            )
              throw error;
            completion = latest;
          }
          if (!journal.isGenerationComplete(completion?.data_json))
            throw new Error("MOTION_FINAL_UNVERIFIED");
          await finalStep("journal_complete", () =>
            journal.complete({
              ...owner,
              framesVerified: true,
              sourceRevision: run.sourceRevision,
              project: completion,
            }),
          );
          return { state: "ready", mergeError, generationOnly: true };
        }
        if (result?.state === "ready")
          await finalStep("journal_complete", () =>
            journal.complete({
              ...owner,
              finalVerified: true,
              sourceRevision: run.sourceRevision,
              finalArtifactId: result.artifactId,
            }),
          );
        return result;
      },
    });
    const closeFailures =
      outcome?.stage === "preparation" && Array.isArray(outcome.items)
        ? outcome.items.filter(
            (item) => item.transcript === "failed" && item.workerClosePending,
          )
        : [];
    if (closeFailures.length && !shouldStop()) {
      try {
        await reconcileWorkers();
      } catch (error) {
        return {
          ...outcome,
          workerClosePending: true,
          cleanupError:
            error?.code || error?.message || "MOTION_WORKER_CLOSE_PENDING",
        };
      }
      if (shouldStop()) return { ...outcome, state: "paused" };
      const otherFailure2 = outcome.items.some(
        (item) =>
          ["failed", "needs_review", "sync_pending"].includes(item.upload) ||
          (["failed", "sync_pending"].includes(item.transcript) &&
            !item.workerClosePending),
      );
      if (
        !otherFailure2 &&
        run.retryEnabled &&
        closeFailures.every(
          (item) =>
            !item.workerFailureTerminal &&
            (_closeRetries[item.frameId] || 0) < run.transcriptMaxRetries,
        )
      ) {
        for (const item of closeFailures) {
          const retryCount = (_closeRetries[item.frameId] || 0) + 1;
          _closeRetries[item.frameId] = retryCount;
          await waitBeforeRetry({
            frameId: item.frameId,
            retryCount,
            stage: "transcript",
          });
        }
        if (shouldStop()) return { ...outcome, state: "paused" };
        if (!shouldStop()) {
          const current2 = await fresh();
          return this.run({
            owner,
            project: current2,
            profile,
            flowTarget,
            api,
            journal,
            maxWorkers,
            getVideoMonitorLimit,
            shouldStop,
            waitBeforeRetry,
            waitForSlot,
            assertScope,
            retryable,
            validateReferences,
            queue,
            downloadConfig,
            download,
            hostEpoch,
            flowTabId,
            accountTabId,
            screen,
            model,
            deleteAfter,
            onStage,
            signal,
            _storageRetries,
            _closeRetries,
            transcriptOnly,
          });
        }
      }
    }
    const reviewOutcome = async () => {
      if (!outcome.subtitleReview) return outcome;
      await assertScope();
      await journal.setSubtitleReview(owner, "waiting");
      const failedCount = outcome.items.filter(
        (item) =>
          !["ready", "skipped"].includes(item.transcript) ||
          !["ready", "skipped"].includes(item.upload),
      ).length;
      console.info("[MotionSubtitleReview]", {
        runId: owner.runId,
        stage: "waiting",
        sourceRevision: run.sourceRevision,
        totalCount: outcome.items.length,
        failedCount,
      });
      return {
        ...outcome,
        pauseReason: "subtitle_review",
        reviewFailed: failedCount > 0,
      };
    };
    const recoveryItems =
      outcome?.stage === "preparation" && Array.isArray(outcome.items)
        ? outcome.items.filter(
            (item) =>
              typeof item.transcriptRecovery?.retryPersistence === "function",
          )
        : [];
    if (!recoveryItems.length) {
      const pendingSync =
        outcome?.stage === "preparation" && Array.isArray(outcome.items)
          ? outcome.items.filter((item) => item.transcript === "sync_pending")
          : [];
      const otherFailure2 = outcome?.items?.some?.(
        (item) =>
          ["failed", "needs_review"].includes(item.upload) ||
          item.transcript === "failed",
      );
      if (pendingSync.length && !otherFailure2 && !shouldStop()) {
        const limit = run.retryEnabled ? run.transcriptMaxRetries : 0;
        for (let retry = 0; retry <= limit && !shouldStop(); retry++) {
          if (retry)
            await waitBeforeRetry({
              frameId: pendingSync[0].frameId,
              retryCount: retry,
              stage: "transcript_sync",
            });
          const reconciled = await MotionProjectRecovery.run({
            owner,
            journal,
            api,
            assertScope,
            flowTarget,
            mode: project.data_json.flow_run_mode,
            maxSeconds: Number(profile.settings.max_split_clip_seconds),
            shouldStop,
            waitBeforeRetry,
            downloadConfig,
            selectedResolution,
            download,
            hostEpoch,
            onStage,
            signal,
          });
          if (!reconciled?.ready) continue;
          let current2 = null;
          let complete = true;
          for (const item of pendingSync) {
            const original = frames.find(
              (frame) => frame.frameId === item.frameId,
            );
            current2 = original ? await fresh(original) : null;
            const saved = current2?.data_json?.frames?.[item.frameId];
            if (item.pendingFailedAttempt) {
              if (
                saved?.stages?.transcribe?.state !== "failed" ||
                saved.stages.transcribe.retry_exhausted === true ||
                !run.retryEnabled ||
                !needTranscript({ ...saved, frameId: item.frameId })
              )
                complete = false;
            } else if (
              saved?.stages?.transcribe?.state !== "ready" ||
              typeof saved.transcript?.has_speech !== "boolean" ||
              needTranscript({ ...saved, frameId: item.frameId })
            )
              complete = false;
          }
          if (!complete || !current2 || shouldStop()) break;
          return this.run({
            owner,
            project: current2,
            profile,
            flowTarget,
            api,
            journal,
            maxWorkers,
            getVideoMonitorLimit,
            shouldStop,
            waitBeforeRetry,
            waitForSlot,
            assertScope,
            retryable,
            validateReferences,
            queue,
            downloadConfig,
            download,
            hostEpoch,
            flowTabId,
            accountTabId,
            screen,
            model,
            deleteAfter,
            onStage,
            signal,
            _storageRetries,
            _closeRetries,
            transcriptOnly,
          });
        }
      }
      if (outcome?.state !== "ready" && !cleanupAttempted) {
        try {
          await reconcileWorkers();
        } catch (error) {
          return {
            ...outcome,
            workerClosePending: true,
            cleanupError:
              error?.code || error?.message || "MOTION_WORKER_CLOSE_PENDING",
          };
        }
      }
      if (shouldStop()) return { ...outcome, state: "paused" };
      return reviewOutcome();
    }
    let recoveredAll = true;
    for (const item of recoveryItems) {
      let recovered = null;
      const limit = run.retryEnabled ? run.transcriptMaxRetries : 0;
      while ((_storageRetries[item.frameId] || 0) < limit && !recovered) {
        const retryCount = (_storageRetries[item.frameId] || 0) + 1;
        _storageRetries[item.frameId] = retryCount;
        try {
          try {
            onStage({
              frameId: item.frameId,
              stage: "transcript_save",
              state: "retrying",
            });
          } catch (_) {}
          await waitBeforeRetry({
            frameId: item.frameId,
            retryCount,
            stage: "transcript_save",
          });
          recovered = await item.transcriptRecovery.retryPersistence();
        } catch (_) {}
      }
      if (
        recovered?.state !== "ready" ||
        recovered.synced !== true ||
        recovered.settlementPending ||
        recovered.closePending
      ) {
        recoveredAll = false;
        continue;
      }
      const original = frames.find((frame) => frame.frameId === item.frameId);
      const current2 = original ? await fresh(original) : null;
      const saved = current2?.data_json?.frames?.[item.frameId];
      if (
        saved?.stages?.transcribe?.state !== "ready" ||
        typeof saved.transcript?.has_speech !== "boolean"
      )
        recoveredAll = false;
    }
    const otherFailure = outcome.items.some(
      (item) =>
        ["failed", "needs_review", "sync_pending"].includes(item.upload) ||
        (["failed", "sync_pending"].includes(item.transcript) &&
          !item.transcriptRecovery),
    );
    if (!recoveredAll || otherFailure || shouldStop()) {
      if (!cleanupAttempted) {
        try {
          await reconcileWorkers();
        } catch (error) {
          return {
            ...outcome,
            workerClosePending: true,
            cleanupError:
              error?.code || error?.message || "MOTION_WORKER_CLOSE_PENDING",
          };
        }
      }
      return shouldStop() ? { ...outcome, state: "paused" } : reviewOutcome();
    }
    const current = await fresh();
    return this.run({
      owner,
      project: current,
      profile,
      flowTarget,
      api,
      journal,
      maxWorkers,
      getVideoMonitorLimit,
      shouldStop,
      waitBeforeRetry,
      waitForSlot,
      assertScope,
      retryable,
      validateReferences,
      queue,
      downloadConfig,
      download,
      hostEpoch,
      flowTabId,
      accountTabId,
      screen,
      model,
      deleteAfter,
      onStage,
      onQueueAdmitted,
      isForceStopped,
      signal,
      _storageRetries,
      _closeRetries,
      transcriptOnly,
    });
  }
}
globalThis.MotionProjectExecution = MotionProjectExecution;
