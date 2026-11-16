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
class WorkflowSpaceArtifacts {
  static async handle(message, sender, dependencies) {
    const { readAuth, authorizeWorkflow, store } = dependencies;
    const auth = await readAuth();
    const userId = String(auth?.user?.id || "");
    if (!auth?.token || !userId || String(message.userId) !== userId)
      throw new Error("SPACE_ARTIFACT_ACCOUNT_MISMATCH");
    const document = `${sender.tab?.id}:${sender.documentId || sender.url || ""}`;
    const now = Date.now();
    for (const [id, transfer2] of this.transfers) {
      if (transfer2.expires <= now || transfer2.userId !== userId)
        this.transfers.delete(id);
    }
    const stillAuthorized = async () => {
      const current = await readAuth();
      if (current?.token !== auth.token || String(current?.user?.id) !== userId)
        throw new Error("SPACE_ARTIFACT_ACCOUNT_CHANGED");
    };
    if (message.operation === "open") {
      for (const field of ["workflowId", "ownerNodeId", "fileId"]) {
        if (
          typeof message[field] !== "string" ||
          !message[field] ||
          message[field].length > (field === "fileId" ? 1024 : 200) ||
          message[field].includes("\0")
        )
          throw new Error("SPACE_ARTIFACT_INVALID_SCOPE");
      }
      await authorizeWorkflow(message, auth);
      await stillAuthorized();
      const saved = await store.get(
        message.workflowId,
        message.ownerNodeId,
        message.fileId,
        userId,
      );
      await stillAuthorized();
      if (!saved?.blob?.size || !/^(image|video)\//.test(saved.blob.type))
        throw new Error("SPACE_ARTIFACT_NOT_AVAILABLE");
      let poster = /^data:image\//.test(saved.poster || "")
        ? saved.poster
        : null;
      if (
        !poster &&
        /^video\//.test(saved.blob.type) &&
        dependencies.recoverPoster
      ) {
        try {
          const recovered = await dependencies.recoverPoster(message);
          if (/^data:image\//.test(recovered || "")) poster = recovered;
        } catch (_) {}
        await stillAuthorized();
      }
      if (
        !poster &&
        /^image\//.test(saved.blob.type) &&
        typeof createImageBitmap === "function" &&
        typeof OffscreenCanvas === "function"
      ) {
        const bitmap = await createImageBitmap(saved.blob);
        try {
          const scale = Math.min(
            1,
            480 / Math.max(bitmap.width, bitmap.height),
          );
          const canvas = new OffscreenCanvas(
            Math.max(1, Math.round(bitmap.width * scale)),
            Math.max(1, Math.round(bitmap.height * scale)),
          );
          canvas
            .getContext("2d")
            .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const bytes2 = new Uint8Array(
            await (
              await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 })
            ).arrayBuffer(),
          );
          let binary = "";
          for (let offset = 0; offset < bytes2.length; offset += 8192)
            binary += String.fromCharCode(
              ...bytes2.subarray(offset, offset + 8192),
            );
          poster = `data:image/jpeg;base64,${btoa(binary)}`;
        } finally {
          bitmap.close();
        }
      }
      await stillAuthorized();
      const transferId = crypto.randomUUID();
      this.transfers.set(transferId, {
        blob: saved.blob,
        document,
        userId,
        token: auth.token,
        expires: now + 5 * 60 * 1e3,
        scope: {
          workflowId: message.workflowId,
          ownerNodeId: message.ownerNodeId,
          fileId: message.fileId,
        },
      });
      return {
        ok: true,
        transferId,
        size: saved.blob.size,
        mime: saved.blob.type,
        chunkBytes: this.chunkBytes,
        poster,
      };
    }
    const transfer = this.transfers.get(message.transferId);
    if (
      !transfer ||
      transfer.document !== document ||
      transfer.userId !== userId ||
      transfer.token !== auth.token
    )
      throw new Error("SPACE_ARTIFACT_TRANSFER_EXPIRED");
    if (message.operation === "finalize") {
      await authorizeWorkflow(
        { ...transfer.scope, grant: message.grant },
        auth,
      );
      await stillAuthorized();
      this.transfers.delete(message.transferId);
      return { ok: true };
    }
    if (message.operation === "release") {
      this.transfers.delete(message.transferId);
      return { ok: true };
    }
    if (
      message.operation !== "read" ||
      !Number.isSafeInteger(message.offset) ||
      message.offset < 0 ||
      message.offset >= transfer.blob.size
    )
      throw new Error("SPACE_ARTIFACT_INVALID_RANGE");
    const bytes = new Uint8Array(
      await transfer.blob
        .slice(message.offset, message.offset + this.chunkBytes)
        .arrayBuffer(),
    );
    await stillAuthorized();
    let encoded = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      encoded += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    transfer.expires = Date.now() + 5 * 60 * 1e3;
    return {
      ok: true,
      offset: message.offset,
      base64: btoa(encoded),
      bytes: bytes.length,
    };
  }
}
__publicField(WorkflowSpaceArtifacts, "transfers", new Map());
__publicField(WorkflowSpaceArtifacts, "chunkBytes", 256 * 1024);
globalThis.WorkflowSpaceArtifacts = WorkflowSpaceArtifacts;
