class MotionTranscriptCommit {
  static async cleanup({
    receipt,
    enabled = true,
    shouldStop = () => false,
    remove,
    timeoutMs,
    operationId,
    frameId,
  }) {
    const startedAt = Date.now();
    const report = (state, code = null) => {
      console.info(
        "[MotionTranscriptCleanup]",
        JSON.stringify({
          operationId,
          frameId,
          provider: ["chatgpt", "gemini"].includes(receipt?.provider)
            ? receipt.provider
            : null,
          state,
          elapsedMs: Date.now() - startedAt,
          ...(code && {
            code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(code))
              ? code
              : "MOTION_CLEANUP_UNCONFIRMED",
          }),
        }),
      );
    };
    const skipped = (code) => {
      report("skipped", code);
      return { success: false, error: code };
    };
    if (!enabled) return skipped("CLEANUP_DISABLED");
    if (
      !Number.isInteger(receipt?.tabId) ||
      !receipt.expectedConversationUrl ||
      !["chatgpt", "gemini"].includes(receipt.provider)
    )
      return skipped("CLEANUP_RECEIPT_MISSING");
    if (shouldStop()) return skipped("CLEANUP_CANCELLED");
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      typeof remove !== "function"
    )
      return skipped("MOTION_CLEANUP_CONFIG_INVALID");
    let timer;
    report("requested");
    try {
      const result = await Promise.race([
        Promise.resolve().then(() =>
          shouldStop()
            ? { success: false, error: "CLEANUP_CANCELLED" }
            : remove(receipt, { operationId, frameId, requestedAt: startedAt }),
        ),
        new Promise((resolve) => {
          timer = setTimeout(
            () =>
              resolve({ success: false, error: "CLEANUP_DEADLINE_EXCEEDED" }),
            timeoutMs,
          );
        }),
      ]);
      report(
        result?.success === true
          ? result.accepted === true
            ? "queued"
            : "verified"
          : "unconfirmed",
        result?.error ||
          (result?.success === true ? null : "MOTION_CLEANUP_UNCONFIRMED"),
      );
      return result;
    } catch (error) {
      report("failed", error?.code || error?.message);
      return { success: false, error: "MOTION_CLEANUP_UNCONFIRMED" };
    } finally {
      clearTimeout(timer);
    }
  }
  static async recordFailure({
    project,
    sourceRevision,
    frameId,
    frame,
    error,
    read,
    write,
    invalidScope,
  }) {
    const raw = String(
      error?.code || error?.message || "MOTION_TRANSCRIPTION_FAILED",
    );
    if (
      invalidScope() ||
      /CANCELLED|ABORTED|SCOPE_CHANGED|SCOPE_INVALID|ACCOUNT_SCOPE|RUN_FENCED/.test(
        raw,
      )
    )
      return null;
    const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
      ? raw
      : "MOTION_TRANSCRIPTION_FAILED";
    const fresh = await read();
    const current = fresh?.data_json?.frames?.[frameId];
    if (
      invalidScope() ||
      fresh?.tool_project_id !== project.tool_project_id ||
      fresh?.flow_project_id !== project.flow_project_id ||
      fresh?.revision !== project.revision ||
      Number(fresh?.data_json?.source_revision) !== sourceRevision ||
      current?.run_id !== frame.run_id ||
      current?.input_revision !== frame.input_revision ||
      JSON.stringify(current?.transcript || null) !==
        JSON.stringify(frame.transcript || null) ||
      JSON.stringify(current?.stages?.transcribe || null) !==
        JSON.stringify(frame.stages?.transcribe || null) ||
      JSON.stringify(fresh.data_json.preferences || {}) !==
        JSON.stringify(project.data_json.preferences || {})
    )
      return null;
    return write({
      revision: fresh.revision,
      source_revision: sourceRevision,
      run_id: frame.run_id,
      input_revision: frame.input_revision,
      error_code: code,
    });
  }
  static matches(saved, transcript) {
    return (
      saved?.has_speech === transcript.hasSpeech &&
      String(saved?.text || "") === transcript.transcript.trim() &&
      String(saved?.translated_text || "") ===
        String(transcript.translatedText || "").trim() &&
      String(saved?.detected_language || "") ===
        String(transcript.detectedLanguage || "") &&
      JSON.stringify(saved?.speech_timeline || null) ===
        JSON.stringify(transcript.speechTimeline || null)
    );
  }
  static async save({
    project,
    sourceRevision,
    frameId,
    frame,
    transcript,
    write,
    read,
    invalidScope,
    cancelled,
    retryable,
    retryEnabled,
    getRetryLimit,
    freshScope = () => true,
    onRetry = () => {},
    onProject = () => {},
  }) {
    const original = JSON.stringify(
      project.data_json.frames[frameId].transcript || null,
    );
    let retries = 0;
    for (;;) {
      const revision = project.revision;
      try {
        return await write(revision);
      } catch (error) {
        const fresh = await read().catch(() => null);
        const current = fresh?.data_json?.frames?.[frameId];
        if (
          !fresh ||
          invalidScope() ||
          Number(fresh.data_json?.source_revision) !== sourceRevision ||
          current?.run_id !== frame.run_id ||
          current?.input_revision !== frame.input_revision
        )
          throw error;
        if (!freshScope(fresh)) throw error;
        if (
          current.stages?.transcribe?.state === "ready" &&
          this.matches(current.transcript, transcript)
        )
          return fresh;
        const revisionConflict =
          Number(error?.httpStatus) === 409 &&
          Number(fresh.revision) !== Number(revision);
        if (
          JSON.stringify(current.transcript || null) !== original ||
          cancelled() ||
          (!revisionConflict && !retryable(error))
        )
          throw error;
        const limit = await getRetryLimit();
        if (!Number.isInteger(limit) || limit < 0)
          throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
        if ((!revisionConflict && !retryEnabled()) || retries >= limit)
          throw error;
        retries++;
        onRetry({ attempt: retries, maxRetries: limit, error });
        project = fresh;
        onProject(fresh);
      }
    }
  }
}
globalThis.MotionTranscriptCommit = MotionTranscriptCommit;
