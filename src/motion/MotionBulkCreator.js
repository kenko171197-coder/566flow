class MotionBulkCreator {
  static canCreateMultiple(quota) {
    if (!quota || !Number.isSafeInteger(quota.limit) || quota.limit < -1)
      throw new Error("MOTION_PROJECT_QUOTA_INVALID");
    return quota.limit === -1 || quota.limit > 1;
  }
  static canRunMultiple(quota) {
    return this.canCreateMultiple(quota);
  }
  static async checkBatchAdmission({
    userId,
    bulkCreateId,
    flowProjectId,
    itemIds,
  }) {
    if (
      !Array.isArray(itemIds) ||
      !itemIds.length ||
      new Set(itemIds).size !== itemIds.length
    ) {
      throw new Error("MOTION_BULK_ITEMS_REQUIRED");
    }
    let newProjects = 0;
    const existingItemIds = [];
    for (const itemId of itemIds) {
      this._context(userId, flowProjectId);
      const journal = await window.MotionArtifactStore.getBulkJournalItem({
        userId,
        bulkCreateId,
        itemId,
      });
      if (!journal || journal.flowProjectId !== flowProjectId)
        throw new Error("MOTION_BULK_JOURNAL_MISSING");
      if (journal.stage === "selected") {
        newProjects++;
        continue;
      }
      if (journal.stage === "staged") {
        this._context(userId, flowProjectId);
        const query = new URLSearchParams({
          bulk_create_id: bulkCreateId,
          item_id: itemId,
        });
        const existing = await window.authManager._apiCall(
          "GET",
          `tools/motion-studio/projects/bulk-item?${query}`,
        );
        this._context(userId, flowProjectId);
        if (!existing) newProjects++;
        else if (existing.flow_project_id !== flowProjectId)
          throw new Error("MOTION_BULK_PROJECT_INVALID");
        else existingItemIds.push(itemId);
      } else if (journal.stage !== "selected") {
        existingItemIds.push(itemId);
      }
    }
    const quota = await this.checkQuota({
      userId,
      flowProjectId,
      count: newProjects,
    });
    return {
      ...quota,
      newProjects,
      existingItemIds,
      planAllowed: newProjects === 0 || this.canCreateMultiple(quota),
    };
  }
  static async checkQuota({ userId, flowProjectId, count }) {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !window.authManager?._apiCall
    )
      throw new Error("MOTION_PROJECT_QUOTA_INVALID");
    this._context(userId, flowProjectId);
    const quota = await window.authManager._apiCall(
      "GET",
      "tools/motion-studio/projects/quota",
    );
    this._context(userId, flowProjectId);
    if (
      !quota ||
      !Number.isSafeInteger(quota.used) ||
      quota.used < 0 ||
      !Number.isSafeInteger(quota.limit) ||
      quota.limit < -1 ||
      (quota.limit !== -1 &&
        (!Number.isSafeInteger(quota.remaining) ||
          quota.remaining !== Math.max(0, quota.limit - quota.used)))
    )
      throw new Error("MOTION_PROJECT_QUOTA_INVALID");
    return {
      ...quota,
      allowed: quota.limit === -1 || count <= quota.remaining,
    };
  }
  static async processItems({
    userId,
    bulkCreateId,
    items,
    shouldStop = () => false,
    onItem = () => {},
  }) {
    if (!Array.isArray(items) || !items.length)
      throw new Error("MOTION_BULK_ITEMS_REQUIRED");
    const seen = new Set();
    for (const item of items) {
      if (!item?.itemId || seen.has(item.itemId))
        throw new Error("MOTION_BULK_ITEM_DUPLICATE");
      seen.add(item.itemId);
    }
    const results = [];
    for (const item of items) {
      if (shouldStop()) return { status: "stopped", results };
      try {
        const result = await this.processItem({
          userId,
          bulkCreateId,
          itemId: item.itemId,
          blob: item.blob || null,
          shouldStop,
          onStage: (event) => {
            if (event.stage === "staged") item.blob = null;
            onItem({ ...event, status: "running" });
          },
        });
        results.push({ itemId: item.itemId, ...result });
        onItem({
          itemId: item.itemId,
          status: "complete",
          projectId: result.projectId,
        });
      } catch (error) {
        const code =
          error?.name === "QuotaExceededError"
            ? "MOTION_STORAGE_QUOTA_EXCEEDED"
            : error?.code || error?.message || "MOTION_BULK_ITEM_FAILED";
        if (code === "MOTION_BULK_STOPPED")
          return { status: "stopped", results };
        onItem({ itemId: item.itemId, status: "failed", code });
        return { status: "failed", failedItemId: item.itemId, code, results };
      }
    }
    return { status: "complete", results };
  }
  static _context(userId, flowProjectId) {
    if (Number(window.authManager?.getUser?.()?.id) !== Number(userId))
      throw new Error("ACCOUNT_SCOPE_CHANGED");
    if (String(window._currentProjectId || "") !== String(flowProjectId))
      throw new Error("MOTION_FLOW_PROJECT_CHANGED");
  }
  static async _liveContext(userId, flowProjectId) {
    this._context(userId, flowProjectId);
    if (!window.MessageBridge?.getTargetContext)
      throw new Error("MOTION_FLOW_PROJECT_UNAVAILABLE");
    const target =
      await window.MessageBridge.getProjectTargetContext(flowProjectId);
    this._context(userId, flowProjectId);
    if (
      !target ||
      target.projectId !== flowProjectId ||
      !Number.isInteger(target.tabId) ||
      !target.driverKey
    ) {
      throw new Error("MOTION_FLOW_PROJECT_CHANGED");
    }
    return target;
  }
  static _mismatchKeys(project, settings) {
    const normalize = (value) =>
      JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === "string" ? item.trim() || null : item,
        ),
      );
    const expected = normalize(settings);
    const actual = normalize(
      Object.fromEntries(
        Object.keys(expected).map((key) => [
          key,
          key === "references"
            ? project.data_json?.references
            : project.data_json?.preferences?.[key],
        ]),
      ),
    );
    const same = (left, right) => {
      if (left === right) return true;
      if (
        !left ||
        !right ||
        typeof left !== "object" ||
        typeof right !== "object" ||
        Array.isArray(left) !== Array.isArray(right)
      )
        return false;
      const a = Object.keys(left).sort(),
        b = Object.keys(right).sort();
      return (
        a.length === b.length &&
        a.every((key, i) => key === b[i] && same(left[key], right[key]))
      );
    };
    return Object.entries(expected)
      .filter(([key, value]) => !same(actual[key], value))
      .map(([key]) => key);
  }
  static _matches(project, settings) {
    return this._mismatchKeys(project, settings).length === 0;
  }
  static async cleanupTemporaryBatches({
    userId,
    flowProjectId,
    ttlHours = null,
    opening = false,
    now = Date.now(),
  }) {
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    const validTtl =
      Number.isSafeInteger(ttlHours) && ttlHours >= 1 && ttlHours <= 720;
    const items = await window.MotionArtifactStore.listPendingBulkJournalItems(
      userId,
      { includeCompleted: true, metadataOnly: true },
    );
    const groups = new Map();
    for (const item of items) {
      if (!groups.has(item.bulkCreateId)) groups.set(item.bulkCreateId, []);
      groups.get(item.bulkCreateId).push(item);
    }
    const current = () =>
      Number(window.authManager?.getUser?.()?.id) === userId;
    let cleared = 0;
    for (const [bulkCreateId, batch] of groups) {
      if (!current()) break;
      const age =
        now -
        batch.reduce(
          (latest, item) =>
            Math.max(latest, Number(item.updatedAt || item.createdAt || now)),
          0,
        );
      const expired = validTtl && age >= ttlHours * 36e5;
      if (
        !expired &&
        !(
          opening && batch.every((item) => item.flowProjectId === flowProjectId)
        )
      )
        continue;
      try {
        await navigator.locks.request(
          `motion-bulk-modal:${userId}:${bulkCreateId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock || !current()) return;
            await this.discardBatch({
              userId,
              bulkCreateId,
              expired,
              shouldStop: () => !current(),
            });
            cleared++;
          },
        );
      } catch (error) {
        console.warn("[MotionBulkCleanup]", {
          bulkCreateId,
          code: error?.message,
        });
      }
    }
    return { cleared };
  }
  static async discardBatch({
    userId,
    bulkCreateId,
    expired = false,
    shouldStop = () => false,
  }) {
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    const store = window.MotionArtifactStore;
    const items = await store.listBulkJournalItems({
      userId,
      bulkCreateId,
      metadataOnly: true,
    });
    for (const item of items)
      await navigator.locks.request(
        `motion-bulk:${userId}:${bulkCreateId}:${item.itemId}`,
        {},
        async () => {
          if (shouldStop()) return;
          const identity = { userId, bulkCreateId, itemId: item.itemId };
          const journal = await store.getBulkJournalItem(identity);
          if (!journal) return;
          let projectId = journal.projectId;
          if (!expired && journal.stage === "staged" && !projectId) {
            this._context(userId, journal.flowProjectId);
            const query = new URLSearchParams({
              bulk_create_id: bulkCreateId,
              item_id: item.itemId,
            });
            const existing = await window.authManager._apiCall(
              "GET",
              `tools/motion-studio/projects/bulk-item?${query}`,
            );
            this._context(userId, journal.flowProjectId);
            if (existing && existing.flow_project_id !== journal.flowProjectId)
              throw new Error("MOTION_BULK_PROJECT_INVALID");
            projectId = existing?.tool_project_id || null;
          }
          const source = await store.getBulkSource(identity);
          if (shouldStop()) return;
          if (projectId && source && !source.toolProjectId)
            await store.bindBulkSource({
              ...identity,
              toolProjectId: projectId,
              flowProjectId: journal.flowProjectId,
            });
          await store.discardBulkJournalItem(identity);
        },
      );
  }
  static async processItem({
    userId,
    bulkCreateId,
    itemId,
    blob = null,
    shouldStop = () => false,
    onStage = () => {},
  }) {
    if (
      !navigator.locks?.request ||
      !window.MotionArtifactStore ||
      !window.authManager?._apiCall
    ) {
      throw new Error("MOTION_BULK_RUNNER_UNAVAILABLE");
    }
    const identity = { userId, bulkCreateId, itemId };
    const store = window.MotionArtifactStore;
    return navigator.locks.request(
      `motion-bulk:${userId}:${bulkCreateId}:${itemId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("MOTION_BULK_ITEM_ACTIVE");
        let journal = await store.getBulkJournalItem(identity);
        if (!journal) throw new Error("MOTION_BULK_JOURNAL_MISSING");
        const allowedSettings = new Set([
          "auto_download_final",
          "remove_final_video_watermark",
          "flow_download_resolution",
          "voice_enabled",
          "voice_mode",
          "subtitle_enabled",
          "transcription_provider",
          "translate_enabled",
          "target_language",
          "ratio",
          "voice_description",
          "voice_slug",
          "references",
          "max_split_clip_seconds",
        ]);
        if (
          Object.keys(journal.settings || {}).some(
            (key) => !allowedSettings.has(key),
          )
        )
          throw new Error("MOTION_BULK_SETTINGS_INVALID");
        const advance = async (stage, extra = {}) => {
          journal = await store.advanceBulkJournalItem({
            ...identity,
            version: journal.version,
            stage,
            ...extra,
          });
          onStage({ itemId, stage, projectId: journal.projectId });
        };
        const api = (method, path2, data) =>
          window.authManager._apiCall(method, path2, data);
        const admit = () => {
          this._context(userId, journal.flowProjectId);
          if (shouldStop()) throw new Error("MOTION_BULK_STOPPED");
        };
        admit();
        if (journal.stage !== "selected" && blob) {
          const staged = await store.getBulkSource(identity);
          if (
            !staged?.blob ||
            staged.flowProjectId !== journal.flowProjectId ||
            staged.fileName !== journal.fileName
          ) {
            throw new Error("MOTION_BULK_SOURCE_MISMATCH");
          }
          blob = null;
          onStage({ itemId, stage: "staged", projectId: journal.projectId });
        }
        if (journal.stage === "selected") {
          let source = await store.getBulkSource(identity);
          if (!source) {
            if (!(blob instanceof Blob) || !blob.size)
              throw new Error("MOTION_BULK_FILE_REQUIRED");
            admit();
            if (typeof navigator.storage?.estimate === "function") {
              const estimate = await navigator.storage.estimate();
              admit();
              if (
                Number.isFinite(estimate?.usage) &&
                Number.isFinite(estimate?.quota) &&
                estimate.quota > 0 &&
                blob.size > Math.max(0, estimate.quota - estimate.usage)
              )
                throw new Error("MOTION_STORAGE_QUOTA_EXCEEDED");
            }
            await store.stageBulkSource({
              ...identity,
              flowProjectId: journal.flowProjectId,
              blob,
              fileName: journal.fileName,
            });
            source = await store.getBulkSource(identity);
          }
          if (
            !source?.blob ||
            source.flowProjectId !== journal.flowProjectId ||
            source.fileName !== journal.fileName
          ) {
            throw new Error("MOTION_BULK_SOURCE_MISMATCH");
          }
          source = null;
          blob = null;
          await advance("staged");
        }
        if (journal.stage === "staged") {
          admit();
          const query = new URLSearchParams({
            bulk_create_id: bulkCreateId,
            item_id: itemId,
          });
          let project = await api(
            "GET",
            `tools/motion-studio/projects/bulk-item?${query}`,
          );
          if (!project) {
            admit();
            await this._liveContext(userId, journal.flowProjectId);
            admit();
            const name =
              journal.fileName
                .replace(/\.[^.]+$/, "")
                .trim()
                .slice(0, 160) || "Motion project";
            project = await api("POST", "tools/motion-studio/projects", {
              name,
              flow_project_id: journal.flowProjectId,
              bulk_create_id: bulkCreateId,
              item_id: itemId,
              voice_mode: journal.settings?.voice_mode || "lip_sync",
            });
          }
          if (
            !project?.tool_project_id ||
            project.flow_project_id !== journal.flowProjectId
          )
            throw new Error("MOTION_BULK_PROJECT_INVALID");
          await advance("created", { projectId: project.tool_project_id });
        }
        const path = `tools/motion-studio/projects/${encodeURIComponent(journal.projectId || "")}`;
        if (journal.stage === "created") {
          admit();
          await this._liveContext(userId, journal.flowProjectId);
          admit();
          await store.bindBulkSource({
            ...identity,
            toolProjectId: journal.projectId,
            flowProjectId: journal.flowProjectId,
          });
          await advance("bound");
        }
        if (journal.stage === "bound") {
          admit();
          const source = await store.getBulkSource(identity);
          const project = await api("GET", path);
          if (
            !source?.blob ||
            source.toolProjectId !== journal.projectId ||
            project?.flow_project_id !== journal.flowProjectId
          ) {
            throw new Error("MOTION_BULK_SOURCE_MISMATCH");
          }
          admit();
          await this._liveContext(userId, journal.flowProjectId);
          admit();
          const saved = await api("PUT", `${path}/source-draft`, {
            revision: project.revision,
            draft_id: itemId,
            file_name: source.fileName,
            mime: source.mime || "application/octet-stream",
            size: source.size,
            duration: journal.duration,
          });
          await advance("source_saved", { projectRevision: saved.revision });
        }
        if (journal.stage === "source_saved") {
          admit();
          let project = await api("GET", path);
          if (project?.flow_project_id !== journal.flowProjectId)
            throw new Error("MOTION_BULK_PROJECT_INVALID");
          if (!this._matches(project, journal.settings)) {
            if (project.revision !== journal.projectRevision)
              throw new Error("MOTION_BULK_SETTINGS_CONFLICT");
            admit();
            await this._liveContext(userId, journal.flowProjectId);
            admit();
            project = await api("PATCH", path, {
              revision: journal.projectRevision,
              ...journal.settings,
            });
            if (!this._matches(project, journal.settings)) {
              console.warn("[MotionBulkSettings]", {
                bulkCreateId,
                itemId,
                projectId: journal.projectId,
                stage: "verify",
                revision: project?.revision,
                mismatchKeys: this._mismatchKeys(project, journal.settings),
              });
              throw new Error("MOTION_BULK_SETTINGS_UNVERIFIED");
            }
          }
          await advance("complete", { projectRevision: project.revision });
        }
        return { projectId: journal.projectId, stage: journal.stage };
      },
    );
  }
}
globalThis.MotionBulkCreator = MotionBulkCreator;
