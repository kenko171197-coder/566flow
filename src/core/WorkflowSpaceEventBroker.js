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
const _WorkflowSpaceEventBroker = class _WorkflowSpaceEventBroker {
  static bytes(packet) {
    return new TextEncoder().encode(JSON.stringify(packet)).byteLength;
  }
  constructor(deps) {
    this.deps = deps;
    this.sessions = new Set();
    this.epoch = crypto.randomUUID();
  }
  accept(port) {
    if (port.name !== _WorkflowSpaceEventBroker.portName) return false;
    const sender = port.sender || {};
    let url;
    try {
      url = new URL(sender.url);
    } catch (_) {
      port.disconnect();
      return true;
    }
    if (
      !["https://local.566flow.invalid", "https://566flow.invalid"].includes(
        url.origin,
      ) ||
      !url.pathname.startsWith("/app/spaces/") ||
      sender.frameId !== 0 ||
      !Number.isInteger(sender.tab?.id) ||
      !sender.documentId ||
      (sender.origin && sender.origin !== url.origin)
    ) {
      port.disconnect();
      return true;
    }
    const session = {
      port,
      sender,
      origin: url.origin,
      closed: false,
      opening: false,
      scope: null,
      sequence: 0,
      ack: 0,
      backlog: [],
      bytes: 0,
      ready: false,
      tail: Promise.resolve(),
      pending: 0,
    };
    this.sessions.add(session);
    const close = () => this.close(session);
    session.onDisconnect = close;
    session.onMessage = (message) => {
      if (session.closed) return;
      if (
        message?.type === "ack" &&
        session.ready &&
        message.connectionId === session.connectionId &&
        Number.isSafeInteger(message.sequence) &&
        message.sequence >= session.ack &&
        message.sequence <= session.sequence
      ) {
        session.ack = message.sequence;
        while (
          session.backlog.length &&
          session.backlog[0].sequence <= session.ack
        ) {
          const entry = session.backlog.shift();
          session.bytes -= entry.bytes;
          this.audit(
            session,
            "acknowledged",
            {
              nodeId: entry.packet.data.nodeId,
              runId: entry.packet.data.runId,
              sourceSequence: entry.packet.data.sequence,
              streamSequence: entry.sequence,
              status: entry.packet.data.patch?.status || null,
              elapsedMs: Math.max(0, Date.now() - entry.sentAt),
              outcome:
                entry.sequence === message.sequence &&
                ["applied", "fenced", "duplicate", "ignored"].includes(
                  message.outcome,
                )
                  ? message.outcome
                  : "received",
            },
            entry.nativeDocumentId,
          );
        }
        return;
      }
      if (message?.type !== "subscribe" || session.scope || session.opening) {
        this.fail(session, "SPACE_EVENTS_PROTOCOL");
        return;
      }
      session.opening = true;
      void this.subscribe(session, message).catch(() =>
        this.fail(session, "SPACE_EVENTS_AUTHORIZATION_FAILED"),
      );
    };
    port.onMessage.addListener(session.onMessage);
    port.onDisconnect.addListener(close);
    session.timer = setTimeout(
      () => this.fail(session, "SPACE_EVENTS_HANDSHAKE_TIMEOUT"),
      25e3,
    );
    return true;
  }
  close(session) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.timer);
    this.sessions.delete(session);
    session.backlog = [];
    session.bytes = 0;
    session.port.onMessage.removeListener(session.onMessage);
    session.port.onDisconnect.removeListener(session.onDisconnect);
    try {
      session.port.disconnect();
    } catch (_) {}
  }
  fail(session, reason) {
    if (session.closed) return;
    try {
      session.port.postMessage({ type: "resync_required", reason });
    } catch (_) {}
    this.close(session);
  }
  revoke() {
    for (const session of [...this.sessions])
      this.fail(session, "SPACE_EVENTS_ACCOUNT_CHANGED");
  }
  stats(scope) {
    const sessions = [...this.sessions].filter(
      (s) =>
        !s.closed &&
        s.expires > Date.now() &&
        s.scope?.workflowId === scope?.workflowId &&
        s.scope?.userId === String(scope?.userId || ""),
    );
    return {
      subscribers: sessions.filter((s) => s.ready).length,
      pending: sessions.filter((s) => !s.ready).length,
    };
  }
  audit(session, stage, info, nativeDocumentId) {
    if (!nativeDocumentId) return;
    try {
      this.deps.audit?.(session.scope, nativeDocumentId, {
        stage,
        connectionId: session.connectionId,
        ...info,
      });
    } catch (_) {}
  }
  async current(session) {
    const auth = await this.deps.readAuth();
    if (
      session.closed ||
      !auth?.token ||
      auth.token !== session.token ||
      String(auth.user?.id || "") !== session.scope?.userId ||
      Date.now() >= session.expires
    )
      throw Error("SPACE_EVENTS_SESSION_EXPIRED");
  }
  async subscribe(session, message) {
    if (
      message.protocol !== 1 ||
      typeof message.workflowId !== "string" ||
      !message.workflowId ||
      message.workflowId.length > 255 ||
      typeof message.userId !== "string" ||
      !message.userId ||
      typeof message.grant !== "string" ||
      message.grant.length > 1e4 ||
      !/^[a-f0-9-]{36}$/i.test(message.sessionId || "")
    )
      throw Error("INVALID_SCOPE");
    if (
      decodeURIComponent(
        new URL(session.sender.url).pathname
          .slice("/app/spaces/".length)
          .replace(/\/$/, ""),
      ) !== message.workflowId
    )
      throw Error("WRONG_DOCUMENT_SCOPE");
    const auth = await this.deps.readAuth();
    if (!auth?.token || String(auth.user?.id || "") !== message.userId)
      throw Error("ACCOUNT_MISMATCH");
    const proof = await this.deps.authorize(message, session.origin, auth);
    if (
      !proof?.success ||
      !Number.isFinite(proof.expires) ||
      proof.expires * 1e3 <= Date.now()
    )
      throw Error("INVALID_PROOF");
    session.scope = { userId: message.userId, workflowId: message.workflowId };
    session.token = auth.token;
    session.expires = proof.expires * 1e3;
    session.connectionId = crypto.randomUUID();
    await this.current(session);
    for (const other of [...this.sessions]) {
      if (
        other !== session &&
        other.sender.documentId === session.sender.documentId &&
        other.sender.tab.id === session.sender.tab.id
      )
        this.close(other);
    }
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => this.fail(session, "SPACE_EVENTS_SESSION_EXPIRED"),
      Math.min(2147483647, session.expires - Date.now()),
    );
    let snapshotTimer;
    const snapshot = await Promise.race([
      this.deps.snapshot(session.scope),
      new Promise((_, reject) => {
        snapshotTimer = setTimeout(
          () => reject(Error("SNAPSHOT_TIMEOUT")),
          1e4,
        );
      }),
    ]).finally(() => clearTimeout(snapshotTimer));
    await this.current(session);
    if (session.closed) return;
    const packet = {
      type: "snapshot",
      protocol: 1,
      connectionId: session.connectionId,
      streamEpoch: this.epoch,
      ...session.scope,
      snapshot,
      sequence: 0,
      expires: session.expires,
    };
    if (
      _WorkflowSpaceEventBroker.bytes(packet) >
      _WorkflowSpaceEventBroker.maxBytes
    ) {
      this.fail(session, "SPACE_EVENTS_SNAPSHOT_BUDGET");
      return;
    }
    session.port.postMessage(packet);
    session.ready = true;
    this.audit(
      session,
      "snapshot",
      { sourceSequence: snapshot.sequence || null },
      snapshot.owner,
    );
    for (const entry of session.backlog) session.port.postMessage(entry.packet);
  }
  publish(event, data, nativeDocumentId = null) {
    if (
      event !== "space:node_result" ||
      !data ||
      typeof data.workflowId !== "string" ||
      !data.userId
    )
      return;
    for (const session of this.sessions) {
      if (
        !session.scope ||
        session.scope.workflowId !== data.workflowId ||
        session.scope.userId !== String(data.userId)
      )
        continue;
      if (++session.pending > _WorkflowSpaceEventBroker.maxEvents) {
        this.fail(session, "SPACE_EVENTS_OVERFLOW");
        continue;
      }
      session.tail = session.tail
        .then(async () => {
          if (session.closed) return;
          await this.current(session);
          const packet = {
            type: "event",
            protocol: 1,
            connectionId: session.connectionId,
            streamEpoch: this.epoch,
            ...session.scope,
            sequence: ++session.sequence,
            eventId: crypto.randomUUID(),
            event,
            data,
          };
          const bytes = _WorkflowSpaceEventBroker.bytes(packet);
          if (
            session.backlog.length >= _WorkflowSpaceEventBroker.maxEvents ||
            session.bytes + bytes > _WorkflowSpaceEventBroker.maxBytes
          ) {
            this.fail(session, "SPACE_EVENTS_OVERFLOW");
            return;
          }
          session.backlog.push({
            packet,
            bytes,
            sequence: packet.sequence,
            nativeDocumentId,
            sentAt: Date.now(),
          });
          session.bytes += bytes;
          if (session.ready) session.port.postMessage(packet);
        })
        .catch(() => this.fail(session, "SPACE_EVENTS_SESSION_UNAVAILABLE"))
        .finally(() => {
          session.pending--;
        });
    }
  }
};
__publicField(
  _WorkflowSpaceEventBroker,
  "portName",
  "tobyflow.space.events.v1",
);
__publicField(_WorkflowSpaceEventBroker, "maxEvents", 256);
__publicField(_WorkflowSpaceEventBroker, "maxBytes", 1024 * 1024);
let WorkflowSpaceEventBroker = _WorkflowSpaceEventBroker;
