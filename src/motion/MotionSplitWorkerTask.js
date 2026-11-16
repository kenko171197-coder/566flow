class MotionSplitWorkerTask {
  static run({
    scope,
    blob,
    maxSeconds,
    includeAudio,
    cutStrategy = "silence",
    assertScope,
    shouldStop = () => false,
    onPlan,
    onFrame = async () => {},
    onProgress = () => {},
    runId = crypto.randomUUID(),
    continueOnFrameError = false,
    maxFrameRetries,
    waitBeforeRetry,
  }) {
    if (
      !scope ||
      !(blob instanceof Blob) ||
      !blob.size ||
      !Number.isFinite(maxSeconds) ||
      maxSeconds < 1 ||
      typeof includeAudio !== "boolean" ||
      !["duration", "silence"].includes(cutStrategy) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(runId)) ||
      [assertScope, shouldStop, onPlan, onFrame, onProgress].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_SPLIT_CONFIG_INVALID");
    if (
      continueOnFrameError &&
      (!Number.isSafeInteger(maxFrameRetries) ||
        maxFrameRetries < 0 ||
        typeof waitBeforeRetry !== "function")
    )
      throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
    const timeoutMs = globalThis.MotionMergeTask?.timeoutMs?.();
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("MOTION_MEDIA_TIMEOUT_CONFIG_INVALID");
    const id = runId;
    const worker = new Worker(
      chrome.runtime.getURL("src/core/video-split-worker.js"),
    );
    return new Promise((resolve, reject) => {
      let plan = null,
        planWrite = null,
        current = null,
        next = 0,
        settled = false,
        timer;
      const frames = [];
      const pendingWrites = new Set();
      const track = (promise) => {
        pendingWrites.add(promise);
        promise.finally(() => pendingWrites.delete(promise)).catch(() => {});
        return promise;
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = worker.onerror = null;
        worker.terminate();
        if (error)
          Promise.allSettled([...pendingWrites]).then(() =>
            reject(error instanceof Error ? error : new Error(String(error))),
          );
        else resolve(result);
      };
      const ack = () => {
        if (
          !current ||
          current.acking ||
          (!current.clip && !current.metadata?.errorCode) ||
          (plan.audioState === "audio_present" &&
            !current.audio &&
            !current.metadata?.errorCode)
        )
          return;
        const item = current;
        item.acking = true;
        track(
          Promise.all([
            planWrite,
            ...(item.clip ? [item.clip] : []),
            ...(item.audio ? [item.audio] : []),
          ])
            .then(async () => {
              await assertScope();
              if (settled || current !== item) return;
              await onFrame({ ...item.metadata, index: item.index, runId: id });
              await assertScope();
              if (settled || current !== item) return;
              if (shouldStop()) return finish(new Error("MOTION_SPLIT_PAUSED"));
              frames.push(item.metadata);
              current = null;
              next++;
              worker.postMessage({
                type: "frame_saved",
                id,
                index: item.index,
              });
            })
            .catch(finish),
        );
      };
      worker.onerror = (event) =>
        finish(new Error(event.message || "SPLIT_WORKER_FAILED"));
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (settled || message.id !== id) return;
        if (["audio_diagnostic", "media_diagnostic"].includes(message.type)) {
          console.warn(
            message.type === "audio_diagnostic"
              ? "[MotionAudioDecode]"
              : "[MotionMediaDecode]",
            JSON.stringify({ runId: id, ...message.diagnostic }),
          );
          return;
        }
        if (message.type === "error")
          return finish(new Error(message.code || "MOTION_SPLIT_FAILED"));
        if (message.type === "frame_retry") {
          if (
            !continueOnFrameError ||
            !plan ||
            message.index !== next ||
            message.count !== plan.count ||
            !Number.isSafeInteger(message.retryCount) ||
            message.retryCount < 1 ||
            message.retryCount > maxFrameRetries
          )
            return finish(new Error("MOTION_SPLIT_FRAME_INVALID"));
          track(
            Promise.resolve()
              .then(() =>
                waitBeforeRetry({
                  frameId: `f${String(next + 1).padStart(4, "0")}`,
                  stage: message.stage,
                  retryCount: message.retryCount,
                }),
              )
              .then(assertScope)
              .then(() => {
                if (settled) return;
                if (shouldStop())
                  return finish(new Error("MOTION_SPLIT_PAUSED"));
                worker.postMessage({
                  type: "frame_retry_ready",
                  id,
                  index: message.index,
                  retryCount: message.retryCount,
                });
              })
              .catch(finish),
          );
          return;
        }
        if (message.type === "frame_error") {
          if (
            !continueOnFrameError ||
            !plan ||
            message.index !== next ||
            message.count !== plan.count ||
            message.start !== plan.boundaries[next] ||
            message.end !== plan.boundaries[next + 1] ||
            !["split", "audio"].includes(message.stage) ||
            !/^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(message.code)
          )
            return finish(new Error("MOTION_SPLIT_FRAME_INVALID"));
          current ||
            (current = {
              index: next,
              clip: null,
              audio: null,
              acking: false,
              metadata: null,
            });
          current.metadata = {
            ...current.metadata,
            frameId: `f${String(next + 1).padStart(4, "0")}`,
            start: message.start,
            end: message.end,
            duration: message.end - message.start,
            errorCode: message.code,
            failureStage: message.stage,
          };
          try {
            onProgress({
              index: next,
              count: plan.count,
              percent: 100,
              state: "failed",
              error: message.code,
            });
          } catch (_) {}
          ack();
          return;
        }
        if (message.type === "progress") {
          try {
            onProgress({
              index: message.index,
              count: message.count,
              percent: message.percent,
            });
          } catch (_) {}
          return;
        }
        if (message.type === "plan") {
          if (
            plan ||
            !Number.isSafeInteger(message.count) ||
            message.count < 1 ||
            message.count > 120 ||
            (message.cutStrategy || "silence") !== cutStrategy ||
            (message.cutStrategy &&
              (!Number.isSafeInteger(message.quietCuts) ||
                message.quietCuts < 0 ||
                !Number.isSafeInteger(message.timeCuts) ||
                message.timeCuts < 0 ||
                message.quietCuts + message.timeCuts !== message.count - 1 ||
                (cutStrategy === "duration" && message.quietCuts !== 0))) ||
            !Number.isFinite(message.duration) ||
            message.duration <= 0 ||
            !Array.isArray(message.boundaries) ||
            message.boundaries.length !== message.count + 1 ||
            message.boundaries[0] !== 0 ||
            Math.abs(message.boundaries.at(-1) - message.duration) > 0.0015 ||
            message.boundaries.some(
              (value, index) =>
                !Number.isFinite(value) ||
                (index > 0 &&
                  (value <= message.boundaries[index - 1] ||
                    value - message.boundaries[index - 1] >
                      maxSeconds + 0.0015)),
            ) ||
            ![
              "audio_present",
              "audio_track_absent",
              "silent_verified",
              "audio_not_requested",
              "audio_decode_unsupported",
            ].includes(message.audioState) ||
            (!includeAudio && message.audioState !== "audio_not_requested") ||
            (includeAudio && message.audioState === "audio_not_requested")
          )
            return finish(new Error("MOTION_SPLIT_PLAN_INVALID"));
          plan = {
            duration: message.duration,
            count: message.count,
            boundaries: [...message.boundaries],
            audioState: message.audioState,
            ...(message.cutStrategy && {
              cutStrategy: message.cutStrategy,
              quietCuts: message.quietCuts,
              timeCuts: message.timeCuts,
            }),
          };
          planWrite = Promise.resolve()
            .then(assertScope)
            .then(() => onPlan({ ...plan, runId: id }));
          planWrite.catch(finish);
          return;
        }
        if (message.type === "clip" || message.type === "audio") {
          if (
            !plan ||
            message.index !== next ||
            message.count !== plan.count ||
            !(message.blob instanceof Blob) ||
            !message.blob.size ||
            !Number.isFinite(message.duration) ||
            message.duration <= 0 ||
            (message.type === "clip" &&
              (message.blob.type !== "video/mp4" ||
                message.duration > maxSeconds + 0.001)) ||
            (message.type === "audio" &&
              (message.blob.type !== "audio/wav" ||
                Math.abs(message.duration - (message.end - message.start)) >
                  0.1)) ||
            message.start !== plan.boundaries[next] ||
            message.end !== plan.boundaries[next + 1]
          )
            return finish(new Error("MOTION_SPLIT_FRAME_INVALID"));
          if (!current)
            current = {
              index: next,
              clip: null,
              audio: null,
              acking: false,
              metadata: null,
            };
          if (
            (message.type === "audio" && plan.audioState !== "audio_present") ||
            current[message.type]
          )
            return finish(new Error("MOTION_SPLIT_FRAME_INVALID"));
          const frameId = `f${String(next + 1).padStart(4, "0")}`;
          if (message.type === "clip")
            current.metadata = {
              frameId,
              start: message.start,
              end: message.end,
              duration: message.duration,
            };
          const item = current;
          current[message.type] = track(
            Promise.resolve()
              .then(() => planWrite)
              .then(assertScope)
              .then(() =>
                MotionArtifactStore.put({
                  ...scope,
                  frameId,
                  kind:
                    message.type === "clip" ? "source_clip" : "source_audio",
                  blob: message.blob,
                  duration: message.duration,
                }),
              )
              .catch((error) => {
                if (!continueOnFrameError) throw error;
                const raw = String(
                  error?.code || error?.message || "MOTION_SPLIT_FAILED",
                );
                item.metadata = {
                  ...item.metadata,
                  errorCode: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                    ? raw
                    : "MOTION_SPLIT_FAILED",
                  failureStage: message.type === "clip" ? "split" : "audio",
                };
              }),
          );
          current[message.type].catch(finish);
          ack();
          return;
        }
        if (message.type === "done") {
          if (
            !plan ||
            current ||
            next !== plan.count ||
            message.count !== plan.count
          )
            return finish(new Error("SPLIT_ARTIFACT_COUNT_MISMATCH"));
          finish(null, { runId: id, plan, frames });
        }
      };
      timer = setTimeout(
        () => finish(new Error("MOTION_SPLIT_TIMEOUT")),
        timeoutMs,
      );
      try {
        worker.postMessage({
          type: "split",
          mode: "motion",
          id,
          blob,
          maxSeconds,
          includeAudio,
          cutStrategy,
          ackEachFrame: true,
          ...(continueOnFrameError && {
            continueOnFrameError,
            maxFrameRetries,
          }),
        });
      } catch (error) {
        finish(error);
      }
    });
  }
}
globalThis.MotionSplitWorkerTask = MotionSplitWorkerTask;
