/**
 * 566Flow LocalMotionBackend
 *
 * Local replacement for the original Motion Studio server API
 * (`tools/motion-studio/projects/...` and the provider-web reservation calls).
 * The Motion editor/runner were written against a server that keeps the
 * project state machine; this module reproduces the parts of that contract
 * the client reads back:
 *
 *   project.data_json = {
 *     preferences, references, paused, flow_run_mode, batch_enabled,
 *     source_draft, split_operation, source, source_revision, requires_resplit,
 *     frames: { [frameId]: { run_id, input_revision, start, end,
 *                            stages: { split, transcribe, upload, submit,
 *                                      monitor, persist, continuity, audio },
 *                            transcript, source_edit, result_edit } },
 *     final, generation_completion, transcript_reset, reset_id, motion_template
 *   }
 *
 * Every write returns the full project (the client replaces its copy with it).
 * Writes are serialized so concurrent frame checkpoints never overwrite each
 * other. Revision numbers are bumped on each write but not enforced.
 */
(() => {
  "use strict";

  const BASE = "tools/motion-studio/projects";
  const PROJECT_KEYS = new Set([
    "revision",
    "request_nonce",
    "name",
    "pause",
    "flow_run_mode",
    "clear_frames",
    "references",
    "batch_enabled",
    "flow_project_id",
    "bulk_create_id",
    "item_id",
    "requested",
    "journal",
  ]);
  const CHECKPOINT_CONTROL = new Set([
    "source_revision",
    "run_id",
    "input_revision",
    "stage",
    "state",
    "request_nonce",
    "revision",
    "replace_existing",
    "persist_artifact_id",
  ]);

  let chain = Promise.resolve();
  function serialized(fn) {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  }

  const now = () => new Date().toISOString();
  const uuid = () => crypto.randomUUID();

  function emptyReferences() {
    return {
      mode: "character_only",
      character: [],
      character2: [],
      background: [],
    };
  }

  function normalize(row) {
    if (!row || typeof row !== "object") return row;
    const dj = (row.data_json ||= {});
    if (!dj.frames || typeof dj.frames !== "object" || Array.isArray(dj.frames))
      dj.frames = {};
    const refs = dj.references;
    if (!refs || typeof refs !== "object" || Array.isArray(refs))
      dj.references = emptyReferences();
    else
      for (const k of ["character", "character2", "background"])
        if (!Array.isArray(refs[k])) refs[k] = [];
    dj.references.mode ||= "character_only";
    if (!dj.preferences || typeof dj.preferences !== "object")
      dj.preferences = {};
    if (!Number.isSafeInteger(dj.source_revision)) dj.source_revision = 0;
    if (typeof dj.paused !== "boolean") dj.paused = false;
    // Legacy rows from the generic store kept preference keys at top level.
    for (const k of Object.keys(row)) {
      if (
        k in dj.preferences ||
        !LEGACY_PREF_KEYS.has(k)
      )
        continue;
      dj.preferences[k] = row[k];
      delete row[k];
    }
    if (row.references && !dj.references.character.length) {
      const r = row.references;
      if (r && typeof r === "object" && !Array.isArray(r))
        dj.references = { ...emptyReferences(), ...r };
    }
    delete row.references;
    for (const frame of Object.values(dj.frames)) {
      frame.stages ||= {};
    }
    row.revision = Number.isSafeInteger(row.revision) ? row.revision : 1;
    return row;
  }
  const LEGACY_PREF_KEYS = new Set([
    "voice_enabled",
    "voice_mode",
    "transcription_provider",
    "subtitle_enabled",
    "review_subtitle",
    "translate_enabled",
    "target_language",
    "ratio",
    "flow_model",
    "voice_description",
    "custom_prompt",
    "voice_slug",
    "character_count",
    "auto_download_final",
    "use_original_audio",
    "continuity_enabled",
    "remove_final_video_watermark",
    "flow_download_resolution",
  ]);

  function newProject(data, db) {
    const t = now();
    const preferences = {};
    if (data.voice_mode) preferences.voice_mode = data.voice_mode;
    return normalize({
      id: db.seq++,
      tool_project_id: uuid(),
      name: String(data.name || "Motion project").slice(0, 160),
      flow_project_id: data.flow_project_id ?? null,
      bulk_create_id: data.bulk_create_id ?? null,
      item_id: data.item_id ?? null,
      status: "draft",
      revision: 1,
      deleted_at: null,
      created_at: t,
      updated_at: t,
      data_json: {
        frames: {},
        preferences,
        references: emptyReferences(),
        source_revision: 0,
        paused: false,
        ...(data.data_json || {}),
      },
    });
  }

  function touch(row) {
    row.revision = (Number(row.revision) || 0) + 1;
    row.updated_at = now();
    return row;
  }

  function resetFrameStages(frame, { keepSplit = true, keepTranscript = true } = {}) {
    const stages = frame.stages || {};
    const next = {};
    if (keepSplit && stages.split) next.split = stages.split;
    if (keepTranscript && stages.transcribe) next.transcribe = stages.transcribe;
    if (keepSplit && stages.audio) next.audio = stages.audio;
    frame.stages = next;
    if (!keepTranscript) delete frame.transcript;
  }

  function invalidateResults(dj) {
    dj.final = null;
    dj.generation_completion = null;
  }

  // ------------------------------------------------------------- handlers
  function patchProject(row, data) {
    const dj = row.data_json;
    for (const [key, value] of Object.entries(data || {})) {
      if (key === "revision" || key === "request_nonce") continue;
      if (key === "name") row.name = String(value || "").slice(0, 160) || row.name;
      else if (key === "pause") dj.paused = value === true;
      else if (key === "flow_run_mode") dj.flow_run_mode = value;
      else if (key === "batch_enabled") dj.batch_enabled = value === true;
      else if (key === "references") {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const changed =
            JSON.stringify(dj.references) !== JSON.stringify(value);
          dj.references = { ...emptyReferences(), ...value };
          if (changed) invalidateResults(dj);
        }
      } else if (key === "clear_frames") {
        if (value === true) {
          dj.frames = {};
          dj.frames_cleared = true;
          invalidateResults(dj);
        }
      } else if (key === "journal") dj.bulk_journal = value;
      else if (key === "flow_project_id") row.flow_project_id = value;
      else if (key === "preferences" && value && typeof value === "object")
        Object.assign(dj.preferences, value);
      else dj.preferences[key] = value;
    }
  }

  function frameOf(dj, frameId) {
    const frame = dj.frames?.[frameId];
    if (!frame) {
      const error = new Error("FRAME_NOT_FOUND");
      error.httpStatus = 404;
      throw error;
    }
    frame.stages ||= {};
    return frame;
  }

  function assertFrameScope(dj, frame, data, { requireRun = true } = {}) {
    if (
      data.source_revision !== undefined &&
      Number(data.source_revision) !== Number(dj.source_revision)
    )
      throw Object.assign(new Error("SOURCE_REVISION_CONFLICT"), {
        httpStatus: 409,
      });
    if (
      requireRun &&
      ((data.run_id !== undefined && data.run_id !== frame.run_id) ||
        (data.input_revision !== undefined &&
          Number(data.input_revision) !== Number(frame.input_revision)))
    )
      throw Object.assign(new Error("FRAME_SCOPE_CHANGED"), {
        httpStatus: 409,
      });
  }

  function checkpoint(dj, frameId, data) {
    const frame = frameOf(dj, frameId);
    assertFrameScope(dj, frame, data);
    const stage = String(data.stage || "");
    if (!/^[a-z_]{1,40}$/.test(stage))
      throw Object.assign(new Error("STAGE_INVALID"), { httpStatus: 422 });
    const extra = {};
    for (const [k, v] of Object.entries(data))
      if (!CHECKPOINT_CONTROL.has(k)) extra[k] = v;
    const previous = frame.stages[stage] || {};
    frame.stages[stage] = {
      ...previous,
      ...extra,
      state: data.state,
      updated_at: now(),
    };
    if (data.state !== "failed") {
      delete frame.stages[stage].error_code;
      if (!("retry_exhausted" in extra)) delete frame.stages[stage].retry_exhausted;
    }
    if (data.persist_artifact_id) {
      frame.stages.persist = {
        ...(frame.stages.persist || {}),
        state:
          frame.stages.persist?.state === "ready" &&
          frame.stages.persist.artifact_id === data.persist_artifact_id
            ? "ready"
            : "running",
        artifact_id: data.persist_artifact_id,
        updated_at: now(),
      };
    }
    // A new submit makes previous result/final stale.
    if (stage === "submit" && data.state === "running") {
      delete frame.stages.monitor;
      if (frame.stages.persist?.state !== "ready" || data.replace_existing)
        delete frame.stages.persist;
      invalidateResults(dj);
    }
    if (stage === "persist" && data.state === "ready") invalidateResults(dj);
    if (stage === "split" && data.state === "ready") {
      delete frame.stages.upload;
    }
  }

  function saveTranscript(dj, frameId, data) {
    const frame = frameOf(dj, frameId);
    assertFrameScope(dj, frame, data);
    const hasSpeech = data.has_speech === true;
    frame.transcript = {
      has_speech: hasSpeech,
      text: hasSpeech ? String(data.transcript || "") : "",
      translated_text:
        data.translated_text == null ? null : String(data.translated_text),
      speech_timeline: data.speech_timeline ?? null,
      detected_language: data.detected_language ?? null,
      translation_stale: false,
      updated_at: now(),
    };
    frame.stages.transcribe = {
      ...(frame.stages.transcribe || {}),
      state: "ready",
      updated_at: now(),
    };
    delete frame.stages.transcribe.error_code;
    delete frame.stages.transcribe.retry_exhausted;
    // Speech changed: Flow result for this frame must be regenerated.
    delete frame.stages.submit;
    delete frame.stages.monitor;
    invalidateResults(dj);
  }

  function transcriptionFailure(dj, frameId, data) {
    const frame = frameOf(dj, frameId);
    assertFrameScope(dj, frame, data);
    const extra = {};
    for (const [k, v] of Object.entries(data))
      if (!CHECKPOINT_CONTROL.has(k)) extra[k] = v;
    frame.stages.transcribe = {
      ...(frame.stages.transcribe || {}),
      ...extra,
      state: data.state || "failed",
      updated_at: now(),
    };
  }

  function bumpRun(frame) {
    const old = { run_id: frame.run_id, input_revision: frame.input_revision };
    frame.run_id = uuid();
    frame.input_revision = (Number(frame.input_revision) || 0) + 1;
    return old;
  }

  function putSource(row, data) {
    const dj = row.data_json;
    const list = Array.isArray(data.frames) ? data.frames : [];
    if (!list.length)
      throw Object.assign(new Error("NO_FRAMES"), { httpStatus: 422 });
    const frames = {};
    for (const f of list) {
      const id = String(f.frame_id || "");
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
        throw Object.assign(new Error("FRAME_ID_INVALID"), { httpStatus: 422 });
      frames[id] = {
        run_id: f.run_id || uuid(),
        input_revision: Number(f.input_revision) || 1,
        start: Number(f.start),
        end: Number(f.end),
        stages: {},
      };
    }
    dj.frames = frames;
    dj.source = { ...(data.source || {}), updated_at: now() };
    dj.source_revision = Number(data.source_revision) || dj.source_revision + 1;
    dj.requires_resplit = false;
    dj.frames_cleared = false;
    if (data.motion_template) dj.motion_template = data.motion_template;
    else if (!data.preserve_motion_template) delete dj.motion_template;
    if (data.split_operation_id && dj.split_operation)
      dj.split_operation = {
        ...dj.split_operation,
        committed_source_revision: dj.source_revision,
      };
    invalidateResults(dj);
    delete dj.transcript_reset;
  }

  function batchSnapshot(rows, flowProjectId) {
    const mine = rows
      .filter((r) => !r.deleted_at && r.flow_project_id === flowProjectId)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const items = [];
    const finals = [];
    let disabled = 0;
    mine.forEach((row, position) => {
      const dj = row.data_json || {};
      if (dj.batch_enabled !== true) {
        disabled++;
        return;
      }
      const frames = Object.fromEntries(
        Object.entries(dj.frames || {}).map(([id, f]) => [
          id,
          {
            run_id: f.run_id,
            input_revision: f.input_revision,
            persist_state: f.stages?.persist?.state || null,
            artifact_id: f.stages?.persist?.artifact_id || null,
          },
        ]),
      );
      const item = {
        tool_project_id: row.tool_project_id,
        position,
        revision: Number(row.revision) || 1,
        name: row.name,
        source_revision: dj.source_revision,
        requires_resplit: dj.requires_resplit === true,
        generation_completion: dj.generation_completion || null,
        frames,
        final: dj.final || null,
      };
      (dj.final ? finals : items).push(item);
    });
    return {
      flow_project_id: flowProjectId,
      items,
      final_candidates: finals,
      disabled_count: disabled,
    };
  }

  // ---------------------------------------------------- provider-web tokens
  async function executionWorkflowPolicy() {
    try {
      const file = await fetch(chrome.runtime.getURL("config/execution.json")).then(
        (r) => (r.ok ? r.json() : {}),
      );
      const stored = (await chrome.storage.local.get(["local566_config_execution"]))
        .local566_config_execution;
      const wf = { ...(file.workflow || {}), ...(stored?.workflow || {}) };
      return {
        maxRetries: Number.isSafeInteger(wf.max_retries) ? wf.max_retries : 2,
      };
    } catch (_) {
      return { maxRetries: 2 };
    }
  }

  async function providerWeb(path, data, db, ok, fail) {
    db.motion_tokens ||= {};
    const tokens = db.motion_tokens;
    if (path === "execution/provider-web/reserve") {
      const policy = await executionWorkflowPolicy();
      const token = `local-motion-${uuid()}`;
      tokens[token] = {
        run_id: data.run_id,
        source: data.source || "motion",
        provider: data.provider,
        status: "active",
        dispatch_intent_count: 0,
        attempts: {},
        created_at: Date.now(),
      };
      return ok({
        execution_token: token,
        token_status: "active",
        expires_in: 6 * 3600,
        motion_retry_limit: policy.maxRetries,
        motion_retry_enabled: true,
        motion_provider_startup_ms: 60000,
        motion_text_timeout_ms: 240000,
      });
    }
    const entry = tokens[data.token];
    if (path === "execution/provider-web/intent") {
      if (!entry) return fail("TOKEN_NOT_FOUND", 404);
      const attempt = String(data.attempt_id || data.item_id || "");
      const replayed = !!entry.attempts[attempt];
      if (data.reconcile_only === true)
        return ok({ status: "dispatch_intent", dispatch_allowed: false, replayed });
      if (!replayed) {
        entry.attempts[attempt] = Date.now();
        entry.dispatch_intent_count++;
      }
      return ok({ status: "dispatch_intent", dispatch_allowed: true, replayed });
    }
    if (path === "execution/cancel-undispatched-motion") {
      if (!entry) return fail("TOKEN_NOT_FOUND", 404);
      const undispatched = entry.dispatch_intent_count === 0;
      if (undispatched) entry.status = "revoked";
      return ok({ undispatched, transcript_reset: undispatched });
    }
    if (path === "execution/complete") {
      if (!entry) return ok({ status: data.status });
      entry.status = "completed";
      entry.settlement = { method: "complete", status: data.status };
      return ok({ status: data.status });
    }
    if (path === "execution/settlement") {
      if (!entry) return fail("TOKEN_NOT_FOUND", 404);
      return ok({
        token_status:
          entry.status === "active" &&
          Date.now() - entry.created_at > 6 * 3600 * 1e3
            ? "expired"
            : entry.status,
        provider_web: {
          run_id: entry.run_id,
          source: entry.source,
          dispatch_intent_count: entry.dispatch_intent_count,
        },
        settlement: entry.settlement || null,
      });
    }
    return null;
  }

  // ------------------------------------------------------------- dispatch
  /**
   * @returns {Promise<object|null>} response, or null when the path is not ours
   */
  async function handle({ method, path, query, data, readDb, writeDb, ok, fail }) {
    const isMotion = path === BASE || path.startsWith(BASE + "/");
    const isProviderWeb =
      path.startsWith("execution/provider-web/") ||
      path === "execution/cancel-undispatched-motion" ||
      path === "execution/settlement" ||
      (path === "execution/complete" &&
        typeof data?.token === "string" &&
        data.token.startsWith("local-motion-"));
    if (!isMotion && !isProviderWeb) return null;

    return serialized(async () => {
      const db = await readDb();
      db.store ||= {};
      const rows = (db.store[BASE] ||= []);
      rows.forEach(normalize);
      const save = async () => writeDb(db);

      try {
        if (isProviderWeb) {
          const res = await providerWeb(path, data || {}, db, ok, fail);
          await save();
          return res;
        }

        const rest = path.slice(BASE.length).replace(/^\//, "");
        const parts = rest ? rest.split("/").map(decodeURIComponent) : [];

        // ---- collection-level
        if (!parts.length) {
          if (method === "GET") {
            let items = rows.filter(
              (r) => !r.deleted_at || query.get("include_deleted"),
            );
            const fp = query.get("flow_project_id");
            if (fp) items = items.filter((r) => r.flow_project_id === fp);
            items = [...items].sort((a, b) =>
              String(b.updated_at).localeCompare(String(a.updated_at)),
            );
            const perPage = Number(query.get("per_page")) || 30;
            const current = Number(query.get("page")) || 1;
            return ok({
              data: items.slice((current - 1) * perPage, current * perPage),
              current_page: current,
              per_page: perPage,
              total: items.length,
              last_page: Math.max(1, Math.ceil(items.length / perPage)),
            });
          }
          if (method === "POST") {
            const row = newProject(data || {}, db);
            rows.unshift(row);
            await save();
            return ok(row);
          }
          return fail("METHOD_NOT_ALLOWED", 405);
        }
        if (parts[0] === "bulk-item" && method === "GET") {
          const row = rows.find(
            (r) =>
              !r.deleted_at &&
              r.bulk_create_id === query.get("bulk_create_id") &&
              r.item_id === query.get("item_id"),
          );
          return ok(row || null);
        }
        if (parts[0] === "quota" && method === "GET")
          return ok({ used: 0, limit: -1, remaining: -1, unlimited: true });
        if (parts[0] === "batch-snapshot" && method === "GET")
          return ok(batchSnapshot(rows, query.get("flow_project_id")));

        // ---- project-level
        const id = parts[0];
        const idx = rows.findIndex(
          (r) => r.tool_project_id === id || String(r.id) === id,
        );
        if (idx < 0) return fail("NOT_FOUND", 404, "Motion project not found");
        const row = rows[idx];
        const dj = row.data_json;
        const action = parts.slice(1);

        if (!action.length) {
          if (method === "GET") return ok(row);
          if (method === "DELETE") {
            row.deleted_at = now();
            await save();
            return ok({});
          }
          if (method === "PATCH" || method === "PUT") {
            patchProject(row, data);
            touch(row);
            await save();
            return ok(row);
          }
          return fail("METHOD_NOT_ALLOWED", 405);
        }

        const [a0, a1, a2] = action;
        switch (a0) {
          case "batch-enabled":
            dj.batch_enabled = !!(data?.enabled ?? data?.batch_enabled);
            break;
          case "source-draft":
            if (method === "DELETE") dj.source_draft = null;
            else
              dj.source_draft = {
                draft_id: data.draft_id,
                file_name: data.file_name,
                mime: data.mime,
                size: data.size,
                duration: data.duration ?? null,
                updated_at: now(),
              };
            break;
          case "split-attempt":
            dj.split_operation = {
              ...(dj.split_operation?.operation_id === data.operation_id
                ? dj.split_operation
                : {}),
              operation_id: data.operation_id,
              draft_id: data.draft_id,
              state: data.state,
              ...(data.include_audio !== undefined && {
                include_audio: data.include_audio,
              }),
              ...(data.cut_strategy !== undefined && {
                cut_strategy: data.cut_strategy,
              }),
              ...(data.state === "failed"
                ? { error_code: data.error_code || "MOTION_SPLIT_FAILED" }
                : { error_code: null }),
              updated_at: now(),
            };
            break;
          case "source":
            putSource(row, data || {});
            break;
          case "reset":
            dj.frames = {};
            dj.source = null;
            dj.source_draft = null;
            dj.split_operation = null;
            dj.requires_resplit = false;
            dj.transcript_reset = null;
            dj.reset_id = data?.reset_id || uuid();
            dj.paused = false;
            invalidateResults(dj);
            break;
          case "rerun": {
            const ids = Array.isArray(data?.frame_ids)
              ? data.frame_ids
              : Object.keys(dj.frames);
            for (const fid of ids) {
              const frame = dj.frames[fid];
              if (!frame) continue;
              if (data?.scope === "transcript") {
                delete frame.stages.transcribe;
                delete frame.transcript;
              } else {
                bumpRun(frame);
                resetFrameStages(frame);
              }
            }
            if (data?.scope === "transcript")
              dj.transcript_reset = {
                rerun_id: data.rerun_id,
                source_revision: Number(data.source_revision),
                previous_project_run_id: data.previous_project_run_id ?? null,
                frame_ids: ids,
                at: now(),
              };
            invalidateResults(dj);
            break;
          }
          case "finalize":
            dj.final = {
              artifact_id: data.artifact_id,
              source_revision: Number(data.source_revision),
              artifact_revision: Number(data.artifact_revision),
              duration: data.duration,
              frame_ids: Array.isArray(data.frame_ids) ? data.frame_ids : [],
              use_original_audio: data.use_original_audio === true,
              stale: false,
              created_at: now(),
            };
            row.status = "completed";
            break;
          case "generation-complete":
            dj.generation_completion = {
              source_revision: Number(data.source_revision),
              frames: data.frames || {},
              merge_error: data.merge_error ?? null,
              completed_at: now(),
            };
            break;
          case "frames": {
            const frameId = a1;
            const op = a2;
            if (!frameId || !op) return fail("NOT_FOUND", 404);
            if (op === "checkpoint") checkpoint(dj, frameId, data || {});
            else if (op === "transcript") saveTranscript(dj, frameId, data || {});
            else if (op === "transcription-failure")
              transcriptionFailure(dj, frameId, data || {});
            else if (op === "rerun") {
              const frame = frameOf(dj, frameId);
              assertFrameScope(dj, frame, data || {}, { requireRun: false });
              bumpRun(frame);
              resetFrameStages(frame);
              invalidateResults(dj);
            } else if (op === "recut") {
              const frame = frameOf(dj, frameId);
              assertFrameScope(dj, frame, data || {}, { requireRun: false });
              bumpRun(frame);
              resetFrameStages(frame, { keepSplit: false, keepTranscript: false });
              frame.stages.split = { state: "pending", updated_at: now() };
              invalidateResults(dj);
            } else if (op === "source") {
              const frame = frameOf(dj, frameId);
              assertFrameScope(dj, frame, data || {});
              bumpRun(frame);
              resetFrameStages(frame, { keepSplit: true, keepTranscript: true });
              frame.source_edit = {
                mutation_id: data.mutation_id,
                media_id: data.media_id,
                persistent_media_id: data.persistent_media_id ?? null,
                display_name: data.display_name ?? null,
                upload_name: data.upload_name ?? null,
                at: now(),
              };
              invalidateResults(dj);
            } else if (op === "result") {
              const frame = frameOf(dj, frameId);
              assertFrameScope(dj, frame, data || {});
              const old = bumpRun(frame);
              const preserve = data.preserve_result === true;
              const keepPersist =
                data.action === "replace" || preserve ? null : undefined;
              resetFrameStages(frame);
              if (data.action === "replace") {
                frame.stages.submit = { state: "ready", updated_at: now() };
                frame.stages.monitor = { state: "ready", updated_at: now() };
                frame.stages.persist = {
                  state: "ready",
                  artifact_id: data.artifact_id,
                  resolution: data.resolution ?? null,
                  media_id: data.media_id ?? null,
                  persistent_media_id: data.persistent_media_id ?? null,
                  updated_at: now(),
                };
              }
              void keepPersist;
              frame.result_edit = {
                mutation_id: data.mutation_id,
                action: data.action,
                run_id: old.run_id,
                input_revision: old.input_revision,
                ...(preserve && { preserve_result: true }),
                at: now(),
              };
              invalidateResults(dj);
            } else return fail("NOT_FOUND", 404);
            break;
          }
          default:
            // Unknown sub-action: accept without changes so the UI keeps going.
            break;
        }
        touch(row);
        await save();
        return ok(row);
      } catch (error) {
        return fail(
          error.message || "MOTION_LOCAL_ERROR",
          error.httpStatus || 500,
          error.message,
        );
      }
    });
  }

  self.LocalMotionBackend = Object.freeze({ handle, normalize });
})();
