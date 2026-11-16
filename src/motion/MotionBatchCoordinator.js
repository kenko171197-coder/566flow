class MotionBatchCoordinator {
  static async run({
    userId,
    flowProjectId,
    batchId,
    entries,
    assertScope,
    shouldStop,
    validate,
    execute,
    identify = null,
    reconcile = null,
    stopOrigin = () => null,
    onUpdate = () => {},
    resumePaused = false,
    skipProjectId = null,
    canSkip = null,
    continueOnProjectFailure = false,
  }) {
    if (
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(flowProjectId || "")) ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(batchId || "")) ||
      !Array.isArray(entries) ||
      [assertScope, shouldStop, validate, execute, stopOrigin, onUpdate].some(
        (fn) => typeof fn !== "function",
      ) ||
      (reconcile !== null && typeof reconcile !== "function") ||
      (identify !== null && typeof identify !== "function") ||
      (skipProjectId !== null &&
        (resumePaused !== true ||
          typeof skipProjectId !== "string" ||
          typeof canSkip !== "function"))
    )
      throw new Error("MOTION_BATCH_INVALID");
    const items = entries.map((item) => ({
      projectId: item?.tool_project_id,
      revision: item?.revision,
      position: item?.position,
      name: typeof item?.name === "string" ? item.name.slice(0, 160) : "",
      state: "pending",
    }));
    if (
      items.some(
        (item) =>
          typeof item.projectId !== "string" ||
          !item.projectId ||
          !Number.isSafeInteger(item.revision) ||
          item.revision < 1 ||
          !Number.isSafeInteger(item.position) ||
          item.position < 0,
      ) ||
      new Set(items.map((item) => item.projectId)).size !== items.length ||
      new Set(items.map((item) => item.position)).size !== items.length ||
      entries.some((item) => item.state !== "eligible")
    )
      throw new Error("MOTION_BATCH_SNAPSHOT_INVALID");
    items.sort((a, b) => a.position - b.position);
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    const key = `motion_batch:${userId}:${batchId}`;
    return navigator.locks.request(
      `motion-batch:${userId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock)
          return { state: "busy", error: "MOTION_BATCH_ALREADY_RUNNING" };
        await assertScope();
        let record = (await chrome.storage.local.get(key))?.[key];
        await assertScope();
        if (record) {
          if (
            record.userId !== userId ||
            record.flowProjectId !== flowProjectId ||
            record.batchId !== batchId ||
            JSON.stringify(
              record.items.map(({ projectId, revision, position }) => ({
                projectId,
                revision,
                position,
              })),
            ) !==
              JSON.stringify(
                items.map(({ projectId, revision, position }) => ({
                  projectId,
                  revision,
                  position,
                })),
              )
          )
            throw new Error("MOTION_BATCH_SCOPE_MISMATCH");
        } else
          record = { userId, flowProjectId, batchId, state: "paused", items };
        const stopKey = `motion_batch_stop:${userId}:${batchId}`;
        const marker = (await chrome.storage.local.get(stopKey))?.[stopKey];
        await assertScope();
        const pauseKey = `motion_batch_pause:${userId}:${batchId}`;
        let pauseMarker = (await chrome.storage.local.get(pauseKey))?.[
          pauseKey
        ];
        await assertScope();
        if (
          marker &&
          (marker.userId !== userId ||
            marker.flowProjectId !== flowProjectId ||
            marker.batchId !== batchId ||
            marker.origin !== "manual")
        )
          throw new Error("MOTION_BATCH_SCOPE_MISMATCH");
        if (
          pauseMarker &&
          (pauseMarker.userId !== userId ||
            pauseMarker.flowProjectId !== flowProjectId ||
            pauseMarker.batchId !== batchId ||
            pauseMarker.origin !== "manual")
        )
          throw new Error("MOTION_BATCH_SCOPE_MISMATCH");
        if (pauseMarker && resumePaused === true && !marker) {
          await chrome.storage.local.remove(pauseKey);
          await assertScope();
          pauseMarker = null;
        }
        const safeCode = (value, fallback) =>
          /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(value || ""))
            ? String(value)
            : fallback;
        const stopped = () => {
          const origin = stopOrigin();
          if (origin) {
            record.stopOrigin = safeCode(origin, "manual");
            record.state = "stopped";
          } else record.state = "paused";
        };
        const publish = async () => {
          await assertScope();
          await chrome.storage.local.set({ [key]: record });
          await assertScope();
          try {
            onUpdate(structuredClone(record));
          } catch (error) {
            console.warn("[MotionBatch] status callback:", error?.message);
          }
        };
        const interrupted = record.items.filter(
          (item) => item.state === "running",
        );
        if (marker || pauseMarker) {
          if (marker) record.stopOrigin = marker.origin;
          if (interrupted.length === 1 && reconcile) {
            const item = interrupted[0];
            let result;
            try {
              result = await reconcile({
                tool_project_id: item.projectId,
                revision: item.revision,
                position: item.position,
                runId: item.runId || null,
                stop: true,
              });
            } catch (_) {
              result = null;
            }
            await assertScope();
            if (["ready", "paused", "failed"].includes(result?.state))
              item.state = result.state;
          }
          record.state = record.items.some((item) => item.state === "running")
            ? "needs_review"
            : marker
              ? "stopped"
              : "paused";
          if (record.state === "needs_review")
            record.error = "MOTION_BATCH_PROJECT_RECONCILE_REQUIRED";
          else delete record.error;
          await publish();
          return record;
        }
        if (interrupted.length) {
          if (interrupted.length !== 1 || !reconcile) {
            record.state = "needs_review";
            record.error = "MOTION_BATCH_PROJECT_RECONCILE_REQUIRED";
            await publish();
            return record;
          }
          const item = interrupted[0];
          let result;
          try {
            result = await reconcile({
              tool_project_id: item.projectId,
              revision: item.revision,
              position: item.position,
              runId: item.runId || null,
            });
          } catch (_) {
            result = null;
          }
          await assertScope();
          if (!["ready", "paused", "failed"].includes(result?.state)) {
            record.state = "needs_review";
            record.error = "MOTION_BATCH_PROJECT_RECONCILE_REQUIRED";
            await publish();
            return record;
          }
          item.state = result.state;
          record.state = result.state === "ready" ? "paused" : result.state;
          delete record.error;
          if (result.error)
            item.error = safeCode(result.error, "MOTION_BATCH_PROJECT_FAILED");
          await publish();
        }
        if (record.state === "ready" || record.state === "stopped")
          return record;
        if (skipProjectId !== null) {
          const failed = record.items.filter((item2) =>
            ["failed", "needs_review"].includes(item2.state),
          );
          const item =
            failed.length === 1 &&
            failed[0].state === "failed" &&
            failed[0].projectId === skipProjectId
              ? failed[0]
              : null;
          if (!item) throw new Error("MOTION_BATCH_SKIP_INVALID");
          await assertScope();
          let safe = false;
          try {
            safe = await canSkip({
              tool_project_id: item.projectId,
              runId: item.runId || null,
              revision: item.revision,
              failureStage: item.failureStage || null,
              cleanupError: item.cleanupError || null,
            });
          } catch (_) {}
          await assertScope();
          if (shouldStop()) {
            stopped();
            await publish();
            return record;
          }
          if (safe !== true) {
            record.state = "needs_review";
            record.error = "MOTION_BATCH_PROJECT_RECONCILE_REQUIRED";
            await publish();
            return record;
          }
          item.state = "skipped";
          record.state = "paused";
          delete record.error;
          await publish();
        }
        if (
          resumePaused === true &&
          skipProjectId === null &&
          ["failed", "needs_review", "paused"].includes(record.state)
        ) {
          const failures = record.items.filter((item) =>
            ["failed", "needs_review"].includes(item.state),
          );
          if (
            failures.length === 1 &&
            failures[0].state === "failed" &&
            failures[0].failureStage === "preflight" &&
            !failures[0].runId
          ) {
            failures[0].state = "pending";
            delete failures[0].error;
            delete failures[0].failureStage;
            record.state = "paused";
            delete record.error;
            await publish();
          } else if (
            failures.length === 1 &&
            failures[0].state === "failed" &&
            failures[0].runId &&
            typeof canSkip === "function"
          ) {
            const item = failures[0];
            let safe = false;
            try {
              safe = await canSkip({
                tool_project_id: item.projectId,
                runId: item.runId,
                revision: item.revision,
                failureStage: item.failureStage || null,
                cleanupError: item.cleanupError || null,
              });
            } catch (_) {}
            await assertScope();
            if (shouldStop()) {
              stopped();
              await publish();
              return record;
            }
            if (safe !== true) {
              record.state = "needs_review";
              record.error = "MOTION_BATCH_PROJECT_RECONCILE_REQUIRED";
              await publish();
              return record;
            }
            item.state = "paused";
            delete item.error;
            delete item.failureStage;
            delete item.failures;
            record.state = "paused";
            delete record.error;
            await publish();
          }
        }
        if (
          record.items.some((item) =>
            ["failed", "needs_review"].includes(item.state),
          )
        )
          return record;
        if (
          continueOnProjectFailure &&
          resumePaused === true &&
          skipProjectId === null
        ) {
          for (const item of record.items.filter(
            (entry) => entry.state === "paused" && entry.failureState,
          )) {
            if (shouldStop()) {
              stopped();
              await publish();
              return record;
            }
            let safe = !item.runId && item.failureStage === "preflight";
            if (item.runId && typeof canSkip === "function") {
              try {
                safe = await canSkip({
                  tool_project_id: item.projectId,
                  runId: item.runId,
                  revision: item.revision,
                  failureStage: item.failureStage || null,
                  cleanupError: item.cleanupError || null,
                });
              } catch (_) {
                safe = false;
              }
            }
            await assertScope();
            if (shouldStop()) {
              stopped();
              await publish();
              return record;
            }
            if (safe !== true) continue;
            delete item.failureState;
            item.state = item.runId ? "paused" : "pending";
            await publish();
          }
        }
        for (const item of record.items) {
          if (item.state === "ready" || item.state === "skipped") continue;
          if (item.state === "paused" && item.failureState) continue;
          if (shouldStop()) {
            stopped();
            await publish();
            return record;
          }
          await assertScope();
          const verdict = await validate({
            tool_project_id: item.projectId,
            revision: item.revision,
            position: item.position,
            runId: item.runId || null,
            state: item.state,
          });
          await assertScope();
          if (shouldStop()) {
            stopped();
            await publish();
            return record;
          }
          if (verdict?.state === "skipped") {
            item.state = "skipped";
            await publish();
            continue;
          }
          if (verdict?.state !== "eligible") {
            if (!continueOnProjectFailure) {
              item.state =
                verdict?.state === "needs_review" ? "needs_review" : "failed";
              item.error = safeCode(
                verdict?.error,
                "MOTION_BATCH_PREFLIGHT_FAILED",
              );
              item.failureStage = "preflight";
              record.state = item.state;
              await publish();
              return record;
            }
            item.failureState =
              verdict?.state === "needs_review" ? "needs_review" : "failed";
            item.state = "paused";
            item.error = safeCode(
              verdict?.error,
              "MOTION_BATCH_PREFLIGHT_FAILED",
            );
            item.failureStage = "preflight";
            await publish();
            continue;
          }
          if (identify && !item.runId) {
            item.runId = await identify({
              tool_project_id: item.projectId,
              revision: item.revision,
              position: item.position,
            });
            if (
              !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
                String(item.runId || ""),
              )
            )
              throw new Error("MOTION_BATCH_RUN_INVALID");
            await assertScope();
            if (shouldStop()) {
              stopped();
              await publish();
              return record;
            }
          }
          item.state = "running";
          record.state = "running";
          await publish();
          let outcome;
          try {
            outcome = await execute({
              tool_project_id: item.projectId,
              revision: item.revision,
              position: item.position,
              runId: item.runId || null,
              resume: verdict.resume === true,
            });
          } catch (error) {
            outcome = {
              state: "needs_review",
              error:
                error?.code ||
                error?.message ||
                "MOTION_BATCH_PROJECT_UNVERIFIED",
            };
          }
          await assertScope();
          item.state = ["ready", "paused", "failed", "needs_review"].includes(
            outcome?.state,
          )
            ? outcome.state
            : "needs_review";
          if (outcome?.error)
            item.error = safeCode(outcome.error, "MOTION_BATCH_PROJECT_FAILED");
          if (outcome?.cleanupError)
            item.cleanupError = safeCode(
              outcome.cleanupError,
              "MOTION_WORKER_CLOSE_PENDING",
            );
          if (outcome?.pauseError)
            item.pauseError = safeCode(
              outcome.pauseError,
              "MOTION_PAUSE_FAILED",
            );
          if (item.state === "ready") {
            for (const key2 of [
              "failureState",
              "error",
              "failures",
              "failureStage",
              "cleanupError",
              "pauseError",
            ])
              delete item[key2];
          }
          if (Array.isArray(outcome?.failures))
            item.failures = outcome.failures.slice(0, 100).map((failure) => ({
              frameId: /^[A-Za-z0-9_-]{1,80}$/.test(
                String(failure?.frameId || ""),
              )
                ? failure.frameId
                : null,
              stage: safeCode(failure?.stage, "unknown"),
              error: safeCode(failure?.error, "MOTION_BATCH_PROJECT_FAILED"),
            }));
          if (item.state !== "ready") {
            if (shouldStop()) {
              stopped();
              await publish();
              return record;
            }
            if (!continueOnProjectFailure) {
              record.state = item.state;
              await publish();
              return record;
            }
            item.failureState = item.state;
            item.state = "paused";
            await publish();
            continue;
          }
          await publish();
        }
        if (shouldStop()) stopped();
        else
          record.state = record.items.some((item) => item.failureState)
            ? "paused"
            : "ready";
        await publish();
        return record;
      },
    );
  }
}
globalThis.MotionBatchCoordinator = MotionBatchCoordinator;
