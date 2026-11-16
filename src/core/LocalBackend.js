/**
 * 566Flow LocalBackend
 *
 * Replaces the former remote service. Every `apiRequest` message that used to
 * be proxied to a remote server is answered here, entirely on this machine:
 *   - a single local user that is always signed in
 *   - every feature unlocked, no quotas
 *   - execution tokens issued locally
 *   - prompts / history / settings kept in chrome.storage.local
 *
 * Runs inside the service worker (classic script, uses `self`).
 * Response shape mirrors what the UI layer already expects:
 *   { success, data, meta?, error?, httpStatus? }
 */
(() => {
  "use strict";

  const DB_KEY = "local566_db";
  const LOCAL_TOKEN = "local-566flow-token";

  const LOCAL_USER = Object.freeze({
    id: 1,
    email: "local@566flow.local",
    name: "566Flow",
    role: "user",
    is_admin: false,
    email_verified: true,
    plan_slug: "local",
  });

  // ---------------------------------------------------------------- features
  // Boolean features: true. Quota features: -1 (= unlimited).
  const QUOTA_KEYS = [
    "gen_run_max",
    "chatgpt_run_max",
    "grok_run_max",
    "muse_run_max",
    "tasks_max",
    "tasks_run_max",
    "workflows_max",
    "workflows_run_max",
    "workflows_nodes_max",
    "angles_run_max",
    "effects_run_max",
    "snippets_max",
    "prompt_submit_max",
    "prompts_per_batch",
    "api_rate_limit_per_minute",
  ];
  const BOOLEAN_KEYS = [
    "gen_enabled",
    "flow_api_enabled",
    "image_remove_watermark_enabled",
    "video_remove_watermark_enabled",
    "chatgpt_enabled",
    "grok_enabled",
    "gemini_enabled",
    "muse_enabled",
    "muse_api_enabled",
    "muse_mcp_enabled",
    "tasks_enabled",
    "workflows_enabled",
    "workflow_share_enabled",
    "workflow_import",
    "workflow_export",
    "angles_enabled",
    "effects_enabled",
    "auto_download",
    "retry_on_fail",
    "ref_images",
    "flow_ref_images",
    "chatgpt_ref_images",
    "grok_ref_images",
    "gemini_ref_images",
    "muse_ref_images",
    "prompt_templates_enabled",
    "workflow_templates_enabled",
    "premium_templates",
    "history_enabled",
    "priority_support",
    "pipeline_queue_enabled",
    "prompt_node_enabled",
    "prompt_assistant_enabled",
    "ai_agent_enabled",
    "mcp_enabled",
    "motion_tool_enabled",
    "telegram_enabled",
    "telegram_workflow",
  ];

  function buildFeatures() {
    const features = {};
    for (const key of BOOLEAN_KEYS)
      features[key] = { type: "boolean", value: true };
    for (const key of QUOTA_KEYS)
      features[key] = { type: "quota", value: -1, usage_today: 0 };
    return features;
  }

  // ---------------------------------------------------------------- storage
  async function readDb() {
    const stored = await chrome.storage.local.get([DB_KEY]);
    const db = stored[DB_KEY] || {};
    db.settings ||= {};
    db.prompts ||= [];
    db.history ||= [];
    db.seq ||= 1;
    return db;
  }
  async function writeDb(db) {
    await chrome.storage.local.set({ [DB_KEY]: db });
  }

  const ok = (data, meta) => ({
    success: true,
    data: data === undefined ? {} : data,
    ...(meta ? { meta } : {}),
  });
  const fail = (code, httpStatus = 404, message = code) => ({
    success: false,
    error: { code, message },
    httpStatus,
  });
  const page = (items, query) => {
    const perPage = Number(query.get("per_page")) || items.length || 1;
    const current = Number(query.get("page")) || 1;
    const start = (current - 1) * perPage;
    return ok(items.slice(start, start + perPage), {
      total: items.length,
      page: current,
      per_page: perPage,
      last_page: Math.max(1, Math.ceil(items.length / perPage)),
    });
  };

  // ------------------------------------------------------------------ router
  async function dispatch(message) {
    const method = String(message.method || "GET").toUpperCase();
    const endpoint = String(message.endpoint || "").replace(/^\/+/, "");
    const [path, queryString = ""] = endpoint.split("?");
    const query = new URLSearchParams(queryString);
    const data = message.data || {};
    const parts = path.split("/");

    // ---- connectivity / enrollment (kept so legacy callers stay happy)
    if (path === "health") return ok({ status: "ok", mode: "local" });
    if (path === "enroll")
      return ok({ client_id: "local", secret: "local", expires_at: null });

    // ---- auth: single local user, always signed in
    if (
      path === "auth/login" ||
      path === "auth/register" ||
      path === "auth/refresh"
    )
      return ok({
        token: LOCAL_TOKEN,
        refresh_token: LOCAL_TOKEN,
        user: LOCAL_USER,
      });
    if (path === "auth/me") return ok({ user: LOCAL_USER });
    if (path === "auth/logout") return ok({});

    // ---- plan / quota: everything on, nothing limited
    if (path === "entitlements")
      return ok(
        {
          features: buildFeatures(),
          plan: { slug: "local", name: "566Flow Local" },
        },
        { version: 1 },
      );
    if (path === "system-settings/public")
      return ok(
        {
          google_enabled: true,
          show_upgrade_ui: false,
          show_tip_coffee: false,
          maintenance_mode: false,
          email_verification_required: false,
          app_name: "566Flow",
          workflow_web_mode: false,
          api_mode_enabled: false,
          api_timeout_ms: 30000,
          image_timeout_ms: 180000,
          video_timeout_ms: 600000,
          chatgpt_timeout_ms: 180000,
          sse_heartbeat_timeout_ms: 60000,
          sse_max_delay_ms: 30000,
          sse_max_retries: 5,
          sse_stable_threshold_ms: 10000,
          broadcast_election_delay_ms: 1500,
          broadcast_heartbeat_ms: 2000,
          broadcast_leader_timeout_ms: 6000,
        },
        { version: 1 },
      );

    // ---- execution tokens (issued locally)
    if (path === "execution/request")
      return ok({
        allowed: true,
        execution_token: `local-${crypto.randomUUID()}`,
        remaining: -1,
        limit: -1,
        used: 0,
        global: { remaining: -1, limit: -1, used: 0 },
        expires_in: 6 * 3600,
      });
    if (
      path === "execution/complete" ||
      path === "execution/cancel" ||
      path.startsWith("execution/muse-api/") ||
      /^executions\/[^/]+\/heartbeat$/.test(path)
    )
      return ok({});

    // ---- telemetry / realtime: no-ops
    if (path.startsWith("usage/") || path === "mcp/executor-heartbeat")
      return ok({});
    if (path.startsWith("sse/")) return fail("SSE_DISABLED", 404);

    // ---- public/admin-provided defaults: nothing to override locally
    if (path === "default-settings") return ok({}, { version: 1 });
    if (
      path === "workflow-node-types" ||
      path === "providers" ||
      path === "provider-voices" ||
      path === "workflows/shared-with-me"
    )
      return ok([]);
    // deep tools fall back to their built-in presets/effects/node types
    if (
      path === "angle-presets" ||
      path === "image-effects" ||
      path === "workflow-node-types" ||
      path === "creator-templates" ||
      path.startsWith("creator-templates/")
    )
      return ok([]);
    if (
      path === "location/me" ||
      path === "validation-rules" ||
      path === "announcement" ||
      path === "provider-models/presentation"
    )
      return ok({});
    if (path.startsWith("i18n/")) {
      try {
        const dict = await fetch(chrome.runtime.getURL("config/i18n.json")).then(
          (r) => (r.ok ? r.json() : {}),
        );
        return ok(dict);
      } catch (_) {
        return ok({});
      }
    }

    // ---- user settings
    if (path === "settings") {
      const db = await readDb();
      if (method === "GET") return ok(db.settings);
      db.settings = { ...db.settings, ...data };
      await writeDb(db);
      return ok(db.settings);
    }

    // ---- prompts (snippets)
    if (parts[0] === "prompts") {
      const db = await readDb();
      const id = parts[1] ? Number(parts[1]) : null;
      if (method === "GET" && id === null) return page(db.prompts, query);
      if (method === "POST" && id === null) {
        const row = {
          ...data,
          id: db.seq++,
          created_at: new Date().toISOString(),
        };
        db.prompts.unshift(row);
        await writeDb(db);
        return ok(row);
      }
      const idx = db.prompts.findIndex((p) => p.id === id);
      if (idx < 0) return fail("NOT_FOUND", 404);
      if (method === "PUT" || method === "PATCH") {
        db.prompts[idx] = { ...db.prompts[idx], ...data };
        await writeDb(db);
        return ok(db.prompts[idx]);
      }
      if (method === "DELETE") {
        db.prompts.splice(idx, 1);
        await writeDb(db);
        return ok({});
      }
    }

    // ---- generation history
    if (parts[0] === "history") {
      const db = await readDb();
      if (method === "GET" && parts.length === 1)
        return page(db.history, query);
      if (method === "POST" && parts.length === 1) {
        const row = {
          ...data,
          id: db.seq++,
          created_at: new Date().toISOString(),
        };
        db.history.unshift(row);
        db.history = db.history.slice(0, 5000);
        await writeDb(db);
        return ok(row);
      }
      const id = Number(parts[1]);
      const idx = db.history.findIndex((h) => h.id === id);
      if (idx < 0) return fail("NOT_FOUND", 404);
      if (method === "DELETE") {
        db.history.splice(idx, 1);
        await writeDb(db);
        return ok({});
      }
      if (method === "PATCH") {
        db.history[idx] = {
          ...db.history[idx],
          ...data,
          favorite: !db.history[idx].favorite,
        };
        await writeDb(db);
        return ok(db.history[idx]);
      }
    }

    // ---- Motion Studio specials
    if (path === "tools/motion-studio/projects/quota")
      return ok({ used: 0, limit: -1, remaining: -1, unlimited: true });
    if (path === "tools/motion-studio/templates/categories") return ok([]);
    if (path === "tools/motion-studio/templates" && method === "GET")
      return ok({ items: [], next_page: null, total: 0 });
    if (
      path === "tools/motion-studio/projects/batch-snapshot" ||
      path === "tools/motion-studio/projects/bulk-item"
    )
      return ok({ data: [], items: [], projects: [] });

    // ---- generic local REST store for every other resource
    return genericStore(method, path, query, data);
  }

  const ID_RE =
    /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]{1,8}_[A-Za-z0-9_-]{4,})$/i;
  const MOTION = "tools/motion-studio/projects";

  function newRecord(collection, data, db) {
    const now = new Date().toISOString();
    const row = { ...data, id: data.id ?? db.seq++, created_at: now, updated_at: now };
    if (collection === MOTION) {
      row.tool_project_id = crypto.randomUUID();
      row.status ||= "draft";
      row.revision = 1;
      row.deleted_at = null;
      row.data_json = {
        frames: [],
        preferences: {},
        references: [],
        source_revision: 0,
        paused: false,
        ...(data.data_json || {}),
      };
    }
    return row;
  }
  function recordKey(row) {
    return String(row.tool_project_id ?? row.wf_id ?? row.task_id ?? row.uuid ?? row.id);
  }
  function mergeRecord(row, data) {
    const next = { ...row, ...data, updated_at: new Date().toISOString() };
    if (row.data_json && data && typeof data.data_json === "object")
      next.data_json = { ...row.data_json, ...data.data_json };
    if (data && data.preferences && row.data_json)
      next.data_json = {
        ...next.data_json,
        preferences: { ...(row.data_json.preferences || {}), ...data.preferences },
      };
    if (typeof row.revision === "number") next.revision = row.revision + 1;
    return next;
  }

  async function genericStore(method, path, query, data) {
    const parts = path.split("/").filter(Boolean);
    const idIdx = parts.findIndex((seg) => ID_RE.test(seg));
    const collection = (idIdx < 0 ? parts : parts.slice(0, idIdx)).join("/");
    const id = idIdx < 0 ? null : decodeURIComponent(parts[idIdx]);
    const action = idIdx < 0 ? "" : parts.slice(idIdx + 1).join("/");
    const db = await readDb();
    db.store ||= {};
    const rows = (db.store[collection] ||= []);
    const isMotion = collection === MOTION;

    if (id === null) {
      if (method === "GET") {
        let items = rows.filter((r) => !r.deleted_at || query.get("include_deleted"));
        for (const key of ["flow_project_id", "project_id", "platform", "type"]) {
          const v = query.get(key);
          if (v) items = items.filter((r) => r[key] === undefined || String(r[key]) === v);
        }
        items = [...items].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
        if (isMotion) {
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
        return page(items, query);
      }
      if (method === "POST") {
        const row = newRecord(collection, data, db);
        rows.unshift(row);
        await writeDb(db);
        return ok(row);
      }
      if (method === "DELETE") {
        db.store[collection] = [];
        await writeDb(db);
        return ok({});
      }
      return ok({});
    }

    const idx = rows.findIndex((r) => recordKey(r) === id || String(r.id) === id);
    if (idx < 0) {
      if (method === "GET") return fail("NOT_FOUND", 404, "Not found");
      if (method === "DELETE") return ok({});
      // upsert for writes on unknown ids (client-generated ids)
      const row = newRecord(collection, data, db);
      if (!isMotion) row.id = /^\d+$/.test(id) ? Number(id) : id;
      rows.unshift(row);
      await writeDb(db);
      return ok(row);
    }
    if (method === "GET") return ok(action ? { ...rows[idx], items: [] } : rows[idx]);
    if (method === "DELETE" && !action) {
      if (isMotion) rows[idx] = { ...rows[idx], deleted_at: new Date().toISOString() };
      else rows.splice(idx, 1);
      await writeDb(db);
      return ok({});
    }
    // PUT/PATCH/POST on the record or one of its sub-actions
    let patch = data;
    if (action === "batch-enabled")
      patch = { data_json: { batch_enabled: !!(data.enabled ?? data.batch_enabled) } };
    else if (action === "source" || action === "source-draft")
      patch = { data_json: { [action === "source" ? "source" : "source_draft"]: data } };
    else if (action === "reset")
      patch = { data_json: { frames: [], frames_cleared: true, paused: false } };
    else if (action) patch = {};
    rows[idx] = mergeRecord(rows[idx], patch);
    await writeDb(db);
    return ok(rows[idx]);
  }

  // Base URL kept on a non-routable host so the page fetch shim can intercept
  // every direct fetch() and forward it to this backend.
  const LOCAL_API_BASE = "https://local.566flow.invalid/api/v1";

  // Make sure the UI always finds a signed-in local user with a routable base URL.
  async function ensureLocalUser() {
    const stored = await chrome.storage.local.get(["af_auth", "af_entitlements"]);
    const auth = stored.af_auth;
    if (
      auth?.token === LOCAL_TOKEN &&
      auth?.apiBaseUrl === LOCAL_API_BASE &&
      stored.af_entitlements?.entitlements?.pipeline_queue_enabled
    )
      return;
    await chrome.storage.local.set({
      af_auth: {
        token: LOCAL_TOKEN,
        user: LOCAL_USER,
        apiBaseUrl: LOCAL_API_BASE,
        savedAt: Date.now(),
      },
      af_api_url: LOCAL_API_BASE,
      // Pre-seed the entitlements cache so every feature is unlocked from the
      // first paint (before FeatureGate's own fetch runs), e.g. Pipeline Queue.
      af_entitlements: {
        entitlements: buildFeatures(),
        plan: { slug: "local", name: "566Flow Local" },
        lastFetch: Date.now(),
        user_id: LOCAL_USER.id,
      },
    });
  }

  self.LocalBackend = Object.freeze({
    dispatch,
    ensureLocalUser,
    buildFeatures,
    LOCAL_TOKEN,
    LOCAL_USER,
  });
})();
