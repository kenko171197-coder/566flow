(function () {
  "use strict";
  let documentId = null,
    cachedQueue = null,
    cachedJobs = null,
    releaseTimer = null;
  const operations = new Map();
  chrome.runtime
    .sendMessage({ action: "workflowSpaceHealthIdentify" })
    .then((result) => {
      documentId = result?.documentId || null;
    })
    .catch(() => {});
  const reduce = (snapshot2) =>
    (snapshot2?.jobs || [])
      .filter((job) => job.owner === "workflow")
      .map((job) => ({
        id: job.id,
        owner: job.owner,
        workflowId: job.workflowId,
        workflowNodeId: job.workflowNodeId,
        workflowRunId: job.workflowRunId,
        status: job.status,
        pauseReason: job.pauseReason,
        items: (job.items || []).map((item) => ({
          state: item.state,
          promptIndex: item.promptIndex,
          statusKind: item.statusKind,
          statusLabel: item.statusLabel,
          statusReason: item.statusReason,
          statusHint: item.statusHint,
          operationId: !!item.operationId,
          flowApiAccepted: item.flowApiAccepted === true,
          errorType: item.errorType,
          errorPolicy: { ambiguous: item.errorPolicy?.ambiguous === true },
        })),
      }));
  const update = (snapshot2) => {
    cachedJobs = reduce(snapshot2);
  };
  function snapshot(queue) {
    if (cachedQueue !== queue) {
      window.eventBus?.off?.("queue:state_changed", update);
      cachedQueue = queue;
      cachedJobs = null;
      window.eventBus?.on?.("queue:state_changed", update);
    }
    if (!cachedJobs) update(queue.getSnapshot());
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => {
      window.eventBus?.off?.("queue:state_changed", update);
      cachedQueue = cachedJobs = null;
    }, 6e4);
    return { jobs: cachedJobs };
  }
  function owner(message) {
    const userId = String(window.authManager?.getUser?.()?.id || "");
    if (!userId || userId !== String(message.userId || ""))
      throw Error("QUEUE_ACCOUNT_MISMATCH");
    const executor = window.workflowExecutor,
      workflow = executor?.currentWorkflow;
    if (
      !workflow ||
      String(workflow.user_id || "") !== userId ||
      workflow.wf_id !== message.workflowId ||
      !executor._flowRunId
    )
      throw Error("QUEUE_OWNER_CONTEXT_REQUIRED");
    const queue = window.PromptQueue?._instance;
    if (!queue || !window.WorkflowSpaceQueuePresentation)
      throw Error("QUEUE_OWNER_CONTEXT_REQUIRED");
    const nodes = new Map(
      (workflow.nodes || []).map((node) => [node.node_id, node]),
    );
    for (const record of executor._singleNodeSession?.records?.values?.() || [])
      if (record.liveNode) nodes.set(record.liveNode.node_id, record.liveNode);
    return {
      executor,
      queue,
      workflow: { ...workflow, nodes: [...nodes.values()] },
    };
  }
  function read(message) {
    const context = owner(message);
    const nodes = window.WorkflowSpaceQueuePresentation(
      context.workflow,
      snapshot(context.queue),
      context.executor._flowRunId,
      (key) => window.I18n?.t(key) || "",
    );
    return {
      ok: true,
      nodes: nodes.map((entry) => ({
        ...entry,
        pause: entry.pause
          ? {
              ...entry.pause,
              stopsWorkflow: context.executor.isRunning === true,
            }
          : null,
      })),
    };
  }
  function signature(message) {
    return JSON.stringify([
      String(message.userId),
      message.workflowId,
      message.queueAction,
      message.nodeId,
      message.jobId,
      message.runId,
    ]);
  }
  async function handle(message) {
    const userId = String(window.authManager?.getUser?.()?.id || "");
    if (!userId || userId !== String(message.userId || ""))
      throw Error("QUEUE_ACCOUNT_MISMATCH");
    if (message.operation === "read") return read(message);
    const key = `${message.userId}:${message.operationId}`,
      sig = signature(message),
      previous = operations.get(key);
    if (previous) {
      if (previous.signature !== sig) throw Error("QUEUE_OPERATION_CONFLICT");
      return previous.response || { ok: true, stage: "pending" };
    }
    if (message.operation === "status")
      return { ok: false, error: "QUEUE_RESULT_UNKNOWN" };
    const context = owner(message);
    if (
      message.operation !== "start" ||
      !["resume", "stop"].includes(message.queueAction)
    )
      throw Error("INVALID_QUEUE_OPERATION");
    const pause = read(message).nodes.find(
      (entry2) => entry2.nodeId === message.nodeId,
    )?.pause;
    const job = context.queue.getJob(message.jobId);
    if (
      !pause ||
      pause.jobId !== message.jobId ||
      pause.runId !== message.runId ||
      context.executor._flowRunId !== message.runId ||
      !job ||
      job.owner !== "workflow" ||
      job.workflowId !== message.workflowId ||
      job.workflowNodeId !== message.nodeId ||
      job.workflowRunId !== message.runId ||
      job.state !== "paused"
    )
      throw Error("QUEUE_PAUSE_CHANGED");
    const active = [...operations.values()].find(
      (entry2) => entry2.signature === sig && !entry2.response,
    );
    if (active) {
      operations.set(key, active);
      return { ok: true, stage: "pending" };
    }
    const entry = { signature: sig, response: null };
    operations.set(key, entry);
    console.info("[WorkflowSpaceQueue]", {
      operationId: message.operationId,
      action: message.queueAction,
      stage: "dispatched",
    });
    (async () => {
      try {
        owner(message);
        if (message.queueAction === "resume") {
          if ((await context.queue.resumeJob(job.id)) !== true)
            throw Error(
              context.queue._lastResumeError || "FLOW_RECOVERY_RESUME_BLOCKED",
            );
        } else if (context.executor.isSingleNodeActive?.(message.nodeId)) {
          await context.executor.stopSingleNode(
            message.nodeId,
            "EDITOR_PAUSED_NODE_STOP",
          );
        } else if (context.executor.isRunning) {
          await context.executor.stop(
            true,
            false,
            "WORKFLOW_EDITOR_PAUSED_NODE_STOP",
          );
        } else throw Error("QUEUE_PAUSE_CHANGED");
        entry.response = { ok: true, stage: "done" };
      } catch (error) {
        entry.response = {
          ok: false,
          stage: "failed",
          error: error?.message || "QUEUE_ACTION_FAILED",
        };
      }
      console.info("[WorkflowSpaceQueue]", {
        operationId: message.operationId,
        action: message.queueAction,
        stage: entry.response.stage,
        code: entry.response.error || null,
      });
      cachedJobs = null;
    })();
    return { ok: true, stage: "pending" };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (
      message?.action !== "workflowSpaceNativeQueue" ||
      sender.id !== chrome.runtime.id ||
      !documentId ||
      message.documentId !== documentId
    )
      return;
    handle(message).then(
      (result) => {
        const currentUser = String(window.authManager?.getUser?.()?.id || "");
        reply(
          currentUser === String(message.userId || "")
            ? result
            : { ok: false, error: "QUEUE_ACCOUNT_CHANGED" },
        );
      },
      (error) =>
        reply({
          ok: false,
          ...(message.operation === "start" ? { stage: "failed" } : {}),
          error: error?.message || "QUEUE_RESULT_UNKNOWN",
        }),
    );
    return true;
  });
})();
