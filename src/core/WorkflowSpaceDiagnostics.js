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
const _WorkflowSpaceDiagnostics = class _WorkflowSpaceDiagnostics {
  constructor(deps) {
    this.deps = deps;
    this.tail = Promise.resolve();
    this.contextId = crypto.randomUUID();
    this.startedAt = Date.now();
    this.sequence = 0;
    this.pending = 0;
  }
  enqueue(task, cleanup = false) {
    if (this.pending >= 64 && !cleanup)
      return Promise.reject(Error("SPACE_DIAGNOSTIC_BUSY"));
    this.pending++;
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next.finally(() => {
      this.pending--;
    });
  }
  async scope(message, sender) {
    let url;
    try {
      url = new URL(sender.url);
    } catch (_) {
      throw Error("SPACE_DIAGNOSTIC_SCOPE");
    }
    const schema = WorkflowSpaceDiagnosticSchema;
    if (
      !["https://local.566flow.invalid", "https://566flow.invalid"].includes(
        url.origin,
      ) ||
      (sender.origin && sender.origin !== url.origin) ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      !Number.isInteger(sender.tab?.id) ||
      !schema.identifier(message.workflowId) ||
      url.pathname.replace(/\/$/, "") !== `/app/spaces/${message.workflowId}`
    )
      throw Error("SPACE_DIAGNOSTIC_SCOPE");
    const auth = (await this.deps.storage.get("af_auth")).af_auth;
    if (
      !auth?.token ||
      String(auth.user?.id || "") !== String(message.userId || "")
    )
      throw Error("ACCOUNT_SCOPE_CHANGED");
    return {
      userId: String(auth.user.id),
      workflowId: message.workflowId,
      token: auth.token,
    };
  }
  async current(scope) {
    const auth = (await this.deps.storage.get("af_auth")).af_auth;
    if (
      auth?.token !== scope.token ||
      String(auth?.user?.id || "") !== scope.userId
    )
      throw Error("ACCOUNT_SCOPE_CHANGED");
  }
  async readStore(scope) {
    const schema = WorkflowSpaceDiagnosticSchema;
    const stored = (await this.deps.storage.get(_WorkflowSpaceDiagnostics.key))[
      _WorkflowSpaceDiagnostics.key
    ];
    const store = { ownerUserId: scope.userId, workflows: Object.create(null) };
    if (
      stored?.ownerUserId !== scope.userId ||
      !stored.workflows ||
      typeof stored.workflows !== "object"
    )
      return store;
    const keys = Object.keys(stored.workflows)
      .filter((key) => schema.identifier(key))
      .sort(
        (a, b) =>
          (stored.workflows[b]?.updatedAt || 0) -
          (stored.workflows[a]?.updatedAt || 0),
      )
      .slice(0, 3);
    for (const key of keys) {
      const entry = stored.workflows[key];
      if (
        !Array.isArray(entry?.events) ||
        !Number.isSafeInteger(entry.updatedAt) ||
        entry.updatedAt < Date.now() - schema.retentionMs
      )
        continue;
      const bounded = schema.bounded(entry.events.slice(-schema.maxEvents));
      store.workflows[key] = {
        events: bounded.events,
        updatedAt: entry.updatedAt,
        dropped: Math.min(
          1e9,
          bounded.dropped +
            (Number.isSafeInteger(entry.dropped) && entry.dropped >= 0
              ? entry.dropped
              : 0),
        ),
      };
    }
    return store;
  }
  async handle(message, sender) {
    const scope = await this.scope(message, sender);
    if (message.operation === "probe") {
      const probe = await this.deps.probe();
      await this.current(scope);
      return { ok: true, probe };
    }
    if (!["append", "read", "clear"].includes(message.operation))
      throw Error("SPACE_DIAGNOSTIC_OPERATION");
    return this.enqueue(async () => {
      await this.current(scope);
      const schema = WorkflowSpaceDiagnosticSchema;
      const store = await this.readStore(scope);
      const entry = store.workflows[scope.workflowId] || {
        events: [],
        dropped: 0,
      };
      let result;
      if (message.operation === "clear")
        delete store.workflows[scope.workflowId];
      else {
        if (
          message.operation === "append" &&
          (!Array.isArray(message.events) || message.events.length > 64)
        )
          throw Error("SPACE_DIAGNOSTIC_BATCH");
        const incoming =
          message.operation === "append"
            ? message.events
                .map((event) =>
                  event &&
                  typeof event === "object" &&
                  Object.keys(event).length <= 32
                    ? schema.sanitize({ ...event, source: "web" })
                    : null,
                )
                .filter(Boolean)
            : [];
        const bounded = schema.bounded([...entry.events, ...incoming]);
        result = store.workflows[scope.workflowId] = {
          updatedAt: Date.now(),
          events: bounded.events,
          dropped: Math.min(1e9, (entry.dropped || 0) + bounded.dropped),
        };
      }
      const keys = Object.keys(store.workflows).sort(
        (a, b) => store.workflows[b].updatedAt - store.workflows[a].updatedAt,
      );
      for (const key of keys.slice(3)) delete store.workflows[key];
      await this.current(scope);
      await this.deps.storage.set({ [_WorkflowSpaceDiagnostics.key]: store });
      await this.current(scope);
      return {
        ok: true,
        revision: schema.revision,
        version: this.deps.version(),
        ...(message.operation === "read" ? { report: result } : {}),
      };
    });
  }
  observeRpc(message, sender, stage, receipt) {
    const trace = message?._spaceDiagnostic;
    if (!trace || message.type === "workflowSpaceDiagnostics") return;
    void this.scope(trace, sender)
      .then((scope) =>
        this.enqueue(async () => {
          await this.current(scope);
          const schema = WorkflowSpaceDiagnosticSchema;
          const event = schema.sanitize({
            ...trace,
            source: "background",
            contextId: this.contextId,
            sourceSequence: ++this.sequence,
            stage,
            command: message.type,
            utcMs: Date.now(),
            elapsedMs: Math.max(0, Date.now() - this.startedAt),
            ok: receipt?.ok,
            accepted: receipt?.accepted,
            code: receipt?.error,
            dispatchStarted: receipt?.dispatchStarted,
          });
          if (!event) return;
          const store = await this.readStore(scope);
          const entry = store.workflows[scope.workflowId] || {
            events: [],
            dropped: 0,
          };
          const bounded = schema.bounded([...entry.events, event]);
          store.workflows[scope.workflowId] = {
            events: bounded.events,
            dropped: Math.min(1e9, (entry.dropped || 0) + bounded.dropped),
            updatedAt: Date.now(),
          };
          for (const key of Object.keys(store.workflows)
            .sort(
              (a, b) =>
                store.workflows[b].updatedAt - store.workflows[a].updatedAt,
            )
            .slice(3))
            delete store.workflows[key];
          await this.current(scope);
          await this.deps.storage.set({
            [_WorkflowSpaceDiagnostics.key]: store,
          });
          await this.current(scope);
        }),
      )
      .catch(() => {});
  }
  purgeUser(userId) {
    return this.enqueue(async () => {
      const stored = (
        await this.deps.storage.get(_WorkflowSpaceDiagnostics.key)
      )[_WorkflowSpaceDiagnostics.key];
      if (stored?.ownerUserId === String(userId))
        await this.deps.storage.remove(_WorkflowSpaceDiagnostics.key);
    }, true);
  }
};
__publicField(
  _WorkflowSpaceDiagnostics,
  "key",
  "workflow_space_diagnostics_v1",
);
let WorkflowSpaceDiagnostics = _WorkflowSpaceDiagnostics;
globalThis.WorkflowSpaceDiagnostics = WorkflowSpaceDiagnostics;
