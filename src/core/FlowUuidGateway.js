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
  const LOCAL_MERGE_PREFIX = "workflow_merge_";
  const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const isUuid = (value) => typeof value === "string" && UUID.test(value);
  const key = (value) =>
    isUuid(value) ? value.toLowerCase() : String(value || "");
  const abort = (context) => {
    if (context.signal?.aborted || context.abortFn?.())
      throw Object.assign(new Error("Aborted"), {
        name: "AbortError",
        code: "ABORTED",
        noRetry: true,
      });
  };
  const _FlowUuidGateway = class _FlowUuidGateway {
    static _fingerprint(value) {
      if (value == null || value === "") return null;
      let hash = 2166136261;
      const text = this._traceSalt + String(value);
      for (let i = 0; i < text.length; i++)
        hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
      return "id_" + (hash >>> 0).toString(16).padStart(8, "0");
    }
    static _diagnostic(context, event, fields = {}) {
      try {
        const trace = context._uuidTrace;
        if (
          !trace ||
          (trace.count >= 96 && !["finish", "error"].includes(event))
        ) {
          if (trace) trace.omitted++;
          return;
        }
        trace.count++;
        console.info(
          "[flow_uuid_gateway]",
          JSON.stringify({
            traceId: trace.id,
            event,
            elapsedMs: Date.now() - trace.started,
            operation: context._uuidOperation,
            operationId: this._fingerprint(context.operationId),
            generationProcessId: this._fingerprint(context.generationProcessId),
            projectId: this._fingerprint(
              context.expectedFlowTarget?.projectId || context.projectId,
            ),
            surface: [
              "gen",
              "prompts",
              "workflow",
              "motion",
              "task",
              "tasks",
              "batch",
              "tracker",
              "picker",
              "flow_images",
            ].includes(context.surface)
              ? context.surface
              : "other",
            purpose: [
              "reference",
              "download",
              "preview",
              "rescan",
              "existence",
            ].includes(context.purpose)
              ? context.purpose
              : null,
            ...fields,
          }),
        );
      } catch (_) {}
    }
    static _diagnosticCode(value) {
      return typeof value === "string" &&
        /^(?:[A-Z][A-Z0-9_]{1,79}|[a-z]+(?:_[a-z]+){0,10})$/.test(value) &&
        !this.isAsb(value)
        ? value
        : "unclassified";
    }
    static _schemaTransitionDiagnostic(value) {
      if (!value || typeof value !== "object") return null;
      const count = (number) =>
        Number.isSafeInteger(number) && number >= 0 ? number : 0;
      return {
        reason: this._diagnosticCode(value.reason),
        source: this._diagnosticCode(value.source),
        changedFields: (Array.isArray(value.changedFields)
          ? value.changedFields
          : []
        )
          .filter((field) =>
            [
              "version",
              "enabled",
              "collection_path",
              "uuid_path",
              "project_path",
              "generation_path",
              "details_path",
              "media_types",
            ].includes(field),
          )
          .slice(0, 8),
        ...Object.fromEntries(
          [
            "aliasesBefore",
            "uuidEvidenceBefore",
            "replayResponses",
            "replayRows",
            "aliasesAfter",
            "uuidEvidenceAfter",
          ].map((field) => [field, count(value[field])]),
        ),
      };
    }
    static async _traceOperation(operation, context, work) {
      const trace = context._uuidTrace || {
        id:
          "uuid_" +
          this._traceSalt.slice(0, 5) +
          "_" +
          Date.now().toString(36) +
          "_" +
          ++this._traceSequence,
        started: Date.now(),
        count: 0,
        omitted: 0,
      };
      const scoped = {
        ...context,
        _uuidTrace: trace,
        _uuidOperation: operation,
      };
      this._diagnostic(scoped, "start");
      try {
        const result = await work(scoped);
        this._diagnostic(scoped, "finish", {
          failed: result?.failed?.length || 0,
          unresolved: result?.unresolved?.length || 0,
          omittedEvents: trace.omitted,
        });
        return result;
      } catch (error) {
        this._diagnostic(scoped, "error", {
          code: this._diagnosticCode(error?.code || error?.name),
          ...(error?.code === "FLOW_MEDIA_LOOKUP_SCOPE_CHANGED" && {
            invalidationReason: this._lastInvalidationReason || "explicit",
            scopeEpoch: this._epoch,
          }),
        });
        throw error;
      }
    }
    static observeProviderMetadata(
      records,
      context = {},
      { requested = 0, sameOwner = false } = {},
    ) {
      try {
        const scoped = {
          ...context,
          _uuidOperation: "providerMetadata",
          _uuidTrace: {
            id:
              "uuid_" +
              this._traceSalt.slice(0, 5) +
              "_" +
              Date.now().toString(36) +
              "_" +
              ++this._traceSequence,
            started: Date.now(),
            count: 0,
            omitted: 0,
          },
        };
        this._diagnostic(scoped, "provider_metadata_summary", {
          requested,
          adopted: records.length,
          sameOwner,
          omittedIdentities: Math.max(0, records.length - 16),
        });
        for (const record of records.slice(0, 16))
          this._diagnostic(scoped, "provider_metadata", {
            identity: this._fingerprint(this.identity(record)),
            hasUuid: isUuid(this.identity(record)),
            hasAsb:
              this.isAsb(record.asb) || this.isAsb(record.persistent_media_id),
            hasThumbnail: !!record.thumbnail,
            hasImage: !!record.image_url,
            hasPlayback: !!record.video_url,
          });
      } catch (_) {}
    }
    static observeMetadataUpdate(previous, current, context = {}) {
      try {
        const asb = (record) =>
          [
            record?.asb,
            record?.persistent_media_id,
            record?.file_name,
            this.asbIdentityFromUrl(record?.video_url),
            this.asbIdentityFromUrl(record?.thumbnail),
          ].find((value) => this.isAsb(value));
        const oldAsb = asb(previous),
          newAsb = asb(current);
        const scoped = {
          ...context,
          _uuidOperation: "metadataUpdate",
          _uuidTrace: {
            id:
              "uuid_" +
              this._traceSalt.slice(0, 5) +
              "_" +
              Date.now().toString(36) +
              "_" +
              ++this._traceSequence,
            started: Date.now(),
            count: 0,
            omitted: 0,
          },
        };
        this._diagnostic(scoped, "metadata_applied", {
          identity: this._fingerprint(this.identity(current)),
          previousIdentity: this._fingerprint(this.identity(previous)),
          previousAsb: this._fingerprint(oldAsb),
          currentAsb: this._fingerprint(newAsb),
          asbChanged: !!newAsb && oldAsb !== newAsb,
          thumbnailChanged: previous?.thumbnail !== current?.thumbnail,
          playbackChanged: previous?.video_url !== current?.video_url,
          hasThumbnail: !!current?.thumbnail,
          hasPlayback: !!current?.video_url,
        });
      } catch (_) {}
    }
    static async noteApiStop(job) {
      const pending = (job?.items || []).filter(
        (item) =>
          item._flowProviderSettled !== true &&
          (item.flowApiAccepted === true ||
            item._apiDispatchStarted === true) &&
          !(
            item.outputs?.length >=
              Math.max(1, Number(item.settings?.quantity) || 1) &&
            item.outputs.every((output) => output.status === "completed")
          ),
      );
      if (!pending.length) return;
      const operations = [];
      let unknown = false;
      for (const item of pending) {
        const edges = (item.flowApiLineage || []).filter((edge) =>
          isUuid(edge.operationId),
        );
        if (
          item.flowApiDriver !== "v2" ||
          edges.length < Math.max(1, Number(item.settings?.quantity) || 1)
        )
          unknown = true;
        for (const edge of edges)
          operations.push({
            operationId: edge.operationId,
            projectId: item.projectId || job.projectId,
            mediaType: /video/i.test(item.settings?.genType || "")
              ? "video"
              : "image",
            protocolRevision: item.flowApiProtocolRevision,
            protocolFingerprint: item.flowApiProtocolFingerprint,
          });
      }
      const projects = [
        ...new Set(
          pending.map((item) => item.projectId || job.projectId).filter(isUuid),
        ),
      ];
      const result = await root.chrome.runtime.sendMessage({
        action: "flowUuidApiStop",
        jobId: job.id,
        projects: projects.length ? projects : ["unknown"],
        operations,
        unknown,
      });
      if (result?.ok !== true)
        throw this.error("FLOW_STOP_SAFETY_NOT_PERSISTED");
    }
    static refreshContextState(request = {}) {
      const queue = root.PromptQueue?._instance,
        own =
          this._refreshOwner?.generationProcessId ===
          request.generationProcessId;
      const busy = (reason) => ({ safe: false, reason });
      if (
        root.ImmediateUploader?._pendingCount > 0 ||
        root.ImmediateUploader?._uploading?.size > 0 ||
        root.MessageBridge?._uploadControls?.size > 0
      )
        return busy("upload_active");
      if (root.FlowApiAdapter?.hasInFlight?.()) return busy("api_active");
      if (
        root.MotionRunnerHost?._runs?.size > 0 &&
        (!own || root.MotionRunnerHost._runs.size > 1)
      )
        return busy("motion_active");
      if (
        root.workflowExecutor?.isRunning &&
        (!own ||
          root.workflowExecutor._flowRunId !== request.generationProcessId)
      )
        return busy("workflow_active");
      if (queue) {
        for (const job of queue._jobs?.values?.() || [])
          for (const item2 of job.items || []) {
            const provenStop =
              job.state === "stopped" &&
              request.settledApiJobs?.includes(job.id);
            if (
              !provenStop &&
              item2._flowProviderSettled !== true &&
              (item2.flowApiAccepted || item2._apiDispatchStarted) &&
              !(
                item2.outputs?.length >=
                  Math.max(1, Number(item2.settings?.quantity) || 1) &&
                item2.outputs.every((output) => output.status === "completed")
              )
            )
              return busy("unsettled_api_receipt");
          }
        if (
          queue._tileMonitor?.activeCount > 0 ||
          queue._editorExecutor?.isDownloading ||
          queue._downloadQueue?.length
        )
          return busy("monitor_or_download_active");
        if (queue._itemQueue?.length > 0 && !own)
          return busy("queued_editor_work");
        if (
          queue._webRecovery?.blocked ||
          queue._webRecovery?.storageError ||
          queue.hasAcceptedV2Operation?.({}) === true
        )
          return busy("recovery_or_receipt_active");
        if (queue._forceReloadPromise && !own)
          return busy("other_reload_active");
        const item = queue._editorExecutor?.currentItem;
        if (item) {
          const job = queue.getJob?.(item.jobId);
          if (
            !own ||
            item.id !== this._refreshOwner?.editorItemId ||
            job?.generationProcessId !== request.generationProcessId ||
            item.flowApiAccepted ||
            item._apiDispatchStarted ||
            item._phaseR?.dispatched ||
            !["PENDING", "RETRY_SUBMIT", "SUBMITTING"].includes(item.state)
          )
            return busy("editor_active");
        }
        for (const record of queue._webRecovery?.records?.values?.() || []) {
          if (
            record.outputs?.some((output) =>
              ["dispatched", "retry_queued", "captcha_held"].includes(
                output.state,
              ),
            )
          )
            return busy("unsettled_web_receipt");
        }
      }
      return { safe: true };
    }
    static _sameAuthScope(previous, current) {
      if (
        typeof previous?.token !== "string" ||
        !previous.token ||
        typeof current?.token !== "string" ||
        !current.token ||
        previous?.user?.id == null ||
        current?.user?.id == null ||
        typeof previous?.apiBaseUrl !== "string" ||
        !previous.apiBaseUrl ||
        typeof current?.apiBaseUrl !== "string" ||
        !current.apiBaseUrl
      )
        return false;
      return (
        previous.token === current.token &&
        String(previous.user.id) === String(current.user.id) &&
        previous.apiBaseUrl === current.apiBaseUrl
      );
    }
    static _sameAccessScope(previous, current) {
      if (
        previous?.contract !== "device-v1" ||
        current?.contract !== "device-v1" ||
        ![previous, current].every(
          (value) =>
            Number.isFinite(value.authorization_ttl_sec) &&
            value.authorization_ttl_sec > 0,
        )
      )
        return false;
      const fields = (value) =>
        Object.keys(value).filter(
          (field) =>
            !["authorized_at", "authorization_ttl_sec"].includes(field),
        );
      const before = fields(previous),
        after = fields(current);
      return (
        before.length === after.length &&
        before.every(
          (field) =>
            Object.hasOwn(current, field) && previous[field] === current[field],
        )
      );
    }
    static invalidate(reason = "explicit") {
      this._epoch++;
      this._lastInvalidationReason = this._diagnosticCode(reason);
      if (root.dispatchEvent && typeof CustomEvent !== "undefined")
        root.dispatchEvent(new CustomEvent("TOBY_FLOW_DOCUMENT_ACTIVITY"));
    }
    static isAsb(value) {
      return (
        typeof value === "string" &&
        !value.startsWith("upload_") &&
        !value.startsWith(LOCAL_MERGE_PREFIX) &&
        !isUuid(value) &&
        /^[A-Za-z0-9_-]{32,1024}$/.test(value)
      );
    }
    static mediaUuidFromUrl(value) {
      try {
        const url = new URL(value);
        const pattern =
          url.origin === "https://flow-content.google"
            ? /^\/(?:image|video)\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
            : url.origin === "https://storage.googleapis.com"
              ? /^\/ai-sandbox-videofx\/image\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i
              : null;
        return pattern?.exec(url.pathname)?.[1]?.toLowerCase() || null;
      } catch (_) {
        return null;
      }
    }
    static imageIdentityMetadata(uuid, ownedImageUrl) {
      const asb = this.asbIdentityFromUrl(ownedImageUrl);
      if (!isUuid(uuid) || !asb) return {};
      uuid = uuid.toLowerCase();
      return {
        media_uuid: uuid,
        asb,
        persistent_media_id: asb,
        file_name: asb,
        identity_kind: "flow-v2-asb",
        identity_durability: "durable",
        identity_aliases: [uuid, asb],
      };
    }
    static identity(record, fallback = null) {
      return (
        [
          record?.media_uuid,
          record?.mediaUuid,
          record?.provider_data?.media_uuid,
          record?.file_name,
          record?.persistent_media_id,
          record?.file_id,
          record?.id,
          fallback,
        ].find(isUuid) || fallback
      );
    }
    static error(code = "FLOW_MEDIA_UUID_NOT_FOUND") {
      return Object.assign(new Error(code), {
        code,
        noRetry: true,
        retryable: false,
      });
    }
    static downloadSucceeded(response) {
      if (
        response?.success !== true &&
        (response?.code || response?.error) === "FLOW_MEDIA_UUID_NOT_FOUND"
      )
        throw this.error();
      return response === true || response?.success === true;
    }
    static formatErrorSync(error) {
      const code = String(error?.code || error?.message || error || "");
      if (code !== "FLOW_MEDIA_UUID_NOT_FOUND") return code;
      const translated = root.I18n?.t?.(this._notFoundKey);
      return translated && translated !== this._notFoundKey ? translated : code;
    }
    static async formatError(error) {
      const code = String(error?.code || error?.message || error || "");
      const translated = this.formatErrorSync(error);
      if (translated !== code || code !== "FLOW_MEDIA_UUID_NOT_FOUND")
        return translated;
      const key2 = this._notFoundKey;
      try {
        const saved = await root.chrome?.storage?.local?.get?.([
          "af_locale",
          "af_settings",
        ]);
        const locale = saved?.af_locale || saved?.af_settings?.language;
        if (locale) {
          const name = "toby_i18n_" + locale;
          const dictionary = await root.chrome.storage.local.get([name]);
          const text = dictionary?.[name]?.data?.[key2];
          if (typeof text === "string" && text) return text;
        }
      } catch (_) {}
      return code;
    }
    static _unknown(uuid, reason) {
      return { ok: false, status: "unresolved", uuid, reason, metadata: null };
    }
    static refFileNamesMatch(expected, observed, tileId, ...records) {
      if (!expected || !observed || expected === observed) return true;
      const isUuid2 = (value) => _FlowUuidGateway.isUuid(value);
      const isAsb = (value) => this.isAsb(value);
      const normalize = (value) =>
        isUuid2(value) ? String(value).toLowerCase() : value;
      if (isUuid2(expected) && isUuid2(observed))
        return normalize(expected) === normalize(observed);
      const aliasesByUuid = new Map();
      for (const record of records) {
        if (
          !record ||
          typeof record !== "object" ||
          !isUuid2(record.media_uuid)
        )
          continue;
        const uuid = normalize(record.media_uuid);
        const aliases = aliasesByUuid.get(uuid) || new Set([uuid]);
        for (const alias of [
          record.persistent_media_id,
          record.file_name,
          ...(Array.isArray(record.identity_aliases)
            ? record.identity_aliases
            : []),
        ]) {
          if (isAsb(alias) || (isUuid2(alias) && normalize(alias) === uuid))
            aliases.add(normalize(alias));
        }
        aliasesByUuid.set(uuid, aliases);
      }
      if (aliasesByUuid.size > 1) return false;
      for (const [uuid, aliases] of aliasesByUuid) {
        if (isUuid2(tileId) && normalize(tileId) !== uuid) continue;
        if (isAsb(tileId) && !aliases.has(tileId)) continue;
        if (
          aliases.has(normalize(expected)) &&
          aliases.has(normalize(observed))
        )
          return true;
      }
      return false;
    }
    static aliases(record, fallbackId = null) {
      const name = String(record?.file_name || record?.fileName || "");
      return new Set(
        [
          fallbackId,
          record?.fileId,
          record?.file_id,
          record?.media_uuid,
          record?.mediaUuid,
          record?.persistent_media_id,
          record?.mediaId,
          isUuid(name) || this.isAsb(name) ? name : null,
          ...(Array.isArray(record?.identity_aliases)
            ? record.identity_aliases
            : []),
        ]
          .filter((value) => typeof value === "string" && value.trim())
          .map((value) => key(value.trim())),
      );
    }
    static sameMediaIdentity(left, right, leftId = null, rightId = null) {
      const a = this.identity(left, leftId),
        b = this.identity(right, rightId);
      if (isUuid(a) && isUuid(b) && key(a) !== key(b)) return false;
      const ap = left?.project_id || left?.projectId,
        bp = right?.project_id || right?.projectId;
      if (ap && bp && key(ap) !== key(bp)) return false;
      const aliases = this.aliases(right, rightId);
      return [...this.aliases(left, leftId)].some((value) =>
        aliases.has(value),
      );
    }
    static metadataMatches(record, info, { projectId = null } = {}) {
      if (!info) return false;
      const type = record?.type || record?.mediaType;
      if (type && info.type && key(type) !== key(info.type)) return false;
      const project = projectId || record?.project_id || record?.projectId;
      const ownerProject = record?.project_id || record?.projectId;
      if (projectId && ownerProject && key(projectId) !== key(ownerProject))
        return false;
      if (project && info.project_id && key(project) !== key(info.project_id))
        return false;
      const uuid = this.identity(
        record,
        record?.refKey || record?.fileId || record?.resultId,
      );
      if (isUuid(uuid)) return key(info.media_uuid) === key(uuid);
      return this.sameMediaIdentity(
        record,
        info,
        record?.refKey || record?.fileId || record?.resultId,
      );
    }
    static referenceMetadata(record, fallbackId = null) {
      record =
        typeof record === "string" ? { thumbnail: record } : record || {};
      const uuid = this.identity(record, fallbackId),
        type = String(record?.type || record?.mediaType || "").toLowerCase();
      return {
        ...record,
        media_uuid: isUuid(uuid) ? uuid : null,
        type: ["image", "video"].includes(type) ? type : null,
        project_id: record?.project_id || record?.projectId || null,
        file_name: record?.file_name || record?.fileName || null,
        persistent_media_id:
          [
            record?.persistent_media_id,
            record?.mediaId,
            record?.file_name,
            record?.fileName,
            record?.refKey,
            fallbackId,
          ].find((value) => this.isAsb(value)) ||
          record?.persistent_media_id ||
          null,
      };
    }
    static isRemoteMetadata(record, id, receipt = record?.provider_data) {
      if (
        record?.local_result === true ||
        receipt?.local_result === true ||
        record?.source === "local" ||
        String(id || "").startsWith(LOCAL_MERGE_PREFIX)
      )
        return false;
      if (
        isUuid(record?.media_uuid || record?.mediaUuid) &&
        ["flow-v2-asb", "flow-api-uuid", "flow-content-uuid"].includes(
          record?.identity_kind,
        )
      )
        return true;
      if (
        receipt?.provider === "flow" &&
        isUuid(receipt.media_uuid) &&
        key(receipt.media_uuid) === key(record?.media_uuid || record?.mediaUuid)
      )
        return true;
      const provider = record?.provider || receipt?.provider;
      return (
        record?.local_result !== true &&
        !(provider && provider !== "flow") &&
        !["upload", "local", "muse"].includes(record?.source) &&
        !String(id || "").startsWith("upload_")
      );
    }
    static async recoverMetadata(entries, context = {}) {
      return this._traceOperation("recoverMetadata", context, (scoped) =>
        this._recoverMetadata(entries, scoped),
      );
    }
    static async _recoverMetadata(entries, context = {}) {
      abort(context);
      const all = (entries || []).map((entry) => ({
        ...entry,
        record: this.referenceMetadata(entry.record, entry.id),
      }));
      let owners = all.filter((entry) =>
        this.isRemoteMetadata(
          entry.record,
          entry.id,
          entry.providerData || entry.record.provider_data,
        ),
      );
      const skipped = all
        .filter(
          (entry) =>
            !this.isRemoteMetadata(
              entry.record,
              entry.id,
              entry.providerData || entry.record.provider_data,
            ),
        )
        .map((entry) => entry.id);
      const records = Object.fromEntries(
        all.map((entry) => [entry.id, entry.record]),
      );
      const stages = [];
      if (!owners.length)
        return {
          records,
          stages,
          target: context.expectedFlowTarget || null,
          failed: [],
          unresolved: skipped,
          skipped,
        };
      const rejected = (entry) => [
        ...new Set([
          ...(entry.rejectedUrls || []),
          ...(context.rejectedUrls || []),
        ]),
      ];
      const ready = (entry) =>
        (entry.fields || context.fields || ["thumbnail"]).every((field) =>
          this.usableUrl(records[entry.id]?.[field], {
            rejectedUrls: rejected(entry),
            allowLocal: context.allowLocal !== false,
          }),
        );
      const adopt = (entry, info, stage) => {
        if (!this.metadataMatches(entry.record, info, pinned)) return;
        records[entry.id] = this.reconcileMetadata(records[entry.id], info, {
          ...pinned,
          rejectedUrls: rejected(entry),
        });
        stages.push({ id: entry.id, stage });
        this._diagnostic(context, "metadata_adopted", {
          identity: this._fingerprint(entry.id),
          source: stage,
          hasThumbnail: !!records[entry.id]?.thumbnail,
          hasPlayback: !!records[entry.id]?.video_url,
        });
      };
      const target = await this._target(context);
      const pinned = {
        ...context,
        expectedFlowTarget: target,
        projectId: target?.projectId || context.projectId,
      };
      owners = owners.filter((entry) => {
        if (
          entry.record.project_id &&
          pinned.projectId &&
          key(entry.record.project_id) !== key(pinned.projectId)
        ) {
          skipped.push(entry.id);
          return false;
        }
        return true;
      });
      if (!owners.length)
        return {
          records,
          stages,
          target,
          failed: [],
          unresolved: skipped,
          skipped,
        };
      const readSafely = async (work, stage) => {
        try {
          return await work();
        } catch (error) {
          abort(pinned);
          await this._target(pinned);
          abort(pinned);
          if (
            [
              "PROJECT_MISMATCH",
              "FLOW_EXECUTION_TARGET_CHANGED",
              "FLOW_MEDIA_LOOKUP_SCOPE_CHANGED",
              "FLOW_MEDIA_DOCUMENT_CHANGED",
            ].includes(error?.code || error?.message)
          )
            throw error;
          stages.push({ stage, reason: "metadata_read_unavailable" });
          return null;
        }
      };
      const identities = [
        ...new Set(
          owners
            .flatMap((entry) => [
              this.identity(entry.record, entry.id),
              ...this.aliases(entry.record, entry.id),
            ])
            .filter(Boolean),
        ),
      ];
      const lookupSettings = root.storageSettings?.getSettings?.() || {};
      const lookupMode =
        context.catalogOnly === true
          ? "web"
          : context.mode ||
            lookupSettings.defaultGenMode ||
            lookupSettings.gen_mode;
      const lookup = (await readSafely(
        () =>
          this.resolve(identities, {
            ...pinned,
            mode: lookupMode,
            passive: true,
            purpose: "preview",
            ownerRecords: owners.map((entry) => ({
              ...entry.record,
              resultId: entry.id,
            })),
          }),
        "gateway",
      )) || { results: {}, failed: [] };
      for (const entry of owners) {
        const info = identities
          .map((id) => lookup.results[id]?.metadata)
          .find((info2) => this.metadataMatches(entry.record, info2, pinned));
        if (info) adopt(entry, info, "gateway");
      }
      const authoritativeMissing = new Set(
        owners
          .filter((entry) =>
            lookup.failed.includes(this.identity(entry.record, entry.id)),
          )
          .map((entry) => entry.id),
      );
      let pending = owners.filter(
        (entry) => !ready(entry) && !authoritativeMissing.has(entry.id),
      );
      if (
        pending.length &&
        context.catalogOnly !== true &&
        root.MessageBridge?.getThumbnailsByIds
      ) {
        abort(pinned);
        const read = await readSafely(
          () =>
            root.MessageBridge.getThumbnailsByIds(
              pending.map((entry) => entry.id),
              {
                deep: context.deep === true,
                signal: context.signal,
                expectedFlowTarget: target,
                fileNamesById: Object.fromEntries(
                  pending.map((entry) => [
                    entry.id,
                    records[entry.id]?.file_name ||
                      entry.record.file_name ||
                      "",
                  ]),
                ),
                ownerRecords: pending.map((entry) => ({
                  resultId: entry.id,
                  mediaUuid: entry.record.media_uuid,
                  mediaType: entry.record.type,
                })),
              },
            ),
          "mounted",
        );
        abort(pinned);
        await this._target(pinned);
        abort(pinned);
        if (
          read?.projectId &&
          pinned.projectId &&
          key(read.projectId) !== key(pinned.projectId)
        )
          throw this.error("PROJECT_MISMATCH");
        for (const entry of pending)
          adopt(entry, read?.results?.[entry.id], "mounted");
      }
      pending = owners.filter(
        (entry) => !ready(entry) && !authoritativeMissing.has(entry.id),
      );
      const settings = root.storageSettings?.getSettings?.() || {};
      if (
        pending.length &&
        context.catalogOnly !== true &&
        context.allowApi !== false &&
        ["api", "auto"].includes(
          context.mode || settings.defaultGenMode || settings.gen_mode,
        )
      ) {
        const ids = pending.map((entry) =>
          this.identity(entry.record, entry.id),
        );
        const api = ["api", "auto"].includes(lookupMode)
          ? lookup
          : await readSafely(
              () =>
                this.resolve(ids, {
                  ...pinned,
                  mode: "api",
                  passive: true,
                  purpose: "preview",
                  ownerRecords: pending.map((entry) => ({
                    ...entry.record,
                    resultId: entry.id,
                  })),
                }),
              "api",
            );
        for (const entry of pending) {
          const identity = this.identity(entry.record, entry.id);
          const verdict = api?.results?.[identity];
          if (api?.failed?.includes(identity))
            authoritativeMissing.add(entry.id);
          if (verdict?.ok)
            adopt(entry, verdict.metadata, api.effectiveMode || "gateway");
        }
        if (api?.legacyActionAvailable) {
          for (const entry of pending.filter(
            (entry2) => !ready(entry2) && !authoritativeMissing.has(entry2.id),
          )) {
            const mediaId = this.identity(entry.record, entry.id);
            if (!isUuid(mediaId)) continue;
            const value = await readSafely(
              () =>
                this.resolveMedia({
                  ...pinned,
                  mode: "api",
                  passive: true,
                  purpose: "preview",
                  mediaId,
                  mediaType: entry.record.type || "image",
                  providerData:
                    entry.providerData || entry.record.provider_data,
                }),
              "legacy_action",
            );
            if (!this.usableUrl(value?.url, { rejectedUrls: rejected(entry) }))
              continue;
            records[entry.id] = {
              ...records[entry.id],
              ...(entry.record.type === "video"
                ? {
                    video_url: value.url,
                    ...(value.posterUrl && { thumbnail: value.posterUrl }),
                  }
                : { thumbnail: value.url, image_url: value.url }),
              ...(!this.isAsb(records[entry.id]?.persistent_media_id) && {
                persistent_media_id:
                  records[entry.id]?.persistent_media_id || mediaId,
                file_name: records[entry.id]?.file_name || mediaId,
                identity_kind: "flow-api-uuid",
                identity_durability: "durable-resolver",
              }),
            };
            stages.push({ id: entry.id, stage: "legacy_action" });
          }
        }
      }
      pending = owners.filter(
        (entry) =>
          entry.record.type === "video" &&
          !ready(entry) &&
          !authoritativeMissing.has(entry.id),
      );
      if (
        context.catalogOnly !== true &&
        root.MessageBridge?.resolveVideoPlaybackUrl
      ) {
        for (const entry of pending) {
          abort(pinned);
          const info = await readSafely(
            () =>
              root.MessageBridge.resolveVideoPlaybackUrl(
                this.isAsb(records[entry.id]?.persistent_media_id)
                  ? records[entry.id].persistent_media_id
                  : this.identity(entry.record, entry.id),
                {
                  projectId: pinned.projectId,
                  expectedFlowTarget: target,
                  signal: context.signal,
                  fileName:
                    records[entry.id]?.file_name ||
                    entry.record.file_name ||
                    "",
                  sourceUrl:
                    records[entry.id]?.source_thumbnail ||
                    records[entry.id]?.thumbnail ||
                    "",
                  persistentMediaId: records[entry.id]?.persistent_media_id,
                  allowVirtualScan: false,
                  skipMediaApiResolve: true,
                  activationTimeoutMs: 0,
                  rejectedVideoUrls: rejected(entry),
                  forceDomResolve: context.forceDomResolve === true,
                },
              ),
            "playback",
          );
          abort(pinned);
          await this._target(pinned);
          abort(pinned);
          if (info?.success === true) {
            const transport = this.playbackMetadata(entry.record, info);
            if (transport) adopt(entry, transport, "playback");
          }
        }
      }
      abort(pinned);
      await this._target(pinned);
      abort(pinned);
      return {
        records,
        stages,
        target,
        failed: [...authoritativeMissing],
        skipped,
        unresolved: [
          ...owners.filter((entry) => !ready(entry)).map((entry) => entry.id),
          ...skipped,
        ],
      };
    }
    static referenceSelection(record, inventory = []) {
      if (!record || typeof record !== "object") return record;
      let next = { ...record };
      if (!["flow", "existing"].includes(next.source)) return next;
      if (!next.media_uuid && isUuid(next.fileId))
        next.media_uuid = next.fileId;
      const discovered = (Array.isArray(inventory) ? inventory : []).find(
        (media) =>
          media &&
          (!next.project_id ||
            !media.project_id ||
            key(next.project_id) === key(media.project_id)) &&
          (!next.type || !media.type || next.type === media.type) &&
          this.sameMediaIdentity(next, media),
      );
      if (discovered) next = this.mergeSelectedMedia(discovered, next);
      if (!next.media_uuid && isUuid(next.fileId))
        next.media_uuid = next.fileId;
      if (next.persistent_media_id) {
        next.fileId = next.persistent_media_id;
        next.file_name = next.file_name || next.persistent_media_id;
        next.identity_durability =
          next.type === "video" &&
          !/^[A-Za-z0-9_-]{32,1024}$/.test(String(next.persistent_media_id))
            ? "session"
            : "durable";
      }
      return this.normalizePosterMetadata(next);
    }
    static mergeSelectedMedia(primary, secondary) {
      if (!this.sameMediaIdentity(primary, secondary)) return { ...primary };
      const merged = { ...(secondary || {}), ...(primary || {}) };
      for (const field of [
        "thumbnail",
        "source_thumbnail",
        "video_url",
        "file_name",
        "media_uuid",
        "persistent_media_id",
        "identity_durability",
        "identity_kind",
        "api_driver",
        "project_id",
        "protocol_revision",
        "protocol_fingerprint",
        "display_name",
        "upload_name",
      ])
        if (!merged[field] && secondary?.[field])
          merged[field] = secondary[field];
      merged.fileId = primary?.fileId || secondary?.fileId;
      if (primary?.type === "video" || secondary?.type === "video")
        merged.type = "video";
      if (primary?.source === "flow" || secondary?.source === "flow")
        merged.source = "flow";
      merged.identity_aliases = [
        ...new Set([...this.aliases(primary), ...this.aliases(secondary)]),
      ];
      return merged;
    }
    static asbIdentityFromUrl(value, { allowedOrigins = [] } = {}) {
      try {
        const url = new URL(value);
        if (
          (url.origin !== "https://flow.google.com" &&
            !(
              Array.isArray(allowedOrigins) &&
              allowedOrigins.includes(url.origin) &&
              url.protocol === "https:"
            )) ||
          !url.pathname.startsWith("/asb/")
        )
          return "";
        const id = url.pathname.slice("/asb/".length).split("=")[0];
        return this.isAsb(id) ? id : "";
      } catch (_) {
        return "";
      }
    }
    static usableUrl(
      value,
      { marginSeconds = 0, rejectedUrls = [], allowLocal = true } = {},
    ) {
      if (!value || typeof value !== "string" || rejectedUrls.includes(value))
        return false;
      try {
        const url = new URL(value);
        if (allowLocal && ["blob:", "data:"].includes(url.protocol))
          return true;
        if (!["https:", "http:"].includes(url.protocol)) return false;
        const expires = Number(url.searchParams.get("Expires"));
        return !(expires > 0 && expires <= Date.now() / 1e3 + marginSeconds);
      } catch (_) {
        return false;
      }
    }
    static keepPlaybackUrl(record, info) {
      return (
        info?.playback_url_source === "configured_transform" &&
        !!record?.video_url &&
        this.isAsb(info.persistent_media_id) &&
        !this.accountRoutingChanged(
          record.video_url,
          info.video_url || info.thumbnail,
        ) &&
        !(
          record.media_uuid &&
          info.media_uuid &&
          key(record.media_uuid) !== key(info.media_uuid)
        ) &&
        this.asbIdentityFromUrl(record.video_url) === info.persistent_media_id
      );
    }
    static accountRoutingChanged(previous, current) {
      try {
        return (
          !!this.asbIdentityFromUrl(previous) &&
          !!this.asbIdentityFromUrl(current) &&
          new URL(previous).searchParams.get("authuser") !==
            new URL(current).searchParams.get("authuser")
        );
      } catch (_) {
        return false;
      }
    }
    static retargetKnownPlayback(record, info) {
      if (
        record?.playback_url_source !== "dom_stream" ||
        info?.playback_url_source !== "configured_transform"
      )
        return null;
      if (
        (record.media_uuid &&
          info.media_uuid &&
          key(record.media_uuid) !== key(info.media_uuid)) ||
        (record.type && info.type && record.type !== info.type)
      )
        return null;
      const oldAsb = this.asbIdentityFromUrl(record.video_url),
        asb = this.asbIdentityFromUrl(info.video_url);
      const sameUuid =
        record.media_uuid &&
        info.media_uuid &&
        key(record.media_uuid) === key(info.media_uuid);
      if (!oldAsb || !asb || (!sameUuid && oldAsb !== asb)) return null;
      if (
        oldAsb === asb &&
        !this.accountRoutingChanged(record.video_url, info.video_url)
      )
        return null;
      try {
        const suffix = new URL(record.video_url).pathname.match(
          /=mm,\d+,\d+$/,
        )?.[0];
        if (!suffix) return null;
        const url = new URL(info.video_url);
        url.pathname = url.pathname.replace(/=mm,\d+,\d+$/, "") + suffix;
        return url.href;
      } catch (_) {
        return null;
      }
    }
    static preferPlaybackUrl(candidateUrl, savedUrl, recovery) {
      if (
        !savedUrl ||
        !candidateUrl ||
        candidateUrl !== recovery?.video_url ||
        recovery.playback_url_source === "dom_stream"
      )
        return candidateUrl;
      try {
        const id = this.asbIdentityFromUrl(savedUrl);
        if (
          id &&
          id === this.asbIdentityFromUrl(candidateUrl) &&
          new URL(savedUrl).searchParams.get("authuser") ===
            new URL(candidateUrl).searchParams.get("authuser")
        )
          return savedUrl;
      } catch (_) {}
      return candidateUrl;
    }
    static hasFreshPlaybackTransport(url, source = null) {
      if (!url || String(url).startsWith("blob:")) return false;
      try {
        const parsed = new URL(url);
        if (this.asbIdentityFromUrl(url)) return source === "dom_stream";
        if (parsed.hostname === "flow-content.google") {
          const expires = Number(parsed.searchParams.get("Expires"));
          return (
            /^\/video\/[0-9a-f-]{36}(?:\/|$)/i.test(parsed.pathname) &&
            Number.isFinite(expires) &&
            expires > Date.now() / 1e3 + 5
          );
        }
        return this.usableUrl(url);
      } catch (_) {
        return false;
      }
    }
    static hasRemoteThumbnailBytes(record) {
      const identity = this.identity(record, record?.fileId);
      return (
        /^data:image\//i.test(record?.thumbnail || "") &&
        this.isRemoteMetadata(record, identity) &&
        (isUuid(identity) ||
          this.isAsb(identity) ||
          this.isAsb(record.persistent_media_id) ||
          this.isAsb(record.file_name) ||
          !!this.asbIdentityFromUrl(record.source_thumbnail))
      );
    }
    static cacheMetadata(previous, incoming, { rejectedUrls = [] } = {}) {
      incoming = this.normalizePosterMetadata(incoming, { rejectedUrls });
      if (!previous || !incoming || typeof incoming !== "object")
        return incoming;
      const next = { ...incoming },
        sameUuid =
          previous.media_uuid &&
          next.media_uuid &&
          key(previous.media_uuid) === key(next.media_uuid);
      const changed =
        (previous.media_uuid && next.media_uuid && !sameUuid) ||
        (previous.type && next.type && previous.type !== next.type) ||
        (previous.project_id &&
          next.project_id &&
          key(previous.project_id) !== key(next.project_id));
      const sameSource =
        previous.source_thumbnail &&
        previous.source_thumbnail === next.thumbnail;
      let signedImage = false;
      try {
        const old = new URL(previous.thumbnail);
        signedImage =
          old.origin === "https://flow-content.google" &&
          /^\/image\/[0-9a-f-]{36}(?:\/|$)/i.test(old.pathname) &&
          this.usableUrl(previous.thumbnail);
      } catch (_) {}
      if (
        !rejectedUrls.includes(previous.thumbnail) &&
        this.asbIdentityFromUrl(next.thumbnail) &&
        !changed &&
        (sameUuid || sameSource) &&
        ((/^data:image\//i.test(previous.thumbnail || "") &&
          !this.hasRemoteThumbnailBytes(previous)) ||
          signedImage)
      )
        next.thumbnail = previous.thumbnail;
      if (
        !rejectedUrls.includes(previous.video_url) &&
        this.keepPlaybackUrl(previous, next)
      ) {
        next.video_url = previous.video_url;
        if (previous.playback_url_source)
          next.playback_url_source = previous.playback_url_source;
      }
      const retargeted = this.retargetKnownPlayback(previous, incoming);
      if (retargeted && !rejectedUrls.includes(retargeted))
        next.video_url = retargeted;
      if (!changed) {
        for (const field of [
          "local_result",
          "provider",
          "source",
          "provider_data",
          "display_name",
          "upload_name",
          "file_name",
          "media_uuid",
          "persistent_media_id",
          "identity_kind",
          "identity_durability",
          "identity_aliases",
          "api_driver",
          "operation_uuid",
          "protocol_revision",
          "protocol_fingerprint",
          "project_id",
          "muse_blob_url",
          "flow_upload_status",
          "flow_upload_error",
        ])
          if (next[field] === void 0 && previous[field] !== void 0)
            next[field] = previous[field];
      }
      return next;
    }
    static mergeRecordMaps(existing, incoming) {
      const merged = { ...(existing || {}) };
      for (const [id, value] of Object.entries(incoming || {})) {
        const old = merged[id];
        if (old && typeof old === "object" && typeof value === "string")
          merged[id] = { ...old, thumbnail: value };
        else if (
          old &&
          typeof old === "object" &&
          value &&
          typeof value === "object"
        )
          merged[id] = { ...old, ...value };
        else merged[id] = value;
      }
      return merged;
    }
    static providerResultMetadata(info, providerData, { mediaType } = {}) {
      if (!info) return null;
      const video =
        String(mediaType || "").toLowerCase() === "video" ||
        info.type === "video" ||
        !!info.video_url;
      const serving =
        typeof providerData?.url === "string" &&
        !providerData.url.includes("media.getMediaUrlRedirect")
          ? providerData.url
          : null;
      const thumbnail =
        (typeof info.thumbnail === "string" &&
        !(video && info.thumbnail.includes("media.getMediaUrlRedirect"))
          ? info.thumbnail
          : "") || (/^https?:\/\//.test(serving || "") ? serving : "");
      const videoUrl =
        (typeof info.video_url === "string" &&
        !info.video_url.includes("media.getMediaUrlRedirect")
          ? info.video_url
          : "") || (video && providerData && serving ? serving : "");
      if (!thumbnail && !video && !info.file_name) return null;
      const result = {
        thumbnail,
        type: video ? "video" : info.type || "image",
        file_name: info.file_name || "",
      };
      for (const field of [
        "phaseRDownloadName",
        "media_uuid",
        "project_id",
        "asb",
        "source_thumbnail",
        "playback_url_source",
        "persistent_media_id",
        "identity_kind",
        "identity_durability",
        "api_driver",
        "operation_uuid",
        "protocol_revision",
        "protocol_fingerprint",
        "display_name",
        "upload_name",
      ])
        if (info[field]) result[field] = info[field];
      if (info.thumb_is_poster === true) result.thumb_is_poster = true;
      if (videoUrl) result.video_url = videoUrl;
      if (Array.isArray(info.identity_aliases) && info.identity_aliases.length)
        result.identity_aliases = [
          ...new Set(info.identity_aliases.filter(Boolean)),
        ];
      return result;
    }
    static playbackMetadata(record, info) {
      if (!info || (info.type && info.type !== "video")) return null;
      if (this.metadataMatches(record, info)) return { ...info, type: "video" };
      if (info.media_uuid) return null;
      const uuid = this.identity(record),
        url = info.video_url;
      let streamUuid = null;
      try {
        const parsed = new URL(url);
        if (parsed.origin === "https://flow-content.google")
          streamUuid = parsed.pathname.match(
            /^\/video\/([0-9a-f-]{36})(?:\/|$)/i,
          )?.[1];
      } catch (_) {}
      const sameAlias = [
        info.persistent_media_id,
        this.asbIdentityFromUrl(url),
      ].some((id) => this.isAsb(id) && this.aliases(record).has(id));
      if (!isUuid(uuid) || !(key(streamUuid) === key(uuid) || sameAlias))
        return null;
      return { ...info, type: "video", media_uuid: uuid };
    }
    static videoPresentation(record, info, options = {}) {
      const next = this.reconcileMetadata(
        record,
        { ...info, type: "video" },
        options,
      );
      if (
        !next ||
        !this.usableUrl(next.video_url, { ...options, allowLocal: false })
      )
        return null;
      const poster = [
        info?.source_thumbnail,
        info?.thumbnail,
        record?.source_thumbnail,
        record?.thumbnail,
      ].find(
        (url) =>
          url !== next.video_url &&
          this.usableUrl(url, options) &&
          !/=mm,\d+,\d+(?:\?|$)/.test(url),
      );
      const persistent = next.persistent_media_id || next.media_uuid;
      return {
        ...next,
        type: "video",
        thumbnail: poster || next.video_url,
        source_thumbnail: poster || null,
        thumb_is_poster: !!poster,
        persistent_media_id: persistent,
        identity_kind: this.isAsb(persistent) ? "flow-v2-asb" : "flow-api-uuid",
        identity_durability: this.isAsb(persistent)
          ? "durable"
          : "durable-resolver",
        file_name: next.file_name || persistent,
      };
    }
    static uploadReceiptMetadata(receipt, info) {
      const record = {
        media_uuid: [receipt?.mediaUuid, receipt?.mediaId].find(isUuid),
        type: "video",
        project_id: receipt?.projectId,
        persistent_media_id: receipt?.persistentMediaId,
        file_name: receipt?.fileName,
      };
      return receipt &&
        this.metadataMatches(record, info, { projectId: receipt.projectId }) &&
        isUuid(info?.media_uuid) &&
        this.isAsb(info?.persistent_media_id)
        ? {
            ...receipt,
            mediaUuid: info.media_uuid,
            persistentMediaId: info.persistent_media_id,
            fileName: info.persistent_media_id,
          }
        : receipt;
    }
    static async correctUploadReceipt(receipt, context = {}) {
      if (!receipt) return receipt;
      const record = {
        media_uuid: [receipt.mediaUuid, receipt.mediaId].find(isUuid),
        type: "video",
        project_id: receipt.projectId,
        persistent_media_id: receipt.persistentMediaId,
        file_name: receipt.fileName,
      };
      const ids = record.media_uuid
        ? [record.media_uuid]
        : [...this.aliases(record, receipt.mediaId)];
      let response;
      try {
        response = await this.resolve(ids, {
          ...context,
          projectId: receipt.projectId,
          mode: "web",
          passive: true,
          mediaType: "video",
        });
      } catch (error) {
        abort(context);
        await this._target(context);
        abort(context);
        if (
          [
            "FLOW_EXECUTION_TARGET_CHANGED",
            "FLOW_MEDIA_LOOKUP_SCOPE_CHANGED",
            "FLOW_MEDIA_DOCUMENT_CHANGED",
          ].includes(error?.code || error?.message)
        )
          throw error;
        return receipt;
      }
      const info = ids
        .map((id) => response.results[id]?.metadata)
        .find((item) => this.metadataMatches(record, item, context));
      return this.uploadReceiptMetadata(receipt, info);
    }
    static async mediaResolverContext(
      providerData = null,
      media = null,
      { allowExactUuidLookup = false, projectId: ownerProjectId = null } = {},
    ) {
      const provider =
        providerData && typeof providerData === "object" ? providerData : {};
      const saved = media && typeof media === "object" ? media : {};
      const apiModeIntended =
        root.FlowApiAdapter?.isApiModeIntended?.({ forWorkflow: true }) ===
        true;
      const savedIdentityValues = [
        saved.identity_kind,
        saved.persistent_media_id,
        saved.file_name,
        saved.video_url,
        saved.source_thumbnail,
        saved.thumbnail,
      ].map((value) => String(value || ""));
      const hasDurableWebIdentity = savedIdentityValues.some(
        (value) =>
          value === "flow-v2-asb" ||
          this.isAsb(value) ||
          /\/asb\/[A-Za-z0-9_-]{32,}/.test(value),
      );
      const identityKind =
        provider.identity_kind ||
        saved.identity_kind ||
        (apiModeIntended ? "flow-api-uuid" : null);
      let apiDriver = provider.api_driver || saved.api_driver || null;
      const runtimeForcesV2 =
        root.SystemConfig?.get?.("flow_api_driver", null) === "v2";
      const forcedV2 = runtimeForcesV2 && apiModeIntended;
      let lookupConfig = null;
      let v2Selection = null;
      const savedByV2Api =
        provider.api_driver === "v2" || saved.api_driver === "v2";
      if (
        runtimeForcesV2 &&
        hasDurableWebIdentity &&
        !allowExactUuidLookup &&
        !savedByV2Api
      )
        return null;
      if (runtimeForcesV2 && !apiModeIntended && !savedByV2Api) return null;
      if (savedByV2Api && !apiModeIntended) {
        if (root.SystemConfig?.get?.("flow_api_driver", null) === "disabled")
          return null;
        lookupConfig =
          await root.ProviderConfigManager?.fetchFlowApiV2Configs?.();
        if (!lookupConfig) return null;
        apiDriver = "v2";
      }
      if (
        !lookupConfig &&
        forcedV2 &&
        (!hasDurableWebIdentity || allowExactUuidLookup || savedByV2Api)
      ) {
        v2Selection = await root.FlowApiSessionCoordinator?.check?.({
          surface: "workflow",
          mediaType:
            saved.type === "video" || saved.video_url ? "video" : "image",
          passive: true,
        });
        if (v2Selection?.ready !== true || v2Selection.driver !== "v2")
          return null;
        apiDriver = "v2";
        lookupConfig =
          await root.ProviderConfigManager?.fetchFlowApiV2Configs?.();
        if (!lookupConfig) return null;
      } else if (!apiDriver && apiModeIntended && !hasDurableWebIdentity) {
        const selection = await root.FlowApiSessionCoordinator?.check?.({
          surface: "workflow",
          mediaType:
            saved.type === "video" || saved.video_url ? "video" : "image",
          passive: true,
        });
        if (
          selection?.ready !== true ||
          !["v1", "v2"].includes(selection.driver)
        )
          return null;
        apiDriver = selection.driver;
        if (apiDriver === "v2") {
          lookupConfig =
            await root.ProviderConfigManager?.fetchFlowApiV2Configs?.();
          if (!lookupConfig) return null;
        }
      }
      if (!apiDriver && !hasDurableWebIdentity) return null;
      let projectId =
        provider.project_id ||
        saved.project_id ||
        ownerProjectId ||
        v2Selection?.projectId;
      if (lookupConfig && !projectId) {
        const selected = await root.FlowApiSessionCoordinator?.check?.({
          surface: "workflow",
          mediaType:
            saved.type === "video" || saved.video_url ? "video" : "image",
          passive: true,
        });
        if (selected?.ready === true && selected.driver === "v2")
          projectId = selected.projectId;
      }
      if (lookupConfig && !projectId) return null;
      return {
        ...provider,
        provider: provider.provider || "flow",
        ...(identityKind && { identity_kind: identityKind }),
        ...(apiDriver && { api_driver: apiDriver }),
        ...(lookupConfig && {
          uuidLookup: true,
          project_id: projectId,
          protocol_revision: Number(lookupConfig.protocol?.schema_version || 0),
          protocol_fingerprint:
            root.FlowApiV2CheckpointStore?.fingerprint?.(lookupConfig) || null,
        }),
      };
    }
    static downloadMode(generationMode) {
      if (!["web", "api"].includes(generationMode))
        throw new Error("MOTION_FLOW_RUN_MODE_REQUIRED");
      if (generationMode === "web") return "web";
      const settings = root.storageSettings?.getSettings?.();
      if (!settings)
        throw new Error("MOTION_FLOW_DOWNLOAD_SETTINGS_UNAVAILABLE");
      const apiActive =
        root.SystemConfig?.get?.("flow_api_driver", null) !== "disabled" &&
        root.featureGate?.canUse?.("flow_api_enabled") === true &&
        [true, "true", 1].includes(settings.apiModeEnabled) &&
        ["auto", "api"].includes(settings.defaultGenMode || settings.gen_mode);
      return apiActive ? "api" : "web";
    }
    static resultSourceThumbnail(r) {
      if (!r) return null;
      var source = r.sourceThumbnail || r.source_thumbnail || null;
      return source ? this.legacyMediaUrl(source, false) : null;
    }
    static resultVideoUrl(r) {
      if (!r) return null;
      if (r.playUrl) return this.legacyMediaUrl(r.playUrl, true);
      var derived = this.asbVariantUrl(
        this.resultSourceThumbnail(r) ||
          r.thumbnail ||
          r.source_thumbnail ||
          null,
      );
      if (derived) return derived;
      var u = r.url;
      if (!u) return null;
      var rebound = this.legacyMediaUrl(u, true);
      if (rebound !== u) return rebound;
      try {
        var parsed = new URL(u, root.location.origin);
        if (parsed.searchParams.has("mediaUrlType")) {
          parsed.searchParams.delete("mediaUrlType");
          return parsed.href;
        }
      } catch (_) {}
      return u;
    }
    static resultThumbnailUrl(r) {
      return this.displayThumbnailUrl(this._resultThumbnailUrl(r));
    }
    static _resultThumbnailUrl(r) {
      function isVideoResourceUrl(url) {
        if (typeof url !== "string" || !url) return false;
        try {
          var parsed2 = new URL(url, root.location.href);
          return (
            (parsed2.hostname === "flow-content.google" &&
              /^\/video\//i.test(parsed2.pathname)) ||
            /\.(?:mp4|webm|mov|m4v)$/i.test(parsed2.pathname) ||
            (parsed2.origin === root.location.origin &&
              parsed2.pathname.indexOf("/asb/") === 0 &&
              /=mm,\d+,\d+$/.test(parsed2.pathname))
          );
        } catch (_) {
          return false;
        }
      }
      if (!r) return null;
      if (!r.video)
        return this.legacyMediaUrl(r.thumbnail || r.url || null, false);
      if (typeof r.poster === "string" && !isVideoResourceUrl(r.poster))
        return this.legacyMediaUrl(r.poster, false);
      if (r.poster === true && r.url && !isVideoResourceUrl(r.url))
        return this.legacyMediaUrl(r.url, false);
      if (
        r.thumbnail &&
        r.thumbnail !== r.url &&
        r.thumbnail !== r.playUrl &&
        !isVideoResourceUrl(r.thumbnail)
      )
        return this.legacyMediaUrl(r.thumbnail, false);
      if (!r.url) {
        var sourceThumbnail = this.resultSourceThumbnail(r);
        return isVideoResourceUrl(sourceThumbnail)
          ? this.asbVariantUrl(sourceThumbnail, { playback: false }) || null
          : sourceThumbnail;
      }
      var rebound = this.legacyMediaUrl(r.url, false);
      if (rebound !== r.url)
        return isVideoResourceUrl(rebound) ? null : rebound;
      var v2Poster = this.asbVariantUrl(r.playUrl || r.url, {
        playback: false,
      });
      if (v2Poster) return v2Poster;
      try {
        var parsed = new URL(r.url, root.location.origin);
        if (isVideoResourceUrl(parsed.href)) return null;
        if (parsed.pathname.indexOf("getMediaUrlRedirect") === -1) return null;
        parsed.searchParams.set("mediaUrlType", "MEDIA_URL_TYPE_THUMBNAIL");
        return parsed.href;
      } catch (_) {
        return r.url;
      }
    }
    static directVideoUrl(r) {
      if (
        !r?.video ||
        typeof r.playUrl !== "string" ||
        !/^https?:\/\//i.test(r.playUrl)
      )
        return null;
      try {
        var parsed = new URL(r.playUrl, root.location.href);
        if (parsed.pathname.indexOf("/asb/") === 0) return null;
        var expires = Number(parsed.searchParams.get("Expires"));
        if (
          Number.isFinite(expires) &&
          expires > 0 &&
          expires <= Math.floor(Date.now() / 1e3) + 30
        )
          return null;
        return parsed.href;
      } catch (_) {
        return null;
      }
    }
    static legacyMediaUrl(url, wantVideo) {
      if (
        root.location.origin !== "https://flow.google.com" ||
        typeof url !== "string" ||
        !url.startsWith("https://labs.google/")
      )
        return url;
      var name = null;
      try {
        name = new URL(url).searchParams.get("name");
      } catch (_) {}
      if (!name) return null;
      const known = this.snapshotMetadata([name])[name];
      if (known)
        return wantVideo
          ? known.video_url || null
          : known.image_url || known.thumbnail || null;
      try {
        var tiles =
          typeof root._getCachedTiles === "function"
            ? Array.prototype.slice.call(root._getCachedTiles(), 0, 256)
            : [];
        for (var i = 0; i < tiles.length; i++) {
          var ids =
            typeof root.extractAllFileNames === "function"
              ? root.extractAllFileNames(tiles[i])
              : [];
          if (ids.indexOf(name) === -1) continue;
          var thumbnail =
            typeof root.extractThumbnailUrl === "function"
              ? root.extractThumbnailUrl(tiles[i])
              : null;
          if (!wantVideo) return thumbnail;
          var videoUrl =
            typeof root.extractVideoUrl === "function"
              ? root.extractVideoUrl(tiles[i])
              : null;
          return videoUrl || this.asbVariantUrl(thumbnail) || null;
        }
      } catch (_) {}
      return null;
    }
    static mountedPreview(result) {
      if (!result?.video) return null;
      var identities = [
        ...new Set(
          [
            result.mediaUuid,
            result.media_uuid,
            result.mediaId,
            result.media_id,
            result.fileName,
            result.file_name,
            result.tileId,
          ]
            .filter(Boolean)
            .map(String),
        ),
      ];
      try {
        var tile = null;
        for (var i = 0; i < identities.length && !tile; i++) {
          if (typeof root._getTileById === "function")
            tile = root._getTileById(identities[i]);
          if (!tile && typeof root.resolveTileByFileName === "function")
            tile = root.resolveTileByFileName(identities[i]);
        }
        if (!tile) return null;
        var mediaType =
          typeof root.detectMediaType === "function"
            ? root.detectMediaType(tile)
            : null;
        if (mediaType && String(mediaType).toLowerCase() !== "video")
          return null;
        var playUrl =
          typeof root.extractVideoUrl === "function"
            ? root.extractVideoUrl(tile)
            : null;
        var posterOwner =
          typeof root._q === "function"
            ? root._q("tile_video_poster", tile)
            : null;
        var poster =
          posterOwner?.currentSrc ||
          posterOwner?.src ||
          (typeof root.extractThumbnailUrl === "function"
            ? root.extractThumbnailUrl(tile)
            : null);
        poster = this.asbVariantUrl(poster, { playback: false }) || poster;
        var playbackSuffix = this.mediaUrlConfig()?.playback_url_suffix || "";
        try {
          if (
            typeof playbackSuffix === "string" &&
            playbackSuffix &&
            poster &&
            new URL(poster, root.location.href).pathname.endsWith(
              playbackSuffix,
            )
          )
            poster = null;
        } catch (_) {
          poster = null;
        }
        if (!poster && !playUrl) return null;
        return {
          ...(poster && {
            thumbnail: poster,
            sourceThumbnail: poster,
            poster: true,
            _mountedPoster: true,
          }),
          ...(playUrl && { playUrl }),
        };
      } catch (_) {
        return null;
      }
    }
    static usableResolvedTransport(url) {
      return (
        typeof url === "string" &&
        /^https?:\/\//i.test(url) &&
        !url.includes("/asb/") &&
        this.usableUrl(url, { marginSeconds: 30, allowLocal: false })
      );
    }
    static async hoverPlayback(result, { url = null, isCurrent = null } = {}) {
      if (isCurrent && !isCurrent()) return null;
      const context = { projectId: result.projectId || result.project_id };
      const target = await this._target(context);
      let tile = result.tileId && root._getTileById?.(result.tileId);
      const identity = result.mediaId || result.fileName;
      if (!tile && identity) tile = root.resolveTileByFileName?.(identity);
      if (tile) {
        const owner = root._q?.("tile_video_owner", tile) || tile;
        const options = {
          bubbles: true,
          cancelable: true,
          view: root,
          pointerType: "mouse",
        };
        try {
          owner.dispatchEvent(new root.PointerEvent("pointerenter", options));
        } catch (_) {}
        try {
          owner.dispatchEvent(new root.MouseEvent("mouseenter", options));
        } catch (_) {}
        try {
          owner.dispatchEvent(new root.MouseEvent("mouseover", options));
        } catch (_) {}
        const deadline = Date.now() + 8e3;
        while (Date.now() < deadline && (!isCurrent || isCurrent())) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const video = root._q?.("tile_video", tile),
            candidate = video?.currentSrc || video?.src;
          if (candidate) {
            url = candidate;
            break;
          }
        }
      }
      if (isCurrent && !isCurrent()) return null;
      await this._target({ ...context, expectedFlowTarget: target });
      return url;
    }
    static mergeMetadata(record, info) {
      if (!info) return record;
      if (
        record &&
        typeof record === "object" &&
        ["media_uuid", "project_id", "type"].some(
          (field) =>
            record[field] &&
            info[field] &&
            key(record[field]) !== key(info[field]),
        )
      )
        return record;
      const next =
        typeof record === "string"
          ? { thumbnail: record }
          : { ...(record || {}) };
      const keepPlayback =
        !!record?.video_url && this.keepPlaybackUrl(record, info);
      for (const [field, value] of Object.entries(info)) {
        if (
          value == null ||
          value === "" ||
          ["source", "provider", "provider_data"].includes(field)
        )
          continue;
        if (
          keepPlayback &&
          ["video_url", "playback_url_source", "url_kind"].includes(field)
        )
          continue;
        if (
          field === "project_id" &&
          record?.project_id &&
          key(record.project_id) !== key(value)
        )
          continue;
        next[field] = value;
      }
      return this.normalizePosterMetadata(next);
    }
    static reconcileMetadata(
      record,
      info,
      { rejectedUrls = [], allowLocal = true } = {},
    ) {
      if (!info) return record;
      const previous =
        typeof record === "string" ? { thumbnail: record } : record || {};
      if (
        ["media_uuid", "project_id", "type"].some(
          (field) =>
            previous[field] &&
            info[field] &&
            key(previous[field]) !== key(info[field]),
        )
      )
        return record;
      const next = this.mergeMetadata(previous, info);
      const oldAsb = [previous.persistent_media_id, previous.file_name].find(
        (value) => this.isAsb(value),
      );
      const asb = [info.persistent_media_id, info.asb].find((value) =>
        this.isAsb(value),
      );
      const rotated = !!oldAsb && !!asb && oldAsb !== asb;
      const remoteProxy = this.hasRemoteThumbnailBytes(previous);
      const usable = (value) =>
        this.usableUrl(value, { rejectedUrls, allowLocal });
      for (const field of [
        "thumbnail",
        "source_thumbnail",
        "image_url",
        "video_url",
      ]) {
        const correctedProxy =
          field === "thumbnail" &&
          remoteProxy &&
          usable(info.thumbnail || info.source_thumbnail);
        const local =
          /^(?:data:|blob:)/.test(previous[field] || "") && !correctedProxy;
        const accountChanged = this.accountRoutingChanged(
          previous[field],
          info[field] || info.video_url || info.thumbnail,
        );
        const actualPlayback =
          field === "video_url" &&
          info.playback_url_source === "dom_stream" &&
          previous.playback_url_source !== "dom_stream";
        if (
          ((rotated || accountChanged) && !local) ||
          (!usable(previous[field]) && field === "image_url")
        ) {
          next[field] =
            info[field] ||
            (field === "image_url" && info.type === "image"
              ? info.thumbnail
              : null) ||
            (field === "source_thumbnail" ? info.thumbnail : null) ||
            null;
        }
        if (
          !correctedProxy &&
          usable(previous[field]) &&
          (local || (!rotated && !accountChanged && !actualPlayback))
        ) {
          next[field] = previous[field];
          if (field === "video_url" && previous.playback_url_source)
            next.playback_url_source = previous.playback_url_source;
        }
        if (correctedProxy)
          next[field] = info.thumbnail || info.source_thumbnail;
        if (rejectedUrls.includes(next[field])) {
          next[field] =
            info[field] && !rejectedUrls.includes(info[field])
              ? info[field]
              : null;
          if (field === "video_url")
            next.playback_url_source = info.playback_url_source || null;
        }
      }
      const retargeted = this.retargetKnownPlayback(previous, info);
      if (retargeted && !rejectedUrls.includes(retargeted))
        next.video_url = retargeted;
      if (asb) {
        next.persistent_media_id = asb;
        next.file_name = asb;
        next.identity_kind = "flow-v2-asb";
        next.identity_durability = "durable";
      }
      next.identity_aliases = [
        ...new Set(
          [
            ...(Array.isArray(previous.identity_aliases)
              ? previous.identity_aliases
              : []),
            ...(Array.isArray(info.identity_aliases)
              ? info.identity_aliases
              : []),
            previous.media_uuid,
            oldAsb,
            info.media_uuid,
            asb,
          ].filter(Boolean),
        ),
      ];
      return this.normalizePosterMetadata(next, { rejectedUrls });
    }
    static async prepareMetadata(entries, context = {}) {
      return this._traceOperation("prepareMetadata", context, (scoped) =>
        this._prepareMetadata(entries, scoped),
      );
    }
    static async _prepareMetadata(entries, context = {}) {
      const records = Object.create(null),
        pending = [];
      let readyApiCount = 0;
      abort(context);
      const settings = root.storageSettings?.getSettings?.() || {};
      const mode = context.mode || settings.defaultGenMode || settings.gen_mode;
      for (const entry of entries || []) {
        if (!entry?.id) continue;
        const record = entry.record || {};
        records[entry.id] = record;
        if (
          !this.isRemoteMetadata(
            record,
            entry.id,
            entry.providerData || record.provider_data,
          )
        )
          continue;
        if (
          record.project_id &&
          context.projectId &&
          key(record.project_id) !== key(context.projectId)
        )
          continue;
        const apiDriver =
          record.api_driver ||
          record.apiDriver ||
          record.provider_data?.api_driver;
        const fields =
          entry.fields ||
          context.fields ||
          (record.type === "video"
            ? ["thumbnail", "video_url"]
            : ["thumbnail"]);
        if (
          (!context.purpose || context.purpose === "preview") &&
          ["api", "auto"].includes(mode) &&
          ["v1", "v2"].includes(apiDriver) &&
          isUuid(this.identity(record, entry.id)) &&
          (record.type !== "video" ||
            !!this._resultThumbnailUrl({
              ...record,
              video: true,
              url: record.video_url,
              playUrl: record.video_url,
            })) &&
          fields.every(
            (field) =>
              this.usableResolvedTransport(record[field]) &&
              !record[field].includes("getMediaUrlRedirect") &&
              this.usableUrl(record[field], {
                rejectedUrls: [
                  ...(entry.rejectedUrls || []),
                  ...(context.rejectedUrls || []),
                ],
              }),
          )
        ) {
          readyApiCount++;
          continue;
        }
        pending.push({ ...entry, identity: this.identity(record, entry.id) });
      }
      this._diagnostic(context, "presentation_summary", {
        apiUrlsReady: readyApiCount,
        lookupPending: pending.length,
        requestedMode: ["api", "auto", "web"].includes(mode)
          ? mode
          : "settings",
      });
      if (!pending.length)
        return { records, results: {}, failed: [], unresolved: [] };
      const response = await this.resolve(
        [...new Set(pending.map((entry) => entry.identity))],
        {
          ...context,
          mode,
          purpose: "preview",
          passive: true,
          ownerRecords: pending.map((entry) => ({
            ...entry.record,
            resultId: entry.identity,
          })),
        },
      );
      for (const entry of pending) {
        const verdict = response.results[entry.identity];
        if (verdict?.ok)
          records[entry.id] = this.reconcileMetadata(
            entry.record,
            verdict.metadata,
            context,
          );
      }
      return { ...response, records };
    }
    static resultMetadata(result) {
      return {
        ...result,
        type: result.video ? "video" : "image",
        media_uuid: result.mediaUuid || result.media_uuid || null,
        project_id: result.projectId || result.project_id || null,
        persistent_media_id:
          result.mediaId || result.persistent_media_id || null,
        file_name: result.fileName || result.file_name || null,
        thumbnail: result.thumbnail || (!result.video ? result.url : null),
        source_thumbnail:
          result.sourceThumbnail || result.source_thumbnail || null,
        image_url: result.video ? null : result.url,
        video_url: result.video
          ? result.playUrl || (result.poster ? null : result.url)
          : null,
      };
    }
    static mediaUrlConfig(input = void 0) {
      let config = input;
      if (input === void 0) {
        const read = (key2) =>
          typeof root._getDynamicSelector === "function"
            ? root._getDynamicSelector(key2)
            : root.ProviderConfigManager?.resolveDomProfile?.(
                "flow",
                "https://flow.google.com/",
              )?.selectors?.[key2];
        config = read("media_url_variants") ?? read("tile_video");
      }
      if (!config || typeof config !== "object" || Array.isArray(config))
        return null;
      return {
        ...config,
        image_url_suffix: config.image_url_suffix ?? config.poster_url_suffix,
        transform_pattern:
          config.transform_pattern ?? config.poster_transform_pattern,
      };
    }
    static async mediaUrlConfigAsync() {
      const current = this.mediaUrlConfig();
      if (current) return current;
      const manager = root.ProviderConfigManager;
      if (!manager?.getForPage) return null;
      const config =
        (await manager.getForPage(
          "flow",
          "media_url_variants",
          "https://flow.google.com/",
        )) ??
        (await manager.getForPage(
          "flow",
          "tile_video",
          "https://flow.google.com/",
        ));
      return this.mediaUrlConfig(config);
    }
    static normalizePosterMetadata(record, { rejectedUrls = [] } = {}) {
      if (!record || typeof record !== "object") return record;
      const config = this.mediaUrlConfig();
      if (!config) return record;
      let next = record;
      const set = (field, value) => {
        if (value === record[field]) return;
        if (next === record) next = { ...record };
        next[field] = value;
      };
      for (const field of [
        "thumbnail",
        "source_thumbnail",
        ...(record.type === "image" ? ["image_url"] : []),
      ]) {
        if (!this.asbIdentityFromUrl(record[field])) continue;
        const url = this.asbVariantUrl(record[field], {
          playback: false,
          thumbnail: field === "thumbnail",
          config,
        });
        if (url) set(field, rejectedUrls.includes(url) ? null : url);
      }
      const base = record.source_thumbnail || record.thumbnail;
      if (this.asbIdentityFromUrl(base)) {
        const high = this.asbVariantUrl(base, { playback: false, config });
        if (high && !rejectedUrls.includes(high)) {
          if (!record.source_thumbnail) set("source_thumbnail", high);
          if (record.type === "image" && !record.image_url)
            set("image_url", high);
        }
      }
      return next;
    }
    static displayThumbnailUrl(value) {
      return this.asbIdentityFromUrl(value)
        ? this.asbVariantUrl(value, { playback: false, thumbnail: true }) ||
            value
        : value;
    }
    static imagePreviewUrl(record, fallback = null) {
      record =
        typeof record === "string" ? { thumbnail: record } : record || {};
      const video = record.type === "video" || record.video === true;
      const candidates = video
        ? [
            record.source_thumbnail,
            record.sourceThumbnail,
            record.thumbnail,
            fallback,
          ]
        : [
            record.image_url,
            record.imageUrl,
            record.source_thumbnail,
            record.sourceThumbnail,
            record.url,
            record.thumbnail,
            record.src,
            fallback,
          ];
      for (const value of candidates) {
        if (
          typeof value !== "string" ||
          !value ||
          value.includes("getMediaUrlRedirect")
        )
          continue;
        return this.asbIdentityFromUrl(value)
          ? this.asbVariantUrl(value, { playback: false }) || value
          : value;
      }
      return null;
    }
    static _reportThumbnailPolicy(config, suffix) {
      const imageSuffix = (value) =>
        typeof value === "string" && /^=s[1-9]\d*(?:-[a-z]+)*$/.test(value)
          ? value
          : null;
      const thumbnailSuffix = imageSuffix(config?.thumbnail_url_suffix);
      const posterSuffix = imageSuffix(config?.image_url_suffix);
      const effectiveSuffix = imageSuffix(suffix);
      const source = config?.thumbnail_url_suffix
        ? "thumbnail_url_suffix"
        : config?.image_url_suffix
          ? "poster_compatibility"
          : "missing_config";
      const signature = JSON.stringify([
        thumbnailSuffix,
        posterSuffix,
        effectiveSuffix,
        source,
      ]);
      if (this._thumbnailPolicySignature === signature) return;
      this._thumbnailPolicySignature = signature;
      try {
        console.info(
          "[flow_uuid_gateway]",
          JSON.stringify({
            event: "thumbnail_policy",
            source,
            thumbnailConfigured: !!thumbnailSuffix,
            thumbnailSuffix,
            posterSuffix,
            effectiveSuffix,
            transformConfigured:
              typeof config?.transform_pattern === "string" &&
              !!config.transform_pattern,
          }),
        );
      } catch (_) {}
    }
    static asbVariantUrl(
      value,
      { playback = true, config = null, thumbnail = false } = {},
    ) {
      try {
        const url = new URL(value);
        if (
          url.origin !== "https://flow.google.com" ||
          !url.pathname.startsWith("/asb/")
        )
          return "";
        if (playback && /=mm,\d+,\d+$/.test(url.pathname)) return url.href;
        const cfg = config
          ? this.mediaUrlConfig(config)
          : this.mediaUrlConfig();
        const suffix = playback
          ? cfg?.playback_url_suffix
          : thumbnail
            ? cfg?.thumbnail_url_suffix || cfg?.image_url_suffix
            : cfg?.image_url_suffix;
        if (!playback && thumbnail) this._reportThumbnailPolicy(cfg, suffix);
        const pattern = cfg?.transform_pattern;
        if (
          typeof suffix !== "string" ||
          !/^=(?:s\d+(?:-[a-z]+)*|mm,\d+,\d+)$/.test(suffix) ||
          typeof pattern !== "string" ||
          !pattern ||
          pattern.length > 120
        )
          return "";
        url.pathname =
          url.pathname.replace(new RegExp(pattern, "i"), "") + suffix;
        return url.href;
      } catch (_) {
        return "";
      }
    }
    static async playbackUrl(value, { resolution = null } = {}) {
      if (!value) return "";
      let url;
      try {
        url = new URL(value);
      } catch (_) {
        return "";
      }
      if (
        url.origin !== "https://flow.google.com" ||
        !url.pathname.startsWith("/asb/") ||
        (!resolution && /=mm,\d+,\d+$/.test(url.pathname))
      )
        return value;
      const config = await this.mediaUrlConfigAsync();
      if (resolution) {
        if (!/^\/asb\/[A-Za-z0-9_-]+(?:=mm,\d+,\d+)?$/.test(url.pathname))
          return value;
        const suffix = config?.playback_url_suffix_by_resolution?.[resolution];
        if (typeof suffix !== "string" || !/^=mm,\d+,\d+$/.test(suffix))
          return value;
        url.pathname = url.pathname.replace(/=mm,\d+,\d+$/, "") + suffix;
        return url.href;
      }
      return this.asbVariantUrl(value, { config });
    }
    static applyResultMetadata(result, info, options = {}) {
      const record = this.resultMetadata(result);
      if (!record.project_id && options.projectId)
        record.project_id = options.projectId;
      const next = this.reconcileMetadata(record, info, options);
      if (next === record) return result;
      return {
        ...result,
        mediaUuid: next.media_uuid || result.mediaUuid,
        mediaId: next.persistent_media_id || result.mediaId,
        fileName: next.file_name || result.fileName,
        ...(next.thumbnail && {
          thumbnail:
            result.video && next.thumb_is_poster === false
              ? null
              : next.thumbnail,
        }),
        ...(next.source_thumbnail && {
          sourceThumbnail: next.source_thumbnail,
        }),
        ...(result.video
          ? {
              playUrl: next.video_url,
              playback_url_source:
                next.playback_url_source || result.playback_url_source,
              ...(next.thumbnail && {
                poster:
                  next.thumb_is_poster !== false &&
                  next.thumbnail !== next.video_url,
              }),
            }
          : { url: next.image_url || next.thumbnail || result.url }),
      };
    }
    static snapshotMetadata(identities, context = {}) {
      if (!identities?.length) return {};
      const read =
        root._flowUuidGatewaySnapshotPrimitive || root._lookupFlowMediaCatalog;
      if (typeof read !== "function") return {};
      const catalog = read(identities);
      if (
        catalog?.snapshotSource !== "observer" ||
        (context.projectId && key(context.projectId) !== key(catalog.projectId))
      )
        return {};
      const results = Object.create(null);
      for (const id of identities) {
        const info = catalog.known?.[id];
        if (!info) continue;
        const verdict = this._normalize(
          id,
          info,
          { ...context, projectId: catalog.projectId },
          "catalog",
        );
        if (verdict.ok) results[id] = verdict.metadata;
      }
      return results;
    }
    static _normalize(uuid, raw, context, source) {
      const info = raw?.metadata || raw;
      if (!info || (isUuid(uuid) && key(info.media_uuid) !== key(uuid)))
        return this._unknown(uuid, "identity_mismatch");
      const projectId =
        context.expectedFlowTarget?.projectId || context.projectId;
      if (
        projectId &&
        info.project_id &&
        key(projectId) !== key(info.project_id)
      )
        return this._unknown(uuid, "project_mismatch");
      const expected = (context.ownerRecords || []).filter(
        (owner) =>
          key(owner.mediaUuid || owner.media_uuid || owner.resultId) ===
          key(uuid),
      );
      const types = new Set(
        expected.map((owner) => owner.mediaType || owner.type).filter(Boolean),
      );
      if (
        types.size > 1 ||
        (context.mediaType && types.size && !types.has(context.mediaType)) ||
        ((context.mediaType || [...types][0]) &&
          info.type !== (context.mediaType || [...types][0]))
      ) {
        return this._unknown(uuid, "type_mismatch");
      }
      const metadata = {
        media_uuid: info.media_uuid || null,
        project_id: info.project_id || projectId || null,
        type: info.type || null,
        asb: null,
        persistent_media_id: null,
        file_name: null,
        thumbnail: null,
        source_thumbnail: null,
        image_url: null,
        video_url: null,
        ...info,
      };
      delete metadata.source;
      const asb = this.isAsb(info.persistent_media_id);
      metadata.asb = asb ? info.persistent_media_id : null;
      if (metadata.type === "video") metadata.image_url = null;
      else metadata.video_url = null;
      const hint = raw?.navigation;
      const navigation =
        hint?.version === 1 &&
        hint.source === "native_collection" &&
        key(hint.projectId) === key(projectId) &&
        !!projectId &&
        hint.documentEpoch === raw?.evidence?.documentEpoch &&
        typeof hint.catalogEpoch === "string" &&
        hint.catalogEpoch.length <= 128 &&
        Number.isSafeInteger(hint.revision) &&
        hint.revision > 0 &&
        Number.isSafeInteger(hint.count) &&
        hint.count >= 2 &&
        hint.count <= 4096 &&
        Number.isSafeInteger(hint.index) &&
        hint.index >= 0 &&
        hint.index < hint.count
          ? {
              version: 1,
              source: "native_collection",
              projectId: hint.projectId,
              documentEpoch: hint.documentEpoch,
              catalogEpoch: hint.catalogEpoch,
              revision: hint.revision,
              index: hint.index,
              count: hint.count,
            }
          : null;
      return {
        ok: true,
        status: "found",
        uuid,
        ...(navigation && { navigation }),
        evidence: {
          source: raw?.evidence?.source || source,
          documentEpoch: raw?.evidence?.documentEpoch || null,
          snapshotSource: raw?.evidence?.snapshotSource || null,
        },
        metadata,
      };
    }
    static async _target(context) {
      if (typeof root._flowUuidGatewayTargetPrimitive === "function")
        return root._flowUuidGatewayTargetPrimitive(context);
      if (typeof root._flowUuidGatewayWebPrimitive === "function")
        return context.expectedFlowTarget || null;
      const live = await root.MessageBridge?.getTargetContext?.(
        context.expectedFlowTarget || null,
      );
      const expected = context.expectedFlowTarget;
      const pinnedTabId =
        context.flowTabId ??
        context.flowApiTabId ??
        context.apiContext?.flowTabId ??
        context.apiContext?.flowApiTabId;
      if (Number.isInteger(pinnedTabId) && live?.tabId !== pinnedTabId)
        throw this.error("FLOW_EXECUTION_TARGET_CHANGED");
      if (
        expected &&
        (!live ||
          ["tabId", "projectId", "origin", "driverKey", "routePrefix"].some(
            (field) =>
              field === "projectId"
                ? key(expected[field]) !== key(live[field])
                : (expected[field] || null) !== (live[field] || null),
          ))
      )
        throw this.error("FLOW_EXECUTION_TARGET_CHANGED");
      if (
        context.projectId &&
        live?.projectId &&
        key(live.projectId) !== key(context.projectId)
      )
        throw this.error("PROJECT_MISMATCH");
      return live ? { ...(expected || {}), ...live } : expected || null;
    }
    static async _apiStatus(context) {
      if (typeof root._flowUuidGatewayApiStatusPrimitive === "function")
        return root._flowUuidGatewayApiStatusPrimitive(context);
      const settings = root.storageSettings?.getSettings?.() || {};
      const mode = context.mode || settings.defaultGenMode || settings.gen_mode;
      if (
        !["api", "auto"].includes(mode) ||
        (settings.defaultGenMode || settings.gen_mode) === "web" ||
        ![true, 1, "true"].includes(settings.apiModeEnabled) ||
        context.requireWebInteraction === true ||
        !root.FlowApiAdapter?.isApiModeIntended?.({
          executionMode: mode,
          forWorkflow: ["workflow", "motion"].includes(context.surface),
          forDownload: context.purpose === "download",
        })
      )
        return null;
      const health = await root.FlowApiSessionCoordinator?.check?.({
        passive: false,
        force: false,
        surface: context.surface || "gen",
        driver: context.apiContext?.apiDriver || void 0,
        projectId: context.expectedFlowTarget?.projectId || context.projectId,
        flowTabId: context.expectedFlowTarget?.tabId,
        mediaType: context.mediaType || "image",
      });
      const config =
        health?.ready === true && health.driver === "v2"
          ? await root.ProviderConfigManager?.fetchFlowApiV2Configs?.()
          : null;
      abort(context);
      const currentSettings = root.storageSettings?.getSettings?.() || {};
      if (
        !["api", "auto"].includes(
          context.mode ||
            currentSettings.defaultGenMode ||
            currentSettings.gen_mode,
        ) ||
        (currentSettings.defaultGenMode || currentSettings.gen_mode) ===
          "web" ||
        ![true, 1, "true"].includes(currentSettings.apiModeEnabled) ||
        health?.ready !== true ||
        !root.FlowApiAdapter.isApiModeIntended({
          executionMode: mode,
          forWorkflow: ["workflow", "motion"].includes(context.surface),
          forDownload: context.purpose === "download",
        })
      )
        return null;
      return {
        ...health,
        maxConcurrent: config?.runtime?.max_concurrent || null,
        ...(config &&
          health.driver === "v2" && {
            readContext: {
              protocolRevision: Number(config.protocol?.schema_version) || null,
              protocolFingerprint:
                root.FlowApiV2CheckpointStore?.fingerprint?.(config) || null,
            },
          }),
      };
    }
    static async _webPrimitive(ids, context) {
      if (typeof root._flowUuidGatewayWebPrimitive === "function")
        return root._flowUuidGatewayWebPrimitive(ids, context);
      if (!root.MessageBridge?.sendToContentScript)
        return { results: {}, reason: "transport_unavailable" };
      return root.MessageBridge.sendToContentScript(
        "flowUuidGatewayRead",
        {
          identities: ids,
          ownerRecords: context.ownerRecords || [],
          expectedFlowTarget: context.expectedFlowTarget,
          operationId: context.operationId,
          mediaType: context.mediaType || null,
        },
        { signal: context.signal },
      );
    }
    static _web(ids, context) {
      const scope = JSON.stringify([
        context.expectedFlowTarget || null,
        context.projectId || null,
        this._epoch,
      ]);
      let batch = this._webReads.get(scope);
      if (!batch) {
        batch = { ids: new Set(), waiters: [] };
        this._webReads.set(scope, batch);
        Promise.resolve().then(async () => {
          this._webReads.delete(scope);
          const joined = [...batch.ids],
            combined = { results: {}, complete: true, fresh: true };
          try {
            for (let at = 0; at < joined.length; at += 256) {
              const read = await this._webPrimitive(
                joined.slice(at, at + 256),
                {
                  ...context,
                  signal: void 0,
                  abortFn: void 0,
                  ownerRecords: [],
                  mediaType: void 0,
                },
              );
              if (read?.error) throw this.error(read.error);
              if (
                at > 0 &&
                (combined.documentEpoch || null) !==
                  (read?.documentEpoch || null)
              ) {
                throw this.error("FLOW_MEDIA_DOCUMENT_CHANGED");
              }
              const complete = combined.complete && read?.complete === true,
                fresh = combined.fresh && read?.fresh === true;
              Object.assign(combined, {
                ...read,
                complete,
                fresh,
                results: { ...combined.results, ...(read?.results || {}) },
              });
            }
            for (const waiter of batch.waiters) waiter.resolve(combined);
          } catch (error) {
            for (const waiter of batch.waiters) waiter.reject(error);
          }
        });
      }
      for (const id of ids) batch.ids.add(id);
      const promise = new Promise((resolve, reject) =>
        batch.waiters.push({ resolve, reject }),
      );
      if (!context.signal) return promise;
      let onAbort;
      const stopped = new Promise((_, reject) => {
        onAbort = () =>
          reject(
            Object.assign(new Error("Aborted"), {
              name: "AbortError",
              code: "ABORTED",
              noRetry: true,
            }),
          );
        context.signal.addEventListener("abort", onAbort, { once: true });
        if (context.signal.aborted) onAbort();
      });
      return Promise.race([promise, stopped]).finally(() =>
        context.signal.removeEventListener("abort", onAbort),
      );
    }
    static async resolve(identities, context = {}) {
      return this._traceOperation("resolve", context, (scoped) =>
        this._resolve(identities, scoped, null),
      );
    }
    static async listMedia(context = {}) {
      return this._traceOperation(
        "listMedia",
        { surface: "picker", purpose: "preview", ...context },
        async (scoped) => {
          const epoch = this._epoch;
          abort(scoped);
          this._diagnostic(scoped, "library_target_start");
          const target = await this._target(scoped);
          scoped.expectedFlowTarget = target;
          scoped.projectId = target?.projectId || scoped.projectId;
          this._diagnostic(scoped, "library_read_start");
          const response = await root.MessageBridge.sendToContentScript(
            "scanFlowImages",
            { deep: false, expectedFlowTarget: target },
            { signal: scoped.signal },
          );
          this._diagnostic(scoped, "library_read_finish", {
            available: response?.images?.length || 0,
            contentMs: Number.isFinite(response?.timing?.totalMs)
              ? response.timing.totalMs
              : null,
          });
          abort(scoped);
          await this._target({ ...scoped, expectedFlowTarget: target });
          abort(scoped);
          if (epoch !== this._epoch)
            throw this.error("FLOW_MEDIA_LOOKUP_SCOPE_CHANGED");
          if (
            response?.projectId &&
            target?.projectId &&
            key(response.projectId) !== key(target.projectId)
          )
            throw this.error("FLOW_EXECUTION_TARGET_CHANGED");
          if (response?.error) throw this.error(response.error);
          const projectId = target?.projectId || response?.projectId || null;
          const images = (response?.images || [])
            .filter(
              (media) =>
                !media.project_id ||
                !projectId ||
                key(media.project_id) === key(projectId),
            )
            .map((media) =>
              this.normalizePosterMetadata({
                ...media,
                ...(projectId && { project_id: projectId }),
              }),
            );
          this._diagnostic(scoped, "library_read", {
            available: images.length,
            complete: false,
            catalogAvailable: Number(response?.catalogStatus?.available) || 0,
          });
          return {
            ...response,
            images,
            projectId: target?.projectId || response?.projectId || null,
            complete: false,
          };
        },
      );
    }
    static async lookupCatalog(identities, options = {}) {
      const lookup = await this.resolve(identities, {
        ...options,
        mode: options.mode || "web",
      });
      const known = Object.fromEntries(
        Object.entries(lookup.results)
          .filter(([, result]) => result.ok)
          .map(([id, result]) => [id, result.metadata]),
      );
      const target = lookup.target || options.expectedFlowTarget || null;
      return {
        supported: target?.driverKey === "flow_v2",
        projectId: target?.projectId || null,
        known,
        unknown: (identities || []).filter((id) => !known[id]),
        complete: false,
        navigation: Object.fromEntries(
          Object.entries(lookup.results)
            .filter(([, value]) => value.ok && value.navigation)
            .map(([id, value]) => [id, value.navigation]),
        ),
        failed: lookup.failed,
        unresolved: lookup.unresolved,
        gateway: true,
        aliases: lookup.catalogStatus?.aliases ?? null,
        revision: lookup.catalogStatus?.revision ?? null,
        snapshotSource: lookup.catalogStatus?.source || null,
        reason: lookup.catalogStatus?.reason || "metadata_read_unavailable",
      };
    }
    static async _resolve(identities, context, refreshedDocumentEpoch) {
      abort(context);
      const scopeEpoch = this._epoch;
      const assertScope = () => {
        abort(context);
        if (this._epoch !== scopeEpoch)
          throw this.error("FLOW_MEDIA_LOOKUP_SCOPE_CHANGED");
      };
      const started = Date.now(),
        requested = [
          ...new Set(
            (Array.isArray(identities) ? identities : []).filter(
              (id) => typeof id === "string" && id,
            ),
          ),
        ];
      const ids = [...new Set(requested.map(key))];
      const results = Object.create(null),
        failed = [],
        unresolved = [];
      if (!ids.length)
        return { results, failed, unresolved, effectiveMode: "web" };
      context = { ...context, expectedFlowTarget: await this._target(context) };
      context.projectId =
        context.expectedFlowTarget?.projectId || context.projectId;
      for (const id of ids) {
        const types = new Set(
          (context.ownerRecords || [])
            .filter(
              (owner) =>
                key(owner.mediaUuid || owner.media_uuid || owner.resultId) ===
                id,
            )
            .map((owner) => owner.mediaType || owner.type)
            .filter(Boolean),
        );
        if (
          types.size > 1 ||
          (context.mediaType && types.size && !types.has(context.mediaType))
        )
          results[id] = this._unknown(id, "type_mismatch");
      }
      context.lookupMediaIds = ids.filter((id) => isUuid(id) && !results[id]);
      assertScope();
      let health = null;
      try {
        if (ids.some((id) => !results[id]))
          health = await this._apiStatus(context);
      } catch (error) {
        this._diagnostic(context, "api_status_error", {
          code: this._diagnosticCode(error?.code || error?.name),
        });
        abort(context);
      }
      assertScope();
      const apiRead =
        root._flowUuidGatewayApiReadPrimitive ||
        root.FlowApiFacade?._resolveMediaPrimitive?.bind(root.FlowApiFacade);
      const apiConcurrency =
        Number.isInteger(health?.maxConcurrent) && health.maxConcurrent > 0
          ? Math.min(4, health.maxConcurrent)
          : 0;
      const api = health?.driver === "v2" && apiRead && apiConcurrency > 0;
      let effectiveMode = api ? "api" : "web";
      this._diagnostic(context, "mode", {
        requested: ids.length,
        requestedMode: ["api", "auto", "web"].includes(context.mode)
          ? context.mode
          : "settings",
        effectiveMode,
        apiReady: health?.ready === true,
        webInteraction: context.requireWebInteraction === true,
        reread: !!refreshedDocumentEpoch,
      });
      let webDocumentEpoch,
        webReadStarted = false,
        catalogStatus = null;
      for (let offset = 0; offset < ids.length; offset += 256) {
        assertScope();
        const chunk = ids
            .slice(offset, offset + 256)
            .filter((id) => !results[id]),
          pending = [];
        if (api) {
          for (let at = 0; at < chunk.length; at += apiConcurrency)
            await Promise.all(
              chunk.slice(at, at + apiConcurrency).map(async (id) => {
                assertScope();
                if (!isUuid(id)) {
                  pending.push(id);
                  return;
                }
                try {
                  const owner = (context.ownerRecords || []).find(
                    (owner2) =>
                      key(
                        owner2.mediaUuid ||
                          owner2.media_uuid ||
                          owner2.resultId,
                      ) === key(id),
                  );
                  const mediaType =
                    context.mediaType ||
                    owner?.mediaType ||
                    owner?.type ||
                    "image";
                  const provenance =
                    context.apiContext?.providerData?.media_uuid ||
                    context.apiContext?.media_uuid;
                  if (isUuid(provenance) && key(provenance) !== id) {
                    pending.push(id);
                    return;
                  }
                  this._diagnostic(context, "api_read_start", {
                    identity: this._fingerprint(id),
                    mediaType,
                  });
                  const value = await apiRead({
                    ...context.apiContext,
                    ...health.readContext,
                    ...(context.apiContext?.providerData && {
                      providerData: {
                        ...context.apiContext.providerData,
                        ...(isUuid(provenance) && { media_uuid: id }),
                      },
                    }),
                    media_uuid: id,
                    mediaId: id,
                    projectId:
                      context.expectedFlowTarget?.projectId ||
                      context.projectId,
                    mediaType,
                    apiDriver: health.driver,
                    uuidLookup: true,
                    identityOnly: true,
                    flowTabId: context.expectedFlowTarget?.tabId,
                    abortFn: () =>
                      context.signal?.aborted || context.abortFn?.() === true,
                  });
                  assertScope();
                  this._diagnostic(context, "api_read_finish", {
                    identity: this._fingerprint(id),
                    sameProject:
                      !!value?.projectId &&
                      key(value.projectId) === key(context.projectId),
                    sameUuid:
                      isUuid(value?.mediaId) && key(value.mediaId) === id,
                    hasUrl: !!value?.url,
                    hasPoster: !!value?.posterUrl,
                  });
                  if (
                    !value?.projectId ||
                    key(value.projectId) !== key(context.projectId)
                  ) {
                    pending.push(id);
                    return;
                  }
                  const info = {
                    media_uuid: value.mediaId,
                    project_id: value.projectId,
                    type: mediaType,
                    thumbnail:
                      value.posterUrl ||
                      (mediaType !== "video" ? value.url : null),
                    image_url: mediaType !== "video" ? value.url : null,
                    video_url: mediaType === "video" ? value.url : null,
                  };
                  const verdict = this._normalize(id, info, context, "api");
                  if (verdict.ok) results[id] = verdict;
                  else pending.push(id);
                } catch (error) {
                  this._diagnostic(context, "api_read_error", {
                    identity: this._fingerprint(id),
                    code: this._diagnosticCode(error?.code || error?.name),
                  });
                  assertScope();
                  pending.push(id);
                }
              }),
            );
        } else pending.push(...chunk);
        if (pending.length) {
          this._diagnostic(context, "web_read_start", {
            requested: pending.length,
            afterApiRead: api,
            passive: context.passive === true,
            preview: context.purpose === "preview",
          });
          let read = await this._web(pending, context);
          assertScope();
          if (read?.catalogStatus) {
            const count = (value) =>
              Number.isSafeInteger(value) && value >= 0 ? value : null;
            catalogStatus = {
              aliases: count(read.catalogStatus.aliases),
              revision: count(read.catalogStatus.revision),
              source: ["observer", "cache"].includes(read.catalogStatus.source)
                ? read.catalogStatus.source
                : null,
              reason: this._diagnosticCode(read.catalogStatus.reason),
            };
          }
          this._diagnostic(context, "web_read_finish", {
            requested: pending.length,
            complete: read?.complete === true,
            fresh: read?.fresh === true,
            document: this._fingerprint(read?.documentEpoch),
            reason: this._diagnosticCode(read?.reason),
            catalogSource: this._diagnosticCode(read?.catalogStatus?.source),
            catalogReason: this._diagnosticCode(read?.catalogStatus?.reason),
            catalogAliases: Number(read?.catalogStatus?.aliases) || 0,
            catalogKnown: Number(read?.catalogStatus?.known) || 0,
            catalogUnknown: Number(read?.catalogStatus?.unknown) || 0,
            catalogRevision: Number(read?.catalogStatus?.revision) || 0,
            observerState: this._diagnosticCode(
              read?.catalogStatus?.observerStatus?.state,
            ),
            observerStage: this._diagnosticCode(
              read?.catalogStatus?.observerStatus?.stage,
            ),
            observerSchemaEpoch:
              Number(read?.catalogStatus?.observerStatus?.schemaEpoch) || 0,
            observerAliases:
              Number(read?.catalogStatus?.observerStatus?.aliases) || 0,
            observerUuidEvidence:
              Number(read?.catalogStatus?.observerStatus?.uuidEvidence) || 0,
            observerRows:
              Number(read?.catalogStatus?.observerStatus?.rows) || 0,
            observerLargestCollection:
              read?.catalogStatus?.observerStatus?.largestCollection || null,
            observerLastRejection:
              read?.catalogStatus?.observerStatus?.lastRejection || null,
            observerRevision:
              Number(read?.catalogStatus?.observerStatus?.observerRevision) ||
              0,
            observerInstance: this._fingerprint(
              read?.catalogStatus?.observerStatus?.observerInstance,
            ),
            observerReplaced:
              read?.catalogStatus?.observerStatus?.observerBoot?.replaced ===
              true,
            observerPreviousRevision:
              Number(
                read?.catalogStatus?.observerStatus?.observerBoot
                  ?.previousRevision,
              ) || 0,
            observerPreviousAliases:
              Number(
                read?.catalogStatus?.observerStatus?.observerBoot
                  ?.previousAliases,
              ) || 0,
            observerPreviousProjectMatched:
              read?.catalogStatus?.observerStatus?.observerBoot?.sameProject ===
              true,
            observerCatalogHandoff: read?.catalogStatus?.observerStatus
              ?.catalogHandoff
              ? {
                  state: this._diagnosticCode(
                    read.catalogStatus.observerStatus.catalogHandoff.state,
                  ),
                  aliases:
                    Number(
                      read.catalogStatus.observerStatus.catalogHandoff.aliases,
                    ) || 0,
                  uuidEvidence:
                    Number(
                      read.catalogStatus.observerStatus.catalogHandoff
                        .uuidEvidence,
                    ) || 0,
                }
              : null,
            observerSchemaTransition: this._schemaTransitionDiagnostic(
              read?.catalogStatus?.observerStatus?.schemaTransition,
            ),
          });
          if (read?.error) throw this.error(read.error);
          if (
            webReadStarted &&
            webDocumentEpoch !== (read?.documentEpoch || null)
          ) {
            throw this.error("FLOW_MEDIA_DOCUMENT_CHANGED");
          }
          webReadStarted = true;
          webDocumentEpoch = read?.documentEpoch || null;
          if (
            (context.expectedFlowTarget?.projectId || context.projectId) &&
            read?.projectId &&
            key(read.projectId) !==
              key(context.expectedFlowTarget?.projectId || context.projectId)
          )
            throw this.error("PROJECT_MISMATCH");
          if (
            refreshedDocumentEpoch &&
            read?.documentEpoch !== refreshedDocumentEpoch
          ) {
            read = {
              results: {},
              complete: false,
              fresh: false,
              reason: "document_not_refreshed",
            };
          }
          for (const id of pending) {
            const raw = read?.results?.[id];
            results[id] =
              raw?.ok && raw.metadata
                ? this._normalize(
                    id,
                    raw,
                    context,
                    raw.evidence?.source || "dom",
                  )
                : this._unknown(
                    id,
                    raw?.reason || read?.reason || "not_observed",
                  );
            if (
              isUuid(id) &&
              raw?.status === "not_found" &&
              read?.complete === true &&
              read?.fresh === true
            ) {
              results[id] = {
                ok: false,
                status: "not_found",
                uuid: id,
                code: "FLOW_MEDIA_UUID_NOT_FOUND",
                metadata: null,
              };
            }
          }
        }
      }
      assertScope();
      let diagnosticIndex = 0;
      for (const id of ids) {
        results[id] || (results[id] = this._unknown(id, "not_observed"));
        if (results[id].ok && results[id].metadata)
          results[id] = {
            ...results[id],
            metadata: this.normalizePosterMetadata(results[id].metadata),
          };
        if (diagnosticIndex++ < 16) {
          const verdict = results[id],
            metadata = verdict.metadata;
          this._diagnostic(context, "verdict", {
            identity: this._fingerprint(id),
            uuid: isUuid(id),
            status: verdict.ok
              ? "found"
              : verdict.status === "not_found"
                ? "not_found"
                : "unresolved",
            reason: this._diagnosticCode(verdict.reason || verdict.code),
            source: this._diagnosticCode(verdict.evidence?.source),
            navigationIndex: verdict.navigation?.index ?? null,
            navigationCount: verdict.navigation?.count ?? null,
            navigationRevision: verdict.navigation?.revision ?? null,
            mediaType: ["image", "video"].includes(metadata?.type)
              ? metadata.type
              : null,
            hasAsb:
              this.isAsb(metadata?.asb) ||
              this.isAsb(metadata?.persistent_media_id),
            asbIdentity: this._fingerprint(
              [
                metadata?.asb,
                metadata?.persistent_media_id,
                metadata?.file_name,
              ].find((value) => this.isAsb(value)),
            ),
            hasThumbnail: !!metadata?.thumbnail,
            hasImage: !!metadata?.image_url,
            hasPlayback: !!metadata?.video_url,
          });
        }
        if (results[id].status === "not_found") failed.push(id);
        else if (!results[id].ok) unresolved.push(id);
      }
      for (const input of requested)
        if (input !== key(input)) results[input] = results[key(input)];
      let refresh = null;
      if (
        !refreshedDocumentEpoch &&
        unresolved.length &&
        context.generationProcessId &&
        context.expectedFlowTarget &&
        context.passive !== true &&
        ["reference", "download", "rescan"].includes(context.purpose)
      ) {
        const request = {
          generationProcessId: context.generationProcessId,
          expectedFlowTarget: context.expectedFlowTarget,
          identities: unresolved,
          requestId: context.operationId || null,
        };
        try {
          refresh = root._flowUuidGatewayRefreshPrimitive
            ? await root._flowUuidGatewayRefreshPrimitive(request)
            : await root.chrome?.runtime?.sendMessage?.({
                action: "flowUuidGatewayRefresh",
                request,
              });
          const queue = root.PromptQueue?._instance;
          if (
            refresh?.state === "deferred" &&
            refresh.reason === "controlled_owner_required" &&
            queue?.forceReloadAndStabilize &&
            !queue._editorExecutor?.currentItem &&
            !queue._editorExecutor?.isDownloading &&
            !queue._itemQueue?.length &&
            !queue._downloadQueue?.length
          ) {
            assertScope();
            const performed = await queue.forceReloadAndStabilize(
              "uuid-gateway-identity-refresh",
              {
                generationProcessId: context.generationProcessId,
                identities: unresolved,
                expectedFlowTarget: context.expectedFlowTarget,
                signal: context.signal,
                abortFn: context.abortFn,
              },
            );
            assertScope();
            if (performed)
              refresh = await root.chrome.runtime.sendMessage({
                action: "flowUuidGatewayRefresh",
                request,
              });
          }
        } catch (_) {
          refresh = { state: "deferred", reason: "coordinator_unavailable" };
        }
        assertScope();
        this._diagnostic(context, "refresh", {
          state: this._diagnosticCode(refresh?.state),
          reason: this._diagnosticCode(refresh?.reason),
        });
        if (
          refresh?.state === "finished" &&
          typeof refresh.documentEpoch === "string" &&
          refresh.documentEpoch
        ) {
          const reread = await this._resolve(
            requested,
            { ...context, mode: "web" },
            refresh.documentEpoch,
          );
          return { ...reread, refresh };
        }
      }
      await this._target(context);
      assertScope();
      this._diagnostic(context, "summary", {
        effectiveMode,
        requested: ids.length,
        found: ids.length - failed.length - unresolved.length,
        failed: failed.length,
        unresolved: unresolved.length,
        omittedIdentities: Math.max(0, ids.length - 16),
        lookupMs: Date.now() - started,
      });
      return {
        results,
        effectiveMode,
        failed,
        unresolved,
        refresh,
        catalogStatus,
        legacyActionAvailable: health?.ready === true && health.driver === "v1",
        target: context.expectedFlowTarget
          ? { ...context.expectedFlowTarget }
          : null,
      };
    }
    static async checkReferenceProject({
      item,
      mediaId,
      config,
      abortFn,
    } = {}) {
      const epoch = this._epoch;
      const context = {
        mode: "api",
        surface: "gen",
        projectId: item?.projectId,
        flowApiTabId: item?.flowApiTabId,
        expectedFlowTarget: item?.flowTarget || null,
        mediaType: /video/i.test(item?.settings?.genType || "")
          ? "video"
          : "image",
        abortFn,
      };
      const assertScope = () => {
        abort(context);
        if (epoch !== this._epoch)
          throw this.error("FLOW_MEDIA_LOOKUP_SCOPE_CHANGED");
      };
      assertScope();
      context.expectedFlowTarget = await this._target(context);
      assertScope();
      const health = await this._apiStatus(context);
      assertScope();
      if (
        health?.ready !== true ||
        health.driver !== "v2" ||
        !Number.isInteger(health.maxConcurrent) ||
        health.maxConcurrent < 1
      ) {
        return { status: "unresolved", checkCode: "FLOW_MEDIA_API_INACTIVE" };
      }
      const pinnedItem = {
        ...item,
        ...(Number.isInteger(context.expectedFlowTarget?.tabId)
          ? { flowApiTabId: context.expectedFlowTarget.tabId }
          : {}),
      };
      const response =
        await root.FlowApiV2Driver._readReferenceProjectPrimitive(
          pinnedItem,
          mediaId,
          config,
          { abortFn },
        );
      await this._target(context);
      assertScope();
      if (
        response?.ok === true &&
        key(response.output?.mediaId) === key(mediaId) &&
        key(response.output?.projectId) === key(item.projectId)
      )
        return { status: "valid" };
      if (
        response?.ok !== true &&
        response?.error === "LINEAGE_MISMATCH" &&
        response?.diagnostic?.lineageCheck === "resolved projectId"
      ) {
        return {
          status: "other_project",
          checkCode: "LINEAGE_MISMATCH",
          lineageCheck:
            root.FlowApiDriverError?.safeLineageCheck?.(response) || null,
        };
      }
      return {
        status: "unresolved",
        checkCode:
          response?.ok === true
            ? "V2_RESOLVE_IDENTITY_MISMATCH"
            : response?.error,
      };
    }
    static async resolveMedia(input) {
      const pinnedDriver =
        input.apiDriver || input.api_driver || input.providerData?.api_driver;
      if (!pinnedDriver || pinnedDriver === "v1") {
        abort(input);
        const epoch = this._epoch;
        const pinned = {
          ...input,
          expectedFlowTarget: await this._target(input),
        };
        const health = await this._apiStatus(pinned);
        abort(input);
        if (epoch !== this._epoch)
          throw this.error("FLOW_MEDIA_LOOKUP_SCOPE_CHANGED");
        if (health?.driver === "v1" && health.ready === true) {
          await this._target(pinned);
          const reader =
            root._flowUuidGatewayApiReadPrimitive ||
            root.FlowApiFacade?._resolveMediaPrimitive?.bind(
              root.FlowApiFacade,
            );
          const payload = await reader({ ...input, apiDriver: "v1" });
          abort(input);
          if (epoch !== this._epoch)
            throw this.error("FLOW_MEDIA_LOOKUP_SCOPE_CHANGED");
          await this._target(pinned);
          return payload;
        }
      }
      const response = await this.resolve([input.mediaId], {
        ...input,
        apiContext: input,
      });
      const verdict = response.results[input.mediaId];
      if (verdict?.status === "not_found") throw this.error();
      if (!verdict?.ok) throw this.error("FLOW_MEDIA_UUID_UNRESOLVED");
      const info = verdict.metadata;
      return {
        url:
          input.mediaType === "image"
            ? info.image_url || info.thumbnail
            : info.video_url,
        posterUrl: info.thumbnail || null,
        mediaId: info.media_uuid,
        projectId: info.project_id,
        revoke: false,
        metadata: info,
        effectiveMode: response.effectiveMode,
      };
    }
    static async requireDownload(identities, context = {}) {
      return this._traceOperation("requireDownload", context, (scoped) =>
        this._requireDownload(identities, scoped),
      );
    }
    static async _requireDownload(identities, context = {}) {
      const ids = (identities || []).filter(Boolean);
      const uuids = ids.filter(isUuid);
      const response = await this.resolve(uuids.length ? uuids : ids, {
        ...context,
        purpose: "download",
      });
      this._diagnostic(context, "download_decision", {
        requested: ids.length,
        decision: response.failed.length ? "not_found" : "continue",
        unresolved: response.unresolved.length,
      });
      if (response.failed.length) throw this.error();
      return response;
    }
    static async controlledRefresh(context, work) {
      return this._traceOperation("controlledRefresh", context, (scoped) =>
        this._controlledRefresh(scoped, work),
      );
    }
    static async _controlledRefresh(context, work) {
      const decision = (reason, fields = {}) => {
        this._diagnostic(context, "controlled_refresh_decision", {
          reason,
          ...fields,
        });
        const failure =
          fields.code ||
          ([
            "process_missing",
            "target_missing",
            "document_epoch_missing",
            "timeout_config_missing",
            "join_not_running",
            "join_timeout",
          ].includes(reason)
            ? reason
            : null) ||
          (fields.state &&
          !["owner", "finished", "joined", "already_dispatched"].includes(
            fields.state,
          )
            ? reason
            : null) ||
          (reason === "work_finished" &&
          fields.result === true &&
          !fields.documentChanged
            ? "document_not_refreshed"
            : null);
        try {
          if (failure) context.onDecision?.(failure);
        } catch (_) {}
      };
      abort(context);
      const scopeEpoch = this._epoch;
      const assertRefreshScope = () => {
        abort(context);
        if (this._epoch !== scopeEpoch)
          throw this.error("FLOW_MEDIA_LOOKUP_SCOPE_CHANGED");
      };
      if (!context.generationProcessId) {
        decision("process_missing");
        return false;
      }
      const target = await this._target(context);
      if (!Number.isInteger(target?.tabId) || !target.projectId) {
        decision("target_missing");
        return false;
      }
      const request = {
        generationProcessId: context.generationProcessId,
        expectedFlowTarget: target,
        identities: (context.identities || []).filter(isUuid),
        requestId: context.operationId || null,
      };
      const readEpoch = async () => {
        const alive = await root.MessageBridge.sendToContentScript(
          "checkContentScriptAlive",
          { expectedFlowTarget: target },
        );
        return typeof alive?.documentEpoch === "string"
          ? alive.documentEpoch
          : null;
      };
      const beforeEpoch = await readEpoch();
      if (!beforeEpoch) {
        decision("document_epoch_missing");
        return false;
      }
      const rpc = (action) =>
        root.chrome.runtime.sendMessage({ action, request });
      const begun = await rpc("flowUuidControlledBegin");
      decision(this._diagnosticCode(begun?.reason), {
        state: this._diagnosticCode(begun?.state),
        hasTicket: !!begun?.ticket,
        requested: request.identities.length,
        ownerSource: this._diagnosticCode(begun?.ownerSource),
      });
      try {
        abort(context);
      } catch (error) {
        if (begun?.state === "owner")
          await root.chrome.runtime
            .sendMessage({
              action: "flowUuidControlledFinish",
              request: {
                ...request,
                ticket: begun.ticket,
                notDispatched: true,
              },
            })
            .catch(() => {});
        throw error;
      }
      if (begun?.state === "finished") {
        decision("completed_budget", {
          sameDocument: begun.documentEpoch === beforeEpoch,
        });
        return begun.documentEpoch === beforeEpoch;
      }
      if (begun?.state === "joined" || begun?.state === "already_dispatched") {
        const timeout = Number(
          root.SystemConfig?.safeGetTimeout?.("api_timeout_ms"),
        );
        if (!(timeout > 0)) {
          decision("timeout_config_missing");
          return false;
        }
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          abort(context);
          const status = await rpc("flowUuidControlledStatus");
          if (status?.state === "finished") {
            const sameDocument =
              !!status.documentEpoch &&
              (await readEpoch()) === status.documentEpoch;
            decision("joined_finished", { sameDocument });
            return sameDocument;
          }
          if (!["reserved", "dispatched"].includes(status?.state)) {
            decision("join_not_running", {
              state: this._diagnosticCode(status?.state),
            });
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        decision("join_timeout");
        return false;
      }
      if (begun?.state !== "owner" || !begun.ticket) return false;
      request.ticket = begun.ticket;
      let dispatched = false,
        epoch = null;
      const previousOwner = this._refreshOwner;
      this._refreshOwner = {
        generationProcessId: context.generationProcessId,
        editorItemId: context.editorItemId,
      };
      try {
        assertRefreshScope();
        decision("owner_acquired");
        const result = await work({
          markDispatch: () => {
            dispatched = true;
            decision("dispatch");
          },
          markNotDispatched: () => {
            dispatched = false;
            decision("not_dispatched");
          },
          expectedFlowTarget: target,
          boundaryRequest: { ...request },
          checkSafety: async () => {
            assertRefreshScope();
            const safety = await rpc("flowUuidControlledSafety");
            assertRefreshScope();
            this._diagnostic(context, "controlled_refresh_safety", {
              safe: safety?.safe === true,
              reason: this._diagnosticCode(safety?.reason),
            });
            return safety;
          },
        });
        if (result === true && dispatched) {
          const afterEpoch = await readEpoch();
          epoch = afterEpoch && afterEpoch !== beforeEpoch ? afterEpoch : null;
        }
        decision("work_finished", {
          result: result === true,
          dispatched,
          documentChanged: !!epoch,
        });
        return result === true && !!epoch;
      } catch (error) {
        if (
          !dispatched &&
          [
            "FLOW_IDENTITY_REFRESH_BUSY",
            "FLOW_IDENTITY_REFRESH_DRAFT",
            "FLOW_IDENTITY_REFRESH_EDITOR_UNKNOWN",
            "FLOW_IDENTITY_REFRESH_MANUAL_UNVERIFIED",
            "V2_PENDING_SELECTOR_MISSING",
            "V2_PENDING_TILES_ACTIVE",
          ].includes(error?.code || error?.message)
        ) {
          decision("boundary_refused", {
            code: this._diagnosticCode(error?.code || error?.message),
          });
          return false;
        }
        throw error;
      } finally {
        this._refreshOwner = previousOwner;
        await root.chrome.runtime
          .sendMessage({
            action: "flowUuidControlledFinish",
            request: {
              ...request,
              notDispatched: !dispatched,
              documentEpoch: epoch,
            },
          })
          .catch(() => {});
      }
    }
    static adoptAttachedReferenceIdentities(item, identities) {
      let adopted = 0;
      for (const [id, proof] of Object.entries(identities || {})) {
        if (
          !item.refFileIds?.includes(id) ||
          proof?.proof !== "owned_video_chip" ||
          proof.type !== "video" ||
          !isUuid(proof.media_uuid) ||
          !item.projectId ||
          key(proof.project_id) !== key(item.projectId)
        )
          continue;
        const previous = item.refThumbnails?.[id];
        const record = {
          ...(typeof previous === "string"
            ? { thumbnail: previous }
            : previous || {}),
          refKey: id,
          file_name: item.refFileNames?.[id] || previous?.file_name,
          type: item.settings?.refVideoIds?.includes(id)
            ? "video"
            : previous?.type,
        };
        if (
          !this.metadataMatches(record, proof, { projectId: item.projectId })
        ) {
          throw this.error("FLOW_REFERENCE_IDENTITY_MISMATCH");
        }
        const { proof: _evidence, ...info } = proof;
        item.refThumbnails = {
          ...(item.refThumbnails || {}),
          [id]: this.mergeMetadata(previous, info),
        };
        root.MediaRegistry?.setRefIdentity?.(id, info);
        adopted++;
      }
      return adopted;
    }
    static async prepareReferences(item, context = {}) {
      return this._traceOperation("prepareReferences", context, (scoped) =>
        this._prepareReferences(item, scoped),
      );
    }
    static async _prepareReferences(item, context = {}) {
      const before = [...(item.refFileIds || [])];
      const records = before.map((id) => ({
        resultId: id,
        mediaUuid: this.identity(item.refThumbnails?.[id], id),
        mediaType: item.settings?.refVideoIds?.includes(id)
          ? "video"
          : item.refThumbnails?.[id]?.type,
      }));
      const ids = records.map((record) => record.mediaUuid);
      let response;
      try {
        response = await this.resolve(ids, {
          ...context,
          purpose: "reference",
          ownerRecords: records,
        });
      } catch (error) {
        abort(context);
        this._diagnostic(context, "reference_decision", {
          requested: before.length,
          kept: before.length,
          removed: 0,
          reason: "lookup_unavailable",
        });
        return {
          results: {},
          failed: [],
          unresolved: ids,
          reason: error?.code || "lookup_unavailable",
        };
      }
      abort(context);
      const failed = new Set(response.failed.map(key));
      const keep = (id) =>
        !failed.has(key(records[before.indexOf(id)]?.mediaUuid || id));
      item.refFileIds = before.filter(keep);
      this._diagnostic(context, "reference_decision", {
        requested: before.length,
        kept: item.refFileIds.length,
        removed: before.length - item.refFileIds.length,
        unresolved: response.unresolved.length,
      });
      if (item._mappedRefFileIds)
        item._mappedRefFileIds = item._mappedRefFileIds.filter(keep);
      if (item.settings?.refVideoIds)
        item.settings = {
          ...item.settings,
          refVideoIds: item.settings.refVideoIds.filter(keep),
        };
      for (const field of ["refFileNames", "refThumbnails"])
        if (item[field]) {
          item[field] = Object.fromEntries(
            Object.entries(item[field]).filter(([id]) => keep(id)),
          );
        }
      if (item.mentionData?.refImages)
        item.mentionData = {
          ...item.mentionData,
          refImages: item.mentionData.refImages.filter(
            (ref) =>
              !failed.has(key(this.identity(ref, ref.file_id || ref.id))),
          ),
        };
      for (let i = 0; i < before.length; i++) {
        const id = before[i],
          info = response.results[ids[i]]?.metadata;
        if (info && keep(id))
          item.refThumbnails = {
            ...(item.refThumbnails || {}),
            [id]: this.mergeMetadata(item.refThumbnails?.[id], info),
          };
      }
      return response;
    }
  };
  __publicField(_FlowUuidGateway, "_traceSequence", 0);
  __publicField(
    _FlowUuidGateway,
    "_traceSalt",
    Math.random().toString(36).slice(2),
  );
  __publicField(_FlowUuidGateway, "_epoch", 0);
  __publicField(_FlowUuidGateway, "_webReads", new Map());
  __publicField(_FlowUuidGateway, "_refreshOwner", null);
  __publicField(
    _FlowUuidGateway,
    "STOP_SAFETY_PREFIX",
    "flow_uuid_gateway_unsettled_api:",
  );
  __publicField(_FlowUuidGateway, "isUuid", isUuid);
  __publicField(_FlowUuidGateway, "_notFoundKey", "download.flowMediaNotFound");
  let FlowUuidGateway = _FlowUuidGateway;
  try {
    root.chrome?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      const changedKey = [
        "af_auth",
        "toby_client_enrollment",
        "toby_config_access_scope",
        "toby_provider_api_configs",
        "toby_provider_configs",
        "af_settings",
        "af_system_settings",
      ].find(
        (key2) =>
          changes[key2] &&
          (key2 !== "af_auth" ||
            !FlowUuidGateway._sameAuthScope(
              changes[key2].oldValue,
              changes[key2].newValue,
            )) &&
          (key2 !== "toby_config_access_scope" ||
            !FlowUuidGateway._sameAccessScope(
              changes[key2].oldValue,
              changes[key2].newValue,
            )),
      );
      if (changedKey) FlowUuidGateway.invalidate(changedKey);
    });
    root.ConfigSnapshotAccess?.onInvalidated?.(() =>
      FlowUuidGateway.invalidate("config_access_invalidated"),
    );
  } catch (_) {}
  root.FlowUuidGateway = FlowUuidGateway;
  root.flow_uuid_gateway = FlowUuidGateway;
  if (
    root.location?.protocol === "chrome-extension:" &&
    root.chrome?.runtime?.onMessage
  ) {
    root.chrome.runtime.onMessage.addListener((message, sender) => {
      if (
        message?.action !== "flowUuidContextProbe" ||
        sender.id !== root.chrome.runtime.id
      )
        return;
      const snapshot = FlowUuidGateway.refreshContextState(message.request);
      root.chrome.runtime
        .sendMessage({
          action: "flowUuidContextProbeReply",
          probeId: message.probeId,
          snapshot,
        })
        .catch(() => {});
    });
  }
})(typeof window !== "undefined" ? window : globalThis);
