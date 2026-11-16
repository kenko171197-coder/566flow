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
class WorkflowMuseVideoStore {
  static _scope(workflowId, userId = globalThis.authManager?.getUser?.()?.id) {
    if (!userId || !workflowId)
      throw new Error("MUSE_LOCAL_VIDEO_SCOPE_MISSING");
    return `${userId}\0${workflowId}`;
  }
  static _db() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("videos", {
            keyPath: "key",
          });
          store.createIndex("scope", "scope", { unique: false });
          store.createIndex("node", "node", { unique: false });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this._dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("MUSE_LOCAL_VIDEO_STORE_BLOCKED"));
      }).catch((error) => {
        this._dbPromise = null;
        throw error;
      });
    }
    return this._dbPromise;
  }
  static async _transaction(mode, enqueue) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("videos", mode);
      const store = tx.objectStore("videos");
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () =>
        reject(tx.error || new Error("MUSE_LOCAL_VIDEO_STORE_ABORTED"));
      try {
        enqueue(store, (result) => {
          value = result;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  static async put(workflowId, nodeId, fileId, blob, poster = "", userId) {
    if (
      !nodeId ||
      !fileId ||
      !(blob instanceof Blob) ||
      !/^video\//i.test(blob.type) ||
      !blob.size
    )
      throw new Error("MUSE_LOCAL_VIDEO_INVALID");
    const actorUserId = globalThis.authManager?.getUser?.()?.id;
    const scope = this._scope(workflowId, userId);
    const node = `${scope}\0${nodeId}`;
    const key = `${node}\0${fileId}`;
    if (!/^data:image\//i.test(poster)) {
      try {
        poster =
          (await globalThis.ImmediateUploader?._portableVideoThumbnail?.(
            blob,
            200,
            { representativeFrame: true },
          )) || "";
      } catch (_) {
        poster = "";
      }
    }
    if (
      actorUserId != null &&
      String(globalThis.authManager?.getUser?.()?.id) !== String(actorUserId)
    )
      throw new Error("MUSE_OWNER_CHANGED");
    await this._transaction("readwrite", (store) => {
      store.put({
        key,
        scope,
        node,
        fileId,
        blob,
        poster: /^data:image\//i.test(poster) ? poster : "",
        createdAt: Date.now(),
      });
    });
    console.info?.("[WorkflowLocalVideo]", {
      stage: "saved",
      posterReady: /^data:image\//i.test(poster),
    });
    return true;
  }
  static async putImage(workflowId, nodeId, fileId, blob, userId) {
    if (
      !nodeId ||
      !fileId ||
      !(blob instanceof Blob) ||
      !/^image\//i.test(blob.type) ||
      !blob.size
    )
      throw new Error("WORKFLOW_LOCAL_IMAGE_INVALID");
    const scope = this._scope(workflowId, userId);
    const node = `${scope}\0${nodeId}`;
    const key = `${node}\0${fileId}`;
    await this._transaction("readwrite", (store) => {
      store.put({ key, scope, node, fileId, blob, createdAt: Date.now() });
    });
    return true;
  }
  static async getImageDataUrl(workflowId, nodeId, fileId) {
    const saved = await this.get(workflowId, nodeId, fileId);
    if (!saved?.blob || !/^image\//i.test(saved.blob.type)) return null;
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () =>
        reject(reader.error || new Error("WORKFLOW_LOCAL_IMAGE_READ_FAILED"));
      reader.readAsDataURL(saved.blob);
    });
  }
  static async get(workflowId, nodeId, fileId, userId) {
    if (!nodeId || !fileId) return null;
    const key = `${this._scope(workflowId, userId)}\0${nodeId}\0${fileId}`;
    return this._transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result || null);
    });
  }
  static async ensurePoster(workflowId, nodeId, fileId, userId) {
    const current = () =>
      String(globalThis.authManager?.getUser?.()?.id || "") === String(userId);
    if (!current()) throw new Error("MUSE_OWNER_CHANGED");
    const record = await this.get(workflowId, nodeId, fileId, userId);
    if (!record?.blob?.type?.startsWith("video/")) return null;
    if (/^data:image\//i.test(record.poster || "")) return record.poster;
    const poster =
      await globalThis.ImmediateUploader?._portableVideoThumbnail?.(
        record.blob,
        200,
        { representativeFrame: true },
      );
    if (!current()) throw new Error("MUSE_OWNER_CHANGED");
    if (!/^data:image\//i.test(poster || "")) return null;
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(record.key);
      request.onsuccess = () => {
        const saved = request.result;
        if (!current() || !saved || saved.createdAt !== record.createdAt) {
          done(null);
          return;
        }
        store.put({ ...saved, poster });
        done(poster);
      };
    });
  }
  static async deleteFile(
    workflowId,
    nodeId,
    fileId,
    userId,
    before = Infinity,
  ) {
    const ownerUserId = userId ?? globalThis.authManager?.getUser?.()?.id;
    const key = `${this._scope(workflowId, ownerUserId)}\0${nodeId}\0${fileId}`;
    const outcome = await this._transaction("readwrite", (store, done) => {
      const read = store.get(key);
      read.onsuccess = () => {
        if (
          read.result &&
          Number.isFinite(before) &&
          (!Number.isFinite(read.result.createdAt) ||
            read.result.createdAt >= before)
        ) {
          done({ keptNewer: true, removed: false });
          return;
        }
        store.delete(key);
        done({ keptNewer: false, removed: !!read.result });
      };
    });
    if (!outcome.keptNewer)
      await globalThis.MuseApiFacade?.discardWorkflowMediaFiles?.(
        workflowId,
        nodeId,
        [fileId],
        ownerUserId,
        before,
      );
    return outcome.removed;
  }
  static async _deleteByIndex(indexName, key, before = Infinity) {
    return this._transaction("readwrite", (store, done) => {
      const removed = [];
      const cursor = store.index(indexName).openCursor(IDBKeyRange.only(key));
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) {
          done(removed);
          return;
        }
        if (
          Number.isFinite(before) &&
          (!Number.isFinite(row.value.createdAt) ||
            row.value.createdAt >= before)
        ) {
          row.continue();
          return;
        }
        removed.push({
          nodeId: row.value.node.split("\0").at(-1),
          fileId: row.value.fileId,
        });
        row.delete();
        row.continue();
      };
    });
  }
  static async deleteNode(workflowId, nodeId, ownerUserId) {
    if (!nodeId) return;
    const userId = ownerUserId ?? globalThis.authManager?.getUser?.()?.id;
    globalThis.WorkflowVideoMerge?.cancelScope(workflowId, nodeId, userId);
    const removed = await this._deleteByIndex(
      "node",
      `${this._scope(workflowId, userId)}\0${nodeId}`,
    );
    await globalThis.MuseApiFacade?.discardWorkflowMediaFiles?.(
      workflowId,
      nodeId,
      removed.map((row) => row.fileId),
      userId,
    );
  }
  static async deleteWorkflow(workflowId, before = Infinity, ownerUserId) {
    const userId = ownerUserId ?? globalThis.authManager?.getUser?.()?.id;
    globalThis.WorkflowVideoMerge?.cancelScope(workflowId, null, userId);
    const removed = await this._deleteByIndex(
      "scope",
      this._scope(workflowId, userId),
      before,
    );
    for (const nodeId of new Set(removed.map((row) => row.nodeId)))
      await globalThis.MuseApiFacade?.discardWorkflowMediaFiles?.(
        workflowId,
        nodeId,
        removed.filter((row) => row.nodeId === nodeId).map((row) => row.fileId),
        userId,
      );
  }
  static async workflowIds() {
    const prefix = `${globalThis.authManager?.getUser?.()?.id}\0`;
    const ids = new Set();
    await this._transaction("readonly", (store, done) => {
      const cursor = store.index("scope").openKeyCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) {
          done();
          return;
        }
        const scope = String(cursor.result.key);
        if (scope.startsWith(prefix)) ids.add(scope.slice(prefix.length));
        cursor.result.continue();
      };
    });
    return [...ids];
  }
  static async reconcileWorkflow(
    workflowId,
    nodeIds,
    before = Infinity,
    userId,
  ) {
    const scope = this._scope(workflowId, userId),
      keep = new Set(nodeIds.map((id) => `${scope}\0${id}`));
    return this._transaction("readwrite", (store) => {
      const cursor = store.index("scope").openCursor(IDBKeyRange.only(scope));
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (
          !keep.has(entry.value.node) &&
          (!Number.isFinite(before) ||
            (Number.isFinite(entry.value.createdAt) &&
              entry.value.createdAt < before))
        )
          entry.delete();
        entry.continue();
      };
    });
  }
  static async retireNodeResults(workflowId, nodeId, keepIds, before, userId) {
    const node = `${this._scope(workflowId, userId)}\0${nodeId}`,
      keep = new Set(keepIds);
    return this._transaction("readwrite", (store) => {
      const cursor = store.index("node").openCursor(IDBKeyRange.only(node));
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (!keep.has(entry.value.fileId) && entry.value.createdAt <= before)
          entry.delete();
        entry.continue();
      };
    });
  }
}
__publicField(
  WorkflowMuseVideoStore,
  "DB_NAME",
  "tobyflow_workflow_muse_videos",
);
__publicField(WorkflowMuseVideoStore, "_dbPromise", null);
globalThis.WorkflowMuseVideoStore = WorkflowMuseVideoStore;
globalThis.WorkflowResultMediaStore = WorkflowMuseVideoStore;
