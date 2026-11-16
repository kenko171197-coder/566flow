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
const _WorkflowSpaceCommands = class _WorkflowSpaceCommands {
  constructor(deps) {
    this.deps = deps;
    this.tail = Promise.resolve();
    this.pending = 0;
  }
  serial(task, cleanup = false) {
    if (this.pending >= 64 && !cleanup)
      return Promise.reject(Error("SPACE_COMMAND_BUSY"));
    this.pending++;
    const next = this.tail.then(task, task);
    this.tail = next.catch(() => {});
    return next.finally(() => {
      this.pending--;
    });
  }
  async actor(message, sender) {
    let url, routeWorkflowId;
    try {
      url = new URL(sender.url);
      const route = url.pathname.match(/^\/app\/spaces\/([^/]+)\/?$/);
      routeWorkflowId = route ? decodeURIComponent(route[1]) : null;
    } catch (_) {
      throw Error("SPACE_COMMAND_SCOPE");
    }
    if (
      !["https://local.566flow.invalid", "https://566flow.invalid"].includes(
        url.origin,
      ) ||
      (sender.origin && sender.origin !== url.origin) ||
      sender.frameId !== 0 ||
      !sender.documentId ||
      !Number.isInteger(sender.tab?.id) ||
      typeof message.workflowId !== "string" ||
      !message.workflowId ||
      message.workflowId.length > 255 ||
      routeWorkflowId !== message.workflowId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        message.operationId || "",
      )
    )
      throw Error("SPACE_COMMAND_SCOPE");
    const auth = (await this.deps.storage.get("af_auth")).af_auth;
    if (
      !auth?.token ||
      !auth.user?.id ||
      String(message.userId) !== String(auth.user.id)
    )
      throw Error("ACCOUNT_SCOPE_CHANGED");
    return {
      userId: String(auth.user.id),
      workflowId: message.workflowId,
      origin: url.origin,
      token: auth.token,
    };
  }
  async current(actor, requireSameToken = true) {
    const auth = (await this.deps.storage.get("af_auth")).af_auth;
    if (
      !auth?.token ||
      (requireSameToken && auth.token !== actor.token) ||
      String(auth?.user?.id || "") !== actor.userId
    )
      throw Error("ACCOUNT_SCOPE_CHANGED");
  }
  async signature(message) {
    if (
      !["runWorkflow", "runNode", "stopWorkflow", "stopNode"].includes(
        message.type,
      )
    )
      throw Error("SPACE_COMMAND_TYPE");
    const target = (value) => {
      if (typeof value !== "string" || !value || value.length > 255)
        throw Error("SPACE_COMMAND_TARGET");
      return value;
    };
    const nodeId = ["runNode", "stopNode"].includes(message.type)
      ? target(message.nodeId)
      : null;
    const onlyNodeIds =
      message.onlyNodeIds == null
        ? null
        : Array.isArray(message.onlyNodeIds)
          ? message.onlyNodeIds.map(target)
          : null;
    if (
      (message.onlyNodeIds != null && !Array.isArray(message.onlyNodeIds)) ||
      JSON.stringify(onlyNodeIds).length > 64e3
    )
      throw Error("SPACE_COMMAND_TARGET");
    if (!Number.isSafeInteger(message.commandCreatedAt))
      throw Error("SPACE_COMMAND_EXPIRED");
    let groupResetDigest = null;
    if (message.groupReset) {
      const proof = message.groupReset;
      if (
        message.type !== "runWorkflow" ||
        !onlyNodeIds?.length ||
        typeof proof.operationId !== "string" ||
        typeof proof.grant !== "string" ||
        proof.grant.length > 1e5 ||
        !Array.isArray(proof.nodeIds)
      )
        throw Error("SPACE_COMMAND_TARGET");
      const bytes = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([proof.operationId, proof.nodeIds, proof.grant]),
        ),
      );
      groupResetDigest = Array.from(new Uint8Array(bytes), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
    }
    return JSON.stringify([
      message.type,
      message.workflowId,
      nodeId,
      message.manualSubmitMode === true,
      onlyNodeIds,
      message.force === true,
      message.commandCreatedAt,
      ...(groupResetDigest ? [groupResetDigest] : []),
    ]);
  }
  async read(userId) {
    const raw = (await this.deps.storage.get(_WorkflowSpaceCommands.key))[
      _WorkflowSpaceCommands.key
    ];
    const rows = Array.isArray(raw)
      ? raw.filter(
          (row) =>
            row &&
            row.userId === userId &&
            Number.isSafeInteger(row.createdAt) &&
            row.createdAt >= Date.now() - _WorkflowSpaceCommands.retentionMs,
        )
      : [];
    return rows.slice(-_WorkflowSpaceCommands.maxEntries);
  }
  unknown(id, stage = "unknown") {
    return {
      ok: false,
      error: "BRIDGE_RESULT_UNKNOWN",
      dispatchStarted: true,
      operationId: id,
      commandStage: stage,
    };
  }
  receipt(row) {
    return row.response
      ? {
          ...row.response,
          operationId: row.operationId,
          commandStage: row.stage,
        }
      : this.unknown(row.operationId, row.stage);
  }
  async handle(message, sender, dispatch) {
    const actor = await this.actor(message, sender),
      signature = await this.signature(message);
    const claim = await this.serial(async () => {
      await this.current(actor);
      const rows = await this.read(actor.userId);
      const row = rows.find(
        (item) =>
          item.operationId === message.operationId &&
          item.userId === actor.userId,
      );
      if (row) {
        if (
          row.workflowId !== actor.workflowId ||
          row.origin !== actor.origin ||
          row.signature !== signature
        )
          throw Error("SPACE_COMMAND_CONFLICT");
        return { receipt: this.receipt(row) };
      }
      if (
        Date.now() - message.commandCreatedAt > 12e4 ||
        message.commandCreatedAt > Date.now() + 1e4
      )
        throw Error("SPACE_COMMAND_EXPIRED");
      if (rows.length >= _WorkflowSpaceCommands.maxEntries)
        throw Error("SPACE_COMMAND_JOURNAL_FULL");
      let targetRunId = null,
        targetJobId = null;
      if (message.type.startsWith("stop")) {
        const flag = (await this.deps.storage.get("af_running_workflow"))
          .af_running_workflow;
        if (
          flag?.wf_id !== actor.workflowId ||
          String(flag.owner_user_id || "") !== actor.userId ||
          !flag.run_id
        )
          throw Error("WORKFLOW_NOT_RUNNING");
        targetRunId = flag.run_id;
        if (message.type === "stopNode") {
          targetJobId = flag.single_node_states?.find(
            (node) => String(node.nodeId) === message.nodeId,
          )?.jobId;
          if (typeof targetJobId !== "string" || !targetJobId)
            throw Error("SINGLE_NODE_SESSION_NOT_FOUND");
        }
      }
      const entry = {
        operationId: message.operationId,
        userId: actor.userId,
        workflowId: actor.workflowId,
        origin: actor.origin,
        signature,
        type: message.type,
        createdAt: Date.now(),
        stage: "dispatching",
        targetRunId,
        targetJobId,
      };
      rows.push(entry);
      if (
        new TextEncoder().encode(JSON.stringify(rows)).byteLength >
        _WorkflowSpaceCommands.maxBytes
      )
        throw Error("SPACE_COMMAND_JOURNAL_FULL");
      await this.current(actor);
      await this.deps.storage.set({ [_WorkflowSpaceCommands.key]: rows });
      await this.current(actor);
      return { entry };
    });
    if (claim.receipt) {
      await this.current(actor);
      return claim.receipt;
    }
    try {
      await this.current(actor);
      const response = await dispatch(
        claim.entry.targetRunId,
        claim.entry.targetJobId,
      );
      const rejected =
        response?.ok === false &&
        (response.dispatchStarted === false ||
          [
            "BUSY",
            "RUN_WINDOW_OPENING",
            "NO_WORKFLOW_ID",
            "NO_NODE_ID",
            "ACCOUNT_SCOPE_CHANGED",
            "SINGLE_NODE_SESSION_NOT_FOUND",
            "WORKFLOW_NOT_RUNNING",
            "SPACE_COMMAND_TARGET_CHANGED",
          ].includes(response.error));
      const stage =
        response?.accepted === true || response?.ok === true
          ? "acknowledged"
          : rejected
            ? "rejected"
            : "unknown";
      await this.serial(async () => {
        await this.current(actor, false);
        const rows = await this.read(actor.userId);
        const entry = rows.find(
          (row) =>
            row.operationId === message.operationId &&
            row.userId === actor.userId,
        );
        if (!entry) return;
        entry.stage = stage;
        entry.response =
          stage === "unknown"
            ? this.unknown(message.operationId)
            : {
                ...Object.fromEntries(
                  ["ok", "accepted", "dispatchStarted"]
                    .filter((key) => typeof response?.[key] === "boolean")
                    .map((key) => [key, response[key]]),
                ),
                ...Object.fromEntries(
                  ["error", "execution_mode", "runId", "wf_id"]
                    .filter(
                      (key) =>
                        typeof response?.[key] === "string" &&
                        /^[A-Za-z0-9_:-]{1,255}$/.test(response[key]),
                    )
                    .map((key) => [key, response[key]]),
                ),
              };
        await this.current(actor, false);
        await this.deps.storage.set({ [_WorkflowSpaceCommands.key]: rows });
        await this.current(actor, false);
      });
      return stage === "unknown"
        ? this.unknown(message.operationId)
        : {
            ...response,
            operationId: message.operationId,
            commandStage: stage,
          };
    } catch (_) {
      return this.unknown(message.operationId);
    }
  }
  async status(message, sender) {
    const actor = await this.actor(message, sender);
    return this.serial(async () => {
      await this.current(actor);
      const rows = await this.read(actor.userId);
      const row = rows.find(
        (item) =>
          item.operationId === message.operationId &&
          item.userId === actor.userId,
      );
      if (
        !row ||
        row.workflowId !== actor.workflowId ||
        row.origin !== actor.origin
      )
        return this.unknown(message.operationId);
      await this.current(actor);
      return this.receipt(row);
    });
  }
  purgeUser(userId) {
    return this.serial(async () => {
      const raw = (await this.deps.storage.get(_WorkflowSpaceCommands.key))[
        _WorkflowSpaceCommands.key
      ];
      if (Array.isArray(raw))
        await this.deps.storage.set({
          [_WorkflowSpaceCommands.key]: raw.filter(
            (row) => row?.userId !== String(userId),
          ),
        });
    }, true);
  }
};
__publicField(_WorkflowSpaceCommands, "key", "workflow_space_commands_v1");
__publicField(_WorkflowSpaceCommands, "retentionMs", 24 * 60 * 60 * 1e3);
__publicField(_WorkflowSpaceCommands, "maxEntries", 512);
__publicField(_WorkflowSpaceCommands, "maxBytes", 1024 * 1024);
let WorkflowSpaceCommands = _WorkflowSpaceCommands;
globalThis.WorkflowSpaceCommands = WorkflowSpaceCommands;
