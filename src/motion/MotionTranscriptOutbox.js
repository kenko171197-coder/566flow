class MotionTranscriptOutbox {
  static async flush({
    userId,
    toolProjectId,
    flowProjectId,
    frameId = null,
    api,
    assertScope,
    notify = null,
  }) {
    if (
      !navigator.locks?.request ||
      typeof api !== "function" ||
      typeof assertScope !== "function"
    ) {
      throw new Error("MOTION_OUTBOX_UNAVAILABLE");
    }
    const scope = { userId, toolProjectId };
    return navigator.locks.request(
      `motion-outbox:${userId}:${toolProjectId}`,
      { mode: "exclusive" },
      async (lock) => {
        if (!lock) throw new Error("MOTION_OUTBOX_UNAVAILABLE");
        let delivered = 0;
        for (;;) {
          await assertScope();
          const event = (
            await MotionRunJournal.listTranscriptOutbox(scope)
          ).find((item) => frameId === null || item.frameId === frameId);
          await assertScope();
          if (!event) return { delivered };
          if (
            event.flowProjectId !== flowProjectId ||
            event.userId !== Number(userId) ||
            event.toolProjectId !== toolProjectId
          )
            throw new Error("MOTION_OUTBOX_SCOPE_MISMATCH");
          const projectPath = `tools/motion-studio/projects/${encodeURIComponent(toolProjectId)}`;
          const framePath = `${projectPath}/frames/${encodeURIComponent(event.frameId)}`;
          const read = async () => {
            await assertScope();
            const project2 = await api("GET", projectPath);
            await assertScope();
            const frame2 = project2?.data_json?.frames?.[event.frameId];
            if (
              project2?.tool_project_id !== toolProjectId ||
              project2?.flow_project_id !== flowProjectId ||
              Number(project2?.data_json?.source_revision) !==
                event.sourceRevision ||
              frame2?.run_id !== event.frameRunId ||
              Number(frame2?.input_revision) !== event.inputRevision
            ) {
              throw new Error("MOTION_OUTBOX_FRAME_CHANGED");
            }
            const settings = event.transcriptSettings;
            const preferences = project2?.data_json?.preferences || {};
            if (
              settings &&
              event.state !== "failed" &&
              ((preferences.transcription_provider &&
                preferences.transcription_provider !==
                  settings.transcription_provider) ||
                (preferences.translate_enabled === true) !==
                  settings.translate_enabled ||
                (settings.translate_enabled &&
                  (preferences.target_language || null) !==
                    settings.target_language))
            ) {
              throw new Error("MOTION_OUTBOX_SETTINGS_CHANGED");
            }
            return { project: project2, frame: frame2 };
          };
          const sameAttempt = (frame2) =>
            frame2?.stages?.transcribe?.worker?.project_run_id ===
              event.projectRunId &&
            frame2?.stages?.transcribe?.worker?.attempt_id ===
              event.attemptId &&
            Number(frame2?.stages?.transcribe?.worker?.retry_count) ===
              event.retryCount &&
            (!event.transcriptSettings ||
              (frame2?.stages?.transcribe?.worker?.transcript_settings
                ?.transcription_provider ===
                event.transcriptSettings.transcription_provider &&
                frame2.stages.transcribe.worker.transcript_settings
                  .translate_enabled ===
                  event.transcriptSettings.translate_enabled &&
                (frame2.stages.transcribe.worker.transcript_settings
                  .target_language || null) ===
                  event.transcriptSettings.target_language));
          const matches = (frame2) => {
            if (event.state !== "direct_ready" && !sameAttempt(frame2))
              return false;
            const stage = frame2.stages.transcribe;
            if (event.state === "running")
              return ["running", "failed", "ready"].includes(stage.state);
            if (event.state === "failed")
              return (
                stage.state === "failed" &&
                stage.error_code === event.errorCode &&
                !!stage.retry_exhausted === !!event.retryExhausted
              );
            const transcript = frame2.transcript;
            return (
              ["ready", "direct_ready"].includes(event.state) &&
              stage?.state === "ready" &&
              transcript?.has_speech === event.transcript?.hasSpeech &&
              String(transcript?.text || "") === event.transcript.transcript &&
              String(transcript?.detected_language || "") ===
                event.transcript.detectedLanguage &&
              String(transcript?.translated_text || "") ===
                String(event.transcript.translatedText || "") &&
              JSON.stringify(transcript?.speech_timeline || null) ===
                JSON.stringify(event.transcript.speechTimeline || null)
            );
          };
          let { project, frame } = await read();
          console.info(
            "[MotionTranscriptOutbox]",
            JSON.stringify({
              runId: event.projectRunId,
              frameId: event.frameId,
              attemptId: event.attemptId,
              event: event.state,
              retryCount: event.retryCount,
              revision: project.revision,
              inputRevision: frame.input_revision,
              serverState: frame.stages?.transcribe?.state || null,
              sameAttempt: sameAttempt(frame),
              alreadySaved: matches(frame),
            }),
          );
          if (!matches(frame)) {
            if (
              event.state === "direct_ready" &&
              JSON.stringify(frame.transcript || null) !==
                JSON.stringify(event.originalTranscript || null)
            )
              throw new Error("MOTION_OUTBOX_FRAME_CHANGED");
            const common = {
              source_revision: event.sourceRevision,
              run_id: event.frameRunId,
              input_revision: event.inputRevision,
              project_run_id: event.projectRunId,
              attempt_id: event.attemptId,
            };
            let path, body;
            if (event.state === "running" || event.state === "failed") {
              path = `${framePath}/transcription-attempt`;
              body = {
                ...common,
                retry_count: event.retryCount,
                state: event.state,
                ...(event.state === "running" &&
                  event.transcriptSettings && {
                    transcript_settings: event.transcriptSettings,
                  }),
                ...(event.state === "failed" && {
                  error_code: event.errorCode,
                  retry_exhausted: event.retryExhausted,
                }),
              };
            } else if (
              event.state === "ready" ||
              event.state === "direct_ready"
            ) {
              path = `${framePath}/transcript`;
              body = {
                ...common,
                ...(event.state === "direct_ready" && {
                  project_run_id: void 0,
                  attempt_id: void 0,
                }),
                revision: project.revision,
                has_speech: event.transcript.hasSpeech,
                transcript: event.transcript.transcript,
                translated_text: event.transcript.translatedText,
                speech_timeline: event.transcript.speechTimeline || null,
                detected_language: event.transcript.detectedLanguage || null,
              };
            } else throw new Error("MOTION_OUTBOX_EVENT_INVALID");
            const originalTranscript = JSON.stringify(frame.transcript || null);
            const originalWorker = JSON.stringify(
              frame.stages?.transcribe?.worker || null,
            );
            for (let revisionRetries = 0; ; revisionRetries++) {
              body.request_nonce = crypto.randomUUID();
              try {
                await assertScope();
                project = await api("PATCH", path, body);
                await assertScope();
                frame = project?.data_json?.frames?.[event.frameId];
                if (
                  project?.tool_project_id !== toolProjectId ||
                  project?.flow_project_id !== flowProjectId ||
                  Number(project?.data_json?.source_revision) !==
                    event.sourceRevision ||
                  frame?.run_id !== event.frameRunId ||
                  Number(frame?.input_revision) !== event.inputRevision ||
                  !matches(frame)
                )
                  throw new Error("MOTION_OUTBOX_ACK_UNVERIFIED");
                break;
              } catch (error) {
                const current = await read().catch(() => null);
                if (current && matches(current.frame)) break;
                console.warn(
                  "[MotionTranscriptOutboxConflict]",
                  JSON.stringify({
                    runId: event.projectRunId,
                    frameId: event.frameId,
                    attemptId: event.attemptId,
                    event: event.state,
                    retryCount: event.retryCount,
                    revision: body.revision ?? project.revision,
                    currentRevision: current?.project.revision ?? null,
                    frameScopeValid: !!current,
                    sameAttempt: current ? sameAttempt(current.frame) : false,
                    serverState:
                      current?.frame.stages?.transcribe?.state || null,
                    workerChanged: current
                      ? JSON.stringify(
                          current.frame.stages?.transcribe?.worker || null,
                        ) !== originalWorker
                      : null,
                    transcriptChanged: current
                      ? JSON.stringify(current.frame.transcript || null) !==
                        originalTranscript
                      : null,
                    conflictReason:
                      error?.serverData?.data?.conflict_reason || null,
                  }),
                );
                const conflict =
                  error?.code === "REVISION_CONFLICT" ||
                  error?.message === "REVISION_CONFLICT" ||
                  Number(error?.httpStatus) === 409;
                if (
                  !current ||
                  !conflict ||
                  !["ready", "direct_ready"].includes(event.state) ||
                  Number(current.project.revision) === Number(body.revision) ||
                  JSON.stringify(current.frame.transcript || null) !==
                    originalTranscript ||
                  JSON.stringify(
                    current.frame.stages?.transcribe?.worker || null,
                  ) !== originalWorker ||
                  (event.state === "ready" &&
                    (!sameAttempt(current.frame) ||
                      current.frame.stages.transcribe.state !== "running"))
                )
                  throw error;
                const run = await MotionRunJournal.get(scope);
                if (run?.runId !== event.projectRunId) throw error;
                const limit = run.transcriptMaxRetries;
                if (!Number.isSafeInteger(limit) || limit < 0)
                  throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
                if (revisionRetries >= limit) throw error;
                body.revision = current.project.revision;
                console.info(
                  "[MotionTranscriptOutboxRetry]",
                  JSON.stringify({
                    runId: event.projectRunId,
                    frameId: event.frameId,
                    stage: "save",
                    attempt: revisionRetries + 1,
                    maxRetries: limit,
                    reason: "REVISION_CONFLICT",
                  }),
                );
              }
            }
          }
          await assertScope();
          if (
            !(await MotionRunJournal.ackTranscriptOutbox({
              ...scope,
              eventId: event.eventId,
              ...(frameId !== null && { frameId }),
            }))
          ) {
            throw new Error("MOTION_OUTBOX_ACK_UNVERIFIED");
          }
          await assertScope();
          delivered++;
          try {
            const update = {
              userId: Number(userId),
              projectId: toolProjectId,
              nonce: crypto.randomUUID(),
            };
            const sent =
              typeof notify === "function"
                ? notify(update)
                : globalThis.chrome?.storage?.local?.set?.({
                    motion_project_changed: update,
                  });
            sent?.catch?.(() => {});
          } catch (_) {}
        }
      },
    );
  }
}
globalThis.MotionTranscriptOutbox = MotionTranscriptOutbox;
