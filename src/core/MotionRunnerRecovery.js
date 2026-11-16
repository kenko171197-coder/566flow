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
class MotionRunnerRecovery {
  static key(input) {
    return `${input.userId}:${input.batchId ? `batch:${input.batchId}` : input.projectId}`;
  }
  static async mutate(change) {
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    return navigator.locks.request("motion-recovery-intents", async () => {
      const data = (await chrome.storage.local.get(this.KEY))?.[this.KEY] || {};
      const before = JSON.stringify(data);
      const result = change(data);
      if (JSON.stringify(data) !== before)
        await chrome.storage.local.set({ [this.KEY]: data });
      return result;
    });
  }
  static async register(input) {
    const uuid = (value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    if (
      !Number.isSafeInteger(input.userId) ||
      input.userId < 1 ||
      !uuid(input.projectId) ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(input.flowProjectId || "") ||
      !uuid(input.runId) ||
      (input.batchId && !uuid(input.batchId)) ||
      !Number.isSafeInteger(input.hostEpoch) ||
      input.hostEpoch < 1 ||
      !Number.isSafeInteger(input.maxRetries) ||
      input.maxRetries < 0
    )
      throw new Error("MOTION_RECOVERY_INTENT_INVALID");
    return this.mutate((records) => {
      const key = this.key(input),
        existing = records[key];
      if (
        input.automaticRecovery === true &&
        (!existing ||
          existing.runId !== input.runId ||
          existing.flowProjectId !== input.flowProjectId)
      )
        throw new Error("MOTION_RECOVERY_FENCED");
      records[key] = {
        userId: input.userId,
        projectId: input.projectId,
        flowProjectId: input.flowProjectId,
        runId: input.runId,
        hostEpoch: input.hostEpoch,
        ...(input.batchId && { batchId: input.batchId }),
        ...(input.parentBatchId && { parentBatchId: input.parentBatchId }),
        screen: input.screen || {},
        state: "preparing",
        recoveries: input.automaticRecovery ? existing.recoveries : 0,
        maxRecoveries: input.automaticRecovery
          ? existing.maxRecoveries
          : 1 + input.maxRetries,
      };
      return records[key];
    });
  }
  static async update(input) {
    return this.mutate((records) => {
      const key = this.key(input),
        record = records[key];
      if (
        !record ||
        record.runId !== input.runId ||
        record.hostEpoch !== input.hostEpoch
      )
        return;
      if (["preparing", "running", "pausing"].includes(input.state))
        record.state = input.state;
      else delete records[key];
    });
  }
  static async recover({ userId, assertScope, inspect, restart, onExhausted }) {
    if (
      !Number.isSafeInteger(userId) ||
      userId < 1 ||
      [assertScope, inspect, restart, onExhausted].some(
        (fn) => typeof fn !== "function",
      )
    )
      throw new Error("MOTION_RECOVERY_CONFIG_INVALID");
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    return navigator.locks.request(
      "motion-runner-wake",
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return { pending: true };
        await assertScope();
        const records =
          (await chrome.storage.local.get(this.KEY))?.[this.KEY] || {};
        let pending = false;
        const candidates = Object.values(records).filter(
          (item) => item.userId === userId,
        );
        for (const item of candidates) {
          if (
            item.parentBatchId &&
            candidates.some((parent) => parent.batchId === item.parentBatchId)
          )
            continue;
          await assertScope();
          const state = await inspect(item);
          await assertScope();
          if (state?.terminal) {
            await this.update({ ...item, state: "ready" });
            continue;
          }
          if (state?.alive || state?.leaseActive) {
            pending = true;
            continue;
          }
          if (
            !Number.isSafeInteger(item.maxRecoveries) ||
            !Number.isSafeInteger(item.recoveries) ||
            item.recoveries >= item.maxRecoveries
          ) {
            await onExhausted(item);
            await assertScope();
            await this.update({ ...item, state: "needs_review" });
            continue;
          }
          const admitted = await this.mutate((latest) => {
            const current = latest[this.key(item)];
            if (
              !current ||
              current.runId !== item.runId ||
              current.hostEpoch !== item.hostEpoch ||
              current.recoveries !== item.recoveries ||
              current.state !== item.state
            )
              return false;
            current.recoveries++;
            return true;
          });
          if (!admitted) {
            pending = true;
            continue;
          }
          await assertScope();
          try {
            await restart(item, {
              drainOnly: item.state === "pausing" || state?.drainOnly === true,
              unresponsive: state?.unresponsive === true,
            });
          } catch (error) {
            console.warn("[MotionRunnerRecovery]", {
              runId: item.runId,
              code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(error?.message || "")
                ? error.message
                : "MOTION_RUNNER_RECOVERY_FAILED",
            });
          }
          pending = true;
        }
        return { pending };
      },
    );
  }
}
__publicField(MotionRunnerRecovery, "KEY", "tobyflow_motion_recovery_intents");
globalThis.MotionRunnerRecovery = MotionRunnerRecovery;
