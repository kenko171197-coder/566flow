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
class GenBatchQueueStore {
  static isPossiblyLive(record) {
    return (
      ["admitting", "running", "paused"].includes(record?.status) ||
      (record?.status === "needs_review" &&
        !!record.jobId &&
        !record.completedAt)
    );
  }
  static _scope(userId, projectId) {
    if (
      userId === null ||
      userId === void 0 ||
      !String(userId).trim() ||
      !projectId
    ) {
      throw new Error("BATCH_SCOPE_REQUIRED");
    }
    return `${String(userId)}\0${String(projectId)}`;
  }
  static _assetId(scope, batchId, refKey) {
    return `${scope}\0${batchId}\0${refKey}`;
  }
  static _assertSafeRecord(value, path = "") {
    if (value == null) return;
    if (value instanceof Blob) throw new Error(`BATCH_BLOB_IN_RECORD:${path}`);
    if (typeof value === "string") {
      if (/^(?:blob:|data:)/i.test(value))
        throw new Error(`BATCH_TRANSIENT_URL:${path}`);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (
        /(?:^|_)(?:access_token|refresh_token|captcha|private_config|api_key|secret)(?:$|_)/i.test(
          key,
        )
      ) {
        throw new Error(`BATCH_PRIVATE_FIELD:${path}.${key}`);
      }
      this._assertSafeRecord(child, `${path}.${key}`);
    }
  }
  static async _db() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("batches")) {
            const batches2 = db.createObjectStore("batches", {
              keyPath: "batchId",
            });
            batches2.createIndex("scope", "scope", { unique: false });
            batches2.createIndex("scopeOrder", ["scope", "order"], {
              unique: false,
            });
          }
          if (!db.objectStoreNames.contains("assets")) {
            const assets = db.createObjectStore("assets", { keyPath: "id" });
            assets.createIndex("scope", "scope", { unique: false });
            assets.createIndex("batchId", "batchId", { unique: false });
          }
          if (!db.objectStoreNames.contains("leases"))
            db.createObjectStore("leases", { keyPath: "scope" });
          const batches = request.transaction.objectStore("batches");
          if (!batches.indexNames.contains("scopeStatus"))
            batches.createIndex("scopeStatus", ["scope", "status"], {
              unique: false,
            });
          if (!batches.indexNames.contains("scopeUpdatedAt"))
            batches.createIndex("scopeUpdatedAt", ["scope", "updatedAt"], {
              unique: false,
            });
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
        request.onblocked = () => reject(new Error("BATCH_STORE_BLOCKED"));
      }).catch((error) => {
        this._dbPromise = null;
        throw error;
      });
    }
    return this._dbPromise;
  }
  static async _transaction(stores, mode, enqueue) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value;
      let failure = null;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () =>
        reject(failure || tx.error || new Error("BATCH_STORE_ABORTED"));
      tx.onerror = () => {
        failure || (failure = tx.error);
      };
      try {
        enqueue(
          tx,
          (result) => {
            value = result;
          },
          (error) => {
            failure = error;
            tx.abort();
          },
        );
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
  }
  static async list(userId, projectId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["batches"], "readonly", (tx, done) => {
      const request = tx.objectStore("batches").index("scope").getAll(scope);
      request.onsuccess = () => {
        const position = (record) =>
          Number.isFinite(record.order)
            ? record.order
            : Number.isFinite(record.createdAt)
              ? record.createdAt
              : Number.MAX_SAFE_INTEGER;
        const preferred = new Map();
        for (const record of request.result || []) {
          const key = this._importedHistoryJobKey(record);
          if (!key) continue;
          const prior = preferred.get(key);
          if (!prior || this._compareImportedHistory(record, prior) > 0)
            preferred.set(key, record);
        }
        done(
          (request.result || [])
            .filter((record) => {
              const key = this._importedHistoryJobKey(record);
              return !key || preferred.get(key) === record;
            })
            .sort(
              (a, b) =>
                position(a) - position(b) ||
                (a.createdAt || 0) - (b.createdAt || 0) ||
                String(a.batchId).localeCompare(String(b.batchId)),
            ),
        );
      };
    });
  }
  static _importedHistoryJobKey(record) {
    if (
      typeof record?.batchId !== "string" ||
      !record.batchId.startsWith("history:")
    )
      return null;
    const split = record.batchId.lastIndexOf(":");
    return split > "history:".length && record.batchId.length > split + 1
      ? `${record.scope}\0${record.batchId.slice(split + 1)}`
      : null;
  }
  static _compareImportedHistory(a, b) {
    const revision = Number(a.revision || 0) - Number(b.revision || 0);
    if (revision) return revision;
    const receiptAt = (record) =>
      Math.max(
        0,
        ...(record.terminalItems || []).map((item) =>
          Number(item?.completedAt || 0),
        ),
      );
    return (
      receiptAt(a) - receiptAt(b) ||
      Number(a.updatedAt || 0) - Number(b.updatedAt || 0)
    );
  }
  static async get(userId, projectId, batchId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["batches"], "readonly", (tx, done) => {
      const request = tx.objectStore("batches").get(batchId);
      request.onsuccess = () =>
        done(request.result?.scope === scope ? request.result : null);
    });
  }
  static async getActiveLease(userId, projectId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["leases"], "readonly", (tx, done) => {
      const request = tx.objectStore("leases").get(scope);
      request.onsuccess = () =>
        done(request.result?.expiresAt > Date.now() ? request.result : null);
    });
  }
  static async acquireLease(userId, projectId, ownerId, ttlMs = 3e4) {
    const scope = this._scope(userId, projectId);
    const now = Date.now();
    return this._transaction(
      ["leases", "batches"],
      "readwrite",
      (tx, done, fail) => {
        const leases = tx.objectStore("leases");
        const request = leases.get(scope);
        request.onsuccess = () => {
          const lease = request.result;
          if (lease && lease.ownerId !== ownerId && lease.expiresAt > now)
            return fail(new Error("BATCH_COORDINATOR_BUSY"));
          if (lease && lease.ownerId !== ownerId) {
            const candidates = tx
              .objectStore("batches")
              .index("scope")
              .getAll(scope);
            candidates.onsuccess = () => {
              if (
                candidates.result?.some((batch) => this.isPossiblyLive(batch))
              )
                return fail(new Error("BATCH_COORDINATOR_RECONCILE_REQUIRED"));
              leases.put({ scope, ownerId, expiresAt: now + ttlMs });
              done(true);
            };
          } else {
            leases.put({ scope, ownerId, expiresAt: now + ttlMs });
            done(true);
          }
        };
      },
    );
  }
  static async renewLease(userId, projectId, ownerId, ttlMs = 3e4) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["leases"], "readwrite", (tx, done, fail) => {
      const leases = tx.objectStore("leases");
      const request = leases.get(scope);
      request.onsuccess = () => {
        if (request.result?.ownerId !== ownerId)
          return fail(new Error("BATCH_COORDINATOR_LOST"));
        leases.put({ scope, ownerId, expiresAt: Date.now() + ttlMs });
        done(true);
      };
    });
  }
  static async releaseLease(userId, projectId, ownerId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["leases"], "readwrite", (tx, done) => {
      const leases = tx.objectStore("leases");
      const request = leases.get(scope);
      request.onsuccess = () => {
        if (request.result?.ownerId === ownerId) leases.delete(scope);
        done(true);
      };
    });
  }
  static async add(userId, projectId, draft, assets = [], queueLimit) {
    if (!Number.isInteger(queueLimit) || queueLimit < -1)
      throw new Error("BATCH_QUEUE_ENTITLEMENT_UNAVAILABLE");
    const scope = this._scope(userId, projectId);
    const now = Date.now();
    const batchId = draft.batchId || crypto.randomUUID();
    const uniqueAssets = new Map();
    for (const entry of assets) {
      if (!entry?.refKey || !(entry.file instanceof Blob))
        throw new Error("BATCH_ASSET_MISSING");
      uniqueAssets.set(entry.refKey, entry);
    }
    const record = {
      schemaVersion: 1,
      batchId,
      userId: String(userId),
      projectId: String(projectId),
      scope,
      status: "queued",
      revision: 1,
      createdAt: now,
      updatedAt: now,
      order: Number.isFinite(draft.order) ? draft.order : now,
      displayName:
        String(draft.displayName || "").trim() ||
        `Batch ${new Date(now).toLocaleString()}`,
      settingsSnapshot: draft.settingsSnapshot || {},
      flowExecutionMode: draft.flowExecutionMode || null,
      sequentialMode: draft.sequentialMode === true,
      refMode: draft.refMode || "none",
      refPool: Array.isArray(draft.refPool) ? draft.refPool : [],
      refImagesPerPrompt: draft.refImagesPerPrompt || null,
      frameFileIds: draft.frameFileIds || null,
      autoDownload: draft.autoDownload === true,
      items: draft.items,
    };
    if (!Array.isArray(record.items) || record.items.length === 0)
      throw new Error("BATCH_ITEMS_REQUIRED");
    this._assertSafeRecord(record);
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const batches = tx.objectStore("batches");
        const assetsStore = tx.objectStore("assets");
        const existing = batches.get(batchId);
        existing.onsuccess = () => {
          if (existing.result) return fail(new Error("BATCH_ALREADY_EXISTS"));
          const scoped = batches.index("scope").getAll(scope);
          scoped.onsuccess = () => {
            const count = (scoped.result || []).filter((batch) =>
              ["queued", "needs_review"].includes(batch.status),
            ).length;
            if (queueLimit !== -1 && count >= queueLimit) {
              const error = new Error("BATCH_QUEUE_FULL");
              error.count = count;
              error.limit = queueLimit;
              return fail(error);
            }
            batches.add(record);
            for (const entry of uniqueAssets.values()) {
              assetsStore.add({
                id: this._assetId(scope, batchId, entry.refKey),
                scope,
                batchId,
                refKey: entry.refKey,
                file: entry.file,
                name: entry.name || entry.file.name || "",
                type: entry.file.type || "",
                size: entry.file.size,
              });
            }
            done(record);
          };
        };
      },
    );
  }
  static async adoptHistory(userId, projectId, record) {
    const scope = this._scope(userId, projectId);
    if (
      !record?.jobId ||
      !record?.trackerSessionId ||
      !Array.isArray(record.items) ||
      !record.items.length ||
      record.runtimeItemIds?.length !== record.items.length
    )
      throw new Error("BATCH_HISTORY_IMPORT_UNAVAILABLE");
    const batchId = `history:${record.trackerSessionId}:${record.jobId}`;
    const value = {
      ...record,
      schemaVersion: 1,
      batchId,
      userId: String(userId),
      projectId: String(projectId),
      scope,
      revision: 1,
      createdAt: Number(record.createdAt) || Date.now(),
      updatedAt: Number(record.createdAt) || Date.now(),
      order: Number(record.createdAt) || Date.now(),
    };
    this._assertSafeRecord(value);
    return this._transaction(["batches"], "readwrite", (tx, done, fail) => {
      const store = tx.objectStore("batches");
      const request = store.index("scope").getAll(scope);
      request.onsuccess = () => {
        const existing = (request.result || [])
          .filter(
            (entry) =>
              this._importedHistoryJobKey(entry) ===
              this._importedHistoryJobKey(value),
          )
          .sort((a, b) => this._compareImportedHistory(b, a))[0];
        if (existing) return done(existing);
        store.add(value);
        done(value);
      };
    });
  }
  static async update(
    userId,
    projectId,
    batchId,
    revision,
    transform,
    newAssets = [],
  ) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const store = tx.objectStore("batches");
        const request = store.get(batchId);
        request.onsuccess = () => {
          const before = request.result;
          if (!before || before.scope !== scope)
            return fail(new Error("BATCH_NOT_FOUND"));
          if (before.revision !== revision)
            return fail(new Error("BATCH_REVISION_CONFLICT"));
          let after;
          try {
            after = transform(structuredClone(before));
          } catch (error) {
            return fail(error);
          }
          if (!after || after.batchId !== batchId || after.scope !== scope)
            return fail(new Error("BATCH_SCOPE_IMMUTABLE"));
          after.revision = revision + 1;
          after.updatedAt = Date.now();
          try {
            this._assertSafeRecord(after);
          } catch (error) {
            return fail(error);
          }
          for (const asset of newAssets) {
            if (
              !asset?.refKey ||
              !(asset.file instanceof Blob) ||
              !after.refPool?.some((ref) => ref.refKey === asset.refKey)
            )
              return fail(new Error("BATCH_ASSET_MISSING"));
            tx.objectStore("assets").put({
              id: this._assetId(scope, batchId, asset.refKey),
              scope,
              batchId,
              refKey: asset.refKey,
              file: asset.file,
              createdAt: Date.now(),
            });
          }
          store.put(after);
          done(after);
        };
      },
    );
  }
  static async applyRegenReceipt(userId, projectId, batchId, receipt) {
    const scope = this._scope(userId, projectId);
    if (
      !receipt?.ownerJobId ||
      !receipt.ownerSessionId ||
      !receipt.rootId ||
      !["COMPLETED", "PARTIAL_FAIL"].includes(receipt.state) ||
      !Array.isArray(receipt.results) ||
      !receipt.results.length ||
      !Number.isFinite(receipt.completedAt) ||
      receipt.completedAt <= 0
    )
      throw new Error("BATCH_REGEN_RECEIPT_INVALID");
    return this._transaction(["batches"], "readwrite", (tx, done, fail) => {
      const batches = tx.objectStore("batches");
      const request = batches.get(batchId);
      request.onsuccess = () => {
        const before = request.result;
        if (!before || before.scope !== scope) return done(false);
        const ownerSegments = [
          { jobId: before.jobId, trackerSessionId: before.trackerSessionId },
          ...(before.executionSegments || []),
        ];
        if (
          !ownerSegments.some(
            (segment) =>
              segment.jobId === receipt.ownerJobId &&
              segment.trackerSessionId === receipt.ownerSessionId,
          )
        )
          return done(false);
        const index = (before.runtimeItemIds || []).indexOf(receipt.rootId);
        if (index < 0 || before.items?.[index]?.hidden) return done(false);
        const previous = before.terminalItems?.[index] || {};
        if (Number(previous.completedAt || 0) > receipt.completedAt)
          return done(false);
        const results = receipt.results
          .map((result) => ({
            video: result.video === true,
            apiProvider: result.apiProvider === true,
            fileName: result.fileName || null,
            mediaId: result.mediaId || null,
            mediaUuid: result.mediaUuid || null,
            tileId: result.tileId || null,
          }))
          .filter(
            (result) =>
              result.fileName ||
              result.mediaId ||
              result.mediaUuid ||
              result.tileId,
          );
        if (!results.length) return done(false);
        const next = {
          ...previous,
          id: receipt.rootId,
          state: receipt.state,
          ...(["api", "web"].includes(receipt.genMode)
            ? { genMode: receipt.genMode }
            : {}),
          results,
          resultIdentity: results.map((result) => ({ ...result })),
          resultIds: results.map((result) => result.tileId).filter(Boolean),
          completedAt: receipt.completedAt,
        };
        if (JSON.stringify(previous) === JSON.stringify(next))
          return done(false);
        const after = structuredClone(before);
        after.terminalItems = [...(after.terminalItems || [])];
        after.terminalItems[index] = next;
        after.revision = before.revision + 1;
        after.updatedAt = Date.now();
        try {
          this._assertSafeRecord(after);
        } catch (error) {
          return fail(error);
        }
        batches.put(after);
        done(true);
      };
    });
  }
  static rename(userId, projectId, batchId, revision, name) {
    const displayName = String(name || "").trim();
    if (!displayName) throw new Error("BATCH_NAME_EMPTY");
    return this.update(userId, projectId, batchId, revision, (record) => ({
      ...record,
      displayName,
    }));
  }
  static async recoverUnfinished(
    userId,
    projectId,
    batchId,
    revision,
    completedEvidence = [],
  ) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "leases"],
      "readwrite",
      (tx, done, fail) => {
        const batches = tx.objectStore("batches");
        const leaseRequest = tx.objectStore("leases").get(scope);
        leaseRequest.onsuccess = () => {
          if (leaseRequest.result?.expiresAt > Date.now())
            return fail(new Error("BATCH_COORDINATOR_BUSY"));
          const request = batches.get(batchId);
          request.onsuccess = () => {
            const before = request.result;
            if (
              !before ||
              before.scope !== scope ||
              before.revision !== revision
            )
              return fail(new Error("BATCH_REVISION_CONFLICT"));
            if (
              !before.jobId ||
              ![
                "admitting",
                "running",
                "paused",
                "needs_review",
                "stopped",
              ].includes(before.status)
            )
              return fail(new Error("BATCH_RECOVERY_UNAVAILABLE"));
            if (before.settingsSnapshot?.chain)
              return fail(new Error("BATCH_CHAIN_RECOVERY_UNAVAILABLE"));
            const evidence = new Map(
              completedEvidence
                .filter((entry) => entry?.id && entry.state === "COMPLETED")
                .map((entry) => [entry.id, entry]),
            );
            const completedIndexes = new Set();
            for (
              let index = 0;
              index < (before.runtimeItemIds || []).length;
              index++
            ) {
              if (
                before.terminalItems?.[index]?.state === "COMPLETED" ||
                evidence.has(before.runtimeItemIds[index])
              )
                completedIndexes.add(index);
            }
            const indexes = (before.items || [])
              .map((item, index) => index)
              .filter(
                (index) =>
                  !before.items[index].hidden && !completedIndexes.has(index),
              );
            if (!indexes.length)
              return fail(new Error("BATCH_RECOVERY_NOTHING_PENDING"));
            const recovered = structuredClone(before);
            recovered.terminalItems = [...(recovered.terminalItems || [])];
            for (const index of completedIndexes) {
              const id = before.runtimeItemIds?.[index];
              const entry = evidence.get(id);
              if (
                !entry ||
                recovered.terminalItems[index]?.state === "COMPLETED"
              )
                continue;
              const results = (entry.results || [])
                .map((result) => ({
                  tileId: result.tileId || null,
                  mediaId: result.mediaId || null,
                  mediaUuid: result.mediaUuid || null,
                  fileName: result.fileName || null,
                  video: result.video === true,
                }))
                .filter(
                  (result) =>
                    result.tileId ||
                    result.mediaId ||
                    result.mediaUuid ||
                    result.fileName,
                );
              recovered.terminalItems[index] = {
                ...recovered.terminalItems[index],
                id,
                state: "COMPLETED",
                results,
                resultIds: results
                  .map((result) => result.tileId)
                  .filter(Boolean),
              };
            }
            for (const index of indexes) recovered.terminalItems[index] = null;
            recovered.executionSegments = [
              ...(recovered.executionSegments || []),
              {
                jobId: before.jobId,
                trackerSessionId: before.trackerSessionId || null,
                runtimeItemIds: [...(before.runtimeItemIds || [])],
              },
            ];
            recovered.status = "queued";
            recovered.resumeItemIndexes = indexes;
            recovered.admissionError = null;
            recovered.completedAt = null;
            recovered.updatedAt = Date.now();
            recovered.revision++;
            try {
              this._assertSafeRecord(recovered);
            } catch (error) {
              return fail(error);
            }
            batches.put(recovered);
            done(recovered);
          };
        };
      },
    );
  }
  static async resetForRerun(
    userId,
    projectId,
    batchId,
    revision,
    queueLimit,
    route,
  ) {
    if (!Number.isInteger(queueLimit) || queueLimit < -1)
      throw new Error("BATCH_QUEUE_ENTITLEMENT_UNAVAILABLE");
    if (!["web", "api", "auto"].includes(route))
      throw new Error("BATCH_ROUTE_UNAVAILABLE");
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "leases"],
      "readwrite",
      (tx, done, fail) => {
        const leases = tx.objectStore("leases");
        const lease = leases.get(scope);
        lease.onsuccess = () => {
          if (lease.result?.expiresAt > Date.now())
            return fail(new Error("BATCH_COORDINATOR_BUSY"));
          const batches = tx.objectStore("batches");
          const request = batches.get(batchId);
          request.onsuccess = () => {
            const before = request.result;
            if (
              !before ||
              before.scope !== scope ||
              before.revision !== revision
            )
              return fail(new Error("BATCH_REVISION_CONFLICT"));
            if (
              !["completed", "failed", "stopped"].includes(before.status) ||
              !Array.isArray(before.items) ||
              !before.items.some((item) => !item.hidden)
            )
              return fail(new Error("BATCH_RERUN_UNAVAILABLE"));
            const scoped = batches.index("scope").getAll(scope);
            scoped.onsuccess = () => {
              const queued = (scoped.result || []).filter((batch) =>
                ["queued", "needs_review"].includes(batch.status),
              ).length;
              if (queueLimit !== -1 && queued >= queueLimit)
                return fail(new Error("BATCH_QUEUE_FULL"));
              const after = structuredClone(before);
              const segments = [...(after.executionSegments || [])];
              if (
                after.jobId &&
                after.trackerSessionId &&
                !segments.some(
                  (segment) =>
                    segment.jobId === after.jobId &&
                    segment.trackerSessionId === after.trackerSessionId,
                )
              ) {
                segments.push({
                  jobId: after.jobId,
                  trackerSessionId: after.trackerSessionId,
                  runtimeItemIds: [...(after.runtimeItemIds || [])],
                });
              }
              after.executionSegments = segments;
              after.status = "queued";
              after.jobId = null;
              after.generationProcessId = null;
              after.trackerSessionId = null;
              after.runtimeItemIds = [];
              after.terminalItems = [];
              const visibleIndexes = after.items
                .map((item, index) => (!item.hidden ? index : null))
                .filter((index) => index !== null);
              after.resumeItemIndexes =
                visibleIndexes.length === after.items.length
                  ? null
                  : visibleIndexes;
              after.admissionError = null;
              after.completedAt = null;
              after.flowExecutionMode = route;
              after.settingsSnapshot = {
                ...after.settingsSnapshot,
                flowExecutionMode: route,
              };
              after.updatedAt = Date.now();
              after.revision++;
              try {
                this._assertSafeRecord(after);
              } catch (error) {
                return fail(error);
              }
              batches.put(after);
              done(after);
            };
          };
        };
      },
    );
  }
  static async reconcileCompleted(
    userId,
    projectId,
    batchId,
    revision,
    completedEvidence = [],
  ) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "leases"],
      "readwrite",
      (tx, done, fail) => {
        const lease = tx.objectStore("leases").get(scope);
        lease.onsuccess = () => {
          if (lease.result?.expiresAt > Date.now())
            return fail(new Error("BATCH_COORDINATOR_BUSY"));
          const batches = tx.objectStore("batches");
          const request = batches.get(batchId);
          request.onsuccess = () => {
            const before = request.result;
            if (
              !before ||
              before.scope !== scope ||
              before.revision !== revision
            )
              return fail(new Error("BATCH_REVISION_CONFLICT"));
            if (
              !before.jobId ||
              !["needs_review", "admitting", "running", "paused"].includes(
                before.status,
              )
            )
              return fail(new Error("BATCH_RECONCILE_UNAVAILABLE"));
            const evidence = new Map(
              completedEvidence
                .filter((entry) => entry?.id && entry.state === "COMPLETED")
                .map((entry) => [entry.id, entry]),
            );
            if (
              !before.items?.every(
                (item, index) =>
                  item.hidden ||
                  before.terminalItems?.[index]?.state === "COMPLETED" ||
                  (before.runtimeItemIds?.[index] &&
                    evidence.has(before.runtimeItemIds[index])),
              )
            )
              return fail(new Error("BATCH_RECONCILE_INCOMPLETE"));
            const after = structuredClone(before);
            after.terminalItems = [...(after.terminalItems || [])];
            for (let index = 0; index < after.items.length; index++) {
              const id = after.runtimeItemIds?.[index];
              const entry = evidence.get(id);
              if (!entry || after.terminalItems[index]?.state === "COMPLETED")
                continue;
              const results = (entry.results || [])
                .map((result) => ({
                  tileId: result.tileId || null,
                  mediaId: result.mediaId || null,
                  mediaUuid: result.mediaUuid || null,
                  fileName: result.fileName || null,
                  video: result.video === true,
                }))
                .filter(
                  (result) =>
                    result.tileId ||
                    result.mediaId ||
                    result.mediaUuid ||
                    result.fileName,
                );
              after.terminalItems[index] = {
                ...after.terminalItems[index],
                id,
                state: "COMPLETED",
                results,
                resultIds: results
                  .map((result) => result.tileId)
                  .filter(Boolean),
              };
            }
            after.status = "completed";
            after.completedAt = Date.now();
            after.updatedAt = after.completedAt;
            after.revision++;
            try {
              this._assertSafeRecord(after);
            } catch (error) {
              return fail(error);
            }
            batches.put(after);
            done(after);
          };
        };
      },
    );
  }
  static async extractItem(userId, projectId, batchId, revision, index) {
    const scope = this._scope(userId, projectId);
    if (!Number.isInteger(index) || index < 0)
      throw new Error("BATCH_ITEM_INDEX_INVALID");
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const batches = tx.objectStore("batches");
        const request = batches.get(batchId);
        request.onsuccess = () => {
          const before = request.result;
          if (!before || before.scope !== scope || before.revision !== revision)
            return fail(new Error("BATCH_REVISION_CONFLICT"));
          if (before.status !== "queued" || before.resumeItemIndexes)
            return fail(new Error("BATCH_EDIT_REQUIRES_DRAFT"));
          if (before.settingsSnapshot?.chain)
            return fail(new Error("BATCH_CHAIN_ITEM_RUN_UNAVAILABLE"));
          if (
            before.items.length < 2 ||
            !before.items[index] ||
            before.items[index].hidden
          )
            return fail(new Error("BATCH_ITEM_INDEX_INVALID"));
          const now = Date.now();
          const picked = structuredClone(before);
          picked.batchId = crypto.randomUUID();
          picked.items = [picked.items[index]];
          const pickedRefs = new Set(picked.items[0].refKeys || []);
          picked.refPool = (picked.refPool || []).filter((ref) =>
            pickedRefs.has(ref.refKey),
          );
          picked.revision = 1;
          picked.createdAt = now;
          picked.updatedAt = now;
          picked.order = before.order - 0.5;
          picked.displayName = `${before.displayName} #${index + 1}`;
          if (Array.isArray(picked.frameFileIds))
            picked.frameFileIds = [picked.frameFileIds[index]];
          const remaining = structuredClone(before);
          remaining.items.splice(index, 1);
          if (Array.isArray(remaining.frameFileIds))
            remaining.frameFileIds.splice(index, 1);
          remaining.revision++;
          remaining.updatedAt = now;
          try {
            this._assertSafeRecord(picked);
            this._assertSafeRecord(remaining);
          } catch (error) {
            return fail(error);
          }
          const assets = tx.objectStore("assets");
          const assetRequest = assets.index("batchId").getAll(batchId);
          assetRequest.onsuccess = () => {
            for (const asset of assetRequest.result || []) {
              if (asset.scope !== scope || !pickedRefs.has(asset.refKey))
                continue;
              assets.add({
                ...asset,
                id: this._assetId(scope, picked.batchId, asset.refKey),
                batchId: picked.batchId,
              });
            }
            batches.put(remaining);
            batches.add(picked);
            done(picked);
          };
        };
      },
    );
  }
  static async updateDraft(
    userId,
    projectId,
    batchId,
    revision,
    transform,
    newAssets = [],
  ) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const batches = tx.objectStore("batches");
        const request = batches.get(batchId);
        request.onsuccess = () => {
          const before = request.result;
          if (!before || before.scope !== scope || before.revision !== revision)
            return fail(new Error("BATCH_REVISION_CONFLICT"));
          if (before.status !== "queued" || before.resumeItemIndexes)
            return fail(new Error("BATCH_EDIT_REQUIRES_DRAFT"));
          let after;
          try {
            after = transform(structuredClone(before));
          } catch (error) {
            return fail(error);
          }
          if (
            !after ||
            after.scope !== scope ||
            after.batchId !== batchId ||
            after.status !== "queued"
          )
            return fail(new Error("BATCH_SCOPE_IMMUTABLE"));
          after.revision = revision + 1;
          after.updatedAt = Date.now();
          try {
            this._assertSafeRecord(after);
          } catch (error) {
            return fail(error);
          }
          const used = new Set((after.refPool || []).map((ref) => ref.refKey));
          const assets = tx.objectStore("assets");
          for (const entry of newAssets) {
            if (!used.has(entry.refKey) || !(entry.file instanceof Blob))
              return fail(new Error("BATCH_ASSET_MISSING"));
            assets.add({
              id: this._assetId(scope, batchId, entry.refKey),
              scope,
              batchId,
              refKey: entry.refKey,
              file: entry.file,
              name: entry.name || entry.file.name || "",
              type: entry.file.type || "",
              size: entry.file.size,
            });
          }
          const cursor = assets.index("batchId").openKeyCursor(batchId);
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            const key = cursor.result.primaryKey;
            const refKey = String(key).slice(
              this._assetId(scope, batchId, "").length,
            );
            if (!used.has(refKey)) assets.delete(key);
            cursor.result.continue();
          };
          batches.put(after);
          done(after);
        };
      },
    );
  }
  static async getAsset(userId, projectId, batchId, refKey) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["assets"], "readonly", (tx, done) => {
      const request = tx
        .objectStore("assets")
        .get(this._assetId(scope, batchId, refKey));
      request.onsuccess = () => done(request.result || null);
    });
  }
  static async getAssetsForBatch(userId, projectId, batchId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["assets"], "readonly", (tx, done) => {
      const request = tx.objectStore("assets").index("batchId").getAll(batchId);
      request.onsuccess = () =>
        done((request.result || []).filter((entry) => entry.scope === scope));
    });
  }
  static async applyUploadedRefs(
    userId,
    projectId,
    batchId,
    revision,
    mapping,
    metadata = {},
  ) {
    const scope = this._scope(userId, projectId);
    const replacements = new Map(Object.entries(mapping || {}));
    if (!replacements.size) return this.get(userId, projectId, batchId);
    for (const [oldKey, newId] of replacements) {
      if (
        !oldKey.startsWith("upload_") ||
        !newId ||
        String(newId).startsWith("upload_")
      )
        throw new Error("BATCH_UPLOAD_MAPPING_INVALID");
    }
    const replace = (key) => replacements.get(key) || key;
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const batches = tx.objectStore("batches");
        const request = batches.get(batchId);
        request.onsuccess = () => {
          const record = request.result;
          if (
            !record ||
            record.scope !== scope ||
            record.revision !== revision ||
            record.status !== "admitting"
          )
            return fail(new Error("BATCH_UPLOAD_REVISION_CONFLICT"));
          record.refPool = (record.refPool || []).map((ref) => {
            const info = metadata[ref.refKey] || {};
            return {
              ...ref,
              refKey: replace(ref.refKey),
              fileName: info.fileName || ref.fileName || null,
              mediaUuid: info.mediaUuid || ref.mediaUuid || null,
              mediaType: info.mediaType || ref.mediaType || null,
            };
          });
          if (record.frameFileIds) {
            const frame = (pair) => ({
              frame1: replace(pair.frame1 || ""),
              frame2: replace(pair.frame2 || ""),
            });
            record.frameFileIds = Array.isArray(record.frameFileIds)
              ? record.frameFileIds.map(frame)
              : frame(record.frameFileIds);
          }
          record.items = (record.items || []).map((item) => ({
            ...item,
            refKeys: (item.refKeys || []).map(replace),
            mentionData: item.mentionData
              ? {
                  ...item.mentionData,
                  refImages: (item.mentionData.refImages || []).map((ref) => ({
                    ...ref,
                    file_id: replace(ref.file_id),
                  })),
                }
              : null,
          }));
          record.revision++;
          record.updatedAt = Date.now();
          this._assertSafeRecord(record);
          batches.put(record);
          const assets = tx.objectStore("assets");
          for (const key of replacements.keys())
            assets.delete(this._assetId(scope, batchId, key));
          done(record);
        };
      },
    );
  }
  static async removeAssetsForBatch(userId, projectId, batchId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const request = tx.objectStore("batches").get(batchId);
        request.onsuccess = () => {
          if (request.result?.scope !== scope)
            return fail(new Error("BATCH_NOT_FOUND"));
          const assets = tx.objectStore("assets");
          const cursor = assets.index("batchId").openKeyCursor(batchId);
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            assets.delete(cursor.result.primaryKey);
            cursor.result.continue();
          };
          done(true);
        };
      },
    );
  }
  static async hideBatchListEntry(
    userId,
    projectId,
    batchId,
    promptIndex = null,
  ) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["batches"], "readwrite", (tx, done, fail) => {
      const store = tx.objectStore("batches");
      const request = store.get(batchId);
      request.onsuccess = () => {
        const record = request.result;
        if (record?.scope !== scope)
          return fail(new Error("BATCH_SCOPE_CHANGED"));
        if (
          promptIndex !== null &&
          (!Number.isInteger(promptIndex) ||
            promptIndex < 0 ||
            !record.items?.[promptIndex])
        )
          return fail(new Error("BATCH_ITEM_NOT_FOUND"));
        const apply = (targets) => {
          for (const target of targets) {
            const hiddenPromptIndexes = [
              ...new Set([
                ...(target.hiddenPromptIndexes || []),
                ...(promptIndex === null ? [] : [promptIndex]),
              ]),
            ];
            store.put({
              ...target,
              hiddenPromptIndexes,
              hiddenFromBatchList:
                target.hiddenFromBatchList ||
                promptIndex === null ||
                target.items.every(
                  (item, index) =>
                    item.hidden || hiddenPromptIndexes.includes(index),
                ),
            });
          }
          done(true);
        };
        const key = this._importedHistoryJobKey(record);
        if (!key) return apply([record]);
        const aliases = store.index("scope").getAll(scope);
        aliases.onsuccess = () =>
          apply(
            aliases.result.filter(
              (entry) => this._importedHistoryJobKey(entry) === key,
            ),
          );
      };
    });
  }
  static async deleteBatch(
    userId,
    projectId,
    batchId,
    allowedStatuses = ["queued", "needs_review"],
    expectedRevision = null,
  ) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "assets"],
      "readwrite",
      (tx, done, fail) => {
        const store = tx.objectStore("batches");
        const request = store.get(batchId);
        request.onsuccess = () => {
          const record = request.result;
          if (!record || record.scope !== scope) return done(false);
          if (expectedRevision !== null && record.revision !== expectedRevision)
            return fail(new Error("BATCH_REVISION_CONFLICT"));
          if (
            !allowedStatuses.includes(record.status) ||
            this.isPossiblyLive(record)
          )
            return fail(new Error("BATCH_LIVE_DELETE_BLOCKED"));
          const aliases = store.index("scope").getAll(scope);
          aliases.onsuccess = () => {
            const key = this._importedHistoryJobKey(record);
            const targets = key
              ? (aliases.result || []).filter(
                  (entry) => this._importedHistoryJobKey(entry) === key,
                )
              : [record];
            if (
              targets.some(
                (entry) =>
                  !allowedStatuses.includes(entry.status) ||
                  this.isPossiblyLive(entry),
              )
            )
              return fail(new Error("BATCH_LIVE_DELETE_BLOCKED"));
            for (const target of targets) {
              store.delete(target.batchId);
              const cursor = tx
                .objectStore("assets")
                .index("batchId")
                .openKeyCursor(target.batchId);
              cursor.onsuccess = () => {
                if (!cursor.result) return;
                tx.objectStore("assets").delete(cursor.result.primaryKey);
                cursor.result.continue();
              };
            }
            done(true);
          };
        };
      },
    );
  }
  static async deleteForProject(userId, projectId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(
      ["batches", "assets", "leases"],
      "readwrite",
      (tx, done, fail) => {
        for (const name of ["batches", "assets"]) {
          const store = tx.objectStore(name);
          const cursor = store.index("scope").openCursor(scope);
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            if (name === "batches" && this.isPossiblyLive(cursor.result.value))
              return fail(new Error("BATCH_LIVE_DELETE_BLOCKED"));
            cursor.result.delete();
            cursor.result.continue();
          };
        }
        tx.objectStore("leases").delete(scope);
        done(true);
      },
    );
  }
  static async deleteQueuedForProject(userId, projectId) {
    const scope = this._scope(userId, projectId);
    return this._transaction(["batches", "assets"], "readwrite", (tx, done) => {
      let removed = 0;
      const batches = tx.objectStore("batches");
      const assets = tx.objectStore("assets");
      const cursor = batches.index("scope").openCursor(scope);
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) {
          done(removed);
          return;
        }
        if (entry.value.status === "queued") {
          removed++;
          const batchId = entry.value.batchId;
          entry.delete();
          const assetCursor = assets.index("batchId").openKeyCursor(batchId);
          assetCursor.onsuccess = () => {
            if (!assetCursor.result) return;
            assets.delete(assetCursor.result.primaryKey);
            assetCursor.result.continue();
          };
        }
        entry.continue();
      };
    });
  }
}
__publicField(GenBatchQueueStore, "DB_NAME", "tobyflow_gen_batches");
__publicField(GenBatchQueueStore, "DB_VERSION", 3);
__publicField(GenBatchQueueStore, "_dbPromise", null);
window.GenBatchQueueStore = GenBatchQueueStore;
