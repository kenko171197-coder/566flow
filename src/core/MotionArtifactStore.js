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
class MotionArtifactStore {
  static _scope(userId, toolProjectId) {
    if (
      !Number.isSafeInteger(Number(userId)) ||
      Number(userId) <= 0 ||
      !/^[0-9a-f-]{36}$/i.test(String(toolProjectId || ""))
    ) {
      throw new Error("MOTION_ARTIFACT_SCOPE_INVALID");
    }
    return `${userId}\0${toolProjectId}`;
  }
  static _key(scope, sourceRevision, frameId, kind, artifactRevision) {
    if (
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 1 ||
      !Number.isSafeInteger(artifactRevision) ||
      artifactRevision < 1 ||
      !this.KINDS.has(kind) ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(frameId)
    ) {
      throw new Error("MOTION_ARTIFACT_KEY_INVALID");
    }
    return `${scope}\0${sourceRevision}\0${frameId}\0${kind}\0${artifactRevision}`;
  }
  static async _db() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.DB_NAME, 2);
        request.onupgradeneeded = (event) => {
          const store =
            event.oldVersion < 1
              ? request.result.createObjectStore("artifacts", {
                  keyPath: "key",
                })
              : request.transaction.objectStore("artifacts");
          if (event.oldVersion < 1) {
            store.createIndex("project", "projectScope");
            store.createIndex("flow", "flowScope");
            store.createIndex("source", "sourceScope");
            store.createIndex("frame", "frameScope");
          }
          if (!store.indexNames.contains("bulkJournal"))
            store.createIndex("bulkJournal", "bulkJournalScope");
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this._dbPromise = null;
          };
          resolve(db);
        };
        request.onerror = () =>
          reject(request.error || new Error("MOTION_ARTIFACT_DB_OPEN_FAILED"));
        request.onblocked = () =>
          reject(new Error("MOTION_ARTIFACT_DB_BLOCKED"));
      }).catch((error) => {
        this._dbPromise = null;
        throw error;
      });
    }
    return this._dbPromise;
  }
  static async _transaction(mode, action, operation = null) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("artifacts", mode);
      const store = tx.objectStore("artifacts");
      let result,
        failure = null;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => {
        if (operation)
          console.warn(
            "[MotionArtifactTransaction]",
            JSON.stringify({
              operation,
              mode,
              reason: failure?.name || tx.error?.name || "application_abort",
            }),
          );
        reject(
          failure ||
            tx.error ||
            new Error("MOTION_ARTIFACT_TRANSACTION_ABORTED"),
        );
      };
      tx.onerror = (event) => {
        failure ||
          (failure =
            event.target?.error ||
            tx.error ||
            new Error("MOTION_ARTIFACT_TRANSACTION_FAILED"));
      };
      try {
        action(store, (value) => {
          result = value;
        });
      } catch (error) {
        failure = error;
        tx.abort();
      }
    });
  }
  static _resultIdentity(kind, media_uuid, persistent_media_id) {
    if (!media_uuid && !persistent_media_id) return {};
    if (
      kind !== "generated_clip" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(media_uuid || ""),
      ) ||
      (persistent_media_id &&
        (!/^[A-Za-z0-9_-]{32,1024}$/.test(persistent_media_id) ||
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            persistent_media_id,
          )))
    )
      throw new Error("MOTION_ARTIFACT_INVALID");
    return { media_uuid, persistent_media_id: persistent_media_id || null };
  }
  static async put({
    userId,
    toolProjectId,
    flowProjectId,
    sourceRevision,
    frameId = "project",
    kind,
    artifactRevision = 1,
    blob,
    duration = null,
    hash = null,
    resolution = null,
    playbackRate = null,
    media_uuid,
    persistent_media_id,
  }) {
    const identity = this._resultIdentity(
      kind,
      media_uuid,
      persistent_media_id,
    );
    const projectScope = this._scope(userId, toolProjectId);
    const key = this._key(
      projectScope,
      sourceRevision,
      frameId,
      kind,
      artifactRevision,
    );
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(flowProjectId || "")) ||
      !(blob instanceof Blob) ||
      blob.size === 0 ||
      (hash !== null && !/^[0-9a-f]{64}$/i.test(hash)) ||
      (playbackRate !== null &&
        (!Number.isFinite(playbackRate) || playbackRate <= 0)) ||
      (duration !== null && (!Number.isFinite(duration) || duration <= 0)) ||
      (resolution !== null &&
        (kind !== "generated_clip" ||
          !/^[A-Za-z0-9]{2,16}$/.test(String(resolution))))
    ) {
      throw new Error("MOTION_ARTIFACT_INVALID");
    }
    const sourceScope = `${projectScope}\0${sourceRevision}`;
    const frameScope = `${sourceScope}\0${frameId}`;
    const record = {
      key,
      projectScope,
      flowScope: `${userId}\0${flowProjectId}`,
      sourceScope,
      frameScope,
      userId: Number(userId),
      toolProjectId,
      flowProjectId,
      sourceRevision,
      frameId,
      kind,
      artifactRevision,
      blob,
      mime: blob.type,
      size: blob.size,
      duration,
      hash,
      resolution,
      ...(playbackRate !== null ? { playbackRate } : {}),
      ...identity,
      createdAt: Date.now(),
    };
    await this._transaction("readwrite", (store) => {
      if (!["generated_clip", "merged_video"].includes(kind)) {
        store.put(record);
        return;
      }
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result?.generatedStageOperationId) {
          store.transaction.abort();
          return;
        }
        if (
          media_uuid === void 0 &&
          persistent_media_id === void 0 &&
          request.result?.media_uuid
        )
          Object.assign(
            record,
            this._resultIdentity(
              kind,
              request.result.media_uuid,
              request.result.persistent_media_id,
            ),
          );
        store.put(record);
      };
    });
    return {
      key,
      size: record.size,
      mime: record.mime,
      duration,
      hash,
      resolution,
    };
  }
  static async get({
    userId,
    toolProjectId,
    sourceRevision,
    frameId = "project",
    kind,
    artifactRevision = 1,
  }) {
    const scope = this._scope(userId, toolProjectId);
    const key = this._key(
      scope,
      sourceRevision,
      frameId,
      kind,
      artifactRevision,
    );
    return this._transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record?.blobKey) {
          done(record || null);
          return;
        }
        const blob = store.get(record.blobKey);
        blob.onsuccess = () => {
          const source = blob.result;
          done(
            source?.projectScope === scope &&
              source.flowProjectId === record.flowProjectId &&
              source.blob
              ? {
                  ...record,
                  blob: source.blob,
                  size: source.size,
                  mime: source.mime,
                }
              : null,
          );
        };
      };
    });
  }
  static _generatedStageKeys({
    userId,
    toolProjectId,
    flowProjectId,
    sourceRevision,
    frameId,
    artifactRevision,
    operationId,
    targetKind = "generated_clip",
  }) {
    const scope = this._scope(userId, toolProjectId);
    if (
      !["generated_clip", "merged_video"].includes(targetKind) ||
      (targetKind === "merged_video" && frameId !== "project")
    )
      throw new Error("MOTION_GENERATED_STAGE_INVALID");
    const targetKey = this._key(
      scope,
      sourceRevision,
      frameId,
      targetKind,
      artifactRevision,
    );
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(operationId || "")) ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(flowProjectId || ""))
    )
      throw new Error("MOTION_GENERATED_STAGE_INVALID");
    return {
      scope,
      targetKey,
      stageKey: `${targetKey}\0stage\0${operationId}`,
    };
  }
  static async stageGenerated(input) {
    const { scope, targetKey, stageKey } = this._generatedStageKeys(input);
    const targetKind = input.targetKind || "generated_clip";
    const identity = this._resultIdentity(
      targetKind,
      input.media_uuid,
      input.persistent_media_id,
    );
    if (
      !(input.blob instanceof Blob) ||
      !input.blob.size ||
      (targetKind === "generated_clip" &&
        !/^[A-Za-z0-9]{2,16}$/.test(String(input.resolution || ""))) ||
      (targetKind === "merged_video" &&
        (!Number.isFinite(input.duration) ||
          input.duration <= 0 ||
          !Array.isArray(input.lineage) ||
          !input.lineage.length ||
          input.lineage.length > 120 ||
          input.lineage.some(
            (item) =>
              !/^[A-Za-z0-9_-]{1,80}$/.test(String(item?.frameId || "")) ||
              !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
                String(item?.runId || ""),
              ) ||
              !Number.isSafeInteger(item?.inputRevision) ||
              item.inputRevision < 1,
          ) ||
          new Set(input.lineage.map((item) => item.frameId)).size !==
            input.lineage.length))
    )
      throw new Error("MOTION_GENERATED_STAGE_INVALID");
    return this._transaction("readwrite", (store) => {
      const request = store.get(stageKey);
      request.onsuccess = () => {
        if (request.result) {
          store.transaction.abort();
          return;
        }
        store.add({
          key: stageKey,
          targetKey,
          projectScope: scope,
          flowScope: `${input.userId}\0${input.flowProjectId}`,
          sourceScope: `${scope}\0${input.sourceRevision}`,
          frameScope: `${scope}\0${input.sourceRevision}\0${input.frameId}`,
          userId: Number(input.userId),
          toolProjectId: input.toolProjectId,
          flowProjectId: input.flowProjectId,
          sourceRevision: input.sourceRevision,
          frameId: input.frameId,
          artifactRevision: input.artifactRevision,
          operationId: input.operationId,
          kind: "generated_staging",
          targetKind,
          state: "staged",
          blob: input.blob,
          mime: input.blob.type,
          size: input.blob.size,
          resolution: input.resolution || null,
          duration: input.duration || null,
          ...identity,
          ...(targetKind === "merged_video"
            ? {
                useOriginalAudio: input.useOriginalAudio === true,
                lineage: input.lineage.map(
                  ({ frameId, runId, inputRevision }) => ({
                    frameId,
                    runId,
                    inputRevision,
                  }),
                ),
              }
            : {}),
          createdAt: Date.now(),
        });
      };
    });
  }
  static async getGeneratedStage(input) {
    const { stageKey } = this._generatedStageKeys(input);
    return this._transaction("readonly", (store, done) => {
      const request = store.get(stageKey);
      request.onsuccess = () => {
        const stage = request.result;
        done(stage?.flowProjectId === input.flowProjectId ? stage : null);
      };
    });
  }
  static async promoteGenerated(input) {
    const { stageKey, targetKey } = this._generatedStageKeys(input);
    return this._transaction("readwrite", (store) => {
      const request = store.get(stageKey);
      request.onsuccess = () => {
        const stage = request.result;
        if (
          !stage ||
          stage.flowProjectId !== input.flowProjectId ||
          stage.state !== "staged"
        ) {
          store.transaction.abort();
          return;
        }
        const target = store.get(targetKey);
        target.onsuccess = () => {
          const prior = target.result || null;
          if (
            prior &&
            (prior.flowProjectId !== input.flowProjectId ||
              prior.generatedStageOperationId)
          ) {
            store.transaction.abort();
            return;
          }
          store.put({
            ...stage,
            key: targetKey,
            kind: stage.targetKind || "generated_clip",
            state: void 0,
            generatedStageOperationId: input.operationId,
          });
          store.put({ ...stage, state: "promoted", prior });
        };
      };
    });
  }
  static async rollbackGenerated(input) {
    const { stageKey, targetKey } = this._generatedStageKeys(input);
    return this._transaction("readwrite", (store) => {
      const request = store.get(stageKey);
      request.onsuccess = () => {
        const stage = request.result;
        if (
          !stage ||
          stage.flowProjectId !== input.flowProjectId ||
          stage.state !== "promoted"
        ) {
          store.transaction.abort();
          return;
        }
        const target = store.get(targetKey);
        target.onsuccess = () => {
          if (target.result?.generatedStageOperationId !== input.operationId) {
            store.transaction.abort();
            return;
          }
          if (stage.prior) store.put(stage.prior);
          else store.delete(targetKey);
          const { prior, ...rest } = stage;
          store.put({ ...rest, state: "staged" });
        };
      };
    });
  }
  static async finishGenerated(input) {
    const { stageKey, targetKey } = this._generatedStageKeys(input);
    return this._transaction("readwrite", (store) => {
      const request = store.get(stageKey);
      request.onsuccess = () => {
        const stage = request.result;
        if (
          !stage ||
          stage.flowProjectId !== input.flowProjectId ||
          stage.state !== "promoted"
        ) {
          store.transaction.abort();
          return;
        }
        const target = store.get(targetKey);
        target.onsuccess = () => {
          if (target.result?.generatedStageOperationId !== input.operationId) {
            store.transaction.abort();
            return;
          }
          const { generatedStageOperationId, ...record } = target.result;
          store.put({
            ...record,
            generatedReceiptOperationId: input.operationId,
          });
          store.delete(stageKey);
        };
      };
    });
  }
  static async discardGenerated(input) {
    const { stageKey } = this._generatedStageKeys(input);
    return this._transaction("readwrite", (store) => {
      const request = store.get(stageKey);
      request.onsuccess = () => {
        const stage = request.result;
        if (
          !stage ||
          stage.flowProjectId !== input.flowProjectId ||
          stage.state !== "staged"
        ) {
          store.transaction.abort();
          return;
        }
        store.delete(stageKey);
      };
    });
  }
  static _splitJournalKey(input) {
    const scope = this._scope(input.userId, input.toolProjectId);
    if (
      !Number.isSafeInteger(input.sourceRevision) ||
      input.sourceRevision < 1 ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(input.flowProjectId || "")) ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(input.operationId || ""),
      )
    )
      throw new Error("MOTION_SPLIT_JOURNAL_INVALID");
    return { scope, key: `${scope}\0${input.sourceRevision}\0split_journal` };
  }
  static async beginSplitJournal(input) {
    const { scope, key } = this._splitJournalKey(input);
    const snapshot = input.preparationSnapshot;
    if (
      snapshot !== void 0 &&
      (snapshot?.version !== 1 ||
        snapshot.userId !== Number(input.userId) ||
        !/^[0-9a-f]{64}$/.test(snapshot.settingsFingerprint) ||
        !/^[0-9a-f]{64}$/.test(snapshot.configFingerprint) ||
        !["sequential", "parallel"].includes(snapshot.executionMode) ||
        !Number.isInteger(snapshot.flowTarget?.tabId) ||
        snapshot.flowTarget.tabId < 0 ||
        snapshot.flowTarget.projectId !== input.flowProjectId ||
        !snapshot.flowTarget.driverKey ||
        !/^https?:\/\//.test(snapshot.flowTarget.origin) ||
        !["web", "api"].includes(snapshot.flowTarget.mode) ||
        !(
          snapshot.accountTabId === null ||
          Number.isInteger(snapshot.accountTabId)
        ) ||
        (snapshot.layout !== void 0 &&
          (!Number.isInteger(snapshot.layout?.sourceWindowId) ||
            snapshot.layout.sourceWindowId < 0 ||
            !snapshot.layout.screen ||
            ["screenLeft", "screenTop", "screenWidth", "screenHeight"].some(
              (key2) =>
                snapshot.layout.screen[key2] !== null &&
                !Number.isSafeInteger(snapshot.layout.screen[key2]),
            ))) ||
        typeof snapshot.retryEnabled !== "boolean" ||
        !Number.isSafeInteger(snapshot.workflow?.max_retries) ||
        snapshot.workflow.max_retries < 0 ||
        !Number.isFinite(snapshot.workflow.delay_nodes_sec) ||
        snapshot.workflow.delay_nodes_sec < 0)
    )
      throw new Error("MOTION_SPLIT_SNAPSHOT_INVALID");
    if (
      typeof input.draftKey !== "string" ||
      !input.draftKey ||
      input.draftKey.length > 1024 ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(input.draftId || ""),
      ) ||
      !Number.isSafeInteger(input.profileRevision) ||
      input.profileRevision < 1 ||
      (input.profileKey !== void 0 &&
        !/^[a-z0-9_]{1,64}$/.test(input.profileKey)) ||
      (input.profilePromptVariant !== void 0 &&
        !["legacy", "timeline"].includes(input.profilePromptVariant)) ||
      !Number.isFinite(input.maxSeconds) ||
      input.maxSeconds < 1 ||
      typeof input.includeAudio !== "boolean" ||
      (input.cutStrategy !== void 0 &&
        !["duration", "silence"].includes(input.cutStrategy))
    )
      throw new Error("MOTION_SPLIT_JOURNAL_INVALID");
    return this._transaction(
      "readwrite",
      (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const prior = request.result;
          if (prior) {
            if (
              prior.operationId !== input.operationId ||
              prior.flowProjectId !== input.flowProjectId ||
              prior.draftId !== input.draftId ||
              prior.draftKey !== input.draftKey ||
              prior.profileRevision !== input.profileRevision ||
              (prior.profilePromptVariant || "legacy") !==
                (input.profilePromptVariant || "legacy") ||
              prior.maxSeconds !== input.maxSeconds ||
              prior.includeAudio !== input.includeAudio ||
              (prior.cutStrategy || "silence") !==
                (input.cutStrategy || "silence") ||
              (prior.preparationSnapshot &&
                JSON.stringify(prior.preparationSnapshot) !==
                  JSON.stringify(snapshot)) ||
              (prior.profileKey !== void 0 &&
                prior.profileKey !== input.profileKey)
            ) {
              store.transaction.abort();
              return;
            }
            if (!prior.preparationSnapshot && snapshot)
              store.put({ ...prior, preparationSnapshot: snapshot });
            return;
          }
          const sourceScope = `${scope}\0${input.sourceRevision}`;
          store.add({
            key,
            projectScope: scope,
            flowScope: `${input.userId}\0${input.flowProjectId}`,
            sourceScope,
            frameScope: `${sourceScope}\0project`,
            userId: Number(input.userId),
            toolProjectId: input.toolProjectId,
            flowProjectId: input.flowProjectId,
            sourceRevision: input.sourceRevision,
            kind: "split_journal",
            operationId: input.operationId,
            draftId: input.draftId,
            draftKey: input.draftKey,
            profileRevision: input.profileRevision,
            maxSeconds: input.maxSeconds,
            ...(input.profileKey && { profileKey: input.profileKey }),
            ...(input.profilePromptVariant && {
              profilePromptVariant: input.profilePromptVariant,
            }),
            ...(snapshot && { preparationSnapshot: snapshot }),
            includeAudio: input.includeAudio,
            cutStrategy: input.cutStrategy || "silence",
            state: "started",
            plan: null,
            completed: [],
            size: 0,
            createdAt: Date.now(),
          });
        };
      },
      "beginSplitJournal",
    );
  }
  static async getSplitJournal(input) {
    const { key } = this._splitJournalKey(input);
    return this._transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        done(
          record?.operationId === input.operationId &&
            record.flowProjectId === input.flowProjectId
            ? record
            : null,
        );
      };
    });
  }
  static async saveSplitPlan(input) {
    const { key } = this._splitJournalKey(input);
    const plan = input.plan;
    if (
      plan?.cutStrategy &&
      (!["duration", "silence"].includes(plan.cutStrategy) ||
        !Number.isSafeInteger(plan.quietCuts) ||
        plan.quietCuts < 0 ||
        !Number.isSafeInteger(plan.timeCuts) ||
        plan.timeCuts < 0 ||
        plan.quietCuts + plan.timeCuts !== plan.count - 1 ||
        (plan.cutStrategy === "duration" && plan.quietCuts !== 0))
    )
      throw new Error("MOTION_SPLIT_PLAN_INVALID");
    if (
      !plan ||
      !Number.isSafeInteger(plan.count) ||
      plan.count < 1 ||
      plan.count > 120 ||
      !Number.isFinite(plan.duration) ||
      plan.duration <= 0 ||
      !Array.isArray(plan.boundaries) ||
      plan.boundaries.length !== plan.count + 1 ||
      plan.boundaries[0] !== 0 ||
      Math.abs(plan.boundaries.at(-1) - plan.duration) > 0.0015 ||
      plan.boundaries.some(
        (value, i) =>
          !Number.isFinite(value) || (i > 0 && value <= plan.boundaries[i - 1]),
      ) ||
      ![
        "audio_present",
        "audio_track_absent",
        "silent_verified",
        "audio_not_requested",
        "audio_decode_unsupported",
      ].includes(plan.audioState)
    )
      throw new Error("MOTION_SPLIT_PLAN_INVALID");
    const normalized = {
      duration: plan.duration,
      count: plan.count,
      boundaries: [...plan.boundaries],
      audioState: plan.audioState,
      ...(plan.cutStrategy && {
        cutStrategy: plan.cutStrategy,
        quietCuts: plan.quietCuts,
        timeCuts: plan.timeCuts,
      }),
    };
    return this._transaction(
      "readwrite",
      (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result;
          const previousPlan = record?.plan;
          const comparablePlan =
            previousPlan && !previousPlan.cutStrategy
              ? {
                  duration: normalized.duration,
                  count: normalized.count,
                  boundaries: normalized.boundaries,
                  audioState: normalized.audioState,
                }
              : normalized;
          if (
            !record ||
            record.operationId !== input.operationId ||
            record.flowProjectId !== input.flowProjectId ||
            normalized.boundaries.some(
              (value, index) =>
                index > 0 &&
                value - normalized.boundaries[index - 1] >
                  record.maxSeconds + 0.0015,
            ) ||
            (plan.cutStrategy || "silence") !==
              (record.cutStrategy || "silence") ||
            (previousPlan &&
              JSON.stringify(previousPlan) !==
                JSON.stringify(comparablePlan)) ||
            (record.includeAudio
              ? normalized.audioState === "audio_not_requested"
              : normalized.audioState !== "audio_not_requested") ||
            normalized.boundaries.some(
              (value, i) =>
                i > 0 &&
                value - normalized.boundaries[i - 1] >
                  record.maxSeconds + 0.0015,
            )
          ) {
            store.transaction.abort();
            return;
          }
          store.put({
            ...record,
            state: record.state === "committed" ? "committed" : "planned",
            plan: normalized,
          });
        };
      },
      "saveSplitPlan",
    );
  }
  static async markSplitFrame(input) {
    const { key } = this._splitJournalKey(input);
    if (!Number.isSafeInteger(input.index) || input.index < 0)
      throw new Error("MOTION_SPLIT_FRAME_INVALID");
    return this._transaction(
      "readwrite",
      (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (
            !record ||
            record.operationId !== input.operationId ||
            record.flowProjectId !== input.flowProjectId ||
            !record.plan ||
            input.index >= record.plan.count ||
            input.index > record.completed.length
          ) {
            store.transaction.abort();
            return;
          }
          if (input.index < record.completed.length) return;
          store.put({
            ...record,
            completed: [...record.completed, input.index],
          });
        };
      },
      "markSplitFrame",
    );
  }
  static async markSplitCommitted(input) {
    const { key } = this._splitJournalKey(input);
    return this._transaction(
      "readwrite",
      (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (
            !record ||
            record.operationId !== input.operationId ||
            record.flowProjectId !== input.flowProjectId ||
            !record.plan ||
            record.completed.length !== record.plan.count
          ) {
            store.transaction.abort();
            return;
          }
          store.put({ ...record, state: "committed" });
        };
      },
      "markSplitCommitted",
    );
  }
  static async clearCommittedSplitJournal(input) {
    const { key } = this._splitJournalKey(input);
    return this._transaction("readwrite", (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (
          !record ||
          record.operationId !== input.operationId ||
          record.flowProjectId !== input.flowProjectId ||
          record.state !== "committed"
        ) {
          store.transaction.abort();
          return;
        }
        store.delete(key);
      };
    });
  }
  static async clearInterruptedSplitJournal(input) {
    const { key } = this._splitJournalKey(input);
    return this._transaction(
      "readwrite",
      (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const record = request.result;
          if (
            !record ||
            record.operationId !== input.operationId ||
            record.flowProjectId !== input.flowProjectId ||
            record.draftId !== input.draftId ||
            record.state === "committed"
          ) {
            store.transaction.abort();
            return;
          }
          store.delete(key);
        };
      },
      "clearInterruptedSplitJournal",
    );
  }
  static async clearSplitJournalsAfterReset({
    userId,
    toolProjectId,
    maxRevision,
    serverResetVerified,
  }) {
    if (
      serverResetVerified !== true ||
      !Number.isSafeInteger(maxRevision) ||
      maxRevision < 1
    )
      throw new Error("MOTION_SPLIT_CLEANUP_UNVERIFIED");
    const scope = this._scope(userId, toolProjectId);
    return this._transaction("readwrite", (store, done) => {
      const cleared = [];
      const request = store
        .index("project")
        .openCursor(IDBKeyRange.only(scope));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done(cleared);
          return;
        }
        if (
          cursor.value.kind === "split_journal" &&
          cursor.value.sourceRevision <= maxRevision
        ) {
          cleared.push(cursor.value.sourceRevision);
          cursor.delete();
        }
        cursor.continue();
      };
    });
  }
  static async linkBulkDraftToSource({
    userId,
    toolProjectId,
    flowProjectId,
    sourceRevision,
    draftKey,
  }) {
    const scope = this._scope(userId, toolProjectId);
    const key = this._key(scope, sourceRevision, "project", "source_video", 1);
    return this._transaction(
      "readwrite",
      (store, done) => {
        const request = store.get(draftKey);
        request.onsuccess = () => {
          const draft = request.result;
          if (
            !draft ||
            draft.projectScope !== scope ||
            draft.kind !== "source_draft" ||
            draft.flowProjectId !== flowProjectId ||
            !draft.blob ||
            draft.baseSourceRevision !== sourceRevision - 1
          ) {
            store.transaction.abort();
            return;
          }
          const existing = store.get(key);
          existing.onsuccess = () => {
            if (existing.result && existing.result.blobKey !== draftKey) {
              store.transaction.abort();
              return;
            }
            const sourceScope = `${scope}\0${sourceRevision}`;
            store.put({
              key,
              projectScope: scope,
              flowScope: `${userId}\0${flowProjectId}`,
              sourceScope,
              frameScope: `${sourceScope}\0project`,
              userId: Number(userId),
              toolProjectId,
              flowProjectId,
              sourceRevision,
              frameId: "project",
              kind: "source_video",
              artifactRevision: 1,
              blobKey: draftKey,
              size: 0,
              mime: draft.mime,
              createdAt: Date.now(),
            });
            done({ key });
          };
        };
      },
      "linkBulkDraftToSource",
    );
  }
  static async commitBulkSource({
    userId,
    toolProjectId,
    flowProjectId,
    sourceRevision,
    draftKey,
  }) {
    const scope = this._scope(userId, toolProjectId);
    const key = this._key(scope, sourceRevision, "project", "source_video", 1);
    await this._transaction(
      "readwrite",
      (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const alias = request.result;
          if (
            !alias ||
            alias.blobKey !== draftKey ||
            alias.flowProjectId !== flowProjectId
          ) {
            store.transaction.abort();
            return;
          }
          const source = store.get(draftKey);
          source.onsuccess = () => {
            const record = source.result;
            if (
              !record ||
              record.projectScope !== scope ||
              record.flowProjectId !== flowProjectId ||
              !record.blob ||
              !["source_draft", "source_video"].includes(record.kind)
            ) {
              store.transaction.abort();
              return;
            }
            if (
              record.kind === "source_video" &&
              record.sourceRevision !== sourceRevision
            ) {
              store.transaction.abort();
              return;
            }
            const sourceScope = `${scope}\0${sourceRevision}`;
            store.put({
              ...record,
              kind: "source_video",
              sourceRevision,
              sourceScope,
              frameScope: `${sourceScope}\0project`,
            });
          };
        };
      },
      "commitBulkSource",
    );
  }
  static async saveSourceDraft({
    userId,
    toolProjectId,
    flowProjectId,
    blob,
    fileName,
    baseSourceRevision,
    playbackRate = null,
  }) {
    const projectScope = this._scope(userId, toolProjectId);
    if (
      !(blob instanceof Blob) ||
      !blob.size ||
      typeof fileName !== "string" ||
      !Number.isSafeInteger(baseSourceRevision) ||
      baseSourceRevision < 0 ||
      (playbackRate !== null &&
        (!Number.isFinite(playbackRate) || playbackRate <= 0))
    )
      throw new Error("MOTION_ARTIFACT_INVALID");
    const key = `${projectScope}\0source_draft`;
    await this._transaction(
      "readwrite",
      (store) => {
        const draftKeys = [];
        const linkedKeys = new Set();
        const occupiedKeys = new Set();
        const request = store
          .index("project")
          .openCursor(IDBKeyRange.only(projectScope));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            occupiedKeys.add(cursor.primaryKey);
            if (cursor.value.kind === "source_draft")
              draftKeys.push(cursor.primaryKey);
            if (cursor.value.blobKey) linkedKeys.add(cursor.value.blobKey);
            if (cursor.value.kind === "split_journal" && cursor.value.draftKey)
              linkedKeys.add(cursor.value.draftKey);
            cursor.continue();
            return;
          }
          if (draftKeys.some((draftKey) => linkedKeys.has(draftKey))) {
            store.transaction.abort();
            return;
          }
          const targetKey =
            linkedKeys.has(key) ||
            (occupiedKeys.has(key) && !draftKeys.includes(key))
              ? `${key}\0${baseSourceRevision}`
              : key;
          if (
            linkedKeys.has(targetKey) ||
            (occupiedKeys.has(targetKey) && !draftKeys.includes(targetKey))
          ) {
            store.transaction.abort();
            return;
          }
          for (const draftKey of draftKeys) store.delete(draftKey);
          store.put({
            key: targetKey,
            projectScope,
            flowScope: `${userId}\0${flowProjectId}`,
            userId: Number(userId),
            toolProjectId,
            flowProjectId,
            sourceRevision: 0,
            frameId: "project",
            kind: "source_draft",
            artifactRevision: 1,
            blob,
            fileName,
            baseSourceRevision,
            ...(playbackRate !== null ? { playbackRate } : {}),
            size: blob.size,
            mime: blob.type,
            createdAt: Date.now(),
          });
        };
      },
      "saveSourceDraft",
    );
  }
  static _bulkKey(userId, bulkCreateId, itemId) {
    if (
      !Number.isSafeInteger(Number(userId)) ||
      Number(userId) < 1 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(bulkCreateId || ""),
      ) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        String(itemId || ""),
      )
    ) {
      throw new Error("MOTION_BULK_SCOPE_INVALID");
    }
    return `bulk\0${Number(userId)}\0${bulkCreateId}\0${itemId}`;
  }
  static async createBulkJournalItem({
    userId,
    bulkCreateId,
    itemId,
    flowProjectId,
    fileName,
    settings,
    duration = null,
  }) {
    const key = `journal\0${this._bulkKey(userId, bulkCreateId, itemId)}`;
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(flowProjectId || "")) ||
      typeof fileName !== "string" ||
      !fileName ||
      fileName.length > 255 ||
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      (duration !== null && (!Number.isFinite(duration) || duration <= 0))
    )
      throw new Error("MOTION_BULK_JOURNAL_INVALID");
    let serialized;
    try {
      serialized = JSON.stringify(settings, (_key, value) => {
        if (
          value instanceof Blob ||
          value instanceof ArrayBuffer ||
          ArrayBuffer.isView(value)
        ) {
          throw new Error("MOTION_BULK_JOURNAL_INVALID");
        }
        return value;
      });
    } catch (_) {
      throw new Error("MOTION_BULK_JOURNAL_INVALID");
    }
    if (!serialized || serialized.length > 1e5)
      throw new Error("MOTION_BULK_JOURNAL_INVALID");
    const snapshot = JSON.parse(serialized);
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result) {
          store.transaction.abort();
          return;
        }
        const record = {
          key,
          kind: "bulk_journal",
          userId: Number(userId),
          bulkCreateId,
          itemId,
          bulkJournalScope: `${Number(userId)}\0${bulkCreateId}`,
          flowProjectId,
          fileName,
          duration,
          settings: snapshot,
          stage: "selected",
          projectId: null,
          version: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        store.add(record);
        done(record);
      };
    });
  }
  static async getBulkJournalItem({ userId, bulkCreateId, itemId }) {
    const key = `journal\0${this._bulkKey(userId, bulkCreateId, itemId)}`;
    return this._transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result || null);
    });
  }
  static _bulkJournalHead(item) {
    return {
      userId: item.userId,
      bulkCreateId: item.bulkCreateId,
      itemId: item.itemId,
      flowProjectId: item.flowProjectId,
      projectId: item.projectId,
      stage: item.stage,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  }
  static async listBulkJournalItems({
    userId,
    bulkCreateId,
    metadataOnly = false,
  }) {
    this._bulkKey(userId, bulkCreateId, bulkCreateId);
    const scope = `${Number(userId)}\0${bulkCreateId}`;
    return this._transaction("readonly", (store, done) => {
      if (metadataOnly) {
        const rows = [],
          request2 = store
            .index("bulkJournal")
            .openCursor(IDBKeyRange.only(scope));
        request2.onsuccess = () => {
          const cursor = request2.result;
          if (!cursor) {
            done(rows);
            return;
          }
          rows.push(this._bulkJournalHead(cursor.value));
          cursor.continue();
        };
        return;
      }
      const request = store
        .index("bulkJournal")
        .getAll(IDBKeyRange.only(scope));
      request.onsuccess = () => done(request.result || []);
    });
  }
  static async listPendingBulkJournalItems(
    userId,
    { includeCompleted = false, metadataOnly = false } = {},
  ) {
    if (!Number.isSafeInteger(Number(userId)) || Number(userId) < 1)
      throw new Error("MOTION_BULK_SCOPE_INVALID");
    const prefix = `${Number(userId)}\0`;
    return this._transaction("readonly", (store, done) => {
      const records = [];
      const request = store
        .index("bulkJournal")
        .openCursor(IDBKeyRange.bound(prefix, `${prefix}\uFFFF`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done(records);
          return;
        }
        if (includeCompleted || cursor.value.stage !== "complete")
          records.push(
            metadataOnly ? this._bulkJournalHead(cursor.value) : cursor.value,
          );
        cursor.continue();
      };
    });
  }
  static async deleteCompletedBulkJournalItem({
    userId,
    bulkCreateId,
    itemId,
  }) {
    const key = `journal\0${this._bulkKey(userId, bulkCreateId, itemId)}`;
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (!request.result) {
          done(false);
          return;
        }
        if (request.result.stage !== "complete") {
          store.transaction.abort();
          return;
        }
        store.delete(key);
        done(true);
      };
    });
  }
  static async discardBulkJournalItem({ userId, bulkCreateId, itemId }) {
    const blobKey = this._bulkKey(userId, bulkCreateId, itemId),
      key = `journal\0${blobKey}`;
    return this._transaction("readwrite", (store, done) => {
      const journal = store.get(key),
        source = store.get(blobKey);
      let ready = 0;
      const apply = () => {
        if (++ready !== 2) return;
        if (
          journal.result?.projectId &&
          source.result &&
          !source.result.toolProjectId
        ) {
          store.transaction.abort();
          return;
        }
        if (
          source.result?.kind === "bulk_source_staging" &&
          !source.result.toolProjectId
        )
          store.delete(blobKey);
        store.delete(key);
        done(true);
      };
      journal.onsuccess = apply;
      source.onsuccess = apply;
    });
  }
  static async deleteUnstartedBulkJournalItem({
    userId,
    bulkCreateId,
    itemId,
  }) {
    const blobKey = this._bulkKey(userId, bulkCreateId, itemId);
    const key = `journal\0${blobKey}`;
    return this._transaction("readwrite", (store, done) => {
      const journal = store.get(key);
      journal.onsuccess = () => {
        if (!journal.result) {
          done(false);
          return;
        }
        if (journal.result.stage !== "selected" || journal.result.projectId) {
          store.transaction.abort();
          return;
        }
        const blob = store.get(blobKey);
        blob.onsuccess = () => {
          if (blob.result) {
            store.transaction.abort();
            return;
          }
          store.delete(key);
          done(true);
        };
      };
    });
  }
  static async advanceBulkJournalItem({
    userId,
    bulkCreateId,
    itemId,
    version,
    stage,
    projectId = null,
    projectRevision = null,
  }) {
    const key = `journal\0${this._bulkKey(userId, bulkCreateId, itemId)}`;
    const stages = [
      "selected",
      "staged",
      "created",
      "bound",
      "source_saved",
      "complete",
    ];
    if (
      !Number.isSafeInteger(version) ||
      version < 1 ||
      !stages.includes(stage) ||
      (projectId !== null &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          projectId,
        )) ||
      (projectRevision !== null &&
        (!Number.isSafeInteger(projectRevision) || projectRevision < 1))
    ) {
      throw new Error("MOTION_BULK_JOURNAL_INVALID");
    }
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const current = request.result;
        if (
          !current ||
          current.version !== version ||
          stages.indexOf(stage) !== stages.indexOf(current.stage) + 1 ||
          (stage === "staged" && projectId !== null) ||
          (current.projectId && projectId && current.projectId !== projectId) ||
          (stages.indexOf(stage) >= stages.indexOf("created") &&
            !(projectId || current.projectId))
        ) {
          store.transaction.abort();
          return;
        }
        const next = {
          ...current,
          stage,
          projectId: projectId || current.projectId,
          projectRevision: projectRevision ?? current.projectRevision ?? null,
          version: version + 1,
          updatedAt: Date.now(),
        };
        store.put(next);
        done(next);
      };
    });
  }
  static async stageBulkSource({
    userId,
    bulkCreateId,
    itemId,
    blob,
    fileName,
    flowProjectId,
  }) {
    const key = this._bulkKey(userId, bulkCreateId, itemId);
    if (
      !(blob instanceof Blob) ||
      !blob.size ||
      typeof fileName !== "string" ||
      !fileName ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(flowProjectId || ""))
    )
      throw new Error("MOTION_ARTIFACT_INVALID");
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const existing = request.result;
        if (existing) {
          store.transaction.abort();
          return;
        }
        store.add({
          key,
          userId: Number(userId),
          bulkCreateId,
          itemId,
          flowProjectId,
          kind: "bulk_source_staging",
          blob,
          fileName,
          mime: blob.type,
          size: blob.size,
          createdAt: Date.now(),
        });
        done({ key, reused: false });
      };
    });
  }
  static async getBulkSource({ userId, bulkCreateId, itemId }) {
    const key = this._bulkKey(userId, bulkCreateId, itemId);
    return this._transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result || null);
    });
  }
  static async deleteUnboundBulkSource({ userId, bulkCreateId, itemId }) {
    const key = this._bulkKey(userId, bulkCreateId, itemId);
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record) {
          done(false);
          return;
        }
        if (record.kind !== "bulk_source_staging" || record.toolProjectId) {
          store.transaction.abort();
          return;
        }
        store.delete(key);
        done(true);
      };
    });
  }
  static async bindBulkSource({
    userId,
    bulkCreateId,
    itemId,
    toolProjectId,
    flowProjectId,
  }) {
    const key = this._bulkKey(userId, bulkCreateId, itemId);
    const projectScope = this._scope(userId, toolProjectId);
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (
          !record ||
          record.flowProjectId !== flowProjectId ||
          record.userId !== Number(userId) ||
          (record.toolProjectId && record.toolProjectId !== toolProjectId)
        ) {
          store.transaction.abort();
          return;
        }
        const cursor = store
          .index("project")
          .openCursor(IDBKeyRange.only(projectScope));
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (
            entry &&
            entry.value.kind === "source_draft" &&
            entry.primaryKey !== key
          ) {
            store.transaction.abort();
            return;
          }
          if (entry) {
            entry.continue();
            return;
          }
          store.put({
            ...record,
            projectScope,
            flowScope: `${userId}\0${flowProjectId}`,
            toolProjectId,
            kind: "source_draft",
            sourceRevision: 0,
            frameId: "project",
            artifactRevision: 1,
            baseSourceRevision: 0,
          });
          done({ key });
        };
      };
    });
  }
  static async getSourceDraft(userId, toolProjectId) {
    const scope = this._scope(userId, toolProjectId);
    const key = `${scope}\0source_draft`;
    return this._transaction("readonly", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result?.kind === "source_draft") {
          done(request.result);
          return;
        }
        const cursor = store
          .index("project")
          .openCursor(IDBKeyRange.only(scope));
        cursor.onsuccess = () => {
          if (!cursor.result) {
            done(null);
            return;
          }
          if (cursor.result.value.kind === "source_draft") {
            done(cursor.result.value);
            return;
          }
          cursor.result.continue();
        };
      };
    });
  }
  static async deleteSourceDraft(userId, toolProjectId) {
    const scope = this._scope(userId, toolProjectId);
    await this._transaction(
      "readwrite",
      (store) => {
        const drafts = [];
        const linked = new Set();
        const request = store
          .index("project")
          .openCursor(IDBKeyRange.only(scope));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            if (cursor.value.kind === "source_draft")
              drafts.push(cursor.primaryKey);
            if (cursor.value.blobKey) linked.add(cursor.value.blobKey);
            if (cursor.value.kind === "split_journal" && cursor.value.draftKey)
              linked.add(cursor.value.draftKey);
            cursor.continue();
            return;
          }
          if (drafts.some((key) => linked.has(key))) {
            store.transaction.abort();
            return;
          }
          for (const key of drafts) store.delete(key);
        };
      },
      "deleteSourceDraft",
    );
  }
  static async syncFlowSources({ userId, project, thumbnails = {} }) {
    const toolProjectId = project?.tool_project_id,
      flowProjectId = project?.flow_project_id;
    const sourceRevision = Number(project?.data_json?.source_revision);
    const uuid = (value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    if (
      !toolProjectId ||
      !flowProjectId ||
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 1
    )
      return;
    const projectScope = this._scope(userId, toolProjectId);
    for (const [frameId, frame] of Object.entries(
      project.data_json.frames || {},
    )) {
      const edit = frame.source_edit;
      if (!uuid(edit?.media_id) || !uuid(edit?.mutation_id)) continue;
      const key = this._key(
        projectScope,
        sourceRevision,
        frameId,
        "source_clip",
        1,
      );
      await this._transaction("readwrite", (store) => {
        const request = store.get(key);
        request.onsuccess = () => {
          const old = request.result;
          if (old && old.flowProjectId !== flowProjectId) {
            store.transaction.abort();
            return;
          }
          const thumbnail = /^https:\/\//.test(thumbnails[frameId] || "")
            ? thumbnails[frameId]
            : null;
          if (old?.sourceEditMutationId === edit.mutation_id) {
            if (
              (thumbnail && old.thumbnailUrl !== thumbnail) ||
              (edit.display_name &&
                edit.display_name !== old.uploadReceipt?.display_name) ||
              (edit.upload_name &&
                edit.upload_name !== old.uploadReceipt?.upload_name)
            )
              store.put({
                ...old,
                ...(thumbnail && { thumbnailUrl: thumbnail }),
                updatedAt: Date.now(),
                uploadReceipt: {
                  ...old.uploadReceipt,
                  ...(edit.display_name && { display_name: edit.display_name }),
                  ...(edit.upload_name && { upload_name: edit.upload_name }),
                },
              });
            return;
          }
          const sourceScope = `${projectScope}\0${sourceRevision}`;
          const asb = edit.persistent_media_id || null;
          store.put({
            key,
            projectScope,
            sourceScope,
            flowScope: `${userId}\0${flowProjectId}`,
            frameScope: `${sourceScope}\0${frameId}`,
            userId: Number(userId),
            toolProjectId,
            flowProjectId,
            sourceRevision,
            frameId,
            kind: "source_clip",
            artifactRevision: 1,
            blob: null,
            mime: "video/mp4",
            size: 0,
            duration: old?.duration || Number(frame.end) - Number(frame.start),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sourceEditMutationId: edit.mutation_id,
            thumbnailUrl: /^https:\/\//.test(thumbnails[frameId] || "")
              ? thumbnails[frameId]
              : null,
            uploadReceipt: {
              mediaId: edit.media_id,
              mediaUuid: edit.media_id,
              projectId: flowProjectId,
              mode: "web",
              fileName: asb || edit.media_id,
              persistentMediaId: asb,
              ...(edit.display_name && { display_name: edit.display_name }),
              ...(edit.upload_name && { upload_name: edit.upload_name }),
              recordedAt: Date.now(),
            },
          });
          store.delete(
            this._key(projectScope, sourceRevision, frameId, "poster", 1),
          );
          const cursor = store.index("source").openCursor(sourceScope);
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            const item = row.value;
            if (
              (item.kind === "generated_clip" &&
                item.frameId === frameId &&
                item.artifactRevision <= Number(edit.input_revision)) ||
              (item.kind === "merged_video" && !project.data_json.final) ||
              (item.kind === "generated_staging" &&
                ((item.targetKind === "generated_clip" &&
                  item.frameId === frameId &&
                  item.artifactRevision <= Number(edit.input_revision)) ||
                  (item.targetKind === "merged_video" &&
                    !project.data_json.final)))
            )
              row.delete();
            row.continue();
          };
        };
      });
    }
  }
  static async setContinuityReference({
    userId,
    toolProjectId,
    sourceRevision,
    frameId,
    artifactRevision,
    expectedOperationId,
    value,
  }) {
    const key = this._key(
      this._scope(userId, toolProjectId),
      sourceRevision,
      frameId,
      "generated_clip",
      artifactRevision,
    );
    if (
      !value ||
      typeof value.dependency !== "string" ||
      value.dependency.length > 2048 ||
      !["pending", "not_dispatched", "ready"].includes(value.state) ||
      (value.state === "ready" &&
        (!value.reference?.media_uuid || value.reference.type !== "image"))
    )
      throw new Error("MOTION_CONTINUITY_SCOPE_CHANGED");
    await this._transaction("readwrite", (store) => {
      const read = store.get(key);
      read.onsuccess = () => {
        const record = read.result;
        if (
          !record?.blob ||
          (record.generatedReceiptOperationId || null) !==
            expectedOperationId ||
          (value.reference &&
            value.reference.project_id !== record.flowProjectId)
        ) {
          store.transaction.abort();
          return;
        }
        store.put({ ...record, continuityReference: value });
      };
    });
  }
  static uploadMetadata(receipt) {
    const metadata = {};
    for (const [key, value] of Object.entries({
      media_uuid: receipt?.mediaUuid,
      persistent_media_id: receipt?.persistentMediaId,
      upload_name: receipt?.upload_name,
      display_name: receipt?.display_name,
    })) {
      if (typeof value === "string" && value.trim())
        metadata[key] = key.endsWith("_name")
          ? Array.from(value).slice(0, 255).join("")
          : value.slice(0, 1024);
    }
    return metadata;
  }
  static async hydrateUploadReceipt({ userId, project, frameId }) {
    const frame = project?.data_json?.frames?.[frameId],
      stage = frame?.stages?.upload;
    const uuid = (value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    const mediaUuid =
      stage?.media_uuid ||
      (uuid(stage?.provider_media_id) ? stage.provider_media_id : null);
    if (
      stage?.state !== "ready" ||
      !stage.provider_media_id ||
      !uuid(mediaUuid) ||
      !["web", "api"].includes(stage.flow_mode)
    )
      return;
    if (
      (uuid(stage.provider_media_id) &&
        stage.provider_media_id.toLowerCase() !== mediaUuid.toLowerCase()) ||
      (uuid(stage.persistent_media_id) &&
        stage.persistent_media_id.toLowerCase() !== mediaUuid.toLowerCase())
    )
      throw new Error("MOTION_UPLOAD_RECEIPT_INVALID");
    const sourceRevision = Number(project.data_json.source_revision),
      toolProjectId = project.tool_project_id;
    if (
      !Number.isSafeInteger(sourceRevision) ||
      sourceRevision < 1 ||
      !toolProjectId ||
      !project.flow_project_id
    )
      return;
    const projectScope = this._scope(userId, toolProjectId),
      sourceScope = `${projectScope}\0${sourceRevision}`;
    const key = this._key(
      projectScope,
      sourceRevision,
      frameId,
      "source_clip",
      1,
    );
    await this._transaction("readwrite", (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const old = request.result;
        if (old && old.flowProjectId !== project.flow_project_id) {
          store.transaction.abort();
          return;
        }
        const prior = old?.uploadReceipt;
        if (
          prior &&
          (prior.projectId !== project.flow_project_id ||
            (prior.mediaUuid &&
              prior.mediaUuid.toLowerCase() !== mediaUuid.toLowerCase()) ||
            ![
              prior.mediaId,
              prior.mediaUuid,
              prior.persistentMediaId,
              prior.fileName,
            ].some((value) =>
              uuid(value) && uuid(stage.provider_media_id)
                ? value.toLowerCase() === stage.provider_media_id.toLowerCase()
                : value === stage.provider_media_id,
            ) ||
            prior.mode !== stage.flow_mode ||
            [
              ["apiDriver", "api_driver"],
              ["protocolRevision", "protocol_revision"],
              ["protocolFingerprint", "protocol_fingerprint"],
            ].some(
              ([localKey, remoteKey]) =>
                prior[localKey] != null &&
                stage[remoteKey] != null &&
                prior[localKey] !== stage[remoteKey],
            ))
        ) {
          store.transaction.abort();
          return;
        }
        const receipt = {
          ...(prior || {}),
          mediaId: stage.provider_media_id,
          mediaUuid,
          projectId: project.flow_project_id,
          mode: stage.flow_mode,
          apiDriver: prior?.apiDriver || stage.api_driver || null,
          protocolRevision:
            prior?.protocolRevision || stage.protocol_revision || null,
          protocolFingerprint:
            prior?.protocolFingerprint || stage.protocol_fingerprint || null,
          persistentMediaId:
            prior?.persistentMediaId || stage.persistent_media_id || null,
          fileName:
            prior?.fileName ||
            stage.persistent_media_id ||
            stage.provider_media_id,
          ...((prior?.upload_name || stage.upload_name) && {
            upload_name: prior?.upload_name || stage.upload_name,
          }),
          ...((prior?.display_name || stage.display_name) && {
            display_name: prior?.display_name || stage.display_name,
          }),
          recordedAt: prior?.recordedAt || Date.now(),
        };
        store.put({
          ...(old || {
            key,
            projectScope,
            sourceScope,
            flowScope: `${userId}\0${project.flow_project_id}`,
            frameScope: `${sourceScope}\0${frameId}`,
            userId: Number(userId),
            toolProjectId,
            flowProjectId: project.flow_project_id,
            sourceRevision,
            frameId,
            kind: "source_clip",
            artifactRevision: 1,
            blob: null,
            mime: "video/mp4",
            size: 0,
            createdAt: Date.now(),
          }),
          uploadReceipt: receipt,
        });
      };
    });
  }
  static async setUploadReceipt({
    userId,
    toolProjectId,
    sourceRevision,
    frameId,
    receipt,
  }) {
    if (
      !receipt ||
      !/^[A-Za-z0-9_:=\-]{1,1024}$/.test(String(receipt.mediaId || "")) ||
      !["web", "api"].includes(receipt.mode)
    )
      throw new Error("MOTION_UPLOAD_RECEIPT_INVALID");
    const uuid = (value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    if (
      (receipt.mediaUuid != null && !uuid(receipt.mediaUuid)) ||
      (uuid(receipt.mediaId) &&
        receipt.mediaUuid &&
        receipt.mediaId.toLowerCase() !== receipt.mediaUuid.toLowerCase()) ||
      (uuid(receipt.persistentMediaId) &&
        receipt.mediaUuid &&
        receipt.persistentMediaId.toLowerCase() !==
          receipt.mediaUuid.toLowerCase())
    )
      throw new Error("MOTION_UPLOAD_RECEIPT_INVALID");
    const key = this._key(
      this._scope(userId, toolProjectId),
      sourceRevision,
      frameId,
      "source_clip",
      1,
    );
    await this._transaction("readwrite", (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (!record || record.flowProjectId !== receipt.projectId) {
          store.transaction.abort();
          return;
        }
        if (
          record.uploadReceipt &&
          (record.uploadReceipt.mediaId !== receipt.mediaId ||
            record.uploadReceipt.mode !== receipt.mode ||
            (record.uploadReceipt.mediaUuid &&
              receipt.mediaUuid &&
              record.uploadReceipt.mediaUuid.toLowerCase() !==
                receipt.mediaUuid.toLowerCase()) ||
            ["apiDriver", "protocolRevision", "protocolFingerprint"].some(
              (key2) =>
                record.uploadReceipt[key2] != null &&
                receipt[key2] != null &&
                record.uploadReceipt[key2] !== receipt[key2],
            ))
        ) {
          store.transaction.abort();
          return;
        }
        store.put({
          ...record,
          uploadReceipt: {
            mediaId: receipt.mediaId,
            mediaUuid:
              receipt.mediaUuid || record.uploadReceipt?.mediaUuid || null,
            mode: receipt.mode,
            apiDriver:
              receipt.apiDriver || record.uploadReceipt?.apiDriver || null,
            protocolRevision:
              receipt.protocolRevision ||
              record.uploadReceipt?.protocolRevision ||
              null,
            protocolFingerprint:
              receipt.protocolFingerprint ||
              record.uploadReceipt?.protocolFingerprint ||
              null,
            projectId: receipt.projectId,
            fileName:
              receipt.fileName || record.uploadReceipt?.fileName || null,
            ...(record.uploadReceipt?.upload_name && {
              upload_name: record.uploadReceipt.upload_name,
            }),
            ...(record.uploadReceipt?.display_name && {
              display_name: record.uploadReceipt.display_name,
            }),
            ...(receipt.upload_name && {
              upload_name: Array.from(String(receipt.upload_name))
                .slice(0, 255)
                .join(""),
            }),
            ...(receipt.display_name && {
              display_name: Array.from(String(receipt.display_name))
                .slice(0, 255)
                .join(""),
            }),
            persistentMediaId:
              receipt.persistentMediaId ||
              record.uploadReceipt?.persistentMediaId ||
              null,
            recordedAt: Date.now(),
          },
        });
      };
    });
  }
  static async clearUploadReceipt({
    userId,
    toolProjectId,
    sourceRevision,
    frameId,
    projectId,
    expectedMediaId,
    blob,
  }) {
    if (
      !(blob instanceof Blob) ||
      blob.type !== "video/mp4" ||
      !blob.size ||
      !expectedMediaId
    ) {
      throw new Error("MOTION_SOURCE_CLIP_MISSING");
    }
    const key = this._key(
      this._scope(userId, toolProjectId),
      sourceRevision,
      frameId,
      "source_clip",
      1,
    );
    await this._transaction("readwrite", (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        if (
          !record ||
          record.flowProjectId !== projectId ||
          (record.uploadReceipt &&
            (record.uploadReceipt.projectId !== projectId ||
              record.uploadReceipt.mediaId !== expectedMediaId))
        ) {
          store.transaction.abort();
          return;
        }
        const { uploadReceipt, ...rest } = record;
        store.put({ ...rest, blob, size: blob.size, mime: blob.type });
      };
    });
  }
  static async clearUploadedSourceBlob({
    userId,
    toolProjectId,
    sourceRevision,
    frameId,
    mediaId,
    projectId,
  }) {
    const key = this._key(
      this._scope(userId, toolProjectId),
      sourceRevision,
      frameId,
      "source_clip",
      1,
    );
    await this._transaction("readwrite", (store) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result;
        const receipt = record?.uploadReceipt;
        if (
          !record ||
          record.flowProjectId !== projectId ||
          receipt?.projectId !== projectId ||
          receipt?.mediaId !== mediaId ||
          !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            String(receipt?.mediaUuid || ""),
          )
        ) {
          store.transaction.abort();
          return;
        }
        store.put({ ...record, blob: null, size: 0 });
      };
    });
  }
  static async delete({
    userId,
    toolProjectId,
    sourceRevision,
    frameId = "project",
    kind,
    artifactRevision = 1,
  }) {
    const key = this._key(
      this._scope(userId, toolProjectId),
      sourceRevision,
      frameId,
      kind,
      artifactRevision,
    );
    await this._transaction("readwrite", (store) => {
      if (!["generated_clip", "merged_video"].includes(kind)) {
        store.delete(key);
        return;
      }
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result?.generatedStageOperationId) {
          store.transaction.abort();
          return;
        }
        store.delete(key);
      };
    });
  }
  static hasLocalBytes(record) {
    if (!record) return false;
    if (Object.prototype.hasOwnProperty.call(record, "blob"))
      return record.blob instanceof Blob && record.blob.size > 0;
    return Number.isSafeInteger(record.size) && record.size > 0;
  }
  static async listProject(userId, toolProjectId) {
    const scope = this._scope(userId, toolProjectId);
    return this._transaction("readonly", (store, done) => {
      const records = [];
      const request = store
        .index("project")
        .openCursor(IDBKeyRange.only(scope));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done(records);
          return;
        }
        const { blob, prior, ...metadata } = cursor.value;
        if (metadata.kind === "generated_staging" && prior?.blob)
          metadata.priorSize = Number(prior.size) || prior.blob.size;
        records.push(metadata);
        cursor.continue();
      };
    });
  }
  static async usage(userId, toolProjectId) {
    const records = await this.listProject(userId, toolProjectId);
    const owned = records.filter((item) => !item.blobKey);
    const byKey = new Map(owned.map((item) => [item.key, item]));
    return {
      bytes: owned.reduce(
        (sum, item) =>
          sum +
          (item.kind === "generated_staging" && item.state === "promoted"
            ? (item.priorSize || 0) +
              (byKey.get(item.targetKey)?.generatedStageOperationId ===
              item.operationId
                ? 0
                : item.size)
            : item.size),
        0,
      ),
      artifacts: owned.length,
    };
  }
  static async checkpointFinalDownload({
    userId,
    toolProjectId,
    flowProjectId,
    sourceRevision,
    artifactRevision,
    artifactId,
    state,
    expectedAttempts = 0,
    maxAttempts,
    errorCode = null,
  }) {
    const key = this._key(
      this._scope(userId, toolProjectId),
      sourceRevision,
      "project",
      "merged_video",
      artifactRevision,
    );
    if (
      !/^[A-Za-z0-9_-]{1,120}$/.test(String(artifactId || "")) ||
      !["pending", "running", "ready", "failed"].includes(state) ||
      !Number.isSafeInteger(expectedAttempts) ||
      expectedAttempts < 0 ||
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      (errorCode !== null && !/^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(errorCode))
    )
      throw new Error("MOTION_DOWNLOAD_CHECKPOINT_INVALID");
    return this._transaction("readwrite", (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => {
        const record = request.result,
          prior = record?.finalDownload;
        if (
          !record?.blob ||
          record.flowProjectId !== flowProjectId ||
          (prior && prior.artifactId !== artifactId)
        ) {
          store.transaction.abort();
          return;
        }
        if (state === "pending" && prior) {
          done(prior);
          return;
        }
        if (
          (state === "pending" && expectedAttempts !== 0) ||
          (state !== "pending" &&
            (!prior || prior.attempts !== expectedAttempts)) ||
          (state === "running" &&
            (prior.state === "ready" || prior.attempts >= prior.maxAttempts)) ||
          (["ready", "failed"].includes(state) && prior.state !== "running")
        ) {
          store.transaction.abort();
          return;
        }
        const next = {
          artifactId,
          state,
          maxAttempts: prior?.maxAttempts ?? maxAttempts,
          attempts:
            state === "running" ? prior.attempts + 1 : (prior?.attempts ?? 0),
          errorCode:
            state === "failed"
              ? errorCode || "MOTION_FINAL_DOWNLOAD_FAILED"
              : null,
          updatedAt: Date.now(),
        };
        store.put({ ...record, finalDownload: next });
        done(next);
      };
    });
  }
  static async deleteProject(userId, toolProjectId) {
    const scope = this._scope(userId, toolProjectId);
    await this._transaction("readwrite", (store) => {
      const request = store
        .index("project")
        .openCursor(IDBKeyRange.only(scope));
      request.onsuccess = () => {
        if (!request.result) return;
        if (
          request.result.value.kind === "generated_staging" ||
          (request.result.value.kind === "split_journal" &&
            request.result.value.state !== "committed")
        ) {
          store.transaction.abort();
          return;
        }
        store.delete(request.result.primaryKey);
        request.result.continue();
      };
    });
  }
  static async deleteFrameArtifacts(userId, toolProjectId) {
    const scope = this._scope(userId, toolProjectId);
    await this._transaction("readwrite", (store) => {
      const request = store
        .index("project")
        .openCursor(IDBKeyRange.only(scope));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        if (
          cursor.value.kind === "generated_staging" ||
          (cursor.value.kind === "split_journal" &&
            cursor.value.state !== "committed")
        ) {
          store.transaction.abort();
          return;
        }
        if (!["source_video", "source_draft"].includes(cursor.value.kind))
          cursor.delete();
        cursor.continue();
      };
    });
  }
  static async deleteSourceRevision(userId, toolProjectId, sourceRevision) {
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1)
      throw new Error("MOTION_ARTIFACT_KEY_INVALID");
    const scope = `${this._scope(userId, toolProjectId)}\0${sourceRevision}`;
    await this._transaction(
      "readwrite",
      (store) => {
        const request = store
          .index("source")
          .openCursor(IDBKeyRange.only(scope));
        request.onsuccess = () => {
          if (!request.result) return;
          if (
            request.result.value.kind === "generated_staging" ||
            (request.result.value.kind === "split_journal" &&
              request.result.value.state !== "committed")
          ) {
            store.transaction.abort();
            return;
          }
          store.delete(request.result.primaryKey);
          request.result.continue();
        };
      },
      "deleteSourceRevision",
    );
  }
}
__publicField(MotionArtifactStore, "DB_NAME", "tobyflow_motion_artifacts");
__publicField(MotionArtifactStore, "_dbPromise", null);
__publicField(
  MotionArtifactStore,
  "KINDS",
  new Set([
    "source_video",
    "source_clip",
    "source_audio",
    "source_full_audio",
    "generated_clip",
    "merged_video",
    "poster",
  ]),
);
globalThis.MotionArtifactStore = MotionArtifactStore;
