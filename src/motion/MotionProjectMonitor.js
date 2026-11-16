class MotionProjectMonitor {
  static apiFailureCode(result) {
    const reasons = [result?.failureReasons, result?.rawStatus?.failureReasons]
      .flat()
      .filter(Boolean);
    const failure = result?.failureReason;
    return MotionFlowQueueRequest.errorCode(
      result?.providerErrorCodes,
      reasons.map((reason) =>
        typeof reason === "string"
          ? reason
          : [reason?.code, reason?.message, reason?.reason],
      ),
      typeof failure === "string"
        ? failure
        : [failure?.code, failure?.message, failure?.reason],
      result?.code,
      result?.error,
    );
  }
  static async apiReceipt({
    frame,
    owner,
    flowTarget,
    queueItemId = frame.run_id,
  }) {
    const submit = frame.stages?.submit;
    if (
      !submit?.provider_operation_id ||
      submit.flow_mode !== "api" ||
      !["v1", "v2"].includes(submit.api_driver) ||
      !submit.protocol_revision
    )
      throw new Error("MOTION_MONITOR_RECEIPT_REQUIRED");
    const operationId = submit.provider_operation_id;
    if (submit.api_driver === "v2") {
      const config = await window.ProviderConfigManager.fetchFlowApiV2Configs();
      if (
        !config ||
        Number(config.protocol?.schema_version) !==
          Number(submit.protocol_revision) ||
        window.FlowApiV2CheckpointStore.fingerprint(config) !==
          submit.protocol_fingerprint
      )
        throw new Error("MOTION_MONITOR_PROTOCOL_CHANGED");
      const captured2 = (
        await chrome.storage.local.get(window.FlowApiV2CheckpointStore.KEY)
      )?.[window.FlowApiV2CheckpointStore.KEY]?.[operationId];
      if (
        captured2 &&
        (captured2.itemId !== queueItemId ||
          captured2.projectId !== flowTarget.projectId ||
          captured2.protocolFingerprint !== submit.protocol_fingerprint)
      )
        throw new Error("MOTION_MONITOR_RECEIPT_MISMATCH");
      const acceptedAt = Date.parse(submit.updated_at || "");
      if (!captured2 && !(acceptedAt > 0))
        throw new Error("MOTION_MONITOR_DEADLINE_MISSING");
      const item = {
        id: queueItemId,
        attemptId: captured2?.attemptId || queueItemId,
        projectId: flowTarget.projectId,
        settings: { genType: "Video" },
        operationId,
        flowOperationId: operationId,
        flowApiAccepted: true,
        flowApiDriver: "v2",
        flowApiTabId: flowTarget.tabId,
        flowApiProtocolRevision: submit.protocol_revision,
        flowApiProtocolFingerprint: submit.protocol_fingerprint,
        flowApiDispatchedAt: captured2?.dispatchedAt || acceptedAt,
        ...(captured2?.operationDeadlineAt && {
          flowApiOperationDeadlineAt: captured2.operationDeadlineAt,
        }),
      };
      const outputs = await window.FlowApiV2Driver._drainAccepted(
        item,
        [
          {
            operationId,
            mediaId: captured2?.mediaId || submit.provider_media_id || null,
            state: "accepted",
          },
        ],
        config,
        { owner: "motion", abortFn: () => false },
      );
      const output = outputs?.length === 1 && outputs[0];
      if (output?.operationId !== operationId)
        throw new Error("MOTION_MONITOR_RECEIPT_MISMATCH");
      if (window.FlowApiV2Driver._isFailed(output))
        return {
          failed: true,
          error: this.apiFailureCode(
            window.FlowApiDriverError?.fromFailedOutputs?.([output]),
          ),
          operationId,
        };
      if (
        !window.FlowApiV2Driver._isCompleted(output) ||
        !window.FlowApiV2Driver._uuid(output.mediaId)
      )
        throw new Error("MOTION_MONITOR_RESULT_UNVERIFIED");
      return {
        provider_operation_id: operationId,
        provider_media_id: output.mediaId,
        flow_mode: "api",
        api_driver: "v2",
        protocol_revision: submit.protocol_revision,
        protocol_fingerprint: submit.protocol_fingerprint,
      };
    }
    const adapter = window.FlowApiAdapter;
    const captured = (await chrome.storage.local.get(adapter.CHECKPOINT_KEY))?.[
      adapter.CHECKPOINT_KEY
    ]?.[operationId];
    if (
      !captured ||
      captured.itemId !== queueItemId ||
      captured.projectId !== flowTarget.projectId ||
      (captured.driver && captured.driver !== "v1") ||
      !captured.mediaId
    )
      throw new Error("MOTION_MONITOR_RECEIPT_MISMATCH");
    const limits = adapter._rl(),
      interval = Number(limits.poll_interval_ms),
      timeout = Number(limits.video_timeout_ms);
    if (!(interval > 0) || !(timeout > 0) || !(captured.submittedAt > 0))
      throw new Error("MOTION_MONITOR_DEADLINE_MISSING");
    const deadline = captured.submittedAt + timeout;
    while (Date.now() < deadline) {
      const result = await adapter._bridgeFlow("flow_poll_video", {
        config: adapter._rawConfig(),
        mediaId: captured.mediaId,
        projectId: flowTarget.projectId,
      });
      if (result?.ok && result.status === "failed")
        return {
          failed: true,
          error: this.apiFailureCode(result),
          operationId,
        };
      if (result?.ok && result.status === "done")
        return {
          provider_operation_id: operationId,
          provider_media_id: captured.mediaId,
          flow_mode: "api",
          api_driver: "v1",
          protocol_revision: submit.protocol_revision,
        };
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(interval, Math.max(0, deadline - Date.now())),
        ),
      );
    }
    throw new Error("MOTION_MONITOR_TIMEOUT");
  }
  static async webReceipt({
    frame,
    owner,
    flowTarget,
    queueItemId = frame.run_id,
  }) {
    const records =
      (await chrome.storage.local.get("flow_web_recovery_v1"))
        .flow_web_recovery_v1 || [];
    const record = records.find(
      (item2) =>
        item2.id === queueItemId &&
        item2.projectId === flowTarget.projectId &&
        item2.snapshot?._owner === "motion" &&
        Number(item2.snapshot.accountId) === owner.userId,
    );
    const saved = record?.attempts?.at(-1)?.correlation;
    if (
      !saved ||
      saved.attemptId !== record.attempts.at(-1).id ||
      saved.projectId !== flowTarget.projectId ||
      saved.mediaType !== "video" ||
      saved.expectedQuantity !== 1 ||
      saved.expiresAt <= Date.now() ||
      record.snapshot._flowTabId !== flowTarget.tabId
    )
      throw new Error("MOTION_MONITOR_RECEIPT_REQUIRED");
    const broker = window.flowV2CorrelationBroker;
    if (!broker || broker._attempts.has(saved.attemptId))
      throw new Error("MOTION_MONITOR_ALREADY_ACTIVE");
    const budget = saved.readBudget;
    if (
      !(
        Number.isFinite(budget?.receiptTimeoutMs) && budget.receiptTimeoutMs > 0
      ) ||
      !(
        Number.isFinite(budget?.requestBindTimeoutMs) &&
        budget.requestBindTimeoutMs > 0
      )
    )
      throw new Error("MOTION_MONITOR_CONFIG_UNAVAILABLE");
    const capability = {
      observable: true,
      parallel: false,
      receiptTimeoutMs: budget.receiptTimeoutMs,
      requestBindTimeoutMs: budget.requestBindTimeoutMs,
      attemptTtlMs: saved.expiresAt - saved.createdAt,
    };
    const attempt = {
      ...saved,
      capability,
      expectedRequestCount: 1,
      lastSequence: 0,
      receipts: [],
      children: [],
      operationIds: [],
      mediaIds: [],
      strong: false,
      skipVideoResultWatch: true,
      targetContext: flowTarget,
    };
    const item = {
      ...record.snapshot,
      id: queueItemId,
      attemptId: saved.attemptId,
      state: "MONITORING",
    };
    broker._attempts.set(saved.attemptId, attempt);
    try {
      await broker.observeAfterSubmit(item);
      if (
        item.flowCorrelationReceipt?.strong !== true ||
        item.flowCorrelationReceipt.children?.length !== 1
      )
        throw new Error("MOTION_MONITOR_RESULT_UNVERIFIED");
      if (
        item.flowCorrelationReceipt.children.some(
          (child2) => !["completed", "failed"].includes(child2.status),
        )
      )
        await broker._waitForVideoResultEvidence(item, attempt);
      const child = item.flowCorrelationReceipt?.children?.[0];
      if (child?.status === "failed")
        return {
          failed: true,
          error: MotionFlowQueueRequest.errorCode(child.errorCodes),
          operationId: child.operationId,
        };
      if (child?.status !== "completed" || !child.mediaId || !child.operationId)
        throw new Error("MOTION_MONITOR_RESULT_UNVERIFIED");
      return {
        provider_operation_id: child.operationId,
        provider_media_id: child.mediaId,
        flow_mode: "web",
      };
    } finally {
      if (broker._attempts.get(saved.attemptId) === attempt)
        broker._attempts.delete(saved.attemptId);
    }
  }
  static async run({
    owner,
    operationId,
    operation,
    journal,
    api,
    assertScope,
    flowTarget,
    mode,
  }) {
    const endpoint = `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`;
    const fresh = async () => {
      await assertScope();
      const run2 = await journal.get(owner);
      journal._owned(run2, owner);
      if (
        run2.runId !== owner.runId ||
        run2.flowProjectId !== flowTarget.projectId ||
        JSON.stringify(run2.operations?.[operationId]) !==
          JSON.stringify(operation)
      )
        throw new Error("MOTION_RUN_FENCED");
      const project = await api("GET", endpoint);
      await assertScope();
      const frame2 = project?.data_json?.frames?.[operation.frameId];
      if (
        project?.tool_project_id !== owner.toolProjectId ||
        project.flow_project_id !== run2.flowProjectId ||
        Number(project.data_json?.source_revision) !== run2.sourceRevision ||
        frame2?.run_id !== operation.frameRunId ||
        frame2?.input_revision !== operation.inputRevision ||
        project.data_json.flow_run_mode !== mode
      )
        throw new Error("MOTION_MONITOR_SCOPE_CHANGED");
      return { project, frame: frame2 };
    };
    let { frame } = await fresh();
    if (frame.stages?.monitor?.state === "ready") return { state: "ready" };
    if (operation.stage !== "flow")
      throw new Error("MOTION_MONITOR_RECEIPT_REQUIRED");
    if (
      operation.queueItemId !== void 0 &&
      operation.queueItemId !== operationId
    )
      throw new Error("MOTION_MONITOR_RECEIPT_MISMATCH");
    const terminalFailure = [frame.stages?.monitor, frame.stages?.submit].find(
      (stage) =>
        stage?.state === "failed" &&
        stage.retry_exhausted === true &&
        (!stage.flow_mode || stage.flow_mode === mode) &&
        /^[A-Z][A-Z0-9_]{0,99}$/.test(stage.error_code || ""),
    );
    if (terminalFailure) {
      await fresh();
      await journal.settle({
        ...owner,
        operationId,
        ...operation,
        outcome: "rejected",
      });
      console.info(
        "[MotionMonitorRecovery]",
        JSON.stringify({
          stage: "terminal_failure_reconciled",
          frameId: operation.frameId,
          operationId,
          code: terminalFailure.error_code,
        }),
      );
      return { state: "failed", error: terminalFailure.error_code };
    }
    const queueItemId = operation.queueItemId || frame.run_id;
    const receipt =
      mode === "api"
        ? await this.apiReceipt({ frame, owner, flowTarget, queueItemId })
        : await this.webReceipt({ frame, owner, flowTarget, queueItemId });
    const write = async (stage, state, extra) => {
      const latest = await fresh();
      const body = {
        source_revision: latest.project.data_json.source_revision,
        run_id: latest.frame.run_id,
        input_revision: latest.frame.input_revision,
        stage,
        state,
        ...extra,
        request_nonce: crypto.randomUUID(),
      };
      try {
        await api(
          "PATCH",
          `${endpoint}/frames/${encodeURIComponent(operation.frameId)}/checkpoint`,
          body,
        );
      } catch (error) {
        const current = (await fresh()).frame;
        const checked = current.stages?.[stage];
        if (
          checked?.state !== state ||
          Object.entries(extra).some(([key, value]) =>
            key === "persist_artifact_id"
              ? current.stages?.persist?.artifact_id !== value ||
                !["running", "ready"].includes(current.stages.persist.state)
              : checked[key] !== value,
          )
        )
          throw error;
      }
    };
    await fresh();
    if (receipt.failed) {
      const code = MotionFlowQueueRequest.errorCode(receipt.error);
      await write("monitor", "failed", {
        error_code: code,
        retry_exhausted: true,
        flow_mode: mode,
      });
      await journal.settle({
        ...owner,
        operationId,
        ...operation,
        outcome: "rejected",
      });
      return { state: "failed", error: code };
    }
    if (frame.stages?.submit?.state !== "ready") {
      const run2 = await journal.get(owner);
      await write("submit", "ready", {
        ...receipt,
        profile_revision: run2.profileRevision,
      });
    }
    const run = await journal.get(owner);
    await write("monitor", "ready", {
      ...receipt,
      persist_artifact_id: `result_${run.sourceRevision}_${operation.frameId}_${operation.inputRevision}_${operationId}`,
    });
    return { state: "ready" };
  }
}
globalThis.MotionProjectMonitor = MotionProjectMonitor;
