class MotionFrameResultActions {
  static withoutFrameFailure(value, scope) {
    if (
      !value ||
      Number(value.userId) !== scope.userId ||
      value.projectId !== scope.toolProjectId ||
      Number(value.sourceRevision) !== scope.sourceRevision ||
      !["failed", "needs_review", "paused"].includes(value.state)
    )
      return value;
    const generated = (stage) =>
      [
        "flow",
        "submit",
        "monitor",
        "persist",
        "download",
        "continuity",
      ].includes(stage);
    const failures = Array.isArray(value.failures) ? value.failures : [];
    const next = failures.filter(
      (item) => !(item.frameId === scope.frameId && generated(item.stage)),
    );
    const clearsTop =
      (value.frameId === scope.frameId && generated(value.stage)) ||
      (!value.frameId &&
        next.length === 0 &&
        next.length !== failures.length &&
        (!value.error ||
          failures.some(
            (item) =>
              item.frameId === scope.frameId && item.error === value.error,
          )));
    if (next.length === failures.length && !clearsTop) return value;
    if (!clearsTop) return { ...value, failures: next };
    if (next.length)
      return {
        ...value,
        failures: next,
        frameId: next[0].frameId,
        stage: next[0].stage,
        error: next[0].error,
        apiDiagnostic: null,
      };
    if (value.cleanupError || value.mergeError || value.downloadError)
      return {
        ...value,
        failures: [],
        frameId: null,
        stage: "final",
        error: null,
        apiDiagnostic: null,
      };
    return null;
  }
  static async clearSavedFrameFailure(scope) {
    const storage = globalThis.chrome?.storage?.local;
    if (!storage) return;
    const keys = [
      "motion_runner_status",
      `motion_runner_status:${scope.userId}:${scope.toolProjectId}`,
    ];
    const saved = await storage.get(keys);
    for (const key of keys) {
      const previous = saved[key],
        next = this.withoutFrameFailure(previous, scope);
      if (next === previous) continue;
      if (next)
        await storage.set({ [key]: { ...next, nonce: crypto.randomUUID() } });
      else await storage.remove(key);
    }
  }
  static terminalFailure(frame) {
    const submit = frame?.stages?.submit,
      monitor = frame?.stages?.monitor;
    const cancelled = [submit, monitor].find(
      (stage) =>
        stage?.state === "failed" &&
        stage.error_code === "MOTION_CANCELLED" &&
        stage.retry_exhausted === true,
    );
    if (cancelled) return cancelled;
    if (
      submit?.state === "failed" &&
      submit.retry_exhausted === true &&
      !["running", "needs_review", "ready"].includes(monitor?.state)
    )
      return submit;
    if (
      submit?.state === "ready" &&
      monitor?.state === "failed" &&
      monitor.retry_exhausted === true
    )
      return monitor;
    return null;
  }
  static async run({
    project,
    frameId,
    action,
    media = null,
    target,
    userId,
    api,
    assertScope,
    journal = MotionRunJournal,
    journalOwner = null,
    store = MotionArtifactStore,
    download = null,
    config,
    selectedResolution = null,
    preserveGenerated = false,
  }) {
    const frame = project?.data_json?.frames?.[frameId];
    const sourceRevision = Number(project?.data_json?.source_revision);
    if (
      !frame ||
      frame.stages?.split?.state !== "ready" ||
      !["reset", "replace"].includes(action) ||
      target?.projectId !== project.flow_project_id ||
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 1
    )
      throw new Error("FRAME_SCOPE_CHANGED");
    await assertScope();
    const scope = {
      userId,
      toolProjectId: project.tool_project_id,
      sourceRevision,
      frameId,
      frameRunId: frame.run_id,
      inputRevision: Number(frame.input_revision),
      ...(journalOwner && { owner: journalOwner }),
    };
    await journal.editFrameResult({ ...scope, checkOnly: true });
    const endpoint = `tools/motion-studio/projects/${encodeURIComponent(project.tool_project_id)}`;
    const body = {
      revision: project.revision,
      source_revision: sourceRevision,
      run_id: frame.run_id,
      input_revision: scope.inputRevision,
      flow_project_id: project.flow_project_id,
      mutation_id: crypto.randomUUID(),
      action,
    };
    if (action === "reset" && preserveGenerated) body.preserve_result = true;
    const artifactScope = {
      userId,
      toolProjectId: project.tool_project_id,
      flowProjectId: project.flow_project_id,
      sourceRevision,
      frameId,
      kind: "generated_clip",
      artifactRevision: scope.inputRevision + 1,
    };
    let staged = false;
    if (action === "replace") {
      download ||
        (download = MotionFlowDownload.persistWeb.bind(MotionFlowDownload));
      const mediaId = String(media?.media_uuid || media?.fileId || "");
      if (
        media?.source !== "flow" ||
        media.type !== "video" ||
        (media.project_id && media.project_id !== target.projectId) ||
        !window.flow_uuid_gateway.isUuid(mediaId)
      )
        throw new Error("MOTION_FLOW_MEDIA_SELECTION_INVALID");
      const preferred =
        project.data_json.preferences?.flow_download_resolution ||
        selectedResolution;
      console.info(
        "[MotionResultEdit]",
        JSON.stringify({
          frameId,
          stage: "download_selection",
          generationMode: project.data_json.flow_run_mode || null,
          resolution: preferred,
          resolutionSource: project.data_json.preferences
            ?.flow_download_resolution
            ? "project"
            : "editor",
        }),
      );
      if (!preferred) throw new Error("FLOW_DOWNLOAD_RESOLUTION_UNAVAILABLE");
      const persistentMediaId = [
        ...window.flow_uuid_gateway.aliases(media, media.fileId),
      ].find((value) => window.flow_uuid_gateway.isAsb(value));
      try {
        const result = await download({
          receipt: {
            mediaId,
            projectId: target.projectId,
            fileName: persistentMediaId || "",
            manualResult: true,
          },
          scope: artifactScope,
          config,
          selectedResolution: preferred,
        });
        staged = true;
        Object.assign(body, {
          media_id: mediaId,
          artifact_id: result.artifactId,
          resolution: result.resolution,
        });
        if (result.persistentMediaId || persistentMediaId)
          body.persistent_media_id =
            result.persistentMediaId || persistentMediaId;
        await assertScope();
      } catch (error) {
        const rawCode = String(error?.code || error?.message || "");
        console.warn(
          "[MotionResultEdit]",
          JSON.stringify({
            frameId,
            stage: "download_failed",
            resolution: preferred,
            code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawCode)
              ? rawCode
              : "MOTION_FLOW_DOWNLOAD_FAILED",
          }),
        );
        await store.delete(artifactScope).catch(() => {});
        throw error;
      }
    }
    let saved;
    try {
      await assertScope();
      saved = await api(
        "POST",
        `${endpoint}/frames/${encodeURIComponent(frameId)}/result`,
        body,
      );
    } catch (error) {
      const fresh = await api("GET", endpoint).catch(() => null);
      if (
        fresh?.data_json?.frames?.[frameId]?.result_edit?.mutation_id ===
        body.mutation_id
      )
        saved = fresh;
      else {
        if (fresh && staged) await store.delete(artifactScope).catch(() => {});
        throw error;
      }
    }
    const updated = saved?.data_json?.frames?.[frameId];
    if (
      saved?.flow_project_id !== target.projectId ||
      saved.data_json?.source_revision !== sourceRevision ||
      updated?.result_edit?.mutation_id !== body.mutation_id ||
      updated.input_revision !== scope.inputRevision + 1 ||
      updated.run_id === frame.run_id
    )
      throw new Error("MOTION_RESULT_EDIT_UNVERIFIED");
    if (preserveGenerated && updated.result_edit.preserve_result !== true)
      throw new Error("MOTION_REGEN_RESET_UNVERIFIED");
    await assertScope();
    await journal.editFrameResult(scope);
    await this.clearSavedFrameFailure(scope).catch((error) => {
      console.warn("[MotionResultEdit]", {
        frameId,
        stage: "clear_saved_failure",
        code: "MOTION_STATUS_CLEANUP_PENDING",
      });
    });
    try {
      const records = await store.listProject(userId, project.tool_project_id);
      for (const record of records) {
        if (
          record.sourceRevision !== sourceRevision ||
          record.flowProjectId !== project.flow_project_id ||
          record.kind !== "generated_staging" ||
          !(
            (record.targetKind === "generated_clip" &&
              record.frameId === frameId &&
              record.artifactRevision <= scope.inputRevision) ||
            (record.targetKind === "merged_video" &&
              record.artifactRevision ===
                project.data_json.final?.artifact_revision)
          )
        )
          continue;
        await assertScope();
        const old = {
          userId,
          toolProjectId: project.tool_project_id,
          flowProjectId: record.flowProjectId,
          sourceRevision,
          frameId: record.frameId,
          artifactRevision: record.artifactRevision,
          operationId: record.operationId,
          targetKind: record.targetKind,
        };
        if (preserveGenerated) {
          if (record.state === "promoted") await store.finishGenerated(old);
          else await store.discardGenerated(old);
          continue;
        }
        if (record.state === "promoted") await store.rollbackGenerated(old);
        await store.discardGenerated(old);
        await store.delete({ ...old, kind: record.targetKind });
      }
      for (const record of records) {
        if (preserveGenerated) continue;
        if (
          record.sourceRevision !== sourceRevision ||
          !(
            (record.kind === "generated_clip" &&
              record.frameId === frameId &&
              record.artifactRevision <= scope.inputRevision) ||
            (record.kind === "merged_video" &&
              record.artifactRevision ===
                project.data_json.final?.artifact_revision)
          )
        )
          continue;
        await assertScope();
        await store.delete({
          userId,
          toolProjectId: project.tool_project_id,
          sourceRevision,
          ...(record.frameId && { frameId: record.frameId }),
          kind: record.kind,
          artifactRevision: record.artifactRevision,
        });
      }
    } catch (error) {
      console.warn("[MotionResultEdit] Superseded artifact cleanup pending", {
        frameId,
        code: error?.message,
      });
    }
    return saved;
  }
}
globalThis.MotionFrameResultActions = MotionFrameResultActions;
