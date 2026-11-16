class MotionTranscriptWorkerAttempt {
  static async run({
    attempt,
    journal,
    flush,
    reserve,
    openWorker,
    authorize,
    dispatch,
    validate,
    cleanup,
    close,
    cleanupTimeoutMs,
    onSaved = () => {},
  }) {
    if (
      !attempt ||
      attempt.stage !== "transcribe" ||
      !journal ||
      !Number.isSafeInteger(cleanupTimeoutMs) ||
      cleanupTimeoutMs < 1 ||
      cleanupTimeoutMs > 2147483647 ||
      ["markSubmitted", "storeTranscript", "failTranscript"].some(
        (name) => typeof journal[name] !== "function",
      ) ||
      [
        flush,
        reserve,
        openWorker,
        authorize,
        dispatch,
        validate,
        cleanup,
        close,
      ].some((fn) => typeof fn !== "function")
    ) {
      throw new Error("MOTION_WORKER_ATTEMPT_INVALID");
    }
    const started = Date.now();
    const trace = (stage, state, code = null) =>
      console.info(
        "[MotionTranscriptAttempt]",
        JSON.stringify({
          runId: attempt.runId,
          frameId: attempt.frameId,
          attemptId: attempt.operationId,
          workerId: attempt.workerId || null,
          stage,
          state,
          elapsedMs: Date.now() - started,
          ...(code && {
            code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(code))
              ? code
              : "MOTION_TRANSCRIPTION_FAILED",
          }),
        }),
      );
    const step = async (stage, action) => {
      trace(stage, "start");
      try {
        const result = await action();
        trace(stage, "returned");
        return result;
      } catch (error) {
        trace(stage, "failed", error?.code || error?.message);
        throw error;
      }
    };
    await step("journal_start", () => journal.markSubmitted(attempt));
    let worker = null;
    let transcript;
    let savedNotified = false;
    const notifySaved = () => {
      if (!savedNotified) {
        savedNotified = true;
        try {
          onSaved();
        } catch (_) {}
      }
    };
    const closeOwned = async () => {
      if (!worker) return false;
      try {
        return (
          (await step("close_worker", () => close(worker)))?.success !== true
        );
      } catch (_) {
        return true;
      }
    };
    const cleanupOwned = async () => {
      let timer;
      try {
        const result = await step("cleanup", () =>
          Promise.race([
            Promise.resolve().then(() => cleanup(worker)),
            new Promise((resolve) => {
              timer = setTimeout(
                () =>
                  resolve({ success: false, error: "MOTION_CLEANUP_TIMEOUT" }),
                cleanupTimeoutMs,
              );
            }),
          ]),
        );
        const pending = result != null && result.success !== true;
        if (pending)
          trace(
            "cleanup",
            "pending",
            result.error || "MOTION_CLEANUP_UNCONFIRMED",
          );
        return pending;
      } catch (_) {
        return true;
      } finally {
        clearTimeout(timer);
      }
    };
    const fail = async (error) => {
      const raw = String(
        error?.code || error?.message || "MOTION_TRANSCRIPTION_FAILED",
      );
      const reason = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
        ? raw
        : "MOTION_TRANSCRIPTION_FAILED";
      trace("attempt", "failed", reason);
      try {
        await journal.failTranscript({ ...attempt, reason });
      } catch (failure) {
        return {
          state: "persistence_error",
          error: failure?.message || "MOTION_JOURNAL_FAILED",
          worker,
        };
      }
      let synced2 = true;
      let closePending2 = false;
      try {
        await step("flush_failed", flush);
      } catch (_) {
        synced2 = false;
      }
      closePending2 = await closeOwned();
      return {
        state: "failed",
        error: reason,
        synced: synced2,
        closePending: closePending2,
        ...(closePending2 && { worker }),
      };
    };
    try {
      await step("flush_running", flush);
      const reservation = await step("reserve", reserve);
      worker = await step("open_worker", openWorker);
      if (!worker) throw new Error("MOTION_WORKER_UNAVAILABLE");
      const authorization = await step("authorize", () =>
        authorize(worker, reservation),
      );
      if (authorization?.allowed !== true)
        throw new Error("MOTION_DISPATCH_NOT_ALLOWED");
      const response = await step("dispatch", () => dispatch(worker));
      transcript = await step("validate", () => validate(response));
      if (!transcript || typeof transcript !== "object")
        throw new Error("MOTION_TRANSCRIPT_INVALID");
    } catch (error) {
      return fail(error);
    }
    try {
      await step("store_result", () =>
        journal.storeTranscript({ ...attempt, transcript }),
      );
    } catch (error) {
      if (error?.message === "MOTION_TRANSCRIPT_INVALID") return fail(error);
      if (
        error?.message === "MOTION_OPERATION_UNKNOWN" &&
        typeof journal.get === "function"
      ) {
        const record = await journal.get(attempt).catch(() => null);
        const prior =
          record?.runId === attempt.runId && record?.epoch === attempt.epoch
            ? record.failedOperations?.[attempt.operationId]
            : null;
        if (
          prior?.stage === "transcribe" &&
          prior.frameId === attempt.frameId &&
          prior.frameRunId === attempt.frameRunId &&
          prior.inputRevision === attempt.inputRevision
        ) {
          return fail(new Error(prior.reason));
        }
      }
      const pending = {
        state: "persistence_error",
        error: error?.message || "MOTION_JOURNAL_FAILED",
        worker,
      };
      let retryInFlight = null,
        recovered = null;
      Object.defineProperty(pending, "pendingTranscript", {
        get: () => transcript,
        enumerable: false,
      });
      Object.defineProperty(pending, "retryPersistence", {
        enumerable: false,
        configurable: true,
        value: () => {
          if (recovered) return Promise.resolve(recovered);
          if (retryInFlight) return retryInFlight;
          retryInFlight = (async () => {
            await journal.storeTranscript({ ...attempt, transcript });
            let synced2 = true;
            let cleanupPending2 = false;
            try {
              await flush();
              notifySaved();
            } catch (_) {
              synced2 = false;
            }
            if (synced2) {
              cleanupPending2 = await cleanupOwned();
            } else cleanupPending2 = true;
            const closePending2 = await closeOwned();
            recovered = {
              state: "ready",
              synced: synced2,
              cleanupPending: cleanupPending2,
              closePending: closePending2,
              ...(closePending2 && { worker }),
            };
            transcript = null;
            if (!closePending2) pending.worker = null;
            return recovered;
          })().finally(() => {
            retryInFlight = null;
          });
          return retryInFlight;
        },
      });
      return pending;
    }
    let synced = true;
    let cleanupPending = false;
    let closePending = false;
    try {
      await step("flush_ready", flush);
      notifySaved();
    } catch (_) {
      synced = false;
    }
    if (synced) {
      cleanupPending = await cleanupOwned();
    } else cleanupPending = true;
    closePending = await closeOwned();
    return {
      state: "ready",
      synced,
      cleanupPending,
      closePending,
      ...(closePending && { worker }),
    };
  }
}
globalThis.MotionTranscriptWorkerAttempt = MotionTranscriptWorkerAttempt;
