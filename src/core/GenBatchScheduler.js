class GenBatchScheduler {
  constructor({
    store = window.GenBatchQueueStore,
    queue = window.PromptQueue?.getInstance?.(),
    scope,
    admit,
    onChange = () => {},
    onError = () => {},
  }) {
    this.store = store;
    this.queue = queue;
    this.scope = scope;
    this.admit = admit;
    this.onChange = onChange;
    this.onError = onError;
    this.state = "idle";
    this.activeBatchId = null;
    this.activeJobId = null;
    this._activeOwner = null;
    this._statusSync = Promise.resolve();
    this._regenReceiptSync = Promise.resolve();
    this._regenReceiptSeen = new Set();
    this._finalizingBatch = false;
    this._loopPromise = null;
    this._startPromise = null;
    this._singleBatchId = null;
    this._runSource = null;
    this._runOriginId = null;
    this._leaseOwner = crypto.randomUUID();
    this._leaseScope = null;
    this._leaseTimer = null;
    this._epoch = 0;
    this._explicitEpoch = 0;
    this._unsubStopAll = window.eventBus?.on?.("queue:stop_all_requested", () =>
      this._stopIntent(),
    );
    this._unsubStopJob = window.eventBus?.on?.(
      "queue:job_stop_requested",
      ({ jobId }) => {
        if (jobId && jobId === this.activeJobId) this._stopIntent();
      },
    );
    this._unsubScope = ["project:changed", "auth:logout", "auth:login"].map(
      (name) =>
        window.eventBus?.on?.(name, () => {
          this._explicitEpoch++;
          if (!this._leaseScope) return;
          this._stopIntent();
          this._releaseLease().catch((error) =>
            console.warn("[GenBatchScheduler] release failed", error),
          );
        }),
    );
  }
  dispose() {
    this._unsubStopAll?.();
    this._unsubStopJob?.();
    this._unsubScope?.forEach((unsubscribe) => unsubscribe?.());
    this._stopIntent();
    this._releaseLease().catch((error) =>
      console.warn("[GenBatchScheduler] release failed", error),
    );
  }
  _owner() {
    const owner = this.scope?.();
    if (!owner?.userId || !owner?.projectId)
      throw new Error("BATCH_SCOPE_REQUIRED");
    return owner;
  }
  _emit() {
    const phase = `${this.state}|${this.activeBatchId || ""}|${this.activeJobId || ""}`;
    if (phase !== this._lastPhaseLog) {
      this._lastPhaseLog = phase;
      console.info(
        "[GenBatchScheduler]",
        JSON.stringify({
          state: this.state,
          batchId: this.activeBatchId || null,
          jobId: this.activeJobId || null,
        }),
      );
    }
    this.onChange({
      state: this.state,
      activeBatchId: this.activeBatchId,
      activeJobId: this.activeJobId,
    });
  }
  _resultReceipt(results) {
    return (Array.isArray(results) ? results : [])
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
  }
  observe(snapshot) {
    const owner = this._activeOwner;
    const batchId = this.activeBatchId;
    const jobId = this.activeJobId;
    const job = snapshot?.jobs?.find(
      (entry) =>
        entry.id === jobId &&
        entry.sourceBatchId === batchId &&
        entry.projectId === owner?.projectId,
    );
    if (
      !owner ||
      !batchId ||
      !job ||
      this._finalizingBatch ||
      !["running", "paused"].includes(job.status)
    )
      return;
    this._statusSync = this._statusSync
      .catch(() => {})
      .then(async () => {
        if (this._finalizingBatch) return;
        const current = await this.store.get(
          owner.userId,
          owner.projectId,
          batchId,
        );
        if (
          !current ||
          current.jobId !== jobId ||
          !["running", "paused"].includes(current.status)
        )
          return;
        const terminalItems = [...(current.terminalItems || [])];
        let receiptChanged = false;
        for (
          let index = 0;
          index < (current.runtimeItemIds || []).length;
          index++
        ) {
          const rootId = current.runtimeItemIds[index];
          const item = job.items?.find((entry) => entry.id === rootId);
          if (!item) continue;
          const previous = terminalItems[index] || {};
          const results = this._resultReceipt(item.results);
          if (
            previous.id === rootId &&
            ["COMPLETED", "PARTIAL_FAIL"].includes(previous.state) &&
            Number(previous.completedAt || 0) > Number(item.completedAt || 0)
          )
            continue;
          const terminalState = [
            "COMPLETED",
            "PARTIAL_FAIL",
            "FAILED",
            "CANCELLED",
            "BLOCKED",
          ].includes(item.state)
            ? item.state
            : previous.state;
          if (!terminalState && !results.length && !previous.id) continue;
          const next = {
            ...previous,
            id: rootId,
            state: terminalState || null,
            ...(["api", "web"].includes(item.genMode)
              ? { genMode: item.genMode }
              : {}),
            results: results.length ? results : previous.results || [],
          };
          if (JSON.stringify(previous) !== JSON.stringify(next)) {
            terminalItems[index] = next;
            receiptChanged = true;
          }
        }
        if (!receiptChanged && current.status === job.status) return;
        await this.store.update(
          owner.userId,
          owner.projectId,
          batchId,
          current.revision,
          (record) => ({ ...record, status: job.status, terminalItems }),
        );
        this._emit();
      })
      .catch((error) => {
        console.warn("[GenBatchScheduler] pause state sync failed", error);
        this.onError(error);
        this._stopIntent();
      });
  }
  observeRegen(snapshot, { notify = true } = {}) {
    const owner = this.scope?.();
    if (!owner?.userId || !owner?.projectId) return;
    const pending = [];
    for (const job of snapshot?.jobs || []) {
      if (
        job.owner !== "prompts" ||
        job.projectId !== owner.projectId ||
        !job.regenDisplay?.jobId ||
        !job.regenDisplay.sessionId
      )
        continue;
      for (const item of job.items || []) {
        if (!["COMPLETED", "PARTIAL_FAIL"].includes(item.state)) continue;
        const rootId = item.regenOf || item._regenSlotRoot;
        const results = this._resultReceipt(item.results);
        const completedAt = Number(item.completedAt || job.completedAt);
        if (
          !rootId ||
          !results.length ||
          !Number.isFinite(completedAt) ||
          completedAt <= 0
        )
          continue;
        const key = `${owner.userId}|${owner.projectId}|${job.id}|${item.id}|${completedAt}|${JSON.stringify(results)}`;
        if (this._regenReceiptSeen.has(key)) continue;
        this._regenReceiptSeen.add(key);
        pending.push({
          key,
          ownerJobId: job.regenDisplay.jobId,
          ownerSessionId: job.regenDisplay.sessionId,
          rootId,
          state: item.state,
          completedAt,
          results,
          genMode: ["api", "web"].includes(item.genMode) ? item.genMode : null,
        });
      }
    }
    if (!pending.length) return;
    this._regenReceiptSync = this._regenReceiptSync
      .catch(() => {})
      .then(async () => {
        const current = this.scope?.();
        if (
          String(current?.userId) !== String(owner.userId) ||
          current?.projectId !== owner.projectId
        ) {
          for (const entry of pending) this._regenReceiptSeen.delete(entry.key);
          return;
        }
        const batches = await this.store.list(owner.userId, owner.projectId);
        let changed = false;
        for (const receipt of pending) {
          const batch = batches.find(
            (record) =>
              (record.runtimeItemIds || []).includes(receipt.rootId) &&
              [
                {
                  jobId: record.jobId,
                  trackerSessionId: record.trackerSessionId,
                },
                ...(record.executionSegments || []),
              ].some(
                (segment) =>
                  segment.jobId === receipt.ownerJobId &&
                  segment.trackerSessionId === receipt.ownerSessionId,
              ),
          );
          if (!batch) continue;
          changed =
            (await this.store.applyRegenReceipt(
              owner.userId,
              owner.projectId,
              batch.batchId,
              receipt,
            )) || changed;
        }
        if (changed && notify) this.onChange();
      })
      .catch((error) => {
        for (const entry of pending) this._regenReceiptSeen.delete(entry.key);
        console.warn("[GenBatchScheduler] Regen receipt sync failed", error);
        this.onError(error);
      });
  }
  _stopIntent() {
    this.state = "stopped";
    this._epoch++;
    this._explicitEpoch++;
    this._wakeIdleWait?.();
    this._emit();
  }
  async _acquireLease(owner) {
    await this.store.acquireLease?.(
      owner.userId,
      owner.projectId,
      this._leaseOwner,
    );
    this._leaseScope = { ...owner };
    if (!this._leaseTimer && this.store.renewLease)
      this._leaseTimer = setInterval(() => {
        this.store
          .renewLease(owner.userId, owner.projectId, this._leaseOwner)
          .catch((error) => {
            console.warn("[GenBatchScheduler] coordinator lease lost", error);
            this._stopIntent();
          });
      }, 1e4);
    this._leaseTimer?.unref?.();
  }
  async _releaseLease() {
    if (this._leaseTimer) clearInterval(this._leaseTimer);
    this._leaseTimer = null;
    const owner = this._leaseScope;
    this._leaseScope = null;
    if (owner)
      await this.store.releaseLease?.(
        owner.userId,
        owner.projectId,
        this._leaseOwner,
      );
  }
  async _waitForRuntimeIdle(epoch) {
    if (!this.queue.isRunning && this.queue.activeJobCount === 0) return;
    await new Promise((resolve) => {
      const finish = () => {
        unsubscribe?.();
        this._wakeIdleWait = null;
        resolve();
      };
      const onChange = () => {
        if (
          this.state !== "running" ||
          this._epoch !== epoch ||
          (!this.queue.isRunning && this.queue.activeJobCount === 0)
        )
          finish();
      };
      const unsubscribe = window.eventBus?.on?.(
        "queue:state_changed",
        onChange,
      );
      this._wakeIdleWait = finish;
      onChange();
    });
  }
  async runAll(runSource = "BATCH_LIST_RUN_ALL", runOriginId = null) {
    if (this._loopPromise) return this._loopPromise;
    if (this._startPromise) return this._startPromise;
    const owner = this._owner();
    if (!this.queue || typeof this.admit !== "function")
      throw new Error("BATCH_ADMISSION_UNAVAILABLE");
    if (!window.PromptQueue?.isEnabled?.())
      throw new Error("PIPELINE_QUEUE_DISABLED");
    const startEpoch = this._epoch;
    this._startPromise = (async () => {
      await this._acquireLease(owner);
      const current = this.scope?.();
      if (
        this._epoch !== startEpoch ||
        String(current?.userId) !== String(owner.userId) ||
        current?.projectId !== owner.projectId
      ) {
        await this._releaseLease();
        throw new Error("BATCH_SCOPE_CHANGED");
      }
      this.state = "running";
      if (runSource !== "BATCH_LIST_RESUME" || !this._generationProcessId)
        this._generationProcessId = crypto.randomUUID();
      this._runSource = runSource;
      this._runOriginId =
        runSource === "BATCH_LIST_RERUN_MCP" ? runOriginId : null;
      this._emit();
      const epoch = ++this._epoch;
      this._loopPromise = this._loop(epoch, owner).finally(async () => {
        this._loopPromise = null;
        this.activeBatchId = null;
        this.activeJobId = null;
        this._activeOwner = null;
        this._runSource = null;
        this._runOriginId = null;
        if (this.state === "running") this.state = "idle";
        if (this.state === "idle" || this.state === "stopped")
          await this._releaseLease();
        this._emit();
      });
      return this._loopPromise;
    })().finally(() => {
      this._startPromise = null;
    });
    return this._startPromise;
  }
  queueExplicit(
    batchId,
    runSource = "BATCH_LIST_RERUN_BATCH",
    runOriginId = null,
  ) {
    const owner = { ...this._owner() },
      explicitEpoch = this._explicitEpoch;
    const previous =
      this._explicitTail ||
      this._startPromise ||
      this._loopPromise ||
      Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        while (this._explicitEpoch === explicitEpoch) {
          const current = this.scope?.();
          if (
            String(current?.userId) !== String(owner.userId) ||
            current?.projectId !== owner.projectId
          )
            throw new Error("BATCH_SCOPE_CHANGED");
          const active = this._startPromise || this._loopPromise;
          if (active) {
            await active.catch(() => {});
            continue;
          }
          const batch = await this.store.get(
            owner.userId,
            owner.projectId,
            batchId,
          );
          if (
            this._explicitEpoch !== explicitEpoch ||
            batch?.status !== "queued"
          )
            return;
          if (this._startPromise || this._loopPromise) continue;
          if (this.state === "paused" && !this.activeJobId) this.state = "idle";
          this._explicitSingle = true;
          try {
            return await this.runOne(batchId, runSource, runOriginId);
          } finally {
            this._explicitSingle = false;
          }
        }
      });
    this._explicitTail = task;
    task
      .catch((error) => this.onError(error))
      .finally(() => {
        if (this._explicitTail === task) this._explicitTail = null;
      });
    return { queued: true, batchId };
  }
  async runOne(
    batchId,
    runSource = "BATCH_LIST_RUN_BATCH",
    runOriginId = null,
  ) {
    if (
      !batchId ||
      this._loopPromise ||
      this._startPromise ||
      ["running", "paused"].includes(this.state)
    )
      throw new Error("BATCH_ALREADY_RUNNING");
    this._singleBatchId = batchId;
    try {
      return await this.runAll(runSource, runOriginId);
    } finally {
      this._singleBatchId = null;
    }
  }
  async _loop(epoch, owner) {
    while (this.state === "running" && this._epoch === epoch) {
      const current = this.scope?.();
      if (
        String(current?.userId) !== String(owner.userId) ||
        current?.projectId !== owner.projectId
      ) {
        this.state = "paused";
        this._emit();
        return;
      }
      const { userId, projectId } = owner;
      const batches = await this.store.list(userId, projectId);
      if (this.state !== "running" || this._epoch !== epoch) return;
      const blocking = this._explicitSingle
        ? batches.filter((batch2) => batch2.batchId === this._singleBatchId)
        : batches;
      if (
        blocking.some((batch2) =>
          ["admitting", "running", "paused"].includes(batch2.status),
        )
      ) {
        this.state = "paused";
        this._emit();
        return;
      }
      if (
        blocking.some(
          (batch2) => batch2.status === "needs_review" && !batch2.completedAt,
        )
      ) {
        this.state = "paused";
        this._emit();
        return;
      }
      const batch = batches.find(
        (entry) =>
          entry.status === "queued" &&
          !entry.hiddenFromBatchList &&
          (!this._singleBatchId || entry.batchId === this._singleBatchId),
      );
      if (!batch) return;
      if (!window.PromptQueue?.isEnabled?.()) {
        this.state = "paused";
        this._emit();
        return;
      }
      if (this.queue.isRunning || this.queue.activeJobCount > 0)
        await this._waitForRuntimeIdle(epoch);
      if (this.state !== "running" || this._epoch !== epoch) return;
      if (!window.PromptQueue?.isEnabled?.()) {
        this.state = "paused";
        this._emit();
        return;
      }
      const beforeClaim = this.scope?.();
      if (
        String(beforeClaim?.userId) !== String(userId) ||
        beforeClaim?.projectId !== projectId
      ) {
        this.state = "paused";
        this._emit();
        return;
      }
      const claimed = await this.store.update(
        userId,
        projectId,
        batch.batchId,
        batch.revision,
        (record) => {
          if (record.refMode === "sequential" && !record.resumeItemIndexes)
            window.GenBatchDraftBuilder.remapDraft(record);
          const continuing = !!record.resumeItemIndexes && !!record.jobId;
          const generationProcessId =
            continuing && record.generationProcessId
              ? record.generationProcessId
              : this._generationProcessId;
          return { ...record, status: "admitting", generationProcessId };
        },
      );
      const afterClaim = this.scope?.();
      if (
        this.state !== "running" ||
        this._epoch !== epoch ||
        String(afterClaim?.userId) !== String(userId) ||
        afterClaim?.projectId !== projectId
      ) {
        await this.store.update(
          userId,
          projectId,
          claimed.batchId,
          claimed.revision,
          (record) => ({ ...record, status: "queued" }),
        );
        if (this.state === "running") {
          this.state = "paused";
          this._emit();
        }
        return;
      }
      this.activeBatchId = claimed.batchId;
      this._activeOwner = owner;
      this._finalizingBatch = false;
      this._emit();
      let admitted = null;
      let admittedJobRef = null;
      let mappingWrite = null;
      const onAdmission = (receipt) => {
        if (mappingWrite) return mappingWrite;
        const indexes2 =
          claimed.resumeItemIndexes || claimed.items.map((_, index) => index);
        if (
          !receipt?.ok ||
          !receipt.jobId ||
          !Array.isArray(receipt.itemIds) ||
          receipt.itemIds.length !== indexes2.length
        ) {
          mappingWrite = Promise.reject(
            new Error("BATCH_ADMISSION_RECEIPT_INVALID"),
          );
          return mappingWrite;
        }
        admitted = receipt;
        admittedJobRef = this.queue.getJob?.(receipt.jobId) || null;
        this.activeJobId = receipt.jobId;
        this._emit();
        mappingWrite = this.store
          .get(userId, projectId, claimed.batchId)
          .then((current2) => {
            if (!current2 || current2.status !== "admitting")
              throw new Error("BATCH_ADMISSION_STATE_CHANGED");
            return this.store.update(
              userId,
              projectId,
              claimed.batchId,
              current2.revision,
              (record) => {
                const runtimeItemIds = [...(record.runtimeItemIds || [])];
                indexes2.forEach((index, position) => {
                  runtimeItemIds[index] = receipt.itemIds[position];
                });
                return {
                  ...record,
                  status: "running",
                  jobId: receipt.jobId,
                  trackerSessionId: receipt.sessionId || null,
                  runtimeItemIds,
                };
              },
            );
          })
          .then(
            (value) => {
              this.observe(this.queue.getSnapshot?.());
              return { value };
            },
            (error) => {
              this._stopIntent();
              return { error };
            },
          );
        return mappingWrite;
      };
      let result;
      let failed = null;
      try {
        result = await this.admit(
          claimed,
          onAdmission,
          this._runSource,
          this._runOriginId,
          claimed.generationProcessId,
        );
      } catch (error) {
        failed = error;
      }
      if (mappingWrite) failed || (failed = (await mappingWrite).error || null);
      if (failed) {
        const rawCode = String(
          failed.code || failed.message || "BATCH_ADMISSION_FAILED",
        );
        const code = /^[A-Z][A-Z0-9_]{2,120}$/.test(rawCode)
          ? rawCode
          : "BATCH_ADMISSION_FAILED";
        console.warn(
          "[GenBatchScheduler] admission failed",
          JSON.stringify({
            batchId: claimed.batchId,
            jobId: admitted?.jobId || null,
            code,
          }),
        );
      }
      if (admitted && !failed) this.observe(this.queue.getSnapshot?.());
      if (!admitted) {
        try {
          const current2 = await this.store.get(
            userId,
            projectId,
            claimed.batchId,
          );
          await this.store.update(
            userId,
            projectId,
            claimed.batchId,
            current2.revision,
            (record) => ({
              ...record,
              status: "needs_review",
              admissionError: String(
                failed?.message || result?.reason || "BATCH_ADMISSION_DENIED",
              ).slice(0, 300),
            }),
          );
        } catch (error) {
          failed || (failed = error);
        }
        this.state = "paused";
        this._emit();
        if (failed) throw failed;
        return;
      }
      if (failed) {
        try {
          const current2 = await this.store.get(
            userId,
            projectId,
            claimed.batchId,
          );
          if (current2?.status === "admitting")
            await this.store.update(
              userId,
              projectId,
              claimed.batchId,
              current2.revision,
              (record) => ({
                ...record,
                status: "needs_review",
                jobId: admitted.jobId,
                trackerSessionId: admitted.sessionId || null,
                runtimeItemIds: admitted.itemIds,
                admissionError: "BATCH_MAPPING_WRITE_FAILED",
              }),
            );
        } catch (_) {}
        this.state = "paused";
        this._emit();
        throw failed;
      }
      this._finalizingBatch = true;
      await this._statusSync;
      const persisted = await this.store.get(
        userId,
        projectId,
        claimed.batchId,
      );
      const job = admittedJobRef || this.queue.getJob?.(admitted.jobId);
      const indexes =
        claimed.resumeItemIndexes || claimed.items.map((_, index) => index);
      const terminalItems = [...(persisted.terminalItems || [])];
      if (job)
        job.items.forEach((item, position) => {
          const index = indexes[position];
          const freshResults = this.queue._itemResults?.(item) || [];
          const previous = terminalItems[index];
          if (
            previous?.id === item.id &&
            ["COMPLETED", "PARTIAL_FAIL"].includes(previous.state) &&
            Number(previous.completedAt || 0) > Number(item.completedAt || 0)
          )
            return;
          terminalItems[index] = {
            id: item.id,
            prompt: item.prompt,
            state: item.state,
            genMode: ["api", "web"].includes(item.genMode)
              ? item.genMode
              : ["api", "web"].includes(previous?.genMode)
                ? previous.genMode
                : null,
            error: item.error || null,
            resultIds: [...(item.resultTileIds || [])],
            results: freshResults.length
              ? this._resultReceipt(freshResults)
              : persisted.terminalItems?.[index]?.results || [],
            resultIdentity: freshResults.map((result2) => ({
              tileId: result2.tileId || null,
              mediaId: result2.mediaId || null,
              mediaUuid: result2.mediaUuid || null,
              fileName: result2.fileName || null,
              video: result2.video === true,
            })),
            completedAt: item.completedAt || null,
          };
        });
      const visible = persisted.items.map(
        (item, index) => !item.hidden && terminalItems[index],
      );
      const allCompleted = visible.every(
        (item) => !item || item.state === "COMPLETED",
      );
      await this.store.update(
        userId,
        projectId,
        claimed.batchId,
        persisted.revision,
        (record) => ({
          ...record,
          status: result?.stopped
            ? "stopped"
            : allCompleted
              ? "completed"
              : Number(result?.completed || 0) === 0 &&
                  Number(result?.failed || 0) > 0
                ? "failed"
                : "needs_review",
          completedAt: Date.now(),
          terminalItems,
          resumeItemIndexes: null,
        }),
      );
      this.activeBatchId = null;
      this.activeJobId = null;
      this._activeOwner = null;
      this._emit();
      if (result?.stopped || this.state !== "running" || this._epoch !== epoch)
        return;
      if (this._singleBatchId === batch.batchId) return;
    }
  }
  async pause() {
    if (this.state !== "running") return false;
    this.state = "paused";
    this._wakeIdleWait?.();
    this._emit();
    if (!this.activeJobId) return true;
    this.queue.pauseJob(this.activeJobId, "manual", "BATCH_LIST_PAUSE");
    const paused = this.queue.getJob?.(this.activeJobId)?.state === "paused";
    if (!paused) {
      this.state = "running";
      this._emit();
    } else {
      this.observe(this.queue.getSnapshot?.());
      await this._statusSync;
    }
    return paused && this.state === "paused";
  }
  async resume() {
    const active = this.activeJobId && this.queue.getJob?.(this.activeJobId);
    if (this.state !== "paused" && active?.state !== "paused") return false;
    if (this.activeJobId) {
      if (!active || active.state !== "paused") return false;
      if (!(await this.queue.resumeJob(this.activeJobId))) return false;
      this.state = "running";
      this._emit();
      return true;
    }
    if (this._loopPromise) {
      if (!this.activeBatchId) {
        await this._loopPromise.catch(() => {});
        if (this.state !== "paused" && this.state !== "idle") return false;
        return this.runAll("BATCH_LIST_RESUME");
      }
      this.state = "running";
      this._emit();
      return true;
    }
    return this.runAll("BATCH_LIST_RESUME");
  }
  async stop() {
    const jobId = this.activeJobId;
    this._stopIntent();
    if (!this._loopPromise) await this._releaseLease();
    return jobId
      ? this.queue.stopJob(jobId, {
          stopOrigin: "user",
          stopSource: "BATCH_LIST_STOP",
        })
      : true;
  }
}
window.GenBatchScheduler = GenBatchScheduler;
