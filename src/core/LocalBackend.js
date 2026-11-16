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
    for (const key of BOOLEAN_KEYS) features[key] = { type: "boolean", value: true };
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
    if (path === "auth/login" || path === "auth/register" || path === "auth/refresh")
      return ok({ token: LOCAL_TOKEN, refresh_token: LOCAL_TOKEN, user: LOCAL_USER });
    if (path === "auth/me") return ok({ user: LOCAL_USER });
    if (path === "auth/logout") return ok({});

    // ---- plan / quota: everything on, nothing limited
    if (path === "entitlements")
      return ok(
        { features: buildFeatures(), plan: { slug: "local", name: "566Flow Local" } },
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
    if (path.startsWith("usage/") || path === "mcp/executor-heartbeat") return ok({});
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
    if (
      path === "location/me" ||
      path === "validation-rules" ||
      path === "announcement" ||
      path === "provider-models/presentation" ||
      path.startsWith("i18n/")
    )
      return ok({});

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
        const row = { ...data, id: db.seq++, created_at: new Date().toISOString() };
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
      if (method === "GET" && parts.length === 1) return page(db.history, query);
      if (method === "POST" && parts.length === 1) {
        const row = { ...data, id: db.seq++, created_at: new Date().toISOString() };
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
        db.history[idx] = { ...db.history[idx], ...data, favorite: !db.history[idx].favorite };
        await writeDb(db);
        return ok(db.history[idx]);
      }
    }

    console.info("[LocalBackend] unsupported endpoint (no remote in 566Flow):", method, path);
    return fail("LOCAL_MODE_UNSUPPORTED", 404, `Not available in local mode: ${path}`);
  }

  // Make sure the UI always finds a signed-in local user.
  async function ensureLocalUser() {
    const stored = await chrome.storage.local.get(["af_auth"]);
    if (stored.af_auth?.token === LOCAL_TOKEN) return;
    await chrome.storage.local.set({
      af_auth: {
        token: LOCAL_TOKEN,
        user: LOCAL_USER,
        apiBaseUrl: "local",
        savedAt: Date.now(),
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
