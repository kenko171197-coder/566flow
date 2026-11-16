class MotionProjectSplit {
  static async run({
    userId,
    toolProjectId,
    flowTarget,
    profile,
    api,
    assertScope,
    shouldStop,
    retryEnabled,
    maxRetries,
    waitBeforeRetry,
    preparationSnapshot = null,
    onProgress = () => {},
  }) {
    if (
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      !toolProjectId ||
      !flowTarget?.projectId ||
      !profile ||
      typeof retryEnabled !== "boolean" ||
      !Number.isSafeInteger(maxRetries) ||
      maxRetries < 0 ||
      [api, assertScope, shouldStop, waitBeforeRetry, onProgress].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_SPLIT_CONFIG_INVALID");
    if (!Number.isSafeInteger(profile.revision) || profile.revision < 1)
      throw new Error("INVALID_SPLIT_PROFILE");
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    return navigator.locks.request(
      `motion-run:${userId}:${toolProjectId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return { state: "busy", error: "PROJECT_ALREADY_RUNNING" };
        const endpoint = `tools/motion-studio/projects/${encodeURIComponent(toolProjectId)}`;
        const read = async () => {
          await assertScope();
          const project2 = await api("GET", endpoint);
          await assertScope();
          const target = await MessageBridge.getTargetContext(flowTarget);
          if (
            project2?.tool_project_id !== toolProjectId ||
            project2.flow_project_id !== flowTarget.projectId ||
            !target ||
            ["tabId", "projectId", "driverKey", "origin"].some(
              (key) => target[key] !== flowTarget[key],
            )
          )
            throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
          return project2;
        };
        let project = await read();
        const maxSeconds = window.MotionSplitPolicy.limit(project, profile);
        if (![0, 1].includes(Number(project.data_json?.source_revision || 0)))
          throw new Error("MOTION_SPLIT_SCOPE_INVALID");
        const records = (
          await MotionArtifactStore.listProject(userId, toolProjectId)
        ).filter(
          (item) => item.kind === "split_journal" && item.sourceRevision === 1,
        );
        if (records.length > 1)
          throw new Error("MOTION_SPLIT_RECONCILE_REQUIRED");
        let record = records[0] || null,
          draft = await MotionArtifactStore.getSourceDraft(
            userId,
            toolProjectId,
          );
        const serverOp = project.data_json?.split_operation;
        if (!record && Number(project.data_json?.source_revision || 0) !== 0)
          throw new Error("MOTION_SPLIT_RECONCILE_REQUIRED");
        const serverDraft = project.data_json?.source_draft;
        if (
          !record &&
          (!draft?.blob ||
            draft.toolProjectId !== toolProjectId ||
            draft.flowProjectId !== flowTarget.projectId ||
            draft.baseSourceRevision !== 0 ||
            (serverDraft &&
              ((draft.bulkCreateId && draft.itemId !== serverDraft.draft_id) ||
                draft.size !== serverDraft.size ||
                draft.fileName !== serverDraft.file_name ||
                (draft.mime || "application/octet-stream") !==
                  serverDraft.mime)))
        )
          throw new Error("MOTION_BULK_SOURCE_MISMATCH");
        const includeAudio =
          record?.includeAudio ??
          (serverOp?.state === "running" ? serverOp.include_audio : true);
        const cutStrategy = record
          ? record.cutStrategy || "silence"
          : serverOp?.state === "running"
            ? serverOp.cut_strategy || "silence"
            : window.MotionSplitPolicy.desired(project.data_json?.preferences);
        if (!record && (shouldStop() || project.data_json?.paused))
          return { state: "paused" };
        const operationId =
          record?.operationId || serverOp?.operation_id || crypto.randomUUID();
        const draftId =
          record?.draftId ||
          serverOp?.draft_id ||
          serverDraft?.draft_id ||
          draft?.itemId ||
          crypto.randomUUID();
        const scope = {
          userId,
          toolProjectId,
          flowProjectId: flowTarget.projectId,
          sourceRevision: 1,
        };
        const split = {
          ...scope,
          operationId,
          draftId,
          draftKey: record?.draftKey || draft?.key,
          ...(preparationSnapshot && { preparationSnapshot }),
          ...(profile.profile_key && { profileKey: profile.profile_key }),
          ...(profile.prompt_variant && {
            profilePromptVariant: profile.prompt_variant,
          }),
          profileRevision: record?.profileRevision ?? profile.revision,
          maxSeconds: record?.maxSeconds ?? maxSeconds,
          includeAudio: record?.includeAudio ?? includeAudio,
          cutStrategy,
        };
        if (
          split.profileRevision !== profile.revision ||
          (record?.profileKey && record.profileKey !== profile.profile_key) ||
          (record &&
            (record.profilePromptVariant || "legacy") !==
              (profile.prompt_variant || "legacy")) ||
          (record?.preparationSnapshot &&
            JSON.stringify(record.preparationSnapshot) !==
              JSON.stringify(preparationSnapshot)) ||
          split.maxSeconds !== maxSeconds ||
          split.includeAudio !== includeAudio ||
          (serverOp?.state === "running" &&
            (serverOp.operation_id !== operationId ||
              serverOp.include_audio !== includeAudio ||
              (serverOp.cut_strategy || "silence") !== cutStrategy))
        )
          throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
        if (!record || (preparationSnapshot && !record.preparationSnapshot)) {
          await assertScope();
          await MotionArtifactStore.beginSplitJournal(split);
          record = await MotionArtifactStore.getSplitJournal(split);
        }
        if (
          !draftId ||
          !record ||
          record.draftKey !== split.draftKey ||
          record.draftId !== draftId ||
          (serverOp?.draft_id && serverOp.draft_id !== draftId)
        )
          throw new Error("MOTION_SPLIT_RECONCILE_REQUIRED");
        if (Number(project.data_json?.source_revision || 0) === 0)
          draft = await MotionArtifactStore.getSourceDraft(
            userId,
            toolProjectId,
          );
        const operation = async (state, errorCode = null) => {
          project = await read();
          const existing = project.data_json?.split_operation;
          if (
            existing?.operation_id === operationId &&
            existing.draft_id === draftId &&
            existing.state === state &&
            (state !== "failed" || existing.error_code === errorCode)
          )
            return project;
          try {
            return await api("POST", `${endpoint}/split-attempt`, {
              revision: project.revision,
              operation_id: operationId,
              draft_id: draftId,
              state,
              ...(state === "running"
                ? { include_audio: includeAudio, cut_strategy: cutStrategy }
                : {}),
              ...(state === "failed" ? { error_code: errorCode } : {}),
              request_nonce: crypto.randomUUID(),
            });
          } catch (error) {
            const current = await read().catch(() => null);
            const saved = current?.data_json?.split_operation;
            if (
              saved?.operation_id === operationId &&
              saved.draft_id === draftId &&
              saved.state === state &&
              (state !== "failed" || saved.error_code === errorCode)
            )
              return current;
            throw error;
          }
        };
        const verifyArtifacts = async (plan) => {
          for (let index = 0; index < plan.count; index++) {
            const frameId = `f${String(index + 1).padStart(4, "0")}`;
            const clip = await MotionArtifactStore.get({
              ...scope,
              frameId,
              kind: "source_clip",
            });
            if (
              !clip?.blob ||
              clip.flowProjectId !== scope.flowProjectId ||
              clip.blob.type !== "video/mp4"
            )
              throw new Error("MOTION_SPLIT_CLIP_MISSING");
            if (plan.audioState === "audio_present") {
              const audio = await MotionArtifactStore.get({
                ...scope,
                frameId,
                kind: "source_audio",
              });
              if (
                !audio?.blob ||
                audio.flowProjectId !== scope.flowProjectId ||
                audio.blob.type !== "audio/wav"
              )
                throw new Error("MOTION_SPLIT_AUDIO_MISSING");
            }
          }
        };
        try {
          if (Number(project.data_json.source_revision || 0) === 0) {
            if (
              !draft?.blob ||
              draft.key !== split.draftKey ||
              draft.flowProjectId !== flowTarget.projectId ||
              draft.baseSourceRevision !== 0
            )
              throw new Error("MOTION_SOURCE_DRAFT_CHANGED");
            if (
              serverOp?.state !== "running" &&
              (shouldStop() || project.data_json?.paused)
            )
              return { state: "paused" };
            const savedDraft = project.data_json?.source_draft;
            if (
              savedDraft &&
              (savedDraft.draft_id !== draftId ||
                (draft.bulkCreateId && draft.itemId !== draftId) ||
                savedDraft.file_name !== draft.fileName ||
                savedDraft.size !== draft.size ||
                savedDraft.mime !== (draft.mime || "application/octet-stream"))
            )
              throw new Error("MOTION_SOURCE_DRAFT_CHANGED");
            if (!project.data_json?.source_draft) {
              try {
                await assertScope();
                project = await api("PUT", `${endpoint}/source-draft`, {
                  revision: project.revision,
                  draft_id: draftId,
                  file_name: draft.fileName,
                  mime: draft.mime || "application/octet-stream",
                  size: draft.size,
                  duration: null,
                  request_nonce: crypto.randomUUID(),
                });
              } catch (error) {
                const current = await read().catch(() => null);
                const saved = current?.data_json?.source_draft;
                if (
                  saved?.draft_id !== draftId ||
                  saved.file_name !== draft.fileName ||
                  saved.size !== draft.size ||
                  saved.mime !== (draft.mime || "application/octet-stream")
                )
                  throw error;
                project = current;
              }
            }
            if (project.data_json?.source_draft?.draft_id !== draftId)
              throw new Error("MOTION_SOURCE_DRAFT_CHANGED");
            if (serverOp?.state !== "running") {
              if (shouldStop() || project.data_json?.paused)
                return { state: "paused" };
              project = await operation("running");
            }
            await assertScope();
            await MotionArtifactStore.linkBulkDraftToSource({
              ...scope,
              draftKey: split.draftKey,
            });
            record = await MotionArtifactStore.getSplitJournal(split);
            let plan = record?.plan;
            if (!plan || record.completed.length !== plan.count) {
              const local =
                draft ||
                (await MotionArtifactStore.getSourceDraft(
                  userId,
                  toolProjectId,
                ));
              if (!local?.blob || local.key !== split.draftKey)
                throw new Error("MOTION_BULK_SOURCE_MISMATCH");
              let attempts = 0;
              for (;;) {
                try {
                  const result = await MotionSplitWorkerTask.run({
                    scope,
                    blob: local.blob,
                    maxSeconds,
                    includeAudio,
                    cutStrategy,
                    runId: operationId,
                    assertScope,
                    shouldStop,
                    onProgress,
                    onPlan: (value) =>
                      MotionArtifactStore.saveSplitPlan({
                        ...split,
                        plan: value,
                      }),
                    onFrame: (value) =>
                      MotionArtifactStore.markSplitFrame({
                        ...split,
                        index: value.index,
                      }),
                  });
                  plan = result.plan;
                  break;
                } catch (error) {
                  if (!retryEnabled || attempts >= maxRetries || shouldStop())
                    throw error;
                  attempts++;
                  await waitBeforeRetry({
                    stage: "split",
                    retryCount: attempts,
                  });
                  await read();
                }
              }
            }
            record = await MotionArtifactStore.getSplitJournal(split);
            if (!plan || !record || record.completed.length !== plan.count)
              throw new Error("MOTION_SPLIT_RECONCILE_REQUIRED");
            await verifyArtifacts(plan);
            project = await read();
            if (shouldStop() || project.data_json?.paused)
              throw new Error("MOTION_SPLIT_PAUSED");
            const sourceDraft = project.data_json?.source_draft;
            if (
              Number(project.data_json?.source_revision || 0) !== 0 ||
              sourceDraft?.draft_id !== draftId ||
              project.data_json?.split_operation?.operation_id !== operationId
            )
              throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
            const frames = Array.from({ length: plan.count }, (_, index) => ({
              frame_id: `f${String(index + 1).padStart(4, "0")}`,
              run_id: operationId,
              input_revision: 1,
              start: plan.boundaries[index],
              end: plan.boundaries[index + 1],
            }));
            const source = {
              artifact_id: "source_1",
              file_name: sourceDraft.file_name,
              mime: sourceDraft.mime,
              size: sourceDraft.size,
              duration: plan.duration,
              split_strategy: cutStrategy,
              split_limit_seconds: maxSeconds,
              ...(Number.isSafeInteger(plan.quietCuts) && {
                split_quiet_cuts: plan.quietCuts,
                split_time_cuts: plan.timeCuts,
              }),
            };
            try {
              project = await api("PUT", `${endpoint}/source`, {
                revision: project.revision,
                source_revision: 1,
                split_operation_id: operationId,
                source,
                frames,
                request_nonce: crypto.randomUUID(),
              });
            } catch (error) {
              const current = await read().catch(() => null);
              if (
                Number(current?.data_json?.source_revision) !== 1 ||
                current.data_json?.split_operation?.operation_id !==
                  operationId ||
                Object.entries(source).some(([key, value]) =>
                  key === "duration" || key === "size"
                    ? Number(current.data_json?.source?.[key]) !== Number(value)
                    : current.data_json?.source?.[key] !== value,
                ) ||
                Object.keys(current.data_json?.frames || {}).length !==
                  frames.length ||
                frames.some((frame) => {
                  const saved = current.data_json?.frames?.[frame.frame_id];
                  return (
                    saved?.run_id !== operationId ||
                    saved.input_revision !== 1 ||
                    Number(saved.start) !== frame.start ||
                    Number(saved.end) !== frame.end
                  );
                })
              )
                throw error;
              project = current;
            }
          }
          record = await MotionArtifactStore.getSplitJournal(split);
          if (!record?.plan || record.completed.length !== record.plan.count)
            throw new Error("MOTION_SPLIT_RECONCILE_REQUIRED");
          await verifyArtifacts(record.plan);
          await assertScope();
          await MotionArtifactStore.commitBulkSource({
            ...scope,
            draftKey: split.draftKey,
          });
          for (let index = 0; index < record.plan.count; index++) {
            const frameId = `f${String(index + 1).padStart(4, "0")}`;
            project = await read();
            const frame = project.data_json?.frames?.[frameId];
            if (frame?.run_id !== operationId || frame.input_revision !== 1)
              throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
            const saved = frame.stages?.split;
            const body = {
              source_revision: 1,
              run_id: operationId,
              input_revision: 1,
              stage: "split",
              state: "ready",
              artifact_id: `clip_1_${frameId}`,
              audio_state: record.plan.audioState,
              audio_artifact_id:
                record.plan.audioState === "audio_present"
                  ? `audio_1_${frameId}`
                  : null,
              request_nonce: crypto.randomUUID(),
            };
            const matches = (stage) =>
              stage?.state === "ready" &&
              stage.artifact_id === body.artifact_id &&
              stage.audio_state === body.audio_state &&
              (stage.audio_artifact_id ?? null) === body.audio_artifact_id;
            if (matches(saved)) continue;
            try {
              await api(
                "PATCH",
                `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
                body,
              );
            } catch (error) {
              const current = await read().catch(() => null);
              const savedFrame = current?.data_json?.frames?.[frameId];
              if (
                savedFrame?.run_id !== operationId ||
                !matches(savedFrame.stages?.split)
              )
                throw error;
            }
          }
          if (
            (((preparationSnapshot?.executionMode ??
              profile.settings.execution_mode) === "parallel" &&
              profile.settings.full_audio_transcription === true) ||
              project.data_json?.preferences?.use_original_audio === true) &&
            record.plan.audioState === "audio_present"
          )
            await MotionFullAudioTranscript.audio({
              scope,
              duration: record.plan.duration,
              shouldStop,
              assertScope: async () => {
                await assertScope();
                const current = await read();
                if (
                  Number(current.data_json.source_revision) !==
                    scope.sourceRevision ||
                  current.data_json.split_operation?.operation_id !==
                    operationId
                )
                  throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
              },
            });
          await operation("complete");
          await MotionArtifactStore.markSplitCommitted(split);
          if (!preparationSnapshot)
            await MotionArtifactStore.clearCommittedSplitJournal(split);
          return { state: "ready", project: await read() };
        } catch (error) {
          const latest = await read().catch(() => null);
          if (
            Number(latest?.data_json?.source_revision) === 0 &&
            latest?.data_json?.split_operation?.operation_id === operationId
          ) {
            const raw = String(
              error?.code || error?.message || "MOTION_SPLIT_FAILED",
            );
            const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
              ? raw
              : "MOTION_SPLIT_FAILED";
            try {
              await operation("failed", code);
            } catch (_) {
              return {
                state: "needs_review",
                error: "MOTION_SPLIT_RECONCILE_REQUIRED",
              };
            }
            return {
              state:
                shouldStop() || latest.data_json?.paused ? "paused" : "failed",
              error: code,
            };
          }
          return {
            state: "needs_review",
            error:
              error?.code ||
              error?.message ||
              "MOTION_SPLIT_RECONCILE_REQUIRED",
          };
        }
      },
    );
  }
}
globalThis.MotionProjectSplit = MotionProjectSplit;
