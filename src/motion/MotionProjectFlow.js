class MotionProjectFlow {
  static async run(options) {
    try {
      return await this._run(options);
    } catch (error) {
      if (error && typeof error === "object") error.dispatchStarted = false;
      throw error;
    }
  }
  static async _run({
    owner,
    frameId,
    profileRevision,
    mode,
    flowTarget,
    api,
    journal,
    assertScope,
    shouldStop,
    buildRequest,
    queue,
    deferSettlement = false,
    onStage = () => {},
    onQueueAdmitted = () => {},
    isForceStopped = () => false,
    waitForAdmission = async () => {},
  }) {
    if (
      !owner ||
      !frameId ||
      !Number.isSafeInteger(profileRevision) ||
      profileRevision < 1 ||
      !["web", "api"].includes(mode) ||
      !flowTarget?.projectId ||
      !journal ||
      !queue?.submitJob ||
      [api, assertScope, shouldStop, buildRequest].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_FLOW_CONFIG_INVALID");
    const endpoint = `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`;
    await assertScope();
    const run = await journal.get(owner);
    if (
      !run ||
      run.runId !== owner.runId ||
      run.state !== "running" ||
      run.profileRevision !== profileRevision ||
      run.flowProjectId !== flowTarget.projectId
    )
      throw new Error("MOTION_FLOW_SCOPE_INVALID");
    journal._owned(run, owner);
    let preparedFrame = null;
    let providerFailureCode = null,
      providerFailureAttempt = null;
    const scopeError = (code, stage, current) =>
      MotionFlowQueueRequest.scopeError?.(code, {
        frameId,
        stage,
        current,
        runId: owner.runId,
        sourceRevision: run.sourceRevision,
        inputRevision: preparedFrame?.input_revision ?? null,
        profileRevision,
        providerCode: providerFailureCode,
        onStage,
      }) || new Error(code);
    const fresh = async () => {
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      const project2 = await api("GET", endpoint);
      await assertScope();
      journal._owned(await journal.get(owner), owner);
      if (
        project2?.tool_project_id !== owner.toolProjectId ||
        project2.flow_project_id !== run.flowProjectId
      )
        throw scopeError(
          "MOTION_FLOW_PROJECT_CHANGED",
          "project_read",
          project2,
        );
      if (Number(project2.data_json?.source_revision) !== run.sourceRevision)
        throw scopeError(
          "MOTION_FLOW_SOURCE_CHANGED",
          "project_read",
          project2,
        );
      if (project2.data_json?.flow_run_mode !== mode)
        throw scopeError("MOTION_FLOW_MODE_CHANGED", "project_read", project2);
      if (project2.data_json?.requires_resplit)
        throw scopeError(
          "MOTION_SOURCE_REQUIRES_RESPLIT",
          "project_read",
          project2,
        );
      return project2;
    };
    let project = await fresh();
    const frame = project.data_json?.frames?.[frameId];
    preparedFrame = frame;
    if (
      !frame ||
      frame.stages?.split?.state !== "ready" ||
      frame.stages?.upload?.state !== "ready"
    )
      throw new Error("MOTION_PREPARATION_NOT_READY");
    const previous = frame.stages?.submit;
    const rejected = run.rejectedFlows?.[`frame:${frameId}`];
    const knownUnsent =
      previous?.state === "failed" &&
      ["MOTION_CANCELLED", "MOTION_FLOW_PRE_DISPATCH_FAILED"].includes(
        previous.error_code,
      ) &&
      previous.retry_exhausted === false &&
      rejected?.errorCode === previous.error_code &&
      rejected.frameRunId === frame.run_id &&
      rejected.inputRevision === frame.input_revision;
    if (
      (previous?.state && !knownUnsent) ||
      Object.values(run.operations || {}).some(
        (op2) => op2.stage === "flow" && op2.frameId === frameId,
      )
    ) {
      providerFailureCode =
        frame.stages?.monitor?.error_code || previous?.error_code || null;
      scopeError(
        "MOTION_SUBMIT_RECONCILE_REQUIRED",
        previous?.state ? "existing_checkpoint" : "pending_flow_operation",
        project,
      );
      return {
        state: "needs_review",
        error: "MOTION_SUBMIT_RECONCILE_REQUIRED",
      };
    }
    if (shouldStop() || project.data_json?.paused) return { state: "paused" };
    const request = await buildRequest(project, frame);
    let flowRetryCount = Number.isSafeInteger(previous?.retry_count)
      ? previous.retry_count
      : 0;
    if (request) request.generationProcessId = owner.runId;
    if (!request || request.flowModeLock !== mode)
      throw new Error("MOTION_FLOW_MODE_CHANGED");
    const checkpoint = async (stage, state, extra = {}) => {
      const body = {
        source_revision: run.sourceRevision,
        run_id: frame.run_id,
        input_revision: frame.input_revision,
        stage,
        state,
        ...(stage === "submit"
          ? {
              profile_revision: profileRevision,
              ...(flowRetryCount > 0 && { retry_count: flowRetryCount }),
            }
          : {}),
        ...extra,
        request_nonce: crypto.randomUUID(),
      };
      if (knownUnsent && stage === "submit" && state === "running")
        body.resume_pre_dispatch = true;
      try {
        await assertScope();
        journal._owned(await journal.get(owner), owner);
        return await api(
          "PATCH",
          `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
          body,
        );
      } catch (error) {
        const current = await fresh().catch(() => null);
        const savedFrame = current?.data_json?.frames?.[frameId];
        const saved = savedFrame?.stages?.[stage];
        if (
          savedFrame?.run_id === frame.run_id &&
          savedFrame?.input_revision === frame.input_revision &&
          saved?.state === state &&
          Object.entries(extra).every(([key, value]) =>
            key === "persist_artifact_id"
              ? savedFrame.stages?.persist?.artifact_id === value &&
                ["running", "ready"].includes(savedFrame.stages.persist.state)
              : (saved[key] ?? null) === (value ?? null),
          )
        )
          return current;
        throw error;
      }
    };
    await waitForAdmission();
    const operationId = crypto.randomUUID();
    const op = {
      ...owner,
      operationId,
      queueItemId: operationId,
      frameId,
      frameRunId: frame.run_id,
      inputRevision: frame.input_revision,
      stage: "flow",
    };
    const persistArtifactId = `result_${run.sourceRevision}_${frameId}_${frame.input_revision}_${op.operationId}`;
    if (deferSettlement && persistArtifactId.length > 160)
      throw new Error("MOTION_ARTIFACT_ID_INVALID");
    request.itemIds = [op.queueItemId];
    await journal.markSubmitted(op);
    let dispatched = false,
      acceptance = null,
      acceptedReceipt = null,
      stoppedBeforeSubmit = false,
      guardFailure = null;
    let jobId = null;
    let submitPrepared = false,
      submitReported = false;
    try {
      project = await fresh();
      const currentFrame = project.data_json?.frames?.[frameId];
      if (
        shouldStop() ||
        project.data_json?.paused ||
        currentFrame?.run_id !== frame.run_id ||
        currentFrame?.input_revision !== frame.input_revision
      ) {
        await checkpoint("submit", "failed", {
          error_code: "MOTION_CANCELLED",
          retry_exhausted: false,
        });
        await journal.settle({
          ...op,
          outcome: "rejected",
          notDispatched: true,
          errorCode: "MOTION_CANCELLED",
        });
        return { state: "paused" };
      }
      request.onMotionAccepted = (data) => {
        if (isForceStopped()) return;
        if (
          acceptance ||
          mode !== "api" ||
          !data?.operationId ||
          !["v1", "v2"].includes(data.apiDriver) ||
          !data.protocolRevision ||
          (data.apiDriver === "v2" && !data.protocolFingerprint)
        )
          return;
        const accepted2 = {
          provider_operation_id: data.operationId,
          flow_mode: mode,
          api_driver: data.apiDriver,
          protocol_revision: data.protocolRevision,
          ...(data.protocolFingerprint
            ? { protocol_fingerprint: data.protocolFingerprint }
            : {}),
        };
        acceptedReceipt = accepted2;
        console.info(
          "[MotionFlowAudit]",
          JSON.stringify({
            runId: owner.runId,
            frameId,
            operationId: op.operationId,
            stage: "provider_accepted",
            mode,
            at: Date.now(),
          }),
        );
        acceptance = checkpoint("submit", "ready", accepted2)
          .then(() => checkpoint("monitor", "running", accepted2))
          .then(() => true);
        acceptance.catch(() => {});
      };
      request.onQueueAdmitted = (admission) => {
        jobId = admission.jobId;
        onQueueAdmitted({ jobId, queue, frameId });
      };
      request.onMotionProviderResult = (diagnostic) => {
        if (isForceStopped()) return;
        if (["retrying", "retry_queued"].includes(diagnostic?.state))
          providerFailureCode = null;
        if (
          (diagnostic?.state === "failed" ||
            (diagnostic?.state === "paused" &&
              diagnostic.reason === "flow_quota")) &&
          /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(diagnostic.code || "")
        )
          providerFailureCode = diagnostic.code;
        try {
          onStage({
            frameId,
            stage: "flow",
            ...(["retrying", "retry_queued"].includes(diagnostic.state) && {
              detail: "retrying",
            }),
            apiDiagnostic: {
              phase: "provider_result",
              operation: "monitor",
              eventState: diagnostic.state,
              code: diagnostic.code || null,
              retryCount: diagnostic.retryCount || null,
            },
            ...(diagnostic.state === "paused" &&
              ["api_unusual_activity", "flow_quota"].includes(
                diagnostic.reason,
              ) && {
                state: "paused",
                detail: "paused",
                pauseReason: diagnostic.reason,
                error: diagnostic.code || providerFailureCode,
              }),
          });
        } catch (_) {}
      };
      request.onBeforeMotionSubmit = async (item) => {
        try {
          const attempt = item?.attemptId || item?.id;
          const retryPresentation =
            submitReported && attempt && attempt !== providerFailureAttempt;
          if (attempt && attempt !== providerFailureAttempt) {
            providerFailureAttempt = attempt;
            providerFailureCode = null;
          }
          let latest = await fresh(),
            current = latest.data_json?.frames?.[frameId];
          if (shouldStop() || latest.data_json?.paused) {
            stoppedBeforeSubmit = true;
            throw new Error("MOTION_CANCELLED");
          }
          if (!submitPrepared) {
            if (
              current?.run_id !== frame.run_id ||
              current?.input_revision !== frame.input_revision
            )
              throw scopeError(
                "MOTION_FLOW_FRAME_CHANGED",
                "submit_prepare",
                latest,
              );
            if (
              latest.data_json?.preferences?.continuity_enabled === true ||
              request.continuity
            )
              MotionContinuity.assertCurrent(
                latest,
                frameId,
                request.continuity?.binding,
              );
            await checkpoint("submit", "running", {
              flow_mode: mode,
              ...(request.continuity && {
                continuity: {
                  ...request.continuity.binding,
                  reference_uuid: request.continuity.reference.media_uuid,
                },
              }),
            });
            submitPrepared = true;
            latest = await fresh();
            current = latest.data_json?.frames?.[frameId];
          }
          if (
            current?.run_id !== frame.run_id ||
            current?.input_revision !== frame.input_revision
          )
            throw scopeError(
              "MOTION_FLOW_FRAME_CHANGED",
              "submit_checkpoint",
              latest,
            );
          if (current?.stages?.submit?.state === "ready" && mode === "api") {
            if (current.stages.submit.flow_mode !== mode)
              throw scopeError(
                "MOTION_FLOW_SUBMIT_MODE_CHANGED",
                "submit_checkpoint",
                latest,
              );
            if (current.stages.submit.profile_revision !== profileRevision)
              throw scopeError(
                "MOTION_FLOW_PROFILE_CHANGED",
                "submit_checkpoint",
                latest,
              );
            const retry = MotionFlowQueueRequest.confirmedRetry?.(
              item,
              current.stages.submit,
              acceptedReceipt,
              op.queueItemId,
            );
            if (retry) {
              await acceptance;
              await checkpoint("monitor", "failed", {
                ...acceptedReceipt,
                error_code: retry.code,
                retry_exhausted: false,
              });
              const nextRetryCount = flowRetryCount + 1;
              await checkpoint("submit", "running", {
                flow_mode: mode,
                retry_count: nextRetryCount,
                retry_previous_operation_id: retry.previousOperationId,
                ...(request.continuity && {
                  continuity: {
                    ...request.continuity.binding,
                    reference_uuid: request.continuity.reference.media_uuid,
                  },
                }),
              });
              flowRetryCount = nextRetryCount;
              acceptance = null;
              acceptedReceipt = null;
              providerFailureCode = null;
              latest = await fresh();
              current = latest.data_json?.frames?.[frameId];
              try {
                onStage({
                  frameId,
                  stage: "flow",
                  detail: "retrying",
                  apiDiagnostic: {
                    phase: "flow_retry",
                    operation: "replace_failed_attempt",
                    eventState: "running",
                    code: retry.code,
                    retryCount: flowRetryCount,
                  },
                });
              } catch (_) {}
            }
          }
          if (
            current?.run_id !== frame.run_id ||
            current?.input_revision !== frame.input_revision
          )
            throw scopeError(
              "MOTION_FLOW_FRAME_CHANGED",
              "submit_checkpoint",
              latest,
            );
          if (current?.stages?.submit?.state !== "running")
            throw scopeError(
              "MOTION_FLOW_SUBMIT_STATE_CHANGED",
              "submit_checkpoint",
              latest,
            );
          if (current.stages.submit.flow_mode !== mode)
            throw scopeError(
              "MOTION_FLOW_SUBMIT_MODE_CHANGED",
              "submit_checkpoint",
              latest,
            );
          if (current.stages.submit.profile_revision !== profileRevision)
            throw scopeError(
              "MOTION_FLOW_PROFILE_CHANGED",
              "submit_checkpoint",
              latest,
            );
          const target = await MessageBridge.getTargetContext(flowTarget);
          if (
            !target ||
            ["tabId", "projectId", "driverKey", "origin"].some(
              (key) => target[key] !== flowTarget[key],
            )
          )
            throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
          if (shouldStop() || latest.data_json?.paused) {
            stoppedBeforeSubmit = true;
            throw new Error("MOTION_CANCELLED");
          }
          if (
            latest.data_json?.preferences?.continuity_enabled === true ||
            request.continuity
          )
            MotionContinuity.assertCurrent(
              latest,
              frameId,
              request.continuity?.binding,
            );
          if (!submitReported) {
            submitReported = true;
            console.info(
              "[MotionFlowAudit]",
              JSON.stringify({
                runId: owner.runId,
                frameId,
                operationId: op.operationId,
                stage: "submit_preflight_ready",
                mode,
                at: Date.now(),
              }),
            );
            try {
              onStage({ frameId, stage: "flow", detail: "running" });
            } catch (_) {}
          } else if (retryPresentation) {
            try {
              onStage({ frameId, stage: "flow", detail: "retrying" });
            } catch (_) {}
          }
        } catch (error) {
          guardFailure =
            error?.code || error?.message || "MOTION_FLOW_PRE_DISPATCH_FAILED";
          throw Object.assign(error, {
            preSubmitFailure: true,
            noRetry: true,
            noReplay: true,
            notDispatched: true,
          });
        }
      };
      dispatched = true;
      console.info(
        "[MotionFlowAudit]",
        JSON.stringify({
          runId: owner.runId,
          frameId,
          operationId: op.operationId,
          stage: "queue_submit",
          mode,
          at: Date.now(),
        }),
      );
      const result = await queue.submitJob(request);
      void MotionFlowQueueRequest.publishHistory?.(
        request,
        result,
        owner.toolProjectId,
        assertScope,
      )?.catch((error) =>
        console.warn(
          "[Motion] Generation history publication failed",
          error?.code || error?.message,
        ),
      );
      const accepted = acceptance ? await acceptance : false;
      if (isForceStopped() && result?.stopped) {
        await checkpoint(accepted ? "monitor" : "submit", "failed", {
          error_code: "MOTION_CANCELLED",
          retry_exhausted: true,
        });
        await journal.settle({ ...op, outcome: "rejected" });
        return { state: "failed", error: "MOTION_CANCELLED" };
      }
      if (stoppedBeforeSubmit && !accepted && !result?.resultTileIds?.length) {
        await checkpoint("submit", "failed", {
          error_code: "MOTION_CANCELLED",
          retry_exhausted: false,
        });
        await journal.settle({
          ...op,
          outcome: "rejected",
          notDispatched: true,
          errorCode: "MOTION_CANCELLED",
        });
        return { state: "paused" };
      }
      if (guardFailure && accepted && !result?.resultTileIds?.length) {
        await checkpoint("monitor", "needs_review", {
          ...acceptedReceipt,
          flow_mode: mode,
        });
        return { state: "needs_review", error: guardFailure };
      }
      if (guardFailure && !accepted && !result?.resultTileIds?.length) {
        await checkpoint("submit", "failed", {
          error_code: "MOTION_FLOW_PRE_DISPATCH_FAILED",
          retry_exhausted: false,
        });
        await journal.settle({
          ...op,
          outcome: "rejected",
          notDispatched: true,
          errorCode: "MOTION_FLOW_PRE_DISPATCH_FAILED",
        });
        return { state: "failed", error: guardFailure };
      }
      if (
        !result?.recoveryRequired &&
        !result?.stopped &&
        result?.failed > 0 &&
        !result?.resultTileIds?.length
      ) {
        const failure = result.errorDetails?.[0];
        if (
          failure?.apiAmbiguous === true ||
          ["ambiguous", "accepted_poll"].includes(failure?.apiStage)
        )
          throw new Error("MOTION_SUBMIT_RECONCILE_REQUIRED");
        const code = MotionFlowQueueRequest.failureCode(
          result,
          providerFailureCode,
        );
        MotionFlowQueueRequest.logFailure?.({
          frameId,
          frame,
          sourceRevision: run.sourceRevision,
          mode,
          accepted,
          code,
          result,
        });
        await checkpoint(accepted ? "monitor" : "submit", "failed", {
          error_code: code,
          retry_exhausted: true,
        });
        await journal.settle({ ...op, outcome: "rejected" });
        return { state: "failed", error: code };
      }
      const receipt = MotionFlowQueueRequest.receipt(
        result,
        mode,
        run.flowProjectId,
      );
      if (
        accepted &&
        Object.entries(acceptedReceipt).some(
          ([key, value]) => receipt[key] !== value,
        )
      )
        throw new Error("MOTION_FLOW_RECEIPT_MISMATCH");
      if (!accepted) await checkpoint("submit", "ready", receipt);
      await checkpoint("monitor", "ready", {
        ...receipt,
        ...(deferSettlement ? { persist_artifact_id: persistArtifactId } : {}),
      });
      if (deferSettlement) return { state: "ready", receipt, operation: op };
      await journal.settle({ ...op, outcome: "received" });
      return { state: "ready", receipt };
    } catch (error) {
      if (acceptance) await acceptance.catch(() => {});
      if (stoppedBeforeSubmit && !acceptance) {
        try {
          await checkpoint("submit", "failed", {
            error_code: "MOTION_CANCELLED",
            retry_exhausted: false,
          });
          await journal.settle({
            ...op,
            outcome: "rejected",
            notDispatched: true,
            errorCode: "MOTION_CANCELLED",
          });
          return { state: "paused" };
        } catch (_) {
          return {
            state: "needs_review",
            error: "MOTION_FLOW_CHECKPOINT_UNVERIFIED",
          };
        }
      }
      if (guardFailure && !acceptance) {
        try {
          await checkpoint("submit", "failed", {
            error_code: "MOTION_FLOW_PRE_DISPATCH_FAILED",
            retry_exhausted: false,
          });
          await journal.settle({
            ...op,
            outcome: "rejected",
            notDispatched: true,
            errorCode: "MOTION_FLOW_PRE_DISPATCH_FAILED",
          });
          return { state: "failed", error: guardFailure };
        } catch (_) {
          return {
            state: "needs_review",
            error: "MOTION_FLOW_CHECKPOINT_UNVERIFIED",
          };
        }
      }
      if (!dispatched) {
        try {
          await checkpoint("submit", "failed", {
            error_code: "MOTION_FLOW_PRE_DISPATCH_FAILED",
            retry_exhausted: false,
          });
          await journal.settle({
            ...op,
            outcome: "rejected",
            notDispatched: true,
            errorCode: "MOTION_FLOW_PRE_DISPATCH_FAILED",
          });
        } catch (_) {
          return {
            state: "needs_review",
            error: "MOTION_FLOW_CHECKPOINT_UNVERIFIED",
          };
        }
        return {
          state: "failed",
          error: error?.code || error?.message || "MOTION_FLOW_FAILED",
        };
      }
      const latest = await fresh().catch(() => null);
      const submit = latest?.data_json?.frames?.[frameId]?.stages?.submit;
      const stage = submit?.state === "ready" ? "monitor" : "submit";
      try {
        await checkpoint(stage, "needs_review", {
          ...acceptedReceipt,
          flow_mode: mode,
        });
      } catch (_) {}
      return {
        state: "needs_review",
        error: error?.code || error?.message || "MOTION_FLOW_UNVERIFIED",
      };
    } finally {
      if (jobId) onQueueAdmitted({ jobId, queue, frameId, completed: true });
    }
  }
}
globalThis.MotionProjectFlow = MotionProjectFlow;
