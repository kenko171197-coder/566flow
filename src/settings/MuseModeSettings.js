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
class MuseModeSettings {
  static _log(stage, data = {}) {
    try {
      console.info("[SettingsMuse]", JSON.stringify({ stage, ...data }));
    } catch (_) {}
  }
  static _authScope() {
    const auth = window.authManager;
    return JSON.stringify([
      auth?.getUser?.()?.id ?? auth?.user?.id ?? null,
      auth?.getToken?.() ?? auth?.token ?? null,
    ]);
  }
  static _currentRightsSignature() {
    return JSON.stringify([
      this._authScope(),
      window.featureGate?.isInitialized?.() === true,
      window.featureGate?.canUse?.("muse_enabled") === true,
      window.featureGate?.canUse?.("muse_api_enabled") === true,
    ]);
  }
  static availability() {
    const runtime = window.ProviderConfigManager?.getApiConfigValueSync?.(
      "muse",
      "muse_api_runtime",
    );
    const entitled = window.featureGate?.canUse?.("muse_api_enabled") === true;
    const known =
      !this._rightsCheckFailed &&
      window.featureGate?.isInitialized?.() === true &&
      Object.hasOwn(window.featureGate.entitlements || {}, "muse_api_enabled");
    const reason =
      this._rightsCheckFailed || !known
        ? "MUSE_API_RIGHTS_UNVERIFIED"
        : !entitled
          ? "MUSE_API_FEATURE_REQUIRED"
          : !runtime
            ? "MUSE_API_CONFIG_REQUIRED"
            : runtime.enabled !== true
              ? "MUSE_API_DISABLED"
              : null;
    return {
      entitled,
      known,
      runtimePresent: !!runtime,
      runtimeEnabled: runtime?.enabled === true,
      selectable:
        !this._rightsCheckFailed && entitled && runtime?.enabled === true,
      reason,
    };
  }
  static _paintBadge(id, ready, checking = false) {
    const badges = [
      document.getElementById(id),
      id === "museApiModeBadge"
        ? document.getElementById("museBridgeStatus")
        : null,
    ];
    for (const badge of badges) {
      if (!badge) continue;
      badge.textContent = this.t(
        checking ? "checking" : ready ? "ready" : "unavailable",
      );
      badge.classList.toggle("is-ready", ready === true && !checking);
      badge.classList.toggle("is-checking", checking);
      badge.classList.toggle("is-warn", ready !== true && !checking);
      badge.setAttribute("aria-live", "polite");
      badge.setAttribute("aria-busy", String(checking));
    }
    if (id === "museApiModeBadge") this._paintApiConnection();
  }
  static _paintApiConnection(
    entitled = this.availability().entitled,
    known = this.availability().known,
  ) {
    const badge = document.getElementById("museApiModeBadge");
    const visual = document.getElementById("museApiLockedConnection");
    const locked = known && !entitled;
    const selectable = known && entitled && this.availability().selectable;
    const ready = selectable && badge?.classList.contains("is-ready") === true;
    const checking =
      selectable && badge?.classList.contains("is-checking") === true;
    if (visual) {
      visual.hidden = !(locked || ready || checking);
      visual.classList.toggle("is-connected", ready);
      visual.setAttribute("aria-busy", String(checking));
      visual.setAttribute(
        "aria-label",
        `Muse ${this.t("apiTitle")} \xB7 ${this.t(checking ? "checking" : ready ? "ready" : "disabled")}`,
      );
    }
    if (badge) badge.hidden = locked || ready;
  }
  static _setBusy(busy) {
    const button = document.getElementById("museRecheck");
    if (button) {
      button.disabled = busy;
      button.setAttribute("aria-busy", String(busy));
    }
    const spinner = document.getElementById("museRecheckSpinner");
    if (spinner) spinner.hidden = !busy;
    const label = document.getElementById("museRecheckLabel");
    if (label) label.textContent = this.t(busy ? "checking" : "recheck");
  }
  static invalidate() {
    this._rightsCheckFailed = false;
    this._lastStatusAt = 0;
    this._epoch++;
    this._choiceEpoch++;
    this._webTabId = null;
    const card = document.getElementById("museApiModeCard");
    if (card) card.disabled = true;
    this.renderLockedState(false, false);
    this._paintBadge("museApiModeBadge", false);
    this._paintBadge("museWebModeBadge", false);
    this.sync();
    this._setBusy(false);
  }
  static refreshIfStale(maxAgeMs) {
    if (
      document.hidden ||
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs < 0 ||
      Date.now() - this._lastStatusAt < maxAgeMs
    )
      return;
    return this.refresh();
  }
  static _observedTabChanged(tabId, removed = false) {
    if (this._webTabId !== tabId) return;
    this._epoch++;
    this._lastStatusAt = 0;
    this._paintBadge("museWebModeBadge", false);
    this._paintBadge("museApiModeBadge", false);
    if (removed) this._webTabId = null;
    this.refresh({ rerun: true });
  }
  static t(key, params) {
    return window.I18n?.t?.(`museApi.${key}`, params) || "";
  }
  static sync() {
    const saved = document.getElementById("museGenMode")?.value;
    const value =
      saved === "api" &&
      window.featureGate?.canUse?.("muse_api_enabled") !== true
        ? "web"
        : saved;
    for (const card of document.querySelectorAll("[data-muse-mode]")) {
      const selected = value === card.dataset.museMode;
      card.setAttribute("aria-checked", String(selected));
      card.tabIndex = selected && !card.disabled ? 0 : -1;
    }
    const web = document.getElementById("museWebModeCard");
    if (web && document.getElementById("museApiModeCard")?.disabled)
      web.tabIndex = 0;
  }
  static init(saveMode) {
    if (this._bound) return;
    this._bound = true;
    this._rightsSignature = this._currentRightsSignature();
    this._rightsCheckFailed =
      window.featureGate?.didLastRefreshSucceed?.() === false;
    const input = document.getElementById("museGenMode");
    const choose = async (card) => {
      if (!input || card.disabled) return;
      const choiceEpoch = ++this._choiceEpoch;
      input.value = card.dataset.museMode;
      this.sync();
      try {
        await saveMode(input.value);
      } catch (error) {
        if (choiceEpoch !== this._choiceEpoch) return;
        window.customDialog?.settingsSaveFailure?.(error);
        return;
      }
      if (choiceEpoch === this._choiceEpoch && input.value === "api")
        await this.refresh({ force: true });
    };
    for (const card of document.querySelectorAll("[data-muse-mode]")) {
      card.addEventListener("click", () => choose(card));
      card.addEventListener("keydown", (event) => {
        if (
          ![
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "Home",
            "End",
          ].includes(event.key)
        )
          return;
        event.preventDefault();
        const all = [...document.querySelectorAll("[data-muse-mode]")].filter(
          (el) => !el.disabled,
        );
        const next =
          event.key === "Home"
            ? all[0]
            : event.key === "End"
              ? all.at(-1)
              : all[
                  (all.indexOf(card) +
                    (["ArrowLeft", "ArrowUp"].includes(event.key)
                      ? all.length - 1
                      : 1)) %
                    all.length
                ];
        next?.focus();
        if (next) choose(next);
      });
    }
    document
      .getElementById("museRecheck")
      ?.addEventListener("click", () => this.refresh({ force: true }));
    document
      .getElementById("museApiUpgradeBtn")
      ?.addEventListener("click", () => {
        try {
          chrome.runtime.sendMessage({ action: "showUpgradeModal" });
        } catch (_) {}
      });
    window.eventBus?.on?.("provider:private_configs_loaded", () =>
      this.renderAvailability(),
    );
    window.eventBus?.on?.("featuregate:refreshed", () => {
      const signature = this._currentRightsSignature();
      const changed =
        signature !== this._rightsSignature || this._rightsCheckFailed;
      this._rightsSignature = signature;
      this._rightsCheckFailed = false;
      this.renderAvailability();
      if (this._checkingRights || !changed) return;
      this._epoch++;
      this.refresh({ rerun: true, forceConfig: true });
    });
    window.eventBus?.on?.("provider:api_config_updated", (event) => {
      if (!event?.provider || event.provider === "muse") {
        this._epoch++;
        this.refresh({ rerun: true, forceConfig: true });
      }
    });
    window.eventBus?.on?.("auth:logout", () => {
      this.invalidate();
      this.message("unavailable");
    });
    const tabs = window.chrome?.tabs;
    const removed = (id) => this._observedTabChanged(id, true);
    const updated = (id, change, tab) => {
      if (!["loading", "complete"].includes(change.status) && !change.url)
        return;
      if (id === this._webTabId) {
        this._observedTabChanged(id);
        return;
      }
      if (this._webTabId != null || change.status !== "complete") return;
      try {
        const base = window.ProviderConfigManager?.getBaseUrlSync?.("muse");
        if (
          base &&
          new URL(tab?.url || change.url).origin === new URL(base).origin
        )
          this.refresh({ rerun: true });
      } catch (_) {}
    };
    tabs?.onRemoved?.addListener(removed);
    tabs?.onUpdated?.addListener(updated);
    window.addEventListener("beforeunload", () => {
      this._disposed = true;
      this._epoch++;
      tabs?.onRemoved?.removeListener(removed);
      tabs?.onUpdated?.removeListener(updated);
    });
    this.refresh();
  }
  static message(key) {
    const el = document.getElementById("museModeGuideCopy");
    if (el) {
      el.textContent = this.t(key);
      el.hidden =
        key === "disabled" &&
        document.getElementById("museApiUpgradeBanner")?.hidden === false;
    }
  }
  static renderLockedState(entitled, known = true) {
    document
      .getElementById("museApiModeCard")
      ?.classList?.toggle("is-api-locked", known && !entitled);
    this._paintApiConnection(entitled, known);
    const banner = document.getElementById("museApiUpgradeBanner");
    if (banner) banner.hidden = !known || entitled;
  }
  static renderAvailability() {
    const availability = this.availability();
    const { entitled, known, selectable: enabled } = availability;
    const card = document.getElementById("museApiModeCard");
    const signature = JSON.stringify(availability);
    if (signature !== this._availabilitySignature) {
      this._availabilitySignature = signature;
      this._log("availability_changed", availability);
    }
    this.renderLockedState(entitled, known);
    if (card) card.disabled = !enabled;
    if (!enabled) this._paintBadge("museApiModeBadge", false);
    this.sync();
    return enabled;
  }
  static refresh({ force = false, rerun = false, forceConfig = false } = {}) {
    if (this._disposed) return Promise.resolve();
    if (this._refreshPromise) {
      if (force || rerun || forceConfig) this._refreshRequested = true;
      this._forceRequested || (this._forceRequested = force);
      this._configRequested || (this._configRequested = forceConfig);
      return this._refreshPromise;
    }
    this._forceRequested || (this._forceRequested = force);
    this._configRequested || (this._configRequested = forceConfig);
    this._setBusy(true);
    const work = (async () => {
      do {
        const fresh = this._forceRequested;
        const configFresh = fresh || this._configRequested;
        this._forceRequested = false;
        this._configRequested = false;
        this._refreshRequested = false;
        await this._refreshOnce(fresh, configFresh);
      } while (!this._disposed && this._refreshRequested);
    })();
    const flight = work.finally(() => {
      if (this._refreshPromise === flight) {
        this._refreshPromise = null;
        this._setBusy(false);
      }
    });
    this._refreshPromise = flight;
    return flight;
  }
  static async _refreshOnce(force, forceConfig = force) {
    const epoch = ++this._epoch,
      owner = this._authScope();
    const startedAt = Date.now();
    const current = () => {
      const valid =
        !this._disposed && epoch === this._epoch && owner === this._authScope();
      if (!valid) this._log("stale_check_ignored", { operationId: epoch });
      return valid;
    };
    this._log("check_started", {
      operationId: epoch,
      force,
      forceConfig,
      gateLoaded: !!window.featureGate,
    });
    this._setBusy(true);
    this._paintBadge("museApiModeBadge", false, true);
    this._paintBadge("museWebModeBadge", false, true);
    try {
      await window.featureGate?.init?.();
      this._rightsCheckFailed =
        window.featureGate?.didLastRefreshSucceed?.() === false;
      if (force) {
        this._checkingRights = true;
        try {
          await window.featureGate?.refresh?.({ force: true });
          this._rightsCheckFailed =
            window.featureGate?.didLastRefreshSucceed?.() === false;
        } finally {
          this._checkingRights = false;
        }
      }
      if (!current()) return;
      let configFailed = false;
      try {
        await window.ProviderConfigManager.fetchPrivateConfigs(forceConfig);
      } catch (_) {
        configFailed = true;
      }
      if (!current()) return;
      const enabled = this.renderAvailability();
      const web = await window.MuseSession.probeReady().catch(() => ({
        ready: false,
        error: "MUSE_WEB_CHECK_FAILED",
      }));
      if (!current()) return;
      this._webTabId = web.tabId || null;
      this._paintBadge("museWebModeBadge", web.ready === true);
      if (force && enabled) await window.BridgeClient?.ping?.(true);
      if (!current()) return;
      const api =
        enabled && !configFailed
          ? await window.MuseApiFacade.ensureReady({
              settings: { museTabId: this._webTabId },
            })
          : {
              ready: false,
              error: configFailed
                ? "MUSE_API_CONFIG_REQUIRED"
                : this.availability().reason || "MUSE_API_NOT_READY",
            };
      if (!current()) return;
      this._paintBadge("museApiModeBadge", api.ready === true);
      const apiCode =
        typeof api.error === "string"
          ? api.error.match(/^[A-Z][A-Z0-9_]{1,90}(?=[:\s]|$)/)?.[0]
          : typeof api.error?.code === "string" &&
              /^[A-Z][A-Z0-9_]{0,90}$/.test(api.error.code)
            ? api.error.code
            : null;
      const denied =
        !this._rightsCheckFailed &&
        window.featureGate?.isInitialized?.() === true &&
        Object.hasOwn(
          window.featureGate.entitlements || {},
          "muse_api_enabled",
        ) &&
        window.featureGate.canUse("muse_api_enabled") !== true;
      const reason = denied
        ? "disabled"
        : !enabled || configFailed
          ? "unavailable"
          : api.ready
            ? "apiHint"
            : api.error === "BRIDGE_NOT_INSTALLED"
              ? "installBridge"
              : [
                    "MUSE_BRIDGE_UPDATE_REQUIRED",
                    "MUSE_EXECUTOR_UNAVAILABLE",
                  ].includes(api.error)
                ? "updateBridge"
                : "openMuse";
      this.message(reason);
      this._lastStatusAt = Date.now();
      this._log("check_completed", {
        operationId: epoch,
        durationMs: Date.now() - startedAt,
        entitled: window.featureGate?.canUse?.("muse_api_enabled") === true,
        runtimePresent: this.availability().runtimePresent,
        runtimeEnabled: this.availability().runtimeEnabled,
        runtimeAvailable: enabled,
        configFailed,
        rightsCheckFailed: this._rightsCheckFailed,
        webReady: web.ready === true,
        apiReady: api.ready === true,
        apiCode: apiCode || (api.ready ? null : "MUSE_API_CHECK_FAILED"),
        readinessStage: api.readinessStage || null,
        errorKind: api.error == null ? null : typeof api.error,
        bridgeVersion:
          typeof api.bridgeVersion === "string" &&
          /^\d+(?:\.\d+){1,3}$/.test(api.bridgeVersion)
            ? api.bridgeVersion
            : null,
        executorVersion: Number.isSafeInteger(api.executorVersion)
          ? api.executorVersion
          : null,
        executorProtocol: Number.isSafeInteger(api.executorProtocol)
          ? api.executorProtocol
          : null,
      });
      const download = document.getElementById("museBridgeDownload");
      const url = window.ProviderConfigManager.getApiConfigValueSync(
        "flow",
        "bridge_download_url",
      );
      let valid = false;
      try {
        valid = typeof url === "string" && new URL(url).protocol === "https:";
      } catch (_) {}
      if (download) {
        download.hidden = !valid;
        if (valid) download.href = url;
        else download.removeAttribute("href");
      }
    } catch (_) {
      if (!current()) return;
      this._log("check_failed", {
        operationId: epoch,
        durationMs: Date.now() - startedAt,
      });
      this.renderAvailability();
      this.message("unavailable");
      this._lastStatusAt = Date.now();
      this._paintBadge("museApiModeBadge", false);
      const badge = document.getElementById("museWebModeBadge");
      if (badge?.classList.contains("is-checking"))
        this._paintBadge("museWebModeBadge", false);
    }
  }
}
__publicField(MuseModeSettings, "_bound", false);
__publicField(MuseModeSettings, "_epoch", 0);
__publicField(MuseModeSettings, "_choiceEpoch", 0);
__publicField(MuseModeSettings, "_webTabId", null);
__publicField(MuseModeSettings, "_refreshPromise", null);
__publicField(MuseModeSettings, "_refreshRequested", false);
__publicField(MuseModeSettings, "_forceRequested", false);
__publicField(MuseModeSettings, "_configRequested", false);
__publicField(MuseModeSettings, "_checkingRights", false);
__publicField(MuseModeSettings, "_disposed", false);
__publicField(MuseModeSettings, "_lastStatusAt", 0);
__publicField(MuseModeSettings, "_rightsCheckFailed", false);
__publicField(MuseModeSettings, "_rightsSignature", null);
__publicField(MuseModeSettings, "_availabilitySignature", null);
window.MuseModeSettings = MuseModeSettings;
