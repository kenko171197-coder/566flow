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
class ConfigAccessUI {
  static primeNormalWindow() {
    if (this._normalWindowFlight) return this._normalWindowFlight;
    const flight = chrome.windows
      .getAll({ windowTypes: ["normal"] })
      .then((windows) => {
        const selected = windows.find((item) => item.focused) || windows[0];
        this._normalWindowId = Number.isInteger(selected?.id)
          ? selected.id
          : null;
        return this._normalWindowId;
      })
      .catch(() => {
        this._normalWindowId = null;
        return null;
      });
    this._normalWindowFlight = flight;
    flight.finally(() => {
      if (this._normalWindowFlight === flight) this._normalWindowFlight = null;
    });
    return flight;
  }
  static openLoginInSidebar() {
    return chrome.runtime.sendMessage({
      action: "openLoginSidePanel",
      windowId: this._normalWindowId,
    });
  }
  static reportLoginOpenFailure(error) {
    window.customDialog?.alert?.(String(error || "SIDEBAR_OPEN_FAILED"), {
      title: window.I18n?.t?.("common.error") || "Error",
      type: "error",
    });
    this.primeNormalWindow().catch(() => {});
  }
  static async _openSettingsForAccess(tab = null) {
    try {
      const result = await chrome.runtime.sendMessage({
        action: "openSettings",
        ...(tab ? { tab } : {}),
      });
      if (result?.ok) return;
      throw new Error(result?.error || "SETTINGS_OPEN_FAILED");
    } catch (error) {
      window.customDialog?.alert?.(error?.message || "SETTINGS_OPEN_FAILED", {
        title: window.I18n?.t?.("common.error") || "Error",
        type: "error",
      });
      window.customDialog?._overlay?.classList.add(
        "cdialog-overlay--config-access",
      );
    }
  }
  static _showWorkflowLoginModal() {
    if (this._loginPromptShown || this._loginPromptFlight)
      return this._loginPromptFlight;
    const flight = (async () => {
      await this.primeNormalWindow();
      if (this._state?.code !== "AUTH_REQUIRED") return;
      const dialog = window.customDialog;
      if (!dialog?.alert) return;
      this._loginPromptShown = true;
      this._loginPromptOpen = true;
      dialog.alert(
        window.I18n?.t?.("configAccess.login") ||
          "Sign in to load generation configuration.",
        {
          title: window.I18n?.t?.("auth.login") || "Login",
          type: "warning",
          buttons: [
            {
              label: window.I18n?.t?.("common.cancel") || "Cancel",
              primary: false,
              action: () => {
                this._loginPromptOpen = false;
              },
            },
            {
              label: window.I18n?.t?.("auth.login") || "Login",
              primary: true,
              action: () => {
                this._loginPromptOpen = false;
                this.openLoginInSidebar()
                  .then((result) => {
                    if (!result?.ok) this.reportLoginOpenFailure(result?.error);
                  })
                  .catch((error) =>
                    this.reportLoginOpenFailure(error?.message),
                  );
              },
            },
          ],
        },
      );
      dialog._overlay?.classList.add("cdialog-overlay--config-access");
    })();
    this._loginPromptFlight = flight;
    flight.finally(() => {
      if (this._loginPromptFlight === flight) this._loginPromptFlight = null;
    });
    return flight;
  }
  static async _replaceDeviceIdentity(code) {
    console.info(
      "[ConfigAccessUI] replacement confirmation",
      JSON.stringify({ code, stage: "opened" }),
    );
    const reasonKey = this._keyReasonKey(code);
    const reason = reasonKey ? window.I18n?.t?.(reasonKey) : null;
    const explanation =
      reason && reason !== reasonKey
        ? `${reason}

`
        : "";
    const confirmed = await window.customDialog?.confirm?.(
      explanation + (window.I18n?.t?.("configAccess.confirm") || ""),
      {
        title: window.I18n?.t?.("configAccess.key") || code,
        type: "warning",
        confirmText:
          window.I18n?.t?.(
            code === "REPLACEMENT_RESPONSE_LOST"
              ? "configAccess.retryReplacement"
              : "configAccess.replace",
          ) || "",
        cancelText: window.I18n?.t?.("common.cancel") || "Cancel",
      },
    );
    console.info(
      "[ConfigAccessUI] replacement confirmation",
      JSON.stringify({ code, stage: confirmed ? "confirmed" : "cancelled" }),
    );
    if (!confirmed) return;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "REPLACE_DEVICE_IDENTITY",
        confirmed: true,
        retryOrphan: code === "REPLACEMENT_RESPONSE_LOST",
      });
      if (!result?.success) {
        this._accessPromptCode = null;
        this.show({
          code: result?.error?.code || "CONFIG_CONTRACT_UNAVAILABLE",
        });
        return;
      }
      const claim = await window.ExtensionDeviceManager?.claim?.();
      if (claim?.registered !== true) {
        this._accessPromptCode = null;
        this.show({ code: claim?.registration_code || "DEVICE_UNREGISTERED" });
        return;
      }
      await window.ProviderConfigManager?.fetch?.();
      await this.refresh();
    } catch (error) {
      this._accessPromptCode = null;
      this.show({ code: error?.code || "CONFIG_CONTRACT_UNAVAILABLE" });
    }
  }
  static _keyReasonKey(code) {
    return (
      {
        KEY_MISSING: "configAccess.keyMissing",
        KEY_MISMATCH: "configAccess.keyMismatch",
        CLIENT_RESET_REQUIRES_REPLACEMENT: "configAccess.clientReset",
        REPLACEMENT_RESPONSE_LOST: "configAccess.lost",
      }[code] || null
    );
  }
  static _showAccessModal(code, group) {
    if (this._accessPromptCode === code) return;
    const dialog = window.customDialog;
    if (!dialog?.alert) return;
    if (window.I18n?._initialized === false) return;
    const settingsPage = location.pathname === "/settings.html";
    const isKey = group === "key";
    const isDeviceBlocked = /DEVICE|KEY_REVOKED/.test(code);
    const reasonKey = isKey ? this._keyReasonKey(code) : null;
    const translated = (key) => {
      const value = window.I18n?.t?.(key);
      return typeof value === "string" && value.trim() && value !== key
        ? value
        : null;
    };
    const messageKey = reasonKey || `configAccess.${group}`;
    const translatedMessage = window.I18n?.t?.(messageKey);
    let message =
      translatedMessage && translatedMessage !== messageKey
        ? translatedMessage
        : window.I18n?.t?.(`configAccess.${group}`) || code;
    if (code === "KEY_MISSING")
      message = translated("configAccess.keyReadFailed") || message;
    let title =
      window.I18n?.t?.(
        isKey
          ? "configAccess.replace"
          : group === "device"
            ? "configAccess.devices"
            : "common.error",
      ) || code;
    if (code === "KEY_MISSING")
      title =
        translated("configAccess.keyCheck") ||
        translated("common.error") ||
        title;
    if (group === "blocked") {
      const help = window.I18n?.t?.("configAccess.blockedHelp");
      if (help && help !== "configAccess.blockedHelp") {
        title = message;
        message = help;
      }
    }
    const buttons = [
      {
        label: window.I18n?.t?.("common.close") || "Close",
        primary: false,
        action: () => {
          this._accessPromptOpen = false;
        },
      },
    ];
    let keyRetryButton = null;
    if (code === "KEY_MISSING") {
      keyRetryButton = {
        label: window.I18n?.t?.("common.retry") || "",
        primary: true,
        action: async () => {
          this._accessPromptOpen = false;
          try {
            const result = await this.retry("manual");
            if (result?.success) return;
            if (this._state?.code !== code) return;
            this._accessPromptCode = null;
            this.showForAction({
              code: result?.error?.code || "CONFIG_FETCH_FAILED",
            });
          } catch (error) {
            if (this._state?.code !== code) return;
            this._accessPromptCode = null;
            this.showForAction({ code: error?.code || "CONFIG_FETCH_FAILED" });
          }
        },
      };
    }
    if (isKey && settingsPage && code !== "KEY_MISSING") {
      buttons.push({
        label:
          window.I18n?.t?.(
            code === "REPLACEMENT_RESPONSE_LOST"
              ? "configAccess.retryReplacement"
              : "configAccess.replace",
          ) || "",
        primary: code !== "KEY_MISSING",
        action: () => {
          this._accessPromptOpen = false;
          this._replaceDeviceIdentity(code).catch(() => {});
        },
      });
    } else if (!settingsPage && code !== "KEY_MISSING") {
      buttons.push({
        label:
          window.I18n?.t?.(
            isDeviceBlocked ? "configAccess.devices" : "configAccess.settings",
          ) || "Settings",
        primary: code !== "KEY_MISSING",
        action: () => {
          this._accessPromptOpen = false;
          this._openSettingsForAccess(isDeviceBlocked ? "devices" : null).catch(
            () => {},
          );
        },
      });
    } else if (isDeviceBlocked) {
      buttons.push({
        label: window.I18n?.t?.("configAccess.devices") || "Devices",
        primary: true,
        action: () => {
          this._accessPromptOpen = false;
          location.hash = "#devices";
          document.querySelector('.settings-tab[data-tab="devices"]')?.click();
        },
      });
    }
    if (keyRetryButton) buttons.push(keyRetryButton);
    if (buttons.length === 1) buttons[0].primary = true;
    this._accessPromptCode = code;
    this._accessPromptOpen = true;
    dialog.alert(message, {
      title,
      type: group === "blocked" ? "error" : "warning",
      buttons,
    });
    dialog._overlay?.classList.add("cdialog-overlay--config-access");
  }
  static refreshCopy() {
    if (this._accessPromptOpen) {
      window.customDialog?._close?.();
      this._accessPromptCode = null;
      this._accessPromptOpen = false;
    }
    this.show(this._state, { passive: this._passiveKeyError });
  }
  static _accessGroup(code) {
    if (["CONFIG_SCOPE_CHANGED", "CONFIG_ACCESS_INVALIDATED"].includes(code))
      return "pending";
    if (code === "AUTH_REQUIRED") return "login";
    if (
      [
        "KEY_MISSING",
        "KEY_MISMATCH",
        "CLIENT_RESET_REQUIRES_REPLACEMENT",
        "REPLACEMENT_RESPONSE_LOST",
      ].includes(code)
    )
      return "key";
    if (
      /DEVICE_(UNREGISTERED|LIMIT|REVOKED)|EXTENSION_DEVICE_(LIMIT|REVOKED)/.test(
        code,
      )
    )
      return "device";
    if (/BANNED|BLOCKED|DISABLED|KEY_REVOKED|NOT_AUTHORIZED/.test(code))
      return "blocked";
    return "service";
  }
  static ownsConnectivityUI() {
    return location.pathname === "/sidebar.html";
  }
  static serviceUnavailable() {
    return (
      !!this._state?.code && this._accessGroup(this._state.code) === "service"
    );
  }
  static retry(trigger = "manual") {
    if (this._retryFlight) return this._retryFlight;
    const flight = chrome.runtime
      .sendMessage({ action: "RETRY_PROTECTED_CONFIG", trigger })
      .then(async (result) => {
        if (result?.success) {
          if (!(await this.recovered()))
            return {
              success: false,
              error: { code: this._state?.code || "CONFIG_FETCH_FAILED" },
              httpStatus: this._state?.httpStatus,
              retryable: this._state?.retryable === true,
            };
        } else await this.refresh();
        return result;
      });
    this._retryFlight = flight;
    flight
      .finally(() => {
        if (this._retryFlight === flight) this._retryFlight = null;
      })
      .catch(() => {});
    return flight;
  }
  static recovered() {
    if (this._recoveredFlight) return this._recoveredFlight;
    const flight = (async () => {
      const loaders = [
        () => window.ProviderConfigManager?.fetch?.(),
        () => window.ProviderConfigManager?._fetchApiConfigs?.(),
        () => window.ProviderConfigManager?.fetchPrivateConfigs?.(),
        () => window.ModelRegistry?.fetch?.(),
        () => window.ExecutionConfig?.getConfig?.(),
      ];
      const reads = await Promise.allSettled(
        loaders.map((load) => Promise.resolve().then(load)),
      );
      let status = await RequestSigner.protectedStatus();
      const isPending = (error) =>
        !!error?.code && this._accessGroup(error.code) === "pending";
      const stale = reads
        .map((read, index) =>
          read.status === "rejected" && isPending(read.reason) ? index : -1,
        )
        .filter((index) => index >= 0);
      if (status.ready && stale.length) {
        console.info(
          "[ConfigAccessUI] Rehydrating invalidated config",
          JSON.stringify({ failedReads: stale }),
        );
        const fresh = await Promise.allSettled(
          stale.map((index) => Promise.resolve().then(loaders[index])),
        );
        stale.forEach((index, position) => {
          reads[index] = fresh[position];
        });
        status = await RequestSigner.protectedStatus();
      }
      const failed = reads
        .map((read, index) => (read.status === "rejected" ? index : -1))
        .filter((index) => index >= 0);
      if (!status.ready || failed.length) {
        if (status.ready && failed.length) {
          const errors = failed.map((index) => reads[index].reason);
          console.warn(
            "[ConfigAccessUI] Local config hydration failed",
            JSON.stringify({
              failedReads: failed,
              codes: errors.map((error) => error?.code || null),
            }),
          );
          const denied = errors.find(
            (error) =>
              error?.code &&
              !["pending", "service"].includes(this._accessGroup(error.code)),
          );
          const pending = errors.every(isPending) ? errors[0] : null;
          this.show(
            denied ||
              pending || { code: "CONFIG_FETCH_FAILED", retryable: true },
          );
        } else this.show(status);
        return false;
      }
      this.show(null);
      window.eventBus?.emit?.("provider:updated", {
        source: "config_recovery",
      });
      window.eventBus?.emit?.("config:protected_ready");
      return true;
    })();
    this._recoveredFlight = flight;
    flight
      .finally(() => {
        if (this._recoveredFlight === flight) this._recoveredFlight = null;
      })
      .catch(() => {});
    return flight;
  }
  static async refresh() {
    const requestId = ++this._statusRequestId,
      stateRevision = this._stateRevision;
    const status = await RequestSigner.protectedStatus();
    if (
      requestId === this._statusRequestId &&
      stateRevision === this._stateRevision
    ) {
      this.show(status.ready ? null : status, { passive: true });
    } else
      console.info(
        "[ConfigAccessUI] Stale status response ignored",
        JSON.stringify({
          page: location.pathname,
          requestId,
          latestRequestId: this._statusRequestId,
          stateChanged: stateRevision !== this._stateRevision,
          code: status.code || null,
          ready: status.ready === true,
        }),
      );
    return status;
  }
  static showForAction(state) {
    if (!this._accessPromptOpen) this._accessPromptCode = null;
    this.show(state);
    if (this.serviceUnavailable())
      document
        .getElementById("tobyflow-offline-overlay")
        ?.classList.remove("hidden");
  }
  static show(state, { passive = false } = {}) {
    // 566Flow: there is no remote configuration service; never block the UI on it.
    if (state?.code)
      console.warn("[566Flow] ignored config access state", state.code);
    state = null;
    this._passiveKeyError =
      passive &&
      state?.code === "KEY_MISSING" &&
      !(this._accessPromptOpen && this._accessPromptCode === "KEY_MISSING");
    const previousCode = this._state?.code;
    const previousGroup = this._state?.code
      ? this._accessGroup(this._state.code)
      : null;
    if (state !== this._state) this._stateRevision++;
    this._state = state;
    if (state?.code !== previousCode) {
      console.log(
        "[ConfigAccessUI] status",
        JSON.stringify({
          page: location.pathname,
          code: state?.code || null,
          group: state?.code ? this._accessGroup(state.code) : null,
          retryable: state?.retryable === true,
          enrollmentFailure: state?.enrollmentFailure === true,
          retryAfterMs: state?.retryAfterMs ?? null,
          httpStatus: state?.httpStatus ?? null,
        }),
      );
    }
    if (state?.code !== "AUTH_REQUIRED") {
      if (this._loginPromptOpen) window.customDialog?._close?.();
      this._loginPromptOpen = false;
      this._loginPromptShown = false;
    }
    if (state?.code !== this._accessPromptCode) {
      if (this._accessPromptOpen) window.customDialog?._close?.();
      this._accessPromptCode = null;
      this._accessPromptOpen = false;
    }
    window.ConfigErrorHandler?.hideOverlay?.();
    if (document.getElementById("tobyflow-offline-overlay")) {
      window.eventBus?.emit?.(
        "config:service_unavailable",
        this.serviceUnavailable() ? state : null,
      );
      if (this.serviceUnavailable()) return;
    } else if (this.serviceUnavailable() && this.ownsConnectivityUI()) {
      window.ConfigErrorHandler?.showOverlay?.({
        title: window.ConfigErrorHandler._t("dialog.offline"),
        message: window.ConfigErrorHandler._t("dialog.offlineDescription"),
      });
      return;
    } else if (this.serviceUnavailable()) return;
    if (!state?.code || !document.body) return;
    const code = state.code;
    const group = this._accessGroup(code);
    if (group === "pending" || this._passiveKeyError) return;
    if (group === "login") {
      if (
        location.pathname === "/workflow-editor.html" ||
        location.pathname === "/workflow-template-editor.html" ||
        location.pathname === "/motion-editor.html"
      ) {
        Promise.resolve(this._showWorkflowLoginModal()).catch((error) =>
          console.warn("[ConfigAccessUI] login modal:", error?.message),
        );
      }
      return;
    }
    if (group === "device") {
      if (location.pathname === "/settings.html") {
        if (previousGroup !== "device") {
          location.hash = "#devices";
          document.querySelector('.settings-tab[data-tab="devices"]')?.click();
        }
      } else if (
        code === "EXTENSION_DEVICE_LIMIT_REACHED" &&
        previousCode !== code
      ) {
        window.ExtensionDeviceManager?.claim?.()?.catch?.(() => {});
      } else if (
        code !== "DEVICE_UNREGISTERED" &&
        code !== "EXTENSION_DEVICE_LIMIT_REACHED"
      ) {
        this._showAccessModal(code, group);
      }
      return;
    }
    this._showAccessModal(code, group);
  }
}
__publicField(ConfigAccessUI, "_state", null);
__publicField(ConfigAccessUI, "_passiveKeyError", false);
__publicField(ConfigAccessUI, "_stateRevision", 0);
__publicField(ConfigAccessUI, "_statusRequestId", 0);
__publicField(ConfigAccessUI, "_accessPromptCode", null);
__publicField(ConfigAccessUI, "_accessPromptOpen", false);
__publicField(ConfigAccessUI, "_retryFlight", null);
__publicField(ConfigAccessUI, "_recoveredFlight", null);
__publicField(ConfigAccessUI, "_normalWindowId", null);
__publicField(ConfigAccessUI, "_normalWindowFlight", null);
__publicField(ConfigAccessUI, "_loginPromptShown", false);
__publicField(ConfigAccessUI, "_loginPromptFlight", null);
__publicField(ConfigAccessUI, "_loginPromptOpen", false);
window.ConfigAccessUI = ConfigAccessUI;
window.eventBus?.on?.("config:access_required", (state) =>
  ConfigAccessUI.show(state),
);
window.eventBus?.on?.("config:protected_ready", () =>
  ConfigAccessUI.refresh().catch(() => {}),
);
window.eventBus?.on?.("provider:models_updated", () =>
  ConfigAccessUI.refresh().catch(() => {}),
);
window.eventBus?.on?.("i18n:changed", () => ConfigAccessUI.refreshCopy());
window.eventBus?.on?.("i18n:reloaded", () => ConfigAccessUI.refreshCopy());
document.addEventListener("DOMContentLoaded", () => {
  ConfigAccessUI.primeNormalWindow().catch(() => {});
  ConfigAccessUI.refresh().catch(() => {});
});
try {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "CONFIG_ACCESS_INVALIDATED")
      ConfigAccessUI.show(
        { code: message.code, retryable: message.retryable },
        { passive: true },
      );
    if (message.type === "CONFIG_ACCESS_RECOVERED") {
      if (ConfigAccessUI.ownsConnectivityUI())
        ConfigAccessUI.recovered().catch(() => {});
      else ConfigAccessUI.refresh().catch(() => {});
    }
  });
  window.addEventListener("online", () => {
    if (ConfigAccessUI.ownsConnectivityUI())
      ConfigAccessUI.retry("online").catch(() => {});
  });
} catch (_) {}
