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
class MotionWebCapture {
  static turn(fn) {
    const work = this._tail
      .catch(() => {})
      .then(async () => {
        const entries =
          (await chrome.storage.local.get(this.KEY))[this.KEY] || {};
        const before = JSON.stringify(entries);
        const result = await fn(entries);
        if (JSON.stringify(entries) !== before)
          await chrome.storage.local.set({ [this.KEY]: entries });
        return result;
      });
    this._tail = work;
    return work;
  }
  static async prepare(message, target, sender) {
    if (
      sender?.id !== chrome.runtime.id ||
      !Number.isInteger(target?.tabId) ||
      target.projectId !== message.flowProjectId ||
      !["motion-editor.html", "motion-runner.html"].some(
        (page) => sender?.url?.split(/[?#]/)[0] === chrome.runtime.getURL(page),
      )
    )
      throw new Error("MOTION_WEB_CAPTURE_SCOPE");
    const id = crypto.randomUUID();
    const entry = {
      id,
      target,
      userId: Number(message.userId),
      toolProjectId: message.toolProjectId,
      sourceRevision: Number(message.sourceRevision),
      frameId: message.frameId,
      artifactRevision: Number(message.artifactRevision),
      resolution: message.resolution,
      stagingOperationId: message.stagingOperationId || null,
      senderUrl: sender.url,
      filename: `TobyFlow/motion-cache/${id}.mp4`,
      expires: Date.now() + 9e5,
    };
    await this.turn((entries) => {
      entries[id] = entry;
    });
    await chrome.alarms.create("motionWebCaptureCleanup", {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
    return { id, filename: entry.filename };
  }
  static async prepareWorkflow(message, target, sender) {
    if (
      sender?.id !== chrome.runtime.id ||
      !Number.isInteger(target?.tabId) ||
      target.projectId !== message.flowProjectId ||
      !["workflow-editor.html", "sidebar.html", "run-window.html"].some(
        (page) => sender?.url?.split(/[?#]/)[0] === chrome.runtime.getURL(page),
      ) ||
      !message.workflowId ||
      !message.nodeId ||
      !message.operationId ||
      !message.resolution
    )
      throw new Error("WORKFLOW_VIDEO_CAPTURE_SCOPE");
    const id = crypto.randomUUID();
    const entry = {
      id,
      kind: "workflow",
      captureOnly: true,
      target,
      userId: Number(message.userId),
      workflowId: message.workflowId,
      nodeId: message.nodeId,
      mergeOperationId: message.operationId,
      resolution: message.resolution,
      senderUrl: sender.url,
      filename: `TobyFlow/workflow-cache/${id}.mp4`,
      expires: Date.now() + 9e5,
    };
    await this.turn((entries) => {
      entries[id] = entry;
    });
    await chrome.alarms.create("motionWebCaptureCleanup", {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
    return { id, filename: entry.filename, captureOnly: true };
  }
  static getWorkflow(id, message, sender) {
    return this.turn((entries) => {
      const entry = entries[id];
      if (
        !entry ||
        entry.kind !== "workflow" ||
        entry.expires < Date.now() ||
        entry.senderUrl !== sender?.url ||
        ["userId", "workflowId", "nodeId", "resolution"].some(
          (key) => entry[key] !== message[key],
        ) ||
        entry.mergeOperationId !== message.operationId
      )
        throw new Error("WORKFLOW_VIDEO_CAPTURE_SCOPE");
      entry.expires = Date.now() + 24e4;
      return { ...entry };
    });
  }
  static control(id, message, sender, target, auth) {
    return this.turn((entries) => {
      const entry = entries[id];
      if (
        !entry ||
        entry.expires < Date.now() ||
        Number(auth?.user?.id) !== entry.userId ||
        !auth?.token ||
        sender?.id !== chrome.runtime.id ||
        sender?.tab?.id !== entry.target.tabId ||
        target?.projectId !== entry.target.projectId ||
        target?.origin !== entry.target.origin ||
        target?.driverKey !== entry.target.driverKey
      )
        throw new Error("MOTION_WEB_CAPTURE_SCOPE");
      if (message.kind === "arm") {
        if (entry.operationId && entry.operationId !== message.operationId)
          throw new Error("MOTION_WEB_CAPTURE_ALREADY_ARMED");
        if (
          typeof message.operationId !== "string" ||
          !message.operationId.startsWith("dl_")
        )
          throw new Error("MOTION_WEB_CAPTURE_OPERATION");
        entry.operationId = message.operationId;
      } else if (message.kind === "blob") {
        if (
          entry.operationId !== message.operationId ||
          entry.blobUrl ||
          typeof message.blobUrl !== "string" ||
          !message.blobUrl.startsWith(`blob:${entry.target.origin}/`) ||
          !Number.isSafeInteger(message.size) ||
          message.size < 12 ||
          message.size > 200 * 1024 * 1024
        )
          throw new Error("MOTION_WEB_CAPTURE_BLOB");
        entry.blobUrl = message.blobUrl;
        entry.size = message.size;
      } else throw new Error("MOTION_WEB_CAPTURE_OPERATION");
      return {
        success: true,
        captureOnly: entry.kind === "workflow" && entry.captureOnly === true,
      };
    });
  }
  static claim(item) {
    return this.turn((entries) => {
      const entry = Object.values(entries).find(
        (value) =>
          value.expires >= Date.now() &&
          !value.captureOnly &&
          value.blobUrl &&
          [item.url, item.finalUrl].includes(value.blobUrl),
      );
      if (!entry) return null;
      if (entry.downloadId && entry.downloadId !== item.id)
        throw new Error("MOTION_WEB_CAPTURE_DUPLICATE");
      entry.downloadId = item.id;
      return { ...entry };
    });
  }
  static get(id, message, sender) {
    return this.turn((entries) => {
      const entry = entries[id];
      if (
        !entry ||
        entry.expires < Date.now() ||
        entry.senderUrl !== sender?.url ||
        [
          "userId",
          "toolProjectId",
          "sourceRevision",
          "frameId",
          "artifactRevision",
          "resolution",
        ].some((key) => entry[key] !== message[key]) ||
        entry.stagingOperationId !== (message.stagingOperationId || null)
      )
        throw new Error("MOTION_WEB_CAPTURE_SCOPE");
      entry.expires = Date.now() + 24e4;
      return { ...entry };
    });
  }
  static async read(entry) {
    if (
      !entry.operationId ||
      !entry.blobUrl?.startsWith(`blob:${entry.target.origin}/`) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 12 ||
      entry.size > 200 * 1024 * 1024
    )
      throw new Error("MOTION_WEB_CAPTURE_NOT_READY");
    if (entry.kind !== "workflow" || entry.captureOnly !== true) {
      const item = (
        await chrome.downloads.search({ id: entry.downloadId })
      )?.[0];
      if (
        !item ||
        item.state !== "complete" ||
        ![item.url, item.finalUrl].includes(entry.blobUrl) ||
        !item.filename?.replace(/\\/g, "/").endsWith(`/${entry.filename}`) ||
        (Number.isFinite(item.fileSize) &&
          item.fileSize >= 0 &&
          item.fileSize !== entry.size)
      )
        throw new Error("MOTION_WEB_CAPTURE_DOWNLOAD_UNVERIFIED");
    }
    const target = describeFlowTab(await chrome.tabs.get(entry.target.tabId));
    if (
      target?.projectId !== entry.target.projectId ||
      target?.origin !== entry.target.origin ||
      target?.driverKey !== entry.target.driverKey
    )
      throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    const chunks = [];
    const deadline = Date.now() + 18e4;
    for (let offset = 0; offset < entry.size; ) {
      if (Date.now() > deadline)
        throw new Error("MOTION_WEB_CAPTURE_READ_TIMEOUT");
      let timer;
      let reply;
      try {
        reply = await Promise.race([
          chrome.tabs.sendMessage(entry.target.tabId, {
            action: "motionWebCaptureRead",
            captureId: entry.id,
            operationId: entry.operationId,
            blobUrl: entry.blobUrl,
            offset,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("MOTION_WEB_CAPTURE_READ_TIMEOUT")),
              1e4,
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (
        !reply?.success ||
        reply.size !== entry.size ||
        reply.offset !== offset ||
        typeof reply.base64 !== "string" ||
        reply.base64.length > 71e4
      )
        throw new Error("MOTION_WEB_CAPTURE_CHUNK_INVALID");
      const binary = atob(reply.base64),
        bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      if (bytes.length !== Math.min(512 * 1024, entry.size - offset))
        throw new Error("MOTION_WEB_CAPTURE_CHUNK_INVALID");
      chunks.push(bytes);
      offset += bytes.length;
    }
    const blob = new Blob(chunks, { type: "video/mp4" });
    const prefix = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...prefix.subarray(4, 8)) !== "ftyp")
      throw new Error("MOTION_VIDEO_BYTES_INVALID");
    return blob;
  }
  static async release(id, expiredOnly = false) {
    return this.turn(async (entries) => {
      const entry = entries[id];
      if (!entry || (expiredOnly && entry.expires >= Date.now())) return;
      if (entry.operationId) {
        await chrome.tabs
          .sendMessage(entry.target.tabId, {
            action: "motionWebCaptureRelease",
            operationId: entry.operationId,
            captureId: entry.id,
            blobUrl: entry.blobUrl,
          })
          .catch(() => {});
      }
      if (entry.downloadId) {
        const item = (
          await chrome.downloads.search({ id: entry.downloadId })
        )?.[0];
        if (item && [item.url, item.finalUrl].includes(entry.blobUrl)) {
          if (item.state === "in_progress")
            await chrome.downloads.cancel(item.id);
          const latest = (await chrome.downloads.search({ id: item.id }))?.[0];
          if (latest?.state === "complete")
            await chrome.downloads.removeFile(item.id);
          await chrome.downloads.erase({ id: item.id });
        }
      }
      delete entries[id];
    });
  }
  static async sweep() {
    const entries = (await chrome.storage.local.get(this.KEY))[this.KEY] || {};
    for (const entry of Object.values(entries))
      if (entry.expires < Date.now()) await this.release(entry.id, true);
    if (
      !Object.keys((await chrome.storage.local.get(this.KEY))[this.KEY] || {})
        .length
    )
      await chrome.alarms.clear("motionWebCaptureCleanup");
  }
}
__publicField(MotionWebCapture, "KEY", "tobyflow_motion_web_captures");
__publicField(MotionWebCapture, "_tail", Promise.resolve());
globalThis.MotionWebCapture = MotionWebCapture;
