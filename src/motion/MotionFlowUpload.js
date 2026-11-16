var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) =>
  key in obj
    ? __defProp(obj, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value,
      })
    : (obj[key] = value);
var __publicField = (obj, key, value) =>
  __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
class MotionFlowUpload {
  static async getUploadConcurrency() {
    await window.ExecutionConfig.getConfig();
    const config = await window.ProviderConfigManager.fetchFlowApiV2Configs();
    const api = Number(config?.runtime?.max_concurrent);
    const system = Number(window.ExecutionConfig.getQueueVideoMaxMonitor());
    if (
      !Number.isSafeInteger(api) ||
      api < 1 ||
      !Number.isSafeInteger(system) ||
      system < 1
    ) {
      console.warn(
        "[MotionApiUpload]",
        JSON.stringify({
          stage: "limits_invalid",
          runtimeMaxConcurrent: api,
          queueVideoMaxMonitor: system,
        }),
      );
      throw new Error("MOTION_FLOW_CONFIG_INVALID");
    }
    const effective = Math.min(api, system),
      key = `${api}:${system}`;
    if (this._uploadLimitsKey !== key) {
      this._uploadLimitsKey = key;
      console.info(
        "[MotionApiUpload]",
        JSON.stringify({
          stage: "limits",
          runtimeMaxConcurrent: api,
          queueVideoMaxMonitor: system,
          effective,
        }),
      );
    }
    return effective;
  }
  static async runBatch({ items, getLimit, run, shouldStop = () => false }) {
    const pending = [...items],
      active = new Set();
    let failure = null;
    while (pending.length || active.size) {
      if (!failure && !shouldStop() && pending.length) {
        let limit;
        try {
          limit = await getLimit();
          if (!Number.isSafeInteger(limit) || limit < 1)
            throw new Error("MOTION_FLOW_CONFIG_INVALID");
        } catch (error) {
          failure = error;
        }
        while (
          !failure &&
          !shouldStop() &&
          pending.length &&
          active.size < limit
        ) {
          const item = pending.shift();
          const task = Promise.resolve()
            .then(() => run(item))
            .catch((error) => {
              failure || (failure = error);
            })
            .finally(() => active.delete(task));
          active.add(task);
        }
      }
      if (active.size) await Promise.race(active);
      else break;
    }
    if (failure) throw failure;
    return { remaining: pending, stopped: shouldStop() };
  }
  static async upload(options) {
    if (options.mode !== "api" || options.parallelApi !== true)
      return this._uploadInSlot(options);
    const frameId =
      /^motion_(f\d+)\.mp4$/.exec(String(options.name || ""))?.[1] || null;
    for (;;) {
      if (options.abortFn?.())
        throw Object.assign(new Error("UPLOAD_STOPPED"), {
          notDispatched: true,
        });
      const limit = await this.getUploadConcurrency();
      if (options.abortFn?.())
        throw Object.assign(new Error("UPLOAD_STOPPED"), {
          notDispatched: true,
        });
      if (this._apiUploads < limit) {
        this._apiUploads++;
        break;
      }
      await new Promise((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          this._apiUploadWaiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, 250);
        this._apiUploadWaiters.add(wake);
      });
    }
    try {
      const locks = window.navigator?.locks,
        userId = Number(options.stopScope?.userId);
      if (
        !locks?.request ||
        !locks?.query ||
        !Number.isSafeInteger(userId) ||
        userId < 1
      )
        throw Object.assign(new Error("PROJECT_LOCK_UNAVAILABLE"), {
          notDispatched: true,
        });
      const prefix = `motion-flow-api-upload:${userId}:`;
      for (;;) {
        if (options.abortFn?.())
          throw Object.assign(new Error("UPLOAD_STOPPED"), {
            notDispatched: true,
          });
        const limit = await this.getUploadConcurrency();
        for (let slot = 0; slot < limit; slot++) {
          const result = await locks.request(
            prefix + slot,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) return { acquired: false };
              if (options.abortFn?.())
                throw Object.assign(new Error("UPLOAD_STOPPED"), {
                  notDispatched: true,
                });
              const held = (await locks.query()).held.filter((item) =>
                item.name.startsWith(prefix),
              ).length;
              if (held > limit) return { acquired: false };
              console.info(
                "[MotionApiUpload]",
                JSON.stringify({
                  stage: "slot_acquired",
                  frameId,
                  active: held,
                  limit,
                  slot,
                }),
              );
              return {
                acquired: true,
                value: await this._uploadInSlot(options),
              };
            },
          );
          if (result.acquired) return result.value;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      this._apiUploads--;
      for (const wake of [...this._apiUploadWaiters]) wake();
      console.info(
        "[MotionApiUpload]",
        JSON.stringify({
          stage: "slot_released",
          frameId,
          localActive: this._apiUploads,
        }),
      );
    }
  }
  static async retryPreDispatch(
    operation,
    { maxRetries, beforeRetry, onRetry, delay, retryTransientUpload = false },
  ) {
    if (!Number.isInteger(maxRetries) || maxRetries < 0)
      throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const transientUpload =
          retryTransientUpload &&
          window.FlowApiDownloadRetry?.retryable?.(error) === true;
        if (
          (error?.notDispatched !== true && !transientUpload) ||
          error?.noRetry === true ||
          error?.noReplay === true ||
          attempt >= maxRetries
        )
          throw error;
        await beforeRetry();
        onRetry(attempt + 1, maxRetries, error);
        await delay();
        await beforeRetry();
      }
    }
  }
  static async base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const match = /^data:video\/mp4;base64,([\s\S]+)$/i.exec(
          String(reader.result || ""),
        );
        match
          ? resolve(match[1])
          : reject(new Error("MOTION_CLIP_ENCODING_INVALID"));
      };
      reader.onerror = () =>
        reject(reader.error || new Error("MOTION_CLIP_READ_FAILED"));
      reader.readAsDataURL(blob);
    });
  }
  static async restoreSourceClip(options) {
    const { maxRetries = 0, beforeRetry, waitBeforeRetry, onRetry } = options;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
      throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
    for (let retryCount = 0; ; retryCount++) {
      try {
        return await this._restoreSourceClip(options);
      } catch (error) {
        const code = error?.code || error?.message;
        if (
          !["MOTION_SPLIT_TIMEOUT", "SPLIT_WORKER_FAILED"].includes(code) ||
          error?.noRetry === true ||
          error?.noReplay === true ||
          retryCount >= maxRetries ||
          options.abortFn?.() ||
          typeof beforeRetry !== "function" ||
          typeof waitBeforeRetry !== "function"
        )
          throw error;
        await beforeRetry();
        onRetry?.(retryCount + 1, maxRetries, error);
        await waitBeforeRetry();
        await beforeRetry();
      }
    }
  }
  static _restoreSourceClip({
    blob,
    start,
    end,
    maxSeconds,
    abortFn = () => false,
  }) {
    if (
      !(blob instanceof Blob) ||
      !blob.size ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      !Number.isFinite(maxSeconds) ||
      maxSeconds < 1 ||
      end - start > maxSeconds + 0.001
    )
      throw new Error("MOTION_SPLIT_CONFIG_INVALID");
    const timeoutMs = globalThis.MotionMergeTask.timeoutMs();
    if (abortFn()) throw new Error("MOTION_CANCELLED");
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        chrome.runtime.getURL("src/core/video-split-worker.js"),
      );
      let clip = null,
        timer,
        poll,
        settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        worker.onmessage = worker.onerror = null;
        worker.terminate();
        error ? reject(error) : resolve(result);
      };
      worker.onerror = (event) =>
        finish(new Error(event.message || "SPLIT_WORKER_FAILED"));
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.id !== id) return;
        if (abortFn()) return finish(new Error("MOTION_CANCELLED"));
        if (message.type === "error")
          return finish(new Error(message.code || "MOTION_SPLIT_FAILED"));
        if (message.type === "clip") {
          if (clip) return finish(new Error("SPLIT_ARTIFACT_COUNT_MISMATCH"));
          clip = message;
        }
        if (message.type === "done") {
          if (
            message.count !== 1 ||
            !(clip?.blob instanceof Blob) ||
            clip.blob.type !== "video/mp4" ||
            !clip.blob.size
          )
            return finish(new Error("SPLIT_ARTIFACT_COUNT_MISMATCH"));
          finish(null, clip.blob);
        }
      };
      timer = setTimeout(
        () => finish(new Error("MOTION_SPLIT_TIMEOUT")),
        timeoutMs,
      );
      poll = setInterval(() => {
        if (abortFn()) finish(new Error("MOTION_CANCELLED"));
      }, 200);
      try {
        worker.postMessage({
          type: "split",
          mode: "motion",
          id,
          blob,
          includeAudio: false,
          maxSeconds,
          range: { start, end },
        });
      } catch (error) {
        finish(error);
      }
    });
  }
  static async _uploadInSlot({
    blob,
    name,
    target,
    mode,
    abortFn = () => false,
    onDispatch = () => {},
    stopScope = null,
    parallelApi = false,
  }) {
    if (
      !(blob instanceof Blob) ||
      blob.type !== "video/mp4" ||
      blob.size < 1 ||
      blob.size > this.MAX_CLIP_BYTES
    )
      throw new Error("MOTION_CLIP_UPLOAD_SIZE_OR_TYPE_INVALID");
    if (!target?.projectId || !Number.isInteger(target.tabId))
      throw new Error("MOTION_FLOW_TARGET_REQUIRED");
    if (!["web", "api"].includes(mode))
      throw new Error("MOTION_FLOW_RUN_MODE_REQUIRED");
    if (!window.MessageBridge?.uploadFilesToFlow)
      throw new Error("MOTION_FLOW_UPLOAD_UNAVAILABLE");
    if (abortFn()) throw new Error("UPLOAD_STOPPED");
    const payload = [
      {
        name: String(name || "motion-clip.mp4"),
        type: "video/mp4",
        base64: await this.base64(blob),
      },
    ];
    const control =
      stopScope && window.MessageBridge.createUploadControl?.(1, abortFn);
    if (control) control.motionScope = { ...stopScope };
    try {
      const result = await window.MessageBridge.uploadFilesToFlow(payload, {
        surface: "workflow",
        expectedFlowTarget: target,
        abortFn,
        forceDom: mode === "web",
        requiredMode: mode,
        onBeforeTransport: onDispatch,
        ...(parallelApi && mode === "api" && { motionApiParallel: true }),
        ...(control && { control }),
      });
      if (abortFn()) throw new Error("UPLOAD_STOPPED");
      const current = await window.MessageBridge.getTargetContext(target);
      if (
        !current ||
        current.tabId !== target.tabId ||
        current.projectId !== target.projectId ||
        current.driverKey !== target.driverKey ||
        current.origin !== target.origin
      ) {
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
      }
      const detail = result?.tileDetails?.[0];
      if (
        result?.error ||
        !detail?.id ||
        (detail.type && detail.type !== "video") ||
        (detail.project_id && detail.project_id !== target.projectId) ||
        result.tileDetails.length !== 1
      ) {
        throw new Error(result?.error || "MOTION_UPLOAD_RECEIPT_UNVERIFIED");
      }
      if ((detail.api_driver ? "api" : "web") !== mode) {
        throw new Error("MOTION_FLOW_MODE_CHANGED_DURING_UPLOAD");
      }
      const mediaUuid = detail.media_uuid || detail.id;
      if (
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
          String(mediaUuid || ""),
        )
      )
        throw new Error("MOTION_UPLOAD_RECEIPT_UNVERIFIED");
      return {
        mediaId: detail.persistent_media_id || detail.id,
        mediaUuid,
        projectId: target.projectId,
        persistentMediaId: detail.persistent_media_id || null,
        mode: detail.api_driver ? "api" : "web",
        apiDriver: detail.api_driver || null,
        protocolRevision: detail.protocol_revision || null,
        protocolFingerprint: detail.protocol_fingerprint || null,
        fileName: detail.file_name || null,
        upload_name: Array.from(
          String(detail.uploadName || payload[0].name || ""),
        )
          .slice(0, 255)
          .join(""),
        ...(detail.display_name && {
          display_name: Array.from(String(detail.display_name))
            .slice(0, 255)
            .join(""),
        }),
      };
    } finally {
      control?.finish();
      payload[0].base64 = "";
    }
  }
}
__publicField(MotionFlowUpload, "MAX_CLIP_BYTES", 40 * 1024 * 1024);
__publicField(MotionFlowUpload, "_apiUploads", 0);
__publicField(MotionFlowUpload, "_apiUploadWaiters", new Set());
globalThis.MotionFlowUpload = MotionFlowUpload;
