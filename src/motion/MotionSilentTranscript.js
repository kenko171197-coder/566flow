class MotionSilentTranscript {
  static async run({
    owner,
    frameId,
    api,
    journal,
    assertScope,
    shouldStop,
    retryable,
    force = false,
  }) {
    if (
      !owner ||
      !frameId ||
      !journal ||
      [api, assertScope, shouldStop, retryable].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_TRANSCRIPT_CONFIG_INVALID");
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    return navigator.locks.request(
      `motion-transcript:${owner.userId}:${owner.toolProjectId}`,
      async () => {
        await assertScope();
        const run = await journal.get(owner);
        journal._owned(run, owner);
        if (run?.runId !== owner.runId || run.state !== "running")
          throw new Error("MOTION_RUN_FENCED");
        const endpoint = `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`;
        const read = async () => {
          await assertScope();
          journal._owned(await journal.get(owner), owner);
          const project2 = await api("GET", endpoint);
          await assertScope();
          journal._owned(await journal.get(owner), owner);
          if (
            project2?.tool_project_id !== owner.toolProjectId ||
            project2.flow_project_id !== run.flowProjectId ||
            Number(project2.data_json?.source_revision) !==
              run.sourceRevision ||
            project2.data_json?.requires_resplit
          )
            throw new Error("MOTION_TRANSCRIPT_SCOPE_CHANGED");
          return project2;
        };
        const project = await read();
        const frame = project.data_json?.frames?.[frameId];
        if (
          !frame ||
          frame.stages?.split?.state !== "ready" ||
          !["audio_track_absent", "silent_verified"].includes(
            frame.stages.split.audio_state,
          )
        )
          throw new Error("MOTION_AUDIO_STATE_INVALID");
        if (frame.transcript && !force) return { state: "ready", synced: true };
        if (shouldStop() || project.data_json?.paused)
          return { state: "paused" };
        const transcript = {
          hasSpeech: false,
          transcript: "",
          translatedText: null,
          detectedLanguage: "",
        };
        try {
          await MotionTranscriptCommit.save({
            project,
            sourceRevision: run.sourceRevision,
            frameId,
            frame,
            transcript,
            write: async (revision) => {
              await assertScope();
              journal._owned(await journal.get(owner), owner);
              if (shouldStop())
                throw Object.assign(new Error("MOTION_CANCELLED"), {
                  notDispatched: true,
                });
              return api(
                "PATCH",
                `${endpoint}/frames/${encodeURIComponent(frameId)}/transcript`,
                {
                  revision,
                  source_revision: run.sourceRevision,
                  run_id: frame.run_id,
                  input_revision: frame.input_revision,
                  has_speech: false,
                  transcript: "",
                  translated_text: null,
                  detected_language: null,
                  request_nonce: crypto.randomUUID(),
                },
              );
            },
            read,
            invalidScope: () => false,
            cancelled: shouldStop,
            retryable,
            retryEnabled: () => run.retryEnabled,
            getRetryLimit: async () => run.transcriptMaxRetries,
          });
        } catch (error) {
          if (
            error?.notDispatched === true &&
            error?.message === "MOTION_CANCELLED"
          )
            return { state: "paused" };
          throw error;
        }
        return { state: "ready", synced: true };
      },
    );
  }
}
globalThis.MotionSilentTranscript = MotionSilentTranscript;
