class MotionMergeTask {
  static timeoutMs() {
    const seconds = globalThis.ExecutionConfig?.getTimeoutSec?.();
    if (
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      !Number.isSafeInteger(seconds * 1e3) ||
      seconds * 1e3 > 2147483647
    )
      throw new Error("MOTION_MEDIA_TIMEOUT_CONFIG_INVALID");
    return seconds * 1e3;
  }
  static measureDuration(blob, options = {}) {
    return this.start([blob], () => {}, {
      ...options,
      metadataOnly: true,
    }).promise.then((result) => {
      if (!Number.isFinite(result.duration) || result.duration <= 0)
        throw new Error("MOTION_VIDEO_DURATION_INVALID");
      return result.duration;
    });
  }
  static slowDown(blob, onProgress = () => {}, options = {}) {
    return this.setSpeed(blob, 0.6, onProgress, options);
  }
  static setSpeed(blob, playbackRate, onProgress = () => {}, options = {}) {
    if (
      typeof playbackRate !== "number" ||
      !Number.isFinite(playbackRate) ||
      playbackRate <= 0
    )
      throw new Error("MOTION_VIDEO_SPEED_INVALID");
    return this.start([blob], onProgress, { ...options, playbackRate });
  }
  static start(clips, onProgress = () => {}, options = {}) {
    const timeoutMs = this.timeoutMs();
    const id = crypto.randomUUID();
    const worker = new Worker(
      chrome.runtime.getURL("src/motion/motion-merge-worker.js"),
    );
    let settled = false;
    let resolveTask;
    let rejectTask;
    let timer;
    const promise = new Promise((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.onmessage = worker.onerror = null;
      worker.terminate();
      if (error)
        rejectTask(error instanceof Error ? error : new Error(String(error)));
      else resolveTask(result);
    };
    const abort = () => finish(new Error("MOTION_CANCELLED"));
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) =>
      finish(new Error(event.message || "MERGE_WORKER_FAILED"));
    worker.onmessage = (event) => {
      const result = event.data || {};
      if (result.id !== id || settled) return;
      if (result.type === "progress") {
        try {
          onProgress(result);
        } catch (_) {}
      } else if (result.type === "error") finish(new Error(result.code));
      else if (result.type === "done") finish(null, result);
    };
    if (options.signal?.aborted) abort();
    if (!settled)
      timer = setTimeout(
        () =>
          finish(
            new Error(
              options.metadataOnly
                ? "MOTION_VIDEO_METADATA_TIMEOUT"
                : options.playbackRate !== void 0 && options.playbackRate !== 1
                  ? "MOTION_VIDEO_SPEED_TIMEOUT"
                  : "MOTION_MERGE_TIMEOUT",
            ),
          ),
        timeoutMs,
      );
    try {
      if (!settled)
        worker.postMessage({
          type: options.metadataOnly ? "measure_duration" : "merge",
          id,
          clips,
          normalizeVideo: true,
          ...(options.originalAudio !== void 0
            ? {
                originalAudio: options.originalAudio,
                originalAudioRanges: options.originalAudioRanges,
              }
            : {}),
          ...(options.workflow === true ? { allowMixedAudio: true } : {}),
          ...(options.playbackRate !== void 0
            ? { playbackRate: options.playbackRate }
            : {}),
        });
    } catch (error) {
      finish(error);
    }
    return {
      worker,
      promise,
      cancel() {
        if (settled) return;
        try {
          worker.postMessage({ type: "cancel", id });
        } catch (_) {}
        finish(new Error("MOTION_CANCELLED"));
      },
    };
  }
}
globalThis.MotionMergeTask = MotionMergeTask;
