class MotionSequentialTranscript {
  static async run({
    owner,
    frameId,
    profile,
    preferences,
    api,
    journal,
    assertScope,
    shouldStop,
    retryable,
    dispatch,
    cleanup = () => {},
  }) {
    if (
      !owner ||
      !frameId ||
      !profile ||
      !preferences ||
      !journal ||
      [api, assertScope, shouldStop, retryable, dispatch, cleanup].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_TRANSCRIPT_CONFIG_INVALID");
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    return navigator.locks.request(
      `motion-transcript:${owner.userId}:${owner.toolProjectId}`,
      async () => {
        const endpoint = `tools/motion-studio/projects/${encodeURIComponent(owner.toolProjectId)}`;
        const scope = async () => {
          await assertScope();
          const current2 = await journal.get(owner);
          journal._owned(current2, owner);
          if (
            current2.state !== "running" ||
            current2.executionMode !== "sequential"
          )
            throw new Error("MOTION_RUN_FENCED");
          return current2;
        };
        const run = await scope();
        const read = async () => {
          await scope();
          const project2 = await api("GET", endpoint);
          await scope();
          if (
            project2?.tool_project_id !== owner.toolProjectId ||
            project2.flow_project_id !== run.flowProjectId ||
            Number(project2.data_json?.source_revision) !==
              run.sourceRevision ||
            project2.data_json?.requires_resplit
          )
            throw new Error("MOTION_TRANSCRIPT_SCOPE_CHANGED");
          const prefs = project2.data_json?.preferences || {};
          if (
            [
              "transcription_provider",
              "translate_enabled",
              "target_language",
            ].some((key) => (prefs[key] ?? null) !== (preferences[key] ?? null))
          )
            throw new Error("MOTION_TRANSCRIPT_SETTINGS_CHANGED");
          return project2;
        };
        const project = await read();
        const frame = structuredClone(
          project.data_json?.frames?.[frameId] || null,
        );
        if (
          !frame ||
          frame.stages?.split?.state !== "ready" ||
          frame.stages.split.audio_state !== "audio_present"
        )
          throw new Error("MOTION_AUDIO_STATE_INVALID");
        if (shouldStop() || project.data_json?.paused)
          return { state: "paused" };
        const audio = await MotionArtifactStore.get({
          userId: owner.userId,
          toolProjectId: owner.toolProjectId,
          sourceRevision: run.sourceRevision,
          frameId,
          kind: "source_audio",
        });
        if (!audio?.blob || audio.flowProjectId !== run.flowProjectId)
          throw new Error("MOTION_AUDIO_NOT_AVAILABLE");
        const uploadAudio = await MotionTranscriptContract.prepareAudio(
          audio.blob,
          { shouldStop },
        );
        console.info(
          "[MotionTranscriptUpload]",
          JSON.stringify({
            runId: owner.runId,
            frameId,
            fullSound: false,
            inputBytes: audio.blob.size,
            uploadBytes: uploadAudio.size,
          }),
        );
        const manifest = MotionTranscriptContract.buildBatches(
          [{ frameId, blob: uploadAudio, duration: frame.end - frame.start }],
          { maxFiles: 1, maxBytes: uploadAudio.size },
        )[0];
        const entry = manifest[0];
        const translate = preferences.translate_enabled === true;
        const preserveOriginal =
          translate && frame.transcript?.has_speech === true;
        const text = MotionTranscriptContract.composePrompt(
          MotionPromptComposer.render(
            profile.prompts?.[
              translate ? "transcribe_translate" : "transcribe"
            ],
            {
              audio_manifest: JSON.stringify([
                {
                  frame_id: frameId,
                  order: entry.order,
                  file_name: entry.name,
                  duration_seconds: entry.duration,
                },
              ]),
              target_language: preferences.target_language || "",
            },
          ),
          { translate },
        );
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(reader.error || new Error("MOTION_AUDIO_READ_FAILED"));
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.readAsDataURL(uploadAudio);
        });
        const before = await read();
        const current = before.data_json?.frames?.[frameId];
        if (
          current?.run_id !== frame.run_id ||
          current?.input_revision !== frame.input_revision ||
          JSON.stringify(current.transcript || null) !==
            JSON.stringify(frame.transcript || null)
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        if (shouldStop() || before.data_json?.paused)
          return { state: "paused" };
        const attempt = {
          ...owner,
          operationId: crypto.randomUUID(),
          frameId,
          frameRunId: frame.run_id,
          inputRevision: frame.input_revision,
          stage: "direct_transcribe",
        };
        await journal.markSubmitted(attempt);
        if (shouldStop()) {
          await journal.cancelDirectTranscript(attempt);
          return { state: "paused" };
        }
        let response, transcript;
        try {
          response = await dispatch({
            text,
            operationId: attempt.operationId,
            audio: { base64, name: entry.name, type: entry.mime },
            audioManifest: [
              {
                frame_id: frameId,
                order: entry.order,
                file_name: entry.name,
                duration_seconds: entry.duration,
              },
            ],
          });
          if (
            response?.error === "MOTION_CANCELLED" &&
            response.notDispatched === true
          ) {
            await journal.cancelDirectTranscript(attempt);
            return { state: "paused" };
          }
          if (!response?.success)
            throw new Error(response?.error || "MOTION_TRANSCRIPTION_FAILED");
          transcript = MotionTranscriptContract.validateSingleResponse(
            response,
            manifest,
            {
              frameId,
              translate,
              preserveOriginalSpeech: preserveOriginal,
              requireTimeline: text.includes("MOTION_SPEECH_TIMELINE_V1"),
            },
          );
        } catch (error) {
          const raw = String(error?.code || error?.message || "");
          const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
            ? raw
            : "MOTION_TRANSCRIPTION_FAILED";
          await journal.failDirectTranscript({ ...attempt, reason: code });
          try {
            await MotionTranscriptCommit.recordFailure({
              project,
              sourceRevision: run.sourceRevision,
              frameId,
              frame,
              error,
              invalidScope: shouldStop,
              read,
              write: (body) =>
                api(
                  "PATCH",
                  `${endpoint}/frames/${encodeURIComponent(frameId)}/transcription-failure`,
                  body,
                ),
            });
          } catch (failure) {
            console.warn("[MotionTranscriptFailure]", {
              frameId,
              stage: "save_error",
              code: failure?.code || "MOTION_TRANSCRIPT_SAVE_FAILED",
            });
          }
          return { state: "failed", error: code };
        }
        if (
          !translate &&
          transcript.hasSpeech &&
          frame.transcript?.translated_text
        ) {
          transcript.translatedText = frame.transcript.translated_text;
          transcript.speechTimeline = null;
        }
        if (preserveOriginal)
          transcript = {
            ...transcript,
            hasSpeech: true,
            transcript: frame.transcript.text || "",
            detectedLanguage: frame.transcript.detected_language || "",
            speechTimeline:
              transcript.transcript.trim() ===
              (frame.transcript.text || "").trim()
                ? transcript.speechTimeline
                : null,
          };
        let saved = null;
        let inFlight = null;
        const persist = () => {
          if (saved) return Promise.resolve(saved);
          if (inFlight) return inFlight;
          inFlight = (async () => {
            await journal.storeDirectTranscript({
              ...attempt,
              transcript,
              originalTranscript: frame.transcript || null,
            });
            try {
              await MotionTranscriptOutbox.flush({
                userId: owner.userId,
                toolProjectId: owner.toolProjectId,
                frameId,
                flowProjectId: run.flowProjectId,
                api,
                assertScope,
              });
            } catch (_) {
              saved = { state: "ready", synced: false };
              return saved;
            }
            void MotionTranscriptCommit.cleanup({
              receipt: response.cleanupReceipt,
              shouldStop,
              operationId: attempt.operationId,
              frameId,
              timeoutMs: 1e4,
              remove: cleanup,
            });
            saved = { state: "ready", synced: true };
            return saved;
          })().finally(() => {
            inFlight = null;
          });
          return inFlight;
        };
        try {
          return await persist();
        } catch (error) {
          const raw = String(error?.code || error?.message || "");
          const outcome = {
            state: "persistence_error",
            error: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
              ? raw
              : "MOTION_TRANSCRIPT_SAVE_FAILED",
          };
          Object.defineProperties(outcome, {
            retryPersistence: { value: persist },
            pendingTranscript: { get: () => transcript },
          });
          return outcome;
        }
      },
    );
  }
}
globalThis.MotionSequentialTranscript = MotionSequentialTranscript;
