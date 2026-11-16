class MotionProjectPersist {
  static async run({
    owner,
    frameId,
    api,
    journal,
    assertScope,
    shouldStop,
    config,
    selectedResolution,
    drainOperationId = null,
    retryDownload = false,
    retryDownloadOnFailure = retryDownload,
    waitBeforeRetry = null,
    onStage = () => {},
    requireMediaIdentity = false,
  }) {
    if (
      !owner ||
      !frameId ||
      !journal ||
      [api, assertScope, shouldStop].some((fn) => typeof fn !== "function")
    )
      throw new Error("MOTION_PERSIST_CONFIG_INVALID");
    await assertScope();
    const run = await journal.get(owner);
    if (
      !run ||
      run.runId !== owner.runId ||
      !["running", "needs_review", "pausing", "stopping"].includes(run.state)
    )
      throw new Error("MOTION_PERSIST_SCOPE_INVALID");
    journal._owned(run, owner);
    const notify = (detail, error = null) => {
      try {
        onStage({ frameId, stage: "download", detail, error });
      } catch (_) {}
    };
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
        Number(project2.data_json?.source_revision) !== run.sourceRevision
      )
        throw new Error("MOTION_PERSIST_SCOPE_CHANGED");
      return project2;
    };
    const project = await fresh(),
      frame = project.data_json?.frames?.[frameId],
      monitor = frame?.stages?.monitor;
    const manualResult =
      monitor?.flow_mode === "web" &&
      monitor.manual_result === true &&
      frame?.result_edit?.action === "replace" &&
      frame.result_edit.media_id === monitor.provider_media_id &&
      frame.result_edit.input_revision + 1 === frame.input_revision &&
      window.flow_uuid_gateway?.isUuid?.(frame.result_edit.mutation_id) ===
        true &&
      window.flow_uuid_gateway?.isUuid?.(monitor.provider_media_id) === true;
    if (
      !frame ||
      monitor?.state !== "ready" ||
      !["web", "api"].includes(monitor.flow_mode) ||
      !monitor.provider_media_id ||
      (!monitor.provider_operation_id && !manualResult)
    )
      throw new Error("MOTION_MONITOR_RECEIPT_REQUIRED");
    const source = await MotionArtifactStore.get({
      userId: owner.userId,
      toolProjectId: owner.toolProjectId,
      sourceRevision: run.sourceRevision,
      frameId,
      kind: "source_clip",
    });
    if (
      source?.uploadReceipt &&
      source.uploadReceipt.projectId !== run.flowProjectId
    )
      throw new Error("MOTION_FLOW_PROJECT_RECEIPT_REQUIRED");
    const matching = Object.entries(run.operations || {}).filter(
      ([id, item]) =>
        item.frameId === frameId &&
        (item.stage === "persist" ||
          (drainOperationId === id && item.stage === "flow")),
    );
    if (
      matching.length > 1 ||
      matching.some(
        ([, item]) =>
          item.frameRunId !== frame.run_id ||
          item.inputRevision !== frame.input_revision,
      )
    )
      return {
        state: "needs_review",
        error: "MOTION_PERSIST_RECONCILE_REQUIRED",
      };
    if (
      drainOperationId &&
      (matching.length !== 1 ||
        matching[0][0] !== drainOperationId ||
        matching[0][1].stage !== "flow")
    )
      return { state: "needs_review", error: "MOTION_PERSIST_DRAIN_INVALID" };
    const receipt = {
      apiDriver: monitor.api_driver,
      mediaId: monitor.provider_media_id,
      operationId: monitor.provider_operation_id,
      projectId: run.flowProjectId,
      protocolRevision: monitor.protocol_revision,
      protocolFingerprint: monitor.protocol_fingerprint,
      ...(manualResult && {
        manualResult: true,
        fileName: monitor.persistent_media_id || "",
      }),
      ratio: run.downloadRatio || project.data_json?.preferences?.ratio,
    };
    const initialPersist = frame.stages?.persist || null;
    let restoreArtifactId = matching[0]?.[1]?.restoreArtifactId || null;
    if (
      !matching.length &&
      initialPersist?.state === "ready" &&
      initialPersist.artifact_id &&
      initialPersist.resolution
    ) {
      const local = await MotionArtifactStore.get({
        userId: owner.userId,
        toolProjectId: owner.toolProjectId,
        sourceRevision: run.sourceRevision,
        frameId,
        kind: "generated_clip",
        artifactRevision: frame.input_revision,
      });
      if (local?.blob) {
        if (
          local.flowProjectId !== run.flowProjectId ||
          local.resolution !== initialPersist.resolution ||
          (requireMediaIdentity &&
            local.media_uuid &&
            local.media_uuid !== monitor.provider_media_id)
        )
          return {
            state: "needs_review",
            error: "MOTION_PERSIST_SCOPE_CHANGED",
          };
        if (
          !requireMediaIdentity ||
          local.media_uuid === monitor.provider_media_id
        )
          return {
            state: "ready",
            artifactId: initialPersist.artifact_id,
            resolution: initialPersist.resolution,
            bytes: local.size,
          };
      }
      restoreArtifactId = initialPersist.artifact_id;
    }
    if (
      restoreArtifactId &&
      (initialPersist?.state !== "ready" ||
        initialPersist.artifact_id !== restoreArtifactId)
    )
      return {
        state: "needs_review",
        error: "MOTION_PERSIST_CHECKPOINT_CHANGED",
      };
    if (
      !matching.length &&
      initialPersist?.state &&
      initialPersist.state !== "failed" &&
      !restoreArtifactId
    )
      return {
        state: "needs_review",
        error: "MOTION_PERSIST_RECONCILE_REQUIRED",
      };
    if (
      !matching.length &&
      (run.state !== "running" || shouldStop() || project.data_json?.paused)
    )
      return { state: "paused" };
    const operationId = matching.length ? matching[0][0] : crypto.randomUUID();
    const op = {
      ...owner,
      operationId,
      frameId,
      frameRunId: frame.run_id,
      inputRevision: frame.input_revision,
      stage: matching[0]?.[1]?.stage || "persist",
      ...(restoreArtifactId && { restoreArtifactId }),
    };
    const scope = {
      userId: owner.userId,
      toolProjectId: owner.toolProjectId,
      flowProjectId: run.flowProjectId,
      sourceRevision: run.sourceRevision,
      frameId,
      artifactRevision: Number(frame.input_revision),
      operationId,
    };
    const artifactId =
      restoreArtifactId ||
      `result_${run.sourceRevision}_${frameId}_${frame.input_revision}_${operationId}`;
    if (artifactId.length > 160) throw new Error("MOTION_ARTIFACT_ID_INVALID");
    const sameFrame = (current) =>
      current?.run_id === frame.run_id &&
      current?.input_revision === frame.input_revision &&
      current?.stages?.monitor?.state === "ready" &&
      current.stages.monitor.provider_operation_id ===
        monitor.provider_operation_id &&
      current.stages.monitor.provider_media_id === monitor.provider_media_id &&
      (!manualResult ||
        current.result_edit?.mutation_id === frame.result_edit.mutation_id);
    if (!matching.length) {
      MotionResolutionPolicy.candidates(config, selectedResolution);
      await journal.markSubmitted(op);
    }
    try {
      let stage = await MotionArtifactStore.getGeneratedStage(scope);
      if (!matching.length && !stage && shouldStop()) {
        await journal.settle({ ...op, outcome: "rejected" });
        return { state: "paused" };
      }
      if (!stage && matching.length) {
        const saved = frame.stages?.persist;
        if (saved?.state === "ready" && saved.artifact_id === artifactId) {
          const local = await MotionArtifactStore.get({
            ...scope,
            kind: "generated_clip",
          });
          if (
            local?.blob &&
            local.resolution === saved.resolution &&
            local.generatedReceiptOperationId === operationId
          ) {
            await journal.settle({ ...op, outcome: "received" });
            return {
              state: "ready",
              artifactId,
              resolution: saved.resolution,
              bytes: local.size,
            };
          }
          if (
            local?.blob?.size >= 12 &&
            local.size === local.blob.size &&
            local.flowProjectId === run.flowProjectId &&
            local.resolution === saved.resolution &&
            local.media_uuid === monitor.provider_media_id &&
            window.flow_uuid_gateway?.isUuid?.(local.media_uuid) === true &&
            !local.generatedStageOperationId
          ) {
            const verified = (await fresh()).data_json?.frames?.[frameId];
            if (
              !sameFrame(verified) ||
              verified.stages?.persist?.state !== "ready" ||
              verified.stages.persist.artifact_id !== artifactId ||
              verified.stages.persist.resolution !== local.resolution
            )
              return {
                state: "needs_review",
                error: "MOTION_PERSIST_CHECKPOINT_CHANGED",
              };
            await journal.settle({ ...op, outcome: "received" });
            console.info("[MotionPersistReconciled]", {
              frameId,
              operationId,
              source: "manual_saved_result",
            });
            notify("ready");
            return {
              state: "ready",
              artifactId,
              resolution: saved.resolution,
              bytes: local.size,
            };
          }
        }
        const ownRunning2 =
          saved?.state === "running" && saved.artifact_id === artifactId;
        const priorDownload = matching[0][1];
        const apiRead =
          monitor.flow_mode === "api" &&
          MotionFlowDownload.downloadMode?.("api") === "api" &&
          MotionFlowDownload.canResumeApiRead?.({
            downloadReceipt: priorDownload.downloadReceipt,
            receipt,
            config,
            selectedResolution,
          }) === true;
        if (priorDownload.persistStarted === true)
          console.info("[MotionPersistReadRecovery]", {
            frameId,
            operationId,
            receiptState: priorDownload.downloadReceipt?.state || null,
            route: priorDownload.downloadReceipt?.route || null,
            apiRead,
          });
        if (
          priorDownload.persistStarted === true &&
          !apiRead &&
          monitor.flow_mode === "api"
        )
          return {
            state: "needs_review",
            error: "MOTION_PERSIST_STAGE_MISSING",
          };
        const retryable =
          !!restoreArtifactId ||
          (retryDownload === true &&
            (!saved?.state || saved.state === "failed" || ownRunning2));
        if (
          !retryable &&
          (!drainOperationId ||
            (saved?.state && !ownRunning2) ||
            matching[0][1].persistStarted === true)
        )
          return {
            state: "needs_review",
            error: "MOTION_PERSIST_STAGE_MISSING",
          };
      }
      if (!stage) {
        MotionResolutionPolicy.candidates(config, selectedResolution);
        const downloadScope = {
          ...scope,
          generationProcessId: owner.runId,
          stagingOperationId: operationId,
          stagingOwner: owner,
        };
        const persist =
          monitor.flow_mode === "web"
            ? MotionFlowDownload.persistWeb
            : MotionFlowDownload.persistApi;
        let downloadError = null;
        const retryState = {};
        while (!stage) {
          await assertScope();
          const currentRun = await journal.get(owner);
          journal._owned(currentRun, owner);
          const retrying =
            (retryDownload && matching.length > 0) ||
            (!!restoreArtifactId &&
              matching[0]?.[1]?.persistStarted === true) ||
            downloadError !== null;
          if (retrying && shouldStop()) return { state: "paused" };
          const latest = await fresh();
          if (!sameFrame(latest.data_json?.frames?.[frameId]))
            throw new Error("MOTION_PERSIST_SCOPE_CHANGED");
          let attempt;
          try {
            attempt = await journal.markFlowDownloadStarted({
              ...op,
              retryDownload: retrying,
            });
          } catch (error) {
            throw error?.message === "MOTION_PERSIST_RETRY_EXHAUSTED" &&
              downloadError
              ? downloadError
              : error;
          }
          notify("running");
          const starting = {
            source_revision: run.sourceRevision,
            run_id: frame.run_id,
            input_revision: frame.input_revision,
            stage: "persist",
            state: "running",
            artifact_id: artifactId,
            request_nonce: crypto.randomUUID(),
          };
          try {
            if (!restoreArtifactId)
              await api(
                "PATCH",
                `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
                starting,
              );
          } catch (error) {
            const latest2 = await fresh().catch(() => null);
            const saved = latest2?.data_json?.frames?.[frameId];
            if (
              !sameFrame(saved) ||
              saved.stages?.persist?.state !== "running" ||
              saved.stages.persist.artifact_id !== artifactId
            )
              throw error;
          }
          console.info("[MotionPersistDownload]", {
            projectId: owner.toolProjectId,
            frameId,
            operationId,
            retry: retrying,
            attempt: Number.isSafeInteger(attempt) ? attempt : null,
          });
          try {
            await persist.call(MotionFlowDownload, {
              receipt,
              config,
              selectedResolution,
              scope: downloadScope,
              retryState,
              downloadReceipt:
                currentRun.operations?.[operationId]?.downloadReceipt || null,
              onDownloadState: async (downloadReceipt) => {
                await assertScope();
                const latest2 = await fresh();
                if (!sameFrame(latest2.data_json?.frames?.[frameId]))
                  throw new Error("MOTION_PERSIST_SCOPE_CHANGED");
                if (typeof journal.setFlowDownloadReceipt !== "function")
                  throw new Error("MOTION_PERSIST_CONFIG_INVALID");
                await journal.setFlowDownloadReceipt({
                  ...op,
                  downloadReceipt,
                });
                console.info("[MotionPersistReceipt]", {
                  frameId,
                  operationId,
                  state: downloadReceipt.state,
                  route: downloadReceipt.route,
                  resolution: downloadReceipt.resolution,
                });
              },
            });
            stage = await MotionArtifactStore.getGeneratedStage(scope);
            if (!stage) throw new Error("MOTION_PERSIST_STAGE_MISSING");
          } catch (error) {
            stage = await MotionArtifactStore.getGeneratedStage(scope);
            if (stage) break;
            const rawCode = String(error?.code || error?.message || "");
            const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawCode)
              ? rawCode
              : "MOTION_FLOW_DOWNLOAD_FAILED";
            try {
              const latest2 = await fresh();
              const saved = latest2.data_json?.frames?.[frameId];
              if (
                sameFrame(saved) &&
                saved.stages?.persist?.state === "running" &&
                saved.stages.persist.artifact_id === artifactId
              )
                await api(
                  "PATCH",
                  `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
                  {
                    source_revision: run.sourceRevision,
                    run_id: frame.run_id,
                    input_revision: frame.input_revision,
                    stage: "persist",
                    state: "failed",
                    artifact_id: artifactId,
                    error_code: code,
                    request_nonce: crypto.randomUUID(),
                  },
                );
            } catch (_) {
              console.warn(
                "[MotionPersistDownload] failure checkpoint pending",
                { frameId, operationId, code },
              );
            }
            if (
              error?.noReplay === true ||
              error?.ambiguous === true ||
              error?.name === "AbortError" ||
              ["ABORTED", "DOWNLOAD_STOPPED", "MOTION_CANCELLED"].includes(
                code,
              ) ||
              !retryDownloadOnFailure ||
              typeof waitBeforeRetry !== "function" ||
              shouldStop()
            )
              throw error;
            const updated = await journal.get(owner);
            journal._owned(updated, owner);
            const attempts =
              updated.operations?.[operationId]?.persistDownloadAttempts;
            const retries =
              updated.retryEnabled === true &&
              Number.isSafeInteger(updated.transcriptMaxRetries)
                ? updated.transcriptMaxRetries
                : 0;
            if (!Number.isSafeInteger(attempts) || attempts >= 1 + retries)
              throw error;
            downloadError = error;
            console.info("[MotionPersistDownloadRetry]", {
              runId: owner.runId,
              frameId,
              operationId,
              retryCount: attempts,
              maxRetries: retries,
              code,
            });
            notify("retrying", code);
            await waitBeforeRetry({
              frameId,
              stage: "download",
              retryCount: attempts,
            });
          }
        }
      }
      if (
        !stage?.blob ||
        !["staged", "promoted"].includes(stage.state) ||
        !stage.resolution ||
        !stage.size
      )
        return { state: "needs_review", error: "MOTION_PERSIST_STAGE_INVALID" };
      const currentProject = await fresh();
      const current = currentProject.data_json?.frames?.[frameId];
      if (!sameFrame(current))
        return { state: "needs_review", error: "MOTION_PERSIST_SCOPE_CHANGED" };
      const existing = current.stages?.persist;
      const unchangedFailure =
        existing?.state === "failed" &&
        JSON.stringify(existing) === JSON.stringify(initialPersist);
      const ownRunning =
        existing?.state === "running" && existing.artifact_id === artifactId;
      const sameSavedReady =
        !!restoreArtifactId &&
        existing?.state === "ready" &&
        existing.artifact_id === artifactId &&
        JSON.stringify(existing) === JSON.stringify(initialPersist);
      if (
        existing?.state &&
        !unchangedFailure &&
        !ownRunning &&
        !sameSavedReady &&
        !(
          existing.state === "ready" &&
          existing.artifact_id === artifactId &&
          existing.resolution === stage.resolution
        )
      )
        return {
          state: "needs_review",
          error: "MOTION_PERSIST_CHECKPOINT_CHANGED",
        };
      if (stage.state === "staged")
        await MotionArtifactStore.promoteGenerated(scope);
      if (
        !existing?.state ||
        unchangedFailure ||
        ownRunning ||
        (sameSavedReady && existing.resolution !== stage.resolution)
      ) {
        const body = {
          source_revision: run.sourceRevision,
          run_id: frame.run_id,
          input_revision: frame.input_revision,
          stage: "persist",
          state: "ready",
          artifact_id: artifactId,
          resolution: stage.resolution,
          request_nonce: crypto.randomUUID(),
          ...(restoreArtifactId && { replace_existing: true }),
        };
        try {
          await assertScope();
          await api(
            "PATCH",
            `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
            body,
          );
        } catch (error) {
          const latest = await fresh().catch(() => null);
          const saved = latest?.data_json?.frames?.[frameId];
          if (
            !sameFrame(saved) ||
            saved.stages?.persist?.state !== "ready" ||
            saved.stages.persist.artifact_id !== artifactId ||
            saved.stages.persist.resolution !== stage.resolution
          ) {
            if (
              sameFrame(saved) &&
              [409, 422].includes(error?.httpStatus) &&
              (JSON.stringify(saved.stages?.persist || null) ===
                JSON.stringify(initialPersist) ||
                (saved.stages?.persist?.state === "running" &&
                  saved.stages.persist.artifact_id === artifactId))
            ) {
              await MotionArtifactStore.rollbackGenerated(scope);
            }
            throw error;
          }
        }
      }
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      await MotionArtifactStore.finishGenerated(scope);
      await journal.settle({ ...op, outcome: "received" });
      notify("ready");
      return {
        state: "ready",
        artifactId,
        resolution: stage.resolution,
        bytes: stage.size,
      };
    } catch (error) {
      const safeCode = (value) =>
        /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(value || ""))
          ? value
          : null;
      const failedRun = await journal.get(owner).catch(() => null);
      const failedProject = await fresh().catch(() => null);
      const failedFrame = failedProject?.data_json?.frames?.[frameId];
      console.warn("[MotionPersistFailure]", {
        frameId,
        operationId,
        stage: "download",
        code:
          safeCode(error?.code || error?.message) ||
          "MOTION_PERSIST_UNVERIFIED",
        checkpointCode: sameFrame(failedFrame)
          ? safeCode(failedFrame.stages?.persist?.error_code)
          : null,
        attempts:
          failedRun?.operations?.[operationId]?.persistDownloadAttempts ?? null,
        retryEnabled: run.retryEnabled === true,
        maxRetries: Number.isSafeInteger(run.transcriptMaxRetries)
          ? run.transcriptMaxRetries
          : null,
      });
      notify(
        "failed",
        error?.code || error?.message || "MOTION_PERSIST_UNVERIFIED",
      );
      return {
        state: "needs_review",
        error: error?.code || error?.message || "MOTION_PERSIST_UNVERIFIED",
      };
    }
  }
}
globalThis.MotionProjectPersist = MotionProjectPersist;
