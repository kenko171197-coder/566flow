class MotionProjectFinalize {
  static mergeClips(clips, options = {}) {
    if (!globalThis.MotionMergeTask?.start)
      throw new Error("MOTION_MERGE_UNAVAILABLE");
    return MotionMergeTask.start(clips, () => {}, options).promise;
  }
  static measureVideoDuration(blob, options = {}) {
    if (!globalThis.MotionMergeTask?.measureDuration)
      throw new Error("MOTION_MERGE_UNAVAILABLE");
    return MotionMergeTask.measureDuration(blob, options);
  }
  static async run({
    owner,
    journal,
    api,
    assertScope,
    shouldStop,
    merge = this.mergeClips,
    measureDuration = this.measureVideoDuration,
    download,
    waitBeforeRetry = null,
    onStage = () => {},
    signal = null,
  }) {
    if (
      !owner ||
      !journal ||
      [api, assertScope, shouldStop, merge, measureDuration, download].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_FINAL_CONFIG_INVALID");
    const startedAt = Date.now();
    const step = async (operation, action) => {
      const emit = (eventState, error = null) => {
        const diagnostic = {
          phase: "final",
          operation,
          eventState,
          elapsedMs: Date.now() - startedAt,
        };
        console.info(
          "[MotionFinalize]",
          JSON.stringify({ runId: owner.runId, ...diagnostic, error }),
        );
        try {
          onStage({
            stage: "final",
            detail: eventState === "failed" ? "failed" : "running",
            error,
            apiDiagnostic: diagnostic,
          });
        } catch (_) {}
      };
      emit("started");
      try {
        const result = await action();
        emit("returned");
        return result;
      } catch (error) {
        const raw = String(
          error?.code || error?.message || "MOTION_FINAL_UNVERIFIED",
        );
        emit(
          "failed",
          /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
            ? raw
            : "MOTION_FINAL_UNVERIFIED",
        );
        throw error;
      }
    };
    await assertScope();
    const run = await journal.get(owner);
    if (
      !run ||
      run.runId !== owner.runId ||
      !["running", "needs_review", "pausing", "stopping"].includes(run.state)
    )
      throw new Error("MOTION_FINAL_SCOPE_INVALID");
    if (typeof run.autoDownloadFinal !== "boolean")
      throw new Error("MOTION_FINAL_SETTINGS_UNPINNED");
    journal._owned(run, owner);
    const useOriginalAudio = run.useOriginalAudio === true;
    const endpoint = `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`;
    const fresh = async () => {
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      const project2 = await api("GET", endpoint);
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      if (
        project2?.tool_project_id !== owner.toolProjectId ||
        project2.flow_project_id !== run.flowProjectId ||
        Number(project2.data_json?.source_revision) !== run.sourceRevision ||
        project2.data_json?.requires_resplit ||
        (project2.data_json?.preferences?.use_original_audio === true) !==
          useOriginalAudio
      )
        throw new Error("MOTION_FINAL_SCOPE_CHANGED");
      return project2;
    };
    const downloadScope = (artifactId2, artifactRevision2) => ({
      userId: owner.userId,
      toolProjectId: owner.toolProjectId,
      flowProjectId: run.flowProjectId,
      sourceRevision: run.sourceRevision,
      artifactRevision: artifactRevision2,
      artifactId: artifactId2,
      maxAttempts:
        1 +
        (run.retryEnabled === true &&
        Number.isSafeInteger(run.transcriptMaxRetries)
          ? run.transcriptMaxRetries
          : 0),
    });
    const downloadFinal = async (
      artifactId2,
      artifactRevision2,
      blob,
      drain = false,
    ) => {
      if (!run.autoDownloadFinal) return null;
      const scope2 = downloadScope(artifactId2, artifactRevision2);
      const local = await MotionArtifactStore.get({
        ...scope2,
        kind: "merged_video",
      });
      let checkpoint = local?.finalDownload;
      if (!checkpoint && drain)
        throw new Error("MOTION_DOWNLOAD_CHECKPOINT_MISSING");
      if (!checkpoint || checkpoint.state === "ready") return null;
      if (
        !local?.blob ||
        local.flowProjectId !== run.flowProjectId ||
        checkpoint.artifactId !== artifactId2
      )
        throw new Error("MOTION_DOWNLOAD_SCOPE_CHANGED");
      let errorCode =
        checkpoint.errorCode || "MOTION_FINAL_DOWNLOAD_RETRY_EXHAUSTED";
      if (
        checkpoint.state === "running" &&
        checkpoint.attempts >= checkpoint.maxAttempts
      ) {
        errorCode = "MOTION_FINAL_DOWNLOAD_UNVERIFIED";
        await MotionArtifactStore.checkpointFinalDownload({
          ...scope2,
          state: "failed",
          expectedAttempts: checkpoint.attempts,
          errorCode,
        });
      }
      while (checkpoint.attempts < checkpoint.maxAttempts) {
        if (shouldStop() && !drain)
          return checkpoint.errorCode || "MOTION_FINAL_DOWNLOAD_PAUSED";
        const latest = await fresh();
        if (
          latest.data_json?.final?.artifact_id !== artifactId2 ||
          latest.data_json.final.artifact_revision !== artifactRevision2
        )
          throw new Error("MOTION_DOWNLOAD_SCOPE_CHANGED");
        checkpoint = await MotionArtifactStore.checkpointFinalDownload({
          ...scope2,
          state: "running",
          expectedAttempts: checkpoint.attempts,
        });
        let failed = null;
        try {
          await download(blob || local.blob);
        } catch (error) {
          const raw = String(
            error?.code || error?.message || "MOTION_FINAL_DOWNLOAD_FAILED",
          );
          failed = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
            ? raw
            : "MOTION_FINAL_DOWNLOAD_FAILED";
        }
        await assertScope();
        journal._owned(await journal.get(owner), owner);
        const acknowledged = await fresh();
        if (
          acknowledged.data_json?.final?.artifact_id !== artifactId2 ||
          acknowledged.data_json.final.artifact_revision !== artifactRevision2
        )
          throw new Error("MOTION_DOWNLOAD_SCOPE_CHANGED");
        checkpoint = await MotionArtifactStore.checkpointFinalDownload({
          ...scope2,
          state: failed ? "failed" : "ready",
          expectedAttempts: checkpoint.attempts,
          errorCode: failed,
        });
        if (!failed) return null;
        errorCode = failed;
        drain = false;
        if (checkpoint.attempts < checkpoint.maxAttempts && !shouldStop()) {
          if (typeof waitBeforeRetry !== "function") return errorCode;
          await waitBeforeRetry({
            stage: "final_download",
            retryCount: checkpoint.attempts,
          });
        }
      }
      return errorCode;
    };
    let project = await step("project_read", () => fresh());
    const entries = Object.entries(project.data_json?.frames || {}).sort(
      (a, b) => Number(a[1].start) - Number(b[1].start),
    );
    if (
      !entries.length ||
      entries.some(([, frame]) => frame.stages?.persist?.state !== "ready")
    )
      throw new Error("FRAMES_NOT_READY");
    const lineage = entries.map(([frameId, frame]) => ({
      frameId,
      runId: frame.run_id,
      inputRevision: frame.input_revision,
    }));
    const matchingLineage = (value) =>
      Array.isArray(value) &&
      value.length === lineage.length &&
      lineage.every((item, index) =>
        ["frameId", "runId", "inputRevision"].every(
          (key) => value[index]?.[key] === item[key],
        ),
      );
    const matches = Object.entries(run.operations || {}).filter(
      ([, item]) => item.stage === "merge",
    );
    if (
      matches.length > 1 ||
      matches.some(
        ([, item]) =>
          item.frameId !== "project" ||
          item.frameRunId !== run.runId ||
          item.inputRevision !== run.sourceRevision ||
          !Number.isSafeInteger(item.artifactRevision),
      )
    )
      return {
        state: "needs_review",
        error: "MOTION_MERGE_OPERATION_MISMATCH",
      };
    const currentFinal = project.data_json?.final;
    if (
      !matches.length &&
      (currentFinal?.use_original_audio === true) === useOriginalAudio &&
      currentFinal?.stale !== true &&
      currentFinal?.source_revision === run.sourceRevision &&
      Number.isSafeInteger(currentFinal.artifact_revision) &&
      currentFinal.artifact_revision > 0 &&
      typeof currentFinal.artifact_id === "string" &&
      currentFinal.artifact_id.length > 0 &&
      Number.isFinite(currentFinal.duration) &&
      currentFinal.duration > 0 &&
      Array.isArray(currentFinal.frame_ids) &&
      currentFinal.frame_ids.length === lineage.length &&
      currentFinal.frame_ids.every((id, index) => id === lineage[index].frameId)
    ) {
      const existing = await MotionArtifactStore.get({
        userId: owner.userId,
        toolProjectId: owner.toolProjectId,
        sourceRevision: run.sourceRevision,
        kind: "merged_video",
        artifactRevision: currentFinal.artifact_revision,
      });
      if (
        existing?.blob &&
        existing.flowProjectId === run.flowProjectId &&
        matchingLineage(existing.lineage)
      )
        return {
          state: "ready",
          artifactId: currentFinal.artifact_id,
          artifactRevision: currentFinal.artifact_revision,
          duration: currentFinal.duration,
          downloadError: await downloadFinal(
            currentFinal.artifact_id,
            currentFinal.artifact_revision,
            existing.blob,
          ),
        };
    }
    if (
      !matches.length &&
      (run.state !== "running" || shouldStop() || project.data_json?.paused)
    )
      return { state: "paused" };
    const operationId = matches.length ? matches[0][0] : crypto.randomUUID();
    const artifactRevision = matches.length
      ? matches[0][1].artifactRevision
      : Number(project.data_json?.final_artifact_revision || 0) + 1;
    if (!Number.isSafeInteger(artifactRevision) || artifactRevision < 1)
      throw new Error("MOTION_FINAL_REVISION_INVALID");
    const op = {
      ...owner,
      operationId,
      frameId: "project",
      frameRunId: run.runId,
      inputRevision: run.sourceRevision,
      stage: "merge",
      artifactRevision,
    };
    const scope = {
      userId: owner.userId,
      toolProjectId: owner.toolProjectId,
      flowProjectId: run.flowProjectId,
      sourceRevision: run.sourceRevision,
      frameId: "project",
      artifactRevision,
      targetKind: "merged_video",
      operationId,
    };
    const artifactId = `merged_${run.sourceRevision}_${artifactRevision}_${operationId}`;
    const sameFrames = (current) => {
      const currentEntries = Object.entries(
        current.data_json?.frames || {},
      ).sort((a, b) => Number(a[1].start) - Number(b[1].start));
      return (
        currentEntries.length === lineage.length &&
        lineage.every((item, index) => {
          const [id, frame] = currentEntries[index] || [];
          return (
            id === item.frameId &&
            frame?.run_id === item.runId &&
            frame?.input_revision === item.inputRevision &&
            frame.stages?.persist?.state === "ready"
          );
        })
      );
    };
    const sameFinal = (final) =>
      (final?.use_original_audio === true) === useOriginalAudio &&
      final?.artifact_id === artifactId &&
      final.artifact_revision === artifactRevision &&
      final.source_revision === run.sourceRevision &&
      Array.isArray(final.frame_ids) &&
      final.frame_ids.length === lineage.length &&
      final.frame_ids.every((id, index) => id === lineage[index].frameId);
    if (!matches.length)
      await step("merge_submit", () => journal.markSubmitted(op));
    let computationFailed = false;
    try {
      let stage = await MotionArtifactStore.getGeneratedStage(scope);
      const final = project.data_json?.final;
      if (!stage && matches.length) {
        if (sameFinal(final) && sameFrames(project)) {
          const local = await MotionArtifactStore.get({
            ...scope,
            kind: "merged_video",
          });
          if (
            local?.blob &&
            local.flowProjectId === run.flowProjectId &&
            local.generatedReceiptOperationId === operationId &&
            matchingLineage(local.lineage)
          ) {
            await journal.settle({ ...op, outcome: "received" });
            return {
              state: "ready",
              artifactId,
              artifactRevision,
              duration: final.duration,
              downloadError: await downloadFinal(
                artifactId,
                artifactRevision,
                local.blob,
              ),
            };
          }
        }
        return { state: "needs_review", error: "MOTION_MERGE_STAGE_MISSING" };
      }
      if (!stage) {
        if (shouldStop()) {
          await journal.settle({ ...op, outcome: "rejected" });
          return { state: "paused" };
        }
        const clips = [];
        for (const item of lineage) {
          const record = await MotionArtifactStore.get({
            userId: owner.userId,
            toolProjectId: owner.toolProjectId,
            sourceRevision: run.sourceRevision,
            frameId: item.frameId,
            kind: "generated_clip",
            artifactRevision: item.inputRevision,
          });
          if (!record?.blob) throw new Error("MOTION_RESULT_LOCAL_MISSING");
          clips.push(record.blob);
        }
        let merged;
        try {
          const audioOptions = useOriginalAudio
            ? await step("original_audio", () =>
                MotionOriginalAudio.options({
                  project,
                  frameIds: lineage.map((item) => item.frameId),
                  scope: {
                    userId: owner.userId,
                    toolProjectId: owner.toolProjectId,
                    flowProjectId: run.flowProjectId,
                    sourceRevision: run.sourceRevision,
                  },
                  shouldStop,
                  assertScope: async () => {
                    const current = await fresh();
                    if (!sameFrames(current))
                      throw new Error("SOURCE_CHANGED_DURING_MERGE");
                  },
                }),
              )
            : {};
          const retries =
            run.retryEnabled === true &&
            Number.isSafeInteger(run.transcriptMaxRetries)
              ? run.transcriptMaxRetries
              : 0;
          for (let retryCount = 0; ; retryCount++) {
            try {
              merged =
                clips.length === 1 && !useOriginalAudio
                  ? {
                      blob: clips[0],
                      duration: await step("measure_duration", () =>
                        measureDuration(clips[0], { signal }),
                      ),
                    }
                  : await step("merge", () =>
                      merge(clips, { ...audioOptions, signal }),
                    );
              break;
            } catch (error) {
              const code = String(error?.code || error?.message || "");
              const retryable = [
                "MOTION_MERGE_TIMEOUT",
                "MOTION_VIDEO_METADATA_TIMEOUT",
                "MERGE_WORKER_FAILED",
              ].includes(code);
              if (
                !retryable ||
                error?.noRetry === true ||
                error?.noReplay === true ||
                retryCount >= retries ||
                typeof waitBeforeRetry !== "function" ||
                shouldStop() ||
                signal?.aborted
              )
                throw error;
              await assertScope();
              const latest = await fresh();
              if (!sameFrames(latest))
                throw new Error("SOURCE_CHANGED_DURING_MERGE");
              try {
                onStage({
                  stage: "final",
                  detail: "retrying",
                  error: code,
                  apiDiagnostic: {
                    phase: "final",
                    operation: "merge_retry",
                    eventState: "retrying",
                    code,
                    retryCount: retryCount + 1,
                    maxRetries: retries,
                  },
                });
              } catch (_) {}
              await waitBeforeRetry({
                stage: "merge",
                retryCount: retryCount + 1,
              });
              if (shouldStop() || signal?.aborted)
                throw new Error("MOTION_CANCELLED");
              await assertScope();
              if (!sameFrames(await fresh()))
                throw new Error("SOURCE_CHANGED_DURING_MERGE");
            }
          }
        } catch (error) {
          computationFailed = true;
          throw error;
        }
        if (signal?.aborted) {
          computationFailed = true;
          throw new Error("MOTION_CANCELLED");
        }
        if (
          !(merged?.blob instanceof Blob) ||
          !merged.blob.size ||
          !Number.isFinite(merged.duration) ||
          merged.duration <= 0
        ) {
          computationFailed = true;
          throw new Error("MOTION_MERGE_OUTPUT_INVALID");
        }
        project = await fresh();
        if (!sameFrames(project))
          throw new Error("SOURCE_CHANGED_DURING_MERGE");
        await step("artifact_stage", () =>
          MotionArtifactStore.stageGenerated({
            ...scope,
            blob: merged.blob,
            duration: merged.duration,
            lineage,
            useOriginalAudio,
          }),
        );
        stage = await MotionArtifactStore.getGeneratedStage(scope);
      }
      if (
        !stage?.blob ||
        !["staged", "promoted"].includes(stage.state) ||
        !Number.isFinite(stage.duration) ||
        stage.duration <= 0 ||
        (stage.useOriginalAudio === true) !== useOriginalAudio ||
        JSON.stringify(stage.lineage) !== JSON.stringify(lineage)
      )
        return { state: "needs_review", error: "MOTION_MERGE_STAGE_INVALID" };
      project = await fresh();
      if (!sameFrames(project))
        return { state: "needs_review", error: "SOURCE_CHANGED_DURING_MERGE" };
      const currentFinal2 = project.data_json?.final;
      const committed = sameFinal(currentFinal2);
      if (
        !committed &&
        Number(project.data_json?.final_artifact_revision || 0) + 1 !==
          artifactRevision
      )
        return {
          state: "needs_review",
          error: "MOTION_FINAL_REVISION_CHANGED",
        };
      if (stage.state === "staged")
        await step("artifact_promote", () =>
          MotionArtifactStore.promoteGenerated(scope),
        );
      if (!committed) {
        try {
          await assertScope();
          journal._owned(await journal.get(owner), owner);
          await step("finalize_checkpoint", () =>
            api("POST", `${endpoint}/finalize`, {
              revision: project.revision,
              source_revision: run.sourceRevision,
              artifact_revision: artifactRevision,
              artifact_id: artifactId,
              duration: stage.duration,
              frame_ids: lineage.map((item) => item.frameId),
              use_original_audio: useOriginalAudio,
              request_nonce: crypto.randomUUID(),
            }),
          );
        } catch (error) {
          const latest = await fresh().catch(() => null);
          const saved = latest?.data_json?.final;
          if (!latest || !sameFrames(latest) || !sameFinal(saved)) throw error;
        }
      }
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      if (run.autoDownloadFinal)
        await MotionArtifactStore.checkpointFinalDownload({
          ...downloadScope(artifactId, artifactRevision),
          state: "pending",
        });
      await step("artifact_finish", () =>
        MotionArtifactStore.finishGenerated(scope),
      );
      await step("merge_settle", () =>
        journal.settle({ ...op, outcome: "received" }),
      );
      try {
        const latest = await fresh();
        if (latest.data_json?.final?.artifact_id === artifactId) {
          const records = await MotionArtifactStore.listProject(
            owner.userId,
            owner.toolProjectId,
          );
          for (const record of records.filter(
            (item) =>
              item.kind === "merged_video" &&
              item.sourceRevision === run.sourceRevision &&
              Number.isSafeInteger(item.artifactRevision) &&
              item.artifactRevision < artifactRevision,
          )) {
            await assertScope();
            journal._owned(await journal.get(owner), owner);
            await MotionArtifactStore.delete({
              userId: owner.userId,
              toolProjectId: owner.toolProjectId,
              sourceRevision: run.sourceRevision,
              kind: "merged_video",
              artifactRevision: record.artifactRevision,
            });
          }
        }
      } catch (error) {
        console.warn(
          "[MotionFinalize] old artifact cleanup failed",
          error?.message,
        );
      }
      const downloadError = await downloadFinal(
        artifactId,
        artifactRevision,
        stage.blob,
        true,
      );
      return {
        state: "ready",
        artifactId,
        artifactRevision,
        duration: stage.duration,
        downloadError,
      };
    } catch (error) {
      const code = error?.code || error?.message || "MOTION_FINAL_UNVERIFIED";
      if (computationFailed) {
        try {
          await assertScope();
          await journal.settle({ ...op, outcome: "rejected" });
        } catch (_) {
          return {
            state: "needs_review",
            error: "MOTION_MERGE_SETTLEMENT_PENDING",
          };
        }
        if (
          (shouldStop() || signal?.aborted) &&
          ["MOTION_CANCELLED", "ABORTED", "AbortError"].includes(code)
        )
          return { state: "paused", error: null };
        return { state: "failed", error: code, computationFailed: true };
      }
      return { state: "needs_review", error: code };
    }
  }
}
globalThis.MotionProjectFinalize = MotionProjectFinalize;
