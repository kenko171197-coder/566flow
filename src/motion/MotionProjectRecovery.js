class MotionProjectRecovery {
  static async run({
    owner,
    journal,
    api,
    assertScope,
    flowTarget,
    mode,
    shouldStop,
    waitBeforeRetry,
    downloadConfig,
    selectedResolution,
    download,
    hostEpoch,
    maxSeconds,
    reconcileWorkers = null,
    onStage = () => {},
    signal = null,
    transcriptOnly = false,
  }) {
    if (
      !owner ||
      !journal ||
      !flowTarget ||
      (!transcriptOnly && !["web", "api"].includes(mode)) ||
      [api, assertScope, shouldStop, waitBeforeRetry, download].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_RECOVERY_CONFIG_INVALID");
    const read = async () => {
      await assertScope();
      const run = await journal.get(owner);
      journal._owned(run, owner);
      if (
        run.runId !== owner.runId ||
        run.flowProjectId !== flowTarget.projectId
      )
        throw new Error("MOTION_RUN_FENCED");
      return run;
    };
    try {
      let run = await read();
      if (
        transcriptOnly &&
        (run.taskKind !== "transcript_batch" ||
          Object.values(run.operations || {}).some(
            (operation) =>
              !["transcribe", "direct_transcribe"].includes(operation.stage),
          ))
      )
        throw new Error("MOTION_TRANSCRIPT_BATCH_UNVERIFIED");
      const reconcile =
        reconcileWorkers ||
        (Number.isSafeInteger(hostEpoch) && hostEpoch > 0
          ? () =>
              chrome.runtime.sendMessage({
                action: "motionWorker:reconcile",
                hostEpoch,
                toolProjectId: owner.toolProjectId,
                runId: owner.runId,
                ownerId: owner.ownerId,
                epoch: owner.epoch,
              })
          : null);
      if (typeof reconcile !== "function")
        throw new Error("MOTION_WORKER_RECONCILE_UNAVAILABLE");
      let workers;
      const closeRetries =
        run.retryEnabled === true &&
        Number.isSafeInteger(run.transcriptMaxRetries)
          ? run.transcriptMaxRetries
          : 0;
      for (let attempt = 0; attempt <= closeRetries; attempt++) {
        try {
          workers = await reconcile();
        } catch (error) {
          if (
            ["ACCOUNT_SCOPE_CHANGED", "MOTION_RUN_FENCED"].includes(
              error?.code || error?.message,
            )
          )
            throw error;
          workers = { success: false, error: error?.code || error?.message };
        }
        await read();
        if (
          workers?.success === true &&
          Array.isArray(workers.pending) &&
          !workers.pending.length
        )
          break;
        if (attempt === closeRetries || shouldStop()) break;
        try {
          onStage({
            stage: "recovery",
            detail: "retrying",
            apiDiagnostic: {
              phase: "worker_reconcile",
              operation: "close_ack",
              eventState: "retrying",
              code: "MOTION_WORKER_CLOSE_PENDING",
            },
          });
        } catch (_) {}
        await waitBeforeRetry({
          stage: "worker_reconcile",
          retryCount: attempt + 1,
        });
        if (shouldStop()) break;
      }
      if (
        workers?.success !== true ||
        !Array.isArray(workers.pending) ||
        workers.pending.length
      )
        return {
          ready: false,
          error: workers?.error || "MOTION_WORKER_CLOSE_PENDING",
        };
      for (const [frameId, reservation] of Object.entries(
        run.reservations || {},
      )) {
        if (reservation.pendingAttemptId)
          await MotionTranscriptReservation.reconcilePendingIntent({
            owner,
            frameId,
            journal,
            api,
            assertScope,
          });
      }
      if (typeof journal.editFrameResult === "function") {
        const project = await api(
          "GET",
          `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`,
        );
        await read();
        if (
          project?.tool_project_id !== owner.toolProjectId ||
          project.flow_project_id !== run.flowProjectId ||
          Number(project.data_json?.source_revision) !== run.sourceRevision
        )
          throw new Error("MOTION_RUN_FENCED");
        for (const [frameId, frame] of Object.entries(
          project.data_json.frames || {},
        )) {
          const edit = frame.result_edit;
          if (
            !edit?.mutation_id ||
            !["reset", "replace"].includes(edit.action) ||
            !edit.run_id ||
            frame.run_id === edit.run_id ||
            frame.input_revision !== edit.input_revision + 1
          )
            continue;
          await journal.editFrameResult({
            userId: owner.userId,
            toolProjectId: owner.toolProjectId,
            owner,
            sourceRevision: run.sourceRevision,
            frameId,
            frameRunId: edit.run_id,
            inputRevision: edit.input_revision,
          });
        }
        run = await read();
      }
      const flush = () =>
        MotionTranscriptOutbox.flush({
          userId: owner.userId,
          toolProjectId: owner.toolProjectId,
          flowProjectId: run.flowProjectId,
          api,
          assertScope,
        });
      await flush();
      run = await read();
      for (const [operationId, operation] of Object.entries(
        run.operations || {},
      )) {
        let result;
        const common = { owner, journal, api, assertScope, shouldStop };
        if (operation.stage === "upload")
          result = await MotionProjectUpload.run({
            ...common,
            frameId: operation.frameId,
            flowTarget,
            mode,
            maxSeconds,
            maxRetries:
              run.retryEnabled === true &&
              Number.isSafeInteger(run.transcriptMaxRetries)
                ? run.transcriptMaxRetries
                : 0,
            waitBeforeRetry,
            onStage,
          });
        else if (operation.stage === "flow" || operation.stage === "persist") {
          if (operation.stage === "flow" && globalThis.MotionProjectMonitor) {
            const monitored = await MotionProjectMonitor.run({
              ...common,
              operationId,
              operation,
              flowTarget,
              mode,
            });
            if (monitored?.state !== "ready")
              return {
                ready: false,
                state: monitored?.state,
                error: monitored?.error || "MOTION_MONITOR_RESULT_UNVERIFIED",
              };
          }
          result = await MotionProjectPersist.run({
            ...common,
            frameId: operation.frameId,
            config: downloadConfig,
            selectedResolution,
            retryDownload: true,
            waitBeforeRetry,
            onStage,
            ...(operation.stage === "flow"
              ? { drainOperationId: operationId }
              : {}),
          });
        } else if (operation.stage === "merge")
          result = await MotionProjectFinalize.run({
            ...common,
            download,
            waitBeforeRetry,
            onStage,
            signal,
          });
        else
          return { ready: false, error: "MOTION_OPERATION_RECONCILE_REQUIRED" };
        if (result?.state !== "ready")
          return {
            ready: false,
            state: result?.state,
            error:
              result?.state === "paused"
                ? null
                : result?.error || "MOTION_OPERATION_RECONCILE_REQUIRED",
          };
      }
      run = await read();
      if (
        Object.keys(run.operations || {}).length ||
        (await journal.listTranscriptOutbox(owner)).length
      )
        return { ready: false, error: "MOTION_RUN_DRAIN_REQUIRED" };
      for (const [frameId, reservation] of Object.entries(
        run.reservations || {},
      )) {
        if (!reservation.token) continue;
        const completed = Object.values(run.completedOperations || {}).find(
          (item) =>
            item.frameId === frameId &&
            item.frameRunId === reservation.frameRunId &&
            item.inputRevision === reservation.inputRevision,
        );
        if (!completed) {
          const failed = Object.values(run.failedOperations || {}).filter(
            (item) =>
              item.frameId === frameId &&
              item.frameRunId === reservation.frameRunId &&
              item.inputRevision === reservation.inputRevision,
          );
          if (
            failed.length &&
            failed.every(
              (item) =>
                item.reason === "MOTION_RESERVATION_EXPIRED" &&
                !item.fullAudioFrames,
            )
          ) {
            await MotionTranscriptReservation.recoverExpired({
              owner,
              frameId,
              reservation,
              journal,
              api,
              assertScope,
            });
            run = await read();
          }
          continue;
        }
        await MotionTranscriptReservation.settle({
          attempt: {
            ...owner,
            frameId,
            frameRunId: reservation.frameRunId,
            inputRevision: reservation.inputRevision,
          },
          status: "success",
          journal,
          api,
          assertScope,
          flush,
        });
        run = await read();
      }
      if (run.subtitleReview === "waiting") {
        const project = await api(
          "GET",
          `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`,
        );
        await read();
        const reviewed = journal.reviewedTranscriptFailures(run, project);
        const frameIds = new Set(
          reviewed.flatMap((item) =>
            (item.fullAudioFrames || [item]).map((member) => member.frameId),
          ),
        );
        for (const frameId of frameIds) {
          const reservation = run.reservations?.[frameId];
          if (reservation?.token) {
            await MotionTranscriptReservation.settle({
              attempt: {
                ...owner,
                frameId,
                frameRunId: reservation.frameRunId,
                inputRevision: reservation.inputRevision,
              },
              status: "failed",
              journal,
              api,
              assertScope,
              flush,
            });
            run = await read();
          }
        }
        if (reviewed.length) {
          await journal.resolveReviewedTranscriptFailures(owner, project);
          run = await read();
        }
      }
      const failures = Object.values(run.failedOperations || {}).filter(
        (item) =>
          ["transcribe", "direct_transcribe"].includes(item.stage) &&
          !item.resolved,
      );
      const counts = new Map();
      for (const item of failures) {
        const key = `${item.frameId}:${item.frameRunId}:${item.inputRevision}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      if (
        failures.some(
          (item) =>
            item.fullAudioFrames &&
            item.reason === "MOTION_FULL_AUDIO_OUTCOME_UNKNOWN",
        )
      )
        return {
          ready: false,
          state: "needs_review",
          error: "MOTION_FULL_AUDIO_OUTCOME_UNKNOWN",
        };
      const exhausted = failures.filter(
        (item) =>
          !run.retryEnabled ||
          counts.get(
            `${item.frameId}:${item.frameRunId}:${item.inputRevision}`,
          ) > run.transcriptMaxRetries,
      );
      for (const item of exhausted) {
        const reservation = run.reservations?.[item.frameId];
        if (!reservation?.token) continue;
        await MotionTranscriptReservation.settle({
          attempt: {
            ...owner,
            frameId: item.frameId,
            frameRunId: item.frameRunId,
            inputRevision: item.inputRevision,
          },
          status: "failed",
          journal,
          api,
          assertScope,
          flush,
        });
        run = await read();
      }
      if (exhausted.length)
        return {
          ready: false,
          state: "failed",
          error: "MOTION_TRANSCRIPT_RETRY_EXHAUSTED",
        };
      return { ready: true };
    } catch (error) {
      return {
        ready: false,
        error: error?.code || error?.message || "MOTION_RUN_RECONCILE_REQUIRED",
      };
    }
  }
}
globalThis.MotionProjectRecovery = MotionProjectRecovery;
