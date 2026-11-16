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
(function (root) {
  "use strict";
  const _FlowUuidRefreshCoordinator = class _FlowUuidRefreshCoordinator {
    constructor(storage) {
      this.storage = storage;
      this.records = null;
      this.loading = null;
      this.writes = Promise.resolve();
      this.controlled = new Map();
      this.claims = new Map();
    }
    async _load() {
      if (this.records) return this.records;
      if (!this.loading)
        this.loading = this.storage
          .get(_FlowUuidRefreshCoordinator.KEY)
          .then((data) => {
            this.records = new Map(
              Object.entries(data?.[_FlowUuidRefreshCoordinator.KEY] || {}),
            );
            return this.records;
          })
          .catch((error) => {
            this.loading = null;
            throw error;
          });
      return this.loading;
    }
    _scope(request) {
      const target = request?.expectedFlowTarget,
        process = request?.generationProcessId;
      if (
        typeof process !== "string" ||
        !process ||
        !/^[A-Za-z0-9_.:-]{1,160}$/.test(process) ||
        !Number.isInteger(target?.tabId) ||
        !target.projectId ||
        !target.origin ||
        !target.driverKey
      )
        throw Error("FLOW_REFRESH_SCOPE_REQUIRED");
      return JSON.stringify([
        process,
        target.tabId,
        String(target.projectId).toLowerCase(),
        target.origin,
        target.driverKey,
        target.routePrefix || "",
      ]);
    }
    _write() {
      const persist = () =>
        this.storage.set({
          [_FlowUuidRefreshCoordinator.KEY]: Object.fromEntries(this.records),
        });
      const task = this.writes.catch(() => {}).then(persist);
      this.writes = task;
      return task;
    }
    async register(request) {
      const key = this._scope(request),
        records = await this._load();
      let record = records.get(key),
        created = false;
      if (!record) {
        if (records.size >= 256)
          for (const [scope, entry] of records) {
            if (
              entry.dispatched === false &&
              entry.state === "pending" &&
              !entry.controlledTicket &&
              !this.claims.has(scope)
            )
              records.delete(scope);
            if (records.size < 256) break;
          }
        if (records.size >= 256)
          return { state: "deferred", reason: "record_capacity" };
        created = true;
        record = {
          generationProcessId: request.generationProcessId,
          target: {
            ...request.expectedFlowTarget,
            projectId: String(
              request.expectedFlowTarget.projectId,
            ).toLowerCase(),
          },
          pendingIds: [],
          dispatched: false,
          state: "pending",
          requestId: request.requestId || null,
        };
        records.set(key, record);
      }
      if (record.dispatched) return record;
      const before = record.pendingIds.length;
      const ids = new Set(record.pendingIds);
      for (const id of request.identities || [])
        if (
          typeof id === "string" &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) &&
          ids.size < 256
        )
          ids.add(id.toLowerCase());
      record.pendingIds = [...ids];
      if (created || record.pendingIds.length !== before) await this._write();
      return record;
    }
    _targetKey(target) {
      return JSON.stringify([
        target.tabId,
        String(target.projectId).toLowerCase(),
        target.origin,
        target.driverKey,
        target.routePrefix || "",
      ]);
    }
    async beginControlled(request, ownerDocumentId) {
      if (typeof ownerDocumentId !== "string" || !ownerDocumentId)
        throw Error("FLOW_REFRESH_OWNER_REQUIRED");
      const scope = this._scope(request);
      this.claims.set(scope, (this.claims.get(scope) || 0) + 1);
      try {
        const record = await this.register(request);
        if (record.state === "deferred")
          return { state: "deferred", reason: record.reason };
        if (record.dispatched)
          return {
            state:
              record.state === "finished" ? "finished" : "already_dispatched",
            documentEpoch: record.documentEpoch || null,
          };
        const key = this._targetKey(record.target);
        let flight = this.controlled.get(key),
          state = "joined";
        if (!flight) {
          flight = {
            ticket: crypto.randomUUID(),
            ownerDocumentId,
            records: new Set(),
          };
          this.controlled.set(key, flight);
          state = "owner";
        }
        flight.records.add(record);
        record.dispatched = true;
        record.state = "reserved";
        record.controlledTicket = flight.ticket;
        record.ownerDocumentId = flight.ownerDocumentId;
        await this._write();
        return { state, ticket: flight.ticket };
      } finally {
        const remaining = this.claims.get(scope) - 1;
        if (remaining) this.claims.set(scope, remaining);
        else this.claims.delete(scope);
      }
    }
    async finishControlled(request, ownerDocumentId) {
      const records = await this._load(),
        record = records.get(this._scope(request));
      const flight = this.controlled.get(
        this._targetKey(request.expectedFlowTarget),
      );
      if (
        !record ||
        !flight ||
        request.ticket !== flight.ticket ||
        ownerDocumentId !== flight.ownerDocumentId ||
        record.controlledTicket !== flight.ticket
      )
        throw Error("FLOW_REFRESH_OWNER_CHANGED");
      const epoch =
        typeof request.documentEpoch === "string" && request.documentEpoch
          ? request.documentEpoch
          : null;
      for (const entry of flight.records) {
        entry.dispatched = request.notDispatched !== true;
        entry.state =
          request.notDispatched === true
            ? "pending"
            : epoch
              ? "finished"
              : "unresolved";
        entry.documentEpoch = request.notDispatched === true ? null : epoch;
        delete entry.controlledTicket;
        delete entry.ownerDocumentId;
      }
      this.controlled.delete(this._targetKey(request.expectedFlowTarget));
      await this._write();
      return { state: record.state, documentEpoch: record.documentEpoch };
    }
    async controlledStatus(request) {
      const record = (await this._load()).get(this._scope(request));
      return {
        state: record?.state || "unresolved",
        documentEpoch: record?.documentEpoch || null,
      };
    }
    async observeRefresh(request) {
      const record = await this.register(request);
      if (record.state === "deferred")
        return { state: "deferred", reason: record.reason };
      const flight = this.controlled.get(this._targetKey(record.target));
      if (flight && !record.dispatched)
        await this.beginControlled(request, flight.ownerDocumentId);
      if (record.state === "finished")
        return { state: "finished", documentEpoch: record.documentEpoch };
      return {
        state: record.dispatched ? "pending_controlled" : "deferred",
        reason: record.dispatched ? null : "controlled_owner_required",
      };
    }
  };
  __publicField(
    _FlowUuidRefreshCoordinator,
    "KEY",
    "flow_uuid_gateway_refresh_records_v1",
  );
  let FlowUuidRefreshCoordinator = _FlowUuidRefreshCoordinator;
  root.FlowUuidRefreshCoordinator = FlowUuidRefreshCoordinator;
})(typeof window !== "undefined" ? window : globalThis);
