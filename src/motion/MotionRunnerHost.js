var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) =>
  key in obj
    ? __defProp(obj, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      })
    : (obj[key] = value);
var __publicField = (obj, key, value) =>
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class MotionRunnerHost {
  static projectScopeError({
    auth,
    latest,
    project,
    userId,
    projectId,
    flowProjectId,
    stage,
  }) {
    const checks = {
      sessionPresent: !!latest?.token,
      sameUser: Number(latest?.user?.id) === userId,
      sameSession: !!auth?.token && latest?.token === auth.token,
      sameMotionProject: project?.tool_project_id === projectId,
      sameFlowProject: project?.flow_project_id === flowProjectId,
    };
    const code =
      !checks.sessionPresent || !checks.sameUser || !checks.sameSession
        ? "ACCOUNT_SCOPE_CHANGED"
        : !checks.sameMotionProject || !checks.sameFlowProject
          ? "MOTION_FLOW_PROJECT_MISMATCH"
          : null;
    if (code)
      console.warn(
        "[MotionScopeCheck]",
        JSON.stringify({ stage, projectId, code, ...checks }),
      );
    return code;
  }
  static controlFlowJob(state, entry) {
    if (state.stopOrigin === "manual") {
      const task = Promise.resolve(
        entry.queue.stopJobAndPersist(entry.jobId, {
          stopOrigin: "user",
          stopReason: "USER_CANCELLED",
          stopSource: "MOTION_FORCE_STOP",
        }),
      );
      state.flowStopTasks || (state.flowStopTasks = new Set());
      state.flowStopTasks.add(task);
      void task
        .catch((error) =>
          console.warn("[MotionControl]", {
            stage: "stop_failed",
            jobId: entry.jobId,
            code: error?.code || error?.message,
          }),
        )
        .finally(() => state.flowStopTasks.delete(task));
      return task;
    }
    if (state.stopped)
      entry.queue.pauseJob(entry.jobId, "manual", "MOTION_PAUSE");
  }
  static failureDetails(result) {
    const code = (value) =>
      /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(value || ""))
        ? String(value)
        : "MOTION_RUN_FAILED";
    const failed = (Array.isArray(result?.items) ? result.items : []).filter(
      (item) =>
        ["failed", "needs_review", "sync_pending"].includes(item.transcript) ||
        ["failed", "needs_review"].includes(item.upload) ||
        ["failed", "needs_review"].includes(item.state),
    );
    const details = failed.map((item) => ({
      frameId: item.frameId,
      stage: item.sourceError
        ? "source"
        : item.transcriptError
          ? "transcript"
          : item.uploadError
            ? "upload"
            : item.flowError
              ? "flow"
              : result.stage,
      error: code(
        item.sourceError ||
          item.transcriptError ||
          item.uploadError ||
          item.flowError ||
          item.error ||
          result.error,
      ),
      ...(item.transcriptError &&
        ["provider_task", "monitor"].includes(
          item.transcriptDiagnostic?.stage,
        ) && {
          diagnostic: {
            stage: item.transcriptDiagnostic.stage,
            code: code(item.transcriptDiagnostic.code),
          },
        }),
      ...(Number.isSafeInteger(item.transcriptRetries) && {
        retries: item.transcriptRetries,
      }),
    }));
    if (
      result?.failure?.frameId &&
      !details.some((item) => item.frameId === result.failure.frameId)
    )
      details.push({
        frameId: result.failure.frameId,
        stage: result.stage,
        error: code(result.failure.error || result.error),
      });
    return details;
  }
  static async publish(host, projectId, data) {
    const label = globalThis.document?.getElementById?.("motionRunnerState");
    if (label) {
      const key =
        data.state === "ready"
          ? "motionEditor.text007"
          : ["failed", "needs_review"].includes(data.state)
            ? "motionEditor.text057"
            : "motionEditor.text056";
      const translated = globalThis.I18n?.t?.(key);
      label.textContent =
        translated && translated !== key ? translated : data.state;
    }
    const status = {
      userId: host.userId,
      projectId,
      epoch: host.epoch,
      ...data,
      nonce: crypto.randomUUID(),
    };
    await chrome.storage.local.set({
      motion_runner_status: status,
      [`motion_runner_status:${host.userId}:${projectId}`]: status,
    });
    await MotionRunnerRecovery.update({
      userId: host.userId,
      projectId,
      runId: data.runId,
      hostEpoch: host.epoch,
      state: data.state,
    });
  }
  static async registerRecovery(host, message, runId, batchId = null) {
    const config = await window.ExecutionConfig.getConfig();
    await MotionRunnerRecovery.register({
      userId: host.userId,
      projectId: message.projectId,
      flowProjectId: message.flowProjectId,
      hostEpoch: host.epoch,
      runId,
      batchId,
      maxRetries:
        window.featureGate.canUse("retry_on_fail") === true
          ? config?.workflow?.max_retries
          : 0,
      screen: message.screen || {},
      automaticRecovery: message.automaticRecovery === true,
    });
  }
  static async downloadFinal(blob, project, assertScope) {
    await assertScope();
    let output = blob;
    const settings =
      (await chrome.storage.local.get("af_settings"))?.af_settings || {};
    const savedWatermark =
      project?.data_json?.preferences?.remove_final_video_watermark;
    const forceClean = savedWatermark === true;
    const shouldClean =
      typeof savedWatermark === "boolean"
        ? savedWatermark
        : [true, 1, "1"].includes(settings.autoRemoveWatermarkVideo);
    if (shouldClean) {
      const config = await chrome.runtime.sendMessage({
        action: "getWatermarkConfig",
        mediaType: "video",
      });
      if (config?.success && window.VideoWmClient) {
        const result = await window.VideoWmClient.process(blob, config.cfg);
        if (result?.applied && result.blob) output = result.blob;
        else if (
          forceClean &&
          !["not_found", "below_threshold", "already_clean_output"].includes(
            result?.reason,
          )
        )
          throw new Error(result?.reason || "VIDEO_WM_NOT_APPLIED");
      } else if (forceClean)
        throw new Error(config?.error || "VIDEO_WM_CONFIG_UNAVAILABLE");
    }
    await assertScope();
    const url = URL.createObjectURL(output);
    try {
      const filename = await window.DownloadHelper.buildMotionFilename(project);
      const result = await chrome.runtime.sendMessage({
        action: "chromeDownload",
        url,
        filename,
        waitForComplete: true,
        waitTimeoutMs: 6e5,
        flowApiDownloadRetry: true,
      });
      if (result?.success !== true)
        throw new Error(result?.error || "MOTION_FINAL_DOWNLOAD_FAILED");
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  static async releaseLayout(host, projectId, runId) {
    const run = await MotionRunJournal.get({
      userId: host.userId,
      toolProjectId: projectId,
    });
    if (run?.runId !== runId || !run.preparationSnapshot?.layout) return;
    const result = await chrome.runtime.sendMessage({
      action: "motionWorker:releaseLayout",
      hostEpoch: host.epoch,
      toolProjectId: projectId,
      runId,
    });
    if (result?.success !== true)
      throw new Error(result?.error || "MOTION_LAYOUT_RELEASE_FAILED");
  }
  static dispatch(message, sender) {
    if (
      (((message.action === "motionRunner:pauseProject" &&
        message.stop === true) ||
        message.action === "motionRunner:resetFrameHost") &&
        this._projects.has(message.projectId)) ||
      (message.action === "motionRunner:stopBatchHost" &&
        this._batch?.id === message.batchId)
    ) {
      return this.command(message, sender);
    }
    const result = this._commandTail.then(() => this.command(message, sender));
    this._commandTail = result.catch(() => {});
    return result;
  }
  static admit(runId) {
    if (this._quiesced) throw new Error("MOTION_RUNNER_QUIESCED");
    if (typeof runId !== "string" || !runId || this._runs.has(runId))
      throw new Error("MOTION_RUNNER_RUN_INVALID");
    this._runs.add(runId);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this._runs.delete(runId);
      }
    };
  }
  static async command(message, sender, batchOwner = null) {
    if (sender?.id !== chrome.runtime.id || sender.tab)
      return { success: false, error: "MOTION_RUNNER_SENDER_INVALID" };
    const [tab, stored] = await Promise.all([
      chrome.tabs.getCurrent(),
      chrome.storage.session.get("tobyflow_motion_runner_host"),
    ]);
    const host = stored?.tobyflow_motion_runner_host;
    if (
      !host ||
      !Number.isSafeInteger(host.epoch) ||
      host.epoch < 1 ||
      !Number.isSafeInteger(host.userId) ||
      host.userId < 1 ||
      tab?.id !== host.tabId ||
      tab?.windowId !== host.windowId ||
      message.tabId !== host.tabId ||
      message.epoch !== host.epoch
    ) {
      return { success: false, error: "MOTION_RUNNER_OWNER_MISMATCH" };
    }
    if (message.action === "motionRunner:quiesce") {
      if (this._runs.size || this._batch) {
        return {
          success: true,
          idle: false,
          quiesced: false,
          epoch: host.epoch,
        };
      }
      this._quiesced = true;
      try {
        if (await MotionRunJournal.hasPendingWork(host.userId)) {
          this._quiesced = false;
          return {
            success: true,
            idle: false,
            quiesced: false,
            epoch: host.epoch,
          };
        }
      } catch (error) {
        this._quiesced = false;
        throw error;
      }
      return { success: true, idle: true, quiesced: true, epoch: host.epoch };
    }
    const auth = (await chrome.storage.local.get("af_auth"))?.af_auth;
    if (!auth?.token || Number(auth.user?.id) !== host.userId)
      return { success: false, error: "MOTION_RUNNER_ACCOUNT_CHANGED" };
    if (message.action === "motionRunner:recoveryState")
      return {
        success: true,
        epoch: host.epoch,
        projects: [...this._projects].map(([projectId, state]) => ({
          projectId,
          runId: state.id,
        })),
        batchId: this._batch?.id || null,
      };
    if (message.action === "motionRunner:unquiesce") {
      this._quiesced = false;
      return { success: true, resumed: true, epoch: host.epoch };
    }
    if (message.action === "motionRunner:resetFrameHost") {
      if (
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          String(message.projectId || ""),
        ) ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(String(message.flowProjectId || ""))
      )
        return { success: false, error: "FRAME_SCOPE_CHANGED" };
      const state = this._projects.get(message.projectId);
      if (
        state &&
        ((message.runId && state.id !== message.runId) ||
          state.flowProjectId !== message.flowProjectId)
      )
        return { success: false, error: "MOTION_RUN_FENCED" };
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(message.frameId || "")))
        return { success: false, error: "FRAME_SCOPE_CHANGED" };
      await MotionRunnerRuntime.ensureReady(host.userId);
      console.info(
        "[MotionResultEdit]",
        JSON.stringify({
          action: "reset",
          frameId: message.frameId,
          stage: "runner_reset",
          runId: state?.id || null,
          active: !!state,
        }),
      );
      if (state) {
        state.resetFrames || (state.resetFrames = new Set());
        state.resetFrames.add(message.frameId);
        const jobs = [...(state.flowJobs?.values() || [])].filter(
          (entry) => entry.frameId === message.frameId,
        );
        await Promise.all(
          jobs.map((entry) =>
            entry.queue.stopJobAndPersist(entry.jobId, {
              stopOrigin: "user",
              stopReason: "USER_CANCELLED",
              stopSource: "MOTION_FRAME_RESET",
            }),
          ),
        );
        await Promise.all(jobs.map((entry) => entry.finished));
      }
      const scope = { userId: host.userId, toolProjectId: message.projectId };
      const path = `tools/motion-studio/projects/${encodeURIComponent(message.projectId)}`;
      const assertScope = async () => {
        const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
        if (
          latest?.token !== auth.token ||
          Number(latest.user?.id) !== host.userId
        )
          throw new Error("ACCOUNT_SCOPE_CHANGED");
      };
      const api = async (...args) => {
        await assertScope();
        const result = await window.authManager._apiCall(...args);
        await assertScope();
        return result;
      };
      const reset = async () => {
        const current = await api("GET", path);
        if (
          current?.tool_project_id !== message.projectId ||
          current.flow_project_id !== message.flowProjectId
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        const record = await MotionRunJournal.get(scope);
        const journalOwner =
          state && record?.ownerId && record.runId === state.id
            ? {
                ...scope,
                runId: record.runId,
                ownerId: record.ownerId,
                epoch: record.epoch,
              }
            : null;
        await MotionFrameResultActions.run({
          project: current,
          frameId: message.frameId,
          action: "reset",
          target: { projectId: message.flowProjectId },
          userId: host.userId,
          api,
          assertScope,
          journalOwner,
          preserveGenerated: message.preserveGenerated === true,
        });
        if (
          state &&
          !state.finishing &&
          this._projects.get(message.projectId) === state
        ) {
          state.startedAt = Date.now();
          delete state.frozenElapsedMs;
          await state.publish({
            state: state.stopped ? "pausing" : "running",
            timerReset: true,
            stage: null,
            frameId: null,
            detail: null,
          });
        }
        await chrome.storage.local.set({
          motion_project_changed: {
            userId: host.userId,
            projectId: message.projectId,
            nonce: crypto.randomUUID(),
          },
        });
        return { success: true };
      };
      return state
        ? reset()
        : navigator.locks.request(
            `motion-run:${host.userId}:${message.projectId}`,
            {},
            (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_RUNNING");
              return reset();
            },
          );
    }
    if (message.action === "motionRunner:pauseProject") {
      const state = this._projects.get(message.projectId);
      if (!state || state.id !== message.runId || state.finishing)
        return { success: false, error: "MOTION_RUN_NOT_FOUND" };
      if (
        message.flowProjectId !== void 0 &&
        message.flowProjectId !== state.flowProjectId
      )
        return { success: false, error: "MOTION_FLOW_PROJECT_MISMATCH" };
      state.stopped = true;
      if (!Number.isFinite(state.frozenElapsedMs))
        state.frozenElapsedMs = Math.max(0, Date.now() - state.startedAt);
      if (message.stop === true) {
        state.stopOrigin = "manual";
        state.finalAbort?.abort();
        for (const control of window.MessageBridge?._uploadControls || []) {
          const scope = control.motionScope;
          if (
            scope?.userId === host.userId &&
            scope.toolProjectId === message.projectId &&
            scope.runId === state.id
          )
            control.cancel();
        }
      }
      const pausing = state.publish({ state: "pausing" });
      const flowStops = [...(state.flowJobs?.values() || [])].map((entry) =>
        this.controlFlowJob(state, entry),
      );
      await Promise.all([pausing, ...flowStops]);
      try {
        const path = `tools/motion-studio/projects/${encodeURIComponent(message.projectId)}`;
        const project = await window.authManager._apiCall("GET", path);
        const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
        if (
          latest?.token !== auth.token ||
          Number(latest?.user?.id) !== host.userId ||
          project?.tool_project_id !== message.projectId ||
          project.flow_project_id !== state.flowProjectId
        )
          throw new Error("ACCOUNT_SCOPE_CHANGED");
        if (project.data_json?.paused !== true)
          await window.authManager._apiCall("PATCH", path, {
            revision: project.revision,
            pause: true,
          });
        if (message.providerPause === true && !state.stopOrigin) {
          await state.publish({
            state: "paused",
            stage: "flow",
            detail: "paused",
            frameId: message.frameId,
            pauseReason:
              message.pauseReason === "flow_quota"
                ? "flow_quota"
                : "api_unusual_activity",
            error: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(message.error || "")
              ? message.error
              : null,
          });
        }
        return { success: true, runId: state.id };
      } catch (error) {
        return {
          success: false,
          runId: state.id,
          error: error?.code || error?.message || "MOTION_PAUSE_SYNC_FAILED",
        };
      }
    }
    const initializingAt = Date.now();
    console.info("[MotionRunnerHost]", {
      stage: "runtime_initializing",
      action: message.action,
      projectId: message.projectId || null,
    });
    try {
      await MotionRunnerRuntime.ensureReady(host.userId);
    } catch (error) {
      console.warn("[MotionRunnerHost]", {
        stage: "runtime_failed",
        action: message.action,
        elapsedMs: Date.now() - initializingAt,
        reason: error?.code || error?.message,
      });
      throw error;
    }
    console.info("[MotionRunnerHost]", {
      stage: "runtime_ready",
      action: message.action,
      elapsedMs: Date.now() - initializingAt,
    });
    const currentAuth = (await chrome.storage.local.get("af_auth"))?.af_auth;
    if (
      currentAuth?.token !== auth.token ||
      Number(currentAuth?.user?.id) !== host.userId
    )
      return { success: false, error: "MOTION_RUNNER_ACCOUNT_CHANGED" };
    this._quiesced = false;
    if (
      ["motionRunner:startBatchHost", "motionRunner:resumeBatchHost"].includes(
        message.action,
      )
    ) {
      if (this._batch || this._projects.size)
        return { success: false, error: "MOTION_BATCH_ALREADY_RUNNING" };
      const flowProjectId = String(message.flowProjectId || "");
      if (!/^[A-Za-z0-9_-]{1,120}$/.test(flowProjectId))
        return { success: false, error: "MOTION_FLOW_PROJECT_MISMATCH" };
      const resuming = message.action === "motionRunner:resumeBatchHost";
      if (
        (resuming || message.automaticRecovery === true) &&
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          String(message.batchId || ""),
        )
      )
        return { success: false, error: "MOTION_BATCH_INVALID" };
      const state = {
        id:
          resuming || message.automaticRecovery === true
            ? message.batchId
            : crypto.randomUUID(),
        flowProjectId,
        stopped: false,
        current: null,
        statusTail: Promise.resolve(),
      };
      await this.registerRecovery(host, message, state.id, state.id);
      this._batch = state;
      let pinnedTarget = null;
      const publishBatch = (value) => {
        const snapshot = { ...value, epoch: host.epoch };
        state.statusTail = state.statusTail
          .catch(() => {})
          .then(async () => {
            await chrome.storage.local.set({ motion_batch_status: snapshot });
            await MotionRunnerRecovery.update({
              userId: host.userId,
              projectId: message.projectId,
              batchId: state.id,
              runId: state.id,
              hostEpoch: host.epoch,
              state: snapshot.state,
            });
          });
        return state.statusTail;
      };
      const assertScope = async () => {
        const current = (await chrome.storage.local.get("af_auth"))?.af_auth;
        const registered = (
          await chrome.storage.session.get("tobyflow_motion_runner_host")
        )?.tobyflow_motion_runner_host;
        if (
          current?.token !== auth.token ||
          Number(current?.user?.id) !== host.userId ||
          registered?.tabId !== host.tabId ||
          registered?.windowId !== host.windowId ||
          registered?.epoch !== host.epoch
        )
          throw new Error("ACCOUNT_SCOPE_CHANGED");
        const target = pinnedTarget
          ? await MessageBridge.getTargetContext(pinnedTarget)
          : await MessageBridge.getProjectTargetContext(flowProjectId);
        if (
          target?.projectId !== flowProjectId ||
          !Number.isInteger(target.tabId) ||
          !target.driverKey
        )
          throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
        if (!pinnedTarget) pinnedTarget = target;
        else if (
          ["tabId", "projectId", "driverKey", "origin"].some(
            (key) => target[key] !== pinnedTarget[key],
          )
        )
          throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
      };
      state.promise = (async () => {
        try {
          await assertScope();
          let entries;
          if (resuming) {
            const key = `motion_batch:${host.userId}:${state.id}`;
            const stored2 = (await chrome.storage.local.get(key))?.[key];
            await assertScope();
            if (
              stored2?.userId !== host.userId ||
              stored2?.flowProjectId !== flowProjectId ||
              stored2?.batchId !== state.id ||
              !Array.isArray(stored2.items)
            )
              throw new Error("MOTION_BATCH_SCOPE_MISMATCH");
            entries = stored2.items.map((item) => ({
              tool_project_id: item.projectId,
              revision: item.revision,
              position: item.position,
              state: "eligible",
            }));
          } else {
            const data = await window.authManager._apiCall(
              "GET",
              `tools/motion-studio/projects/batch-snapshot?flow_project_id=${encodeURIComponent(flowProjectId)}`,
            );
            await assertScope();
            const snapshot = await MotionBatchSnapshot.classify({
              data,
              userId: host.userId,
              flowProjectId,
              artifactStore: MotionArtifactStore,
            });
            const blocked = snapshot.entries.filter(
              (item) => !["eligible", "complete"].includes(item.state),
            );
            if (blocked.length)
              return {
                state: "needs_review",
                error: "MOTION_BATCH_FINAL_UNVERIFIED",
                blocked,
              };
            entries = snapshot.entries.filter(
              (item) => item.state === "eligible",
            );
          }
          return await MotionBatchCoordinator.run({
            userId: host.userId,
            flowProjectId,
            batchId: state.id,
            entries,
            assertScope,
            resumePaused: resuming && message.automaticRecovery !== true,
            continueOnProjectFailure: true,
            skipProjectId:
              resuming && message.skipProjectId ? message.skipProjectId : null,
            canSkip: async (item) => {
              if (item.cleanupError) return false;
              if (!item.runId) return item.failureStage === "preflight";
              const run = await MotionRunJournal.get({
                userId: host.userId,
                toolProjectId: item.tool_project_id,
              });
              const outbox = await MotionRunJournal.listTranscriptOutbox({
                userId: host.userId,
                toolProjectId: item.tool_project_id,
              });
              await assertScope();
              if (
                !run ||
                run.runId !== item.runId ||
                run.flowProjectId !== flowProjectId ||
                run.ownerId ||
                !["failed", "paused"].includes(run.state) ||
                !Array.isArray(outbox) ||
                outbox.length ||
                !run.operations ||
                typeof run.operations !== "object" ||
                Array.isArray(run.operations) ||
                Object.keys(run.operations).length ||
                Object.values(run.reservations || {}).some(
                  (entry) =>
                    entry.token ||
                    entry.pendingAttemptId ||
                    entry.pendingSettlement,
                )
              )
                return false;
              const project = await window.authManager._apiCall(
                "GET",
                `tools/motion-studio/projects/${encodeURIComponent(item.tool_project_id)}`,
              );
              await assertScope();
              return (
                project?.tool_project_id === item.tool_project_id &&
                project.flow_project_id === flowProjectId &&
                Number(project.data_json?.source_revision) ===
                  run.sourceRevision
              );
            },
            shouldStop: () => state.stopped,
            stopOrigin: () => state.stopOrigin || null,
            onUpdate: (record) => {
              state.admitted = record.items.some(
                (item) => item.state === "running",
              );
              void publishBatch(record).catch(() => {});
            },
            identify: async (item) => {
              const existing = await MotionRunJournal.get({
                userId: host.userId,
                toolProjectId: item.tool_project_id,
              });
              if (
                existing &&
                existing.state !== "completed" &&
                existing.flowProjectId !== flowProjectId
              )
                throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
              return existing && existing.state !== "completed"
                ? existing.runId
                : crypto.randomUUID();
            },
            reconcile: async (item) => {
              if (!item.runId) return { state: "needs_review" };
              const run = await MotionRunJournal.get({
                userId: host.userId,
                toolProjectId: item.tool_project_id,
              });
              if (!run) return { state: "paused" };
              if (
                run.runId !== item.runId ||
                run.flowProjectId !== flowProjectId
              )
                return { state: "needs_review" };
              if (run.state === "completed") {
                const project = await window.authManager._apiCall(
                  "GET",
                  `tools/motion-studio/projects/${encodeURIComponent(item.tool_project_id)}`,
                );
                const final = project?.data_json?.final;
                if (
                  MotionRunJournal.isGenerationComplete?.(project?.data_json) &&
                  run.generationCompletion &&
                  JSON.stringify(run.generationCompletion) ===
                    JSON.stringify(project.data_json.generation_completion)
                ) {
                  const local = await Promise.all(
                    Object.entries(project.data_json.frames).map(
                      ([frameId, frame]) =>
                        MotionArtifactStore.get({
                          userId: host.userId,
                          toolProjectId: item.tool_project_id,
                          sourceRevision: run.sourceRevision,
                          frameId,
                          kind: "generated_clip",
                          artifactRevision: frame.input_revision,
                        }),
                    ),
                  );
                  return project.flow_project_id === flowProjectId &&
                    local.every(
                      (record) =>
                        record?.blob?.size &&
                        record.flowProjectId === flowProjectId,
                    )
                    ? { state: "ready" }
                    : { state: "needs_review" };
                }
                const frames = Object.fromEntries(
                  Object.entries(project?.data_json?.frames || {}).map(
                    ([id, frame]) => [
                      id,
                      {
                        input_revision: frame.input_revision,
                        persist_state: frame.stages?.persist?.state,
                      },
                    ],
                  ),
                );
                const checked = await MotionBatchSnapshot.classify({
                  userId: host.userId,
                  flowProjectId,
                  artifactStore: MotionArtifactStore,
                  data: {
                    flow_project_id: flowProjectId,
                    disabled_count: 0,
                    items: [],
                    final_candidates: [
                      {
                        tool_project_id: item.tool_project_id,
                        revision: Number(project?.revision),
                        position: item.position,
                        source_revision: Number(
                          project?.data_json?.source_revision,
                        ),
                        requires_resplit: project?.data_json?.requires_resplit,
                        final,
                        frames,
                      },
                    ],
                  },
                });
                const candidate = checked.entries[0];
                return candidate?.state === "complete" &&
                  project.flow_project_id === flowProjectId &&
                  final?.artifact_id === run.finalArtifactId &&
                  final?.source_revision === run.sourceRevision
                  ? { state: "ready" }
                  : { state: "needs_review" };
              }
              if (run.ownerId && run.leaseUntil > Date.now())
                return { state: "needs_review" };
              {
                const started = await this.command(
                  {
                    action: "motionRunner:startProject",
                    tabId: host.tabId,
                    epoch: host.epoch,
                    projectId: item.tool_project_id,
                    flowProjectId,
                    screen: message.screen,
                    runId: item.runId,
                    drainOnly: true,
                  },
                  sender,
                  state.id,
                );
                if (!started?.success || !started.completion)
                  return { state: "needs_review" };
                state.admitted = true;
                const outcome = await started.completion;
                const latest = await MotionRunJournal.get({
                  userId: host.userId,
                  toolProjectId: item.tool_project_id,
                });
                const outbox = await MotionRunJournal.listTranscriptOutbox({
                  userId: host.userId,
                  toolProjectId: item.tool_project_id,
                });
                if (
                  !latest ||
                  latest.runId !== item.runId ||
                  Object.keys(latest.operations || {}).length ||
                  outbox.length ||
                  Object.values(latest.reservations || {}).some(
                    (entry) =>
                      entry.token ||
                      entry.pendingAttemptId ||
                      entry.pendingSettlement,
                  ) ||
                  outcome?.state === "needs_review"
                )
                  return { state: "needs_review" };
                if (run.stopOrigin)
                  return { state: "failed", error: "MOTION_RUN_STOPPED" };
                return {
                  state:
                    outcome?.state === "ready"
                      ? "ready"
                      : outcome?.state === "failed"
                        ? "failed"
                        : "paused",
                  ...(outcome?.error && { error: outcome.error }),
                };
              }
            },
            validate: async (item) => {
              const entitlement = await window.authManager._apiCall(
                "GET",
                `tools/motion-studio/projects/batch-snapshot?flow_project_id=${encodeURIComponent(flowProjectId)}`,
              );
              if (entitlement?.flow_project_id !== flowProjectId)
                return {
                  state: "needs_review",
                  error: "MOTION_BATCH_SCOPE_MISMATCH",
                };
              const project = await window.authManager._apiCall(
                "GET",
                `tools/motion-studio/projects/${encodeURIComponent(item.tool_project_id)}`,
              );
              if (
                project?.tool_project_id !== item.tool_project_id ||
                project.flow_project_id !== flowProjectId
              )
                return {
                  state: "needs_review",
                  error: "MOTION_FLOW_PROJECT_MISMATCH",
                };
              if (project.data_json?.batch_enabled !== true)
                return { state: "skipped" };
              if (
                message.automaticRecovery === true &&
                project.data_json?.paused === true
              )
                return { state: "failed", error: "MOTION_PROJECT_PAUSED" };
              const resumeProject =
                resuming && item.state === "paused" && !!item.runId;
              if (resumeProject) {
                const run = await MotionRunJournal.get({
                  userId: host.userId,
                  toolProjectId: item.tool_project_id,
                });
                if (
                  (project.data_json?.final &&
                    project.data_json.final.stale !== true) ||
                  (!run && Number(project.revision) !== item.revision) ||
                  (run &&
                    (run.runId !== item.runId ||
                      run.flowProjectId !== flowProjectId ||
                      Number(project.data_json?.source_revision) !==
                        run.sourceRevision))
                ) {
                  MotionRunnerRuntime.snapshotChanged?.({
                    userId: host.userId,
                    toolProjectId: item.tool_project_id,
                    reason: "batch_resume",
                    fields: [
                      ...(project.data_json?.final &&
                      project.data_json.final.stale !== true
                        ? ["final"]
                        : []),
                      ...(!run && Number(project.revision) !== item.revision
                        ? ["projectRevision"]
                        : []),
                      ...(run && run.runId !== item.runId ? ["runId"] : []),
                      ...(run && run.flowProjectId !== flowProjectId
                        ? ["flowProjectId"]
                        : []),
                      ...(run &&
                      Number(project.data_json?.source_revision) !==
                        run.sourceRevision
                        ? ["sourceRevision"]
                        : []),
                    ],
                  });
                  return {
                    state: "needs_review",
                    error: "MOTION_RUN_SNAPSHOT_CHANGED",
                  };
                }
              } else if (
                Number(project.revision) !== item.revision ||
                (project.data_json?.final &&
                  project.data_json.final.stale !== true)
              )
                return {
                  state: "needs_review",
                  error: "MOTION_BATCH_PROJECT_CHANGED",
                };
              if (project.data_json?.paused && !resumeProject)
                return { state: "failed", error: "MOTION_PROJECT_PAUSED" };
              return { state: "eligible", resume: resumeProject };
            },
            execute: async (item) => {
              if (state.stopped) return { state: "paused" };
              const started = await this.command(
                {
                  action: "motionRunner:startProject",
                  tabId: host.tabId,
                  epoch: host.epoch,
                  projectId: item.tool_project_id,
                  flowProjectId,
                  screen: message.screen,
                  runId: item.runId,
                  resume: item.resume,
                  automaticRecovery: message.automaticRecovery === true,
                },
                sender,
                state.id,
              );
              if (!started?.success)
                return {
                  state: "failed",
                  error: started?.error || "MOTION_RUN_FAILED",
                };
              state.admitted = true;
              state.current = {
                projectId: item.tool_project_id,
                runId: started.runId,
              };
              if (
                !started.completion ||
                typeof started.completion.then !== "function"
              )
                return { state: "needs_review", error: "MOTION_RUN_NOT_FOUND" };
              if (state.stopped && this._projects.has(item.tool_project_id))
                await this.command(
                  {
                    action: "motionRunner:pauseProject",
                    tabId: host.tabId,
                    epoch: host.epoch,
                    ...state.current,
                  },
                  sender,
                  state.id,
                );
              try {
                const result = await started.completion;
                if (!result || result.state === "ready") return result;
                const failures = this.failureDetails(result);
                let pauseError = null;
                if (!state.stopped) {
                  try {
                    await assertScope();
                    const path = `tools/motion-studio/projects/${encodeURIComponent(item.tool_project_id)}`;
                    const current = await window.authManager._apiCall(
                      "GET",
                      path,
                    );
                    await assertScope();
                    if (
                      current?.tool_project_id !== item.tool_project_id ||
                      current.flow_project_id !== flowProjectId
                    )
                      throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
                    if (current.data_json?.paused !== true)
                      await window.authManager._apiCall("PATCH", path, {
                        revision: current.revision,
                        pause: true,
                      });
                    await assertScope();
                  } catch (error) {
                    pauseError =
                      error?.code || error?.message || "MOTION_PAUSE_FAILED";
                  }
                }
                return {
                  ...result,
                  error: result.error || failures[0]?.error || null,
                  failures,
                  ...(pauseError && { pauseError }),
                };
              } finally {
                state.current = null;
              }
            },
          });
        } catch (error) {
          const code = String(error?.code || error?.message || "");
          return {
            state: state.admitted ? "needs_review" : "failed",
            error: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(code)
              ? code
              : "MOTION_BATCH_FAILED",
          };
        }
      })()
        .then(async (result) => {
          await publishBatch({
            userId: host.userId,
            flowProjectId,
            batchId: state.id,
            ...result,
          }).catch(() => {});
          return result;
        })
        .finally(() => {
          if (this._batch === state) this._batch = null;
        });
      return { success: true, batchId: state.id, epoch: host.epoch };
    }
    if (
      ["motionRunner:pauseBatchHost", "motionRunner:stopBatchHost"].includes(
        message.action,
      )
    ) {
      const state = this._batch;
      if (!state || state.id !== message.batchId)
        return { success: false, error: "MOTION_BATCH_NOT_FOUND" };
      if (message.action === "motionRunner:stopBatchHost")
        state.stopOrigin = "manual";
      state.stopped = true;
      if (state.stopOrigin) {
        const key = `motion_batch_stop:${host.userId}:${state.id}`;
        try {
          await chrome.storage.local.set({
            [key]: {
              userId: host.userId,
              flowProjectId: state.flowProjectId,
              batchId: state.id,
              origin: state.stopOrigin,
            },
          });
        } catch (error) {
          return { success: false, error: "MOTION_BATCH_STOP_SAVE_FAILED" };
        }
      } else {
        const key = `motion_batch_pause:${host.userId}:${state.id}`;
        try {
          await chrome.storage.local.set({
            [key]: {
              userId: host.userId,
              flowProjectId: state.flowProjectId,
              batchId: state.id,
              origin: "manual",
            },
          });
        } catch (error) {
          return { success: false, error: "MOTION_BATCH_PAUSE_SAVE_FAILED" };
        }
      }
      if (state.current) {
        const paused = await this.command(
          {
            action: "motionRunner:pauseProject",
            tabId: host.tabId,
            epoch: host.epoch,
            ...state.current,
            stop: state.stopOrigin === "manual",
          },
          sender,
          state.id,
        );
        if (!paused?.success && paused?.error !== "MOTION_RUN_NOT_FOUND")
          return paused;
      }
      return { success: true, batchId: state.id };
    }
    if (message.action === "motionRunner:startProject") {
      if (this._batch && this._batch.id !== batchOwner)
        return { success: false, error: "MOTION_BATCH_ALREADY_RUNNING" };
      const projectId = String(message.projectId || ""),
        flowProjectId = String(message.flowProjectId || "");
      if (
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(projectId) ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(flowProjectId)
      )
        return { success: false, error: "MOTION_RUNNER_SCOPE_INVALID" };
      let active = this._projects.get(projectId);
      if (
        message.resume &&
        active?.finishing &&
        active.id === message.runId &&
        active.flowProjectId === flowProjectId &&
        active.promise?.then
      ) {
        await active.promise.catch(() => {});
        active = this._projects.get(projectId);
      }
      if (active) {
        if (
          !message.resume ||
          active.id !== message.runId ||
          active.flowProjectId !== flowProjectId ||
          !active.stopped ||
          active.finishing
        )
          return { success: false, error: "PROJECT_ALREADY_RUNNING" };
        if (active.stopOrigin)
          return { success: false, error: "MOTION_RUN_DRAIN_REQUIRED" };
        const path = `tools/motion-studio/projects/${encodeURIComponent(projectId)}`;
        const current = await window.authManager._apiCall("GET", path);
        const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
        const scopeError = this.projectScopeError({
          auth,
          latest,
          project: current,
          userId: host.userId,
          projectId,
          flowProjectId,
          stage: "resume_active",
        });
        if (scopeError) return { success: false, error: scopeError };
        if (current.data_json?.paused)
          await window.authManager._apiCall("PATCH", path, {
            revision: current.revision,
            pause: false,
          });
        if (active.stopOrigin || this._projects.get(projectId) !== active)
          return { success: false, error: "MOTION_RUN_DRAIN_REQUIRED" };
        if (Number.isFinite(active.frozenElapsedMs)) {
          active.startedAt = Date.now() - active.frozenElapsedMs;
          delete active.frozenElapsedMs;
        }
        active.stopped = false;
        delete active.providerQuotaPause;
        delete active.providerPauseError;
        delete active.providerPauseTask;
        for (const entry of active.flowJobs?.values() || [])
          await entry.queue.resumeJob(entry.jobId);
        for (const control of window.MessageBridge?._uploadControls || []) {
          const scope = control.motionScope;
          if (
            scope?.userId === host.userId &&
            scope.toolProjectId === projectId &&
            scope.runId === active.id
          )
            control.paused = false;
        }
        await active.publish({ state: "running" });
        return { success: true, runId: active.id };
      }
      const runScope = { userId: host.userId, toolProjectId: projectId };
      let currentFrameIds = null;
      let prior = await MotionRunJournal.get(runScope);
      if (prior && prior.state !== "completed") {
        const current = await window.authManager._apiCall(
          "GET",
          `tools/motion-studio/projects/${encodeURIComponent(projectId)}`,
        );
        const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
        const scopeError = this.projectScopeError({
          auth,
          latest,
          project: current,
          userId: host.userId,
          projectId,
          flowProjectId,
          stage: "load_prior_run",
        });
        if (scopeError) return { success: false, error: scopeError };
        currentFrameIds = Object.keys(current.data_json?.frames || {});
        if (
          !batchOwner &&
          message.resume !== true &&
          message.automaticRecovery !== true &&
          Number(current.data_json?.source_revision) > prior.sourceRevision
        ) {
          await MotionRunJournal.acknowledgeSourceChange(runScope, current);
          prior = await MotionRunJournal.get(runScope);
        }
        if (current.data_json?.rerun_operation) {
          await MotionRunJournal.acknowledgeRerun(runScope, current);
          prior = await MotionRunJournal.get(runScope);
        }
      }
      const transcriptTask =
        !batchOwner &&
        (message.taskKind === "transcript_batch" ||
          ((message.resume || message.automaticRecovery) &&
            prior?.taskKind === "transcript_batch" &&
            prior.state !== "completed"));
      let newTranscriptTask =
        transcriptTask &&
        message.taskKind === "transcript_batch" &&
        !message.resume &&
        !message.automaticRecovery;
      if (newTranscriptTask && prior && prior.state !== "completed") {
        const ownerActive = !!prior.ownerId && prior.leaseUntil > Date.now();
        if (
          ownerActive ||
          Object.values(prior.operations || {}).some(
            (item) => !["transcribe", "direct_transcribe"].includes(item.stage),
          )
        )
          return {
            success: false,
            error: ownerActive
              ? "PROJECT_ALREADY_RUNNING"
              : "FRAME_OPERATION_MUST_RECONCILE",
          };
        console.info(
          "[MotionTranscriptBatch]",
          JSON.stringify({
            stage: "restart_requested",
            previousRunId: prior.runId,
            outboxCount: (await MotionRunJournal.listTranscriptOutbox(runScope))
              .length,
          }),
        );
      }
      const explicitResume =
        message.automaticRecovery !== true &&
        !transcriptTask &&
        (message.resume === true || !batchOwner);
      const id =
        !newTranscriptTask && prior && prior.state !== "completed"
          ? prior.runId
          : (batchOwner || message.automaticRecovery === true) && message.runId
            ? message.runId
            : crypto.randomUUID();
      if (batchOwner && message.runId !== id)
        return { success: false, error: "MOTION_RUN_FENCED" };
      if (
        prior &&
        prior.state !== "completed" &&
        prior.flowProjectId !== flowProjectId
      )
        return { success: false, error: "MOTION_FLOW_PROJECT_MISMATCH" };
      if (!batchOwner) await this.registerRecovery(host, message, id);
      const previousStatus = (
        await chrome.storage.local.get(
          `motion_runner_status:${host.userId}:${projectId}`,
        )
      )?.[`motion_runner_status:${host.userId}:${projectId}`];
      const startedAt =
        previousStatus?.runId === id &&
        previousStatus.userId === host.userId &&
        previousStatus.timerReset !== true &&
        previousStatus.flowProjectId === flowProjectId &&
        Number.isSafeInteger(previousStatus.startedAt) &&
        previousStatus.startedAt > 0
          ? ["ready", "failed", "paused", "stopped", "needs_review"].includes(
              previousStatus.state,
            ) &&
            Number.isSafeInteger(previousStatus.elapsedMs) &&
            previousStatus.elapsedMs >= 0
            ? Date.now() - previousStatus.elapsedMs
            : previousStatus.startedAt
          : Date.now();
      const release = this.admit(id),
        state = {
          id,
          flowProjectId,
          startedAt,
          stopped: message.drainOnly === true,
          finishing: false,
          flowJobs: new Map(),
          flowStopTasks: new Set(),
          resetFrames: new Set(),
          updateTail: Promise.resolve(),
          finalAbort: new AbortController(),
        };
      this._projects.set(projectId, state);
      state.publish = (data) => {
        const now = Date.now();
        const terminal = !["preparing", "running", "pausing"].includes(
          data.state,
        );
        if (
          (state.stopped || terminal) &&
          !Number.isFinite(state.frozenElapsedMs)
        )
          state.frozenElapsedMs = Math.max(0, now - state.startedAt);
        const timing = {
          startedAt: state.startedAt,
          elapsedMs: data.timerReset
            ? 0
            : (state.frozenElapsedMs ?? Math.max(0, now - state.startedAt)),
          ...(Number.isFinite(state.frozenElapsedMs) && { timerPaused: true }),
          finishedAt: ["preparing", "running", "pausing"].includes(data.state)
            ? null
            : now,
        };
        const next = state.updateTail.then(() =>
          this.publish(host, projectId, {
            runId: id,
            flowProjectId,
            sourceRevision: state.sourceRevision ?? null,
            ...data,
            ...timing,
          }),
        );
        state.updateTail = next.catch(() => {});
        return next;
      };
      const stage = (info) => {
        if (
          Number.isSafeInteger(info.sourceRevision) &&
          info.sourceRevision > 0
        )
          state.sourceRevision = info.sourceRevision;
        if (
          info.state === "paused" &&
          ["api_unusual_activity", "flow_quota"].includes(info.pauseReason) &&
          !state.stopped &&
          !state.finishing &&
          this._projects.get(projectId) === state
        ) {
          state.stopped = true;
          if (info.pauseReason === "flow_quota")
            state.providerQuotaPause = {
              frameId: info.frameId,
              error: info.error,
              pauseReason: "flow_quota",
            };
          state.frozenElapsedMs ??
            (state.frozenElapsedMs = Math.max(0, Date.now() - state.startedAt));
          const pauseTask = this.dispatch(
            {
              action: "motionRunner:pauseProject",
              tabId: host.tabId,
              epoch: host.epoch,
              projectId,
              flowProjectId,
              runId: id,
              providerPause: true,
              pauseReason: info.pauseReason,
              frameId: info.frameId,
              error: info.error,
            },
            { id: chrome.runtime.id },
          )
            .then((result) => {
              if (
                result?.success !== true &&
                !state.stopOrigin &&
                this._projects.get(projectId) === state
              ) {
                if (info.pauseReason === "flow_quota")
                  state.providerPauseError =
                    result?.error || "MOTION_PAUSE_SYNC_FAILED";
                return state.publish({
                  state: "needs_review",
                  stage: "flow",
                  frameId: info.frameId,
                  error: result?.error || "MOTION_PAUSE_SYNC_FAILED",
                });
              }
            })
            .catch((error) => {
              if (info.pauseReason === "flow_quota")
                state.providerPauseError = "MOTION_PAUSE_SYNC_FAILED";
              console.warn("[MotionProviderPause]", {
                code: error?.code || error?.message,
              });
            });
          if (info.pauseReason === "flow_quota")
            state.providerPauseTask = pauseTask;
          return;
        }
        if (
          !state.stopped &&
          !state.finishing &&
          this._projects.get(projectId) === state
        ) {
          const { state: stageState, ...details } = info;
          void state
            .publish({
              ...details,
              state: "running",
              detail: info.detail || stageState || null,
            })
            .catch((error) =>
              console.warn("[MotionStatus]", { code: error?.message }),
            );
        }
      };
      state.promise = (async () => {
        try {
          await state.publish({ state: "preparing" });
          if (transcriptTask) {
            const result2 = await MotionTranscriptBatchRunner.run({
              userId: host.userId,
              toolProjectId: projectId,
              flowProjectId,
              runId: id,
              hostEpoch: host.epoch,
              resume: !newTranscriptTask,
              frameIds: message.frameIds,
              shouldStop: () => state.stopped,
              onStage: stage,
              screen: message.screen || {},
            });
            state.finishing = true;
            const failedItem2 = result2?.items?.find(
              (item) => item.transcript === "failed",
            );
            await state.publish({
              state: state.stopOrigin ? "stopped" : result2.state,
              stage: result2.stage,
              completedCount: result2.completedCount,
              frameId: result2.failure?.frameId || failedItem2?.frameId || null,
              error: result2.error || failedItem2?.transcriptError || null,
              failures: this.failureDetails(result2),
            });
            return result2;
          }
          if (message.resume === true) {
            const path = `tools/motion-studio/projects/${encodeURIComponent(projectId)}`;
            const current = await window.authManager._apiCall("GET", path);
            const latest = (await chrome.storage.local.get("af_auth"))?.af_auth;
            const scopeError = this.projectScopeError({
              auth,
              latest,
              project: current,
              userId: host.userId,
              projectId,
              flowProjectId,
              stage: "resume_prepare",
            });
            if (scopeError) throw new Error(scopeError);
            if (!state.stopped && current.data_json?.paused === true)
              await window.authManager._apiCall("PATCH", path, {
                revision: current.revision,
                pause: false,
              });
          }
          let prepared = await MotionRunnerRuntime.prepareProject({
            userId: host.userId,
            toolProjectId: projectId,
            flowProjectId,
            explicitResume: explicitResume === true,
            confirmedFlowMode: message.confirmedFlowMode,
            screen: message.screen || {},
            shouldStop: () => state.stopped,
            onProgress: (info) => stage({ stage: "split", ...info }),
          });
          if (prepared?.state === "ready")
            state.sourceRevision =
              Number(prepared.project?.data_json?.source_revision) || null;
          const executePrepared = () =>
            MotionRunnerRuntime.runPreparedProject({
              userId: host.userId,
              toolProjectId: projectId,
              prepared,
              hostEpoch: host.epoch,
              runId: id,
              parentBatchId: batchOwner,
              shouldStop: () => state.stopped,
              signal: state.finalAbort.signal,
              isForceStopped: (frameId) =>
                state.stopOrigin === "manual" || state.resetFrames.has(frameId),
              onQueueAdmitted: (entry) => {
                if (entry.completed) {
                  state.flowJobs.get(entry.jobId)?.resolveFinished?.();
                  state.flowJobs.delete(entry.jobId);
                  return;
                }
                entry.finished = new Promise((resolve) => {
                  entry.resolveFinished = resolve;
                });
                state.flowJobs.set(entry.jobId, entry);
                if (state.resetFrames.has(entry.frameId)) {
                  void entry.queue
                    .stopJobAndPersist(entry.jobId, {
                      stopOrigin: "user",
                      stopReason: "USER_CANCELLED",
                      stopSource: "MOTION_FRAME_RESET",
                    })
                    .catch((error) =>
                      console.warn("[MotionControl]", {
                        stage: "reset_stop_failed",
                        jobId: entry.jobId,
                        code: error?.code || error?.message,
                      }),
                    );
                } else this.controlFlowJob(state, entry);
              },
              download: async (blob) => {
                stage({ stage: "final_download", detail: "running" });
                try {
                  await this.downloadFinal(
                    blob,
                    prepared.project,
                    prepared.assertScope,
                  );
                  stage({ stage: "final_download", detail: "ready" });
                } catch (error) {
                  stage({ stage: "final_download", detail: "failed" });
                  throw error;
                }
              },
              onStage: stage,
              screen: message.screen || {},
            });
          let result =
            prepared?.state === "ready" ? await executePrepared() : prepared;
          if (
            prepared?.recoveryOnly &&
            result?.state === "paused" &&
            !state.stopped
          ) {
            prepared = await MotionRunnerRuntime.prepareProject({
              userId: host.userId,
              toolProjectId: projectId,
              flowProjectId,
              explicitResume: explicitResume === true,
              confirmedFlowMode: message.confirmedFlowMode,
              screen: message.screen || {},
              shouldStop: () => state.stopped,
              onProgress: (info) => stage({ stage: "split", ...info }),
            });
            if (prepared?.state === "ready" && !prepared.recoveryOnly)
              result = await executePrepared();
          }
          const failedItem = result?.items?.find?.(
            (item) =>
              ["failed", "needs_review", "sync_pending"].includes(
                item.transcript,
              ) || ["failed", "needs_review"].includes(item.upload),
          );
          const rawDownloadError = String(result?.final?.downloadError || "");
          const downloadError = rawDownloadError
            ? /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawDownloadError)
              ? rawDownloadError
              : "MOTION_FINAL_DOWNLOAD_FAILED"
            : null;
          const rawCleanupError = String(result?.cleanupError || "");
          const cleanupError = rawCleanupError
            ? /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawCleanupError)
              ? rawCleanupError
              : "MOTION_WORKER_CLOSE_PENDING"
            : null;
          if (state.providerPauseTask) await state.providerPauseTask;
          const quotaPause = state.providerQuotaPause;
          const quotaOutcome =
            !state.stopOrigin && quotaPause
              ? {
                  state:
                    state.providerPauseError || result?.state === "needs_review"
                      ? "needs_review"
                      : "paused",
                  stage: "flow",
                  frameId: quotaPause.frameId,
                  pauseReason: quotaPause.pauseReason,
                  error:
                    state.providerPauseError ||
                    (result?.state === "needs_review" && result.error) ||
                    quotaPause.error,
                }
              : null;
          state.finishing = true;
          await state.publish({
            state: state.stopOrigin ? "stopped" : result?.state || "failed",
            stopOrigin: state.stopOrigin || null,
            stage: result?.stage || null,
            pauseReason: result?.pauseReason || null,
            reviewFailed: result?.reviewFailed === true,
            frameId: result?.failure?.frameId || failedItem?.frameId || null,
            error:
              result?.error ||
              result?.failure?.error ||
              failedItem?.transcriptError ||
              failedItem?.uploadError ||
              null,
            failures: this.failureDetails(result),
            downloadError,
            cleanupError,
            mergeError: result?.final?.mergeError || null,
            ...quotaOutcome,
          });
          return quotaOutcome
            ? { ...result, ...quotaOutcome }
            : result || { state: "failed", error: "MOTION_RUN_FAILED" };
        } catch (error) {
          state.finishing = true;
          const snapshot =
            error?.code === "MOTION_RUN_SNAPSHOT_CHANGED" &&
            /^[a-z][a-z_]{0,79}$/.test(error?.snapshotReason || "")
              ? {
                  reason: error.snapshotReason,
                  fields: (Array.isArray(error.snapshotFields)
                    ? error.snapshotFields
                    : []
                  )
                    .filter(
                      (field) =>
                        typeof field === "string" &&
                        /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(field),
                    )
                    .slice(0, 30),
                }
              : null;
          if (
            snapshot &&
            error.snapshotSettings &&
            typeof error.snapshotSettings.matchesSavedFingerprint === "boolean"
          ) {
            snapshot.settings = {
              matchesSavedFingerprint:
                error.snapshotSettings.matchesSavedFingerprint,
              pinnedFields: (Array.isArray(error.snapshotSettings.pinnedFields)
                ? error.snapshotSettings.pinnedFields
                : []
              ).filter((field) =>
                [
                  "auto_download_final",
                  "use_original_audio",
                  "continuity_enabled",
                  "ratio",
                  "flow_download_resolution",
                  "transcription_provider",
                  "translate_enabled",
                  "target_language",
                ].includes(field),
              ),
            };
          }
          const result = {
            state: "failed",
            error: error?.code || error?.message || "MOTION_RUN_FAILED",
            ...(error?.referenceDiagnostic && {
              referenceDiagnostic: error.referenceDiagnostic,
            }),
            ...(snapshot && { snapshot }),
          };
          await state.publish(result);
          return result;
        } finally {
          this._projects.delete(projectId);
          release();
          void this.releaseLayout(host, projectId, id).catch((error) =>
            console.warn("[MotionLayout]", { code: error?.message }),
          );
        }
      })();
      return {
        success: true,
        runId: id,
        epoch: host.epoch,
        ...(batchOwner ? { completion: state.promise } : {}),
      };
    }
    return { success: true, resumed: true, epoch: host.epoch };
  }
}
__publicField(MotionRunnerHost, "_runs", new Set());
__publicField(MotionRunnerHost, "_quiesced", false);
__publicField(MotionRunnerHost, "_commandTail", Promise.resolve());
__publicField(MotionRunnerHost, "_projects", new Map());
__publicField(MotionRunnerHost, "_batch", null);
globalThis.MotionRunnerHost = MotionRunnerHost;
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    ![
      "motionRunner:quiesce",
      "motionRunner:unquiesce",
      "motionRunner:recoveryState",
      "motionRunner:startProject",
      "motionRunner:pauseProject",
      "motionRunner:resetFrameHost",
      "motionRunner:startBatchHost",
      "motionRunner:resumeBatchHost",
      "motionRunner:pauseBatchHost",
      "motionRunner:stopBatchHost",
    ].includes(message?.action)
  )
    return false;
  chrome.tabs
    .getCurrent()
    .then((tab) => {
      if (tab?.id !== message.tabId) return;
      return MotionRunnerHost.dispatch(message, sender).then(
        sendResponse,
        (error) =>
          sendResponse({
            success: false,
            error: error?.message || "MOTION_RUNNER_FAILED",
          }),
      );
    })
    .catch((error) =>
      console.warn("[MotionRunnerHost]", {
        stage: "address_check_failed",
        reason: error?.message,
      }),
    );
  return true;
});
