class MotionParallelPreparation {
  static async run({
    frames,
    maxWorkers,
    needsTranscript,
    transcribe,
    needsUpload,
    upload,
    transcriptMaxRetries,
    retryEnabled,
    waitBeforeRetry,
    shouldStop = () => false,
    onStage = () => {},
    getUploadLimit = null,
  }) {
    if (
      !Array.isArray(frames) ||
      !Number.isSafeInteger(maxWorkers) ||
      maxWorkers < 1 ||
      typeof needsTranscript !== "function" ||
      typeof transcribe !== "function" ||
      typeof needsUpload !== "function" ||
      typeof upload !== "function" ||
      !Number.isSafeInteger(transcriptMaxRetries) ||
      transcriptMaxRetries < 0 ||
      typeof retryEnabled !== "boolean" ||
      typeof waitBeforeRetry !== "function" ||
      (getUploadLimit !== null && typeof getUploadLimit !== "function")
    )
      throw new Error("MOTION_PREPARATION_CONFIG_INVALID");
    const ids = frames.map((frame) => frame?.frameId);
    if (
      ids.some((id) => typeof id !== "string" || !id) ||
      new Set(ids).size !== ids.length
    ) {
      throw new Error("MOTION_PREPARATION_FRAME_INVALID");
    }
    const results = new Map(
      frames.map((frame) => [
        frame.frameId,
        {
          frameId: frame.frameId,
          transcript: frame.preparationError
            ? "failed"
            : needsTranscript(frame)
              ? "pending"
              : "skipped",
          upload: frame.preparationError
            ? "skipped"
            : needsUpload(frame)
              ? "pending"
              : "skipped",
          ...(frame.preparationError && {
            transcriptError: frame.preparationError.code,
            ...(frame.preparationError.stage === "source" && {
              sourceError: frame.preparationError.code,
            }),
          }),
        },
      ]),
    );
    if (
      getUploadLimit &&
      !shouldStop() &&
      [...results.values()].some((item) => item.upload === "pending")
    ) {
      const limit = await getUploadLimit();
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new Error("MOTION_FLOW_CONFIG_INVALID");
    }
    let halted = false;
    let pendingBackoffs = 0;
    const queue = frames
      .filter((frame) => results.get(frame.frameId).transcript === "pending")
      .map((frame) => ({ frame, retries: 0 }));
    const waiters = new Set();
    const backoffs = new Set();
    const wake = () => {
      for (const resolve of waiters) resolve();
      waiters.clear();
    };
    const permitted = () => !halted && !shouldStop();
    const emit = (frameId, stage, state, error = null) => {
      const items = [...results.values()];
      const completedCount = items.filter(
        (item) =>
          stage in item && !["pending", "running"].includes(item[stage]),
      ).length;
      try {
        onStage({
          frameId,
          stage,
          state,
          error,
          completedCount,
          totalCount: frames.length,
        });
      } catch (cause) {
        console.warn(
          "[MotionParallelPreparation] stage callback:",
          cause?.message,
        );
      }
    };
    for (const frame of frames)
      if (frame.preparationError)
        emit(
          frame.frameId,
          frame.preparationError.stage,
          "failed",
          frame.preparationError.code,
        );
    const runStage = async (frame, stage, fn, retries = 0) => {
      const result = results.get(frame.frameId);
      result[stage] = "running";
      emit(frame.frameId, stage, "running");
      let outcome;
      try {
        outcome = await fn(frame, { retryCount: retries });
      } catch (error) {
        const code =
          error?.code || error?.message || "MOTION_PREPARATION_FAILED";
        outcome = {
          state: error?.dispatchStarted === false ? "failed" : "needs_review",
          error: code,
          terminal: [
            "MOTION_TRANSCRIPT_RETRY_EXHAUSTED",
            "MOTION_RUN_FENCED",
            "MOTION_RUN_NOT_RUNNING",
            "ACCOUNT_SCOPE_CHANGED",
            "MOTION_FULL_AUDIO_OUTCOME_UNKNOWN",
            "MOTION_FULL_AUDIO_ALREADY_COMPLETED",
          ].includes(code),
        };
      }
      if (
        stage === "transcript" &&
        outcome?.state === "ready" &&
        outcome.synced === false
      ) {
        result.transcript = "sync_pending";
        result.transcriptError = "MOTION_TRANSCRIPT_SYNC_PENDING";
        emit(frame.frameId, stage, "sync_pending", result.transcriptError);
        wake();
        return;
      }
      if (
        stage === "transcript" &&
        outcome?.state === "ready" &&
        outcome.settlementPending === true
      ) {
        result.transcript = "sync_pending";
        result.transcriptError = "MOTION_SETTLEMENT_UNCONFIRMED";
        emit(frame.frameId, stage, "sync_pending", result.transcriptError);
        wake();
        return;
      }
      if (
        stage === "transcript" &&
        outcome?.state === "ready" &&
        outcome.closePending === true
      ) {
        result.transcript = "sync_pending";
        result.transcriptError = "MOTION_WORKER_CLOSE_PENDING";
        Object.defineProperty(result, "workerClosePending", {
          enumerable: false,
          value: outcome.worker || null,
        });
        emit(frame.frameId, stage, "sync_pending", result.transcriptError);
        wake();
        return;
      }
      if (
        stage === "transcript" &&
        outcome?.state === "failed" &&
        outcome.synced === false
      ) {
        result.transcript = "sync_pending";
        result.transcriptError = "MOTION_TRANSCRIPT_SYNC_PENDING";
        Object.defineProperty(result, "pendingFailedAttempt", {
          enumerable: false,
          value: true,
        });
        emit(frame.frameId, stage, "sync_pending", result.transcriptError);
        wake();
        return;
      }
      if (stage === "transcript" && outcome?.failureDiagnostic)
        result.transcriptDiagnostic = outcome.failureDiagnostic;
      else if (stage === "transcript") delete result.transcriptDiagnostic;
      if (outcome?.state === "ready") {
        delete result[`${stage}Error`];
        if (stage === "transcript") delete result.transcriptAmbiguous;
        result[stage] = "ready";
        emit(frame.frameId, stage, "ready");
        return;
      }
      if (
        stage === "transcript" &&
        outcome?.state === "failed" &&
        outcome.closePending === true
      ) {
        result.transcript = "failed";
        result.transcriptError = outcome.error || "MOTION_TRANSCRIPTION_FAILED";
        Object.defineProperty(result, "workerClosePending", {
          enumerable: false,
          value: outcome.worker || null,
        });
        Object.defineProperty(result, "workerFailureTerminal", {
          enumerable: false,
          value: outcome.terminal === true,
        });
        emit(frame.frameId, stage, "failed", result.transcriptError);
        wake();
        return;
      }
      const ambiguous = outcome?.state === "needs_review";
      if (stage === "transcript" && outcome?.state === "persistence_error") {
        const recovery = { retryPersistence: outcome.retryPersistence || null };
        Object.defineProperties(recovery, {
          pendingTranscript: {
            enumerable: false,
            get: () => outcome.pendingTranscript || null,
          },
          worker: { enumerable: false, get: () => outcome.worker || null },
        });
        Object.defineProperty(result, "transcriptRecovery", {
          enumerable: false,
          value: recovery,
        });
      }
      const state =
        stage === "transcript"
          ? "failed"
          : ambiguous
            ? "needs_review"
            : "failed";
      result[stage] = state;
      result[`${stage}Error`] =
        outcome?.error || "MOTION_PREPARATION_UNVERIFIED";
      if (stage === "transcript" && ambiguous)
        result.transcriptAmbiguous = true;
      if (
        stage === "transcript" &&
        outcome?.state !== "persistence_error" &&
        !outcome?.terminal &&
        retryEnabled &&
        retries < transcriptMaxRetries &&
        permitted()
      ) {
        retries++;
        result.transcriptRetries = retries;
        emit(frame.frameId, stage, "retrying", result.transcriptError);
        pendingBackoffs++;
        const backoff = Promise.resolve()
          .then(() =>
            waitBeforeRetry({ frameId: frame.frameId, retryCount: retries }),
          )
          .then(
            () => {
              if (permitted()) queue.push({ frame, retries });
              else emit(frame.frameId, stage, "failed", result.transcriptError);
            },
            (error) => {
              result.transcriptError =
                error?.code || error?.message || "MOTION_RETRY_WAIT_FAILED";
              emit(frame.frameId, stage, "failed", result.transcriptError);
            },
          )
          .finally(() => {
            pendingBackoffs--;
            backoffs.delete(backoff);
            wake();
          });
        backoffs.add(backoff);
        return;
      }
      emit(frame.frameId, stage, result[stage], result[`${stage}Error`]);
      wake();
    };
    const worker = async () => {
      while (permitted()) {
        const task = queue.shift();
        if (task) {
          await runStage(task.frame, "transcript", transcribe, task.retries);
          continue;
        }
        if (!pendingBackoffs) return;
        await new Promise((resolve) => waiters.add(resolve));
      }
    };
    const uploadLane = async () => {
      if (getUploadLimit)
        return MotionFlowUpload.runBatch({
          items: frames.filter(
            (frame) => results.get(frame.frameId).upload === "pending",
          ),
          getLimit: getUploadLimit,
          shouldStop: () => !permitted(),
          run: (frame) => runStage(frame, "upload", upload),
        }).catch((error) => {
          halted = true;
          wake();
          throw error;
        });
      for (const frame of frames) {
        if (!permitted()) return;
        if (results.get(frame.frameId).upload !== "pending") continue;
        await runStage(frame, "upload", upload);
      }
    };
    const preparation = await Promise.allSettled([
      ...Array.from({ length: Math.min(maxWorkers, frames.length) }, () =>
        worker(),
      ),
      uploadLane(),
    ]);
    await Promise.all([...backoffs]);
    const rejected = preparation.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    const entries = [...results.values()];
    const ready = entries.every(
      (item) =>
        ["ready", "skipped"].includes(item.transcript) &&
        ["ready", "skipped"].includes(item.upload),
    );
    return {
      ready: ready && !halted && !shouldStop(),
      stopped: shouldStop(),
      failed:
        halted ||
        entries.some(
          (item) =>
            !["ready", "skipped"].includes(item.transcript) ||
            !["ready", "skipped"].includes(item.upload),
        ),
      items: entries,
    };
  }
}
globalThis.MotionParallelPreparation = MotionParallelPreparation;
