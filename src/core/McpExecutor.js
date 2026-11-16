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
class McpExecutor {
  static _activityText(key, fallback) {
    const value = window.I18n?.t?.(`mcpActivity.${key}`);
    return value && value !== `mcpActivity.${key}` ? value : fallback;
  }
  static _activityLabel(command) {
    const labels = {
      gen_image: ["image", "Generate image"],
      gen_video: ["video", "Generate video"],
      upload_ref: ["upload", "Upload reference"],
      upload_saved_result_ref: ["upload", "Upload reference"],
      extract_last_frame: ["lastFrame", "Extract last frame"],
      run_node: ["node", "Run workflow node"],
      run_workflow: ["workflow", "Run workflow"],
      create_project: ["createProject", "Create project"],
      open_project: ["openProject", "Open project"],
      get_context: ["context", "Read project context"],
      get_provider_status: ["status", "Check provider status"],
      get_characters: ["characters", "Read characters"],
      list_saved_results: ["savedResults", "Find saved results"],
      get_saved_media: ["savedResults", "Read saved media"],
      manage_saved_web_batch: ["savedBatchDetails", "Manage saved batch"],
      list_saved_batches: ["savedBatches", "Find saved batches"],
      get_saved_batch: ["savedBatchDetails", "Check batch prompts"],
      edit_saved_flow_prompt: ["editPrompt", "Edit saved batch prompt"],
      rerun_saved_flow_prompt: ["rerunPrompt", "Run saved prompt again"],
      rerun_saved_flow_batch: ["rerunBatch", "Run saved batch again"],
      add_saved_results_to_refs: ["addRefs", "Add result to references"],
      rename_saved_batch: ["renameBatch", "Rename batch"],
      delete_saved_batch: ["deleteBatch", "Delete batch"],
      delete_chat: ["deleteChat", "Delete chat"],
      clear_flow_cookies: ["clearCookies", "Clear Flow cookies"],
    };
    const [key, fallback] = labels[command] || ["status", "Process command"];
    return this._activityText(key, fallback);
  }
  static _updateActivity(jobId, command, phase, detail = null) {
    if (typeof document === "undefined" || !document.body) return;
    let toast = document.getElementById("tobyflow-mcp-activity");
    if (phase === "deferred") {
      if (toast?.dataset.jobId === jobId) toast.remove();
      return;
    }
    if (this._activityTimer) {
      clearTimeout(this._activityTimer);
      this._activityTimer = null;
    }
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "tobyflow-mcp-activity";
      toast.className = "tobyflow-mcp-activity";
      toast.setAttribute("role", "status");
      toast.setAttribute("aria-live", "polite");
      const dot = document.createElement("span");
      dot.className = "tobyflow-mcp-activity-dot";
      dot.setAttribute("aria-hidden", "true");
      toast.append(dot, document.createElement("span"));
      document.body.appendChild(toast);
    }
    if (phase !== "running" && toast.dataset.jobId !== jobId) return;
    toast.dataset.jobId = jobId;
    toast.dataset.phase = phase;
    const status = this._activityText(
      phase,
      phase === "running"
        ? "Working\u2026"
        : phase === "completed"
          ? "Completed"
          : phase === "cancelled"
            ? "Stopped"
            : "Failed",
    );
    const display =
      detail ||
      (command === "extract_last_frame" && phase === "failed"
        ? this._lastFrameActivityDetail
        : null);
    toast.lastElementChild.textContent = display
      ? `MCP \xB7 ${display}`
      : `MCP \xB7 ${this._activityLabel(command)} \xB7 ${status}`;
    if (phase !== "running")
      this._activityTimer = setTimeout(
        () => {
          if (toast.dataset.jobId === jobId) toast.remove();
          this._activityTimer = null;
        },
        command === "extract_last_frame" && phase === "failed" ? 1e4 : 4500,
      );
  }
  static async _runnerId() {
    const ownerId = String(window.authManager?.user?.id || "");
    if (this._runnerIdPromise && this._runnerOwnerId === ownerId)
      return this._runnerIdPromise;
    this._runnerOwnerId = ownerId;
    const task = (this._runnerIdPromise = (async () => {
      const stored = await chrome.storage.local.get([
        this._RUNNER_ID_KEY,
        this._RUNNER_OWNER_KEY,
      ]);
      if (
        ownerId &&
        stored?.[this._RUNNER_ID_KEY] &&
        stored?.[this._RUNNER_OWNER_KEY] === ownerId
      ) {
        return stored[this._RUNNER_ID_KEY];
      }
      const runnerId = crypto.randomUUID();
      await chrome.storage.local.set({
        [this._RUNNER_ID_KEY]: runnerId,
        [this._RUNNER_OWNER_KEY]: ownerId,
      });
      return runnerId;
    })());
    try {
      return await task;
    } catch (error) {
      if (this._runnerIdPromise === task) this._runnerIdPromise = null;
      throw error;
    }
  }
  static _runnerLabel() {
    const ua = String(navigator.userAgent || "");
    const browser = /Edg\//.test(ua)
      ? "Microsoft Edge"
      : /OPR\//.test(ua)
        ? "Opera"
        : /Chrome\//.test(ua)
          ? "Google Chrome"
          : "Browser";
    const os = /Windows NT/.test(ua)
      ? "Windows"
      : /Mac OS X/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : "Unknown OS";
    return `${browser} - ${os}`;
  }
  static init() {
    if (this._initialized) return;
    this._initialized = true;
    for (const event of [
      "queue:state_changed",
      "execution:captcha_detected",
      "execution:quota_exceeded",
      "execution:settled",
    ]) {
      window.eventBus?.on(event, () =>
        Promise.resolve().then(() => this._notifyFlowControlChanged()),
      );
    }
    window.eventBus?.on("sse:ai_command", (data) => this._execute(data));
    window.eventBus?.on("sse:ai_cancel", (data) =>
      this._handleCancel(data).catch((error) =>
        console.warn("[McpExecutor] cancel routing failed", error?.message),
      ),
    );
    window.eventBus?.on("execution:force_stopped", () => {
      if (!this._currentJobId) return;
      this._wasStopped = true;
      this._stopOwnedMcpRun("MCP_FORCE_STOP").catch(() => {});
      if (
        this._currentProvider === "muse" &&
        this._currentMuseGenMode !== "api"
      )
        window.MuseSession?.abort?.().catch(() => {});
    });
    const restore = () => {
      this._pingExecutorHeartbeat("ready").catch(() => {});
      this._flushResultOutbox().catch(() => {});
      window.ProviderWebScheduler?.pruneExpiredOwnedRuns?.(
        window.authManager?.getUser?.()?.id,
      ).catch(() => {});
    };
    for (const event of [
      "auth:login",
      "sse:connected",
      "broadcast:became_leader",
    ]) {
      window.eventBus?.on(event, restore);
    }
    window.addEventListener?.("online", restore);
    window.addEventListener?.("focus", restore);
    document.addEventListener?.("visibilitychange", () => {
      if (document.visibilityState === "visible") restore();
    });
    this._flushResultOutbox().catch((e) =>
      console.warn("[McpExecutor] flush outbox l\u1ED7i:", e?.message),
    );
    window.ProviderWebScheduler?.pruneExpiredOwnedRuns?.(
      window.authManager?.getUser?.()?.id,
    ).catch(() => {});
    this._pingExecutorHeartbeat("ready").catch(() => {});
    this._executorHeartbeatTimer = setInterval(
      () => this._pingExecutorHeartbeat("ready").catch(() => {}),
      45e3,
    );
    console.log("[McpExecutor] \u0110\xE3 kh\u1EDFi t\u1EA1o");
  }
  static _flowExecutionControl() {
    if (!this._currentJobId) return null;
    const queue = window.PromptQueue?.getInstance?.();
    const workflow = this._currentWorkflowId;
    const runId = window.workflowExecutor?._flowRunId;
    const jobs =
      queue?.getJobsByOwner?.(workflow ? "workflow" : "mcp", {
        includeTerminal: true,
      }) || [];
    for (const job of jobs) {
      if (
        workflow
          ? !runId ||
            job.workflowId !== workflow ||
            job.workflowRunId !== runId ||
            (this._currentWorkflowNodeId &&
              job.workflowNodeId !== this._currentWorkflowNodeId) ||
            !Number.isFinite(job.createdAt) ||
            job.createdAt < this._currentCommandStartedAt
          : job.mcpJobId !== this._currentJobId
      )
        continue;
      const quota = !!job._apiQuotaBlocked || job._apiBlockedModels?.size > 0;
      const culprit = (job.items || []).find((item) =>
        (quota
          ? ["quota_exceeded", "per_model_daily", "tier_restricted"]
          : ["bot_detected", "captcha_failed"]
        ).includes(item.errorType),
      );
      const workflowCaptcha =
        workflow &&
        window.workflowExecutor?._captchaHalted === true &&
        window.workflowExecutor?.currentWorkflow?.wf_id === workflow &&
        culprit;
      const paused =
        job.state === "paused" ||
        !!(workflowCaptcha && window.workflowExecutor?.isRunning);
      const stopped = !!(
        culprit &&
        ["bot_detected", "captcha_failed"].includes(culprit.errorType) &&
        (job.state === "stopped" ||
          (workflowCaptcha && !window.workflowExecutor?.isRunning))
      );
      if (!quota && !paused && !stopped) continue;
      const reason =
        culprit?.errorType || (quota ? "quota_exceeded" : "manual");
      const rawCode =
        culprit?.errorPolicy?.code ||
        culprit?.flowApiFailureDetail?.code ||
        job._apiQuotaBlocked;
      return {
        state: paused
          ? "paused"
          : stopped || job.isDone
            ? "stopped"
            : "limited",
        reason,
        provider_code:
          typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode)
            ? rawCode
            : null,
        scope:
          job._apiBlockedModels?.size && !job._apiQuotaBlocked
            ? "model"
            : "batch",
        submissions_blocked: true,
        automatic_retry_allowed: false,
        requires_user_action: true,
        user_action: quota
          ? reason === "per_model_daily" || reason === "tier_restricted"
            ? "wait_or_change_model"
            : "wait_for_quota_or_upgrade"
          : "verify_in_flow_then_resume_existing_job",
      };
    }
    return null;
  }
  static _flowControlEnvelope() {
    const control = this._flowExecutionControl();
    const signature = JSON.stringify([this._currentJobId, control]);
    if (signature !== this._flowControlRevisionSignature) {
      this._flowControlRevisionSignature = signature;
      this._flowControlRevision = Math.max(
        Date.now(),
        (this._flowControlRevision || 0) + 1,
      );
    }
    return {
      runtime_control: control,
      runtime_control_revision: this._flowControlRevision || 1,
    };
  }
  static _notifyFlowControlChanged() {
    if (!this._currentJobId) return;
    const jobId = this._currentJobId;
    const signature = JSON.stringify([jobId, this._flowExecutionControl()]);
    if (this._flowControlHeartbeatSignature === signature) return;
    this._flowControlHeartbeatSignature = signature;
    this._pingExecutorHeartbeat("running", jobId)
      .then((ok) => {
        if (ok === false && this._flowControlHeartbeatSignature === signature)
          this._flowControlHeartbeatSignature = null;
      })
      .catch(() => {
        if (this._flowControlHeartbeatSignature === signature)
          this._flowControlHeartbeatSignature = null;
      });
  }
  static async _pingExecutorHeartbeat(stage = "ready", jobId = null) {
    if (stage !== "ready") return this._sendExecutorHeartbeat(stage, jobId);
    if (this._readyHeartbeatPromise) return this._readyHeartbeatPromise;
    this._readyHeartbeatPromise = this._sendExecutorHeartbeat(stage, jobId);
    try {
      return await this._readyHeartbeatPromise;
    } finally {
      this._readyHeartbeatPromise = null;
    }
  }
  static async _sendExecutorHeartbeat(stage, jobId) {
    if (!window.authManager?._apiCall || !window.authManager?.isLoggedIn?.())
      return false;
    const heartbeatJobId = jobId || this._currentJobId || null;
    const flowControl =
      heartbeatJobId === this._currentJobId ? this._flowControlEnvelope() : {};
    let timer = null;
    let expired = false;
    try {
      const timeoutMs = Number(
        window.SystemConfig?.safeGetTimeout?.("api_timeout_ms"),
      );
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw Object.assign(
          new Error("MCP_HEARTBEAT_TIMEOUT_CONFIG_UNAVAILABLE"),
          { code: "MCP_HEARTBEAT_TIMEOUT_CONFIG_UNAVAILABLE" },
        );
      }
      const heartbeat = await Promise.race([
        (async () => {
          const runnerId = await this._runnerId();
          const flag = (await chrome.storage.local.get("af_running_workflow"))
            ?.af_running_workflow;
          if (expired) return;
          return window.authManager._apiCall("POST", "mcp/executor-heartbeat", {
            runner_id: runnerId,
            label: this._runnerLabel(),
            job_id: heartbeatJobId,
            stage,
            ...flowControl,
            context: window.location?.pathname || "sidebar",
            request_nonce: crypto.randomUUID(),
            workflow_scoped_execution: true,
            workflow_data_access: true,
            batch_data_access: true,
            flow_batch_control: true,
            active_workflow:
              flag?.wf_id &&
              flag?.run_id &&
              Date.now() -
                Number(flag.last_heartbeat_at || flag.started_at || 0) <
                3e5
                ? {
                    wf_id: flag.wf_id,
                    run_id: flag.run_id,
                    execution_mode:
                      flag.executor_context === "single_nodes"
                        ? "single_nodes"
                        : "workflow",
                  }
                : null,
          });
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(
              Object.assign(new Error("MCP executor heartbeat timed out"), {
                code: "MCP_HEARTBEAT_TIMEOUT",
              }),
            );
          }, timeoutMs);
        }),
      ]);
      if (stage === "ready" && heartbeat?.recoverable_job_id && !expired) {
        this._recoverOwnedMcpJob(
          heartbeat.recoverable_job_id,
          heartbeat.recoverable_muse_command,
        ).catch((error) =>
          console.warn(
            "[McpExecutor] Owned job recovery pending:",
            error?.message || error,
          ),
        );
      }
      if (this._heartbeatFailed)
        console.info("[McpExecutor] Executor heartbeat restored");
      this._heartbeatFailed = false;
      return true;
    } catch (error) {
      if (!this._heartbeatFailed)
        console.warn(
          `[McpExecutor] Executor heartbeat failed: stage=${stage}, code=${error?.code || "unknown"}, status=${error?.httpStatus ?? "n/a"}, message=${error?.message || "unknown"}`,
        );
      this._heartbeatFailed = true;
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  static _startActiveHeartbeat(jobId) {
    this._stopActiveHeartbeat();
    this._pingExecutorHeartbeat("event_received", jobId).catch(() => {});
    this._activeHeartbeatTimer = setInterval(
      () => this._pingExecutorHeartbeat("running", jobId).catch(() => {}),
      3e4,
    );
  }
  static _stopActiveHeartbeat() {
    if (this._activeHeartbeatTimer) clearInterval(this._activeHeartbeatTimer);
    this._activeHeartbeatTimer = null;
  }
  static _isLeaderContext() {
    const role = window.SseBroadcastManager?._role;
    return !role || role === "leader";
  }
  static async _recoverOwnedMcpJob(jobId, museCommand = null) {
    if (
      this._ownedRecoveryPromise ||
      this._isExecuting ||
      !this._isLeaderContext() ||
      !window.ProviderWebQueueStore?.listRuns ||
      !window.ProviderWebScheduler?.runOwned
    )
      return;
    const task = (async () => {
      const stored = await chrome.storage.local.get([this._RESULT_OUTBOX_KEY]);
      if (
        (stored?.[this._RESULT_OUTBOX_KEY] || []).some(
          (item) => item?.body?.job_id === jobId,
        )
      ) {
        await this._flushResultOutbox();
        return;
      }
      const userId = window.authManager?.getUser?.()?.id;
      if (!userId) return;
      const runnerId = await this._runnerId();
      if (
        museCommand?.args?.provider === "muse" &&
        ["gen_image", "gen_video"].includes(museCommand.command)
      ) {
        const handles = await this._museApiJobHandles(jobId);
        const apiRows = handles.length
          ? []
          : await window.ProviderWebQueueStore.listRuns(
              userId,
              null,
              `mcp:${jobId}`,
            );
        const nativeRows = apiRows.filter(
          (run2) =>
            run2.settingsSnapshot?.museDirect === true &&
            run2.runnerId === runnerId &&
            run2.mcpJobId === jobId,
        );
        if (nativeRows.length === 1) {
          const run2 = nativeRows[0],
            owner = { mcpJobId: jobId, runnerId };
          const snapshot2 = await window.ProviderWebQueueStore.getOwnedRun(
            run2.id,
            userId,
            owner,
          );
          await this._execute(
            {
              job_id: jobId,
              runner_id: runnerId,
              command: museCommand.command,
              args: museCommand.args,
            },
            {
              nativeReadOnly: true,
              existingRunId: run2.id,
              userId,
              provider: "muse",
              mediaType: run2.settingsSnapshot.mediaType,
              promptList: snapshot2.items.map((item) => item.prompt),
              owner,
            },
          );
          return;
        }
        if (
          handles.length ||
          apiRows.some(
            (run2) =>
              run2.settingsSnapshot?.museGenMode === "api" &&
              run2.runnerId === runnerId,
          )
        ) {
          await this._execute(
            {
              job_id: jobId,
              runner_id: runnerId,
              command: museCommand.command,
              args: museCommand.args,
            },
            null,
            handles,
          );
          return;
        }
      }
      const runs = (
        await window.ProviderWebQueueStore.listRuns(
          userId,
          null,
          `mcp:${jobId}`,
        )
      ).filter(
        (run2) =>
          run2.source === "mcp_direct" &&
          run2.settingsSnapshot?.museGenMode !== "api" &&
          run2.settingsSnapshot?.museDirect !== true &&
          run2.mcpJobId === jobId &&
          run2.runnerId === runnerId &&
          ["QUEUED", "RUNNING"].includes(run2.status),
      );
      if (runs.length !== 1) return;
      const snapshot = await window.ProviderWebQueueStore.getOwnedRun(
        runs[0].id,
        userId,
        { mcpJobId: jobId, runnerId },
      );
      const items = [...(snapshot?.items || [])].sort(
        (a, b) => a.promptIndex - b.promptIndex,
      );
      if (
        !items.length ||
        items.some(
          (item, index) =>
            item.promptIndex !== index ||
            typeof item.prompt !== "string" ||
            !item.prompt.trim(),
        )
      )
        return;
      const run = snapshot.run;
      const isVideo = run.settingsSnapshot?.mediaType === "video";
      if (
        !["muse", "chatgpt", "gemini"].includes(run.provider) ||
        !["image", "video"].includes(run.settingsSnapshot?.mediaType) ||
        (run.provider === "chatgpt" && isVideo)
      )
        return;
      const route = {
        userId,
        provider: run.provider,
        mediaType: run.settingsSnapshot.mediaType,
        promptList: items.map((item) => item.prompt),
        settingsSnapshot: run.settingsSnapshot,
        prompts: items.map((item) => ({
          text: item.prompt,
          refKeys: item.refKeys || [],
          quantity: 1,
        })),
        refAssets: [],
        owner: { mcpJobId: jobId, runnerId },
        existingRunId: run.id,
      };
      await this._execute(
        {
          job_id: jobId,
          runner_id: runnerId,
          command: isVideo ? "gen_video" : "gen_image",
          args: { provider: run.provider },
        },
        route,
      );
    })();
    this._ownedRecoveryPromise = task;
    this._ownedRecoveryJobId = jobId;
    try {
      await task;
    } finally {
      if (this._ownedRecoveryPromise === task) {
        this._ownedRecoveryPromise = null;
        this._ownedRecoveryJobId = null;
      }
    }
  }
  static async _museApiJobHandles(jobId) {
    if (!window.MuseApiFacade?.listRuns) return [];
    return (await window.MuseApiFacade.listRuns()).filter(
      (row) =>
        row.source === "mcp" &&
        (row.sourceId === jobId || row.sourceId?.startsWith(`${jobId}:`)),
    );
  }
  static async _execute(data, recoveryRoute = null, museApiRecovery = null) {
    const { command, job_id } = data || {};
    let args = { ...(data?.args || {}) };
    delete args._muse_api_handles;
    if (!job_id) return;
    if (
      !recoveryRoute &&
      !museApiRecovery &&
      job_id === this._ownedRecoveryJobId
    )
      return;
    if (!data.runner_id || data.runner_id !== (await this._runnerId())) return;
    if (!this._isLeaderContext()) {
      console.log("[McpExecutor] follower context \u2192 skip", job_id);
      return;
    }
    const VALID = [
      "gen_image",
      "gen_video",
      "upload_ref",
      "extract_last_frame",
      "run_node",
      "run_workflow",
      "get_workflow_results",
      "upload_workflow_result_ref",
      "create_project",
      "open_project",
      "get_context",
      "get_provider_status",
      "get_characters",
      "delete_chat",
      "clear_flow_cookies",
      "list_saved_results",
      "get_saved_media",
      "manage_saved_web_batch",
      "add_saved_results_to_refs",
      "upload_saved_result_ref",
      "list_saved_batches",
      "rename_saved_batch",
      "delete_saved_batch",
      "get_saved_batch",
      "edit_saved_flow_prompt",
      "rerun_saved_flow_prompt",
      "rerun_saved_flow_batch",
    ];
    if (!VALID.includes(command)) {
      await this._sendResult(job_id, "failed", {
        errorCode: "GEN_FAILED",
        errorMessage: `L\u1EC7nh kh\xF4ng h\u1ED7 tr\u1EE3: ${command}`,
      });
      return;
    }
    if (
      !recoveryRoute &&
      !museApiRecovery &&
      ["gen_image", "gen_video"].includes(command)
    ) {
      try {
        const pending = await chrome.storage.local.get([
          this._RESULT_OUTBOX_KEY,
        ]);
        const userId = window.authManager?.getUser?.()?.id;
        if (
          (pending?.[this._RESULT_OUTBOX_KEY] || []).some(
            (item) =>
              item?.body?.job_id === job_id &&
              String(item.userId) === String(userId),
          )
        ) {
          await this._flushResultOutbox();
          return;
        }
        if (userId && args.provider === "muse") {
          const handles = await this._museApiJobHandles(job_id);
          if (handles.length) museApiRecovery = handles;
        }
        if (userId && window.ProviderWebQueueStore?.listRuns) {
          const runnerId = await this._runnerId();
          const prior = await window.ProviderWebQueueStore.listRuns(
            userId,
            null,
            `mcp:${job_id}`,
          );
          if (
            args.provider === "muse" &&
            !museApiRecovery &&
            prior.some(
              (run) =>
                run.source === "mcp_direct" &&
                run.settingsSnapshot?.museGenMode === "api" &&
                run.runnerId === runnerId,
            )
          )
            museApiRecovery = [];
          if (
            args.provider === "muse" &&
            prior.some(
              (run) =>
                run.settingsSnapshot?.museDirect === true &&
                run.runnerId === runnerId,
            )
          ) {
            await this._recoverOwnedMcpJob(job_id, { command, args });
            return;
          }
          if (
            prior.some(
              (run) =>
                run.source === "mcp_direct" &&
                run.settingsSnapshot?.museGenMode !== "api" &&
                run.runnerId === runnerId &&
                ["QUEUED", "RUNNING"].includes(run.status),
            )
          ) {
            await this._recoverOwnedMcpJob(job_id);
            return;
          }
        }
      } catch (error) {
        console.warn(
          "[McpExecutor] Existing job check unavailable:",
          error?.message || error,
        );
        return;
      }
    }
    try {
      if (window.featureGate?.isInitialized?.() !== true) {
        await window.featureGate?.init?.();
      }
      if (
        !recoveryRoute &&
        window.featureGate &&
        window.featureGate.canUse &&
        window.featureGate.canUse("mcp_enabled") === false
      ) {
        await this._sendResult(job_id, "failed", {
          errorCode: "FEATURE_NOT_IN_PLAN",
          errorMessage: "MCP ch\u01B0a b\u1EADt cho plan",
        });
        return;
      }
    } catch (_) {}
    if (this._isExecuting) {
      if (job_id === this._currentJobId) {
        console.log("[McpExecutor] Duplicate active command ignored:", job_id);
        this._pingExecutorHeartbeat("duplicate_ignored", job_id).catch(
          () => {},
        );
        return;
      }
      await this._sendResult(job_id, "failed", {
        errorCode: "EXTENSION_BUSY",
        errorMessage: "Extension \u0111ang x\u1EED l\xFD l\u1EC7nh MCP kh\xE1c",
      });
      return;
    }
    this._currentJobId = job_id;
    this._currentCommandStartedAt = Date.now();
    this._lastFrameActivityDetail = null;
    this._isExecuting = true;
    this._cancelRequested = false;
    this._wasStopped = false;
    this._startActiveHeartbeat(job_id);
    this._updateActivity(job_id, command, "running");
    const provider = args?.provider || "flow";
    this._currentProvider = provider;
    const isWorkflowCommand =
      command === "run_workflow" || command === "run_node";
    this._currentWorkflowId = isWorkflowCommand ? args.wf_id : null;
    this._currentWorkflowNodeId = command === "run_node" ? args.node_id : null;
    let ownsMcpLock = false;
    let generationStarted = false;
    let generationFinished = false;
    let ownedRoute = recoveryRoute;
    let activityOutcome = "failed";
    try {
      const requestedOwner = isWorkflowCommand ? "workflow" : "mcp";
      const readOnlyCommand =
        [
          "list_saved_results",
          "list_saved_batches",
          "get_saved_batch",
          "get_provider_status",
        ].includes(command) ||
        (command === "manage_saved_web_batch" && args.operation === "stop");
      if (
        !readOnlyCommand &&
        window.ExecutionLock?.isBlockedBy(requestedOwner)
      ) {
        if (recoveryRoute) {
          activityOutcome = "deferred";
          return;
        }
        const st = window.ExecutionLock.getState?.() || {};
        const ownerLabels = {
          prompts: "Prompt/Gen",
          task: "Task",
          workflow: "Workflow",
          angles: "Angles",
          effects: "Effects",
          queue: "Queue",
        };
        const busy =
          st.label || ownerLabels[st.owner] || st.owner || "another task";
        await this._sendResult(job_id, "failed", {
          errorCode: "EXTENSION_BUSY",
          errorMessage: `Extension \u0111ang b\u1EADn: ${busy}. Ch\u1EDD xong r\u1ED3i th\u1EED l\u1EA1i.`,
        });
        return;
      }
      if (!isWorkflowCommand && !readOnlyCommand) {
        window.ExecutionLock?.acquire("mcp", `MCP: ${command}`);
        ownsMcpLock = true;
      }
      if (Array.isArray(museApiRecovery))
        args = { ...args, _muse_api_handles: museApiRecovery };
      this._currentExecutionToken = null;
      this._currentOwnedRun = null;
      this._currentMuseGenMode = null;
      if (provider === "muse" && ["gen_image", "gen_video"].includes(command)) {
        const stored = await chrome.storage.local.get("af_settings");
        const requestedMode = args._muse_api_handles
          ? "api"
          : (args.muse_gen_mode ?? stored.af_settings?.museGenMode ?? "web");
        if (!["web", "api"].includes(requestedMode))
          throw this._err("VALIDATION_ERROR", "MUSE_MODE_INVALID");
        const mode = args._muse_api_handles
          ? "api"
          : window.MuseApiFacade?.effectiveMode({
              museGenMode: requestedMode,
            }) || "web";
        if (!["web", "api"].includes(mode))
          throw this._err("VALIDATION_ERROR", "MUSE_MODE_INVALID");
        args = {
          ...args,
          muse_gen_mode: mode,
          _muse_requested_mode: requestedMode,
        };
        this._currentMuseGenMode = mode;
        if (mode === "api" && !args._muse_api_handles) {
          if (!window.MuseApiFacade)
            throw this._err("CONFIG_UNAVAILABLE", "MUSE_API_NOT_LOADED");
          const policy = await window.MuseApiFacade.policy();
          window.MuseApiFacade.validateInput(
            {
              settings: {
                mode: command === "gen_video" ? "video" : "image",
                quantity: args.count ?? 1,
              },
              refs:
                args.ref_mode === "none"
                  ? []
                  : [
                      ...(args.refs || []),
                      ...(args.refs_per_prompt || []).flat(),
                      ...(args.saved_refs || []),
                      ...(args.workflow_refs || []),
                      ...(args.saved_refs_per_prompt || []).flat(),
                      ...(args.workflow_refs_per_prompt || []).flat(),
                    ],
            },
            policy,
          );
        }
      }
      const execAction = this._mapCommandToAction(command, provider);
      if (
        ["gen_image", "gen_video"].includes(command) &&
        (args.workflow_refs?.length || args.workflow_refs_per_prompt?.length)
      )
        args = await this._prepareWorkflowRefsForGen(args);
      if (
        !recoveryRoute &&
        ["gen_image", "gen_video"].includes(command) &&
        ((Array.isArray(args.saved_refs) && args.saved_refs.length) ||
          (Array.isArray(args.saved_refs_per_prompt) &&
            args.saved_refs_per_prompt.length))
      )
        args = await this._prepareSavedRefsForGen(args, provider);
      ownedRoute =
        recoveryRoute ||
        (["gen_image", "gen_video"].includes(command)
          ? await this._prepareOwnedMcpGen(
              args,
              command === "gen_video",
              job_id,
            )
          : null);
      if (["gen_image", "gen_video"].includes(command))
        console.info(
          "[McpExecutor] generation_route",
          JSON.stringify({
            jobId: job_id,
            provider,
            route: ownedRoute
              ? "web_worker"
              : provider === "muse" && args.muse_gen_mode === "api"
                ? "muse_api"
                : "legacy",
            promptCount: Array.isArray(args?.prompts) ? args.prompts.length : 1,
            batchName: args?.batch_name || null,
          }),
        );
      if (
        execAction &&
        !window.ExecutionGate &&
        !recoveryRoute &&
        !args._muse_api_handles
      ) {
        await this._sendResult(job_id, "failed", {
          errorCode: "EXECUTION_GATE_UNAVAILABLE",
          errorMessage: "ExecutionGate ch\u01B0a s\u1EB5n s\xE0ng.",
        });
        return;
      }
      if (
        execAction &&
        window.ExecutionGate &&
        !ownedRoute &&
        !args._muse_api_handles
      ) {
        try {
          const nPrompts =
            Array.isArray(args?.prompts) && args.prompts.length
              ? args.prompts.length
              : 1;
          const promptCount =
            command === "gen_image"
              ? nPrompts * Math.min(args?.count || 1, 4)
              : command === "gen_video"
                ? nPrompts
                : 1;
          const refCount =
            args?.ref_mode === "none"
              ? 0
              : (Array.isArray(args?.refs) ? args.refs.length : 0) +
                (Array.isArray(args?.refs_per_prompt)
                  ? args.refs_per_prompt.reduce(
                      (total, refSet) =>
                        total + (Array.isArray(refSet) ? refSet.length : 0),
                      0,
                    )
                  : 0) +
                (Array.isArray(args?.reuse_refs) ? args.reuse_refs.length : 0);
          const gate = await ExecutionGate.request(execAction, promptCount, {
            owner: "mcp",
            label: `MCP: ${command}`,
            provider,
            ...(provider === "muse" && args.muse_gen_mode === "api"
              ? { muse_api_mcp_job_id: job_id }
              : {}),
            has_ref: refCount > 0,
            ref_count: refCount,
          });
          if (!gate.allowed) {
            await this._sendResult(job_id, "failed", {
              errorCode: "DAILY_QUOTA_EXCEEDED",
              errorMessage:
                "\u0110\xE3 h\u1EBFt l\u01B0\u1EE3t s\u1EED d\u1EE5ng trong ng\xE0y (quota). Ch\u1EDD reset ho\u1EB7c n\xE2ng plan \u2014 kh\xF4ng retry ngay.",
            });
            return;
          }
          if (!gate.token || gate.reason === "OFFLINE_FALLBACK") {
            await this._sendResult(job_id, "failed", {
              errorCode: "EXECUTION_GATE_UNAVAILABLE",
              errorMessage:
                "Kh\xF4ng th\u1EC3 x\xE1c nh\u1EADn quy\u1EC1n ch\u1EA1y v\u1EDBi server. Ki\u1EC3m tra k\u1EBFt n\u1ED1i r\u1ED3i th\u1EED l\u1EA1i.",
            });
            return;
          }
          this._currentExecutionToken = gate.token;
        } catch (e) {
          if (window.QuotaErrorHandler?.isQuotaError?.(e)) {
            await this._sendResult(job_id, "failed", {
              errorCode: "DAILY_QUOTA_EXCEEDED",
              errorMessage:
                "\u0110\xE3 h\u1EBFt l\u01B0\u1EE3t s\u1EED d\u1EE5ng trong ng\xE0y (quota). Ch\u1EDD reset ho\u1EB7c n\xE2ng plan \u2014 kh\xF4ng retry ngay.",
            });
            return;
          }
          await this._sendResult(job_id, "failed", {
            errorCode: "EXECUTION_GATE_UNAVAILABLE",
            errorMessage:
              e?.message ||
              "Kh\xF4ng th\u1EC3 k\u1EBFt n\u1ED1i ExecutionGate.",
          });
          return;
        }
      }
      let result;
      generationStarted = ["gen_image", "gen_video"].includes(command);
      this._currentGenerationStartedAt = generationStarted ? Date.now() : null;
      switch (command) {
        case "gen_image":
          result = ownedRoute
            ? await this._executeOwnedMcpGen(ownedRoute)
            : await this._executeGen(args, false);
          break;
        case "gen_video":
          result = ownedRoute
            ? await this._executeOwnedMcpGen(ownedRoute)
            : await this._executeGen(args, true);
          break;
        case "upload_ref":
          result = await this._executeUploadRef(args);
          break;
        case "extract_last_frame":
          result = await this._executeExtractLastFrame(args);
          break;
        case "get_workflow_results":
          result = await this._executeWorkflowResults(args);
          break;
        case "upload_workflow_result_ref":
          result = await this._executeUploadWorkflowResultRef(
            args.workflow_refs[0],
          );
          break;
        case "run_node":
          result = await this._executeWorkflowNode(args);
          break;
        case "run_workflow":
          result = await this._executeWorkflow(args);
          break;
        case "create_project":
          result = await this._executeCreateProject(args);
          break;
        case "open_project":
          result = await this._executeOpenProject(args);
          break;
        case "get_context":
          result = await this._executeGetContext();
          break;
        case "get_provider_status":
          result = await this._executeGetProviderStatus(args);
          break;
        case "get_characters":
          result = await this._executeGetCharacters();
          break;
        case "get_saved_media":
          result = await this._executeGetSavedMedia(args);
          break;
        case "manage_saved_web_batch":
          result = await this._executeManageSavedWebBatch(args, job_id);
          break;
        case "list_saved_results":
          result = await this._executeListSavedResults(args);
          break;
        case "add_saved_results_to_refs":
          result = await this._executeAddSavedResultsToRefs(args);
          break;
        case "upload_saved_result_ref":
          result = await this._executeUploadSavedResultRef(args);
          break;
        case "list_saved_batches":
          result = await this._executeListSavedBatches(args);
          break;
        case "get_saved_batch":
          result = await this._executeGetSavedBatch(args);
          break;
        case "edit_saved_flow_prompt":
          result = await this._executeEditSavedFlowPrompt(args);
          break;
        case "rerun_saved_flow_prompt":
          result = await this._executeRerunSavedFlow(args, job_id, false);
          break;
        case "rerun_saved_flow_batch":
          result = await this._executeRerunSavedFlow(args, job_id, true);
          break;
        case "rename_saved_batch":
          result = await this._executeRenameSavedBatch(args);
          break;
        case "delete_saved_batch":
          result = await this._executeDeleteSavedBatch(args);
          break;
        case "delete_chat":
          result = await this._executeDeleteChat(args);
          break;
        case "clear_flow_cookies":
          result = await this._executeClearFlowCookies(args);
          break;
      }
      generationFinished = true;
      activityOutcome = this._wasStopped ? "cancelled" : "completed";
      if (this._wasStopped) {
        const quota = this._quotaCompletion(result, true);
        const delivered = await this._sendResult(
          job_id,
          "failed",
          {
            ...result,
            errorCode: "CANCELLED",
            errorMessage:
              "\u0110\xE3 hu\u1EF7 (d\u1EEBng th\u1EE7 c\xF4ng ho\u1EB7c cancel_all) tr\u01B0\u1EDBc khi ho\xE0n t\u1EA5t.",
          },
          {
            executionToken: this._currentExecutionToken,
            executionOutcome: quota.status,
            executionResultData: quota.resultData,
            ownedRun: this._currentOwnedRun,
          },
        );
        if (window.ExecutionGate && this._currentExecutionToken) {
          if (delivered)
            await ExecutionGate.complete(
              this._currentExecutionToken,
              quota.status,
              quota.resultData,
            );
          this._currentExecutionToken = null;
        }
      } else {
        const quota = this._quotaCompletion(result, false);
        const delivered = await this._sendResult(
          job_id,
          "completed",
          { ...(result || {}), _command: command },
          {
            executionToken: this._currentExecutionToken,
            executionOutcome: quota.status,
            executionResultData: quota.resultData,
            ownedRun: this._currentOwnedRun,
          },
        );
        if (window.ExecutionGate && this._currentExecutionToken) {
          if (delivered)
            await ExecutionGate.complete(
              this._currentExecutionToken,
              quota.status,
              quota.resultData,
            );
          this._currentExecutionToken = null;
        }
      }
    } catch (err) {
      activityOutcome = this._wasStopped ? "cancelled" : "failed";
      if (this._currentOwnedRun?.status === null)
        await this._classifyOwnedMcpFailure(err);
      if (ownedRoute && !ownedRoute.nativeReadOnly && !this._currentOwnedRun) {
        try {
          const runs = await window.ProviderWebQueueStore.listRuns(
            ownedRoute.userId,
            null,
            `mcp:${job_id}`,
          );
          if (
            runs.some(
              (run) =>
                run.source === "mcp_direct" &&
                run.runnerId === ownedRoute.owner.runnerId &&
                ["QUEUED", "RUNNING"].includes(run.status),
            )
          ) {
            console.warn(
              "[McpExecutor] Owned admission unresolved; retaining job for idempotent recovery:",
              JSON.stringify({
                code: err?.code || null,
                httpStatus: err?.httpStatus || null,
                message: err?.message || String(err),
              }),
            );
            activityOutcome = "deferred";
            return;
          }
        } catch (storeError) {
          console.warn(
            "[McpExecutor] Owned recovery store unavailable:",
            storeError?.message,
          );
          activityOutcome = "deferred";
          return;
        }
      }
      const stopped = this._wasStopped;
      const flowControl = this._flowExecutionControl();
      const code = stopped
        ? "CANCELLED"
        : flowControl
          ? flowControl.state === "paused"
            ? "FLOW_PROVIDER_PAUSED"
            : "FLOW_PROVIDER_STOPPED"
          : err?.code || "GEN_FAILED";
      const msg = stopped
        ? "\u0110\xE3 hu\u1EF7 (d\u1EEBng th\u1EE7 c\xF4ng ho\u1EB7c cancel_all)."
        : err?.message || String(err);
      if (!stopped) console.error("[McpExecutor] L\u1ED7i:", err?.message);
      if (
        generationStarted &&
        !generationFinished &&
        !err?.confirmationPending
      ) {
        const promptList =
          recoveryRoute?.promptList ||
          (Array.isArray(args?.prompts) && args.prompts.length
            ? [...args.prompts]
            : args?.prompt
              ? [args.prompt]
              : []);
        await this._saveGenHistory({
          promptList,
          mediaType: command === "gen_video" ? "video" : "image",
          model: this._historyModel(
            provider,
            recoveryRoute?.settingsSnapshot?.model || args?.model,
            command === "gen_video",
          ),
          ratio: recoveryRoute?.settingsSnapshot?.ratio || args?.ratio,
          quantity: args?.count || 1,
          provider,
          thumbs: [],
          resultFileIds: [],
          refFileIds: err?.refFileIds || [],
          refThumbnails: err?.refThumbnails || {},
          status: stopped ? "stopped" : "failed",
          errorReason:
            stopped && err?.stopOrigin === "user"
              ? `${err.stopReason || "USER_CANCELLED"}${err.stopSource ? `:${err.stopSource}` : ""}`
              : msg,
          stopOrigin: stopped && err?.stopOrigin === "user" ? "user" : null,
          durationMs: err?.durationMs,
          errorDetails: err?.errorDetails || [],
          flowApiVersions: err?.flowApiVersions || [],
          diagnostics: err?.diagnostics || null,
          historyRoute: err?.historyRoute || null,
        });
      }
      const delivered = await this._sendResult(
        job_id,
        "failed",
        {
          errorCode: code,
          errorMessage: msg,
          batch: err?.confirmationPending
            ? { ...(err?.batch || {}), needs_review: true, no_retry: true }
            : err?.batch || null,
        },
        {
          executionToken: this._currentExecutionToken,
          executionOutcome: "failed",
          ownedRun: this._currentOwnedRun,
        },
      );
      if (window.ExecutionGate && this._currentExecutionToken) {
        if (delivered)
          await ExecutionGate.complete(this._currentExecutionToken, "failed", {
            error: msg,
          });
        this._currentExecutionToken = null;
      }
    } finally {
      this._updateActivity(job_id, command, activityOutcome);
      if (ownsMcpLock) window.ExecutionLock?.release("mcp");
      this._stopActiveHeartbeat();
      this._currentJobId = null;
      this._currentProvider = null;
      this._currentOwnedRun = null;
      this._currentGenerationStartedAt = null;
      this._isExecuting = false;
    }
  }
  static _resolvePromptList(args) {
    const list =
      Array.isArray(args?.prompts) && args.prompts.length
        ? args.prompts
        : args?.prompt
          ? [args.prompt]
          : [];
    if (!list.length)
      throw this._err("GEN_FAILED", "Thi\u1EBFu prompt/prompts.");
    if (list.some((prompt) => typeof prompt !== "string" || !prompt.trim())) {
      throw this._err(
        "VALIDATION_ERROR",
        "Every prompt must be a non-empty string; blank slots cannot be removed because refs_per_prompt is positional.",
      );
    }
    return [...list];
  }
  static async _executeGen(args, isVideo) {
    const provider = args.provider || "flow";
    if (provider === "chatgpt") return this._executeChatGPTGen(args);
    if (provider === "grok") return this._executeGrokGen(args, isVideo);
    if (provider === "gemini") return this._executeGeminiGen(args, isVideo);
    if (provider === "muse") return this._executeMuseGen(args, isVideo);
    if (provider === "flow") return this._executeFlowGen(args, isVideo);
    throw this._err(
      "UNSUPPORTED_PROVIDER",
      `Provider kh\xF4ng \u0111\u01B0\u1EE3c h\u1ED7 tr\u1EE3: ${provider}`,
    );
  }
  static async _prepareOwnedMcpGen(args, isVideo, jobId) {
    const provider = args?.provider || "flow";
    if (provider === "muse" && args.muse_gen_mode === "api") return null;
    if (!["chatgpt", "muse", "gemini"].includes(provider)) return null;
    if (
      !window.ExecutionConfig?.getConfig ||
      !window.ExecutionConfig?.getProviderWebSurface
    )
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "MCP worker config ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    await window.ExecutionConfig.getConfig(true);
    const surface = window.ExecutionConfig.getProviderWebSurface(
      "mcp_direct",
      provider,
    );
    if (surface?.surfaceEnabled === false) return null;
    if (surface?.surfaceEnabled !== true)
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "MCP worker admission kh\xF4ng h\u1EE3p l\u1EC7.",
      );
    if (provider === "chatgpt" && isVideo)
      throw this._err(
        "UNSUPPORTED_MEDIA_TYPE",
        "ChatGPT Web worker ch\u1EC9 h\u1ED7 tr\u1EE3 \u1EA3nh.",
      );
    if (Number(args?.count || 1) !== 1)
      throw this._err(
        "VALIDATION_ERROR",
        "MCP Web worker ch\u1EC9 h\u1ED7 tr\u1EE3 m\u1ED9t k\u1EBFt qu\u1EA3 cho m\u1ED7i prompt.",
      );
    if (Array.isArray(args?.reuse_refs) && args.reuse_refs.length)
      throw this._err(
        "VALIDATION_ERROR",
        "MCP Web worker ch\u01B0a h\u1ED7 tr\u1EE3 reuse_refs cho provider n\xE0y.",
      );
    const scheduler = window.ProviderWebScheduler;
    const store = window.ProviderWebQueueStore;
    if (
      !scheduler?.createOwned ||
      !scheduler?.runOwned ||
      !scheduler?.settleOwned ||
      !store?.consumerSnapshot ||
      !store?.getConsumerAsset
    )
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "MCP worker runtime ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    const userId = String(window.authManager?.getUser?.()?.id || "");
    if (!userId)
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "MCP worker thi\u1EBFu t\xE0i kho\u1EA3n \u0111ang \u0111\u0103ng nh\u1EADp.",
      );
    const mediaType = isVideo ? "video" : "image";
    const promptList = this._resolvePromptList(args);
    const adapter = window.ProviderRegistry?.get?.(provider);
    if (
      adapter?.key !== provider ||
      !window.featureGate?.canUse?.(`${provider}_enabled`) ||
      !window.featureGate?.canUse?.(`${provider}_mcp_enabled`)
    )
      throw this._err(
        "FEATURE_NOT_IN_PLAN",
        `${provider} MCP kh\xF4ng kh\u1EA3 d\u1EE5ng cho t\xE0i kho\u1EA3n n\xE0y.`,
      );
    let museWorkerDownload = null;
    if (provider === "muse" && mediaType === "image") {
      const settings = await chrome.storage.local.get(["af_settings"]);
      if (
        settings.af_settings?.museDeleteAfterGen === true &&
        adapter.capabilities?.supportsDeleteAfterGen === true
      )
        museWorkerDownload = await this._getMcpDownloadSettings();
    }
    let models =
      window.ModelRegistry?.safeGetModelsSync?.(provider, mediaType) || [];
    if (!models.length && window.ModelRegistry?.getModels)
      models = await window.ModelRegistry.getModels(provider, mediaType);
    const selectedModel =
      args?.model || models.find((item) => item?.is_default)?.value || null;
    if (!selectedModel || !models.some((item) => item.value === selectedModel))
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `${provider} ${mediaType} model config ch\u01B0a h\u1EE3p l\u1EC7.`,
      );
    let ratios =
      window.ProviderConfigManager?.safeGetRatiosSync?.(provider, mediaType) ||
      [];
    if (!ratios.length && window.ProviderConfigManager?.getRatios)
      ratios = await window.ProviderConfigManager.getRatios(
        provider,
        mediaType,
      );
    const selectedRatio =
      args?.ratio ||
      ratios.find((item) => item?.is_default)?.value ||
      ratios[0]?.value ||
      null;
    if (
      !selectedRatio ||
      !ratios.some(
        (item) =>
          item?.value === selectedRatio || item?.ui_name === selectedRatio,
      )
    )
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `${provider} ${mediaType} ratio config ch\u01B0a h\u1EE3p l\u1EC7.`,
      );
    const cleanupAfterDownload = museWorkerDownload?.autoDownload === true;
    const settingsSnapshot = {
      mediaType,
      model: selectedModel,
      ratio: selectedRatio,
      ...(provider === "muse" && args.chain
        ? {
            museGenMode: "web",
            chain: {
              enabled: true,
              kind: "video_last_frame",
              refPolicy: args.chain,
            },
          }
        : {}),
      deleteAfterGen: cleanupAfterDownload,
      autoDownload: cleanupAfterDownload,
      ...(cleanupAfterDownload
        ? {
            downloadSubFolder: this._mcpDownloadTaskName(
              museWorkerDownload.downloadFolder,
              args?.batch_name,
            ),
          }
        : {}),
    };
    await scheduler._promptConfig(provider, settingsSnapshot);
    const maxRefs =
      provider === "chatgpt"
        ? Number(adapter.capabilities?.maxRefImages) || 0
        : Number(
            adapter.getMaxRefImages?.({
              mode: mediaType,
              modelValue: selectedModel,
            }),
          ) || 0;
    const promptImages = await this._resolvePromptImages(
      args,
      promptList.length,
      maxRefs,
    );
    if (
      promptImages.some((refs) => refs.length) &&
      !window.featureGate?.canUseProviderRefImages?.(provider)
    )
      throw this._err(
        "FEATURE_NOT_IN_PLAN",
        `${provider} reference images ch\u01B0a \u0111\u01B0\u1EE3c b\u1EADt.`,
      );
    const refAssets = [];
    const prompts = [];
    for (const [index, text] of promptList.entries()) {
      const refKeys = [];
      for (const ref of promptImages[index]) {
        const id = crypto.randomUUID();
        const blob = await (
          await fetch(`data:${ref.type};base64,${ref.base64}`)
        ).blob();
        if (!blob.size || !blob.type.startsWith("image/"))
          throw this._err(
            "REF_FETCH_FAILED",
            "\u1EA2nh tham chi\u1EBFu kh\xF4ng h\u1EE3p l\u1EC7.",
          );
        refAssets.push({
          id,
          blob,
          name: ref.name || `ref-${index}`,
          type: ref.type,
        });
        refKeys.push(id);
      }
      prompts.push({ text, refKeys, quantity: 1 });
    }
    if (provider === "muse" && args.chain)
      window.MuseVideoContinuity.validate(settingsSnapshot, prompts);
    if (provider === "gemini") {
      const account = await window.GeminiSession?.ensureReady?.({
        createIfMissing: true,
        activate: false,
        focusWindow: false,
        silent: true,
      });
      if (!account?.ready || !Number.isInteger(account.tabId))
        throw this._err(
          "PROVIDER_TAB_NOT_READY",
          "Gemini account ch\u01B0a s\u1EB5n s\xE0ng.",
        );
    }
    return {
      userId,
      provider,
      mediaType,
      promptList,
      settingsSnapshot,
      prompts,
      batchName: args.batch_name || null,
      refAssets,
      owner: { mcpJobId: jobId, runnerId: await this._runnerId() },
    };
  }
  static async _readMuseDirectDisplay(route) {
    const store = window.ProviderWebQueueStore,
      thumbs = [],
      failed = [];
    const snapshot = await store.consumerSnapshot(
      route.existingRunId,
      route.userId,
      route.owner,
    );
    for (const item of snapshot.items) {
      if (item.state !== "COMPLETED" || !item.verifiedReceipts?.length) {
        failed.push({
          index: item.promptIndex,
          prompt: route.promptList[item.promptIndex],
          error: item.error || "MUSE_BATCH_INTERRUPTED_REVIEW",
          noRetry: true,
        });
        continue;
      }
      for (const receipt of item.verifiedReceipts) {
        const asset = await store.getConsumerAsset(
          route.existingRunId,
          route.userId,
          route.owner,
          item.promptIndex,
          receipt.assetKey,
        );
        if (!(asset?.blob instanceof Blob) || !asset.blob.size)
          throw this._err(
            "RESULT_MEDIA_UNAVAILABLE",
            "MUSE_LOCAL_ASSET_MISSING",
          );
        thumbs.push({
          type: receipt.mediaType,
          provider: "muse",
          _savedBlob: asset.blob,
          require_durable: true,
          file_name: `muse_${item.promptIndex}_${receipt.index ?? 0}.mp4`,
          batch_id: route.existingRunId,
          batch_source: "web_run",
          prompt_index: item.promptIndex,
          result_index: receipt.resultIndex ?? receipt.index ?? 0,
          identity: receipt.identity,
        });
      }
    }
    if (!thumbs.length)
      throw Object.assign(
        this._err(
          "MUSE_BATCH_INTERRUPTED_REVIEW",
          "MUSE_BATCH_INTERRUPTED_REVIEW",
        ),
        { batch: this._buildBatch(route.promptList.length, failed, 0) },
      );
    return {
      thumbnails: thumbs,
      batch: this._buildBatch(route.promptList.length, failed),
    };
  }
  static async _executeOwnedMcpGen(route) {
    if (route.nativeReadOnly) return this._readMuseDirectDisplay(route);
    const {
      userId,
      provider,
      mediaType,
      promptList,
      settingsSnapshot,
      prompts,
      refAssets,
      owner,
      batchName,
    } = route;
    if (this._wasStopped || this._cancelRequested)
      throw this._err(
        "CANCELLED",
        "MCP job \u0111\xE3 d\u1EEBng tr\u01B0\u1EDBc khi t\u1EA1o worker run.",
      );
    const runId =
      route.existingRunId ||
      (await window.ProviderWebScheduler.createOwned({
        userId,
        provider,
        source: "mcp_direct",
        settingsSnapshot,
        prompts,
        refAssets,
        owner,
        batchName,
      }));
    const startedAt = Date.now();
    const trace = (stage, details = {}) =>
      console.info(
        "[McpOwnedProgress]",
        JSON.stringify({
          jobId: owner.mcpJobId,
          runId,
          provider,
          stage,
          elapsedMs: Date.now() - startedAt,
          ...details,
        }),
      );
    trace("worker_start", { promptCount: prompts.length });
    this._currentOwnedRun = {
      runId,
      userId,
      owner,
      status: null,
      successfulCount: 0,
    };
    if (!route.existingRunId)
      window.genBatchListModal
        ?.openProviderRun?.(provider, runId)
        .catch((error) =>
          console.warn(
            "[McpExecutor] Batch list open:",
            error?.message || error,
          ),
        );
    if (this._wasStopped || this._cancelRequested) {
      await this._stopOwnedMcpRun("MCP_CANCEL");
      await window.ProviderWebQueueStore.deleteUnreservedOwnedRun?.(
        runId,
        userId,
        owner,
      );
      this._currentOwnedRun = null;
      throw this._err(
        "CANCELLED",
        "MCP job \u0111\xE3 d\u1EEBng tr\u01B0\u1EDBc khi worker submit.",
      );
    }
    const retainedMainLayouts = new Map();
    const retainMainLayout = (layout) =>
      retainedMainLayouts.set(layout.runId, layout);
    let outcome;
    try {
      outcome = await window.ProviderWebScheduler.runOwned(
        runId,
        userId,
        owner,
        { retainMainLayout },
      );
      const configuredRetries = Number(
        window.ExecutionConfig?.getWorkflowConfig?.()?.max_retries,
      );
      const maxRetries =
        window.featureGate?.canUse?.("retry_on_fail") === true &&
        Number.isSafeInteger(configuredRetries) &&
        configuredRetries > 0
          ? configuredRetries
          : 0;
      for (
        let retry = 0;
        retry < maxRetries &&
        ["failed", "partial"].includes(outcome.status) &&
        !this._wasStopped &&
        !this._cancelRequested;
        retry++
      ) {
        let requeued;
        try {
          requeued = await window.ProviderWebQueueStore.retryOwnedMcpPreSubmit(
            runId,
            userId,
            owner,
            maxRetries,
          );
        } catch (error) {
          console.warn(
            "[McpExecutor] Worker retry check unavailable:",
            error?.message || error,
          );
          break;
        }
        if (!requeued) break;
        try {
          outcome = await window.ProviderWebScheduler.runOwned(
            runId,
            userId,
            owner,
            { retainMainLayout },
          );
        } catch (error) {
          console.warn(
            "[McpExecutor] Worker retry dispatch stopped:",
            error?.message || error,
          );
          break;
        }
      }
    } finally {
      for (const layout of retainedMainLayouts.values()) {
        try {
          await window.ProviderWebScheduler.restoreMainWindowLayout(
            layout.runId,
            layout.windowId,
          );
        } catch (error) {
          console.warn(
            "[McpExecutor] Worker layout restore:",
            error?.message || error,
          );
        }
      }
    }
    if (window.ProviderWebQueueStore.clearRetryPending) {
      const cleared = await window.ProviderWebQueueStore.clearRetryPending(
        runId,
      ).catch((error) => {
        console.warn(
          "[McpExecutor] Retry status cleanup:",
          error?.message || error,
        );
        return 0;
      });
      if (cleared) window.eventBus?.emit?.("provider_web:changed", { runId });
    }
    const snapshot = await window.ProviderWebQueueStore.consumerSnapshot(
      runId,
      userId,
      owner,
    );
    trace("worker_finished", {
      status: outcome.status,
      itemCount: snapshot.items.length,
    });
    if (
      outcome.status === "needs_review" ||
      snapshot.items.some(
        (item) =>
          item.reviewRequired ||
          item.state === "NEEDS_REVIEW" ||
          ["PREPARING", "SUBMITTING", "MONITORING"].includes(item.state),
      )
    ) {
      this._currentOwnedRun.status = "needs_review";
      const failed = snapshot.items
        .filter(
          (item) =>
            item.state !== "COMPLETED" || !item.verifiedReceipts?.length,
        )
        .map((item) => ({
          index: item.promptIndex,
          prompt: promptList[item.promptIndex],
          error: item.error || item.state || "NEEDS_REVIEW",
        }));
      const succeeded = snapshot.items.filter(
        (item) => item.state === "COMPLETED" && item.verifiedReceipts?.length,
      ).length;
      const error = this._err(
        "PROVIDER_RESULT_UNVERIFIED",
        "MCP worker c\u1EA7n \u0111\u1ED1i so\xE1t k\u1EBFt qu\u1EA3; kh\xF4ng g\u1EEDi l\u1EA1i prompt khi ch\u01B0a r\xF5 l\u01B0\u1EE3t \u0111\xE3 ch\u1EA1y.",
      );
      error.batch = this._buildBatch(promptList.length, failed, succeeded);
      const evidence = await this._ownedWorkerReviewEvidence(
        snapshot,
        runId,
        userId,
        owner,
      );
      error.errorDetails = evidence.errorDetails;
      error.diagnostics = evidence.diagnostics;
      throw error;
    }
    const thumbs = [],
      failedPrompts = [];
    for (const item of snapshot.items) {
      const index = item.promptIndex;
      if (item.state !== "COMPLETED") {
        failedPrompts.push({
          index,
          prompt: promptList[index],
          error: item.error || "Kh\xF4ng c\xF3 k\u1EBFt qu\u1EA3 x\xE1c minh",
          errorCode: this._mcpErrorCode(item.error),
        });
      }
      if (
        !["COMPLETED", "PARTIAL_FAIL"].includes(item.state) ||
        !item.verifiedReceipts?.length
      )
        continue;
      for (const [mediaIndex, receipt] of item.verifiedReceipts.entries()) {
        if (receipt.mediaType !== mediaType)
          throw this._err(
            "RESULT_MEDIA_UNAVAILABLE",
            "Provider tr\u1EA3 media kh\xE1c lo\u1EA1i y\xEAu c\u1EA7u.",
          );
        const asset = await window.ProviderWebQueueStore.getConsumerAsset(
          runId,
          userId,
          owner,
          index,
          receipt.assetKey,
        );
        if (!asset?.blob?.size || !asset.blob.type.startsWith(`${mediaType}/`))
          throw this._err(
            "RESULT_MEDIA_UNAVAILABLE",
            "Worker result bytes kh\xF4ng h\u1EE3p l\u1EC7.",
          );
        const base64 = await this._blobToBase64(asset.blob);
        thumbs.push({
          type: mediaType,
          provider,
          base64,
          mime_type: asset.blob.type,
          file_name: `${provider}_${index + 1}_${mediaIndex + 1}.${mediaType === "video" ? "mp4" : "png"}`,
          require_durable: true,
          promptIndex: index,
          batch_id: runId,
          batch_source: "web_run",
          prompt_index: index,
          result_index: Number.isInteger(receipt.resultIndex)
            ? receipt.resultIndex
            : mediaIndex,
          identity: receipt.identity || null,
        });
      }
    }
    this._currentOwnedRun.successfulCount = snapshot.items.filter(
      (item) => item.state === "COMPLETED",
    ).length;
    this._currentOwnedRun.status = failedPrompts.length
      ? thumbs.length
        ? "partial"
        : "failed"
      : "success";
    if (!thumbs.length)
      throw Object.assign(
        this._err(
          this._firstGenerationFailureCode(failedPrompts) || "GEN_FAILED",
          failedPrompts[0]?.error ||
            "Provider kh\xF4ng tr\u1EA3 k\u1EBFt qu\u1EA3 x\xE1c minh.",
        ),
        { batch: this._buildBatch(promptList.length, failedPrompts, 0) },
      );
    trace("media_export_start", { resultCount: thumbs.length });
    const converted = await this._convertForMcp(thumbs, null);
    trace("media_export_done", { resultCount: converted.length });
    if (converted.length !== thumbs.length)
      throw this._err(
        "RESULT_MEDIA_UNAVAILABLE",
        "M\u1ED9t s\u1ED1 worker media kh\xF4ng th\u1EC3 chuy\u1EC3n v\u1EC1 MCP.",
      );
    if (!route.existingRunId) {
      const downloadedInWorkers = new Set();
      if (settingsSnapshot.autoDownload) {
        const owned = await window.ProviderWebQueueStore.getOwnedRun(
          runId,
          userId,
          owner,
        );
        for (const item of owned?.items || [])
          if (item.downloadState === "completed")
            downloadedInWorkers.add(item.promptIndex);
      }
      await this._downloadOwnedMcpResults(
        converted,
        thumbs,
        promptList,
        mediaType,
        route.batchName,
        downloadedInWorkers,
      );
    }
    trace("download_done");
    await this._saveGenHistory({
      promptList,
      mediaType,
      model: settingsSnapshot.model,
      ratio: settingsSnapshot.ratio,
      quantity: 1,
      refFileIds: [],
      thumbs: converted,
      resultFileIds: [],
      provider,
      failedPrompts,
    });
    trace("history_done");
    return {
      thumbnails: converted,
      _convertedThumbs: true,
      batch: this._buildBatch(
        promptList.length,
        failedPrompts,
        this._currentOwnedRun.successfulCount,
      ),
    };
  }
  static async _ownedWorkerReviewEvidence(snapshot, runId, userId, owner) {
    const store = window.ProviderWebQueueStore;
    let owned = null;
    try {
      owned = await store.getOwnedRun(runId, userId, owner);
    } catch (_) {}
    const sourceItems = new Map(
      (owned?.items || []).map((item) => [item.promptIndex, item]),
    );
    const unresolved = (snapshot.items || []).filter(
      (item) => item.state !== "COMPLETED" || !item.verifiedReceipts?.length,
    );
    const failures = await Promise.all(
      unresolved.slice(0, 20).map(async (item) => {
        const source = sourceItems.get(item.promptIndex);
        let attempt = null;
        if (source?.attemptId && store.getAttempt) {
          try {
            attempt = await store.getAttempt(source.attemptId);
          } catch (_) {}
        }
        const stages = [];
        if (
          ["pre_submit", "intent_request", "dispatch_intent"].includes(
            attempt?.submitStage,
          )
        )
          stages.push({ event: "worker_attempt", stage: attempt.submitStage });
        if (attempt?.clickGrantedAt)
          stages.push({ event: "click_granted", stage: "dispatch_intent" });
        if (attempt?.sendObservedAt)
          stages.push({ event: "send_observed", stage: "dispatch_intent" });
        return {
          promptIndex: item.promptIndex,
          state: /^[A-Z_]{1,40}$/.test(item.state || "")
            ? item.state
            : "NEEDS_REVIEW",
          retrySubmitCount: Number.isSafeInteger(source?.retrySubmitCount)
            ? source.retrySubmitCount
            : 0,
          operationIdAvailable: false,
          stages,
        };
      }),
    );
    const errorDetails = unresolved
      .filter((item) => item.state !== "QUEUED")
      .slice(0, 100)
      .map((item) => ({
        promptIndex: item.promptIndex,
        code: /^[A-Z][A-Z0-9_]{0,79}$/.test(item.error || "")
          ? item.error
          : "PROVIDER_RESULT_UNVERIFIED",
        provider: this._currentProvider || null,
      }));
    const count = (state) =>
      snapshot.items.filter((item) => item.state === state).length;
    return {
      errorDetails,
      diagnostics: {
        version: 2,
        droppedEvents: 0,
        events: [],
        summary: {
          total: snapshot.items.length,
          completed: count("COMPLETED"),
          failed: count("FAILED"),
          partial: count("PARTIAL_FAIL"),
          cancelled: count("CANCELLED"),
          unfinished:
            snapshot.items.length -
            ["COMPLETED", "FAILED", "PARTIAL_FAIL", "CANCELLED"].reduce(
              (sum, state) => sum + count(state),
              0,
            ),
        },
        failedPromptCount: unresolved.length,
        omittedFailedPrompts: Math.max(0, unresolved.length - failures.length),
        failures,
      },
    };
  }
  static async _downloadOwnedMcpResults(
    converted,
    source,
    prompts,
    mediaType,
    batchName = null,
    skipPromptIndexes = new Set(),
  ) {
    const config = await this._getMcpDownloadSettings();
    if (
      !config.autoDownload ||
      !window.DownloadHelper?.downloadExternalMedia ||
      !window.DownloadHelper?.getSettings ||
      !window.DownloadHelper?.buildFilename
    )
      return;
    let naming;
    try {
      naming = await window.DownloadHelper.getSettings();
    } catch (error) {
      console.warn(
        "[McpExecutor] Worker download settings:",
        error?.message || error,
      );
      return;
    }
    for (const [index, item] of converted.entries()) {
      const raw = source[index];
      if (skipPromptIndexes.has(raw?.promptIndex)) continue;
      const url =
        (mediaType === "video"
          ? item.video_url || item.url
          : item.url || item.video_url) ||
        (item.base64
          ? `data:${item.mime_type || raw?.mime_type || "image/png"};base64,${item.base64}`
          : null);
      if (!url) continue;
      try {
        const filename = window.DownloadHelper.buildFilename({
          template: naming.template,
          project: naming.project,
          prompt: prompts[raw.promptIndex] || "",
          index: index + 1,
          taskName: this._mcpDownloadTaskName(config.downloadFolder, batchName),
          folder: naming.folder,
          ext: mediaType === "video" ? "mp4" : "png",
        });
        const result = await window.DownloadHelper.downloadExternalMedia({
          url,
          filename,
          mediaType,
          waitForComplete: false,
        });
        if (!result?.success)
          console.warn(
            "[McpExecutor] Worker auto-download failed:",
            result?.error,
          );
      } catch (error) {
        console.warn(
          "[McpExecutor] Worker auto-download error:",
          error?.message || error,
        );
      }
    }
  }
  static async _stopOwnedMcpRun(stopSource) {
    const batch = this._currentSavedBatchRun;
    if (
      batch &&
      String(window.authManager?.getUser?.()?.id) === String(batch.userId)
    ) {
      const stored = (await window.ProviderWebQueueStore.getRun(batch.runId))
        ?.run;
      if (
        String(stored?.userId) === String(batch.userId) &&
        stored.projectId === batch.projectId
      )
        await window.ProviderWebScheduler.stop(batch.runId, stopSource);
    }
    const run = this._currentOwnedRun;
    if (!run || !window.ProviderWebScheduler?.stopOwned) return;
    await window.ProviderWebScheduler.stopOwned(
      run.runId,
      run.userId,
      run.owner,
      stopSource,
    );
  }
  static async _classifyOwnedMcpFailure(error = null) {
    const run = this._currentOwnedRun;
    if (!run) return;
    try {
      const snapshot = await window.ProviderWebQueueStore.getOwnedRun(
        run.runId,
        run.userId,
        run.owner,
      );
      if (!snapshot?.reservation?.token) {
        if (
          snapshot?.run?.status === "QUEUED" &&
          [400, 403, 422].includes(Number(error?.httpStatus))
        ) {
          const deleted =
            await window.ProviderWebQueueStore.deleteUnreservedOwnedRun(
              run.runId,
              run.userId,
              run.owner,
            );
          if (deleted) {
            console.warn(
              "[McpExecutor] Owned admission rejected:",
              JSON.stringify({
                code: error?.code || null,
                httpStatus: error?.httpStatus || null,
                runId: run.runId,
              }),
            );
            this._currentOwnedRun = null;
            return;
          }
        }
        this._currentOwnedRun = null;
        return;
      }
      const consumer = await window.ProviderWebQueueStore.consumerSnapshot(
        run.runId,
        run.userId,
        run.owner,
      );
      const terminal = new Set([
        "COMPLETED",
        "FAILED",
        "PARTIAL_FAIL",
        "CANCELLED",
      ]);
      if (
        consumer.items.length &&
        consumer.items.every(
          (item) => terminal.has(item.state) && !item.reviewRequired,
        )
      ) {
        const successful = consumer.items.filter(
          (item) => item.state === "COMPLETED" && item.verifiedReceipts?.length,
        ).length;
        run.successfulCount = successful;
        run.status =
          successful === consumer.items.length
            ? "success"
            : successful > 0
              ? "partial"
              : "failed";
        return;
      }
      const attempts = await Promise.all(
        (snapshot.items || [])
          .filter((item) => item.attemptId)
          .map((item) =>
            window.ProviderWebQueueStore.getAttempt(item.attemptId),
          ),
      );
      const dispatched =
        snapshot.items.some((item) => item.state === "NEEDS_REVIEW") ||
        attempts.some(
          (attempt) => attempt?.clickGrantedAt || attempt?.sendObservedAt,
        );
      run.status = dispatched ? "needs_review" : "failed";
    } catch (_) {
      run.status = "needs_review";
    }
  }
  static _flowProjectTimeoutMs() {
    let timeoutMs = 0;
    try {
      timeoutMs = Number(window.SystemConfig?.getTimeout?.("api_timeout_ms"));
    } catch (_) {}
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Flow context timeout config ch\u01B0a t\u1EA3i t\u1EEB server.",
      );
    }
    return timeoutMs;
  }
  static async _flowProjectRequest(
    message,
    timeoutMs = this._flowProjectTimeoutMs(),
  ) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, context) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(context);
      };
      const unavailable = () =>
        this._err(
          "PROVIDER_TAB_NOT_READY",
          "Kh\xF4ng nh\u1EADn \u0111\u01B0\u1EE3c Flow context t\u1EEB relay. Ki\u1EC3m tra k\u1EBFt n\u1ED1i extension v\xE0 tab Flow r\u1ED3i th\u1EED l\u1EA1i; ch\u01B0a th\u1EC3 k\u1EBFt lu\u1EADn c\u1EA7n t\u1EA1o project m\u1EDBi.",
        );
      const timer = setTimeout(() => finish(unavailable()), timeoutMs);
      try {
        chrome.runtime.sendMessage(message, (context) => {
          if (
            chrome.runtime.lastError ||
            !context ||
            typeof context !== "object"
          )
            finish(unavailable());
          else finish(null, context);
        });
      } catch (_) {
        finish(unavailable());
      }
    });
  }
  static _readFlowProjectContext({ tabId = null, timeoutMs } = {}) {
    return this._flowProjectRequest(
      {
        action: "getFlowProjectContext",
        ...(tabId != null ? { targetTabId: tabId } : {}),
      },
      timeoutMs,
    );
  }
  static async _ensureFlowProjectContext({
    projectId = null,
    tabId = null,
    allowNavigation = false,
    forcePrepare = false,
    purpose = "execution",
  } = {}) {
    if (this._cancelRequested)
      throw this._err("CANCELLED", "Flow preparation cancelled.");
    let context = await this._readFlowProjectContext({ tabId });
    if (this._cancelRequested)
      throw this._err("CANCELLED", "Flow preparation cancelled.");
    if (context.signedOut === true)
      throw this._err(
        "PROVIDER_NOT_LOGGED_IN",
        "\u0110\u0103ng nh\u1EADp Google Flow r\u1ED3i th\u1EED l\u1EA1i.",
      );
    const expectedProject = projectId || context.projectId;
    const expectedTab = tabId ?? context.tabId;
    if (!expectedProject || expectedTab == null) return context;
    const sameProject = (value) =>
      String(value?.projectId || "").toLowerCase() ===
      String(expectedProject).toLowerCase();
    const initialOrigin = context.origin;
    const initialRoutePrefix = context.routePrefix;
    let arrived = sameProject(context);
    let prepared = false;
    const healthy = (value) =>
      value.contentReady !== false && !value.projectError && !value.signedOut;
    if (arrived && healthy(context) && !forcePrepare) return context;
    const startedAt = Date.now();
    const deadline = startedAt + this._flowProjectTimeoutMs();
    const operationId = `${this._currentJobId || "local"}:${purpose}:${startedAt}`;
    const trace = (stage, error = null) =>
      console.info(
        "[McpFlowReady]",
        JSON.stringify({
          operationId,
          purpose,
          stage,
          tabId: expectedTab,
          elapsedMs: Date.now() - startedAt,
          projectMatched: sameProject(context),
          contentReady: context.contentReady ?? null,
          contextSource: context.contextSource || null,
          code: error,
        }),
      );
    const changed = () =>
      this._err(
        "PROJECT_MISMATCH",
        "Flow tab, t\xE0i kho\u1EA3n ho\u1EB7c project \u0111\xE3 \u0111\u1ED5i trong l\xFAc chu\u1EA9n b\u1ECB.",
      );
    trace("waiting");
    do {
      if (this._cancelRequested) {
        trace("cancelled");
        throw this._err("CANCELLED", "Flow preparation cancelled.");
      }
      if (
        (context.tabId != null && context.tabId !== expectedTab) ||
        (initialOrigin && context.origin && initialOrigin !== context.origin) ||
        (initialRoutePrefix != null &&
          context.routePrefix != null &&
          initialRoutePrefix !== context.routePrefix)
      ) {
        trace("target_changed");
        throw changed();
      }
      if (sameProject(context)) {
        arrived = true;
        if (context.projectError === true) return context;
        if (context.signedOut === true)
          throw this._err(
            "PROVIDER_NOT_LOGGED_IN",
            "\u0110\u0103ng nh\u1EADp Google Flow r\u1ED3i th\u1EED l\u1EA1i.",
          );
        if (healthy(context) && (!forcePrepare || prepared)) {
          trace("ready");
          return context;
        }
        if (!prepared) {
          const status = await this._flowProjectRequest(
            {
              action: "ensureFlowTabReady",
              readinessScope: "project",
              targetTabId: expectedTab,
            },
            Math.max(1, deadline - Date.now()),
          );
          prepared = true;
          trace("prepared", status.error || null);
          if (this._cancelRequested) {
            trace("cancelled");
            throw this._err("CANCELLED", "Flow preparation cancelled.");
          }
          if (
            status.error === "FLOW_EXECUTION_TARGET_CHANGED" ||
            (status.tabId != null && status.tabId !== expectedTab) ||
            (status.projectId && !sameProject(status))
          )
            throw changed();
          if (status.error === "V2_SIGNED_OUT")
            throw this._err(
              "PROVIDER_NOT_LOGGED_IN",
              "\u0110\u0103ng nh\u1EADp Google Flow r\u1ED3i th\u1EED l\u1EA1i.",
            );
          if (
            [
              "CONTENT_REVISION_MISMATCH",
              "V2_PROJECT_ERROR",
              "NO_TAB",
            ].includes(status.error)
          ) {
            throw this._err(
              "PROVIDER_TAB_NOT_READY",
              this._flowProjectReadinessError(context) ||
                "Ch\u01B0a th\u1EC3 chu\u1EA9n b\u1ECB tab Flow \u0111\u1EC3 ch\u1EA1y. Ki\u1EC3m tra l\u1EA1i project r\u1ED3i th\u1EED l\u1EA1i.",
            );
          }
          if (Date.now() < deadline) {
            context = await this._readFlowProjectContext({
              tabId: expectedTab,
              timeoutMs: Math.max(1, deadline - Date.now()),
            });
            continue;
          }
        }
      } else if (arrived || !allowNavigation) {
        trace("project_changed");
        throw changed();
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, deadline - Date.now())),
      );
      if (Date.now() >= deadline) break;
      context = await this._readFlowProjectContext({
        tabId: expectedTab,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
    } while (Date.now() < deadline);
    trace("timeout");
    throw this._err(
      "PROVIDER_TAB_NOT_READY",
      this._flowProjectReadinessError(context) ||
        "Ch\u01B0a x\xE1c nh\u1EADn Flow project s\u1EB5n s\xE0ng trong th\u1EDDi gian ch\u1EDD. Kh\xF4ng c\u1EA7n t\u1EA1o project m\u1EDBi.",
    );
  }
  static _flowProjectReadinessError(context) {
    if (context?.signedOut === true)
      return "\u0110\u0103ng nh\u1EADp Google Flow r\u1ED3i th\u1EED l\u1EA1i.";
    if (!context?.projectId) {
      return "Ch\u01B0a m\u1EDF Google Flow ho\u1EB7c ch\u01B0a v\xE0o 1 project. H\xE3y m\u1EDF Flow + v\xE0o/t\u1EA1o 1 project (ho\u1EB7c g\u1ECDi create_project) r\u1ED3i th\u1EED l\u1EA1i.";
    }
    if (context.projectError === true)
      return "Flow project \u0111ang b\xE1o l\u1ED7i ho\u1EB7c \u0111\xE3 b\u1ECB xo\xE1. Ki\u1EC3m tra project tr\xEAn tab Flow r\u1ED3i th\u1EED l\u1EA1i.";
    if (context.contentReady === false) {
      return "\u0110\xE3 m\u1EDF Flow project nh\u01B0ng content script/relay ch\u01B0a s\u1EB5n s\xE0ng. \u0110\u1EE3i tab t\u1EA3i xong; n\u1EBFu \u0111ang xem media h\xE3y tr\u1EDF l\u1EA1i editor r\u1ED3i th\u1EED l\u1EA1i. Kh\xF4ng c\u1EA7n t\u1EA1o project m\u1EDBi.";
    }
    return null;
  }
  static async _resolveFlowChain(args, isVideo, promptList, hasRef) {
    if (!args.chain) return null;
    const fail = (message) => {
      throw this._err("VALIDATION_ERROR", message);
    };
    const config = window.ProviderConfigManager?.getFlowChainConfigSync?.();
    const max = Number(
      isVideo ? config?.max_video_segments : config?.max_image_segments,
    );
    const apiCapability =
      (isVideo ? config?.video_enabled : config?.image_enabled) === true;
    const webCapability =
      (isVideo
        ? config?.video_web_chain_enabled
        : config?.image_web_chain_enabled) === true;
    if (
      !config?.enabled ||
      !Number.isFinite(max) ||
      max < 2 ||
      (!apiCapability && !webCapability)
    )
      fail("Flow chain is unavailable in server config.");
    if (promptList.length < 2 || promptList.length > max)
      fail(`Chain requires 2\u2013${max} prompts.`);
    if ((args.count || 1) !== 1) fail("Chain requires count=1.");
    if (!["generated_only", "generated_plus_mapped"].includes(args.chain))
      fail("Invalid chain policy.");
    if (isVideo && hasRef && args.video_input_type !== "Frames")
      fail("Video chain refs require Frames input.");
    const settings = (await window.storageSettings?.getSettings?.()) || {};
    const storedMode =
      args.gen_mode || settings.defaultGenMode || settings.gen_mode || "ui";
    const serverApiDisabled =
      window.SystemConfig?.get?.("flow_api_driver", null) === "disabled";
    const mode = serverApiDisabled
      ? "web"
      : storedMode === "ui"
        ? "web"
        : storedMode;
    const isFrames = isVideo && args.video_input_type === "Frames";
    const components =
      !isFrames &&
      (!!args.voice ||
        !!args.character ||
        promptList.some((prompt) =>
          window.MentionParser?.hasComponents?.(prompt),
        ));
    const apiEnabled =
      args.gen_mode === "api" ||
      [true, "true", 1].includes(settings.apiModeEnabled);
    const apiAllowed =
      apiCapability &&
      apiEnabled &&
      window.featureGate?.canUse?.("flow_api_enabled") &&
      !components;
    let ready = false;
    if (apiAllowed && mode !== "web") {
      try {
        ready =
          (
            await window.FlowApiSessionCoordinator?.check?.({
              surface: "mcp",
              mediaType: isVideo ? "video" : "image",
              force: true,
              passive: true,
            })
          )?.ready === true;
      } catch (_) {}
    }
    let engine = null;
    if (mode === "web" && webCapability) engine = "web";
    else if (mode === "api" && apiAllowed && ready) engine = "api";
    else if (mode === "auto")
      engine = apiAllowed && ready ? "api" : webCapability ? "web" : null;
    if (!engine)
      fail(`Flow ${mode} chain is not ready for the selected settings.`);
    return {
      enabled: true,
      kind: isVideo ? "video_last_frame" : "image_result",
      refPolicy: isVideo && hasRef ? "generated_plus_mapped" : args.chain,
      engine,
      allowWebFallback: mode === "auto" && engine === "api" && webCapability,
    };
  }
  static async _resolvePromptImages(args, promptCount, maxRefs) {
    if (args.ref_mode === "none")
      return Array.from({ length: promptCount }, () => []);
    const perPrompt =
      Array.isArray(args.refs_per_prompt) && args.refs_per_prompt.length > 0;
    if (perPrompt && args.refs_per_prompt.length !== promptCount)
      throw this._err(
        "VALIDATION_ERROR",
        "refs_per_prompt must match prompts length.",
      );
    const sets = perPrompt ? args.refs_per_prompt : [args.refs || []];
    const resolved = [];
    for (const refs of sets) {
      if (Number.isInteger(maxRefs) && refs.length > maxRefs)
        throw this._err("VALIDATION_ERROR", "Reference image limit exceeded.");
      resolved.push(
        await this._resolveRefsToImages(refs, maxRefs ?? refs.length),
      );
    }
    return perPrompt
      ? resolved
      : Array.from({ length: promptCount }, () => resolved[0]);
  }
  static async _executeFlowGen(args, isVideo) {
    const {
      prompt,
      prompts,
      ratio,
      model,
      count,
      refs,
      refs_per_prompt,
      ref_mode,
      duration,
      resolution,
      video_input_type,
      voice,
      character,
      reuse_refs,
    } = args;
    const promptList = this._resolvePromptList(args);
    if (!promptList.length)
      throw this._err("GEN_FAILED", "Thi\u1EBFu prompt/prompts.");
    if (isVideo && video_input_type === "Frames") {
      if (voice || character) {
        throw this._err(
          "VALIDATION_ERROR",
          "Flow Frames does not support voice or character selection. Remove voice/character or use Ingredients.",
        );
      }
    }
    const requestedRefSets = refs_per_prompt?.length
      ? refs_per_prompt
      : [refs || []];
    if (
      isVideo &&
      video_input_type === "Frames" &&
      ref_mode !== "none" &&
      requestedRefSets.some(
        (set) =>
          set.length + (refs_per_prompt?.length ? 0 : reuse_refs?.length || 0) >
          2,
      )
    ) {
      throw this._err(
        "VALIDATION_ERROR",
        "Flow Frames accepts at most 2 images (first and last frame).",
      );
    }
    if (!window.PromptQueue || !PromptQueue.isEnabled?.()) {
      throw this._err(
        "GEN_FAILED",
        "PromptQueue ch\u01B0a s\u1EB5n s\xE0ng (c\u1EA7n b\u1EADt pipeline queue).",
      );
    }
    const flowRatio = await this._resolveFlowRatio(ratio, isVideo);
    if (
      !window.ModelRegistry?.getDefaultAsync ||
      !window.ModelRegistry?.findModel
    ) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Flow model registry ch\u01B0a s\u1EB5n s\xE0ng. Reload extension r\u1ED3i th\u1EED l\u1EA1i.",
      );
    }
    let effectiveModel = model || null;
    if (!effectiveModel) {
      try {
        effectiveModel = await window.ModelRegistry.getDefaultAsync(
          "flow",
          isVideo ? "video" : "image",
        );
      } catch (error) {
        throw this._err(
          "CONFIG_UNAVAILABLE",
          `Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c model Flow m\u1EB7c \u0111\u1ECBnh: ${error?.message || "unknown error"}`,
        );
      }
    }
    if (!effectiveModel) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `Kh\xF4ng c\xF3 model Flow ${isVideo ? "video" : "image"} kh\u1EA3 d\u1EE5ng t\u1EEB server.`,
      );
    }
    if (resolution) {
      const config = isVideo
        ? window.ModelRegistry.getGenerationResolutionConfig?.(
            "flow",
            effectiveModel,
          )
        : null;
      if (!config?.options?.some((option) => option.value === resolution)) {
        throw this._err(
          "VALIDATION_ERROR",
          `resolution "${resolution}" is invalid for Flow model "${effectiveModel}".`,
        );
      }
    }
    const flowContext = await this._ensureFlowProjectContext({
      projectId: args._savedFlowScope?.projectId || null,
      purpose: "generate",
    });
    if (args._savedFlowScope) {
      this._assertSavedResultScope(args._savedFlowScope);
      if (
        String(flowContext.projectId).toLowerCase() !==
        String(args._savedFlowScope.projectId).toLowerCase()
      )
        throw this._err(
          "PROJECT_MISMATCH",
          "Flow project changed after preparing saved references.",
        );
    }
    const readinessError = this._flowProjectReadinessError(flowContext);
    if (readinessError)
      throw this._err("PROVIDER_TAB_NOT_READY", readinessError);
    try {
      await new Promise((r) =>
        chrome.runtime.sendMessage(
          {
            action: "activateFlowTabForExecution",
            tabId: flowContext.tabId,
            focusWindow: true,
          },
          () => r(),
        ),
      );
      await new Promise((r) => setTimeout(r, 400));
    } catch (_) {}
    const requestedRefs =
      ref_mode !== "none" &&
      (!!reuse_refs?.length || requestedRefSets.some((set) => set.length));
    const chain = await this._resolveFlowChain(
      args,
      isVideo,
      promptList,
      requestedRefs,
    );
    if (
      chain &&
      isVideo &&
      video_input_type === "Frames" &&
      !(
        ref_mode !== "none" &&
        (Array.isArray(refs_per_prompt) && refs_per_prompt.length
          ? requestedRefSets[0]?.length
          : (refs?.length || 0) + (reuse_refs?.length || 0))
      )
    ) {
      throw this._err(
        "VALIDATION_ERROR",
        "Video chain Frames requires a start image for the first prompt.",
      );
    }
    if (chain && isVideo && requestedRefs) {
      const perPrompt =
        Array.isArray(refs_per_prompt) && refs_per_prompt.length > 0;
      if (
        (perPrompt &&
          (requestedRefSets[0]?.length > 2 ||
            requestedRefSets.slice(1).some((set) => set.length > 1))) ||
        (!perPrompt && (refs?.length || 0) + (reuse_refs?.length || 0) > 1)
      ) {
        throw this._err(
          "VALIDATION_ERROR",
          "Video chain accepts at most two initial frames and one mapped image for each later prompt.",
        );
      }
    }
    const refFileIds = [];
    const refFileNames = {};
    const refThumbnails = {};
    let refFileIdsPerPrompt = null;
    let refImageMode = "none";
    const _uploadOne = async (ref) => {
      if (typeof ref !== "string" || !ref.trim()) {
        throw this._err(
          "VALIDATION_ERROR",
          "Reference image must be a non-empty base64/data URL/public URL string.",
        );
      }
      if (args._savedFlowScope)
        this._assertSavedResultScope(args._savedFlowScope);
      if (args._savedFlowRefNames?.[ref]) {
        refFileNames[ref] = args._savedFlowRefNames[ref];
        return ref;
      }
      const up = await this._uploadRefToFlow(ref);
      if (args._savedFlowScope)
        this._assertSavedResultScope(args._savedFlowScope);
      if (up?.tileId) {
        if (up.fileName) refFileNames[up.tileId] = up.fileName;
        if (up.thumbnailUrl)
          refThumbnails[up.tileId] = {
            thumbnail: up.thumbnailUrl,
            file_name: up.fileName || null,
            type: "image",
          };
        return up.tileId;
      }
      throw this._err(
        "UPLOAD_FAILED",
        "Reference image upload completed without a Flow media identity.",
      );
    };
    if (
      ref_mode !== "none" &&
      Array.isArray(refs_per_prompt) &&
      refs_per_prompt.length
    ) {
      refImageMode = "sequential";
      refFileIdsPerPrompt = [];
      for (const refSet of refs_per_prompt) {
        const ids = [];
        for (const ref of Array.isArray(refSet) ? refSet : []) {
          const id = await _uploadOne(ref);
          if (id) ids.push(id);
        }
        refFileIdsPerPrompt.push(ids);
      }
    } else if (ref_mode !== "none" && Array.isArray(refs) && refs.length) {
      refImageMode = "all";
      for (const ref of refs) {
        const id = await _uploadOne(ref);
        if (id) refFileIds.push(id);
      }
    }
    if (ref_mode !== "none" && Array.isArray(reuse_refs) && reuse_refs.length) {
      const reuseTiles = await this._resolveReuseRefs(
        reuse_refs,
        refFileNames,
        refThumbnails,
      );
      if (args._savedFlowScope)
        this._assertSavedResultScope(args._savedFlowScope);
      for (const t of reuseTiles)
        if (!refFileIds.includes(t)) refFileIds.push(t);
      if (reuseTiles.length && refImageMode !== "sequential")
        refImageMode = "all";
    }
    const genType = isVideo ? "Video" : "Image";
    const quantity = isVideo ? 1 : Math.min(count || 1, 4);
    const isFrames = isVideo && video_input_type === "Frames";
    let flowDuration = isVideo ? duration || null : null;
    const inputType = isFrames ? "Frames" : "Ingredients";
    const hasRef =
      refFileIds.length > 0 ||
      (Array.isArray(refFileIdsPerPrompt) &&
        refFileIdsPerPrompt.some((a) => a?.length));
    const flowAdapter = window.ProviderRegistry?.get?.("flow");
    if (isVideo && hasRef && flowAdapter?.getDurationOverride) {
      try {
        const forced = flowAdapter.getDurationOverride({
          modelValue: effectiveModel,
          hasRef: true,
          inputType,
        });
        if (forced && forced !== flowDuration) {
          console.warn(
            `[McpExecutor] \xA713 duration \xE9p ${flowDuration} \u2192 ${forced} (${effectiveModel} + ref)`,
          );
          flowDuration = forced;
        }
      } catch (_) {}
    }
    if (hasRef && flowAdapter?.supportsRefImages) {
      let refsSupported = true;
      try {
        refsSupported = flowAdapter.supportsRefImages(effectiveModel, {
          inputType: isVideo ? inputType : void 0,
          duration: isVideo ? flowDuration || void 0 : void 0,
        });
      } catch (_) {}
      if (!refsSupported)
        throw this._err(
          "VALIDATION_ERROR",
          `Model "${effectiveModel}" (${inputType}) does not support the supplied reference images.`,
        );
    }
    const dl = await this._getMcpDownloadSettings();
    let voicePayload = null;
    if (isVideo && voice) {
      const modelObj = window.ModelRegistry.findModel("flow", effectiveModel);
      if (!modelObj?.config?.supports_voice) {
        throw this._err(
          "VALIDATION_ERROR",
          `Model "${effectiveModel}" does not support voice. Choose a model with supports_voice (see list_capabilities) or remove voice.`,
        );
      }
      let vlist = [];
      try {
        vlist = (await window.VoiceRegistry?.getRenderList?.("flow")) || [];
      } catch (_) {}
      const v = vlist.find((x) => x.slug === voice);
      if (!v?.search_value) {
        throw this._err(
          "VALIDATION_ERROR",
          `Voice "${voice}" kh\xF4ng h\u1EE3p l\u1EC7. D\xF9ng list_voices \u0111\u1EC3 l\u1EA5y slug \u0111\xFAng.`,
        );
      }
      voicePayload = { slug: v.slug, search_value: v.search_value };
    }
    let characterPayload = null;
    if (character) {
      const modelObj = window.ModelRegistry.findModel("flow", effectiveModel);
      if (modelObj?.config?.supports_character !== true) {
        throw this._err(
          "VALIDATION_ERROR",
          `Model "${effectiveModel}" does not support characters. Choose a model with supports_character (see list_capabilities) or remove character.`,
        );
      }
      let characters = [];
      try {
        characters = (await window.CharacterRegistry?.getRenderList?.()) || [];
      } catch (_) {}
      const selected = characters.find((item) => item.slug === character);
      if (!selected?.search_value) {
        throw this._err(
          "VALIDATION_ERROR",
          `Character "${character}" kh\xF4ng h\u1EE3p l\u1EC7. D\xF9ng list_characters \u0111\u1EC3 l\u1EA5y slug hi\u1EC7n c\xF3.`,
        );
      }
      characterPayload = {
        slug: selected.slug,
        search_value: selected.search_value,
      };
    }
    const flowThinkingLevel = !isVideo
      ? window.ModelRegistry?.getThinkingLevelValue?.(
          "flow",
          effectiveModel,
          args.flow_thinking_level,
        )
      : null;
    if (args.flow_thinking_level != null && !flowThinkingLevel)
      throw this._err(
        "VALIDATION_ERROR",
        "Selected model does not support Flow image thinking levels.",
      );
    window.genBatchListModal
      ?.open?.("flow")
      .catch((error) =>
        console.warn(
          "[McpExecutor] Flow Batch list open:",
          error?.message || error,
        ),
      );
    const result = await PromptQueue.getInstance().submitJob({
      owner: "mcp",
      generationProcessId: this._currentJobId,
      mcpJobId: this._currentJobId,
      mcpBatchName: args.batch_name || null,
      mcpUserId: window.authManager?.getUser?.()?.id || null,
      chain,
      sequentialMode: args.run_mode === "sequential",
      projectId: flowContext.projectId,
      label: isVideo ? "MCP Video" : "MCP Generate",
      _executionToken: this._currentExecutionToken,
      _executionTokenManagedByCaller: true,
      prompts: promptList,
      voice: voicePayload,
      character: characterPayload,
      settings: {
        genType,
        ratio: flowRatio,
        model: effectiveModel,
        quantity,
        isFrames,
        flowVideoDuration: flowDuration,
        flowThinkingLevel,
        ...(isVideo && resolution ? { flowVideoResolution: resolution } : {}),
        ...(args.gen_mode ? { flowExecutionMode: args.gen_mode } : {}),
      },
      refImageMode,
      refFileIds,
      refFileIdsPerPrompt,
      refFileNames,
      refThumbnails,
      autoDownload: dl.autoDownload,
      downloadResolution: dl.downloadResolution,
      videoDownloadResolution: dl.videoDownloadResolution,
      taskName: dl.autoDownload
        ? this._mcpDownloadTaskName(dl.downloadFolder, args.batch_name)
        : null,
    });
    const thumbs = this._collectThumbs(result?.resultThumbnails);
    const firstFailureCode = this._firstGenerationFailureCode(
      result?.failedPrompts,
    );
    if (thumbs.length === 0)
      throw Object.assign(
        this._err(
          firstFailureCode || "GEN_FAILED",
          result?.failedPrompts?.[0]?.error ||
            result?.reason ||
            "Flow kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c k\u1EBFt qu\u1EA3 (0 \u1EA3nh/video).",
        ),
        {
          batch: this._buildBatch(
            promptList.length,
            result?.failedPrompts,
            result?.completed,
            { flow: true },
          ),
          errorDetails: result?.errorDetails || [],
          flowApiVersions: result?.flowApiVersions || [],
          historyRoute: result?.historyRoute || null,
          stopOrigin: result?.stopped ? result.stopOrigin || null : null,
          stopReason: result?.stopped ? result.stopReason || null : null,
          stopSource: result?.stopped ? result.stopSource || null : null,
          durationMs: result?.durationMs,
        },
      );
    thumbs.forEach((t) => {
      t.provider = "flow";
    });
    const allRefIds = [
      ...refFileIds,
      ...(Array.isArray(refFileIdsPerPrompt) ? refFileIdsPerPrompt.flat() : []),
    ];
    await this._saveGenHistory({
      promptList,
      mediaType: isVideo ? "video" : "image",
      model: this._historyModel("flow", effectiveModel, isVideo),
      ratio: flowRatio,
      quantity,
      refFileIds: allRefIds,
      refThumbnails,
      thumbs,
      resultFileIds: result?.resultTileIds || [],
      provider: "flow",
      status: result?.stopped ? "stopped" : null,
      stopOrigin: result?.stopOrigin || null,
      errorReason: result?.stopped
        ? result.stopReason || "BATCH_STOPPED"
        : null,
      failedPrompts: result?.failedPrompts || [],
      errorDetails: result?.errorDetails || [],
      flowApiVersions: result?.flowApiVersions || [],
      historyRoute: result?.historyRoute || null,
      durationMs: result?.durationMs,
    });
    try {
      await window.genBatchListModal?.syncMcpHistory?.();
    } catch (error) {
      console.warn(
        "[McpExecutor] MCP Batch List sync:",
        error?.message || error,
      );
    }
    return {
      thumbnails: thumbs,
      batch: this._buildBatch(
        promptList.length,
        result?.failedPrompts,
        result?.completed,
        { flow: true },
      ),
    };
  }
  static async _executeChatGPTGen(args) {
    const { prompt, prompts, ratio, model, refs } = args;
    const promptList = this._resolvePromptList(args);
    if (!promptList.length)
      throw this._err("GEN_FAILED", "Thi\u1EBFu prompt/prompts.");
    if (!window.ChatGPTSession)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "Ch\u01B0a m\u1EDF tab ChatGPT.",
      );
    const ready = await window.ChatGPTSession.ensureReady({
      createIfMissing: true,
      activate: true,
      focusWindow: true,
      forceCheck: true,
    });
    if (!ready.ready) {
      throw ready.error === "NOT_LOGGED_IN"
        ? this._err(
            "PROVIDER_NOT_LOGGED_IN",
            "Vui l\xF2ng \u0111\u0103ng nh\u1EADp ChatGPT.",
          )
        : this._err(
            "PROVIDER_TAB_NOT_READY",
            `ChatGPT kh\xF4ng s\u1EB5n s\xE0ng: ${ready.error}`,
          );
    }
    if (!window.MessageBridge?.chatGPTSubmitAndWait)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "MessageBridge ChatGPT kh\xF4ng kh\u1EA3 d\u1EE5ng.",
      );
    const promptImages = await this._resolvePromptImages(
      args,
      promptList.length,
    );
    const settings = await window.storageSettings?.getSettings();
    const fallbackPrefix =
      settings?.chatgptFallbackPrefix || "Generate an image of: ";
    const mcpDownload = await this._getMcpDownloadSettings();
    let fileNameSettings = null;
    if (
      mcpDownload.autoDownload &&
      window.DownloadHelper?.getSettings &&
      window.DownloadHelper?.buildFilename
    ) {
      try {
        fileNameSettings = await window.DownloadHelper.getSettings();
      } catch (error) {
        console.warn(
          "[McpExecutor] ChatGPT filename settings unavailable:",
          error?.message || error,
        );
      }
    }
    const thumbs = [];
    const failedPrompts = [];
    let lastErr = null;
    let downloadIndex = 0;
    for (let idx = 0; idx < promptList.length; idx++) {
      const p = promptList[idx];
      if (this._cancelRequested) {
        failedPrompts.push({
          index: idx,
          prompt: p,
          error: "\u0110\xE3 hu\u1EF7",
        });
        continue;
      }
      try {
        const result = await window.MessageBridge.chatGPTSubmitAndWait({
          text: p,
          images: promptImages[idx],
          settings: {
            imageMode: true,
            ratio: this._mapRatioToChatGPT(ratio),
            model: model || null,
            fallbackPrefix,
          },
          timeout:
            window.SystemConfig?.getTimeout("chatgpt_timeout_ms") || 12e4,
          tabId: ready.tabId,
          taskName: "MCP ChatGPT",
        });
        if (!result?.success) {
          lastErr = result?.message || result?.error;
          failedPrompts.push({
            index: idx,
            prompt: p,
            error: lastErr,
            errorCode: this._mcpErrorCode(result),
          });
          continue;
        }
        const before = thumbs.length;
        for (const url of result.imageUrls || []) {
          const outputIndex = ++downloadIndex;
          thumbs.push({
            url,
            type: "image",
            file_name: `chatgpt_${url.slice(-12)}.png`,
            provider: "chatgpt",
          });
          if (
            mcpDownload.autoDownload &&
            fileNameSettings &&
            window.DownloadHelper?.downloadExternalMedia
          ) {
            try {
              const filename = window.DownloadHelper.buildFilename({
                template: fileNameSettings.template,
                project: fileNameSettings.project,
                prompt: p,
                index: outputIndex,
                taskName: this._mcpDownloadTaskName(
                  mcpDownload.downloadFolder,
                  args.batch_name,
                ),
                folder: fileNameSettings.folder,
                ext: "png",
              });
              let source = url;
              const fetched = await window.MessageBridge?.chatGPTFetchImage?.(
                url,
                result.tabId || ready.tabId,
              );
              if (fetched?.success && fetched.base64) {
                source = String(fetched.base64).startsWith("data:")
                  ? fetched.base64
                  : `data:${fetched.mime || "image/png"};base64,${fetched.base64}`;
              }
              const downloaded =
                await window.DownloadHelper.downloadExternalMedia({
                  url: source,
                  filename,
                  mediaType: "image",
                  waitForComplete: false,
                });
              if (!downloaded?.success)
                console.warn(
                  "[McpExecutor] ChatGPT auto-download failed:",
                  downloaded?.error || "DOWNLOAD_FAILED",
                );
            } catch (downloadError) {
              console.warn(
                "[McpExecutor] ChatGPT auto-download error:",
                downloadError?.message || downloadError,
              );
            }
          }
        }
        if (thumbs.length === before)
          failedPrompts.push({
            index: idx,
            prompt: p,
            error: "Kh\xF4ng c\xF3 \u1EA3nh tr\u1EA3 v\u1EC1",
          });
      } catch (e) {
        lastErr = e?.message;
        failedPrompts.push({
          index: idx,
          prompt: p,
          error: lastErr,
          errorCode: this._mcpErrorCode(e),
        });
      }
    }
    if (thumbs.length === 0)
      throw Object.assign(
        this._err(
          this._firstGenerationFailureCode(failedPrompts) || "GEN_FAILED",
          lastErr || "ChatGPT could not generate an image.",
        ),
        { batch: this._buildBatch(promptList.length, failedPrompts, 0) },
      );
    await this._saveGenHistory({
      promptList,
      mediaType: "image",
      model: this._historyModel("chatgpt", model),
      ratio,
      quantity: 1,
      refFileIds: [],
      thumbs,
      resultFileIds: [],
      provider: "chatgpt",
      failedPrompts,
      errorDetails: failedPrompts
        .filter((item) => this._mcpErrorCode(item.errorCode))
        .map((item) => ({
          promptIndex: item.index,
          code: item.errorCode,
          provider: "chatgpt",
        })),
    });
    return {
      thumbnails: thumbs,
      _tabId: ready.tabId,
      batch: this._buildBatch(promptList.length, failedPrompts),
    };
  }
  static async _executeGrokGen(args, isVideo) {
    const {
      prompt,
      prompts,
      ratio,
      refs,
      duration,
      resolution,
      model,
      video_input_type,
    } = args;
    const promptList = this._resolvePromptList(args);
    if (!promptList.length)
      throw this._err("GEN_FAILED", "Thi\u1EBFu prompt/prompts.");
    if (!window.GrokSession)
      throw this._err("PROVIDER_TAB_NOT_READY", "Ch\u01B0a m\u1EDF tab Grok.");
    const ready = await window.GrokSession.ensureReady({
      createIfMissing: true,
      activate: true,
      focusWindow: true,
      forceCheck: true,
    });
    if (!ready.ready) {
      throw ready.error === "NOT_LOGGED_IN"
        ? this._err(
            "PROVIDER_NOT_LOGGED_IN",
            "Vui l\xF2ng \u0111\u0103ng nh\u1EADp Grok.",
          )
        : this._err(
            "PROVIDER_TAB_NOT_READY",
            `Grok kh\xF4ng s\u1EB5n s\xE0ng: ${ready.error}`,
          );
    }
    if (!window.MessageBridge?.grokSubmitAndWait)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "MessageBridge Grok kh\xF4ng kh\u1EA3 d\u1EE5ng.",
      );
    const mode = isVideo ? "video" : "image";
    const adapter = window.ProviderRegistry?.get?.("grok");
    const selectedModel = adapter?.getModel?.(model, mode);
    if (!selectedModel)
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Grok model config is unavailable.",
      );
    const inputType = video_input_type || "Ingredients";
    const refMode = isVideo
      ? adapter
          .getVideoInputTypes(selectedModel.value)
          .find((option) => option.value === inputType)
      : null;
    if (isVideo && !refMode)
      throw this._err(
        "VALIDATION_ERROR",
        "Grok model does not support the selected video input type.",
      );
    const maxRefs = adapter.getMaxRefImages({
      mode,
      isFrames: inputType === "Frames",
      modelValue: selectedModel.value,
    });
    const promptImages = await this._resolvePromptImages(
      args,
      promptList.length,
      maxRefs,
    );
    try {
      await window.GrokSession.setMode(mode);
    } catch (_) {}
    const stored = await chrome.storage.local.get(["af_settings"]);
    const userSettings = stored?.af_settings || {};
    const grokDuration = duration || userSettings.grokDefaultDuration || null;
    const grokResolution =
      resolution || userSettings.grokDefaultResolution || null;
    const grokImageQuality =
      args.image_quality || userSettings.grokDefaultImageQuality || null;
    if (isVideo && (!grokDuration || !grokResolution)) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Grok video defaults are unavailable from server-backed user settings. Reload the extension and retry.",
      );
    }
    if (!isVideo && !grokImageQuality) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Grok image quality is unavailable from server-backed user settings. Reload the extension and retry.",
      );
    }
    const mcpDownload = await this._getMcpDownloadSettings();
    let fileNameSettings = null;
    if (mcpDownload.autoDownload) {
      if (
        !window.DownloadHelper?.getSettings ||
        !window.DownloadHelper?.buildFilename ||
        !window.MessageBridge?.grokDownloadMedia
      ) {
        console.warn(
          "[McpExecutor] Grok auto-download unavailable: shared download helpers missing",
        );
      } else {
        try {
          fileNameSettings = await window.DownloadHelper.getSettings();
        } catch (error) {
          console.warn(
            "[McpExecutor] Grok filename settings unavailable:",
            error?.message || error,
          );
        }
      }
    }
    const thumbs = [];
    const failedPrompts = [];
    let lastErr = null;
    let downloadIndex = 0;
    for (let idx = 0; idx < promptList.length; idx++) {
      const p = promptList[idx];
      if (this._cancelRequested) {
        failedPrompts.push({
          index: idx,
          prompt: p,
          error: "\u0110\xE3 hu\u1EF7",
        });
        continue;
      }
      try {
        const result = await window.MessageBridge.grokSubmitAndWait({
          text: p,
          images: promptImages[idx],
          settings: {
            mode,
            model: selectedModel.value,
            videoInputType: inputType,
            refRoleSelectors: refMode?.role_selectors || null,
            ratio: this._mapRatioToGrok(ratio),
            duration: isVideo ? grokDuration : null,
            resolution: isVideo ? grokResolution : null,
            imageQuality: isVideo ? null : grokImageQuality,
          },
          timeout: isVideo
            ? window.SystemConfig?.getTimeout("video_timeout_ms") || 6e5
            : window.SystemConfig?.getTimeout("image_timeout_ms") || 3e5,
          tabId: ready.tabId,
          taskName: "MCP Grok",
        });
        if (!result?.success) {
          lastErr = result?.message || result?.error;
          failedPrompts.push({
            index: idx,
            prompt: p,
            error: lastErr,
            errorCode: this._mcpErrorCode(result),
          });
          continue;
        }
        const mediaType = result.mediaType || (isVideo ? "video" : "image");
        const urls = result.mediaUrls || result.imageUrls || [];
        const before = thumbs.length;
        for (const url of urls) {
          const fetched = result.fetchedMedia?.find((f) => f.url === url);
          const outputIndex = ++downloadIndex;
          thumbs.push({
            url,
            type: mediaType,
            file_name: `grok_${url.slice(-12)}.${mediaType === "video" ? "mp4" : "png"}`,
            video_url: mediaType === "video" ? url : "",
            base64: fetched?.base64 || null,
            provider: "grok",
          });
          if (mcpDownload.autoDownload && fileNameSettings) {
            try {
              const ext = mediaType === "video" ? "mp4" : "png";
              const filename = window.DownloadHelper.buildFilename({
                template: fileNameSettings.template,
                project: fileNameSettings.project,
                prompt: p,
                index: outputIndex,
                taskName: this._mcpDownloadTaskName(
                  mcpDownload.downloadFolder,
                  args.batch_name,
                ),
                folder: fileNameSettings.folder,
                ext,
              });
              let downloaded;
              if (window.WatermarkClient?.enabled?.(mediaType) === true) {
                let source = fetched?.base64 || null;
                let sourceMime = fetched?.mime || null;
                if (!source) {
                  const fetchedForDownload =
                    await window.MessageBridge.grokFetchImage?.(
                      url,
                      result.tabId || ready.tabId,
                    );
                  if (fetchedForDownload?.success) {
                    source = fetchedForDownload.base64;
                    sourceMime = fetchedForDownload.mime || sourceMime;
                  }
                }
                sourceMime =
                  /^data:([^;,]+);base64,/.exec(source || "")?.[1] ||
                  sourceMime;
                downloaded = await window.DownloadHelper.downloadExternalMedia({
                  url,
                  base64: source,
                  mime: sourceMime,
                  filename,
                  mediaType,
                  waitForComplete: true,
                });
              } else {
                downloaded = await window.MessageBridge.grokDownloadMedia(
                  url,
                  result.tabId || ready.tabId,
                  filename,
                  fetched?.base64 || null,
                  { nativeFirst: urls.length === 1 },
                );
              }
              if (!downloaded?.success) {
                console.warn(
                  "[McpExecutor] Grok auto-download failed:",
                  downloaded?.error || "DOWNLOAD_FAILED",
                );
              }
            } catch (downloadError) {
              console.warn(
                "[McpExecutor] Grok auto-download error:",
                downloadError?.message || downloadError,
              );
            }
          }
        }
        if (thumbs.length === before)
          failedPrompts.push({
            index: idx,
            prompt: p,
            error: "Kh\xF4ng c\xF3 k\u1EBFt qu\u1EA3 tr\u1EA3 v\u1EC1",
          });
      } catch (e) {
        lastErr = e?.message;
        failedPrompts.push({
          index: idx,
          prompt: p,
          error: lastErr,
          errorCode: this._mcpErrorCode(e),
        });
      }
    }
    if (thumbs.length === 0)
      throw Object.assign(
        this._err(
          this._firstGenerationFailureCode(failedPrompts) || "GEN_FAILED",
          lastErr || "Grok could not generate a result.",
        ),
        { batch: this._buildBatch(promptList.length, failedPrompts, 0) },
      );
    await this._saveGenHistory({
      promptList,
      mediaType: isVideo ? "video" : "image",
      model: this._historyModel("grok", selectedModel.value, isVideo),
      ratio,
      quantity: 1,
      refFileIds: [],
      thumbs,
      resultFileIds: [],
      provider: "grok",
      failedPrompts,
    });
    return {
      thumbnails: thumbs,
      _tabId: ready.tabId,
      batch: this._buildBatch(promptList.length, failedPrompts),
    };
  }
  static async _executeGeminiGen(args, isVideo) {
    const { prompt, prompts, ratio, model, refs } = args;
    const promptList = this._resolvePromptList(args);
    if (!promptList.length)
      throw this._err("GEN_FAILED", "Thi\u1EBFu prompt/prompts.");
    const adapter = window.ProviderRegistry?.get?.("gemini");
    if (!adapter)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "Gemini adapter ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    if (
      args.ref_mode !== "none" &&
      (refs?.length || args.refs_per_prompt?.some((set) => set.length)) &&
      !window.featureGate?.canUseProviderRefImages?.("gemini")
    ) {
      throw this._err(
        "FEATURE_NOT_IN_PLAN",
        "Gemini reference images ch\u01B0a \u0111\u01B0\u1EE3c b\u1EADt cho plan hi\u1EC7n t\u1EA1i.",
      );
    }
    const promptImages = await this._resolvePromptImages(
      args,
      promptList.length,
    );
    const selectedModel =
      model ||
      window.ModelRegistry?.safeGetDefault?.(
        "gemini",
        isVideo ? "video" : "image",
      );
    if (!selectedModel)
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Gemini model config ch\u01B0a t\u1EA3i t\u1EEB server.",
      );
    const mcpDownload = await this._getMcpDownloadSettings();
    let fileNameSettings = null;
    if (
      mcpDownload.autoDownload &&
      window.DownloadHelper?.getSettings &&
      window.DownloadHelper?.buildFilename
    ) {
      try {
        fileNameSettings = await window.DownloadHelper.getSettings();
      } catch (error) {
        console.warn(
          "[McpExecutor] Gemini filename settings unavailable:",
          error?.message || error,
        );
      }
    }
    const thumbs = [];
    const failedPrompts = [];
    let lastErr = null;
    let lastErrorCode = "GEN_FAILED";
    for (let idx = 0; idx < promptList.length; idx++) {
      if (this._cancelRequested) {
        failedPrompts.push({
          index: idx,
          prompt: promptList[idx],
          error: "\u0110\xE3 hu\u1EF7",
        });
        continue;
      }
      try {
        const result = await adapter.submit({
          prompt: promptList[idx],
          mediaType: isVideo ? "video" : "image",
          model: selectedModel,
          ratio: isVideo ? null : ratio,
          refs: promptImages[idx],
          runId: `mcp-gemini-${Date.now()}-${idx}`,
          settings: { promptIndex: idx },
        });
        const promptDownloadBase = thumbs.length;
        for (const item of result.results || []) {
          let materializedBase64 =
            !isVideo && String(item.url || "").startsWith("data:")
              ? String(item.url).split(",")[1]
              : null;
          if (
            isVideo &&
            item.url &&
            result.tabId &&
            window.MessageBridge?.geminiFetchMedia
          ) {
            const monitor =
              window.ProviderConfigManager?.getApiConfigValueSync?.(
                "gemini",
                "generation_monitor",
              )?.video;
            if (Number.isFinite(Number(monitor?.max_materialized_bytes))) {
              const fetched = await window.MessageBridge.geminiFetchMedia(
                item.url,
                result.tabId,
                Number(monitor.max_materialized_bytes),
              );
              if (fetched?.success)
                materializedBase64 = String(fetched.base64 || "").replace(
                  /^data:[^,]+,/,
                  "",
                );
            }
          }
          thumbs.push({
            url: item.url,
            type: isVideo ? "video" : "image",
            provider: "gemini",
            file_name: `gemini_${Date.now()}_${thumbs.length + 1}.${isVideo ? "mp4" : "png"}`,
            video_url: isVideo ? item.url : "",
            base64: materializedBase64,
            fingerprint: item.fingerprint || null,
            tab_id: result.tabId || null,
          });
        }
        if (
          mcpDownload.autoDownload &&
          fileNameSettings &&
          window.GeminiMediaDownloadHelper?.downloadResults &&
          (result.results || []).length
        ) {
          const downloaded =
            await window.GeminiMediaDownloadHelper.downloadResults({
              items: result.results,
              tabId: result.tabId,
              mediaType: isVideo ? "video" : "image",
              waitForComplete: false,
              filenameFor: (_item, mediaIndex) =>
                window.DownloadHelper.buildFilename({
                  template: fileNameSettings.template,
                  project: fileNameSettings.project,
                  prompt: promptList[idx],
                  index: promptDownloadBase + mediaIndex + 1,
                  taskName: this._mcpDownloadTaskName(
                    mcpDownload.downloadFolder,
                    args.batch_name,
                  ),
                  folder: fileNameSettings.folder,
                  ext: isVideo ? "mp4" : "png",
                }),
              onLog: (message) =>
                console.warn("[McpExecutor] Gemini auto-download:", message),
            });
          if (!downloaded?.success)
            console.warn(
              "[McpExecutor] Gemini auto-download partial:",
              downloaded?.failures || [],
            );
        }
        if (!(result.results || []).length)
          failedPrompts.push({
            index: idx,
            prompt: promptList[idx],
            error: "Kh\xF4ng c\xF3 k\u1EBFt qu\u1EA3 tr\u1EA3 v\u1EC1",
          });
      } catch (e) {
        lastErr = e?.message;
        lastErrorCode =
          typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(e.code)
            ? e.code
            : "GEN_FAILED";
        failedPrompts.push({
          index: idx,
          prompt: promptList[idx],
          error: `[${lastErrorCode}] ${lastErr || "Gemini kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c k\u1EBFt qu\u1EA3."}`,
          errorCode: lastErrorCode,
        });
      }
    }
    if (!thumbs.length)
      throw Object.assign(
        this._err(
          lastErrorCode,
          lastErr ||
            "Gemini kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c k\u1EBFt qu\u1EA3.",
        ),
        { batch: this._buildBatch(promptList.length, failedPrompts, 0) },
      );
    await this._saveGenHistory({
      promptList,
      mediaType: isVideo ? "video" : "image",
      model: selectedModel,
      ratio: isVideo ? null : ratio,
      quantity: 1,
      refFileIds: [],
      thumbs,
      resultFileIds: [],
      provider: "gemini",
      failedPrompts,
    });
    return {
      thumbnails: thumbs,
      batch: this._buildBatch(promptList.length, failedPrompts),
    };
  }
  static async _prepareMuseApiDisplay(promptList, settings) {
    const store = window.ProviderWebQueueStore,
      userId = window.authManager?.getUser?.()?.id,
      jobId = this._currentJobId;
    if (!store?.museApiCheckpoint || !userId || !jobId)
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "MUSE_API_RESULT_STORE_UNAVAILABLE",
      );
    const mode = settings.museGenMode || "api";
    const runnerId = await this._runnerId(),
      id = `muse-${mode}-mcp:${jobId}`,
      ownerScope = `mcp:${jobId}`;
    let snapshot = await store.getRun(id);
    if (!snapshot) {
      try {
        await store.createRun({
          id,
          userId,
          provider: "muse",
          source: "mcp_direct",
          mcpJobId: jobId,
          runnerId,
          batchName: settings.batchName || null,
          settingsSnapshot: {
            ...settings,
            museGenMode: mode,
            museDirect: mode === "web",
          },
          prompts: promptList.map((text) => ({
            text,
            quantity: 1,
            refKeys: [],
          })),
        });
      } catch (error) {
        if (error?.message !== "PROVIDER_RUN_EXISTS") throw error;
      }
      snapshot = await store.getRun(id);
    }
    if (
      snapshot?.run?.userId !== String(userId) ||
      snapshot.run.runnerId !== runnerId ||
      snapshot.run.mcpJobId !== jobId ||
      snapshot.run.settingsSnapshot?.museGenMode !== mode ||
      String(window.authManager?.getUser?.()?.id) !== String(userId)
    )
      throw this._err(
        "PROVIDER_CONSUMER_OWNER_MISMATCH",
        "MUSE_API_RESULT_OWNER_CHANGED",
      );
    if (snapshot.run.status !== "SETTLED")
      await store.museApiCheckpoint(
        id,
        userId,
        null,
        { started: true },
        ownerScope,
      );
    window.eventBus?.emit?.("provider_web:changed", { runId: id });
    return { id, userId, ownerScope };
  }
  static async _recordMuseApiDisplay(display, index, result) {
    const write = this._museApiDisplayWrite
      .catch(() => {})
      .then(async () => {
        if (
          (result.genMode === "api" &&
            result?.apiHandle?.ownerScope !== `toby-user:${display.userId}`) ||
          String(window.authManager?.getUser?.()?.id) !== String(display.userId)
        )
          throw this._err(
            "PROVIDER_CONSUMER_OWNER_MISMATCH",
            "MUSE_API_RESULT_OWNER_CHANGED",
          );
        const store = window.ProviderWebQueueStore,
          receipts = [];
        for (const media of result.fetchedMedia || []) {
          const assetKey = `muse-${result.genMode || "web"}:${result.apiHandle?.commandId || display.id + ":" + index}:${media.resourceIndex}`;
          await store.putAsset({
            id: assetKey,
            userId: display.userId,
            ownerScope: display.ownerScope,
            runId: display.id,
            blob: media.blob,
            name: "",
            type: media.blob.type,
          });
          receipts.push({
            identity: assetKey,
            assetKey,
            index: media.resourceIndex,
            mediaType: result.mediaType,
          });
        }
        if (!receipts.length)
          throw this._err(
            "RESULT_MEDIA_UNAVAILABLE",
            "MUSE_LOCAL_ASSET_MISSING",
          );
        await store.museApiCheckpoint(
          display.id,
          display.userId,
          null,
          {
            promptIndex: index,
            state: "COMPLETED",
            commandId: result.apiHandle?.commandId || `${display.id}:${index}`,
            resultReceipts: receipts,
          },
          display.ownerScope,
        );
        if (
          String(window.authManager?.getUser?.()?.id) !== String(display.userId)
        )
          throw this._err(
            "PROVIDER_CONSUMER_OWNER_MISMATCH",
            "MUSE_API_RESULT_OWNER_CHANGED",
          );
        window.eventBus?.emit?.("provider_web:changed", { runId: display.id });
      });
    this._museApiDisplayWrite = write.catch(() => {});
    return write;
  }
  static async _executeMuseGen(args, isVideo) {
    const { prompt, prompts, ratio, model, refs, refs_per_prompt, reuse_refs } =
      args;
    const promptList = this._resolvePromptList(args);
    if (!promptList.length)
      throw this._err("GEN_FAILED", "Thi\u1EBFu prompt/prompts.");
    if (
      args.ref_mode !== "none" &&
      Array.isArray(reuse_refs) &&
      reuse_refs.length
    ) {
      throw this._err(
        "VALIDATION_ERROR",
        "Muse MCP ch\u01B0a h\u1ED7 tr\u1EE3 reuse_refs; h\xE3y g\u1EEDi \u1EA3nh qua refs ho\u1EB7c refs_per_prompt.",
      );
    }
    const mediaType = isVideo ? "video" : "image";
    const recovery = args._muse_api_handles;
    const registry = window.ModelRegistry;
    let selectedModel;
    if (recovery) {
      selectedModel =
        recovery.find((handle) => handle.requestedInput?.model)?.requestedInput
          .model ||
        model ||
        null;
    } else {
      if (!registry?.getModels || !registry?.findModel)
        throw this._err(
          "CONFIG_UNAVAILABLE",
          "Muse model registry ch\u01B0a s\u1EB5n s\xE0ng.",
        );
      let models;
      try {
        models = await registry.getModels("muse", mediaType);
      } catch (error) {
        throw this._err(
          "CONFIG_UNAVAILABLE",
          `Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c Muse model config t\u1EEB server: ${error?.message || "unknown error"}`,
        );
      }
      if (!Array.isArray(models) || !models.length)
        throw this._err(
          "CONFIG_UNAVAILABLE",
          `Muse ${mediaType} model config ch\u01B0a t\u1EA3i t\u1EEB server.`,
        );
      const selected = model
        ? registry.findModel("muse", model)
        : models.find((item) => item.is_default) || models[0];
      if (
        !selected?.value ||
        !models.some((item) => item.value === selected.value)
      ) {
        throw this._err(
          "VALIDATION_ERROR",
          `Muse model "${model}" kh\xF4ng h\u1ED7 tr\u1EE3 ${mediaType} ho\u1EB7c kh\xF4ng c\xF3 trong config server. D\xF9ng list_capabilities \u0111\u1EC3 ch\u1ECDn model h\u1EE3p l\u1EC7.`,
        );
      }
      selectedModel = selected.value;
    }
    const adapter = window.ProviderRegistry?.get?.("muse");
    if (!adapter || adapter.key !== "muse")
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "Muse adapter ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    const sharedRefs =
      args.ref_mode === "none" ? [] : Array.isArray(refs) ? refs : [];
    const perPromptRefs =
      args.ref_mode === "none"
        ? []
        : Array.isArray(refs_per_prompt)
          ? refs_per_prompt
          : [];
    const hasRefs =
      sharedRefs.length > 0 ||
      perPromptRefs.some(
        (refSet) => Array.isArray(refSet) && refSet.length > 0,
      );
    const maxRefs =
      adapter.getMaxRefImages?.({
        mode: mediaType,
        modelValue: selectedModel,
      }) ?? 0;
    if (hasRefs && !window.featureGate?.canUseProviderRefImages?.("muse")) {
      throw this._err(
        "FEATURE_NOT_IN_PLAN",
        "Muse reference images ch\u01B0a \u0111\u01B0\u1EE3c b\u1EADt cho plan hi\u1EC7n t\u1EA1i.",
      );
    }
    if (hasRefs && maxRefs <= 0) {
      throw this._err(
        "VALIDATION_ERROR",
        `Muse ${mediaType} kh\xF4ng h\u1ED7 tr\u1EE3 \u1EA3nh tham chi\u1EBFu theo c\u1EA5u h\xECnh hi\u1EC7n t\u1EA1i.`,
      );
    }
    const resolvedSharedRefs = await this._resolveRefsToImages(
      sharedRefs,
      maxRefs,
    );
    const resolvedPerPromptRefs = [];
    for (const refSet of perPromptRefs) {
      resolvedPerPromptRefs.push(
        await this._resolveRefsToImages(refSet, maxRefs),
      );
    }
    const historyByInput = new Map(),
      historyByRef = new Map(),
      usedHistoryRefs = new Map();
    const registerHistoryRefs = (resolved, inputs) =>
      resolved.forEach((ref, index) => {
        const input = inputs[index];
        if (!historyByInput.has(input))
          historyByInput.set(input, {
            id: `mcp_ref_${historyByInput.size + 1}`,
            thumbnail:
              typeof input === "string" &&
              input.length <= 4096 &&
              /^https:\/\//i.test(input)
                ? input
                : null,
          });
        historyByRef.set(ref, historyByInput.get(input));
      });
    registerHistoryRefs(resolvedSharedRefs, sharedRefs);
    resolvedPerPromptRefs.forEach((refs2, index) =>
      registerHistoryRefs(refs2, perPromptRefs[index]),
    );
    const historyRefs = () => ({
      refFileIds: [...usedHistoryRefs.keys()],
      refThumbnails: Object.fromEntries(
        [...usedHistoryRefs]
          .filter(([, ref]) => ref.thumbnail)
          .slice(0, 100)
          .map(([id, ref]) => [id, ref.thumbnail]),
      ),
    });
    const userSettings = await chrome.storage.local.get(["af_settings"]);
    const deleteAfterGen =
      !args._muse_api_handles &&
      userSettings.af_settings?.museDeleteAfterGen === true &&
      adapter.capabilities?.supportsDeleteAfterGen === true;
    let selectedRatio =
      recovery?.find((handle) => handle.requestedInput?.ratio)?.requestedInput
        .ratio ||
      ratio ||
      null;
    if (!selectedRatio && !recovery) {
      const configuredRatios = await window.ProviderConfigManager?.getRatios?.(
        "muse",
        mediaType,
      );
      selectedRatio =
        configuredRatios?.find((item) => item?.is_default === true)?.value ||
        configuredRatios?.[0]?.value ||
        configuredRatios?.[0] ||
        null;
    }
    if (!selectedRatio && !recovery)
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `Muse ${mediaType} ratio config ch\u01B0a t\u1EA3i t\u1EEB server.`,
      );
    const mcpDownload = args._muse_api_handles
      ? { autoDownload: false }
      : await this._getMcpDownloadSettings();
    let fileNameSettings = null;
    if (
      mcpDownload.autoDownload &&
      window.DownloadHelper?.getSettings &&
      window.DownloadHelper?.buildFilename
    ) {
      try {
        fileNameSettings = await window.DownloadHelper.getSettings();
      } catch (error) {
        console.warn(
          "[McpExecutor] Muse filename settings unavailable:",
          error?.message || error,
        );
      }
    }
    const chain = args.chain
      ? { enabled: true, kind: "video_last_frame", refPolicy: args.chain }
      : null;
    if (chain && !recovery)
      window.MuseVideoContinuity.validate(
        {
          chain,
          mediaType,
          museGenMode: args.muse_gen_mode,
          model: selectedModel,
        },
        promptList.map((_, index) => ({
          quantity: Number(args.count ?? 1),
          refs: resolvedPerPromptRefs[index] || resolvedSharedRefs,
        })),
      );
    const display =
      args.muse_gen_mode === "api" || isVideo
        ? await this._prepareMuseApiDisplay(promptList, {
            mediaType,
            museGenMode: args.muse_gen_mode || "web",
            chain,
            model: selectedModel,
            ratio: selectedRatio,
            deleteAfterGen,
            autoDownload: mcpDownload.autoDownload === true,
            batchName: args.batch_name || null,
          })
        : null;
    const thumbs = [];
    const failedPrompts = [];
    const errorDetails = [];
    let lastErr = null,
      museBridgeVersion = null;
    const submitMuseMcpPrompt = async (idx) => {
      const currentPrompt = promptList[idx];
      if (this._cancelRequested) {
        failedPrompts.push({
          index: idx,
          prompt: currentPrompt,
          error: "\u0110\xE3 hu\u1EF7",
        });
        return;
      }
      let result;
      try {
        if (display) {
          const snapshot = await window.ProviderWebQueueStore.getRun(
            display.id,
          );
          if (
            snapshot?.items?.find((item) => item.promptIndex === idx)?.state ===
            "QUEUED"
          )
            await window.ProviderWebQueueStore.museApiCheckpoint(
              display.id,
              display.userId,
              null,
              { promptIndex: idx, state: "MONITORING" },
              display.ownerScope,
            );
        }
        let promptRefs = resolvedPerPromptRefs.length
          ? resolvedPerPromptRefs[idx]
          : resolvedSharedRefs;
        if (chain && display && !args._muse_api_handles) {
          const snapshot = await window.ProviderWebQueueStore.getRun(
            display.id,
          );
          promptRefs = await window.MuseVideoContinuity.refs(
            snapshot.run,
            snapshot.items.find((item) => item.promptIndex === idx),
            promptRefs,
            () => this._cancelRequested === true,
          );
        }
        for (const ref of promptRefs || []) {
          const history = historyByRef.get(ref);
          if (history) usedHistoryRefs.set(history.id, history);
        }
        if (
          display &&
          String(window.authManager?.getUser?.()?.id) !== String(display.userId)
        )
          throw this._err(
            "PROVIDER_CONSUMER_OWNER_MISMATCH",
            "MUSE_API_RESULT_OWNER_CHANGED",
          );
        const retained = args._muse_api_handles?.filter(
          (handle) =>
            handle.sourceId === `${this._currentJobId}:${idx}` ||
            (promptList.length === 1 && handle.sourceId === this._currentJobId),
        );
        if (args._muse_api_handles && retained?.length !== 1)
          throw this._err(
            "MUSE_RECOVERY_NOT_SUBMITTED",
            "This prompt has no unique retained command; no new request was sent.",
          );
        result = args._muse_api_handles
          ? await window.MuseApiFacade.recover(retained[0], {
              shouldStop: () => this._cancelRequested === true,
            })
          : await adapter.submit({
              prompt: currentPrompt,
              refs: promptRefs,
              settings: {
                mode: mediaType,
                ratio: selectedRatio,
                museGenMode: args.muse_gen_mode || "web",
                museModeResolved: true,
                museRequestedMode:
                  args._muse_requested_mode || args.muse_gen_mode || "web",
                source: "mcp",
                sourceId: `${this._currentJobId}:${idx}`,
                model: selectedModel,
                deleteAfterGen,
                executionToken: this._currentExecutionToken,
              },
              shouldStop: () => this._cancelRequested === true,
              taskName: "MCP Muse",
            });
        if (!result?.success) {
          errorDetails.push(
            ...(result?.errorDetails || []).map((detail) => ({
              ...detail,
              promptIndex: idx,
            })),
          );
          lastErr =
            result?.message || result?.error || "Muse did not return a result";
          failedPrompts.push({
            index: idx,
            prompt: currentPrompt,
            error: lastErr,
            errorCode: result?.confirmationPending
              ? "MUSE_CONFIRMATION_REVIEW_REQUIRED"
              : this._mcpErrorCode(result),
            ...(result?.confirmationPending
              ? { confirmationPending: true, noRetry: true }
              : {}),
          });
          return;
        }
        museBridgeVersion = result.apiHandle?.bridgeVersion || null;
        const resultMediaType = result.mediaType || mediaType;
        if (resultMediaType !== mediaType) {
          lastErr = `Muse returned ${resultMediaType} for requested ${mediaType}.`;
          failedPrompts.push({
            index: idx,
            prompt: currentPrompt,
            error: lastErr,
          });
          return;
        }
        if (display && resultMediaType === "video")
          result = await window.MuseVideoContinuity.materialize(
            result,
            () => this._cancelRequested === true,
          );
        if (display) await this._recordMuseApiDisplay(display, idx, result);
        const urls = result.mediaUrls || [];
        const before = thumbs.length;
        let downloadsOk = mcpDownload.autoDownload && !!fileNameSettings;
        let deliveryReady = true;
        for (const url of urls) {
          const fetched = result.fetchedMedia?.find((item) => item.url === url);
          const outputIndex = thumbs.length + 1;
          const thumb = {
            url: result.genMode === "api" ? "" : url,
            type: resultMediaType,
            provider: "muse",
            tab_id: result.tabId,
            file_name:
              result.genMode === "api"
                ? `muse_${result.apiHandle?.commandId || this._currentJobId}_${fetched?.resourceIndex ?? idx}.${{ "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg", "video/mp4": "mp4" }[fetched?.blob?.type] || (resultMediaType === "video" ? "mp4" : "png")}`
                : `muse_${Date.now()}_${thumbs.length + 1}.${resultMediaType === "video" ? "mp4" : "png"}`,
            video_url:
              result.genMode === "api"
                ? ""
                : resultMediaType === "video"
                  ? url
                  : "",
            base64: fetched?.base64
              ? String(fetched.base64).replace(/^data:[^,]+,/, "")
              : null,
            ...(result.genMode === "api" || fetched?.blob instanceof Blob
              ? { _savedBlob: fetched?.blob, require_durable: true }
              : {}),
          };
          if (
            resultMediaType === "video" &&
            result.genMode !== "api" &&
            !(fetched?.blob instanceof Blob) &&
            /^blob:/i.test(String(url))
          ) {
            try {
              thumb._savedBlob = await this._readMuseVideoBlob(
                result.tabId,
                url,
              );
              thumb.require_durable = true;
              thumb._mcpConverted = (await this._convertForMcp([thumb]))[0];
              thumb._savedBlob = null;
            } catch (error) {
              thumb._deliveryError = error;
              deliveryReady = false;
            }
          }
          thumbs.push(thumb);
          if (fileNameSettings) {
            try {
              const filename = window.DownloadHelper.buildFilename({
                template: fileNameSettings.template,
                project: fileNameSettings.project,
                prompt: currentPrompt,
                index: outputIndex,
                taskName: this._mcpDownloadTaskName(
                  mcpDownload.downloadFolder,
                  args.batch_name,
                ),
                folder: fileNameSettings.folder,
                ext: resultMediaType === "video" ? "mp4" : "jpg",
              });
              const downloaded =
                result.genMode === "api"
                  ? await window.MuseApiFacade.download(
                      result,
                      url,
                      filename,
                      deleteAfterGen,
                    )
                  : resultMediaType === "video"
                    ? await window.MessageBridge?.museDownloadNative?.(
                        result.tabId,
                        filename,
                        url,
                        deleteAfterGen ? 6e5 : 12e4,
                      )
                    : await window.MessageBridge?.museDownloadImageResult?.({
                        tabId: result.tabId,
                        url,
                        base64: fetched?.base64 || null,
                        filename,
                        waitForComplete: deleteAfterGen,
                      });
              if (!downloaded?.success) {
                downloadsOk = false;
                console.warn(
                  "[McpExecutor] Muse auto-download failed:",
                  downloaded?.error,
                );
              }
            } catch (error) {
              downloadsOk = false;
              console.warn(
                "[McpExecutor] Muse auto-download error:",
                error?.message || error,
              );
            }
          }
        }
        if (
          deleteAfterGen &&
          deliveryReady &&
          (mcpDownload.autoDownload ? downloadsOk : result.genMode === "api") &&
          thumbs.length > before &&
          !this._cancelRequested
        ) {
          const deleted =
            result.genMode === "api"
              ? await window.MuseApiFacade.cleanup(result)
              : await window.MuseSession?.deleteCurrentConversation?.();
          if (!deleted?.success)
            console.warn(
              "[McpExecutor] Muse cleanup failed:",
              deleted?.error || "unknown",
            );
        }
        if (thumbs.length === before)
          failedPrompts.push({
            index: idx,
            prompt: currentPrompt,
            error: "Kh\xF4ng c\xF3 k\u1EBFt qu\u1EA3 tr\u1EA3 v\u1EC1",
          });
      } catch (error) {
        errorDetails.push(
          ...(error?.errorDetails || []).map((detail) => ({
            ...detail,
            promptIndex: idx,
          })),
        );
        lastErr = error?.message || String(error);
        failedPrompts.push({
          index: idx,
          prompt: currentPrompt,
          error: lastErr,
          errorCode: this._mcpErrorCode(error),
        });
      } finally {
        if (result?.genMode === "api")
          result.mediaUrls?.forEach((url) => URL.revokeObjectURL(url));
      }
    };
    if (args.muse_gen_mode === "api" && !chain)
      await window.MuseApiFacade.runBatch(
        promptList.length,
        submitMuseMcpPrompt,
        {
          mode: mediaType,
          shouldStop: () => !!(this._cancelRequested === true),
        },
      );
    else
      for (
        let idx = 0;
        idx < promptList.length && !this._cancelRequested;
        idx++
      ) {
        if (chain && failedPrompts.length) {
          for (let skipped = idx; skipped < promptList.length; skipped++)
            failedPrompts.push({
              index: skipped,
              prompt: promptList[skipped],
              error: "MUSE_CHAIN_PREVIOUS_NOT_READY",
            });
          break;
        }
        await submitMuseMcpPrompt(idx);
      }
    if (display) {
      const store = window.ProviderWebQueueStore;
      if (
        String(window.authManager?.getUser?.()?.id) !== String(display.userId)
      )
        throw this._err(
          "PROVIDER_CONSUMER_OWNER_MISMATCH",
          "MUSE_API_RESULT_OWNER_CHANGED",
        );
      const snapshot = await store.getRun(display.id);
      if (this._cancelRequested) {
        for (const item of snapshot?.items || [])
          if (item.state === "QUEUED")
            await store.museApiCheckpoint(
              display.id,
              display.userId,
              null,
              {
                promptIndex: item.promptIndex,
                state: "CANCELLED",
                error: "USER_CANCELLED",
              },
              display.ownerScope,
            );
      }
      for (const failure of failedPrompts) {
        const item = snapshot?.items?.find(
          (item2) => item2.promptIndex === failure.index,
        );
        if (item?.state === "COMPLETED" && item.resultReceipts?.length)
          continue;
        await store.museApiCheckpoint(
          display.id,
          display.userId,
          null,
          {
            promptIndex: failure.index,
            state: "NEEDS_REVIEW",
            error: failure.errorCode || "MUSE_RESULT_UNVERIFIED",
          },
          display.ownerScope,
        );
      }
      await store.museApiCheckpoint(
        display.id,
        display.userId,
        null,
        { settled: true },
        display.ownerScope,
      );
      window.eventBus?.emit?.("provider_web:changed", { runId: display.id });
    }
    if (
      display &&
      String(window.authManager?.getUser?.()?.id) !== String(display.userId)
    )
      throw this._err(
        "PROVIDER_CONSUMER_OWNER_MISMATCH",
        "MUSE_API_RESULT_OWNER_CHANGED",
      );
    if (!thumbs.length)
      throw Object.assign(
        this._err(
          failedPrompts.some((item) => item.confirmationPending)
            ? "MUSE_CONFIRMATION_REVIEW_REQUIRED"
            : this._firstGenerationFailureCode(failedPrompts) || "GEN_FAILED",
          lastErr ||
            "Muse kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c k\u1EBFt qu\u1EA3.",
        ),
        historyRefs(),
        {
          confirmationPending: failedPrompts.some(
            (item) => item.confirmationPending,
          ),
          errorDetails: errorDetails.slice(0, 100),
          batch: this._buildBatch(promptList.length, failedPrompts, 0),
        },
      );
    await this._saveGenHistory({
      promptList,
      mediaType,
      model: selectedModel,
      ratio: selectedRatio,
      quantity: 1,
      ...historyRefs(),
      thumbs,
      resultFileIds: [],
      provider: "muse",
      failedPrompts,
      errorDetails: errorDetails.slice(0, 100),
      historyRoute: {
        genMode: args.muse_gen_mode === "api" ? "api" : "web",
        initialGenMode:
          args._muse_requested_mode || args.muse_gen_mode || "web",
        fallbackReason:
          args._muse_requested_mode === "api" && args.muse_gen_mode === "web"
            ? "muse_api_permission_disabled"
            : null,
        bridgeVersion: museBridgeVersion,
      },
    });
    return {
      thumbnails: thumbs,
      batch: this._buildBatch(promptList.length, failedPrompts),
    };
  }
  static async _executeExtractLastFrame(args) {
    if (args.provider && args.provider !== "flow")
      throw this._err(
        "VALIDATION_ERROR",
        "Last-frame extraction currently supports Flow references.",
      );
    if (!window.VideoFrameExtractor?.extractLastFrame)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "Video frame extractor is unavailable.",
      );
    const context = await this._ensureFlowProjectContext({
      purpose: "extract_last_frame",
    });
    const readinessError = this._flowProjectReadinessError(context);
    if (readinessError)
      throw this._err("PROVIDER_TAB_NOT_READY", readinessError);
    const checkCancelled = () => {
      if (this._cancelRequested)
        throw this._err("CANCELLED", "Last-frame extraction cancelled.");
    };
    checkCancelled();
    let url = args.video_url || null;
    if (args.tile_id) {
      const playback = await window.MessageBridge?.resolveVideoPlaybackUrl?.(
        args.tile_id,
        {
          fileName: args.file_name || "",
          sourceUrl: url || "",
          forceDomResolve: false,
        },
      );
      if (!playback?.success || !playback.video_url)
        throw this._err(
          "RESULT_MEDIA_UNAVAILABLE",
          "Could not resolve the selected Flow video.",
        );
      url = playback.video_url;
    }
    if (!url)
      throw this._err(
        "VALIDATION_ERROR",
        "Provide the Flow video tile_id or a playable video_url.",
      );
    checkCancelled();
    let stage = "extract";
    const updateStatus = (stage2) =>
      this._updateActivity(
        this._currentJobId,
        "extract_last_frame",
        "running",
        window.VideoFrameExtractor.statusText?.(stage2) || stage2,
      );
    updateStatus("extracting");
    try {
      const frame = await window.VideoFrameExtractor.extractLastFrame(url, {
        provider: "flow",
        shouldStop: () => this._cancelRequested,
        onRetry: () => updateStatus("retrying"),
      });
      if (!frame?.base64)
        throw this._err(
          "RESULT_MEDIA_UNAVAILABLE",
          "Video decoder returned no last frame.",
        );
      checkCancelled();
      stage = "upload";
      updateStatus("uploading");
      const result = await this._executeUploadRef({ image: frame.base64 });
      checkCancelled();
      updateStatus("ready");
      return result;
    } catch (error) {
      if (!this._cancelRequested)
        this._lastFrameActivityDetail =
          window.VideoFrameExtractor.failureStatus?.(error, stage) ||
          "Could not prepare the last frame.";
      throw error;
    }
  }
  static async _executeUploadRef(args) {
    const up = await this._uploadRefToFlow(args.image);
    if (!up?.tileId)
      throw this._err(
        "UPLOAD_FAILED",
        "Upload \u1EA3nh tham chi\u1EBFu th\u1EA5t b\u1EA1i.",
      );
    const upload = { file_id: up.tileId };
    if (up.fileName) upload.file_name = up.fileName;
    if (up.thumbnailUrl && /^https?:\/\//i.test(up.thumbnailUrl))
      upload.thumbnail_url = up.thumbnailUrl;
    return { upload };
  }
  static _inlineImageParts(ref, declaredMime = null, index = 0) {
    let base64 = String(ref || "").trim();
    let mime = String(declaredMime || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const data = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(base64);
    if (data) {
      mime = String(data[1] || "").toLowerCase();
      base64 = data[2];
    } else if (/^data:/i.test(base64)) {
      throw this._err(
        "VALIDATION_ERROR",
        "Reference data URL must contain base64 image bytes.",
      );
    }
    const allowed = new Set([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
    ]);
    if (mime && !allowed.has(mime)) {
      throw this._err(
        "VALIDATION_ERROR",
        `Reference content type is not a supported image: ${mime}`,
      );
    }
    base64 = base64.replace(/\s+/g, "");
    if (!base64)
      throw this._err("VALIDATION_ERROR", "Reference image bytes are empty.");
    if (!mime) {
      if (base64.startsWith("iVBORw0KGgo")) mime = "image/png";
      else if (base64.startsWith("UklGR")) mime = "image/webp";
      else if (base64.startsWith("R0lGOD")) mime = "image/gif";
      else mime = "image/jpeg";
    }
    const ext =
      mime === "image/png"
        ? "png"
        : mime === "image/webp"
          ? "webp"
          : mime === "image/gif"
            ? "gif"
            : "jpg";
    return { base64, mime, name: `mcp_ref_${index}.${ext}` };
  }
  static async _uploadRefToFlow(ref) {
    if (!ref || typeof ref !== "string") return null;
    if (!window.MessageBridge?.uploadFilesToFlow)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "MessageBridge upload kh\xF4ng kh\u1EA3 d\u1EE5ng.",
      );
    if (window.ImmediateUploader?._ensureFlowTabReady) {
      try {
        const act = await window.ImmediateUploader._ensureFlowTabReady();
        if (!act?.isOpen)
          throw this._err(
            "PROVIDER_TAB_NOT_READY",
            "Ch\u01B0a m\u1EDF tab Google Flow.",
          );
      } catch (e) {
        if (e?.code) throw e;
      }
    }
    let parts = null;
    if (/^https?:\/\//i.test(ref)) {
      const resp = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "fetchBlob", url: ref, expectImage: true },
          (r) => {
            if (chrome.runtime.lastError)
              reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          },
        );
      });
      if (!resp?.success || !resp.base64) {
        throw this._err(
          "REF_FETCH_FAILED",
          `Could not download ref image from URL: ${ref} (${resp?.error || "unknown error"}). Use a public URL that opens directly (no login/cookie required).`,
        );
      }
      parts = this._inlineImageParts(resp.base64, resp.contentType, 0);
    } else {
      parts = this._inlineImageParts(ref, null, 0);
    }
    let { base64, mime, name } = parts;
    if (window.WatermarkClient) {
      try {
        const cl = await window.WatermarkClient.cleanBase64(
          base64,
          mime,
          "image",
          { scope: "input" },
        );
        if (cl?.cleaned && cl.base64) base64 = cl.base64;
      } catch (e) {
        console.warn("[MCP] b\u1ECF qua xo\xE1 watermark cho ref:", e?.message);
      }
    }
    const result = await window.MessageBridge.uploadFilesToFlow(
      [{ name, type: mime, base64 }],
      { surface: "mcp", manualUpload: true },
    );
    const tileId = result?.orderedTileIds?.[0] || result?.tileIds?.[0] || null;
    if (!tileId)
      throw this._err(
        "UPLOAD_FAILED",
        "Upload xong nh\u01B0ng kh\xF4ng nh\u1EADn \u0111\u01B0\u1EE3c tile.",
      );
    const detail =
      result?.tileDetails?.find(
        (entry) => (entry?.id || entry?.tileId) === tileId,
      ) || {};
    const fileName =
      detail.file_name ||
      detail.file_id ||
      window.MediaRegistry?.getFileName?.(tileId) ||
      window.GenTab?.fileNameCache?.[tileId] ||
      "";
    const thumbnailUrl =
      detail.thumbnailUrl ||
      detail.thumbnail_url ||
      window.MediaRegistry?.getThumb?.(tileId) ||
      "";
    return { tileId, fileName, thumbnailUrl };
  }
  static async _executeCreateProject(args) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const oldId = window._currentProjectId || null;
    if (typeof window._createNewProject === "function") {
      try {
        const result = await window._createNewProject();
        if (result?.ok === false)
          throw new Error(result.error || "CREATE_PROJECT_FAILED");
      } catch (e) {
        throw this._err(
          "PROVIDER_TAB_NOT_READY",
          `T\u1EA1o project th\u1EA5t b\u1EA1i: ${e?.message || e}`,
        );
      }
    } else {
      let targetTabId = null;
      try {
        const flowHome = window.ProviderConfigManager?.getCreateUrl?.("flow");
        const navigation = await new Promise((r) =>
          chrome.runtime.sendMessage(
            { action: "navigateToProject", url: flowHome },
            r,
          ),
        );
        if (!navigation?.success || !navigation.tabId)
          throw new Error(navigation?.error || "FLOW_TARGET_UNAVAILABLE");
        targetTabId = navigation.tabId;
        await sleep(1800);
      } catch (error) {
        throw this._err("PROVIDER_TAB_NOT_READY", error.message);
      }
      const resp = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            { action: "clickCreateNewProject", targetTabId },
            (r) => resolve(r),
          );
        } catch (e) {
          resolve({ success: false, error: e?.message });
        }
      });
      if (!resp?.success) {
        throw this._err(
          "PROVIDER_TAB_NOT_READY",
          resp?.error ||
            resp?.result?.error ||
            "Could not create project (the Create project button was not found on Flow).",
        );
      }
    }
    let newId = null;
    for (let i = 0; i < 30; i++) {
      await sleep(1e3);
      const cur = window._currentProjectId;
      if (cur && cur !== oldId) {
        newId = cur;
        break;
      }
    }
    if (!newId) {
      throw this._err(
        "PROJECT_CREATION_UNCONFIRMED",
        "\u0110\xE3 g\u1EEDi thao t\xE1c t\u1EA1o project nh\u01B0ng ch\u01B0a x\xE1c nh\u1EADn \u0111\u01B0\u1EE3c project m\u1EDBi. Ki\u1EC3m tra tab Flow/get_context tr\u01B0\u1EDBc khi t\u1EA1o l\u1EA1i \u0111\u1EC3 tr\xE1nh t\u1EA1o tr\xF9ng.",
      );
    }
    return {
      project: {
        project_id: newId,
        project_name: window._currentProjectName || null,
      },
    };
  }
  static async _executeOpenProject(args) {
    const projectId = args?.project_id;
    if (!projectId) throw this._err("GEN_FAILED", "Thi\u1EBFu project_id");
    const helper = window.ProjectHelper;
    if (!helper?.navigateToProject || !helper?.waitForProjectReady) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Flow project navigation ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    }
    if (this._cancelRequested)
      throw this._err("CANCELLED", "Flow preparation cancelled.");
    console.info(
      "[McpFlowReady]",
      JSON.stringify({
        jobId: this._currentJobId,
        purpose: "open_project",
        stage: "navigate",
      }),
    );
    const opened = await helper.navigateToProject(projectId);
    if (this._cancelRequested)
      throw this._err("CANCELLED", "Flow preparation cancelled.");
    if (opened?.success !== true || !Number.isInteger(opened.tabId)) {
      console.warn(
        "[McpFlowReady]",
        JSON.stringify({
          jobId: this._currentJobId,
          purpose: "open_project",
          stage: "navigation_failed",
          code: opened?.error || null,
        }),
      );
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "Kh\xF4ng m\u1EDF \u0111\u01B0\u1EE3c Flow project \u0111\xE3 ch\u1ECDn. Ki\u1EC3m tra quy\u1EC1n truy c\u1EADp tr\xEAn tab Flow r\u1ED3i th\u1EED l\u1EA1i.",
      );
    }
    const deadline = Date.now() + this._flowProjectTimeoutMs();
    const context = await this._ensureFlowProjectContext({
      projectId,
      tabId: opened.tabId,
      allowNavigation: true,
      forcePrepare: true,
      purpose: "open_project",
    });
    const readinessError = this._flowProjectReadinessError(context);
    if (readinessError)
      throw this._err("PROVIDER_TAB_NOT_READY", readinessError);
    const ready =
      Date.now() < deadline &&
      (await helper.waitForProjectReady(projectId, {
        tabId: opened.tabId,
        timeoutMs: Math.max(1, deadline - Date.now()),
        shouldContinue: () => !this._cancelRequested,
      }));
    if (this._cancelRequested)
      throw this._err("CANCELLED", "Flow preparation cancelled.");
    if (!ready)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        "\u0110\xE3 m\u1EDF Flow project nh\u01B0ng tab ch\u01B0a t\u1EA3i xong ho\u1EB7c ch\u01B0a s\u1EB5n s\xE0ng. Kh\xF4ng c\u1EA7n t\u1EA1o project m\u1EDBi.",
      );
    const verified = await this._readFlowProjectContext({
      tabId: opened.tabId,
      timeoutMs: Math.max(1, deadline - Date.now()),
    });
    if (this._cancelRequested)
      throw this._err("CANCELLED", "Flow preparation cancelled.");
    if (
      verified.tabId !== opened.tabId ||
      String(verified.projectId || "").toLowerCase() !==
        String(projectId).toLowerCase()
    ) {
      throw this._err(
        "PROJECT_MISMATCH",
        "Flow project \u0111\xE3 \u0111\u1ED5i trong l\xFAc x\xE1c nh\u1EADn m\u1EDF project.",
      );
    }
    const error = this._flowProjectReadinessError(verified);
    if (error) throw this._err("PROVIDER_TAB_NOT_READY", error);
    let name = verified.projectName || null;
    if (!name) {
      try {
        name = await helper.getProjectName?.(projectId);
      } catch (_) {}
    }
    console.info(
      "[McpFlowReady]",
      JSON.stringify({
        jobId: this._currentJobId,
        purpose: "open_project",
        stage: "ready",
        tabId: opened.tabId,
      }),
    );
    return { project: { project_id: projectId, project_name: name || null } };
  }
  static async _executeGetContext() {
    const ctx = await this._readFlowProjectContext();
    return {
      project: {
        project_id: ctx.projectId || null,
        project_name: ctx.projectId
          ? ctx.projectName ||
            (ctx.projectId === window._currentProjectId
              ? window._currentProjectName
              : null) ||
            null
          : null,
      },
    };
  }
  static _savedResultScope(allowNoProject = false) {
    const userId = window.authManager?.getUser?.()?.id;
    const projectId = window._currentProjectId;
    if (!userId || (!projectId && !allowNoProject))
      throw this._err(
        "PROJECT_NOT_READY",
        "M\u1EDF Flow project trong TobyFlow tr\u01B0\u1EDBc khi \u0111\u1ECDc Batch List.",
      );
    return { userId, projectId };
  }
  static _assertSavedResultScope(scope) {
    const current = this._savedResultScope(!scope.projectId);
    if (
      String(current.userId) !== String(scope.userId) ||
      current.projectId !== scope.projectId
    )
      throw this._err(
        "PROJECT_MISMATCH",
        "T\xE0i kho\u1EA3n ho\u1EB7c Flow project \u0111\xE3 \u0111\u1ED5i trong l\xFAc x\u1EED l\xFD d\u1EEF li\u1EC7u local.",
      );
  }
  static _flowSavedResults(batch, promptIndex) {
    const receipt = batch?.terminalItems?.[promptIndex];
    return receipt?.results?.length
      ? receipt.results
      : receipt?.resultIdentity?.length
        ? receipt.resultIdentity
        : (receipt?.resultIds || []).map((tileId) => ({
            tileId,
            video:
              String(batch.settingsSnapshot?.genType || "").toLowerCase() ===
              "video",
          }));
  }
  static async _savedWebRuns(scope, provider) {
    if (!window.ProviderWebQueueStore?.listRuns)
      throw this._err(
        "SAVED_RESULTS_UNAVAILABLE",
        "Kho k\u1EBFt qu\u1EA3 Web ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    const scoped = scope.projectId
      ? await window.ProviderWebQueueStore.listRuns(
          scope.userId,
          scope.projectId,
        )
      : [];
    const owned = await window.ProviderWebQueueStore.listMcpRuns(scope.userId);
    const runnerId = await this._runnerId();
    return [
      ...new Map(
        [...scoped, ...owned]
          .filter(
            (run) =>
              run.provider === provider &&
              !run.hiddenFromBatchList &&
              (run.source !== "mcp_direct" || run.runnerId === runnerId),
          )
          .map((run) => [run.id, run]),
      ).values(),
    ];
  }
  static async _executeListSavedResults(args = {}) {
    const provider = args?.provider || "flow";
    if (!["flow", "chatgpt", "gemini", "muse"].includes(provider))
      throw this._err(
        "VALIDATION_ERROR",
        "Batch List ch\u01B0a h\u1ED7 tr\u1EE3 \u0111\u1ECDc k\u1EBFt qu\u1EA3 provider n\xE0y.",
      );
    const scope = this._savedResultScope(provider !== "flow");
    if (provider === "flow") await window.genBatchListModal?.syncMcpHistory?.();
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 50));
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw this._err("VALIDATION_ERROR", "Invalid result offset.");
    const pageEnd = offset + limit;
    const query = String(args?.query || "")
      .trim()
      .toLocaleLowerCase();
    const mediaType = args?.media_type || null;
    const batchId = String(args?.batch_id || "").trim();
    const expectedPromptCount =
      args?.expected_prompt_count == null
        ? null
        : Number(args.expected_prompt_count);
    if (
      expectedPromptCount !== null &&
      (!batchId ||
        !Number.isInteger(expectedPromptCount) ||
        expectedPromptCount < 1 ||
        expectedPromptCount > 100)
    )
      throw this._err(
        "VALIDATION_ERROR",
        "expected_prompt_count c\u1EA7n batch_id v\xE0 s\u1ED1 prompt h\u1EE3p l\u1EC7.",
      );
    const includeRefs = args?.include_refs === true;
    const results = [];
    let coverage = null;
    if (provider === "flow") {
      const batches = (
        await window.GenBatchQueueStore.list(scope.userId, scope.projectId)
      ).filter((batch) => !batchId || batch.batchId === batchId);
      for (const batch of batches.slice().reverse()) {
        const unknown = [
          ...(includeRefs ? batch.refPool || [] : []),
          ...(batch.items || []).flatMap((_, index) =>
            this._flowSavedResults(batch, index),
          ),
        ].filter((media) => !this._flowMediaUuid(media));
        const aliases = [
          ...new Set(
            unknown
              .flatMap((media) => [
                media.tileId,
                media.mediaId,
                media.fileName,
                media.refKey,
              ])
              .filter(Boolean),
          ),
        ];
        const catalog =
          aliases.length && window.MessageBridge?.lookupFlowMediaCatalog
            ? await window.MessageBridge.lookupFlowMediaCatalog(aliases).catch(
                () => null,
              )
            : null;
        if (includeRefs)
          (batch.refPool || []).forEach((raw, resultIndex) => {
            const ref = this._correctSavedFlowIdentity(
              raw,
              catalog,
              scope,
              raw.mediaType === "video" ? "video" : "image",
            );
            if (results.length > pageEnd && !query && !mediaType) return;
            results.push({
              source: "flow_ref",
              id: batch.batchId,
              prompt_index: 0,
              result_index: resultIndex,
              identity:
                this._flowMediaUuid(ref) || ref.fileName || ref.refKey || null,
              provider,
              kind: "ref",
              media_type: ref.mediaType === "video" ? "video" : "image",
              batch_name: batch.displayName || null,
              file_name: ref.fileName || ref.name || null,
              prompt: null,
              created_at: batch.createdAt || null,
            });
          });
        for (
          let promptIndex = 0;
          promptIndex < (batch.items || []).length;
          promptIndex++
        ) {
          if (batch.items[promptIndex]?.hidden) continue;
          this._flowSavedResults(batch, promptIndex).forEach(
            (raw, resultIndex) => {
              const result = this._correctSavedFlowIdentity(
                raw,
                catalog,
                scope,
                raw.video || batch.settingsSnapshot?.genType === "Video"
                  ? "video"
                  : "image",
              );
              if (results.length > pageEnd && !query && !mediaType) return;
              const fileId =
                result?.tileId ||
                result?.fileName ||
                result?.mediaUuid ||
                result?.mediaId;
              if (typeof fileId !== "string" || !fileId.trim()) return;
              results.push({
                source: "flow_batch",
                id: batch.batchId,
                prompt_index: promptIndex,
                kind: "result",
                result_index: resultIndex,
                identity:
                  this._flowMediaUuid(result) ||
                  result.fileName ||
                  result.tileId ||
                  result.mediaId,
                provider,
                media_type:
                  result.video || batch.settingsSnapshot?.genType === "Video"
                    ? "video"
                    : "image",
                batch_name: batch.displayName || null,
                file_name: result.fileName || null,
                prompt: String(
                  batch.items[promptIndex]?.text ||
                    batch.items[promptIndex]?.prompt ||
                    "",
                ).slice(0, 160),
                created_at: batch.createdAt || null,
              });
            },
          );
        }
        if (results.length > pageEnd && !query && !mediaType) break;
      }
    } else {
      if (includeRefs) {
        const batches = (
          scope.projectId
            ? await window.ProviderWebQueueStore.listBatches(
                scope.userId,
                scope.projectId,
              )
            : []
        ).filter(
          (batch) =>
            batch.provider === provider && (!batchId || batch.id === batchId),
        );
        for (const batch of batches) {
          const ids =
            batch.prompts?.flatMap((item) => item.refKeys || []) || [];
          const names = await window.ProviderWebQueueStore.getAssetNames(
            scope.userId,
            scope.projectId,
            ids,
          );
          (batch.prompts || []).forEach((item, promptIndex) =>
            (item.refKeys || []).forEach((key, resultIndex) => {
              if (
                !names[key] ||
                ![
                  "image/jpeg",
                  "image/png",
                  "image/webp",
                  "image/gif",
                ].includes(names[key].type) ||
                !names[key].size ||
                names[key].size > 1e7 ||
                (results.length > pageEnd && !query && !mediaType)
              )
                return;
              results.push({
                source: "web_batch_ref",
                id: batch.id,
                prompt_index: promptIndex,
                result_index: resultIndex,
                provider,
                identity: key,
                kind: "ref",
                media_type: "image",
                batch_name: batch.displayName || null,
                file_name: names[key].name || null,
                prompt: String(item.text || "").slice(0, 160),
                created_at: batch.createdAt || null,
              });
            }),
          );
          if (results.length > pageEnd && !query && !mediaType) break;
        }
      }
      const discovered = await this._savedWebRuns(scope, provider);
      let rootId = batchId,
        sourceBatch = null;
      if (batchId && scope.projectId) {
        sourceBatch = (
          await window.ProviderWebQueueStore.listBatches(
            scope.userId,
            scope.projectId,
          )
        ).find((batch) => batch.id === batchId && batch.provider === provider);
        if (sourceBatch) rootId = sourceBatch.runId || null;
      }
      if (batchId && !discovered.some((run) => run.id === rootId)) {
        const child = (await window.ProviderWebQueueStore.getRun(rootId))?.run;
        const parent =
          child?.mcpParentRunId &&
          discovered.find((run) => run.id === child.mcpParentRunId);
        if (
          parent?.source === "mcp_direct" &&
          child.provider === provider &&
          String(child.userId) === String(scope.userId) &&
          parent.manualRuns?.some((entry) => entry.runId === child.id) &&
          !child.hiddenFromBatchList
        )
          discovered.push(child);
      }
      const runs = discovered.filter((run) => !batchId || run.id === rootId);
      if (batchId && rootId && !runs.length && sourceBatch) {
        const root = (await window.ProviderWebQueueStore.getRun(rootId))?.run;
        if (
          root?.scope === sourceBatch.scope &&
          root.batchId === sourceBatch.id &&
          root.provider === provider &&
          !root.hiddenFromBatchList
        )
          runs.push(root);
      }
      for (const run of runs) {
        const snapshot = await window.ProviderWebQueueStore.getRun(run.id);
        if (snapshot?.run?.scope !== run.scope) continue;
        const verifiedPromptIndices = new Set();
        let verifiedResultCount = 0;
        for (const item of snapshot.items || []) {
          if (item.hidden) continue;
          const refKeys = item.displayRefKeys || item.refKeys || [];
          if (includeRefs && refKeys.length) {
            const names = await window.ProviderWebQueueStore.getAssetNames(
              scope.userId,
              run.projectId ?? null,
              refKeys,
              run.ownerScope || null,
            );
            refKeys.forEach((key, resultIndex) => {
              if (
                !names[key] ||
                ![
                  "image/jpeg",
                  "image/png",
                  "image/webp",
                  "image/gif",
                ].includes(names[key].type) ||
                !names[key].size ||
                names[key].size > 1e7 ||
                (results.length > pageEnd && !query && !mediaType)
              )
                return;
              results.push({
                source: "web_run_ref",
                id: run.id,
                prompt_index: item.promptIndex,
                result_index: resultIndex,
                provider,
                identity: key,
                kind: "ref",
                media_type: "image",
                batch_name: run.displayName || run.batchName || null,
                file_name: names[key].name || null,
                prompt: String(item.prompt || "").slice(0, 160),
                created_at: run.createdAt || null,
              });
            });
          }
          for (const [resultIndex, receipt] of (
            item.resultReceipts || []
          ).entries()) {
            if (!receipt?.identity || !receipt?.assetKey) continue;
            if (batchId) {
              const asset = await window.ProviderWebQueueStore.getAsset(
                scope.userId,
                run.projectId ?? null,
                receipt.assetKey,
                run.ownerScope || null,
              );
              const mime = asset?.blob?.type || "";
              const validVideo =
                receipt.mediaType === "video" && /^video\//i.test(mime);
              const validImage =
                receipt.mediaType !== "video" &&
                asset?.blob?.size <= 1e7 &&
                ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
                  mime,
                );
              if (
                asset?.runId !== run.id ||
                !asset.blob?.size ||
                !(validVideo || validImage) ||
                (mediaType && (validVideo ? "video" : "image") !== mediaType)
              )
                continue;
              if (item.state === "COMPLETED")
                verifiedPromptIndices.add(item.promptIndex);
              verifiedResultCount++;
            }
            if (results.length > pageEnd && !query && !mediaType) continue;
            results.push({
              source: "web_run",
              id: run.id,
              prompt_index: item.promptIndex,
              kind: "result",
              result_index: resultIndex,
              identity: receipt.identity,
              provider,
              media_type: receipt.mediaType === "video" ? "video" : "image",
              batch_name: run.displayName || run.batchName || null,
              file_name: receipt.fileName || receipt.name || null,
              prompt: String(item.prompt || "").slice(0, 160),
              created_at: run.createdAt || null,
            });
          }
        }
        if (batchId) {
          const indices = [
            ...new Set(
              (snapshot.items || [])
                .map((item) => item.promptIndex)
                .filter(Number.isInteger),
            ),
          ].sort((a, b) => a - b);
          const missing = indices.filter(
            (index) => !verifiedPromptIndices.has(index),
          );
          const runStatus = snapshot.run.status;
          const settled = runStatus === "SETTLED";
          coverage = {
            source: "web_run",
            id: run.id,
            run_status: runStatus,
            settled,
            expected_prompt_count: expectedPromptCount ?? indices.length,
            source_prompt_count: indices.length,
            verified_result_count: verifiedResultCount,
            verified_prompt_indices: [...verifiedPromptIndices].sort(
              (a, b) => a - b,
            ),
            missing_prompt_indices: missing,
            complete:
              settled &&
              indices.length > 0 &&
              indices.every((index, slot) => index === slot) &&
              missing.length === 0 &&
              (expectedPromptCount === null ||
                indices.length === expectedPromptCount),
          };
        }
        if (results.length > pageEnd && !query && !mediaType) break;
      }
    }
    const matches = results.filter(
      (result) =>
        (!mediaType || result.media_type === mediaType) &&
        (!query ||
          [result.batch_name, result.file_name, result.prompt, result.id].some(
            (value) =>
              String(value || "")
                .toLocaleLowerCase()
                .includes(query),
          )),
    );
    this._assertSavedResultScope(scope);
    return {
      data: {
        provider,
        project_id: scope.projectId,
        results: matches.slice(offset, pageEnd),
        limit,
        offset,
        has_more: matches.length > pageEnd,
        next_offset: matches.length > pageEnd ? pageEnd : null,
        ...(batchId && { coverage }),
      },
    };
  }
  static async _executeAddSavedResultsToRefs(args = {}) {
    const provider = args?.provider || "flow";
    const selected = args?.results;
    if (
      !["flow", "chatgpt", "gemini", "muse"].includes(provider) ||
      !Array.isArray(selected) ||
      !selected.length ||
      selected.length > 20
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Ch\u1ECDn t\u1EEB 1 \u0111\u1EBFn 20 k\u1EBFt qu\u1EA3 c\xF9ng provider.",
      );
    const scope = this._savedResultScope(provider !== "flow");
    if (
      window.GenTab?.providerSelect?.value !== provider ||
      !window.GenTab?.fileIdsInput
    )
      throw this._err(
        "GEN_REFERENCES_NOT_READY",
        `Ch\u1ECDn ${provider} trong GenTab tr\u01B0\u1EDBc khi th\xEAm tham chi\u1EBFu.`,
      );
    const flowRefs = [],
      webRefs = [];
    const seen = new Set();
    for (const selector of selected) {
      const key = [
        selector?.source,
        selector?.id,
        selector?.prompt_index,
        selector?.result_index,
      ].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      if (selector.identity)
        await this._selectedSavedMedia(provider, selector, {
          metadataOnly: true,
        });
      if (
        !Number.isInteger(selector?.prompt_index) ||
        !Number.isInteger(selector?.result_index) ||
        selector.prompt_index < 0 ||
        selector.result_index < 0 ||
        typeof selector.id !== "string"
      )
        throw this._err(
          "VALIDATION_ERROR",
          "Selector k\u1EBFt qu\u1EA3 kh\xF4ng h\u1EE3p l\u1EC7.",
        );
      if (
        selector.extract_frame === "last" ||
        ["flow_ref", "web_batch_ref", "web_run_ref"].includes(selector.source)
      ) {
        const dataUrl = await this._readSavedImageDataUrl(provider, selector);
        if (provider === "flow") {
          this._assertSavedResultScope(scope);
          const ref = await this._uploadRefToFlow(dataUrl);
          if (!ref?.tileId || !ref.fileName)
            throw this._err(
              "UPLOAD_FAILED",
              "Could not upload the selected image to the current Flow project.",
            );
          flowRefs.push({
            fileId: ref.tileId,
            file_name: ref.fileName,
            thumbnail: ref.thumbnailUrl || dataUrl,
            type: "image",
          });
        } else {
          const blob = await (await fetch(dataUrl)).blob();
          const file = new File([blob], "saved-reference", { type: blob.type });
          webRefs.push({
            file,
            thumbnail: dataUrl,
            type: blob.type,
            name: file.name,
            sourceKey: `saved:${key}:${selector.identity || ""}:${selector.extract_frame || ""}`,
          });
        }
        continue;
      }
      if (provider === "flow" && selector.source === "flow_batch") {
        const batch = await window.GenBatchQueueStore.get(
          scope.userId,
          scope.projectId,
          selector.id,
        );
        if (!batch || batch.items?.[selector.prompt_index]?.hidden)
          throw this._err(
            "SAVED_RESULT_NOT_FOUND",
            "Batch ho\u1EB7c prompt \u0111\xE3 b\u1ECB x\xF3a.",
          );
        const result = this._flowSavedResults(batch, selector.prompt_index)[
          selector.result_index
        ];
        const corrected =
          result &&
          (await this._readSavedFlowIdentity(
            result,
            scope,
            result.video || batch.settingsSnapshot?.genType === "Video"
              ? "video"
              : "image",
          ));
        const fileId =
          this._flowMediaUuid(corrected || {}) ||
          result?.tileId ||
          result?.fileName ||
          result?.mediaId;
        if (typeof fileId !== "string" || !fileId.trim())
          throw this._err(
            "SAVED_RESULT_NOT_FOUND",
            "Result Flow kh\xF4ng c\xF2n ID tham chi\u1EBFu.",
          );
        flowRefs.push({
          fileId: fileId.trim(),
          file_name: corrected.fileName || null,
          media_uuid: this._flowMediaUuid(corrected),
          thumbnail:
            result.thumbnail ||
            result.sourceThumbnail ||
            (!result.video ? result.url : null) ||
            null,
          type: result.video ? "video" : "image",
          video_url: result.video ? result.playUrl || result.url || null : null,
        });
      } else if (provider !== "flow" && selector.source === "web_run") {
        const snapshot = await window.ProviderWebQueueStore.getRun(selector.id);
        const run = snapshot?.run;
        const currentRunner = await this._runnerId();
        if (
          !run ||
          String(run.userId) !== String(scope.userId) ||
          run.provider !== provider ||
          (run.source === "mcp_direct"
            ? run.runnerId !== currentRunner ||
              run.ownerScope !== `mcp:${run.mcpJobId}`
            : run.projectId !== scope.projectId)
        )
          throw this._err(
            "SAVED_RESULT_NOT_FOUND",
            "Run kh\xF4ng thu\u1ED9c browser, t\xE0i kho\u1EA3n ho\u1EB7c project hi\u1EC7n t\u1EA1i.",
          );
        const item = snapshot.items.find(
          (entry) =>
            entry.promptIndex === selector.prompt_index && !entry.hidden,
        );
        const receipt = item?.resultReceipts?.[selector.result_index];
        if (!receipt?.identity || !receipt?.assetKey)
          throw this._err(
            "SAVED_RESULT_NOT_FOUND",
            "Receipt k\u1EBFt qu\u1EA3 kh\xF4ng c\xF2n h\u1EE3p l\u1EC7.",
          );
        const asset = await window.ProviderWebQueueStore.getAsset(
          scope.userId,
          run.projectId ?? null,
          receipt.assetKey,
          run.ownerScope || null,
        );
        const mediaType = receipt.mediaType === "video" ? "video" : "image";
        const mimeType = asset?.blob?.type || asset?.type || "";
        if (
          asset?.runId !== run.id ||
          !asset.blob?.size ||
          !mimeType.startsWith(`${mediaType}/`)
        )
          throw this._err(
            "SAVED_RESULT_ASSET_MISSING",
            "File k\u1EBFt qu\u1EA3 \u0111\xE3 b\u1ECB x\xF3a kh\u1ECFi browser.",
          );
        let file,
          thumbnail = null;
        if (mediaType === "video") {
          const poster = receipt.posterAssetKey
            ? await window.ProviderWebQueueStore.getAsset(
                scope.userId,
                run.projectId ?? null,
                receipt.posterAssetKey,
                run.ownerScope || null,
              )
            : null;
          if (poster?.blob?.size && poster.blob.type?.startsWith("image/")) {
            file = new File(
              [poster.blob],
              poster.name || `${provider}_frame_${webRefs.length + 1}`,
              { type: poster.blob.type },
            );
          } else {
            const video = new File(
              [asset.blob],
              asset.name || `${provider}_result_${webRefs.length + 1}`,
              { type: mimeType },
            );
            const frame =
              await window.imagePickerModal?._createThumbnail?.(video);
            if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(frame || ""))
              throw this._err(
                "SAVED_RESULT_FRAME_UNAVAILABLE",
                "Kh\xF4ng th\u1EC3 l\u1EA5y frame tham chi\u1EBFu t\u1EEB video.",
              );
            const bytes = await (await fetch(frame)).arrayBuffer();
            file = new File(
              [bytes],
              `${video.name.replace(/\.[^.]+$/, "")}_frame.jpg`,
              { type: "image/jpeg" },
            );
            thumbnail = frame;
          }
        } else
          file = new File(
            [asset.blob],
            asset.name || `${provider}_result_${webRefs.length + 1}`,
            { type: mimeType },
          );
        try {
          thumbnail ||
            (thumbnail =
              (await window.imagePickerModal?._createThumbnail?.(file)) ||
              null);
        } catch (_) {}
        webRefs.push({
          file,
          thumbnail,
          type: file.type,
          name: file.name,
          sourceKey: `provider-web:${run.scope}:${receipt.assetKey}`,
        });
      } else
        throw this._err(
          "VALIDATION_ERROR",
          "Result kh\xF4ng kh\u1EDBp provider \u0111\xE3 ch\u1ECDn.",
        );
    }
    const current = this._savedResultScope(provider !== "flow");
    if (
      String(current.userId) !== String(scope.userId) ||
      current.projectId !== scope.projectId ||
      window.GenTab?.providerSelect?.value !== provider
    )
      throw this._err(
        "PROJECT_MISMATCH",
        "T\xE0i kho\u1EA3n, project ho\u1EB7c provider \u0111\xE3 \u0111\u1ED5i trong l\xFAc \u0111\u1ECDc result.",
      );
    const added =
      provider === "flow"
        ? await window.GenTab.addTrackerReferences(flowRefs, scope.projectId)
        : window.GenTab.addUploadRefImages(webRefs);
    window.showNotification?.(
      window.I18n?.t?.(
        added > 0 ? "gen.refImageAddedCount" : "gen.refImageAlreadyAdded",
        { count: added },
      ),
      added > 0 ? "success" : "info",
    );
    return {
      data: {
        provider,
        project_id: scope.projectId,
        requested: seen.size,
        added,
      },
    };
  }
  static async _savedReferenceImage(provider, selector, scope) {
    if (selector.source === "flow_ref" && provider === "flow") {
      const batch = await window.GenBatchQueueStore.get(
        scope.userId,
        scope.projectId,
        selector.id,
      );
      const ref = batch?.refPool?.[selector.result_index];
      if (!ref || ref.mediaType === "video")
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "\u1EA2nh tham chi\u1EBFu Flow kh\xF4ng c\xF2n trong batch.",
        );
      if (ref.refKey?.startsWith("upload_")) {
        const asset = await window.GenBatchQueueStore.getAsset(
          scope.userId,
          scope.projectId,
          batch.batchId,
          ref.refKey,
        );
        if (
          !asset?.file?.size ||
          asset.file.size > 1e7 ||
          !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
            asset.file.type,
          )
        )
          throw this._err(
            "SAVED_RESULT_ASSET_MISSING",
            "File ref upload ch\u1EDD kh\xF4ng c\xF2n h\u1EE3p l\u1EC7.",
          );
        return { blob: asset.file, identity: ref.refKey };
      }
      if (!ref.refKey || !ref.fileName)
        throw this._err(
          "SAVED_RESULT_IDENTITY_MISSING",
          "Ref Flow thi\u1EBFu tile ID ho\u1EB7c t\xEAn file.",
        );
      return {
        tileId: this._flowMediaUuid(ref) || ref.refKey,
        fileName: ref.fileName,
        url: ref.thumbnail || null,
        mediaUuid: ref.mediaUuid || null,
      };
    }
    if (
      selector.source === "web_batch_ref" &&
      ["chatgpt", "gemini", "muse"].includes(provider)
    ) {
      const batch = (
        await window.ProviderWebQueueStore.listBatches(
          scope.userId,
          scope.projectId,
        )
      ).find(
        (entry) => entry.id === selector.id && entry.provider === provider,
      );
      const key =
        batch?.prompts?.[selector.prompt_index]?.refKeys?.[
          selector.result_index
        ];
      if (!key)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Ref Web kh\xF4ng c\xF2n trong batch.",
        );
      const asset = await window.ProviderWebQueueStore.getAsset(
        scope.userId,
        scope.projectId,
        key,
      );
      if (
        asset?.batchId !== batch.id ||
        !asset.blob?.size ||
        asset.blob.size > 1e7 ||
        !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
          asset.blob.type,
        )
      )
        throw this._err(
          "SAVED_RESULT_ASSET_MISSING",
          "File ref Web kh\xF4ng c\xF2n h\u1EE3p l\u1EC7.",
        );
      return { blob: asset.blob, identity: key };
    }
    if (
      selector.source === "web_run_ref" &&
      ["chatgpt", "gemini", "muse"].includes(provider)
    ) {
      const snapshot = await window.ProviderWebQueueStore.getRun(selector.id);
      const run = snapshot?.run;
      const runnerId = await this._runnerId();
      let allowed =
        run &&
        String(run.userId) === String(scope.userId) &&
        run.provider === provider &&
        !run.hiddenFromBatchList &&
        (run.source === "mcp_direct"
          ? run.runnerId === runnerId &&
            run.ownerScope === `mcp:${run.mcpJobId}`
          : !!scope.projectId && run.projectId === scope.projectId);
      if (
        !allowed &&
        run?.mcpParentRunId &&
        String(run.userId) === String(scope.userId) &&
        run.provider === provider &&
        !run.hiddenFromBatchList
      ) {
        const parent = (
          await window.ProviderWebQueueStore.getRun(run.mcpParentRunId)
        )?.run;
        allowed =
          parent?.source === "mcp_direct" &&
          parent.runnerId === runnerId &&
          String(parent.userId) === String(scope.userId) &&
          parent.provider === provider &&
          !parent.hiddenFromBatchList &&
          parent.manualRuns?.some((entry) => entry.runId === run.id);
      }
      if (!allowed)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Run ref kh\xF4ng thu\u1ED9c t\xE0i kho\u1EA3n, project ho\u1EB7c runner n\xE0y.",
        );
      const item = snapshot.items?.find(
        (entry) => entry.promptIndex === selector.prompt_index && !entry.hidden,
      );
      const key = (item?.displayRefKeys || item?.refKeys || [])[
        selector.result_index
      ];
      if (!key)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "\u1EA2nh ref kh\xF4ng c\xF2n trong run.",
        );
      const asset = await window.ProviderWebQueueStore.getAsset(
        scope.userId,
        run.projectId ?? null,
        key,
        run.ownerScope || null,
      );
      if (
        asset?.runId !== run.id ||
        !asset.blob?.size ||
        asset.blob.size > 1e7 ||
        !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
          asset.blob.type,
        )
      )
        throw this._err(
          "SAVED_RESULT_ASSET_MISSING",
          "File ref run kh\xF4ng c\xF2n h\u1EE3p l\u1EC7.",
        );
      return { blob: asset.blob, identity: key };
    }
    throw this._err(
      "VALIDATION_ERROR",
      "Selector ref kh\xF4ng kh\u1EDBp provider ngu\u1ED3n.",
    );
  }
  static async _blobImageDataUrl(blob, scope) {
    this._assertSavedResultScope(scope);
    if (
      !blob?.size ||
      blob.size > 1e7 ||
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
        blob.type,
      )
    )
      throw this._err(
        "SAVED_RESULT_ASSET_MISSING",
        "Reference image is missing, unsupported or exceeds the upload limit.",
      );
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(reader.error || new Error("SAVED_RESULT_READ_FAILED"));
      reader.readAsDataURL(blob);
    });
    this._assertSavedResultScope(scope);
    return dataUrl;
  }
  static async _executeUploadSavedResultRef(args = {}) {
    const provider = args?.provider || "flow";
    const selector = args?.results?.[0];
    if (
      !["flow", "chatgpt", "gemini", "muse"].includes(provider) ||
      !Array.isArray(args?.results) ||
      args.results.length !== 1 ||
      !selector ||
      typeof selector.id !== "string" ||
      !selector.id ||
      !Number.isInteger(selector.prompt_index) ||
      selector.prompt_index < 0 ||
      !Number.isInteger(selector.result_index) ||
      selector.result_index < 0
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Ch\u1ECDn \u0111\xFAng m\u1ED9t \u1EA3nh \u0111\xE3 l\u01B0u b\u1EB1ng selector t\u1EEB list_saved_results.",
      );
    if (args.results?.[0]?.extract_frame === "last")
      return this._executeUploadRef({
        image: await this._readSavedImageDataUrl(
          args.provider,
          args.results[0],
        ),
      });
    const referenceSource = [
      "flow_ref",
      "web_batch_ref",
      "web_run_ref",
    ].includes(selector.source);
    if (args.results?.[0]?.identity && !referenceSource)
      await this._selectedSavedMedia(args.provider, args.results[0], {
        metadataOnly: true,
      });
    const scope = this._savedResultScope();
    if (referenceSource) {
      let ref = await this._savedReferenceImage(provider, selector, scope);
      if (provider === "flow" && !ref.blob)
        ref = await this._readSavedFlowIdentity(ref, scope, "image");
      this._assertSavedResultScope(scope);
      const identity =
        this._flowMediaUuid(ref) ||
        ref.identity ||
        ref.fileName ||
        ref.tileId ||
        null;
      if (selector.identity && selector.identity !== identity)
        throw this._err(
          "SAVED_RESULT_IDENTITY_CHANGED",
          "Reference slot changed; select the intended image again.",
        );
      if (ref.tileId) {
        const names = {};
        const ids = await this._resolveReuseRefs(
          [
            {
              provider: "flow",
              tile_id:
                this._flowMediaUuid(ref) ||
                this._flowMediaUuid({ tileId: selector.identity }) ||
                ref.tileId,
              file_name: ref.fileName,
            },
          ],
          names,
        );
        this._assertSavedResultScope(scope);
        if (ids.length !== 1)
          throw this._err(
            "SAVED_RESULT_NOT_FOUND",
            "Ref Flow kh\xF4ng c\xF2n tr\xEAn board.",
          );
        return {
          upload: { file_id: ids[0], file_name: names[ids[0]] || ref.fileName },
          data: { reused: true, source: selector.source },
        };
      }
      const up2 = await this._uploadRefToFlow(
        await this._blobImageDataUrl(ref.blob, scope),
      );
      if (!up2?.tileId || !up2.fileName)
        throw this._err(
          "SAVED_RESULT_IDENTITY_MISSING",
          "Upload ref ch\u01B0a tr\u1EA3 t\xEAn file Flow.",
        );
      return {
        upload: { file_id: up2.tileId, file_name: up2.fileName },
        data: { reused: false, source: selector.source },
      };
    }
    if (provider === "flow") {
      if (selector.source !== "flow_batch")
        throw this._err(
          "VALIDATION_ERROR",
          "Selector Flow kh\xF4ng h\u1EE3p l\u1EC7.",
        );
      const batch = await window.GenBatchQueueStore.get(
        scope.userId,
        scope.projectId,
        selector.id,
      );
      if (!batch || batch.items?.[selector.prompt_index]?.hidden)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Batch ho\u1EB7c prompt \u0111\xE3 b\u1ECB x\xF3a.",
        );
      const result = this._flowSavedResults(batch, selector.prompt_index)[
        selector.result_index
      ];
      if (
        !result ||
        result.video ||
        batch.settingsSnapshot?.genType === "Video"
      )
        throw this._err(
          "VALIDATION_ERROR",
          "Result video c\u1EA7n extract_last_frame tr\u01B0\u1EDBc khi d\xF9ng l\xE0m \u1EA3nh tham chi\u1EBFu.",
        );
      const corrected = await this._readSavedFlowIdentity(
        result,
        scope,
        "image",
      );
      const tileId =
        this._flowMediaUuid(corrected) || result.tileId || result.mediaId;
      const fileName = corrected.fileName || result.fileName;
      if (!tileId || !fileName)
        throw this._err(
          "SAVED_RESULT_IDENTITY_MISSING",
          "\u1EA2nh Flow \u0111\xE3 l\u01B0u thi\u1EBFu tile ID ho\u1EB7c t\xEAn file \u0111\u1EC3 x\xE1c minh trong project.",
        );
      const names = {};
      const ids = await this._resolveReuseRefs(
        [{ provider: "flow", tile_id: tileId, file_name: fileName }],
        names,
      );
      this._assertSavedResultScope(scope);
      if (ids.length !== 1)
        throw this._err(
          "PROJECT_MISMATCH",
          "Flow project \u0111\xE3 \u0111\u1ED5i khi x\xE1c minh \u1EA3nh.",
        );
      return {
        upload: { file_id: ids[0], file_name: names[ids[0]] || fileName },
        data: { reused: true, source: "flow_batch" },
      };
    }
    if (selector.source !== "web_run")
      throw this._err(
        "VALIDATION_ERROR",
        "Selector Web kh\xF4ng h\u1EE3p l\u1EC7.",
      );
    const dataUrl = await this._readSavedImageDataUrl(provider, selector);
    this._assertSavedResultScope(scope);
    const up = await this._uploadRefToFlow(dataUrl);
    if (!up?.tileId)
      throw this._err(
        "UPLOAD_FAILED",
        "Kh\xF4ng upload \u0111\u01B0\u1EE3c result local l\xE0m Flow ref.",
      );
    return {
      upload: {
        file_id: up.tileId,
        file_name: up.fileName || null,
        ...(up.thumbnailUrl && /^https?:\/\//.test(up.thumbnailUrl)
          ? { thumbnail_url: up.thumbnailUrl }
          : {}),
      },
      data: { reused: false, source: "web_run" },
    };
  }
  static _flowMediaUuid(media = {}) {
    return (
      [
        media.mediaUuid,
        media.media_uuid,
        media.tileId,
        media.tile_id,
        media.mediaId,
        media.fileName,
        media.file_name,
        media.refKey,
      ]
        .find(
          (value) =>
            typeof value === "string" &&
            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value),
        )
        ?.toLowerCase() || null
    );
  }
  static _correctSavedFlowIdentity(media, catalog, scope, type) {
    if (this._flowMediaUuid(media) || catalog?.supported !== true) return media;
    if (
      String(catalog.projectId || "").toLowerCase() !==
      String(scope.projectId).toLowerCase()
    )
      throw this._err(
        "PROJECT_MISMATCH",
        "Open the source Flow project before resolving its media identity.",
      );
    const aliases = [media.tileId, media.mediaId, media.fileName, media.refKey];
    const info = aliases
      .map((id) => catalog.known?.[id])
      .find((entry) => entry?.type === type && this._flowMediaUuid(entry));
    return info
      ? {
          ...media,
          mediaUuid: this._flowMediaUuid(info),
          fileName:
            info.persistent_media_id || info.file_name || media.fileName,
        }
      : media;
  }
  static async _readSavedFlowIdentity(media, scope, type) {
    if (
      this._flowMediaUuid(media) ||
      !window.MessageBridge?.lookupFlowMediaCatalog
    )
      return media;
    const aliases = [
      media.tileId,
      media.mediaId,
      media.fileName,
      media.refKey,
    ].filter(Boolean);
    const catalog = await window.MessageBridge.lookupFlowMediaCatalog(
      aliases,
    ).catch(() => null);
    this._assertSavedResultScope(scope);
    return this._correctSavedFlowIdentity(media, catalog, scope, type);
  }
  static async _flowApiState(
    mediaType = "image",
    projectId = window._currentProjectId,
  ) {
    const settings = window.storageSettings?.getSettings?.() || {};
    const selected = settings.defaultGenMode || settings.gen_mode || null;
    const mode =
      selected === "ui"
        ? "web"
        : ["web", "api", "auto"].includes(selected)
          ? selected
          : null;
    const enabled = [true, "true", 1].includes(settings.apiModeEnabled);
    const runningMode = window.FlowApiSessionCoordinator?._activeWebDispatch?.()
      ? "web"
      : window.FlowApiSessionCoordinator?._activeApiDispatch?.() === true
        ? "api"
        : null;
    const state = {
      mode,
      running_mode: runningMode,
      enabled,
      active: false,
      ready: false,
      reason: "config_unavailable",
      media_type: mediaType,
      _driver: null,
      _tabId: null,
    };
    const policy = window.SystemConfig?.get?.("flow_api_driver", null);
    const allowed = window.featureGate?.canUse?.("flow_api_enabled") === true;
    if (!enabled) return { ...state, reason: "disabled" };
    if (mode === "web") return { ...state, reason: "web_mode" };
    if (!allowed) return { ...state, reason: "feature_unavailable" };
    if (policy === "disabled") return { ...state, reason: "disabled" };
    if (!mode || !["v1", "v2", "v2_canary", "auto"].includes(policy))
      return state;
    if (window.FlowApiAdapter?.isApiModeIntended?.() !== true)
      return { ...state, reason: "session_not_ready" };
    if (!projectId) return { ...state, reason: "project_required" };
    try {
      const health = await window.FlowApiSessionCoordinator?.check?.({
        projectId,
        surface: "gen",
        mediaType,
        passive: true,
      });
      const webActive =
        runningMode === "web" ||
        health?.activeGenerationRoute === "web" ||
        /^health_probe_suppressed_web/.test(health?.detail || "");
      const sameProject =
        !health?.projectId ||
        String(health.projectId).toLowerCase() ===
          String(projectId).toLowerCase();
      const policyMatches =
        policy === "v2"
          ? health?.driver === "v2"
          : policy === "v1"
            ? health?.driver === "v1"
            : true;
      const ready =
        health?.ready === true &&
        ["v1", "v2"].includes(health.driver) &&
        policyMatches &&
        sameProject &&
        !webActive;
      return {
        ...state,
        ready,
        active: ready,
        reason: ready ? "ready" : webActive ? "busy" : "session_not_ready",
        _driver: ready ? health.driver : null,
        _tabId: Number.isInteger(health?.flowTabId) ? health.flowTabId : null,
      };
    } catch (_) {
      return { ...state, reason: "session_not_ready" };
    }
  }
  static _publicFlowState(state) {
    return {
      mode: state.mode,
      running_mode: state.running_mode,
      api: {
        enabled: state.enabled,
        active: state.active,
        ready: state.ready,
        reason: state.reason,
        media_type: state.media_type,
      },
    };
  }
  static async _resolveSavedFlowApiMedia(uuid, scope, type) {
    const api = await this._flowApiState(type, scope.projectId);
    this._assertSavedResultScope(scope);
    if (!api.active) return null;
    try {
      if (api._driver === "v2" && window.FlowApiFacade?.resolveMedia) {
        const config =
          await window.ProviderConfigManager?.fetchFlowApiV2Configs?.();
        const fingerprint =
          config && window.FlowApiV2CheckpointStore?.fingerprint?.(config);
        if (!fingerprint) return null;
        const result = await window.FlowApiFacade.resolveMedia({
          mediaId: uuid,
          mediaType: type,
          apiDriver: "v2",
          projectId: scope.projectId,
          flowApiTabId: api._tabId,
          uuidLookup: true,
          protocolRevision: Number(config.protocol?.schema_version || 0),
          protocolFingerprint: fingerprint,
          abortFn: () => this._cancelRequested,
        });
        this._assertSavedResultScope(scope);
        return result?.url ? { url: result.url } : null;
      }
      if (api._driver === "v1" && window.FlowApiFacade?.resolveMedia) {
        const result = await window.FlowApiFacade.resolveMedia({
          mediaId: uuid,
          mediaType: type,
          apiDriver: "v1",
          projectId: scope.projectId,
          flowApiTabId: api._tabId,
          abortFn: () => this._cancelRequested,
        });
        this._assertSavedResultScope(scope);
        return result?.url ? { url: result.url } : null;
      }
      return null;
    } catch (error) {
      if (
        ["PROJECT_MISMATCH", "FLOW_EXECUTION_TARGET_CHANGED"].includes(
          error?.code,
        )
      )
        throw this._err(
          "PROJECT_MISMATCH",
          "Flow project changed while reading the selected media.",
        );
      if (this._cancelRequested)
        throw this._err("CANCELLED", "Saved media read cancelled.");
      if (error?.code === "FLOW_MEDIA_UUID_NOT_FOUND")
        throw this._err(
          "SAVED_RESULT_ASSET_MISSING",
          "The selected media was not found in this project.",
        );
      throw this._err(
        "SAVED_RESULTS_UNAVAILABLE",
        "The selected media could not be read right now.",
      );
    }
  }
  static async _savedFlowMediaUrl(media, scope, type) {
    const bridge = window.MessageBridge;
    const uuid = this._flowMediaUuid(media);
    if (uuid && window.flow_uuid_gateway) {
      let lookup;
      try {
        lookup = await window.flow_uuid_gateway.resolve([uuid], {
          projectId: scope.projectId,
          surface: "gen",
          mediaType: type,
          purpose: "preview",
          passive: true,
          abortFn: () => this._cancelRequested,
        });
      } catch (error) {
        this._assertSavedResultScope(scope);
        if (this._cancelRequested)
          throw this._err("CANCELLED", "Saved media read cancelled.");
        if (
          [
            "PROJECT_MISMATCH",
            "FLOW_EXECUTION_TARGET_CHANGED",
            "FLOW_MEDIA_LOOKUP_SCOPE_CHANGED",
          ].includes(error?.code || error?.message)
        )
          throw this._err(
            "PROJECT_MISMATCH",
            "Flow project changed while reading the selected media.",
          );
      }
      this._assertSavedResultScope(scope);
      const verdict = lookup?.results?.[uuid];
      if (verdict?.status === "not_found")
        throw this._err(
          "SAVED_RESULT_ASSET_MISSING",
          "The selected media was not found in this project.",
        );
      const info = verdict?.ok ? verdict.metadata : null;
      const resolved =
        type === "video"
          ? info?.video_url
          : info?.image_url || info?.source_thumbnail || info?.thumbnail;
      if (resolved) return resolved;
    }
    const identities = [
      ...new Set(
        [
          uuid,
          media.mediaUuid,
          media.mediaId,
          media.fileName,
          media.tileId,
        ].filter((value) => typeof value === "string" && value),
      ),
    ];
    let resolvedSource = false,
      nativeName = media.fileName || "";
    let url =
      type === "video"
        ? media.video_url || media.videoUrl || media.playUrl || media.url
        : media.url || media.sourceThumbnail || media.thumbnail;
    if (identities.length && bridge?.lookupFlowMediaCatalog) {
      const catalog = await bridge
        .lookupFlowMediaCatalog(identities)
        .catch(() => null);
      if (catalog?.supported === true) {
        if (
          String(catalog.projectId || "").toLowerCase() !==
          String(scope.projectId).toLowerCase()
        )
          throw this._err(
            "PROJECT_MISMATCH",
            "Flow media catalog belongs to another project.",
          );
        const info = identities
          .map((id) => catalog.known?.[id])
          .find(
            (entry) =>
              entry?.type === type &&
              (!uuid ||
                String(entry.media_uuid || "").toLowerCase() ===
                  uuid.toLowerCase()),
          );
        const resolved =
          type === "video"
            ? info?.video_url
            : info?.source_thumbnail || info?.thumbnail;
        if (info?.persistent_media_id) nativeName = info.persistent_media_id;
        if (!info && uuid) {
          url = null;
          nativeName = "";
        }
        if (resolved) {
          url = resolved;
          resolvedSource = true;
        }
      }
    }
    if (!resolvedSource && uuid) {
      const resolved = await this._resolveSavedFlowApiMedia(uuid, scope, type);
      if (resolved?.url) {
        url = resolved.url;
        resolvedSource = true;
      }
    }
    if (
      type === "image" &&
      !url &&
      bridge?.getTargetContext &&
      bridge?.getThumbnailsByIds
    ) {
      const target = await bridge.getTargetContext();
      if (
        String(target?.projectId || "").toLowerCase() !==
        String(scope.projectId).toLowerCase()
      )
        throw this._err(
          "PROJECT_MISMATCH",
          "Open the source Flow project before reading its media.",
        );
      const id = uuid || media.mediaId || media.tileId || nativeName;
      const mounted = await bridge.getThumbnailsByIds([id], {
        deep: false,
        fileNamesById: nativeName ? { [id]: nativeName } : {},
        ...(uuid
          ? {
              ownerRecords: [
                { resultId: id, mediaUuid: uuid, mediaType: "image" },
              ],
            }
          : {}),
      });
      const info = mounted?.results?.[id];
      if (
        info?.type === "image" &&
        (!uuid ||
          String(info.media_uuid || "").toLowerCase() === uuid.toLowerCase())
      )
        url = info.source_thumbnail || info.thumbnail || url;
    }
    if (
      !resolvedSource &&
      type === "video" &&
      bridge?.resolveVideoPlaybackUrl
    ) {
      const playback = await bridge.resolveVideoPlaybackUrl(
        uuid || media.tileId || media.mediaId || nativeName,
        {
          fileName: nativeName,
          projectId: scope.projectId,
          sourceUrl: url || "",
          skipMediaApiResolve: true,
          abortFn: () => this._cancelRequested,
        },
      );
      if (playback?.success && playback.video_url) url = playback.video_url;
    }
    this._assertSavedResultScope(scope);
    return url;
  }
  static async _selectedSavedMedia(
    provider,
    selector,
    { metadataOnly = false } = {},
  ) {
    if (
      !["flow", "chatgpt", "gemini", "muse"].includes(provider) ||
      !selector?.id ||
      !Number.isInteger(selector.prompt_index) ||
      selector.prompt_index < 0 ||
      !Number.isInteger(selector.result_index) ||
      selector.result_index < 0
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Select an exact saved Batch List result.",
      );
    const scope = this._savedResultScope(provider !== "flow");
    let blob = null,
      type = "image",
      name = "",
      identity = null,
      url = null;
    if (
      ["flow_ref", "web_batch_ref", "web_run_ref"].includes(selector.source)
    ) {
      let ref = await this._savedReferenceImage(provider, selector, scope);
      if (provider === "flow" && !ref.blob)
        ref = await this._readSavedFlowIdentity(ref, scope, "image");
      blob = ref.blob || null;
      url = ref.url;
      name = ref.fileName || "";
      identity =
        this._flowMediaUuid(ref) ||
        ref.identity ||
        ref.fileName ||
        ref.tileId ||
        null;
      if (!metadataOnly && !blob && provider === "flow")
        url = await this._savedFlowMediaUrl(
          { ...ref, thumbnail: ref.url },
          scope,
          "image",
        );
    } else if (selector.source === "flow_batch" && provider === "flow") {
      const batch = await window.GenBatchQueueStore.get(
        scope.userId,
        scope.projectId,
        selector.id,
      );
      const item = batch?.items?.[selector.prompt_index];
      if (!item || item.hidden)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Saved Flow prompt is missing.",
        );
      let media = this._flowSavedResults(batch, selector.prompt_index)[
        selector.result_index
      ];
      if (!media)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Saved Flow result is missing.",
        );
      media = await this._readSavedFlowIdentity(
        media,
        scope,
        media.video || batch.settingsSnapshot?.genType === "Video"
          ? "video"
          : "image",
      );
      identity =
        this._flowMediaUuid(media) ||
        media.fileName ||
        media.tileId ||
        media.mediaId;
      type =
        media.video || batch.settingsSnapshot?.genType === "Video"
          ? "video"
          : "image";
      name = media.fileName || "";
      url =
        media.video_url ||
        media.videoUrl ||
        media.playUrl ||
        media.url ||
        media.thumbnail;
      if (selector.identity && selector.identity !== identity)
        throw this._err(
          "SAVED_RESULT_IDENTITY_CHANGED",
          "Saved result changed; select the intended take again.",
        );
      if (!metadataOnly)
        url = await this._savedFlowMediaUrl(media, scope, type);
    } else if (selector.source === "web_run" && provider !== "flow") {
      const snapshot = await window.ProviderWebQueueStore.getRun(selector.id),
        run = snapshot?.run;
      if (
        !run ||
        String(run.userId) !== String(scope.userId) ||
        run.provider !== provider ||
        run.hiddenFromBatchList
      )
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Saved Web run is not accessible.",
        );
      const runner = await this._runnerId();
      let allowed =
        run.source === "mcp_direct"
          ? run.runnerId === runner && run.ownerScope === `mcp:${run.mcpJobId}`
          : !!scope.projectId && run.projectId === scope.projectId;
      if (!allowed && run.mcpParentRunId) {
        const parent = (
          await window.ProviderWebQueueStore.getRun(run.mcpParentRunId)
        )?.run;
        allowed =
          parent?.source === "mcp_direct" &&
          parent.runnerId === runner &&
          String(parent.userId) === String(scope.userId) &&
          parent.provider === provider &&
          !parent.hiddenFromBatchList &&
          parent.manualRuns?.some((entry) => entry.runId === run.id);
      }
      if (!allowed)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Run does not belong to this project/runner.",
        );
      const item = snapshot.items.find(
        (row) => row.promptIndex === selector.prompt_index && !row.hidden,
      );
      const receipt = item?.resultReceipts?.[selector.result_index];
      if (!receipt?.identity || !receipt.assetKey)
        throw this._err(
          "SAVED_RESULT_NOT_FOUND",
          "Verified result receipt is missing.",
        );
      identity = receipt.identity;
      type = receipt.mediaType === "video" ? "video" : "image";
      if (selector.identity && selector.identity !== identity)
        throw this._err(
          "SAVED_RESULT_IDENTITY_CHANGED",
          "Result slot now contains another take.",
        );
      const asset = await window.ProviderWebQueueStore.getAsset(
        scope.userId,
        run.projectId ?? null,
        receipt.assetKey,
        run.ownerScope || null,
      );
      if (asset?.runId !== run.id || !asset.blob?.size)
        throw this._err(
          "SAVED_RESULT_ASSET_MISSING",
          "Original media bytes are missing in this browser profile.",
        );
      blob = asset.blob;
      name = receipt.fileName || receipt.name || asset.name || "";
    } else
      throw this._err(
        "VALIDATION_ERROR",
        "Saved media selector does not match its provider.",
      );
    this._assertSavedResultScope(scope);
    if (selector.identity && identity && selector.identity !== identity)
      throw this._err(
        "SAVED_RESULT_IDENTITY_CHANGED",
        "Saved media identity changed.",
      );
    if (metadataOnly) return { scope, type, identity };
    if (!blob) {
      if (!/^https:\/\//i.test(String(url)))
        throw this._err(
          "SAVED_RESULT_ASSET_MISSING",
          "Saved media has no readable original source.",
        );
      try {
        const response = await this._fetchTO(url, {}, 3e4);
        if (response?.ok) blob = await response.blob();
      } catch (_) {}
      if (!blob?.size) {
        const fetched = await chrome.runtime.sendMessage({
          action: "fetchBlob",
          url,
          expectImage: type === "image",
        });
        if (!fetched?.success || !fetched.base64)
          throw this._err(
            "SAVED_RESULT_ASSET_MISSING",
            "Could not download the existing selected result.",
          );
        const data = /^data:/i.test(fetched.base64)
          ? fetched.base64
          : `data:${fetched.contentType || fetched.mime};base64,${fetched.base64}`;
        blob = await (await fetch(data)).blob();
      }
    }
    if (!blob?.size || !blob.type.toLowerCase().startsWith(type + "/"))
      throw this._err(
        "SAVED_RESULT_ASSET_MISSING",
        "Stored media MIME does not match the selected result.",
      );
    this._assertSavedResultScope(scope);
    if (selector.extract_frame === "last") {
      if (type !== "video" || !window.VideoFrameExtractor?.extractLastFrame)
        throw this._err(
          "VALIDATION_ERROR",
          "Last-frame extraction requires a video result.",
        );
      const objectUrl = URL.createObjectURL(blob);
      try {
        const frame = await window.VideoFrameExtractor.extractLastFrame(
          objectUrl,
          { shouldStop: () => this._cancelRequested },
        );
        const parts = this._inlineImageParts(frame?.base64, "image/jpeg");
        blob = await (
          await fetch(`data:${parts.mime};base64,${parts.base64}`)
        ).blob();
        name = name.replace(/\.[^.]+$/, "") + "-last-frame.jpg";
        type = "image";
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
      this._assertSavedResultScope(scope);
    }
    return { scope, blob, type, name, identity };
  }
  static async _executeGetSavedMedia(args = {}) {
    if (
      !Array.isArray(args.results) ||
      !args.results.length ||
      args.results.length > 20
    )
      throw this._err("VALIDATION_ERROR", "Select 1-20 saved media items.");
    const thumbnails = [],
      downloads = [];
    for (const selector of args.results) {
      const media = await this._selectedSavedMedia(args.provider, selector);
      if (this._cancelRequested)
        throw this._err("CANCELLED", "Saved media delivery cancelled.");
      if (args.delivery === "browser") {
        const helper = window.DownloadHelper,
          settings = await helper.getSettings();
        const ext = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/webp": "webp",
          "image/gif": "gif",
          "video/mp4": "mp4",
          "video/webm": "webm",
          "video/ogg": "ogv",
        }[media.blob.type];
        if (!ext)
          throw this._err(
            "SAVED_RESULT_ASSET_MISSING",
            "Saved media format is not supported.",
          );
        const filename = helper.buildFilename({
          template: settings.template,
          project: settings.project,
          folder: settings.folder,
          taskName: args.batch_name || selector.id,
          prompt: media.name || selector.id,
          index: selector.prompt_index + 1,
          ext,
        });
        this._assertSavedResultScope(media.scope);
        if (this._cancelRequested)
          throw this._err("CANCELLED", "Saved media delivery cancelled.");
        const response = await helper[
          media.type === "video"
            ? "downloadStoredProviderVideo"
            : "downloadStoredProviderImage"
        ]({ blob: media.blob, filename, waitForComplete: true });
        if (!response?.success)
          throw this._err(
            "SAVED_RESULT_DOWNLOAD_FAILED",
            response?.error || "Browser download did not complete.",
          );
        downloads.push({
          ...selector,
          filename:
            response.filename ||
            (media.type === "image"
              ? filename.replace(/\.[^.\/]+$/, ".jpg")
              : filename),
          download_id: response.downloadId || null,
          downloaded: true,
          source_bytes: media.blob.size,
          source_mime_type: media.blob.type,
        });
        continue;
      }
      thumbnails.push({
        type: media.type,
        provider: args.provider,
        _savedBlob: media.blob,
        file_name: media.name,
        mime_type: media.blob.type,
        batch_id: selector.id,
        batch_source: selector.source,
        prompt_index: selector.prompt_index,
        result_index: selector.result_index,
        identity: media.identity,
      });
    }
    return args.delivery === "browser"
      ? { data: { provider: args.provider, downloads } }
      : { thumbnails };
  }
  static async _readSavedImageDataUrl(provider, selector) {
    const media = await this._selectedSavedMedia(provider, selector);
    if (media.type !== "image")
      throw this._err(
        "VALIDATION_ERROR",
        "Choose extract_frame:last for a video reference.",
      );
    return this._blobImageDataUrl(media.blob, media.scope);
  }
  static async _prepareSavedRefsForGen(args, targetProvider) {
    if (
      Array.isArray(args.saved_refs_per_prompt) &&
      args.saved_refs_per_prompt.length
    ) {
      const prompts = this._resolvePromptList(args);
      const sets = args.saved_refs_per_prompt;
      if (
        !["flow", "chatgpt", "grok", "gemini", "muse"].includes(
          targetProvider,
        ) ||
        sets.length !== prompts.length ||
        sets.some((set) => !Array.isArray(set) || !set.length) ||
        sets.reduce((total, set) => total + set.length, 0) > 10 ||
        args.ref_mode === "none" ||
        args.saved_refs?.length ||
        args.refs?.length ||
        args.refs_per_prompt?.length ||
        args.reuse_refs?.length
      )
        throw this._err(
          "VALIDATION_ERROR",
          "saved_refs_per_prompt c\u1EA7n m\u1ED9t b\u1ED9 \u1EA3nh cho m\u1ED7i prompt v\xE0 kh\xF4ng k\u1EBFt h\u1EE3p v\u1EDBi c\xE1c ref kh\xE1c.",
        );
      const refsPerPrompt = [],
        flowRefNames = {};
      const flowScope =
        targetProvider === "flow" ? this._savedResultScope() : null;
      for (const set of sets) {
        const refs2 = [];
        for (const saved of set) {
          if (
            targetProvider === "flow" &&
            saved.provider === "flow" &&
            !saved.extract_frame
          ) {
            const result = await this._executeUploadSavedResultRef({
              provider: "flow",
              results: [saved],
            });
            this._assertSavedResultScope(flowScope);
            if (!result.upload?.file_id || !result.upload.file_name)
              throw this._err(
                "SAVED_RESULT_IDENTITY_MISSING",
                "Flow reference has no current-project identity.",
              );
            refs2.push(result.upload.file_id);
            flowRefNames[result.upload.file_id] = result.upload.file_name;
          } else
            refs2.push(
              await this._readSavedImageDataUrl(saved.provider, saved),
            );
        }
        refsPerPrompt.push(refs2);
      }
      return {
        ...args,
        refs_per_prompt: refsPerPrompt,
        ...(flowScope
          ? { _savedFlowRefNames: flowRefNames, _savedFlowScope: flowScope }
          : {}),
      };
    }
    if (
      !["flow", "chatgpt", "grok", "gemini", "muse"].includes(targetProvider) ||
      !Array.isArray(args.saved_refs) ||
      args.saved_refs.length > 10 ||
      args.ref_mode === "none" ||
      args.refs_per_prompt?.length
    )
      throw this._err(
        "VALIDATION_ERROR",
        "saved_refs c\u1EA7n 1\u201310 \u1EA3nh d\xF9ng chung; kh\xF4ng k\u1EBFt h\u1EE3p ref_mode none ho\u1EB7c refs_per_prompt.",
      );
    const selectors = args.saved_refs;
    if (targetProvider === "flow") {
      const flowScope = this._savedResultScope();
      const reuseRefs = [...(args.reuse_refs || [])];
      for (const saved of selectors) {
        const result = await this._executeUploadSavedResultRef({
          provider: saved.provider,
          results: [saved],
        });
        this._assertSavedResultScope(flowScope);
        if (!result.upload?.file_id || !result.upload?.file_name)
          throw this._err(
            "SAVED_RESULT_IDENTITY_MISSING",
            "Result ch\u01B0a c\xF3 t\xEAn file Flow \u0111\u1EC3 t\xE1i d\xF9ng an to\xE0n.",
          );
        reuseRefs.push({
          provider: "flow",
          tile_id: result.upload.file_id,
          file_name: result.upload.file_name,
        });
      }
      return { ...args, reuse_refs: reuseRefs, _savedFlowScope: flowScope };
    }
    const refs = [...(args.refs || [])];
    for (const saved of selectors)
      refs.push(await this._readSavedImageDataUrl(saved.provider, saved));
    return { ...args, refs };
  }
  static async _executeListSavedBatches(args = {}) {
    const provider = args?.provider || "flow";
    const scope = this._savedResultScope(
      provider !== "flow" && args.include_runs === true,
    );
    if (!["flow", "chatgpt", "gemini", "muse"].includes(provider))
      throw this._err(
        "VALIDATION_ERROR",
        "Provider Batch List kh\xF4ng h\u1EE3p l\u1EC7.",
      );
    if (provider === "flow") await window.genBatchListModal?.syncMcpHistory?.();
    const query = String(args?.query || "")
      .trim()
      .toLocaleLowerCase();
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 50));
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw this._err("VALIDATION_ERROR", "Invalid batch offset.");
    const source = provider === "flow" ? "flow_batch" : "web_batch";
    const rows =
      provider === "flow"
        ? await window.GenBatchQueueStore.list(scope.userId, scope.projectId)
        : (scope.projectId
            ? await window.ProviderWebQueueStore.listBatches(
                scope.userId,
                scope.projectId,
              )
            : []
          ).filter((batch) => batch.provider === provider);
    const batches = rows
      .slice()
      .reverse()
      .map((batch) => ({
        source,
        id: provider === "flow" ? batch.batchId : batch.id,
        provider,
        name: batch.displayName || null,
        status: batch.status,
        revision: batch.revision,
        prompt_count:
          provider === "flow"
            ? batch.items?.filter((item) => !item.hidden).length || 0
            : batch.prompts?.length || 0,
        created_at: batch.createdAt || null,
      }));
    if (provider !== "flow" && args.include_runs === true) {
      const runs = await this._savedWebRuns(scope, provider);
      const seen = new Set();
      for (const run of runs) {
        if (
          seen.has(run.id) ||
          run.manualRegen ||
          !["mcp_direct", "gentab_direct"].includes(run.source)
        )
          continue;
        seen.add(run.id);
        batches.push({
          source: "web_run",
          id: run.id,
          provider,
          name: run.displayName || run.batchName || null,
          status: run.status,
          revision: run.revision,
          created_at: run.createdAt || null,
        });
      }
      batches.sort(
        (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0),
      );
    }
    this._assertSavedResultScope(scope);
    const matched = batches.filter(
      (batch) =>
        !query ||
        [batch.id, batch.name].some((value) =>
          String(value || "")
            .toLocaleLowerCase()
            .includes(query),
        ),
    );
    return {
      data: {
        provider,
        project_id: scope.projectId,
        batches: matched.slice(offset, offset + limit),
        limit,
        offset,
        total: matched.length,
        has_more: matched.length > offset + limit,
        next_offset: matched.length > offset + limit ? offset + limit : null,
      },
    };
  }
  static async _savedFlowBatch(args = {}) {
    const scope = this._savedResultScope();
    if (
      args.provider !== "flow" ||
      args.batch_source !== "flow_batch" ||
      !String(args.batch_id || "").trim()
    )
      throw this._err(
        "VALIDATION_ERROR",
        "C\u1EA7n Flow batch_source=flow_batch v\xE0 batch_id.",
      );
    await window.genBatchListModal?.syncMcpHistory?.();
    const batch = await window.GenBatchQueueStore?.get?.(
      scope.userId,
      scope.projectId,
      String(args.batch_id).trim(),
    );
    if (!batch)
      throw this._err(
        "SAVED_BATCH_NOT_FOUND",
        "Batch kh\xF4ng thu\u1ED9c Flow project hi\u1EC7n t\u1EA1i.",
      );
    this._assertSavedResultScope(scope);
    return { scope, batch };
  }
  static _savedBatchDisplayStatus(
    items,
    ownerStatus,
    paused = false,
    leaseActive = false,
  ) {
    const states = items
      .filter((item) => !item.hidden)
      .map((item) => String(item.status || item.state || "").toUpperCase());
    if (!states.length) return "queued";
    const active = states.some((state) =>
      [
        "PREPARING",
        "SUBMITTING",
        "SUBMITTED",
        "MONITORING",
        "GENERATING",
        "RUNNING",
      ].includes(state),
    );
    const retryQueued = items.some(
      (item) =>
        !item.hidden &&
        item.retry_pending === true &&
        ["FAILED", "QUEUED"].includes(item.status || item.state) &&
        (item.retry_active === true ||
          (leaseActive && String(ownerStatus).toUpperCase() !== "SETTLED")),
    );
    const pending =
      retryQueued ||
      states.some((state) =>
        [
          "PENDING",
          "QUEUED",
          "RETRY_SUBMIT",
          "WAITING_USER",
          "WAITING_PROVIDER",
          "WAITING_DEPENDENCY",
        ].includes(state),
      );
    if (
      (active || pending) &&
      (paused || String(ownerStatus).toLowerCase() === "paused")
    )
      return "paused";
    if (active) return "running";
    if (pending) return "queued";
    if (states.includes("NEEDS_REVIEW")) return "needs_review";
    if (states.every((state) => ["COMPLETED", "SUCCESS"].includes(state)))
      return "completed";
    if (
      items.some(
        (item) =>
          !item.hidden &&
          (item.status || item.state) === "CANCELLED" &&
          item.error === "USER_CANCELLED",
      )
    )
      return "stopped";
    if (String(ownerStatus).toLowerCase() === "stopped") return "stopped";
    const completed = states.filter((state) =>
      ["COMPLETED", "SUCCESS"].includes(state),
    ).length;
    return completed === states.length
      ? "completed"
      : completed
        ? "partial_fail"
        : states.every((state) => state === "CANCELLED")
          ? "stopped"
          : "failed";
  }
  static _savedWebPresentationSettings(settings = {}) {
    return Object.fromEntries(
      [
        "mediaType",
        "model",
        "ratio",
        "refMode",
        "refImagesPerPrompt",
        "autoDownload",
        "deleteAfterGen",
        "downloadSubFolder",
      ]
        .filter((key) => settings[key] !== void 0)
        .map((key) => [key, settings[key]]),
    );
  }
  static async _executeGetSavedBatch(args = {}) {
    if (args.provider !== "flow") return this._executeGetSavedWebBatch(args);
    const { scope, batch } = await this._savedFlowBatch(args);
    const modal = window.genBatchListModal;
    const displayed = modal?._displayItems?.(batch, null, null) || [];
    const items = (batch.items || []).map((item, index) => {
      const receipt = batch.terminalItems?.[index];
      const current = displayed[index];
      const state = current?.state || receipt?.state || item.state || "PENDING";
      const results = current?.results?.length
        ? current.results
        : this._flowSavedResults(batch, index);
      return {
        prompt_index: index,
        prompt: item.prompt || item.text || "",
        hidden: item.hidden === true,
        status: state,
        result_count: results.length,
        error: current?.error || receipt?.error || item.error || null,
      };
    });
    const visible = items.filter((item) => !item.hidden);
    const summary = {
      completed: visible.filter((item) => item.status === "COMPLETED").length,
      failed: visible.filter((item) =>
        ["FAILED", "PARTIAL_FAIL", "CANCELLED", "BLOCKED"].includes(
          item.status,
        ),
      ).length,
      pending: visible.filter((item) =>
        [
          "PENDING",
          "QUEUED",
          "RETRY_SUBMIT",
          "WAITING_USER",
          "WAITING_PROVIDER",
          "WAITING_DEPENDENCY",
        ].includes(item.status),
      ).length,
      other: 0,
    };
    summary.other =
      visible.length - summary.completed - summary.failed - summary.pending;
    return {
      data: {
        batch: {
          source: "flow_batch",
          id: batch.batchId,
          provider: "flow",
          name: batch.displayName || null,
          status: batch.status,
          revision: batch.revision,
          display_status: this._savedBatchDisplayStatus(items, batch.status),
          project_id: scope.projectId,
          prompt_count: visible.length,
          summary,
          items,
        },
      },
    };
  }
  static async _executeGetSavedWebBatch(args = {}) {
    const { provider, batch_source: source } = args;
    const scope = this._savedResultScope(source === "web_run");
    const id = String(args.batch_id || "").trim();
    if (
      !["chatgpt", "gemini", "muse"].includes(provider) ||
      !["web_batch", "web_run"].includes(source) ||
      !id
    )
      throw this._err(
        "VALIDATION_ERROR",
        "C\u1EA7n Web provider, batch_source v\xE0 batch_id h\u1EE3p l\u1EC7.",
      );
    const store = window.ProviderWebQueueStore;
    const rows =
      source === "web_run"
        ? await this._savedWebRuns(scope, provider)
        : await store.listBatches(scope.userId, scope.projectId);
    const batch = rows.find(
      (row) => row.id === id && row.provider === provider,
    );
    if (!batch)
      throw this._err(
        "SAVED_BATCH_NOT_FOUND",
        "Batch kh\xF4ng thu\u1ED9c runner/project hi\u1EC7n t\u1EA1i.",
      );
    const runId = source === "web_run" ? id : batch.runId;
    const snapshot = runId ? await store.getRun(runId) : null;
    if (
      runId &&
      (!snapshot ||
        snapshot.run.scope !== batch.scope ||
        String(snapshot.run.userId) !== String(scope.userId) ||
        snapshot.run.provider !== provider ||
        (source === "web_run" &&
          snapshot.run.source === "mcp_direct" &&
          snapshot.run.runnerId !== (await this._runnerId())))
    )
      throw this._err(
        "SAVED_BATCH_NOT_FOUND",
        "Run kh\xF4ng thu\u1ED9c batch/runner hi\u1EC7n t\u1EA1i.",
      );
    const display = snapshot
      ? snapshot.items.map((item) => ({
          ...item,
          resultRunId: runId,
          retryActive:
            snapshot.run.status !== "SETTLED" &&
            (snapshot.leaseActive === true ||
              window.ProviderWebScheduler?.getRunControlState?.(runId)
                ?.active === true),
          resultPromptIndex: item.promptIndex,
        }))
      : (batch.prompts || []).map((item, promptIndex) => ({
          ...item,
          promptIndex,
          state: "QUEUED",
        }));
    let latestRun = snapshot?.run || null;
    for (const manual of batch.manualRuns || []) {
      const child = await store.getRun(manual.runId);
      const linked =
        batch.source === "mcp_direct"
          ? child?.run?.mcpParentRunId === batch.id &&
            String(child.run.userId) === String(scope.userId)
          : child?.run?.scope === batch.scope &&
            (source === "web_run"
              ? child.run.parentRunId === batch.id
              : child.run.batchId === batch.id);
      if (!linked || child.run.provider !== provider) continue;
      latestRun = child.run;
      for (const item of child.items) {
        const target = display.find(
          (row) =>
            row.promptIndex === manual.originalIndexes?.[item.promptIndex],
        );
        if (!target || item.hidden) continue;
        Object.assign(target, {
          state: item.state,
          resultReceipts: item.resultReceipts,
          error: item.error,
          downloadState: item.downloadState,
          retryPending: item.retryPending,
          retryActive: child.leaseActive === true,
          retrySubmitCount: item.retrySubmitCount,
          manualRunId: child.run.id,
          resultRunId: child.run.id,
          resultPromptIndex: item.promptIndex,
        });
      }
    }
    this._assertSavedResultScope(scope);
    const items = display.map((item) => ({
      prompt_index: item.promptIndex,
      prompt: item.displayPrompt || item.prompt || item.text || "",
      hidden: item.hidden === true,
      status: item.state,
      quantity: item.quantity || 1,
      settings_override: this._savedWebPresentationSettings(
        item.displaySettingsOverride || item.settingsOverride || {},
      ),
      result_count: (item.resultReceipts || []).filter(
        (receipt) => receipt.identity,
      ).length,
      results: (item.resultReceipts || []).flatMap((receipt, resultIndex) =>
        receipt.identity && !item.hidden
          ? [
              {
                source: "web_run",
                id: item.resultRunId,
                provider,
                prompt_index: item.resultPromptIndex,
                result_index: resultIndex,
                identity: receipt.identity,
                media_type: receipt.mediaType || "image",
              },
            ]
          : [],
      ),
      download_status: item.downloadState || null,
      retry_pending: item.retryPending === true,
      retry_active: item.retryPending === true && item.retryActive === true,
      error: item.error || null,
    }));
    const visible = items.filter((item) => !item.hidden);
    const summary = {
      completed: visible.filter((item) => item.status === "COMPLETED").length,
      failed: visible.filter((item) =>
        ["FAILED", "PARTIAL_FAIL", "CANCELLED", "NEEDS_REVIEW"].includes(
          item.status,
        ),
      ).length,
      pending: visible.filter((item) => item.status === "QUEUED").length,
      other: 0,
    };
    summary.other =
      visible.length - summary.completed - summary.failed - summary.pending;
    return {
      data: {
        batch: {
          source,
          id,
          provider,
          name: batch.displayName || batch.batchName || null,
          status: latestRun?.status || batch.status,
          display_status: this._savedBatchDisplayStatus(
            items,
            latestRun?.status || batch.status,
            window.ProviderWebScheduler?.getRunControlState?.(latestRun?.id)
              ?.paused === true,
          ),
          settings: this._savedWebPresentationSettings(
            snapshot?.run.displaySettingsSnapshot ||
              snapshot?.run.settingsSnapshot ||
              batch.settingsSnapshot,
          ),
          revision: batch.revision,
          run_id: latestRun?.id || null,
          project_id: batch.projectId || null,
          root_run_id: snapshot?.run?.id || null,
          run_revision: snapshot?.run?.revision || null,
          manual_run_id:
            latestRun?.id !== snapshot?.run?.id ? latestRun?.id : null,
          prompt_count: visible.length,
          summary,
          items,
        },
      },
    };
  }
  static async _executeManageSavedWebBatch(args, jobId) {
    const { provider, batch_source: source, operation } = args;
    if (
      !["chatgpt", "gemini", "muse"].includes(provider) ||
      !["web_batch", "web_run"].includes(source) ||
      !["edit", "rerun", "resume", "stop"].includes(operation) ||
      !Number.isInteger(args.expected_revision)
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Provide Web batch source, operation and current revision.",
      );
    const scope = this._savedResultScope();
    const store = window.ProviderWebQueueStore;
    const rows =
      source === "web_run"
        ? await this._savedWebRuns(scope, provider)
        : await store.listBatches(scope.userId, scope.projectId);
    const batch = rows.find(
      (row) => row.id === args.batch_id && row.provider === provider,
    );
    if (
      !batch ||
      (source === "web_run" &&
        !["mcp_direct", "gentab_direct"].includes(batch.source))
    )
      throw this._err(
        "SAVED_BATCH_NOT_FOUND",
        "Choose the original batch/run in the current project/runner.",
      );
    const key = `mcp_saved_web_action:${scope.userId}:${jobId}`;
    if (["rerun", "resume"].includes(operation)) {
      const prior = (await chrome.storage.local.get(key))?.[key];
      if (prior?.batchId === batch.id && prior.runId) {
        const existing = (await store.getRun(prior.runId))?.run;
        if (
          existing &&
          String(existing.userId) === String(scope.userId) &&
          existing.provider === provider &&
          (existing.parentRunId === batch.id || existing.batchId === batch.id)
        ) {
          return {
            data: {
              accepted: true,
              idempotent: true,
              batch_id: batch.id,
              run_id: existing.id,
              status: existing.status,
              note: "Existing take retained. Read get_saved_batch; explicitly resume a queued take instead of rerunning it.",
            },
          };
        }
        if (prior.status === "accepted")
          throw this._err(
            "SAVED_BATCH_RUN_MISSING",
            "Accepted take is no longer in this browser; do not regenerate automatically.",
          );
      }
    }
    if (batch.revision !== args.expected_revision)
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Read get_saved_batch again before editing/rerunning.",
      );
    if (operation === "stop") {
      const manual = batch.manualRuns?.find(
        (entry) => entry.runId === args.run_id,
      );
      const child = manual && (await store.getRun(manual.runId))?.run;
      if (
        !child ||
        String(child.userId) !== String(scope.userId) ||
        child.provider !== provider ||
        child.projectId !== scope.projectId ||
        !["QUEUED", "RUNNING"].includes(child.status) ||
        !(child.parentRunId === batch.id || child.batchId === batch.id)
      )
        throw this._err(
          "SAVED_BATCH_STOP_UNAVAILABLE",
          "Choose the exact active/queued linked take in this project.",
        );
      this._assertSavedResultScope(scope);
      await window.ProviderWebScheduler.stop(child.id, "MCP_BATCH_STOP");
      return {
        data: {
          stop_requested: true,
          run_id: child.id,
          note: "Stop request accepted; read get_saved_batch to verify the final state.",
        },
      };
    }
    const snapshot =
      batch.runId && source === "web_batch"
        ? await store.getRun(batch.runId)
        : source === "web_run"
          ? await store.getRun(batch.id)
          : null;
    const index = args.prompt_index;
    if (
      index != null &&
      (!Number.isInteger(index) ||
        index < 0 ||
        (snapshot &&
          !snapshot.items.some(
            (item) => item.promptIndex === index && !item.hidden,
          )) ||
        (!snapshot && !batch.prompts?.[index]))
    )
      throw this._err("VALIDATION_ERROR", "Prompt slot is missing or hidden.");
    const modal = window.genBatchListModal;
    if (!modal || modal._editor || modal._busy || modal.webView?.editing)
      throw this._err(
        "BATCH_EDITOR_BUSY",
        "Finish the current Batch List edit first.",
      );
    if (operation === "edit") {
      const text = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (index == null || !text || text.length > 1e4)
        throw this._err("VALIDATION_ERROR", "Provide prompt_index and prompt.");
      this._assertSavedResultScope(scope);
      if (batch.source === "mcp_direct") {
        await store.editMcpDisplay(
          scope.userId,
          batch.id,
          args.expected_revision,
          { promptUpdates: [{ promptIndex: index, text }] },
        );
      } else if (!snapshot && batch.status === "QUEUED") {
        await store.editBatch(
          scope.userId,
          scope.projectId,
          batch.id,
          args.expected_revision,
          {
            settingsSnapshot: batch.settingsSnapshot,
            prompts: batch.prompts.map((item, i) =>
              i === index ? { ...item, text } : item,
            ),
          },
        );
      } else {
        const runRevision =
          source === "web_run"
            ? args.expected_revision
            : args.expected_run_revision;
        if (
          !Number.isInteger(runRevision) ||
          snapshot?.run.revision !== runRevision
        )
          throw this._err(
            "SAVED_BATCH_REVISION_CONFLICT",
            "Provide root run_revision from get_saved_batch for a settled Web batch edit.",
          );
        const item = snapshot.items.find(
          (item2) => item2.promptIndex === index,
        );
        await store.editRunPresentation(
          scope.userId,
          snapshot.run.id,
          runRevision,
          {
            projectId: scope.projectId,
            source: snapshot.run.source,
            promptUpdates: [
              {
                promptIndex: index,
                text,
                refKeys: item.displayRefKeys || item.refKeys || [],
                settingsOverride:
                  item.displaySettingsOverride || item.settingsOverride || {},
              },
            ],
          },
        );
      }
      await modal.reload?.();
      return {
        data: {
          saved: true,
          batch_id: batch.id,
          prompt_index: index,
          note: "Updated Batch List prompt for the next take; original receipts/history remain intact.",
        },
      };
    }
    if (args.confirm !== true)
      throw this._err("VALIDATION_ERROR", "Generation requires confirm:true.");
    const session =
      window[
        provider === "muse"
          ? "MuseSession"
          : provider === "chatgpt"
            ? "ChatGPTSession"
            : "GeminiSession"
      ];
    const ready =
      provider === "muse" && window.MuseApiBatchRunner?.applies(batch)
        ? await window.MuseApiBatchRunner.readiness([batch])
        : provider === "muse"
          ? await session?.ensureReady({
              createIfMissing: true,
              activate: true,
              waitForComposer: true,
              silent: true,
            })
          : await session?.ensureReady({
              createIfMissing: true,
              activate: true,
              forceCheck: true,
              waitForEditorMs: 12e3,
              silent: true,
            });
    if (!ready?.ready)
      throw this._err(
        "PROVIDER_SESSION_NOT_READY",
        ready?.error || "Provider session is unavailable.",
      );
    this._assertSavedResultScope(scope);
    if ((await modal.open(provider)) !== true)
      throw this._err(
        "BATCH_LIST_UNAVAILABLE",
        "Could not open Web Batch List.",
      );
    this._assertSavedResultScope(scope);
    const view = modal.webView,
      current = view?.batches.find((row) => row.id === batch.id);
    if (!current || current.revision !== args.expected_revision || view.editing)
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Batch changed while opening; read it again.",
      );
    let acceptedId = null,
      resolveAccepted;
    const accepted = new Promise((resolve) => {
      resolveAccepted = resolve;
    });
    const accept = async (runId) => {
      acceptedId = runId;
      this._currentSavedBatchRun = {
        runId,
        userId: scope.userId,
        projectId: scope.projectId,
      };
      await chrome.storage.local.set({
        [key]: { batchId: batch.id, runId, status: "accepted" },
      });
      if (this._cancelRequested)
        await window.ProviderWebScheduler.stop(runId, "MCP_CANCEL");
      resolveAccepted({ runId });
    };
    try {
      const execution = (async () => {
        if (operation === "resume") {
          const manual = current.manualRuns?.at(-1);
          const child2 = manual?.runId && (await store.getRun(manual.runId));
          if (
            !child2 ||
            child2.run.status !== "QUEUED" ||
            window.ProviderWebScheduler.getRunControlState?.(child2.run.id)
              ?.active === true ||
            child2.run.provider !== provider ||
            child2.run.projectId !== scope.projectId ||
            String(child2.run.userId) !== String(scope.userId) ||
            !(
              child2.run.parentRunId === current.id ||
              child2.run.batchId === current.id
            )
          )
            throw this._err(
              "SAVED_BATCH_RESUME_UNAVAILABLE",
              "Only the linked queued take in this project can resume.",
            );
          const ready2 =
            provider === "muse" &&
            window.MuseApiBatchRunner?.applies(child2.run)
              ? await window.MuseApiBatchRunner.readiness([child2.run])
              : await view._probeReady(provider);
          if (!ready2.ready)
            throw this._err(
              "PROVIDER_SESSION_NOT_READY",
              ready2.error || "Provider is not ready.",
            );
          this._assertSavedResultScope(scope);
          view.running.add(current.id);
          try {
            await accept(child2.run.id);
            await modal.reload();
            await window.ProviderWebScheduler.run(child2.run.id);
          } finally {
            window.ProviderWebScheduler.forgetStop(child2.run.id);
            view.running.delete(current.id);
            await modal.reload();
          }
        } else {
          if (this._cancelRequested)
            throw this._err("CANCELLED", "Batch rerun cancelled.");
          const runId = crypto.randomUUID();
          await chrome.storage.local.set({
            [key]: { batchId: batch.id, runId, status: "preparing" },
          });
          const options = {
            skipConfirm: true,
            expectedRevision: args.expected_revision,
            runId,
            onAccepted: accept,
            failedPendingOnly: args.failed_pending_only === true,
          };
          if (current.source === "mcp_direct")
            await view._mcpRerun(current, {
              ...options,
              promptIndex: index ?? null,
            });
          else
            await view._regen(current, index ?? null, {
              ...options,
              fullBatchRerun:
                index == null && args.failed_pending_only !== true,
            });
        }
      })();
      execution.catch((error) =>
        console.warn(
          "[MCP] saved_web_run_failed",
          JSON.stringify({
            runId: acceptedId,
            stage: "scheduler",
            code:
              error?.code ||
              (/^[A-Z][A-Z0-9_]{2,100}$/.test(error?.message || "")
                ? error.message
                : "SCHEDULER_ERROR"),
          }),
        ),
      );
      await Promise.race([accepted, execution]);
      const child = acceptedId && (await store.getRun(acceptedId))?.run;
      return {
        data: {
          accepted: !!acceptedId,
          batch_id: batch.id,
          run_id: acceptedId,
          status: child?.status || null,
          note: "Read get_saved_batch for per-prompt status and exact take selectors.",
        },
      };
    } finally {
      this._currentSavedBatchRun = null;
    }
  }
  static async _executeEditSavedFlowPrompt(args = {}) {
    const { scope, batch } = await this._savedFlowBatch(args);
    const index = Number(args.prompt_index);
    const revision = Number(args.expected_revision);
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= batch.items.length ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      !prompt ||
      prompt.length > 1e4
    )
      throw this._err(
        "VALIDATION_ERROR",
        "C\u1EA7n prompt, prompt_index v\xE0 revision h\u1EE3p l\u1EC7.",
      );
    if (batch.revision !== revision)
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Batch \u0111\xE3 thay \u0111\u1ED5i; \u0111\u1ECDc l\u1EA1i get_saved_batch.",
      );
    if (batch.items[index]?.hidden)
      throw this._err("BATCH_EDIT_UNAVAILABLE", "Prompt \u0111\xE3 \u1EA9n.");
    const modal = window.genBatchListModal;
    if (!modal || modal._editor || modal._busy)
      throw this._err(
        "BATCH_EDITOR_BUSY",
        "Batch List \u0111ang \u0111\u01B0\u1EE3c ch\u1EC9nh s\u1EEDa.",
      );
    if ((await modal.open("flow")) !== true)
      throw this._err(
        "BATCH_LIST_UNAVAILABLE",
        "Kh\xF4ng m\u1EDF \u0111\u01B0\u1EE3c Batch List.",
      );
    this._assertSavedResultScope(scope);
    const latest = await window.GenBatchQueueStore.get(
      scope.userId,
      scope.projectId,
      batch.batchId,
    );
    if (!latest || latest.revision !== revision)
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Batch \u0111\xE3 thay \u0111\u1ED5i; \u0111\u1ECDc l\u1EA1i get_saved_batch.",
      );
    if (modal._editor || modal._busy)
      throw this._err(
        "BATCH_EDITOR_BUSY",
        "Batch List \u0111ang \u0111\u01B0\u1EE3c ch\u1EC9nh s\u1EEDa.",
      );
    try {
      modal._editItem(null, latest, { dataset: { itemIndex: String(index) } });
      const editor = modal._editor;
      if (!editor || editor.batchId !== batch.batchId || editor.index !== index)
        throw this._err(
          "BATCH_EDIT_UNAVAILABLE",
          "Prompt \u0111ang x\u1EED l\xFD ho\u1EB7c kh\xF4ng th\u1EC3 ch\u1EC9nh s\u1EEDa.",
        );
      const input = modal.overlay?.querySelector(
        '.gen-batch-editor textarea[name="prompt"]',
      );
      if (!input)
        throw this._err(
          "BATCH_EDITOR_UNAVAILABLE",
          "Kh\xF4ng t\xECm th\u1EA5y tr\xECnh ch\u1EC9nh s\u1EEDa prompt.",
        );
      input.value = prompt;
      await modal._saveEditor();
      const saved = await window.GenBatchQueueStore.get(
        scope.userId,
        scope.projectId,
        batch.batchId,
      );
      if (
        !saved ||
        saved.items?.[index]?.prompt !== prompt ||
        saved.revision <= revision
      )
        throw this._err(
          "BATCH_EDIT_NOT_CONFIRMED",
          "Ch\u01B0a x\xE1c nh\u1EADn \u0111\u01B0\u1EE3c prompt \u0111\xE3 l\u01B0u.",
        );
      return {
        data: {
          batch_id: saved.batchId,
          prompt_index: index,
          revision: saved.revision,
          saved: true,
        },
      };
    } finally {
      if (
        modal._editor?.batchId === batch.batchId &&
        modal._editor?.index === index
      )
        modal._closeEditor();
    }
  }
  static async _preflightSavedFlowRerun(scope, batch) {
    const modal = window.genBatchListModal;
    if (!modal?.scheduler || !window.PromptQueue?.isEnabled?.())
      throw this._err(
        "BATCH_ADMISSION_UNAVAILABLE",
        "Batch runner ho\u1EB7c Prompt Queue ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    const activation = await chrome.runtime.sendMessage({
      action: "ensureFlowTabActive",
      focusWindow: true,
    });
    if (
      activation?.ok !== true ||
      String(activation.projectId || "") !== String(scope.projectId)
    )
      throw this._err(
        "PROJECT_NOT_READY",
        "Flow tab ch\u01B0a m\u1EDF \u0111\xFAng project c\u1EE7a batch.",
      );
    const readiness = await chrome.runtime.sendMessage({
      action: "checkFlowTabOpen",
      passive: false,
      readOnly: false,
      readinessScope: "project",
      targetTabId: activation.tabId,
    });
    if (
      (readiness?.ready ?? readiness?.isOpen) !== true ||
      (readiness?.projectId &&
        String(readiness.projectId) !== String(scope.projectId))
    )
      throw this._err(
        "PROVIDER_NOT_READY",
        "Flow tab ch\u01B0a s\u1EB5n s\xE0ng \u0111\u1EC3 ch\u1EA1y batch.",
      );
    const route = modal._currentRunRoute();
    if (!["web", "api", "auto"].includes(route))
      throw this._err(
        "BATCH_ROUTE_UNAVAILABLE",
        "Ch\u1EBF \u0111\u1ED9 ch\u1EA1y Flow kh\xF4ng h\u1EE3p l\u1EC7.",
      );
    const apiIntended =
      window.FlowApiAdapter?.isApiModeIntended?.({ executionMode: route }) ===
      true;
    if (route === "api" && !apiIntended)
      throw this._err(
        "PROVIDER_NOT_READY",
        "Flow API bridge ch\u01B0a s\u1EB5n s\xE0ng.",
      );
    let effectiveRoute = route === "auto" ? "web" : route;
    if (apiIntended && ["api", "auto"].includes(route)) {
      const mediaType =
        String(batch.settingsSnapshot?.genType || "").toLowerCase() === "video"
          ? "video"
          : "image";
      const api = await window.FlowApiSessionCoordinator?.check?.({
        surface: "gen",
        mediaType,
        force: true,
        passive: true,
      });
      if (route === "api" && api?.ready !== true)
        throw this._err(
          "PROVIDER_NOT_READY",
          "Flow API bridge ch\u01B0a s\u1EB5n s\xE0ng.",
        );
      if (route === "auto" && api?.ready === true) effectiveRoute = "auto";
    }
    this._assertSavedResultScope(scope);
    return { modal, effectiveRoute };
  }
  static async _executeRerunSavedFlow(args = {}, jobId, fullBatch = false) {
    const markerKey = `toby_mcp_saved_rerun_${jobId}`;
    const { scope, batch } = await this._savedFlowBatch(args);
    const prior = (await chrome.storage.local.get(markerKey))?.[markerKey];
    if (
      prior &&
      (prior.userId !== String(scope.userId) || prior.batchId !== batch.batchId)
    )
      throw this._err(
        "BATCH_REGEN_REVIEW_REQUIRED",
        "L\u1EC7nh ch\u1EA1y l\u1EA1i kh\xF4ng kh\u1EDBp ch\u1EE7 s\u1EDF h\u1EEFu ho\u1EB7c batch.",
      );
    if (prior?.status === "accepted") return { data: prior.data };
    if (prior?.status === "persisted" && prior.takeBatchId) {
      const take = await window.GenBatchQueueStore.get(
        scope.userId,
        scope.projectId,
        prior.takeBatchId,
      );
      this._assertSavedResultScope(scope);
      if (!take)
        throw this._err(
          "BATCH_REGEN_REVIEW_REQUIRED",
          "The queued take is no longer in this browser. Do not regenerate automatically.",
        );
      return {
        data: {
          accepted: true,
          batch_id: take.batchId,
          source_batch_id: batch.batchId,
          queued: take.status === "queued",
          status: take.status,
          idempotent: true,
          note: "Existing persisted take retained. Read get_saved_batch before resuming it.",
        },
      };
    }
    if (prior?.status === "dispatching")
      throw this._err(
        "BATCH_REGEN_REVIEW_REQUIRED",
        "L\u1EC7nh ch\u1EA1y l\u1EA1i tr\u01B0\u1EDBc \u0111\xF3 ch\u01B0a x\xE1c nh\u1EADn; ki\u1EC3m tra Batch List tr\u01B0\u1EDBc khi th\u1EED l\u1EC7nh m\u1EDBi.",
      );
    const revision = Number(args.expected_revision);
    const index = Number(args.prompt_index);
    if (
      !Number.isInteger(revision) ||
      revision < 1 ||
      args.confirm !== true ||
      (!fullBatch &&
        (!Number.isInteger(index) || index < 0 || index >= batch.items.length))
    )
      throw this._err(
        "VALIDATION_ERROR",
        "C\u1EA7n revision hi\u1EC7n t\u1EA1i, confirm:true v\xE0 prompt_index h\u1EE3p l\u1EC7.",
      );
    if (batch.revision !== revision)
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Batch \u0111\xE3 thay \u0111\u1ED5i; \u0111\u1ECDc l\u1EA1i get_saved_batch.",
      );
    if (!fullBatch && batch.items[index]?.hidden)
      throw this._err(
        "BATCH_RERUN_UNAVAILABLE",
        "Batch/prompt ch\u01B0a \u1EDF tr\u1EA1ng th\xE1i c\xF3 th\u1EC3 ch\u1EA1y l\u1EA1i.",
      );
    const batchModal = window.genBatchListModal;
    if (
      typeof batchModal?.open !== "function" ||
      (await batchModal.open("flow")) !== true
    )
      throw this._err(
        "BATCH_LIST_UNAVAILABLE",
        "Kh\xF4ng th\u1EC3 m\u1EDF Batch List tr\u01B0\u1EDBc khi ch\u1EA1y l\u1EA1i Flow batch.",
      );
    this._assertSavedResultScope(scope);
    const { modal, effectiveRoute } = await this._preflightSavedFlowRerun(
      scope,
      batch,
    );
    const latest = await window.GenBatchQueueStore.get(
      scope.userId,
      scope.projectId,
      batch.batchId,
    );
    if (
      !latest ||
      latest.revision !== revision ||
      latest.status !== batch.status
    )
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Batch \u0111\xE3 thay \u0111\u1ED5i tr\u01B0\u1EDBc khi ch\u1EA1y l\u1EA1i.",
      );
    this._assertSavedResultScope(scope);
    await chrome.storage.local.set({
      [markerKey]: {
        status: "dispatching",
        userId: String(scope.userId),
        batchId: latest.batchId,
        at: Date.now(),
      },
    });
    let dispatched = false;
    const onPersisted = async ({ batchId }) => {
      dispatched = true;
      await chrome.storage.local.set({
        [markerKey]: {
          status: "persisted",
          takeBatchId: batchId,
          userId: String(scope.userId),
          batchId: latest.batchId,
          at: Date.now(),
        },
      });
    };
    try {
      let data;
      if (fullBatch) {
        const take = await modal._rerunSavedBatch(latest, {
          skipConfirmation: true,
          returnAfterStart: true,
          effectiveRoute,
          mcpOrigin: true,
          mcpJobId: jobId,
          onPersisted,
        });
        if (!take?.batchId)
          throw this._err(
            "BATCH_REGEN_REJECTED",
            "Batch ch\u01B0a \u0111\u01B0\u1EE3c nh\u1EADn v\xE0o h\xE0ng ch\u1EDD.",
          );
        modal._scrollToActiveBatch?.();
        dispatched = true;
        data = {
          accepted: true,
          batch_id: take.batchId,
          source_batch_id: latest.batchId,
          queued: take.queued === true,
          status: take.started ? "started" : "queued",
          note: "\u0110\u1ECDc l\u1EA1i get_saved_batch \u0111\u1EC3 theo d\xF5i k\u1EBFt qu\u1EA3 t\u1EEBng prompt.",
        };
      } else {
        let resolveAdmission;
        const admission = new Promise((resolve) => {
          resolveAdmission = resolve;
        });
        const accepted = await modal._regenItem(
          latest,
          { dataset: { itemIndex: String(index) } },
          {
            skipConfirmation: true,
            effectiveRoute,
            onPersisted,
            onAdmission: (ack2) => {
              if (ack2?.ok) dispatched = true;
              resolveAdmission(ack2);
            },
            onFinalSettled: (settlement) =>
              this._saveSavedFlowPromptRerunHistory(
                latest,
                index,
                jobId,
                settlement,
              ).catch((error) =>
                console.warn(
                  "[McpExecutor] Saved Flow prompt history:",
                  error?.message || error,
                ),
              ),
          },
        );
        if (!accepted)
          throw this._err(
            "BATCH_REGEN_REJECTED",
            "Prompt ch\u01B0a \u0111\u01B0\u1EE3c nh\u1EADn v\xE0o h\xE0ng ch\u1EDD.",
          );
        const ack = await Promise.race([
          admission,
          new Promise((resolve) =>
            setTimeout(
              () => resolve({ ok: false, error: "BATCH_ADMISSION_TIMEOUT" }),
              3e4,
            ),
          ),
        ]);
        if (ack?.ok !== true)
          throw this._err(
            ack?.error || "BATCH_REGEN_REJECTED",
            "Prompt ch\u01B0a \u0111\u01B0\u1EE3c nh\u1EADn v\xE0o h\xE0ng ch\u1EDD.",
          );
        dispatched = true;
        data = {
          accepted: true,
          batch_id: ack.batchId || latest.batchId,
          prompt_index: index,
          ...(ack.batchId ? { source_batch_id: latest.batchId } : {}),
          queued: ack.queued === true,
          status: "admitted",
          note: "\u0110\u1ECDc l\u1EA1i get_saved_batch \u0111\u1EC3 theo d\xF5i k\u1EBFt qu\u1EA3 prompt.",
        };
      }
      await chrome.storage.local.set({
        [markerKey]: {
          status: "accepted",
          data,
          userId: String(scope.userId),
          batchId: latest.batchId,
          at: Date.now(),
        },
      });
      return { data };
    } catch (error) {
      if (!dispatched) await chrome.storage.local.remove(markerKey);
      throw error;
    }
  }
  static async _saveSavedFlowPromptRerunHistory(
    batch,
    index,
    jobId,
    settlement,
  ) {
    if (settlement?.ok !== true) return;
    const item = batch.items?.[index];
    if (!item) return;
    const result = settlement.result || {};
    const settings = {
      ...(batch.settingsSnapshot || {}),
      ...(item.settingsOverride || {}),
    };
    const isVideo = String(settings.genType || "").toLowerCase() === "video";
    const thumbs = this._collectThumbs(result.resultThumbnails);
    const resultFileIds = result.resultTileIds || [];
    const failedPrompts = result.failedPrompts || [];
    const hasResult = resultFileIds.length > 0 || thumbs.length > 0;
    const refFileIds = item.refKeys || [];
    const refThumbnails = Object.fromEntries(
      (batch.refPool || [])
        .filter((ref) => refFileIds.includes(ref.refKey) && ref.thumbnail)
        .map((ref) => [
          ref.refKey,
          { thumbnail: ref.thumbnail, type: ref.mediaType || "image" },
        ]),
    );
    await this._saveGenHistory({
      promptList: [item.prompt],
      mediaType: isVideo ? "video" : "image",
      model: this._historyModel("flow", settings.model, isVideo),
      ratio: settings.ratio,
      quantity: Number(settings.quantity) || 1,
      refFileIds,
      refThumbnails,
      thumbs,
      resultFileIds,
      provider: "flow",
      sourceId: jobId,
      status: result.stopped
        ? "stopped"
        : !hasResult
          ? "failed"
          : failedPrompts.length
            ? "partial"
            : "success",
      stopOrigin: result.stopOrigin || null,
      errorReason: failedPrompts[0]?.error || settlement.error || null,
      failedPrompts,
      errorDetails: result.errorDetails || [],
      flowApiVersions: result.flowApiVersions || [],
      historyRoute: result.historyRoute || null,
      durationMs: result.durationMs,
    });
  }
  static async _executeRenameSavedBatch(args = {}) {
    const scope = this._savedResultScope();
    const source = args?.batch_source;
    const id = String(args?.batch_id || "").trim();
    const name = String(args?.name || "").trim();
    const revision = args?.expected_revision;
    if (
      !["flow_batch", "web_batch"].includes(source) ||
      !id ||
      !name ||
      name.length > 120 ||
      !Number.isInteger(revision) ||
      revision < 1
    )
      throw this._err(
        "VALIDATION_ERROR",
        "C\u1EA7n source, batch ID, revision v\xE0 t\xEAn m\u1EDBi h\u1EE3p l\u1EC7.",
      );
    const store =
      source === "flow_batch"
        ? window.GenBatchQueueStore
        : window.ProviderWebQueueStore;
    const batch =
      source === "flow_batch"
        ? await store.get(scope.userId, scope.projectId, id)
        : (await store.listBatches(scope.userId, scope.projectId)).find(
            (entry) => entry.id === id,
          );
    if (!batch || batch.revision !== revision)
      throw this._err(
        "SAVED_BATCH_REVISION_CONFLICT",
        "Batch \u0111\xE3 \u0111\u1ED5i ho\u1EB7c kh\xF4ng thu\u1ED9c project hi\u1EC7n t\u1EA1i.",
      );
    this._assertSavedResultScope(scope);
    await store.rename(scope.userId, scope.projectId, id, revision, name);
    try {
      await window.genBatchListModal?.reload?.();
    } catch (error) {
      console.warn(
        "[McpExecutor] Batch List refresh after rename failed:",
        error?.message || error,
      );
    }
    return { data: { source, id, name, revision: revision + 1 } };
  }
  static async _executeDeleteSavedBatch(args = {}) {
    const scope = this._savedResultScope();
    const source = args?.batch_source;
    const id = String(args?.batch_id || "").trim();
    const revision = args?.expected_revision;
    if (
      !["flow_batch", "web_batch"].includes(source) ||
      !id ||
      !Number.isInteger(revision) ||
      revision < 1 ||
      args?.confirm !== true
    )
      throw this._err(
        "VALIDATION_ERROR",
        "C\u1EA7n x\xE1c nh\u1EADn x\xF3a v\xE0 revision t\u1EEB list_saved_batches.",
      );
    if (source === "web_batch") {
      const batch = (
        await window.ProviderWebQueueStore.listBatches(
          scope.userId,
          scope.projectId,
        )
      ).find((entry) => entry.id === id);
      if (!batch || batch.revision !== revision)
        throw this._err(
          "SAVED_BATCH_REVISION_CONFLICT",
          "Batch \u0111\xE3 \u0111\u1ED5i ho\u1EB7c kh\xF4ng thu\u1ED9c project hi\u1EC7n t\u1EA1i.",
        );
      this._assertSavedResultScope(scope);
      await window.ProviderWebQueueStore.deleteBatch(
        scope.userId,
        scope.projectId,
        id,
        revision,
      );
    } else {
      const store = window.GenBatchQueueStore;
      const batch = await store.get(scope.userId, scope.projectId, id);
      if (!batch || batch.revision !== revision)
        throw this._err(
          "SAVED_BATCH_REVISION_CONFLICT",
          "Batch \u0111\xE3 \u0111\u1ED5i ho\u1EB7c kh\xF4ng thu\u1ED9c project hi\u1EC7n t\u1EA1i.",
        );
      this._assertSavedResultScope(scope);
      if (
        store.isPossiblyLive(batch) ||
        window.genBatchListModal?.scheduler?.activeBatchId === id
      )
        throw this._err(
          "BATCH_LIVE_DELETE_BLOCKED",
          "Batch \u0111ang ch\u1EA1y ho\u1EB7c c\u1EA7n x\u1EED l\xFD, kh\xF4ng th\u1EC3 x\xF3a.",
        );
      if (
        !["queued", "needs_review", "completed", "stopped", "failed"].includes(
          batch.status,
        )
      )
        throw this._err(
          "BATCH_LIVE_DELETE_BLOCKED",
          "Tr\u1EA1ng th\xE1i batch kh\xF4ng cho ph\xE9p x\xF3a.",
        );
      const segments = window.genBatchListModal?._historySegments?.(batch) || [
        ...(batch.executionSegments || []),
        ...(batch.jobId && batch.trackerSessionId
          ? [{ jobId: batch.jobId, trackerSessionId: batch.trackerSessionId }]
          : []),
      ];
      const queue = window.PromptQueue?.getInstance?.();
      for (const itemId of batch.jobId ? batch.runtimeItemIds || [] : []) {
        if (
          itemId &&
          queue?.removeTrackerItem?.(scope.projectId, batch.jobId, itemId) !==
            true
        )
          throw this._err(
            "BATCH_RUNTIME_HISTORY_CLEAR_FAILED",
            "Kh\xF4ng th\u1EC3 x\xF3a prompt kh\u1ECFi tracker Flow \u0111ang ch\u1EA1y.",
          );
      }
      for (const segment of segments) {
        this._assertSavedResultScope(scope);
        const ack = await chrome.runtime.sendMessage({
          action: "ft:removeHistoryJob",
          projectId: scope.projectId,
          sessionId: segment.trackerSessionId,
          jobId: segment.jobId,
          allSessions: batch.batchId.startsWith("history:"),
        });
        if (!ack?.ok)
          throw this._err(
            "SAVED_BATCH_HISTORY_DELETE_FAILED",
            ack?.error ||
              "Kh\xF4ng th\u1EC3 x\xF3a l\u1ECBch s\u1EED Flow c\u1EE7a batch.",
          );
      }
      await store.deleteBatch(
        scope.userId,
        scope.projectId,
        id,
        ["queued", "needs_review", "completed", "stopped", "failed"],
        revision,
      );
    }
    this._assertSavedResultScope(scope);
    try {
      await window.genBatchListModal?.reload?.();
    } catch (error) {
      console.warn(
        "[McpExecutor] Batch List refresh after delete failed:",
        error?.message || error,
      );
    }
    return { data: { source, id, deleted: true } };
  }
  static async _preflightProviders(providers, { nodes = [], edges = [] } = {}) {
    const order = { chatgpt: 0, grok: 1, gemini: 2, muse: 3, flow: 4 };
    const sorted = [...new Set(providers || [])].sort(
      (a, b) => (order[a] ?? 9) - (order[b] ?? 9),
    );
    const notReady = [];
    for (const p of sorted) {
      if (p === "chatgpt") {
        const prepared = await window.ChatGPTSession?.prepareNewChat?.({
          createIfMissing: true,
        });
        const r = prepared?.ready
          ? await window.ChatGPTSession.ensureReady({
              createIfMissing: false,
              activate: true,
              focusWindow: true,
              forceCheck: true,
              waitForEditorMs: 12e3,
            })
          : prepared;
        if (!r?.ready)
          notReady.push({
            provider: "chatgpt",
            reason:
              r?.error === "NOT_LOGGED_IN"
                ? "not logged in"
                : r?.error || "provider runtime unavailable",
            login: r?.error === "NOT_LOGGED_IN",
          });
      } else if (p === "grok") {
        const r = await window.GrokSession?.ensureReady?.({
          createIfMissing: true,
          activate: true,
          focusWindow: true,
          forceCheck: true,
        });
        if (!r?.ready)
          notReady.push({
            provider: "grok",
            reason:
              r?.error === "NOT_LOGGED_IN"
                ? "not logged in"
                : r?.error || "provider runtime unavailable",
            login: r?.error === "NOT_LOGGED_IN",
          });
      } else if (p === "gemini") {
        const r = await window.GeminiSession?.ensureReady?.({
          createIfMissing: true,
          activate: true,
          focusWindow: true,
        });
        if (!r?.ready)
          notReady.push({
            provider: "gemini",
            reason:
              r?.error === "NOT_LOGGED_IN"
                ? "not logged in"
                : r?.error || "provider runtime unavailable",
            login: r?.error === "NOT_LOGGED_IN",
          });
      } else if (p === "muse") {
        const checkWeb = async () => {
          const web = await window.MuseSession?.ensureReady?.({
            createIfMissing: true,
            activate: true,
            silent: true,
          });
          return web?.error === "COMPOSER_NOT_READY" && web?.tabId
            ? { ...web, ready: true }
            : web;
        };
        const r = window.MuseApiFacade?.checkReadiness
          ? await window.MuseApiFacade.checkReadiness({
              entries: window.MuseApiFacade.nodeReadinessEntries(nodes, {
                edges,
              }),
              checkWeb,
              activateTab: true,
            })
          : await checkWeb();
        console.info(
          "[McpWorkflowPreflight]",
          JSON.stringify({
            provider: "muse",
            genMode: r?.genMode || "web",
            ready: r?.ready === true,
            error: /^[A-Z][A-Z0-9_]{1,90}$/.test(r?.error || "")
              ? r.error
              : null,
          }),
        );
        if (!r?.ready) {
          notReady.push({
            provider: "muse",
            reason:
              r?.error === "NOT_LOGGED_IN"
                ? "not logged in"
                : r?.error || "provider runtime unavailable",
            login: r?.error === "NOT_LOGGED_IN",
          });
        }
      } else if (p === "flow") {
        try {
          const context = await this._ensureFlowProjectContext({
            purpose: "workflow",
          });
          const reason = this._flowProjectReadinessError(context);
          if (reason) notReady.push({ provider: "flow", reason, login: false });
          else {
            try {
              await new Promise((res) =>
                chrome.runtime.sendMessage(
                  {
                    action: "activateFlowTabForExecution",
                    tabId: context.tabId,
                    focusWindow: true,
                  },
                  () => res(),
                ),
              );
            } catch (_) {}
          }
        } catch (error) {
          if (["CANCELLED", "PROJECT_MISMATCH"].includes(error.code))
            throw error;
          notReady.push({
            provider: "flow",
            reason: error.message,
            login: error.code === "PROVIDER_NOT_LOGGED_IN",
          });
        }
      }
    }
    if (notReady.length) {
      const list = notReady
        .map((x) => `${x.provider} (${x.reason})`)
        .join("; ");
      const allLogin = notReady.every((x) => x.login);
      throw this._err(
        allLogin ? "PROVIDER_NOT_LOGGED_IN" : "PROVIDER_TAB_NOT_READY",
        `${notReady.length} provider ch\u01B0a s\u1EB5n s\xE0ng: ${list}. Chu\u1EA9n b\u1ECB xong T\u1EA4T C\u1EA2 r\u1ED3i run_workflow l\u1EA1i.`,
      );
    }
  }
  static async _executeGetProviderStatus(args) {
    const supported = ["flow", "chatgpt", "grok", "gemini", "muse"];
    const requested = Array.isArray(args?.providers) ? args.providers : null;
    const want = args?.provider
      ? [args.provider]
      : requested
        ? requested.filter((provider) => supported.includes(provider))
        : supported;
    const providers = [];
    for (const p of want) {
      let ready = false,
        reason = "ok";
      let muse = null;
      const requiredFeatures =
        p === "flow" ? ["gen_enabled"] : [`${p}_enabled`, `${p}_mcp_enabled`];
      const flow =
        p === "flow"
          ? this._publicFlowState(
              await this._flowApiState(args?.media_type || "image"),
            )
          : null;
      const disabledFeature = window.featureGate?.canUse
        ? requiredFeatures.find(
            (key) => window.featureGate.canUse(key) === false,
          )
        : null;
      if (disabledFeature) {
        providers.push({
          provider: p,
          ready: false,
          reason: `feature_disabled:${disabledFeature}`,
          feature_enabled: false,
          ...(flow ? { flow } : {}),
        });
        continue;
      }
      try {
        if (p === "chatgpt") {
          const r = await window.ChatGPTSession?.ensureReady?.({
            createIfMissing: false,
            activate: false,
          });
          ready = !!r?.ready;
          reason = ready ? "ok" : r?.error || "not_ready";
        } else if (p === "grok") {
          const r = await window.GrokSession?.ensureReady?.({
            createIfMissing: false,
            activate: false,
          });
          ready = !!r?.ready;
          reason = ready ? "ok" : r?.error || "not_ready";
        } else if (p === "gemini") {
          const r = await window.GeminiSession?.ensureReady?.({
            createIfMissing: false,
            activate: false,
          });
          ready = !!r?.ready;
          reason = ready ? "ok" : r?.error || "not_ready";
        } else if (p === "muse") {
          const stored = await chrome.storage.local.get("af_settings");
          const mode = window.MuseApiFacade.effectiveMode({
            museGenMode: args?.muse_gen_mode ?? stored.af_settings?.museGenMode,
          });
          const r =
            mode === "api"
              ? await window.MuseApiFacade.ensureReady()
              : await window.MuseSession?.ensureReady?.({
                  createIfMissing: false,
                  activate: false,
                  silent: true,
                });
          muse = {
            gen_mode: mode,
            ...(mode === "api"
              ? {
                  media_types:
                    r?.policy?.media_types?.filter((type) =>
                      ["image", "video"].includes(type),
                    ) || [],
                  max_outputs: r?.policy?.quantity ?? null,
                  refs_supported: false,
                  isolated_session_required:
                    r?.policy?.isolated_session_required === true,
                  monitor_limits: {
                    image: window.ExecutionConfig.getQueueMaxMonitor(),
                    video: window.ExecutionConfig.getQueueVideoMaxMonitor(),
                  },
                }
              : {}),
          };
          ready = !!r?.ready;
          reason = ready ? "ok" : r?.error || "not_ready";
        } else if (p === "flow") {
          const context = await this._readFlowProjectContext();
          reason = this._flowProjectReadinessError(context) || "ok";
          ready = reason === "ok";
        } else {
          reason = "unknown_provider";
        }
      } catch (e) {
        reason = e?.message || "error";
      }
      providers.push({
        provider: p,
        ready,
        reason,
        feature_enabled: true,
        ...(flow ? { flow } : {}),
        ...(muse ? { muse } : {}),
      });
    }
    console.info("[McpExecutor] provider status:", providers);
    const mcpGeneration = {
      web_workers: {
        config_available: false,
        max_concurrent_workers: null,
        enabled_providers: [],
      },
      download: {
        settings_available: false,
        auto_download: null,
        folder: null,
      },
    };
    try {
      if (
        !window.ExecutionConfig?.getConfig ||
        !window.ExecutionConfig?.getProviderWebSurface
      )
        throw new Error("EXECUTION_CONFIG_UNAVAILABLE");
      await window.ExecutionConfig.getConfig(true);
      const enabledProviders = [];
      let maxConcurrentWorkers = 0;
      for (const provider of ["chatgpt", "muse", "gemini"]) {
        const surface = window.ExecutionConfig.getProviderWebSurface(
          "mcp_direct",
          provider,
        );
        if (surface.surfaceEnabled !== true) continue;
        if (
          window.featureGate?.canUse?.(`${provider}_enabled`) === false ||
          window.featureGate?.canUse?.(`${provider}_mcp_enabled`) === false
        )
          continue;
        enabledProviders.push(provider);
        maxConcurrentWorkers = surface.maxConcurrentWorkers;
      }
      mcpGeneration.web_workers = {
        config_available: true,
        max_concurrent_workers: maxConcurrentWorkers,
        enabled_providers: enabledProviders,
      };
    } catch (error) {
      console.warn(
        "[McpExecutor] MCP worker status unavailable:",
        error?.message || error,
      );
    }
    try {
      const download = await this._getMcpDownloadSettings();
      mcpGeneration.download = {
        settings_available: true,
        auto_download: download.autoDownload,
        folder: download.downloadFolder,
      };
    } catch (error) {
      console.warn(
        "[McpExecutor] MCP download status unavailable:",
        error?.message || error,
      );
    }
    return { data: { providers, mcp_generation: mcpGeneration } };
  }
  static async _executeGetCharacters() {
    if (!window.CharacterRegistry?.getRenderList) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "Character registry ch\u01B0a s\u1EB5n s\xE0ng. Reload extension r\u1ED3i th\u1EED l\u1EA1i.",
      );
    }
    let characters = [];
    try {
      characters = await window.CharacterRegistry.getRenderList();
    } catch (error) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `Kh\xF4ng \u0111\u1ECDc \u0111\u01B0\u1EE3c danh s\xE1ch character: ${error?.message || "unknown error"}`,
      );
    }
    return {
      data: {
        characters: (characters || []).map((item) => ({
          slug: item.slug,
          name: item.name || item.search_value || item.slug,
          search_value: item.search_value || item.name || null,
          thumbnail: item.thumbnail || item.thumbnail_url || null,
        })),
      },
    };
  }
  static async _executeDeleteChat(args) {
    const provider = args?.provider || "chatgpt";
    if (provider !== "chatgpt" && provider !== "muse") {
      throw this._err(
        "VALIDATION_ERROR",
        `delete_chat ch\u01B0a h\u1ED7 tr\u1EE3 provider "${provider}".`,
      );
    }
    const session =
      provider === "muse" ? window.MuseSession : window.ChatGPTSession;
    if (!session)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        `Ch\u01B0a m\u1EDF tab ${provider === "muse" ? "Muse" : "ChatGPT"}.`,
      );
    const ready = await session.ensureReady({
      createIfMissing: false,
      activate: true,
      focusWindow: true,
    });
    if (!ready?.ready)
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        `${provider === "muse" ? "Muse" : "ChatGPT"} is not ready to delete chat: ${ready?.error || "open the provider tab"}.`,
      );
    const r =
      provider === "muse"
        ? await session.deleteCurrentConversation()
        : await session.deleteLastMessage();
    if (!r?.success)
      throw this._err(
        "GEN_FAILED",
        `X\xF3a conversation th\u1EA5t b\u1EA1i${r?.error ? ": " + r.error : ""}.`,
      );
    return { data: { deleted: true, provider } };
  }
  static _workflowProviders(nodes = []) {
    const providers = new Set();
    for (const node of nodes) {
      if (node?.enabled === false) continue;
      const type = node?.node_type;
      if (type === "image" || type === "generate") providers.add("flow");
      else if (type === "chatgpt")
        providers.add(node.provider === "gemini" ? "gemini" : "chatgpt");
      else if (type === "grok") providers.add("grok");
      else if (type === "gemini") providers.add("gemini");
      else if (type === "muse") providers.add("muse");
      else if (
        type === "prompt" &&
        (node.use_ai === true || node.enhance === true)
      ) {
        providers.add(
          ["chatgpt", "grok", "gemini"].includes(node.provider)
            ? node.provider
            : "chatgpt",
        );
      }
    }
    return [...providers];
  }
  static async _workflowDataScope(wfId) {
    const userId = window.authManager?.getUser?.()?.id;
    if (!userId || !wfId)
      throw this._err(
        "VALIDATION_ERROR",
        "Workflow and authenticated user are required.",
      );
    const workflow = await window.storageManager.getWorkflow(wfId);
    const assertOwner = () => {
      if (String(window.authManager?.getUser?.()?.id) !== String(userId))
        throw this._err(
          "WORKFLOW_OWNER_CHANGED",
          "Workflow data owner changed.",
        );
      if (this._cancelRequested)
        throw this._err("CANCELLED", "Workflow data operation cancelled.");
    };
    assertOwner();
    if (
      !workflow ||
      String(workflow.wf_id) !== String(wfId) ||
      (workflow.user_id != null && String(workflow.user_id) !== String(userId))
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Workflow does not exist or is not accessible.",
      );
    return { workflow, userId, assertOwner };
  }
  static _workflowOutput(node, output = "result") {
    const prefix = { result: "result", frame: "result_frame", ref: "ref" }[
      output
    ];
    if (!prefix)
      throw this._err("VALIDATION_ERROR", "Unknown workflow output kind.");
    const rawIds = node[`${prefix}_file_ids`];
    return {
      ids: (Array.isArray(rawIds) ? rawIds : String(rawIds || "").split(","))
        .map((id) => String(id).trim())
        .filter(Boolean),
      thumbnails: node[`${prefix}_thumbnails`] || {},
      names: output === "frame" ? {} : node[`${prefix}_file_names`] || {},
      providers: output === "result" ? node.result_provider_urls || {} : {},
    };
  }
  static async _workflowRecord(scope, node, fileId, output) {
    const declared = this._workflowOutput(node, output);
    if (!declared.ids.includes(String(fileId)))
      throw this._err(
        "RESULT_MEDIA_UNAVAILABLE",
        "Selected file is no longer declared by this workflow node.",
      );
    const saved = await window.WorkflowResultMediaStore?.get(
      scope.workflow.wf_id,
      node.node_id,
      fileId,
    );
    scope.assertOwner();
    const raw = declared.thumbnails[fileId],
      info = typeof raw === "string" ? { thumbnail: raw } : raw || {};
    const rawProvenance = declared.providers[fileId];
    const provenance =
      typeof rawProvenance === "string"
        ? { url: rawProvenance }
        : rawProvenance || {};
    const type =
      /^video\//i.test(saved?.blob?.type || "") ||
      info.type === "video" ||
      provenance.media_type === "video" ||
      info.video_url ||
      info.videoUrl ||
      provenance.video_url
        ? "video"
        : "image";
    return {
      fileId,
      output,
      node,
      info,
      provenance,
      blob: saved?.blob?.size ? saved.blob : null,
      type,
      fileName: declared.names[fileId] || info.file_name || "",
      url:
        type === "video"
          ? info.video_url ||
            info.videoUrl ||
            provenance.video_url ||
            provenance.url ||
            info.url ||
            ""
          : provenance.url ||
            info.url ||
            info.thumbnail ||
            info.thumbnailUrl ||
            "",
      selector: {
        wf_id: scope.workflow.wf_id,
        node_id: node.node_id,
        file_id: fileId,
        output,
      },
    };
  }
  static async _executeWorkflowResults(args) {
    const scope = await this._workflowDataScope(args.wf_id);
    const requested = args.node_ids ? new Set(args.node_ids.map(String)) : null;
    const nodes = scope.workflow.nodes.filter(
      (node) => !requested || requested.has(String(node.node_id)),
    );
    if (requested && (!requested.size || nodes.length !== requested.size))
      throw this._err(
        "VALIDATION_ERROR",
        "Result scope contains missing workflow nodes.",
      );
    const all = [];
    for (const node of nodes)
      for (const output of ["result", "frame", "ref"]) {
        if (args.output && args.output !== "all" && args.output !== output)
          continue;
        for (const id of this._workflowOutput(node, output).ids)
          all.push({ node, output, id });
      }
    const offset = args.offset ?? 0,
      limit = args.limit ?? 20;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw this._err("VALIDATION_ERROR", "Invalid workflow result page.");
    const records = [];
    for (const item of all.slice(offset, offset + limit)) {
      records.push(
        await this._workflowRecord(scope, item.node, item.id, item.output),
      );
    }
    if (args.include_media === true && records.length) {
      const thumbnails = records.flatMap((record) =>
        record.type === "image" && /^data:image\//i.test(record.url)
          ? [
              {
                type: "image",
                base64: record.url,
                tile_id: record.fileId,
                workflow_id: args.wf_id,
                node_id: record.node.node_id,
                file_name: record.fileName,
              },
            ]
          : this._collectNodeMedia(
              {
                ...record.node,
                result_thumbnails: {
                  [record.fileId]: {
                    ...record.info,
                    type: record.type,
                    ...(record.blob ? { local_result: true } : {}),
                  },
                },
                result_file_names: { [record.fileId]: record.fileName },
                result_provider_urls: { [record.fileId]: record.provenance },
              },
              args.wf_id,
            ),
      );
      if (thumbnails.length !== records.length)
        throw this._err(
          "RESULT_MEDIA_UNAVAILABLE",
          "Some selected results cannot be delivered; inspect metadata without rerunning generation.",
        );
      return { thumbnails };
    }
    return {
      data: {
        workflow_id: args.wf_id,
        status: scope.workflow.status,
        nodes: nodes.map((node) => ({
          node_id: node.node_id,
          node_type: node.node_type,
          status: node.status,
          enabled: node.enabled,
          error_message: node.error_message || "",
          result_text: node.result_text || "",
        })),
        results: records.map((record) => ({
          ...record.selector,
          selector: record.selector,
          type: record.type,
          file_name: record.fileName,
          local_available: !!record.blob,
          local_bytes: record.blob?.size || 0,
          source_url_available: /^https?:\/\//i.test(record.url),
        })),
        total: all.length,
        offset,
        next_offset: offset + limit < all.length ? offset + limit : null,
      },
    };
  }
  static async _workflowSelectedRecord(selector) {
    const scope = await this._workflowDataScope(selector?.wf_id);
    const node = scope.workflow.nodes.find(
      (item) => String(item.node_id) === String(selector.node_id),
    );
    if (!node)
      throw this._err(
        "VALIDATION_ERROR",
        "Reference node does not belong to this workflow.",
      );
    const record = await this._workflowRecord(
      scope,
      node,
      selector.file_id,
      selector.output || "result",
    );
    return { scope, node, record };
  }
  static _isWorkflowFlowRecord(selected) {
    return (
      selected.record.provenance.provider === "flow" ||
      ["generate", "image"].includes(selected.node.node_type)
    );
  }
  static async _reuseWorkflowFlowRef(selected, selector, targetScope) {
    const { scope, record } = selected;
    if (
      selector.extract_frame ||
      record.type !== "image" ||
      !this._isWorkflowFlowRecord(selected) ||
      !scope.workflow.project_id ||
      String(scope.workflow.project_id).toLowerCase() !==
        String(targetScope.projectId).toLowerCase()
    )
      return null;
    const corrected = await this._readSavedFlowIdentity(
      {
        ...record.info,
        tileId: record.fileId,
        fileName: record.fileName,
        mediaUuid: record.provenance.media_uuid || record.info.media_uuid,
      },
      targetScope,
      "image",
    );
    const uuid = this._flowMediaUuid(corrected);
    if (!uuid) return null;
    const names = {};
    const ids = await this._resolveReuseRefs(
      [
        {
          provider: "flow",
          tile_id: uuid,
          file_name: corrected.fileName || uuid,
        },
      ],
      names,
    );
    scope.assertOwner();
    this._assertSavedResultScope(targetScope);
    if (ids.length !== 1)
      throw this._err(
        "RESULT_MEDIA_UNAVAILABLE",
        "The selected Flow reference could not be verified in its project.",
      );
    return {
      fileId: ids[0],
      fileName: names[ids[0]] || corrected.fileName || uuid,
    };
  }
  static async _executeUploadWorkflowResultRef(selector) {
    const targetScope = this._savedResultScope();
    const selected = await this._workflowSelectedRecord(selector);
    const reused = await this._reuseWorkflowFlowRef(
      selected,
      selector,
      targetScope,
    );
    if (reused)
      return {
        upload: { file_id: reused.fileId, file_name: reused.fileName },
        data: { reused: true },
      };
    const image = await this._readWorkflowImageRef(selector, selected);
    this._assertSavedResultScope(targetScope);
    return this._executeUploadRef({ image });
  }
  static async _readWorkflowImageRef(selector, selected = null) {
    selected || (selected = await this._workflowSelectedRecord(selector));
    const { scope, record } = selected;
    scope.assertOwner();
    let image;
    if (record.type === "video") {
      if (
        selector.extract_frame !== "last" ||
        !window.VideoFrameExtractor?.extractLastFrame
      )
        throw this._err(
          "VALIDATION_ERROR",
          "Choose a saved frame or set extract_frame:last for a video reference.",
        );
      const localUrl = record.blob ? URL.createObjectURL(record.blob) : null;
      try {
        let sourceUrl = record.url;
        const flow = this._isWorkflowFlowRecord(selected);
        if (
          !localUrl &&
          flow &&
          scope.workflow.project_id &&
          String(scope.workflow.project_id).toLowerCase() ===
            String(window._currentProjectId || "").toLowerCase()
        ) {
          const mediaScope = this._savedResultScope();
          let media = {
            ...record.info,
            tileId: record.fileId,
            fileName: record.fileName,
            mediaUuid: record.provenance.media_uuid || record.info.media_uuid,
            video_url: record.url,
          };
          media = await this._readSavedFlowIdentity(media, mediaScope, "video");
          sourceUrl = await this._savedFlowMediaUrl(media, mediaScope, "video");
          scope.assertOwner();
        }
        if (!localUrl && !/^https:\/\//i.test(sourceUrl))
          throw this._err(
            "RESULT_MEDIA_UNAVAILABLE",
            "Open the source Flow project to resolve the selected video, or choose a saved local frame.",
          );
        const frame = await window.VideoFrameExtractor.extractLastFrame(
          localUrl || sourceUrl,
          {
            ...(localUrl
              ? {}
              : {
                  provider: flow ? "flow" : record.provenance.provider,
                  tabId: record.provenance.tab_id,
                }),
            shouldStop: () => this._cancelRequested,
          },
        );
        image = frame?.base64;
      } finally {
        if (localUrl) URL.revokeObjectURL(localUrl);
      }
    } else if (record.blob) {
      if (!/^image\//i.test(record.blob.type) || record.blob.size > 1e7)
        throw this._err(
          "RESULT_MEDIA_UNAVAILABLE",
          "Workflow reference image is invalid or too large.",
        );
      image = `data:${record.blob.type};base64,${await this._blobToBase64(record.blob)}`;
    } else if (/^data:image\//i.test(record.url)) image = record.url;
    else {
      if (!/^https:\/\//i.test(record.url))
        throw this._err(
          "RESULT_MEDIA_UNAVAILABLE",
          "Workflow image is missing in this browser profile.",
        );
      let result;
      const provider = record.provenance.provider;
      if (provider === "grok")
        result = await window.MessageBridge.grokMaterializeMedia(
          record.url,
          record.provenance.tab_id,
        );
      else if (provider === "chatgpt")
        result = await window.MessageBridge.chatGPTFetchImage(
          record.url,
          record.provenance.tab_id,
        );
      else if (provider === "gemini") {
        const maxBytes = Number(
          window.ProviderConfigManager?.getApiConfigValueSync(
            "gemini",
            "generation_monitor",
          )?.image?.max_materialized_bytes,
        );
        if (!(maxBytes > 0))
          throw this._err(
            "CONFIG_UNAVAILABLE",
            "Gemini image byte policy is unavailable.",
          );
        const tabs = await chrome.runtime.sendMessage({
          action: "queryProviderTabs",
          provider,
        });
        result = await window.MessageBridge.geminiFetchMedia(
          record.url,
          tabs?.tabs?.[0]?.id ?? record.provenance.tab_id,
          Math.min(1e7, maxBytes),
        );
      } else
        result = await chrome.runtime.sendMessage({
          action: "fetchBlob",
          url: record.url,
          expectImage: true,
        });
      if (!result?.success)
        throw this._err(
          "RESULT_MEDIA_UNAVAILABLE",
          "Could not read the selected workflow image.",
        );
      const parts2 = this._inlineImageParts(
        result.base64 || result.dataUrl,
        result.contentType || result.mime,
        0,
      );
      image = `data:${parts2.mime};base64,${parts2.base64}`;
    }
    scope.assertOwner();
    if (!image || image.length > 14e6)
      throw this._err(
        "RESULT_MEDIA_UNAVAILABLE",
        "Workflow reference bytes are missing or too large.",
      );
    const parts = this._inlineImageParts(image, null, 0);
    return `data:${parts.mime};base64,${parts.base64}`;
  }
  static async _prepareWorkflowRefsForGen(args) {
    if (
      args.ref_mode === "none" ||
      args.refs?.length ||
      args.refs_per_prompt?.length ||
      args.reuse_refs?.length ||
      args.saved_refs?.length ||
      args.saved_refs_per_prompt?.length ||
      (args.workflow_refs?.length && args.workflow_refs_per_prompt?.length)
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Workflow reference selectors cannot be combined with other reference fields.",
      );
    const sets = args.workflow_refs_per_prompt || [args.workflow_refs];
    if (
      !sets.length ||
      sets.some((set) => !Array.isArray(set) || !set.length) ||
      sets.reduce((sum, set) => sum + set.length, 0) > 10 ||
      (args.workflow_refs_per_prompt &&
        sets.length !== this._resolvePromptList(args).length)
    )
      throw this._err(
        "VALIDATION_ERROR",
        "Provide up to 10 workflow references, one nonempty set per prompt.",
      );
    const targetScope =
      (args.provider || "flow") === "flow" ? this._savedResultScope() : null;
    const resolved = [],
      names = {};
    for (const set of sets) {
      const refs = [];
      for (const selector of set) {
        const selected = await this._workflowSelectedRecord(selector);
        const native = targetScope
          ? await this._reuseWorkflowFlowRef(selected, selector, targetScope)
          : null;
        if (native) {
          refs.push(native.fileId);
          names[native.fileId] = native.fileName;
        } else refs.push(await this._readWorkflowImageRef(selector, selected));
        if (targetScope) this._assertSavedResultScope(targetScope);
      }
      resolved.push(refs);
    }
    return {
      ...args,
      ...(args.workflow_refs_per_prompt
        ? { refs_per_prompt: resolved }
        : { refs: resolved[0] }),
      ...(targetScope
        ? { _savedFlowScope: targetScope, _savedFlowRefNames: names }
        : {}),
    };
  }
  static async _prepareWorkflowExecution(wfId, nodeId = null, nodeIds = null) {
    if (!wfId) throw this._err("VALIDATION_ERROR", "Thi\u1EBFu wf_id");
    let workflow = null;
    try {
      workflow = await window.storageManager?.getWorkflow?.(wfId);
    } catch (error) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c workflow t\u1EEB server: ${error?.message || "unknown error"}`,
      );
    }
    if (!workflow)
      throw this._err(
        "VALIDATION_ERROR",
        `Workflow "${wfId}" kh\xF4ng t\u1ED3n t\u1EA1i ho\u1EB7c ch\u01B0a \u0111\u1ED3ng b\u1ED9.`,
      );
    let selectedNodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
    if (nodeId) {
      const selected = selectedNodes.find(
        (node) => String(node.node_id) === String(nodeId),
      );
      if (!selected)
        throw this._err(
          "VALIDATION_ERROR",
          `Node "${nodeId}" kh\xF4ng t\u1ED3n t\u1EA1i trong workflow.`,
        );
      selectedNodes = [selected];
    }
    if (Array.isArray(nodeIds)) {
      const requested = new Set(nodeIds.map(String));
      selectedNodes = selectedNodes.filter((node) =>
        requested.has(String(node.node_id)),
      );
      if (!requested.size || selectedNodes.length !== requested.size)
        throw this._err(
          "VALIDATION_ERROR",
          "Run group contains missing or duplicate nodes.",
        );
    }
    try {
      if (
        workflow.project_id &&
        !window.ProjectHelper?.checkWorkflowProjectGate
      ) {
        throw this._err(
          "CONFIG_UNAVAILABLE",
          "Project gate ch\u01B0a s\u1EB5n s\xE0ng; kh\xF4ng th\u1EC3 x\xE1c minh Flow project c\u1EE7a workflow.",
        );
      }
      if (window.ProjectHelper?.checkWorkflowProjectGate) {
        const gate =
          await window.ProjectHelper.checkWorkflowProjectGate(workflow);
        if (!gate.ok) {
          if (gate.code === "WRONG_PROJECT") {
            const where = gate.expectedName
              ? `"${gate.expectedName}" (id: ${gate.expectedProjectId})`
              : `project ${gate.expectedProjectId}`;
            throw this._err(
              "WRONG_PROJECT",
              `Workflow thu\u1ED9c ${where}. H\u1ECEI user c\xF3 mu\u1ED1n m\u1EDF project n\xE0y kh\xF4ng; n\u1EBFu \u0111\u1ED3ng \xFD g\u1ECDi open_project("${gate.expectedProjectId}") r\u1ED3i ch\u1EA1y l\u1EA1i.`,
            );
          }
          throw this._err(
            "PROVIDER_TAB_NOT_READY",
            "Project c\u1EE7a workflow \u0111ang l\u1ED7i ho\u1EB7c \u0111\xE3 x\xF3a. H\xE3y m\u1EDF/ch\u1ECDn l\u1EA1i project h\u1EE3p l\u1EC7 r\u1ED3i th\u1EED l\u1EA1i.",
          );
        }
      }
    } catch (error) {
      if (error?.code) throw error;
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        `Kh\xF4ng x\xE1c minh \u0111\u01B0\u1EE3c Flow project: ${error?.message || "unknown error"}`,
      );
    }
    try {
      await this._preflightProviders(this._workflowProviders(selectedNodes), {
        nodes: selectedNodes,
        edges: workflow.edges || [],
      });
    } catch (error) {
      if (error?.code) throw error;
      throw this._err(
        "PROVIDER_TAB_NOT_READY",
        `Kh\xF4ng ki\u1EC3m tra \u0111\u01B0\u1EE3c provider c\u1EE7a workflow: ${error?.message || "unknown error"}`,
      );
    }
    return { workflow, selectedNodes };
  }
  static _collectNodeMedia(node, workflowId = node?.wf_id) {
    const media = [];
    const seen = new Set();
    const thumbnails =
      node?.result_thumbnails && typeof node.result_thumbnails === "object"
        ? node.result_thumbnails
        : {};
    const providerUrls =
      node?.result_provider_urls &&
      typeof node.result_provider_urls === "object"
        ? node.result_provider_urls
        : {};
    const ids = new Set([
      ...Object.keys(thumbnails),
      ...Object.keys(providerUrls),
    ]);
    for (const id of ids) {
      const raw = thumbnails[id];
      const info = typeof raw === "string" ? { thumbnail: raw } : raw || {};
      const rawProvenance = providerUrls[id];
      const provenance =
        typeof rawProvenance === "string"
          ? { url: rawProvenance }
          : rawProvenance || {};
      const type =
        info.type === "video" ||
        provenance.media_type === "video" ||
        info.video_url ||
        info.videoUrl ||
        provenance.video_url
          ? "video"
          : "image";
      const videoUrl =
        info.video_url ||
        info.videoUrl ||
        provenance.video_url ||
        (type === "video" ? provenance.url || info.url || "" : "");
      const url =
        info.thumbnail ||
        info.thumbnailUrl ||
        info.url ||
        provenance.url ||
        videoUrl;
      const local =
        info.local_result === true || provenance.local_result === true;
      const playable = type === "video" ? videoUrl : url;
      if (
        local
          ? !workflowId || !node.node_id
          : typeof playable !== "string" || !/^https?:\/\//i.test(playable)
      )
        continue;
      const key = local
        ? `${type}:${workflowId}:${node.node_id}:${id}`
        : `${type}:${videoUrl || url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      media.push({
        url,
        type,
        tile_id: id,
        provider:
          provenance.provider ||
          (node.node_type === "generate"
            ? "flow"
            : node.node_type === "chatgpt" && node.provider === "gemini"
              ? "gemini"
              : node.node_type) ||
          null,
        tab_id: provenance.tab_id || null,
        file_name: info.file_name || node?.result_file_names?.[id] || "",
        video_url: type === "video" ? videoUrl : "",
        workflow_id: workflowId,
        node_id: node.node_id,
        ...(local ? { local_result: true } : {}),
      });
    }
    return media;
  }
  static async _executeWorkflowNode(args) {
    if (!window.workflowExecutor?.executeSingleNode) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "WorkflowExecutor single-node ch\u01B0a kh\u1EDFi t\u1EA1o.",
      );
    }
    const wfId = args?.wf_id;
    const nodeId = args?.node_id;
    if (!nodeId) throw this._err("VALIDATION_ERROR", "Thi\u1EBFu node_id");
    const prepared = await this._prepareWorkflowExecution(wfId, nodeId);
    const target = prepared.selectedNodes[0];
    const previousHistorySource = window.workflowExecutor._historySource;
    window.workflowExecutor._historySource = "mcp";
    let executionResult;
    try {
      executionResult = await window.workflowExecutor.executeSingleNode(
        wfId,
        nodeId,
        { manualSubmitMode: false },
      );
    } finally {
      window.workflowExecutor._historySource = previousHistorySource;
    }
    const refreshed = await window.storageManager?.getWorkflow?.(wfId);
    const persistedNode =
      refreshed?.nodes?.find(
        (item) => String(item.node_id) === String(nodeId),
      ) || null;
    const liveNode = {
      ...target,
      result_thumbnails: executionResult?.thumbnails || {},
      result_file_names: executionResult?.fileNames || {},
      result_provider_urls: executionResult?.providerUrls || {},
      result_text:
        executionResult?.resultText || executionResult?.result_text || "",
    };
    const liveMedia = this._collectNodeMedia(liveNode, wfId);
    const expectedResultIds = new Set(
      [
        ...(Array.isArray(executionResult?.fileIds)
          ? executionResult.fileIds
          : []),
        ...Object.keys(executionResult?.thumbnails || {}),
        ...Object.keys(executionResult?.providerUrls || {}),
      ]
        .filter(Boolean)
        .map(String),
    );
    const persistedMedia = this._collectNodeMedia(persistedNode, wfId).filter(
      (item) => expectedResultIds.has(String(item.tile_id || "")),
    );
    const media = liveMedia.length ? liveMedia : persistedMedia;
    if (media.length) return { thumbnails: media };
    if (
      ["generate", "chatgpt", "grok", "gemini", "muse", "video_merge"].includes(
        target.node_type,
      )
    ) {
      throw this._err(
        "RESULT_MEDIA_UNAVAILABLE",
        `Node "${target.node_name || nodeId}" completed but no usable media could be returned to MCP.`,
      );
    }
    const resultText = liveNode.result_text || persistedNode?.result_text || "";
    if (typeof resultText === "string" && resultText.trim()) {
      return {
        data: {
          workflow_id: wfId,
          node_id: nodeId,
          node_type: target.node_type,
          status: persistedNode?.status || "completed",
          result_text: resultText,
        },
      };
    }
    return {
      data: {
        workflow_id: wfId,
        node_id: nodeId,
        node_type: target?.node_type || null,
        status: persistedNode?.status || "completed",
      },
    };
  }
  static async _executeWorkflow(args) {
    const wfId = args.wf_id;
    if (!window.workflowExecutor)
      throw this._err(
        "GEN_FAILED",
        "WorkflowExecutor ch\u01B0a kh\u1EDFi t\u1EA1o.",
      );
    const scope = Array.isArray(args.node_ids)
      ? new Set(args.node_ids.map(String))
      : null;
    await this._prepareWorkflowExecution(wfId, null, args.node_ids);
    const collected = [];
    const collectedKeys = new Set();
    const liveNodes = new Set();
    const collectMedia = (item) => {
      const key = item.local_result
        ? `${item.workflow_id}:${item.node_id}:${item.tile_id}`
        : `${item.type}:${item.video_url || item.url}`;
      if (collectedKeys.has(key)) return;
      collectedKeys.add(key);
      collected.push(item);
    };
    const onNode = (d) => {
      if (d?.workflowId && d.workflowId !== wfId) return;
      if (
        !d?.result ||
        (d.node?.wf_id && d.node.wf_id !== wfId) ||
        (scope && !scope.has(String(d.node?.node_id)))
      )
        return;
      const node = {
        ...d.node,
        result_thumbnails: d.result.thumbnails || {},
        result_provider_urls: d.result.providerUrls || {},
        result_file_names: d.result.fileNames || {},
      };
      const media = this._collectNodeMedia(node, wfId);
      if (media.length && d.node?.node_id) liveNodes.add(d.node.node_id);
      media.forEach(collectMedia);
    };
    window.eventBus?.on("node:completed", onNode);
    const previousHistorySource = window.workflowExecutor._historySource;
    window.workflowExecutor._historySource = "mcp";
    try {
      const ok = await window.workflowExecutor.execute(
        wfId,
        scope
          ? { onlyNodeIds: [...scope], manualSubmitMode: false }
          : { manualSubmitMode: false },
      );
      if (!ok && !this._flowExecutionControl())
        throw this._err(
          "GEN_FAILED",
          "Workflow th\u1EF1c thi th\u1EA5t b\u1EA1i.",
        );
      const wf = await window.storageManager?.getWorkflow?.(wfId);
      const outputNodes = (wf?.nodes || []).filter(
        (node) => !scope || scope.has(String(node.node_id)),
      );
      for (const node of outputNodes) {
        if (
          ![
            "generate",
            "chatgpt",
            "grok",
            "gemini",
            "muse",
            "video_merge",
          ].includes(node.node_type) ||
          liveNodes.has(node.node_id)
        )
          continue;
        this._collectNodeMedia(node, wfId).forEach(collectMedia);
      }
      if (collected.length === 0) {
        const control = this._flowExecutionControl();
        if (control)
          throw this._err(
            control.state === "paused"
              ? "FLOW_PROVIDER_PAUSED"
              : "FLOW_PROVIDER_STOPPED",
            "Flow stopped new workflow submissions; resolve the reported provider condition before more work.",
          );
        const outputs = outputNodes
          .filter(
            (node) =>
              typeof node.result_text === "string" && node.result_text.trim(),
          )
          .map((node) => ({
            node_id: node.node_id,
            node_type: node.node_type,
            result_text: node.result_text,
          }));
        if (outputs.length) return { data: { workflow_id: wfId, outputs } };
        if (
          outputNodes.some(
            (node) =>
              [
                "generate",
                "chatgpt",
                "grok",
                "gemini",
                "muse",
                "video_merge",
              ].includes(node.node_type) && node.enabled !== false,
          )
        )
          throw this._err(
            "RESULT_MEDIA_UNAVAILABLE",
            "Workflow completed but its media is unavailable. Inspect node results before rerunning.",
          );
        return {
          data: { workflow_id: wfId, status: "completed", outputs: [] },
        };
      }
      return { thumbnails: collected };
    } finally {
      window.eventBus?.off("node:completed", onNode);
      window.workflowExecutor._historySource = previousHistorySource;
      try {
        await window.generationHistory?._flushBuffer?.();
      } catch (error) {
        console.warn(
          "[McpExecutor] Workflow history flush failed:",
          error?.message,
        );
      }
    }
  }
  static async _sendResult(jobId, status, payload = {}, deliveryMeta = {}) {
    const control =
      jobId === this._currentJobId ? this._flowExecutionControl() : null;
    if (control)
      payload = {
        ...payload,
        batch: { ...(payload.batch || {}), execution_control: control },
      };
    const body = { job_id: jobId, status, runner_id: await this._runnerId() };
    const evidence = Array.isArray(payload.thumbnails)
      ? {
          ...(payload.batch || {}),
          generated_result_count: payload.thumbnails.length,
        }
      : payload.batch;
    if (status === "completed") {
      if (payload.project) {
        body.project = payload.project;
      } else if (payload.upload) {
        body.upload = payload.upload;
      } else if (payload.data) {
        body.data = payload.data;
      } else {
        let thumbs;
        try {
          thumbs =
            payload._convertedThumbs === true
              ? payload.thumbnails || []
              : await this._convertForMcp(
                  payload.thumbnails || [],
                  payload._tabId,
                );
        } catch (error) {
          return this._sendResult(
            jobId,
            "failed",
            {
              batch: { ...evidence, delivery_failed: true },
              errorCode: error?.code || "RESULT_MEDIA_UNAVAILABLE",
              errorMessage: error?.message || String(error),
            },
            deliveryMeta,
          );
        }
        if (
          [
            "gen_image",
            "gen_video",
            "run_workflow",
            "run_node",
            "get_saved_media",
          ].includes(payload._command) &&
          thumbs.length === 0
        ) {
          return this._sendResult(
            jobId,
            "failed",
            {
              batch: { ...evidence, delivery_failed: true },
              errorCode: "RESULT_MEDIA_UNAVAILABLE",
              errorMessage:
                "Provider \u0111\xE3 x\u1EED l\xFD nh\u01B0ng kh\xF4ng th\u1EC3 chuy\u1EC3n media k\u1EBFt qu\u1EA3 v\u1EC1 MCP client.",
            },
            deliveryMeta,
          );
        }
        body.thumbnails = thumbs;
        body.result_count = thumbs.length;
        if (evidence) body.batch = evidence;
        if (payload.batch)
          body.completion_state =
            payload.batch.failed > 0 || payload.batch.execution_control
              ? "partial"
              : "full";
        else body.completion_state = "full";
      }
    } else {
      if (evidence) body.batch = evidence;
      if (payload.errorCode) body.error_code = payload.errorCode;
      if (payload.errorMessage)
        body.error_message = String(payload.errorMessage).slice(0, 1e3);
    }
    if (evidence) body.batch = evidence;
    if (status === "completed" && evidence?.execution_control)
      body.completion_state = "partial";
    if (deliveryMeta.ownedRun) {
      await this._enqueueResultOutbox(body, deliveryMeta);
      await this._flushResultOutbox();
      const stored = await chrome.storage.local.get([this._RESULT_OUTBOX_KEY]);
      if (
        (stored?.[this._RESULT_OUTBOX_KEY] || []).some(
          (item) => item?.body?.job_id === jobId,
        )
      ) {
        await this._flushResultOutbox();
        const retried = await chrome.storage.local.get([
          this._RESULT_OUTBOX_KEY,
        ]);
        return !(retried?.[this._RESULT_OUTBOX_KEY] || []).some(
          (item) => item?.body?.job_id === jobId,
        );
      }
      return true;
    }
    const delivery = await this._deliverResultBody(body);
    if (delivery.delivered) {
      if (deliveryMeta.ownedRun) {
        try {
          await this._settleOwnedMcpAfterAck(deliveryMeta.ownedRun);
        } catch (error) {
          console.warn(
            "[McpExecutor] Worker settlement pending after MCP ACK:",
            error?.message || error,
          );
          await this._enqueueResultOutbox(body, deliveryMeta);
          return false;
        }
      }
      return true;
    }
    if (!delivery.retryable) {
      if (status === "completed") {
        const rejection = this._resultDeliveryDiagnostic(delivery.error);
        const failureBody = {
          job_id: jobId,
          runner_id: body.runner_id,
          status: "failed",
          batch: {
            ...(body.batch || {}),
            delivery_failed: true,
            ...(rejection ? { delivery_error: rejection } : {}),
          },
          error_code: "RESULT_DELIVERY_REJECTED",
          error_message:
            "Provider completed, but the MCP result payload was rejected by the server.",
        };
        const fallbackDelivery = await this._deliverResultBody(failureBody);
        if (
          !fallbackDelivery.delivered &&
          (fallbackDelivery.retryable || deliveryMeta.ownedRun)
        ) {
          await this._enqueueResultOutbox(failureBody, deliveryMeta);
          return false;
        }
        if (fallbackDelivery.delivered && deliveryMeta.ownedRun) {
          try {
            await this._settleOwnedMcpAfterAck(deliveryMeta.ownedRun);
          } catch (error) {
            await this._enqueueResultOutbox(failureBody, deliveryMeta);
            return false;
          }
        }
      }
      if (deliveryMeta.ownedRun && status !== "completed") {
        await this._enqueueResultOutbox(body, deliveryMeta);
        return false;
      }
      return true;
    }
    await this._enqueueResultOutbox(body, deliveryMeta);
    return false;
  }
  static _resultDeliveryDiagnostic(error) {
    if (!error) return null;
    const status = Number(error.httpStatus);
    const code = this._mcpErrorCode(error);
    const fields = Object.keys(error.details || error.serverData?.errors || {})
      .filter((field) => /^[A-Za-z0-9_.]{1,128}$/.test(field))
      .slice(0, 20);
    return {
      http_status:
        Number.isInteger(status) && status >= 100 && status <= 599
          ? status
          : null,
      code,
      fields,
    };
  }
  static async _deliverResultBody(body) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (!window.authManager?._apiCall)
          throw new Error("AuthManager ch\u01B0a s\u1EB5n s\xE0ng");
        await window.authManager._apiCall("POST", "mcp/result", body);
        return { delivered: true, retryable: false };
      } catch (err) {
        lastError = err;
        const status = Number(err?.httpStatus || 0);
        const retryable =
          status === 0 ||
          status === 408 ||
          status === 409 ||
          status === 429 ||
          status >= 500;
        if (!retryable) {
          console.warn("[McpResultDeliveryRejected]", {
            jobId: body.job_id,
            status: body.status,
            ...this._resultDeliveryDiagnostic(err),
          });
          return { delivered: false, retryable: false, error: err };
        }
        if (attempt < 2)
          await new Promise((r) => setTimeout(r, 750 * 2 ** attempt));
      }
    }
    console.error(
      "[McpExecutor] g\u1EEDi result th\u1EA5t b\u1EA1i sau retry:",
      lastError?.message,
    );
    return { delivered: false, retryable: true, error: lastError };
  }
  static async _enqueueResultOutbox(body, meta = {}) {
    await this._mutateResultOutbox(async () => {
      const stored = await chrome.storage.local.get([this._RESULT_OUTBOX_KEY]);
      const items = Array.isArray(stored?.[this._RESULT_OUTBOX_KEY])
        ? stored[this._RESULT_OUTBOX_KEY]
        : [];
      const withoutSameJob = items.filter(
        (item) => item?.body?.job_id !== body.job_id,
      );
      const userId = window.authManager?.user?.id || null;
      if (!userId) return;
      withoutSameJob.push({
        body,
        meta,
        userId,
        queuedAt: Date.now(),
        outboxRevision: crypto.randomUUID(),
        attempts: 0,
      });
      const owned = withoutSameJob.filter((item) => item.meta?.ownedRun);
      const legacy = withoutSameJob
        .filter((item) => !item.meta?.ownedRun)
        .slice(-50);
      await chrome.storage.local.set({
        [this._RESULT_OUTBOX_KEY]: [...legacy, ...owned],
      });
    });
    setTimeout(() => this._flushResultOutbox().catch(() => {}), 3e4);
  }
  static _mutateResultOutbox(task) {
    const next = this._outboxMutation.catch(() => {}).then(task);
    this._outboxMutation = next.catch(() => {});
    return next;
  }
  static async _flushResultOutbox() {
    if (this._resultFlushPromise) return this._resultFlushPromise;
    this._resultFlushPromise = (async () => {
      const stored = await chrome.storage.local.get([this._RESULT_OUTBOX_KEY]);
      const items = Array.isArray(stored?.[this._RESULT_OUTBOX_KEY])
        ? stored[this._RESULT_OUTBOX_KEY]
        : [];
      if (!items.length) return;
      const currentUserId = window.authManager?.user?.id || null;
      if (!currentUserId) return;
      const remaining = [];
      for (const item of items) {
        const age = Date.now() - Number(item.queuedAt || 0);
        if (!item.meta?.ownedRun && (age > 864e5 || (item.attempts || 0) >= 10))
          continue;
        if (String(item.userId || "") !== String(currentUserId)) {
          remaining.push(item);
          continue;
        }
        const delivery = await this._deliverResultBody(item.body);
        if (item.meta?.ownedRun)
          console.info(
            "[McpOwnedProgress]",
            JSON.stringify({
              jobId: item.body.job_id,
              runId: item.meta.ownedRun.runId,
              stage: "result_delivery",
              delivered: delivery.delivered === true,
              retryable: delivery.retryable === true,
              attempt: (item.attempts || 0) + 1,
            }),
          );
        if (!delivery.delivered) {
          if (delivery.retryable) {
            remaining.push({ ...item, attempts: (item.attempts || 0) + 1 });
            continue;
          }
          if (item.body?.status === "completed") {
            const rejection = this._resultDeliveryDiagnostic(delivery.error);
            const failureBody = {
              job_id: item.body.job_id,
              status: "failed",
              error_code: "RESULT_DELIVERY_REJECTED",
              runner_id: item.body.runner_id,
              batch: {
                ...(item.body.batch || {}),
                delivery_failed: true,
                ...(rejection ? { delivery_error: rejection } : {}),
              },
              error_message:
                "Provider completed, but the queued MCP result payload was rejected by the server.",
            };
            const fallbackDelivery = await this._deliverResultBody(failureBody);
            if (!fallbackDelivery.delivered) {
              remaining.push({
                ...item,
                body: failureBody,
                attempts: (item.attempts || 0) + 1,
              });
              continue;
            }
          } else if (item.meta?.ownedRun) {
            remaining.push({ ...item, attempts: (item.attempts || 0) + 1 });
            continue;
          }
          if (!(await this._completeOutboxExecution(item))) {
            remaining.push({ ...item, attempts: (item.attempts || 0) + 1 });
            continue;
          }
          continue;
        }
        if (!(await this._completeOutboxExecution(item))) {
          remaining.push({ ...item, attempts: (item.attempts || 0) + 1 });
          continue;
        }
      }
      await this._mutateResultOutbox(async () => {
        const current = await chrome.storage.local.get([
          this._RESULT_OUTBOX_KEY,
        ]);
        const latest = Array.isArray(current?.[this._RESULT_OUTBOX_KEY])
          ? current[this._RESULT_OUTBOX_KEY]
          : [];
        const seen = new Map(items.map((item) => [item?.body?.job_id, item]));
        for (const item of latest) {
          const previous = seen.get(item?.body?.job_id);
          if (
            !previous ||
            Number(item.queuedAt || 0) > Number(previous.queuedAt || 0) ||
            item.outboxRevision !== previous.outboxRevision
          )
            remaining.push(item);
        }
        if (remaining.length)
          await chrome.storage.local.set({
            [this._RESULT_OUTBOX_KEY]: remaining,
          });
        else await chrome.storage.local.remove(this._RESULT_OUTBOX_KEY);
      });
    })().finally(() => {
      this._resultFlushPromise = null;
    });
    return this._resultFlushPromise;
  }
  static async _completeOutboxExecution(item) {
    if (item?.meta?.ownedRun) {
      try {
        await this._settleOwnedMcpAfterAck(item.meta.ownedRun);
      } catch (error) {
        console.warn(
          "[McpExecutor] Worker settlement retry pending:",
          error?.message || error,
        );
        return false;
      }
    }
    const token = item?.meta?.executionToken;
    if (!token || !window.ExecutionGate) return true;
    const allowed = new Set(["success", "partial", "failed"]);
    const outcome = allowed.has(item.meta?.executionOutcome)
      ? item.meta.executionOutcome
      : "failed";
    const resultData =
      item.meta?.executionResultData &&
      typeof item.meta.executionResultData === "object"
        ? item.meta.executionResultData
        : outcome === "failed"
          ? { error: "mcp_result_delayed" }
          : {};
    try {
      await ExecutionGate.complete(token, outcome, resultData);
    } catch (_) {
      return false;
    }
    return true;
  }
  static async _settleOwnedMcpAfterAck(run) {
    if (!run || run.status === "needs_review") return;
    await window.ProviderWebScheduler.settleOwned(
      run.runId,
      run.userId,
      run.owner,
      run.status || "failed",
      run.status === "partial" ? run.successfulCount : null,
    );
  }
  static async _readMuseVideoBlob(tabId, url) {
    try {
      const runtime = await window.MessageBridge?.museCreateRuntimeVideoUrl?.(
        tabId,
        url,
      );
      if (runtime?.success && runtime.videoUrl) {
        try {
          const blob = await (await fetch(runtime.videoUrl)).blob();
          if (blob.size > 0 && /^video\//i.test(blob.type)) return blob;
        } finally {
          URL.revokeObjectURL(runtime.videoUrl);
        }
      }
    } catch (_) {}
    throw this._err(
      "RESULT_DELIVERY_UNAVAILABLE",
      "Muse generated the video, but its source tab could not provide the bytes for MCP delivery. Keep that tab open to recover/download the existing result.",
    );
  }
  static async _convertForMcp(thumbnails, tabId) {
    const out = [];
    let inlineBytes = 0;
    for (const t of thumbnails) {
      try {
        if (t._deliveryError) throw t._deliveryError;
        if (t._mcpConverted) {
          out.push(t._mcpConverted);
          continue;
        }
        const type = t.type || "image";
        let localBlob = t._savedBlob instanceof Blob ? t._savedBlob : null;
        if (t.local_result === true) {
          const saved = await window.WorkflowResultMediaStore?.get(
            t.workflow_id,
            t.node_id,
            t.tile_id,
          );
          localBlob = saved?.blob;
          if (!localBlob?.size) {
            localBlob = null;
            const sourceUrl = t.type === "video" ? t.video_url : t.url;
            if (!/^https?:\/\//i.test(String(sourceUrl)))
              throw this._err(
                "RESULT_MEDIA_UNAVAILABLE",
                "Local workflow media is missing. Open the node result in its original browser profile.",
              );
          }
        }
        if (type === "video") {
          const vurl = t.video_url || t.url;
          const pageOwnedVideo = /^blob:/i.test(String(vurl || ""));
          let blob = localBlob;
          try {
            if (!blob && t.base64)
              blob = await (
                await fetch(
                  String(t.base64).startsWith("data:")
                    ? t.base64
                    : `data:${t.mime_type || "video/mp4"};base64,${t.base64}`,
                )
              ).blob();
            else if (!blob && vurl) {
              const r = await this._fetchTO(vurl, {}, 3e4);
              if (r?.ok) blob = await r.blob();
            }
          } catch (_) {}
          if (!blob && pageOwnedVideo && t.provider === "muse") {
            blob = await this._readMuseVideoBlob(t.tab_id ?? tabId, vurl);
          }
          let finalUrl = localBlob
            ? ""
            : /^https?:\/\//i.test(String(vurl || ""))
              ? vurl
              : "";
          let videoStoredInR2 = false;
          let poster = null;
          if (blob) {
            if (window.DownloadHelper?.cleanMediaBlob) {
              const cl = await window.DownloadHelper.cleanMediaBlob(
                blob,
                "video",
              );
              blob = cl.blob || blob;
              if (
                !cl.cleaned &&
                cl.reason &&
                cl.reason !== "DISABLED" &&
                !cl.noWatermark
              ) {
                console.warn("[MCP] video watermark unchanged:", cl.reason);
              }
            }
            const r2 = await this._uploadMediaToR2(blob);
            if (r2) {
              finalUrl = r2;
              videoStoredInR2 = true;
            } else if (t.require_durable === true) {
              throw this._err(
                pageOwnedVideo && t.provider === "muse"
                  ? "RESULT_DELIVERY_UNAVAILABLE"
                  : "RESULT_MEDIA_UNAVAILABLE",
                "Generated video could not be stored durably. Keep its source result; check object storage before delivering it without generating again.",
              );
            } else if (window.WatermarkClient?.enabled?.("video") === true) {
              console.warn(
                "[MCP] Video could not be stored in R2; returning the original provider URL.",
              );
            }
            poster = await this._videoPoster(blob);
            if (poster && window.WatermarkClient) {
              const cl = await window.WatermarkClient.cleanBase64(
                poster,
                "image/png",
                "video",
              );
              if (cl.cleaned) poster = cl.base64;
            }
          }
          if (t.require_durable === true && !videoStoredInR2) {
            throw this._err(
              pageOwnedVideo && t.provider === "muse"
                ? "RESULT_DELIVERY_UNAVAILABLE"
                : "RESULT_MEDIA_UNAVAILABLE",
              "Worker video has no durable storage after its tab closes.",
            );
          }
          if (pageOwnedVideo && !localBlob && !videoStoredInR2)
            throw this._err(
              "RESULT_DELIVERY_UNAVAILABLE",
              "Muse generated the video, but MCP object storage is unavailable. Keep the existing result in its source tab; configure storage before delivering it, without generating again.",
            );
          if (finalUrl || poster || localBlob) {
            const v = {
              type: "video",
              provider: t.provider || null,
              tile_id:
                (t.provider === "flow" ? this._flowMediaUuid(t) : null) ||
                t.tile_id ||
                null,
              file_name: t.file_name || "",
              storage: videoStoredInR2
                ? "r2"
                : localBlob
                  ? "local"
                  : "provider",
              downloadable: videoStoredInR2,
            };
            if (finalUrl) v.video_url = finalUrl;
            if (blob?.type) v.mime_type = blob.type;
            if (t.workflow_id && t.node_id) {
              v.workflow_id = t.workflow_id;
              v.node_id = t.node_id;
            }
            if (t.batch_id)
              Object.assign(v, {
                batch_id: t.batch_id,
                batch_source: t.batch_source,
                prompt_index: t.prompt_index,
                result_index: t.result_index,
                identity: t.identity || null,
              });
            if (poster) {
              v.poster = poster;
              inlineBytes += poster.length;
            }
            out.push(v);
          }
          continue;
        }
        let base64 = localBlob
          ? await this._blobToBase64(localBlob)
          : t.base64 || null;
        if (!base64 && t.url) {
          base64 = await this._fetchImageAsBase64(
            t.url,
            t.tab_id || tabId,
            t.provider,
          );
        }
        let mime = localBlob?.type || t.mime_type || "image/png";
        const dataUrl =
          typeof base64 === "string" &&
          /^data:([^;,]+);base64,([\s\S]+)$/.exec(base64);
        if (dataUrl) {
          mime = dataUrl[1];
          base64 = dataUrl[2];
        }
        let cleaned = false;
        if (base64 && window.WatermarkClient) {
          const cl = await window.WatermarkClient.cleanBase64(
            base64,
            mime,
            "image",
          );
          if (cl.cleaned) {
            base64 = cl.base64;
            mime = cl.mime || mime;
            cleaned = true;
          }
        }
        let storedUrl = null;
        if (base64) {
          try {
            const blob = await (
              await fetch(`data:${mime};base64,${base64}`)
            ).blob();
            storedUrl = await this._uploadMediaToR2(blob);
            if (storedUrl) base64 = null;
          } catch (_) {}
        }
        const item = {
          type: "image",
          provider: t.provider || null,
          tile_id:
            (t.provider === "flow" ? this._flowMediaUuid(t) : null) ||
            t.tile_id ||
            null,
          file_name: t.file_name || "",
        };
        if (t.workflow_id && t.node_id) {
          item.workflow_id = t.workflow_id;
          item.node_id = t.node_id;
        }
        if (t.batch_id)
          Object.assign(item, {
            batch_id: t.batch_id,
            batch_source: t.batch_source,
            prompt_index: t.prompt_index,
            result_index: t.result_index,
            identity: t.identity || null,
          });
        if (storedUrl) {
          item.url = storedUrl;
          item.storage = "r2";
          item.downloadable = true;
        } else if (t.url && /^https?:\/\//i.test(t.url) && !cleaned) {
          item.url = t.url;
          item.storage = "provider";
          item.downloadable = false;
        }
        if (
          base64 &&
          t._savedBlob &&
          (base64.length > 8e6 || inlineBytes + base64.length > 19e6)
        ) {
          item.storage = "local";
          item.downloadable = false;
          item.mime_type = mime;
        } else if (base64) {
          item.base64 = base64;
          item.mime_type = mime;
          item.storage = "inline";
          item.downloadable = true;
          inlineBytes += base64.length;
        }
        if (item.url || item.base64 || item.storage === "local") out.push(item);
      } catch (e) {
        if (
          t?.require_durable === true ||
          t?.local_result === true ||
          t?._savedBlob ||
          e?.code === "RESULT_DELIVERY_UNAVAILABLE"
        )
          throw e;
        console.warn("[McpExecutor] convert thumb l\u1ED7i:", e?.message);
      }
    }
    if (inlineBytes > 2e7) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        "MCP media exceeds the inline result limit and object storage is unavailable. Configure R2 and retry.",
      );
    }
    return out;
  }
  static async _fetchImageAsBase64(url, tabId, provider = null) {
    try {
      let materialized;
      if (provider === "grok" && window.MessageBridge?.grokMaterializeMedia)
        materialized = await window.MessageBridge.grokMaterializeMedia(
          url,
          tabId,
        );
      else if (
        provider === "gemini" &&
        window.MessageBridge?.geminiFetchMedia
      ) {
        const maxBytes = Number(
          window.ProviderConfigManager?.getApiConfigValueSync(
            "gemini",
            "generation_monitor",
          )?.image?.max_materialized_bytes,
        );
        if (maxBytes > 0) {
          const tabs = await chrome.runtime.sendMessage({
            action: "queryProviderTabs",
            provider,
          });
          materialized = await window.MessageBridge.geminiFetchMedia(
            url,
            tabs?.tabs?.[0]?.id ?? tabId,
            maxBytes,
          );
        }
      } else if (
        (!provider || provider === "chatgpt") &&
        window.MessageBridge?.chatGPTFetchImage &&
        tabId
      )
        materialized = await window.MessageBridge.chatGPTFetchImage(url, tabId);
      if (materialized?.success && materialized.base64)
        return materialized.base64;
      const resp = await fetch(url);
      if (!resp.ok) return null;
      return await this._blobToBase64(await resp.blob());
    } catch (_) {
      return null;
    }
  }
  static async _uploadMediaToR2(blob) {
    try {
      const ct = blob.type || "video/mp4";
      const ext = ct.includes("webm")
        ? "webm"
        : ct.includes("jpeg")
          ? "jpg"
          : ct.includes("png")
            ? "png"
            : ct.includes("webp")
              ? "webp"
              : "mp4";
      const resp = await window.authManager?._apiCall(
        "POST",
        "mcp/media/upload-url",
        { ext, content_type: ct },
      );
      const p = resp && resp.enabled !== void 0 ? resp : resp?.data || {};
      if (!p?.enabled || !p.upload_url) return null;
      const put = await this._fetchTO(
        p.upload_url,
        {
          method: "PUT",
          body: blob,
          headers: { "Content-Type": ct, ...(p.headers || {}) },
        },
        6e4,
      );
      if (!put?.ok) {
        console.warn("[McpExecutor] R2 PUT fail", put?.status);
        return null;
      }
      return p.public_url || null;
    } catch (e) {
      console.warn("[McpExecutor] R2 upload l\u1ED7i:", e?.message);
      return null;
    }
  }
  static async _fetchTO(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  static _videoPoster(blob) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      try {
        const url = URL.createObjectURL(blob);
        const cleanup = () => {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
        };
        const video = document.createElement("video");
        video.muted = true;
        video.preload = "metadata";
        video.playsInline = true;
        video.src = url;
        video.onloadeddata = () => {
          try {
            video.currentTime = Math.min(0.1, video.duration || 0.1);
          } catch (_) {
            cleanup();
            finish(null);
          }
        };
        video.onseeked = () => {
          try {
            const c = document.createElement("canvas");
            const width = video.videoWidth || 360,
              height = video.videoHeight || 640;
            const scale = Math.min(1, 512 / Math.max(width, height));
            c.width = Math.max(1, Math.round(width * scale));
            c.height = Math.max(1, Math.round(height * scale));
            c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
            finish(c.toDataURL("image/png").split(",")[1] || null);
          } catch (_) {
            finish(null);
          }
          cleanup();
        };
        video.onerror = () => {
          cleanup();
          finish(null);
        };
        setTimeout(() => {
          cleanup();
          finish(null);
        }, 8e3);
      } catch (_) {
        finish(null);
      }
    });
  }
  static _blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result.split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  static async _handleFlowBatchControl(data) {
    const userId = window.authManager?.getUser?.()?.id;
    const owned = () =>
      String(window.authManager?.getUser?.()?.id) === String(userId) &&
      String(data.user_id) === String(userId);
    const trace = (stage, reason) =>
      console.info(
        "[McpFlowBatchControl]",
        JSON.stringify({
          stage,
          reason,
          batchId: data.batch_id,
          projectId: data.project_id,
          operation: data.operation,
        }),
      );
    if (
      !userId ||
      !owned() ||
      !data.batch_id ||
      !data.project_id ||
      !["stop", "resume"].includes(data.operation)
    )
      return false;
    const store = window.GenBatchQueueStore,
      modal = window.genBatchListModal;
    for (let attempt = 0; attempt < 2; attempt++) {
      const batch = await store?.get(userId, data.project_id, data.batch_id);
      if (!owned() || !batch) {
        trace("ignored", "BATCH_OWNER_CHANGED");
        return false;
      }
      if (data.operation === "resume") {
        if (
          data.confirm !== true ||
          batch.status !== "queued" ||
          batch.revision !== data.expected_revision ||
          window._currentProjectId !== data.project_id ||
          !modal?.scheduler
        ) {
          trace("ignored", "QUEUED_TAKE_OR_PROJECT_CHANGED");
          return false;
        }
        modal.scheduler.queueExplicit(batch.batchId, "BATCH_LIST_RERUN_MCP");
        trace("resume_requested", "EXISTING_QUEUED_TAKE");
        return true;
      }
      if (batch.status === "queued") {
        try {
          await store.update(
            userId,
            data.project_id,
            batch.batchId,
            batch.revision,
            (record) => ({
              ...record,
              status: "stopped",
              completedAt: Date.now(),
            }),
          );
          trace("stop_requested", "QUEUED_TAKE");
          await modal?.reload?.().catch(() => {});
          return true;
        } catch (error) {
          if (attempt === 0 && error?.message === "BATCH_REVISION_CONFLICT")
            continue;
          throw error;
        }
      }
      if (
        modal?.scheduler?.activeBatchId === batch.batchId &&
        String(modal.scheduler._activeOwner?.userId) === String(userId) &&
        modal.scheduler._activeOwner?.projectId === data.project_id
      ) {
        await modal.scheduler.stop();
        trace("stop_requested", "SCHEDULER_OWNER");
        return true;
      }
      const jobId = batch.executionJobId || batch.jobId,
        job = jobId && modal?.queue?.getJob?.(jobId);
      const exactJob =
        job &&
        job.projectId === data.project_id &&
        (job.sourceBatchId === batch.batchId ||
          (job.owner === "mcp" &&
            batch.mcpJobId &&
            job.mcpJobId === batch.mcpJobId &&
            String(job.mcpUserId) === String(userId)));
      if (!owned() || !exactJob) {
        trace("ignored", "NO_EXACT_RUNTIME_OWNER");
        return false;
      }
      await modal.queue.stopJob(jobId, {
        stopOrigin: "user",
        stopSource: "MCP_BATCH_STOP",
      });
      trace("stop_requested", "EXACT_RUNTIME_JOB");
      return true;
    }
    return false;
  }
  static async _handleWorkflowStop(data) {
    const flag = (await chrome.storage.local.get("af_running_workflow"))
      ?.af_running_workflow;
    const trace = (stage, reason) =>
      console.info(
        "[McpWorkflowControl]",
        JSON.stringify({
          stage,
          reason,
          workflowId: data.workflow_id,
          runId: data.workflow_run_id,
          nodeId: data.node_id || null,
        }),
      );
    if (
      !flag ||
      flag.wf_id !== data.workflow_id ||
      flag.run_id !== data.workflow_run_id
    ) {
      trace("stop_ignored", "RUN_CHANGED");
      return false;
    }
    if (data.node_id && flag.executor_context !== "single_nodes") {
      trace("stop_ignored", "NOT_SINGLE_NODE_SESSION");
      return false;
    }
    const executor = window.workflowExecutor;
    if (
      this._isExecuting &&
      this._currentWorkflowId === data.workflow_id &&
      (!data.node_id || this._currentWorkflowNodeId === data.node_id)
    ) {
      this._cancelRequested = true;
      this._wasStopped = true;
    }
    const localOwner =
      executor?.currentWorkflow?.wf_id === flag.wf_id &&
      executor?._flowRunId === flag.run_id;
    trace("stop_requested", localOwner ? "LOCAL_OWNER" : "REMOTE_OWNER");
    if (data.node_id) {
      if (localOwner && executor.isSingleNodeActive?.(data.node_id))
        return executor.stopSingleNode(data.node_id, "MCP_WORKFLOW_NODE_STOP");
      await chrome.runtime.sendMessage({
        action: "workflow:stop_single_node",
        workflowId: flag.wf_id,
        runId: flag.run_id,
        nodeId: data.node_id,
        stopSource: "MCP_WORKFLOW_NODE_STOP",
      });
    } else {
      if (localOwner)
        executor.handleRemoteStop?.(
          flag.wf_id,
          flag.run_id,
          "MCP_WORKFLOW_STOP",
        );
      await chrome.runtime.sendMessage({
        action: "workflowExecutionEvent",
        event: "execution:stop",
        data: {
          wf_id: flag.wf_id,
          run_id: flag.run_id,
          stopSource: "MCP_WORKFLOW_STOP",
        },
      });
    }
    return true;
  }
  static async _handleCancel(data) {
    if (!this._isLeaderContext()) return;
    if (!data?.runner_id || data.runner_id !== (await this._runnerId())) return;
    if (data.flow_batch_control === true)
      return this._handleFlowBatchControl(data);
    if (data.workflow_id && data.workflow_run_id)
      return this._handleWorkflowStop(data);
    const cancelAll = data?.all === true;
    if (
      this._currentJobId &&
      (cancelAll || data?.job_id === this._currentJobId)
    ) {
      this._cancelRequested = true;
      this._wasStopped = true;
      await this._stopOwnedMcpRun(
        cancelAll ? "MCP_CANCEL_ALL" : "MCP_CANCEL",
      ).catch((error) =>
        console.warn(
          "[McpExecutor] Worker stop pending:",
          error?.message || error,
        ),
      );
      if (
        this._currentProvider === "muse" &&
        this._currentMuseGenMode !== "api"
      )
        window.MuseSession?.abort?.().catch(() => {});
      if (window.ExecutionLock?.stopCurrent) window.ExecutionLock.stopCurrent();
      window.eventBus?.emit("queue:stop_all", {
        stopOrigin: "user",
        stopReason: "USER_CANCELLED",
        stopSource: cancelAll ? "MCP_CANCEL_ALL" : "MCP_CANCEL",
      });
    }
  }
  static _mcpDownloadTaskName(downloadFolder, batchName) {
    if (!batchName) return downloadFolder;
    const slug =
      String(batchName)
        .trim()
        .replace(/[đĐ]/g, (c) => (c === "\u0111" ? "d" : "D"))
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9_-]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 30) || "batch";
    return `${downloadFolder || "tobyflow_mcp"}/${slug}`;
  }
  static async _getMcpDownloadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(["af_settings"], (res) => {
          const s = res?.af_settings || {};
          const on =
            s.mcpAutoDownload === true ||
            s.mcpAutoDownload === "1" ||
            s.mcpAutoDownload === 1;
          const canDl = window.featureGate
            ? window.featureGate.canUse("auto_download")
            : true;
          resolve({
            autoDownload: on && canDl,
            downloadResolution: s.mcpDownloadResolution || "1k",
            videoDownloadResolution: s.mcpVideoDownloadResolution || "720p",
            downloadFolder: s.mcpDownloadFolder || "tobyflow_mcp",
          });
        });
      } catch (_) {
        resolve({
          autoDownload: false,
          downloadResolution: "1k",
          videoDownloadResolution: "720p",
          downloadFolder: "tobyflow_mcp",
        });
      }
    });
  }
  static _err(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
  }
  static _mcpErrorCode(value) {
    const candidate =
      typeof value === "string"
        ? value
        : value?.code || value?.errorCode || value?.error;
    return typeof candidate === "string" &&
      /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)
      ? candidate
      : null;
  }
  static _firstGenerationFailureCode(failures) {
    return (
      (Array.isArray(failures) ? failures : [])
        .map((failure) => failure?.errorCode)
        .find(
          (code) =>
            typeof code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(code),
        ) || null
    );
  }
  static _quotaCompletion(result, stopped = false) {
    const thumbnails = Array.isArray(result?.thumbnails)
      ? result.thumbnails.length
      : 0;
    const batchFailed = Math.max(0, Number(result?.batch?.failed || 0));
    const batchSucceeded = Math.max(0, Number(result?.batch?.succeeded || 0));
    const successfulCount = thumbnails || batchSucceeded;
    if (successfulCount > 0 && (stopped || batchFailed > 0)) {
      return {
        status: "partial",
        resultData: {
          successful_count: successfulCount,
          ...(batchFailed > 0 ? { failed_count: batchFailed } : {}),
        },
      };
    }
    if (
      stopped ||
      (result?.batch && successfulCount === 0 && batchFailed > 0)
    ) {
      return {
        status: "failed",
        resultData: { error: stopped ? "cancelled" : "mcp_generation_failed" },
      };
    }
    return { status: "success", resultData: {} };
  }
  static _buildBatch(total, failedList, completed, { flow = false } = {}) {
    const failed = Array.isArray(failedList) ? failedList : [];
    if (total <= 1 && failed.length === 0) return null;
    return {
      succeeded:
        typeof completed === "number"
          ? completed
          : Math.max(0, total - failed.length),
      failed: failed.length,
      ...(failed.some((item) => item.confirmationPending)
        ? { needs_review: true, no_retry: true }
        : {}),
      failed_prompts: failed.slice(0, 200).map((f) => ({
        index: typeof f.index === "number" ? f.index : null,
        prompt: String(f.prompt || "").slice(0, 500),
        error: String(f.error || "").slice(0, 300),
        ...(typeof f.errorCode === "string" &&
        /^[A-Z][A-Z0-9_]{0,79}$/.test(f.errorCode)
          ? { error_code: f.errorCode }
          : {}),
        ...(() => {
          if (!flow || !window.FlowApiAdapter?.classifyError) return {};
          const type = window.FlowApiAdapter.classifyError(
            f.errorCode || f.error,
            f.errorType || null,
          );
          const action = window.FlowApiAdapter.getErrorPolicy?.(type)?.action;
          return type && type !== "unknown"
            ? {
                flow_error_type: type,
                ...(typeof action === "string"
                  ? { flow_user_action: action }
                  : {}),
              }
            : {};
        })(),
      })),
    };
  }
  static async _executeClearFlowCookies(args = {}) {
    if (
      args.confirm !== true ||
      typeof args.project_id !== "string" ||
      !args.project_id.trim() ||
      (args.provider && args.provider !== "flow")
    ) {
      throw this._err(
        "VALIDATION_ERROR",
        "Provide the current Flow project_id and confirm: true after user consent.",
      );
    }
    if (window.FlowApiAdapter?.isApiModeIntended?.() !== true) {
      throw this._err("FLOW_API_NOT_ACTIVE", "Flow API mode must be active.");
    }
    if (!(await window.BridgeClient?.supportsFlowCookieRecovery?.(true))) {
      throw this._err(
        "FLOW_SESSION_RECOVERY_UNAVAILABLE",
        "Flow session recovery is unavailable. Update TobyFlow and check the session in Settings.",
      );
    }
    const target = await window.MessageBridge?.getTargetContext?.();
    if (
      !Number.isInteger(target?.tabId) ||
      target.driverKey !== "flow_v2" ||
      target.projectId !== args.project_id
    ) {
      throw this._err(
        "COOKIE_RECOVERY_PROJECT_MISMATCH",
        "The current Flow project does not match project_id.",
      );
    }
    const queue = window.PromptQueue?.getInstance?.();
    if (
      !queue?.clearFlowCookiesForTest ||
      !window.FlowCookieRecovery?._withLoading
    ) {
      throw this._err("CONFIG_NOT_READY", "Flow cookie recovery is not ready.");
    }
    const result = await window.FlowCookieRecovery._withLoading(() =>
      queue.clearFlowCookiesForTest(target),
    );
    if (result?.ok !== true) {
      throw this._err(
        result?.error || "COOKIE_RECOVERY_FAILED",
        "Could not finish Flow cookie recovery. Generation data is retained; do not automatically retry.",
      );
    }
    return {
      data: {
        project_id: target.projectId,
        cookies_cleared: true,
        cache_cleared: true,
        reloaded: true,
        auto_resumed: false,
      },
    };
  }
  static _mapCommandToAction(command, provider) {
    if (command === "gen_image" || command === "gen_video") {
      return provider === "grok"
        ? "grok_run"
        : provider === "chatgpt"
          ? "chatgpt_run"
          : provider === "gemini"
            ? "gemini_run"
            : provider === "muse"
              ? "muse_run"
              : provider === "flow"
                ? "generate"
                : null;
    }
    return null;
  }
  static async _resolveReuseRefs(
    reuseRefs,
    refFileNames = {},
    refThumbnails = {},
  ) {
    const out = [];
    let uuidLookup = null;
    if (window.flow_uuid_gateway) {
      const uuids = [
        ...new Set(
          (Array.isArray(reuseRefs) ? reuseRefs : [])
            .filter((ref) => ref && (!ref.provider || ref.provider === "flow"))
            .map((ref) =>
              this._flowMediaUuid({
                tile_id: ref.tile_id,
                file_name: ref.file_name,
              }),
            )
            .filter(Boolean),
        ),
      ];
      if (uuids.length) {
        const scope = this._savedResultScope();
        try {
          uuidLookup = await window.flow_uuid_gateway.resolve(uuids, {
            projectId: scope.projectId,
            purpose: "reference",
            surface: "mcp",
            generationProcessId: this._currentJobId || null,
            mediaType: "image",
          });
        } catch (error) {
          if (
            [
              "PROJECT_MISMATCH",
              "FLOW_EXECUTION_TARGET_CHANGED",
              "ABORTED",
            ].includes(error?.code) ||
            error?.name === "AbortError"
          )
            throw error;
          uuidLookup = { results: {}, failed: [], unresolved: uuids };
          console.warn(
            "[McpExecutor] UUID reference lookup unavailable",
            error?.code || "lookup_unavailable",
          );
        }
        this._assertSavedResultScope(scope);
      }
    }
    let boardReloadAttempted = false;
    let boardReloaded = false;
    for (const r of Array.isArray(reuseRefs) ? reuseRefs : []) {
      if (!r || typeof r !== "object") {
        throw this._err(
          "VALIDATION_ERROR",
          "reuse_refs entries must be objects.",
        );
      }
      const provider = r.provider || "flow";
      try {
        if (provider === "flow") {
          const uuid = this._flowMediaUuid({
            tile_id: r.tile_id,
            file_name: r.file_name,
          });
          if (uuid && uuidLookup) {
            const verdict = uuidLookup.results?.[uuid];
            if (uuidLookup.failed?.includes(uuid)) continue;
            if (
              [
                "type_mismatch",
                "identity_mismatch",
                "project_mismatch",
              ].includes(verdict?.reason)
            ) {
              throw this._err(
                "SAVED_RESULT_IDENTITY_CHANGED",
                "Flow reference identity changed; select its canonical UUID again.",
              );
            }
            const info = verdict?.ok ? verdict.metadata : null;
            out.push(uuid);
            refFileNames[uuid] =
              info?.persistent_media_id ||
              info?.file_name ||
              r.file_name ||
              uuid;
            const thumbnail = info?.source_thumbnail || info?.thumbnail;
            if (/^https?:\/\//.test(thumbnail || ""))
              refThumbnails[uuid] = {
                thumbnail,
                media_uuid: uuid,
                file_name: refFileNames[uuid],
                type: "image",
              };
            continue;
          }
          if (uuid && window.MessageBridge?.lookupFlowMediaCatalog) {
            const scope = this._savedResultScope();
            const catalog = await window.MessageBridge.lookupFlowMediaCatalog([
              uuid,
            ]);
            this._assertSavedResultScope(scope);
            if (
              catalog?.supported === true &&
              String(catalog.projectId || "").toLowerCase() !==
                String(scope.projectId).toLowerCase()
            )
              throw this._err(
                "PROJECT_MISMATCH",
                "Open the source Flow project before reusing this image.",
              );
            const info =
              catalog?.supported === true ? catalog.known?.[uuid] : null;
            if (
              info &&
              (info.type !== "image" ||
                String(info.media_uuid || "").toLowerCase() !== uuid)
            )
              throw this._err(
                "SAVED_RESULT_IDENTITY_CHANGED",
                "Flow reference identity changed; select its canonical UUID again.",
              );
            if (
              info?.type === "image" &&
              String(info.media_uuid || "").toLowerCase() === uuid
            ) {
              out.push(uuid);
              refFileNames[uuid] =
                info.persistent_media_id || info.file_name || uuid;
              const thumbnail = info.source_thumbnail || info.thumbnail;
              if (/^https?:\/\//.test(thumbnail || ""))
                refThumbnails[uuid] = {
                  thumbnail,
                  file_name: refFileNames[uuid],
                  type: "image",
                };
              continue;
            }
            const resolved = await this._resolveSavedFlowApiMedia(
              uuid,
              scope,
              "image",
            );
            if (resolved?.url) {
              out.push(uuid);
              refFileNames[uuid] = uuid;
              refThumbnails[uuid] = {
                thumbnail: resolved.url,
                file_name: uuid,
                type: "image",
              };
              continue;
            }
            if (catalog?.supported === true)
              throw this._err(
                "SAVED_RESULT_NOT_FOUND",
                "Open this media in its source Flow project before reusing its UUID.",
              );
          }
          const tid = (r.tile_id || "").toString().trim();
          if (!tid)
            throw this._err(
              "VALIDATION_ERROR",
              "Flow reuse_ref requires tile_id.",
            );
          let id = tid;
          if (window.resolveFileIdsString) {
            const fnMap = r.file_name ? { [tid]: r.file_name } : {};
            const thMap = r.url ? { [tid]: r.url } : {};
            const resolved = await window.resolveFileIdsString(
              tid,
              thMap,
              fnMap,
            );
            id = (resolved || tid).split(",")[0].trim() || tid;
          }
          if (r.file_name && window.MessageBridge?.checkFilesExist) {
            let chk = null;
            try {
              chk = await window.MessageBridge.checkFilesExist([r.file_name]);
            } catch (_) {}
            if (
              chk &&
              Array.isArray(chk.missing) &&
              chk.missing.includes(r.file_name)
            ) {
              if (!boardReloadAttempted) {
                boardReloadAttempted = true;
                try {
                  const queue = window.PromptQueue?.getInstance?.();
                  boardReloaded = !!(await queue?.forceReloadAndStabilize?.(
                    "mcp-reuse-ref-refresh",
                    { bypassSuppress: true, scope: "mcp" },
                  ));
                } catch (error) {
                  console.warn(
                    "[McpExecutor] Could not refresh Flow board for reuse_refs:",
                    error?.message || error,
                  );
                }
              }
              if (!boardReloaded) {
                throw this._err(
                  "REF_FETCH_FAILED",
                  `Ch\u01B0a th\u1EC3 \u0111\u1ED3ng b\u1ED9 \u1EA3nh "${r.file_name}" v\u1EDBi Flow project \u0111ang m\u1EDF (Flow \u0111ang b\u1EADn ho\u1EB7c reload th\u1EA5t b\u1EA1i). Th\u1EED l\u1EA1i khi c\xE1c l\u01B0\u1EE3t gen hi\u1EC7n t\u1EA1i ho\xE0n t\u1EA5t.`,
                );
              }
              let foundId = null;
              try {
                const scan = await window.MessageBridge.sendToContentScript?.(
                  "ensureFlowTilesLoaded",
                  { force: true, targetFileNames: [r.file_name] },
                );
                foundId = scan?.found?.[r.file_name] || null;
              } catch (_) {}
              if (!foundId) {
                try {
                  chk = await window.MessageBridge.checkFilesExist([
                    r.file_name,
                  ]);
                  foundId = chk?.found?.[r.file_name] || null;
                } catch (_) {}
              }
              if (!foundId) {
                throw this._err(
                  "REF_FETCH_FAILED",
                  `\u1EA2nh "${r.file_name}" kh\xF4ng c\xF3 trong Flow project \u0111ang m\u1EDF sau khi n\u1EA1p l\u1EA1i (\u0111\u1ED5i project ho\u1EB7c \u0111\xE3 x\xF3a?). M\u1EDF \u0111\xFAng project ch\u1EE9a \u1EA3nh r\u1ED3i th\u1EED l\u1EA1i.`,
                );
              }
              id = foundId;
            } else if (chk?.found?.[r.file_name]) {
              id = chk.found[r.file_name];
            }
          }
          if (id) {
            out.push(id);
            if (r.file_name) refFileNames[id] = r.file_name;
            const thumbnail = window.MediaRegistry?.getThumb?.(id) || null;
            if (/^https?:\/\//.test(thumbnail || ""))
              refThumbnails[id] = {
                thumbnail,
                file_name: r.file_name || null,
                type: "image",
              };
          }
        } else if (provider === "chatgpt" || provider === "grok") {
          if (!r.url)
            throw this._err(
              "REF_FETCH_FAILED",
              `reuse_ref ${provider} thi\u1EBFu url \u0111\u1EC3 bridge sang Flow.`,
            );
          const CDN =
            provider === "chatgpt"
              ? /(^|\.)chatgpt\.com$|(^|\.)oaiusercontent\.com$/i
              : /(^|\.)grok\.com$|(^|\.)x\.ai$/i;
          let host = "";
          try {
            host = new URL(r.url).hostname;
          } catch (_) {}
          if (!host || !CDN.test(host))
            throw this._err(
              "REF_FETCH_FAILED",
              `reuse_ref url ph\u1EA3i l\xE0 CDN ${provider} (host nh\u1EADn: ${host || "invalid"}). Ch\u1EC9 d\xF9ng url \u1EA3nh K\u1EBET QU\u1EA2 t\u1EEB ${provider}.`,
            );
          const session =
            provider === "chatgpt" ? window.ChatGPTSession : window.GrokSession;
          const ready = await session?.ensureReady?.({
            createIfMissing: false,
            activate: false,
          });
          if (!ready?.ready)
            throw this._err(
              "PROVIDER_TAB_NOT_READY",
              `Tab ${provider} ch\u01B0a s\u1EB5n s\xE0ng \u0111\u1EC3 l\u1EA5y \u1EA3nh bridge sang Flow (m\u1EDF + \u0111\u0103ng nh\u1EADp ${provider}).`,
            );
          const fetchFn =
            provider === "chatgpt"
              ? window.MessageBridge?.chatGPTFetchImage
              : window.MessageBridge?.grokFetchImage;
          const fr = await fetchFn?.(r.url, ready.tabId);
          if (!fr?.success || !fr.base64)
            throw this._err(
              "REF_FETCH_FAILED",
              `Could not fetch the ${provider} image from url (${fr?.error || "error"}) to bridge to Flow.`,
            );
          const up = await this._uploadRefToFlow(fr.base64);
          if (up?.tileId) {
            out.push(up.tileId);
            if (up.fileName) refFileNames[up.tileId] = up.fileName;
            if (/^https?:\/\//.test(up.thumbnailUrl || ""))
              refThumbnails[up.tileId] = {
                thumbnail: up.thumbnailUrl,
                file_name: up.fileName || null,
                type: "image",
              };
          }
        } else {
          throw this._err(
            "VALIDATION_ERROR",
            `reuse_ref provider is unsupported: ${provider}`,
          );
        }
      } catch (e) {
        if (e?.code) throw e;
        throw this._err(
          "REF_FETCH_FAILED",
          `reuse_ref (${provider}) l\u1ED7i: ${e?.message || e}`,
        );
      }
    }
    return out;
  }
  static async _resolveRefsToImages(refs, maxRefs = 4) {
    if (!Array.isArray(refs) || !refs.length) return [];
    if (!Number.isInteger(maxRefs) || maxRefs < 1) {
      throw this._err(
        "VALIDATION_ERROR",
        "Reference image limit is unavailable for this provider.",
      );
    }
    const out = [];
    for (let i = 0; i < Math.min(refs.length, maxRefs); i++) {
      const ref = refs[i];
      if (typeof ref !== "string" || !ref) continue;
      let parts = null;
      if (/^https?:\/\//i.test(ref)) {
        try {
          const resp = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage(
              { action: "fetchBlob", url: ref, expectImage: true },
              (r) => {
                if (chrome.runtime.lastError)
                  reject(new Error(chrome.runtime.lastError.message));
                else resolve(r);
              },
            );
          });
          if (!resp?.success || !resp.base64) {
            throw this._err(
              "REF_FETCH_FAILED",
              `Could not download ref image from URL: ${ref} (${resp?.error || "unknown error"}). Use a public URL that opens directly (no login/cookie required).`,
            );
          }
          parts = this._inlineImageParts(resp.base64, resp.contentType, i);
        } catch (e) {
          if (e?.code) throw e;
          throw this._err(
            "REF_FETCH_FAILED",
            `L\u1ED7i t\u1EA3i ref URL ${ref}: ${e?.message || e}`,
          );
        }
      } else {
        parts = this._inlineImageParts(ref, null, i);
      }
      if (parts?.base64)
        out.push({ base64: parts.base64, name: parts.name, type: parts.mime });
    }
    return out;
  }
  static _historyModel(provider, model, isVideo = false) {
    const m = (model || "").trim();
    if (m) return m;
    if (provider === "grok") return "grok";
    if (provider === "chatgpt") {
      return (
        window.storageSettings?.getSettings?.()?.chatgptModel ||
        window.ModelRegistry?.safeGetDefault?.("chatgpt", "image") ||
        null
      );
    }
    if (provider === "gemini")
      return (
        window.ModelRegistry?.safeGetDefault?.(
          "gemini",
          isVideo ? "video" : "image",
        ) || ""
      );
    if (provider === "muse")
      return (
        window.ModelRegistry?.safeGetDefault?.(
          "muse",
          isVideo ? "video" : "image",
        ) || ""
      );
    return (
      window.ModelRegistry?.safeGetDefault?.(
        "flow",
        isVideo ? "video" : "image",
      ) || ""
    );
  }
  static async _saveGenHistory({
    promptList,
    mediaType,
    model,
    ratio,
    quantity,
    refFileIds,
    refThumbnails = {},
    thumbs,
    resultFileIds,
    provider,
    sourceId = null,
    status,
    stopOrigin = null,
    errorReason,
    failedPrompts = [],
    errorDetails = [],
    diagnostics = null,
    flowApiVersions = [],
    historyRoute = null,
    durationMs = null,
  }) {
    try {
      if (!window.generationHistory?.saveRecord) return;
      const result_thumbnails = (thumbs || []).map((t) => ({
        thumbnail: t.url || "",
        file_name: t.file_name || "",
        type: t.type || "image",
        video_url: t.video_url || "",
      }));
      await window.generationHistory.saveRecord({
        prompt: (promptList || []).join("\n\n"),
        media_type: mediaType || "image",
        model: model || "",
        ratio: ratio || "",
        prompt_count: (promptList || []).length || 1,
        quantity: quantity || 1,
        ref_file_ids: (refFileIds || []).filter(Boolean).join(", "),
        ref_thumbnails: refThumbnails,
        result_file_ids: (resultFileIds || []).filter(Boolean).join(", "),
        result_thumbnails,
        source: "mcp",
        source_id: sourceId || this._currentJobId || "",
        status: status || (failedPrompts.length ? "partial" : "success"),
        stop_origin:
          status === "stopped" && stopOrigin === "user" ? "user" : null,
        error_reason:
          errorReason ||
          [
            ...new Set(failedPrompts.map((item) => item.error).filter(Boolean)),
          ].join(" \xB7 ") ||
          null,
        error_details: errorDetails,
        diagnostics,
        duration_ms: Number.isFinite(durationMs)
          ? durationMs
          : this._currentGenerationStartedAt
            ? Math.max(0, Date.now() - this._currentGenerationStartedAt)
            : null,
        flow_api_versions: flowApiVersions,
        historyRoute,
        provider: provider || "flow",
        project_id: window._currentProjectId || null,
        auto_download: false,
      });
      await window.generationHistory._flushBuffer?.();
    } catch (e) {
      console.warn(
        "[McpExecutor] _saveGenHistory l\u1ED7i (b\u1ECF qua, kh\xF4ng fail gen):",
        e?.message,
      );
    }
  }
  static _collectThumbs(resultThumbnails) {
    const thumbs = [];
    if (resultThumbnails) {
      for (const [tileId, info] of Object.entries(resultThumbnails)) {
        if (info.thumbnail || info.video_url) {
          thumbs.push({
            url: info.thumbnail || "",
            file_name: info.file_name || "",
            type: info.type || "image",
            video_url: info.video_url || "",
            tile_id: tileId,
            ...(this._flowMediaUuid({ ...info, tileId })
              ? { media_uuid: this._flowMediaUuid({ ...info, tileId }) }
              : {}),
          });
        }
      }
    }
    return thumbs;
  }
  static _reverseRatioMap(uiMap) {
    if (!uiMap || typeof uiMap !== "object") return {};
    const r = {};
    for (const [k, v] of Object.entries(uiMap)) r[v] = k;
    return r;
  }
  static async _resolveFlowRatio(ratio, isVideo = false) {
    const mode = isVideo ? "video" : "image";
    let configured;
    try {
      configured = await window.ProviderConfigManager?.getRatios?.(
        "flow",
        mode,
      );
    } catch (_) {
      configured = null;
    }
    const valid = (Array.isArray(configured) ? configured : [])
      .map((item) => (typeof item === "string" ? item : item?.value))
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim());
    if (!valid.length) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `Flow ${mode} ratios are unavailable from server config.`,
      );
    }
    if (ratio != null && String(ratio).trim()) {
      const requested = String(ratio).trim().toLowerCase();
      const matched = valid.find((value) => value.toLowerCase() === requested);
      if (!matched) {
        throw this._err(
          "VALIDATION_ERROR",
          `Ratio "${String(ratio).trim()}" is invalid for Flow ${mode}.`,
        );
      }
      return matched;
    }
    const settings = window.storageSettings?.getSettings?.() || {};
    const preferred = isVideo
      ? settings.defaultVideoRatio
      : settings.defaultImageRatio;
    return (
      [preferred, settings.aspectRatio]
        .map((value) => valid.find((candidate) => candidate === value))
        .find(Boolean) || valid[0]
    );
  }
  static _mapRatioToChatGPT(ratio) {
    return this._mapRatioToProvider("chatgpt", ratio, "chatgptDefaultRatio");
  }
  static _mapRatioToGrok(ratio) {
    return this._mapRatioToProvider("grok", ratio, "grokDefaultRatio");
  }
  static _mapRatioToProvider(provider, ratio, settingKey) {
    let uiMap = null;
    try {
      uiMap = window.ProviderConfigManager?.getRatioUiMapSync?.(provider);
    } catch (_) {
      uiMap = null;
    }
    if (
      !uiMap ||
      typeof uiMap !== "object" ||
      Object.keys(uiMap).length === 0
    ) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `${provider} ratio UI mapping is unavailable from server config.`,
      );
    }
    const configuredDefault =
      window.storageSettings?.getSettings?.()?.[settingKey];
    const requested = String(ratio || configuredDefault || "")
      .trim()
      .toLowerCase();
    if (!requested) {
      throw this._err(
        "CONFIG_UNAVAILABLE",
        `${provider} default ratio is unavailable from server-backed user settings.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(uiMap, requested))
      return requested;
    const valueToUi = this._reverseRatioMap(uiMap);
    if (valueToUi[requested]) return valueToUi[requested];
    throw this._err(
      "VALIDATION_ERROR",
      `Ratio "${requested}" is invalid for ${provider}.`,
    );
  }
}
__publicField(McpExecutor, "_currentJobId", null);
__publicField(McpExecutor, "_isExecuting", false);
__publicField(McpExecutor, "_cancelRequested", false);
__publicField(McpExecutor, "_wasStopped", false);
__publicField(McpExecutor, "_currentProvider", null);
__publicField(McpExecutor, "_initialized", false);
__publicField(McpExecutor, "_currentExecutionToken", null);
__publicField(McpExecutor, "_currentOwnedRun", null);
__publicField(McpExecutor, "_currentSavedBatchRun", null);
__publicField(McpExecutor, "_RESULT_OUTBOX_KEY", "af_mcp_result_outbox");
__publicField(McpExecutor, "_resultFlushPromise", null);
__publicField(McpExecutor, "_outboxMutation", Promise.resolve());
__publicField(McpExecutor, "_executorHeartbeatTimer", null);
__publicField(McpExecutor, "_activeHeartbeatTimer", null);
__publicField(McpExecutor, "_readyHeartbeatPromise", null);
__publicField(McpExecutor, "_heartbeatFailed", false);
__publicField(McpExecutor, "_RUNNER_ID_KEY", "toby_mcp_runner_id");
__publicField(McpExecutor, "_RUNNER_OWNER_KEY", "toby_mcp_runner_owner");
__publicField(McpExecutor, "_runnerIdPromise", null);
__publicField(McpExecutor, "_runnerOwnerId", null);
__publicField(McpExecutor, "_ownedRecoveryPromise", null);
__publicField(McpExecutor, "_ownedRecoveryJobId", null);
__publicField(McpExecutor, "_activityTimer", null);
__publicField(McpExecutor, "_lastFrameActivityDetail", null);
__publicField(McpExecutor, "_museApiDisplayWrite", Promise.resolve());
window.McpExecutor = McpExecutor;
