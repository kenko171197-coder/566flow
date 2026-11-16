(function () {
  "use strict";
  class WorkflowSingleNodeSession {
    constructor(owner, workflowId) {
      this.owner = owner;
      this.workflowId = workflowId;
      this.runId = null;
      this.records = new Map();
      this.ready = false;
      this.closed = false;
      this.stopping = false;
      this.browserRecord = null;
      this.previewRequests = new Map();
      this._waiters = new Set();
      this.done = new Promise((resolve) => {
        this._resolveDone = resolve;
      });
    }
    accepts(workflowId) {
      return (
        !this.closed &&
        !this.stopping &&
        String(workflowId) === String(this.workflowId)
      );
    }
    enqueue(nodeId, options = {}) {
      if (!this.accepts(this.workflowId))
        throw this._error("SINGLE_NODE_SESSION_STOPPING");
      nodeId = String(nodeId);
      if (this.records.has(nodeId)) throw this._error("NODE_ALREADY_RUNNING");
      const record = {
        nodeId,
        options,
        status: "queued",
        worker: null,
        overlapReady: false,
        api: false,
        web: false,
        createdAt: Date.now(),
        id: `single-node:${crypto.randomUUID()}`,
      };
      record.promise = new Promise((resolve, reject) => {
        record.resolve = resolve;
        record.reject = reject;
      });
      this.records.set(nodeId, record);
      this._changed(record);
      this._pump();
      return record.promise;
    }
    setReady(workflow) {
      this.workflow = workflow;
      this.ready = true;
      this._pump();
      this._finishIfEmpty();
    }
    _error(code) {
      return Object.assign(new Error(code), { code, noRetry: true });
    }
    static noticeKey(code) {
      const keys = {
        NODE_NOT_FOUND: "nodeNotFoundAfterSave",
        NODE_ALREADY_RUNNING: "singleNodeDuplicate",
        PREPARATION_BUSY: "singleNodePreparing",
        UNSAVED_CHANGES: "singleNodeUnsaved",
        SAVE_FAILED: "singleNodeSaveFailed",
        SINGLE_NODE_SESSION_STOPPING: "singleNodeStopping",
        WORKFLOW_EXECUTION_STILL_STOPPING: "singleNodeStopping",
        WORKFLOW_EXECUTION_BUSY: "singleNodeOtherRun",
        CROSS_CONTEXT_RUNNING: "singleNodeOtherRun",
        BUSY: "singleNodeOtherRun",
        SINGLE_NODE_OWNER_UNAVAILABLE: "singleNodeOwnerUnavailable",
        SINGLE_NODE_SESSION_NOT_FOUND: "singleNodeOwnerUnavailable",
        BROWSER_STOP_UNCONFIRMED: "singleNodeStopUnconfirmed",
        BROWSER_BUSY: "singleNodeWaitBrowser",
        FLOW_WEB_BUSY: "singleNodeWaitFlowWeb",
        FLOW_API_PREPARING: "singleNodeWaitApiDispatch",
        GENERATION_QUEUE: "singleNodeQueued",
        PREPARING_NODE: "singleNodePreparing",
      };
      return `workflow.${keys[code] || "singleNodeBlocked"}`;
    }
    waitingFor(record) {
      if (record.status === "running")
        return {
          waitReason: record.flow ? "GENERATION_QUEUE" : "PREPARING_NODE",
        };
      if (this.browserRecord) {
        const node = this.browserRecord.node;
        const provider =
          node?.node_type === "prompt" ? node.provider : node?.node_type;
        return {
          waitReason: "BROWSER_BUSY",
          waitProvider: provider === "generate" ? "flow" : provider,
        };
      }
      const flows = [...this.records.values()].filter(
        (r) => r.flow && ["running", "stopping"].includes(r.status),
      );
      if (flows.some((r) => !r.api || r.web))
        return { waitReason: "FLOW_WEB_BUSY" };
      if (flows.some((r) => !r.overlapReady))
        return { waitReason: "FLOW_API_PREPARING" };
      return { waitReason: "GENERATION_QUEUE" };
    }
    _dependent(leftId, rightId) {
      const edges = this.workflow?.edges || [];
      const nodes = this.workflow?.nodes || [];
      const bySlug = new Map(
        nodes
          .filter((node) => node.slug)
          .map((node) => [node.slug, String(node.node_id)]),
      );
      const mentionSources = new Map();
      for (const node of nodes) {
        const usesMentions =
          ["generate", "chatgpt", "grok", "gemini", "muse", "prompt"].includes(
            node.node_type,
          ) &&
          !(
            node.node_type !== "prompt" &&
            node.prompt_source === "upstream_node"
          ) &&
          (node.prompt_mode === "mention" ||
            (node.node_type === "prompt" &&
              (!node.prompt_mode || node.prompt_mode === "auto")));
        if (!usesMentions) continue;
        const sources = [
          ...String(node.prompt || "").matchAll(
            /@([a-z][a-z0-9_]{0,29})(?![a-z0-9@._:-])/g,
          ),
        ]
          .map((match) => bySlug.get(match[1]))
          .filter((id) => id && id !== String(node.node_id));
        mentionSources.set(String(node.node_id), sources);
      }
      const reaches = (start, target) => {
        const seen = new Set();
        const pending = [String(start)];
        while (pending.length) {
          const current = pending.pop();
          if (current === String(target)) return true;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const edge of edges)
            if (String(edge.source_node_id) === current)
              pending.push(String(edge.target_node_id));
          for (const [consumerId, sources] of mentionSources)
            if (sources.includes(current)) pending.push(consumerId);
        }
        return false;
      };
      return reaches(leftId, rightId) || reaches(rightId, leftId);
    }
    _pump() {
      if (!this.ready || this.closed || this.stopping) return;
      for (const record of this.records.values()) {
        if (record.status !== "queued") continue;
        const node = this.workflow.nodes?.find(
          (n) => String(n.node_id) === record.nodeId,
        );
        if (
          !node &&
          record.options.refreshDefinition === true &&
          record.definitionRefresh === void 0
        ) {
          record.definitionRefresh = "checking";
          Promise.resolve()
            .then(() =>
              window.storageManager.getWorkflowDefinitionFresh(this.workflowId),
            )
            .then((definition) => {
              if (
                !this.records.has(record.nodeId) ||
                this.closed ||
                this.stopping
              )
                return;
              const added = definition?.nodes?.find(
                (n) => String(n.node_id) === record.nodeId,
              );
              if (!added) throw this._error("NODE_NOT_FOUND");
              const known = new Set(
                (this.workflow.nodes || []).map((n) => String(n.node_id)),
              );
              for (const fresh of definition.nodes)
                if (!known.has(String(fresh.node_id))) {
                  this.workflow.nodes.push(fresh);
                  known.add(String(fresh.node_id));
                }
              if (Array.isArray(definition.edges))
                this.workflow.edges = definition.edges;
              record.definitionRefresh = "ready";
              console.info(
                "[WorkflowSingleNode] Added saved node to active session",
                JSON.stringify({
                  workflowId: this.workflowId,
                  nodeId: record.nodeId,
                }),
              );
            })
            .catch((error) => {
              record.definitionRefresh = "failed";
              this._settle(record, null, error);
            })
            .finally(() => this._pump());
          continue;
        }
        if (!node && record.definitionRefresh === "checking") continue;
        if (!node) {
          this._settle(record, null, this._error("NODE_NOT_FOUND"));
          continue;
        }
        record.node = node;
        const earlier = [...this.records.values()].slice(
          0,
          [...this.records.values()].indexOf(record),
        );
        if (
          earlier.some(
            (other) =>
              other.status === "queued" &&
              this._dependent(other.nodeId, record.nodeId),
          )
        )
          continue;
        const pipeline = window.PromptQueue?.isEnabled?.() === true;
        record.flow = node.node_type === "generate";
        const museApi =
          node.node_type === "muse" &&
          window.MuseApiFacade?.workflowEffectiveMode?.() === "api";
        record.museApi = museApi;
        let museLimit = null;
        if (museApi) {
          if (!this._museConfigPromise) {
            this._museConfigHandler = () => this._pump();
            this._museConfigUnsubscribe = window.eventBus?.on?.(
              "execution_config:refreshed",
              this._museConfigHandler,
            );
            this._museConfigPromise = Promise.resolve()
              .then(() => window.ExecutionConfig.getConfig())
              .then(
                () => {
                  this._museConfigReady = true;
                },
                (error) => {
                  this._museConfigReady = true;
                  this._museConfigError = error;
                },
              )
              .finally(() => this._pump());
          }
          if (!this._museConfigReady) continue;
          try {
            if (this._museConfigError) throw this._museConfigError;
            museLimit =
              node.media_type === "Video"
                ? window.ExecutionConfig.getQueueVideoMaxMonitor()
                : window.ExecutionConfig.getQueueMaxMonitor();
            if (!Number.isSafeInteger(museLimit) || museLimit <= 0)
              throw this._error("MUSE_EXECUTION_CONFIG_REQUIRED");
          } catch (cause) {
            const error = this._error("MUSE_EXECUTION_CONFIG_REQUIRED");
            error.cause = cause;
            this._settle(record, null, error);
            continue;
          }
        }
        const workerSupported =
          ["chatgpt", "muse", "gemini"].includes(node.node_type) &&
          !museApi &&
          (node.node_type !== "chatgpt" || node.media_type !== "Video");
        let workerCandidate = false;
        let workerConfigInvalid = false;
        let surfaceConfigError = null;
        if (workerSupported) {
          try {
            const surface = window.ExecutionConfig?.getProviderWebSurface?.(
              "workflow",
              node.node_type,
            );
            if (!surface || typeof surface.surfaceEnabled !== "boolean") {
              workerConfigInvalid = true;
              surfaceConfigError = this._error(
                "PROVIDER_WORKER_CONFIG_UNAVAILABLE",
              );
            } else if (surface.surfaceEnabled === true) {
              workerCandidate = true;
              if (
                !window.ProviderWebScheduler?.runOwned ||
                !window.ProviderWebScheduler?.acquireDomTurn
              )
                workerConfigInvalid = true;
            }
          } catch (error) {
            workerConfigInvalid = true;
            surfaceConfigError = error;
          }
        }
        if (workerSupported && record.workerConfigRefresh === "checking")
          continue;
        if (
          surfaceConfigError &&
          record.workerConfigRefresh === void 0 &&
          window.ExecutionConfig?.getConfig
        ) {
          record.workerConfigRefresh = "checking";
          Promise.resolve()
            .then(() => window.ExecutionConfig.getConfig(true))
            .then(
              () => {
                record.workerConfigRefresh = "ready";
              },
              (error) => {
                record.workerConfigRefresh = "failed";
                record.workerConfigError = error;
              },
            )
            .finally(() => this._pump());
          continue;
        }
        if (workerConfigInvalid) {
          const cause = record.workerConfigError || surfaceConfigError || null;
          const safeTag = (value) =>
            typeof value === "string" && /^[A-Za-z0-9_:-]{1,100}$/.test(value)
              ? value
              : null;
          console.warn(
            "[WorkflowWorkerAdmission]",
            JSON.stringify({
              workflowId: this.workflowId,
              nodeId: record.nodeId,
              provider: node.node_type,
              stage: surfaceConfigError
                ? "web_surface_config"
                : "worker_runtime",
              code: "PROVIDER_WORKER_ADMISSION_UNAVAILABLE",
              causeCode: safeTag(cause?.code || cause?.name),
              configKey: safeTag(cause?.configKey),
              refreshed: record.workerConfigRefresh === "ready",
            }),
          );
          const error = this._error("PROVIDER_WORKER_ADMISSION_UNAVAILABLE");
          error.cause = cause;
          this._settle(record, null, error);
          continue;
        }
        if (workerCandidate && record.workerAdmission === void 0) {
          record.workerAdmission = "checking";
          Promise.resolve()
            .then(() => this.owner._workflowWorkerCapabilities([node], true))
            .then(
              (ready) => {
                record.workerAdmission = ready?.has(node.node_type)
                  ? "ready"
                  : "legacy";
              },
              (error) => {
                record.workerAdmission = "failed";
                record.workerAdmissionError = error;
                console.warn(
                  "[WorkflowWorkerAdmission]",
                  JSON.stringify({
                    nodeId: record.nodeId,
                    provider: node.node_type,
                    code:
                      error?.code ||
                      error?.message ||
                      "PROVIDER_WORKER_ADMISSION_UNAVAILABLE",
                    cause: error?.cause?.code || error?.cause?.message || null,
                  }),
                );
              },
            )
            .finally(() => this._pump());
          continue;
        }
        if (workerCandidate && record.workerAdmission === "checking") continue;
        if (workerCandidate && record.workerAdmission !== "ready") {
          this._settle(
            record,
            null,
            record.workerAdmissionError ||
              this._error("PROVIDER_WORKER_ADMISSION_UNAVAILABLE"),
          );
          continue;
        }
        record.workerLane =
          workerCandidate && record.workerAdmission === "ready";
        record.api =
          record.flow &&
          pipeline &&
          record.options.manualSubmitMode !== true &&
          window.FlowApiAdapter?.isApiModeIntended?.({ forWorkflow: true }) ===
            true;
        const active = [...this.records.values()].filter(
          (r) => r.status === "running" || r.status === "stopping",
        );
        if (
          active.some((other) => this._dependent(other.nodeId, record.nodeId))
        )
          continue;
        if (record.flow) {
          if (
            this.browserRecord ||
            active.some((r) => r.workerLane || r.museApi)
          )
            continue;
        } else if (museApi) {
          if (this.browserStopError) {
            this._settle(record, null, this._error("BROWSER_STOP_UNCONFIRMED"));
            continue;
          }
          if (
            this.browserRecord ||
            active.some(
              (r) =>
                !r.museApi && (!r.flow || !r.api || r.web || !r.overlapReady),
            )
          )
            continue;
          const sameMedia = active.filter(
            (r) =>
              r.museApi &&
              (r.node?.media_type === "Video") ===
                (node.media_type === "Video"),
          );
          if (sameMedia.length >= museLimit) continue;
        } else if (record.workerLane) {
          if (
            this.browserRecord ||
            active.some(
              (r) =>
                r.museApi || (r.flow && (!r.api || r.web || !r.overlapReady)),
            )
          )
            continue;
        } else {
          if (this.browserStopError) {
            const error = this._error("BROWSER_STOP_UNCONFIRMED");
            error.cause = this.browserStopError;
            this._settle(record, null, error);
            continue;
          }
          if (
            this.browserRecord ||
            active.some((r) => !r.flow || !r.api || r.web || !r.overlapReady)
          )
            continue;
        }
        record.status = "running";
        if (node.node_type === "muse")
          console.info(
            "[WorkflowSingleNodeAdmission]",
            JSON.stringify({
              workflowId: this.workflowId,
              nodeId: record.nodeId,
              provider: "muse",
              lane: museApi ? "api" : record.workerLane ? "worker" : "web",
              workerRequired: workerSupported,
            }),
          );
        if (!record.flow && !record.workerLane && !museApi)
          this.browserRecord = record;
        let worker;
        try {
          worker = this.owner._createSingleNodeWorker(this, record);
        } catch (error) {
          this._settle(record, null, error);
          continue;
        }
        record.worker = worker;
        this._changed(record);
        Promise.resolve()
          .then(() =>
            worker._executeSingleNodeOwned(
              this.workflowId,
              record.nodeId,
              record.options,
            ),
          )
          .then(
            (result) => this._settle(record, result),
            (error) => this._settle(record, null, error),
          );
      }
      this._finishIfEmpty();
    }
    admitted(nodeId) {
      const record = this.records.get(String(nodeId));
      if (!record) return;
      record.api = true;
      record.overlapReady = true;
      this._pump();
    }
    async enterApiPreparation(nodeId, cancelled) {
      const record = this.records.get(String(nodeId));
      if (!record) return;
      record.overlapReady = false;
      this._changed();
      while (this.browserRecord) {
        if (this.stopping || cancelled?.() || record.status === "stopping")
          throw this._error("ABORTED");
        await this._waitForChange();
      }
      if (this.stopping || cancelled?.() || record.status === "stopping")
        throw this._error("ABORTED");
    }
    async enterFlowWeb(nodeId, cancelled) {
      const record = this.records.get(String(nodeId));
      if (!record) return;
      record.web = true;
      record.api = false;
      this._changed();
      while (this.browserRecord) {
        if (this.stopping || cancelled?.() || record.status === "stopping")
          throw this._error("ABORTED");
        await this._waitForChange();
      }
      if (this.stopping || cancelled?.() || record.status === "stopping")
        throw this._error("ABORTED");
    }
    _waitForChange() {
      return new Promise((resolve) => {
        this._waiters.add(resolve);
      });
    }
    _changed(record = null) {
      for (const resolve of this._waiters) resolve();
      this._waiters.clear();
      const node =
        record?.node ||
        this.workflow?.nodes?.find((n) => String(n.node_id) === record?.nodeId);
      if (record?.status === "queued")
        window.eventBus?.emit("node:queued", {
          workflowId: this.workflowId,
          node: node || { node_id: record.nodeId },
          nodeId: record.nodeId,
        });
      try {
        this.owner._publishSingleNodeState?.(this);
      } catch (error) {
        console.warn(
          "[WorkflowSingleNode] tracker publication failed:",
          error.message,
        );
      }
    }
    _settle(record, result, error = null) {
      if (!this.records.has(record.nodeId)) return;
      const stopped = record.status === "stopping" || result?.stopped === true;
      if (record.liveNode) {
        const live = this.owner.currentWorkflow?.nodes?.find(
          (n) => String(n.node_id) === record.nodeId,
        );
        if (live) Object.assign(live, record.liveNode);
      }
      if (this.browserRecord === record) this.browserRecord = null;
      this.records.delete(record.nodeId);
      record.status = stopped ? "cancelled" : error ? "failed" : "completed";
      if (error && !stopped) {
        this.error || (this.error = error);
        if (!record.liveNode || error.preSubmitFailure)
          this.owner._publishSingleNodeRejected?.(
            record.nodeId,
            error,
            this.workflowId,
          );
        record.reject(error);
      } else record.resolve(stopped ? { stopped: true } : result);
      this._changed(record);
      this._pump();
      this._finishIfEmpty();
    }
    _finishIfEmpty() {
      if (!this.ready || this.records.size || this.closed) return;
      this.closed = true;
      this._releaseMuseConfigListener();
      this._changed();
      this._resolveDone();
    }
    _releaseMuseConfigListener() {
      if (typeof this._museConfigUnsubscribe === "function")
        this._museConfigUnsubscribe();
      else if (this._museConfigHandler)
        window.eventBus?.off?.(
          "execution_config:refreshed",
          this._museConfigHandler,
        );
      this._museConfigUnsubscribe = null;
      this._museConfigHandler = null;
    }
    fail(error) {
      this.closed = true;
      this._releaseMuseConfigListener();
      this.error || (this.error = error);
      for (const record of [...this.records.values()])
        this._settle(record, null, error);
      this._changed();
      this._resolveDone();
    }
    stopNode(nodeId, stopSource = "WORKFLOW_NODE_STOP") {
      const record = this.records.get(String(nodeId));
      if (!record) return false;
      if (record.status === "queued") {
        this.owner._publishQueuedNodeCancelled?.(
          record.node || { node_id: record.nodeId },
          this.workflowId,
        );
        this._settle(record, { stopped: true });
      } else if (record.status !== "stopping") {
        record.status = "stopping";
        this.owner._stopSingleNodeWorker(record, stopSource);
        this._changed(record);
      }
      return true;
    }
    stopJob(jobId, stopSource) {
      const job = window.PromptQueue?.getInstance?.()?.getJob?.(jobId);
      const record = [...this.records.values()].find(
        (r) =>
          r.id === jobId ||
          r.worker?._geminiTrackerJobs?.has(jobId) ||
          (job?.workflowRunId === this.owner._flowRunId &&
            String(job.workflowNodeId) === r.nodeId),
      );
      return record ? this.stopNode(record.nodeId, stopSource) : false;
    }
    haltPending() {
      this.stopping = true;
      for (const record of [...this.records.values()])
        if (record.status === "queued") {
          this.owner._publishQueuedNodeCancelled?.(
            record.node || { node_id: record.nodeId },
            this.workflowId,
          );
          this._settle(record, { stopped: true });
        }
      this._changed();
      this._finishIfEmpty();
    }
    stopAll(stopSource) {
      this.stopping = true;
      for (const record of [...this.records.values()])
        this.stopNode(record.nodeId, stopSource);
      this._changed();
      this._finishIfEmpty();
    }
    state() {
      return [...this.records.values()].map((r) => {
        const status =
          r.status === "running" && r.generationStarted !== true
            ? "queued"
            : r.status;
        return {
          nodeId: r.nodeId,
          jobId: r.id,
          status,
          provider:
            r.node?.node_type === "generate"
              ? "flow"
              : r.node?.node_type || null,
          ...(status === "queued" ? this.waitingFor(r) : {}),
        };
      });
    }
    trackerJobs() {
      const queue = window.PromptQueue?.getInstance?.();
      const liveFlowIds = new Set(
        (queue?.getJobsByOwner?.("workflow") || [])
          .filter(
            (j) =>
              j.workflowRunId === this.owner._flowRunId &&
              ["running", "paused", "pending", "queued", "preparing"].includes(
                j.state,
              ),
          )
          .map((j) => j.workflowNodeId),
      );
      return [...this.records.values()]
        .filter((r) => !liveFlowIds.has(r.nodeId))
        .map((r) => ({
          id: r.id,
          sessionId: this.owner._flowRunId,
          owner: "workflow",
          workflowId: this.workflowId,
          workflowNodeId: r.nodeId,
          label: r.node?.node_name || r.nodeId,
          provider: r.node?.node_type || "workflow",
          singleNodeSession: true,
          status: "running",
          totalExpected: 1,
          completedCount: 0,
          failedCount: 0,
          createdAt: r.createdAt,
          startedAt: r.createdAt,
          items: [
            {
              id: r.nodeId,
              promptIndex: 0,
              promptText: r.node?.prompt || "",
              state:
                r.status === "queued"
                  ? "PENDING"
                  : r.status === "stopping"
                    ? "CANCELLED"
                    : r.trackerState || "MONITORING",
            },
          ],
        }));
    }
  }
  window.WorkflowSingleNodeSession = WorkflowSingleNodeSession;
})();
