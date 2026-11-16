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
class GeminiSession {
  static _bindRuntimeListeners() {
    if (this._listenersBound) return;
    this._listenersBound = true;
    if (!chrome?.runtime?.onMessage) return;
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message.action !== "string") return;
      if (message.action === "gemini:tabClosed") {
        if (!this._tabId || message.tabId === this._tabId) {
          this._resetCache();
          this._emit("gemini:error", { error: "TAB_CLOSED" });
        }
      } else if (message.action === "gemini:navigatedBroadcast") {
        if (this._tabId && message.tabId === this._tabId) {
          this._ready = false;
          this._lastCheck = 0;
        }
      }
    });
  }
  static _resetCache() {
    this._tabId = null;
    this._ready = false;
    this._lastCheck = 0;
  }
  static _emit(eventName, data) {
    try {
      if (window.eventBus && typeof window.eventBus.emit === "function") {
        window.eventBus.emit(eventName, data || {});
      }
    } catch (err) {}
  }
  static _sendToBackground(action, payload = {}) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ action, ...payload }, (resp) => {
          if (chrome.runtime.lastError) {
            reject(
              new Error(chrome.runtime.lastError.message || "Runtime error"),
            );
            return;
          }
          if (!resp) {
            reject(
              new Error(
                "Kh\xF4ng nh\u1EADn \u0111\u01B0\u1EE3c ph\u1EA3n h\u1ED3i t\u1EEB background",
              ),
            );
            return;
          }
          resolve(resp);
        });
      } catch (err) {
        reject(err);
      }
    });
  }
  static async ensureReady(options = {}) {
    if (options.workerContext) return this._ensureWorkerReady(options);
    if (window.ExecutionConfig?.getProviderStartupTimeoutMs) {
      options = {
        ...options,
        waitForEditorMs:
          await window.ExecutionConfig.getProviderStartupTimeoutMs("gemini"),
      };
    }
    this._bindRuntimeListeners();
    const {
      createIfMissing = true,
      activate = true,
      focusWindow = false,
      silent = false,
      forceCheck = false,
      requireEditor = false,
      waitForEditorMs = 0,
    } = options;
    if (
      !forceCheck &&
      !requireEditor &&
      this._ready &&
      this._tabId &&
      Date.now() - this._lastCheck < this._readyTtlMs
    ) {
      if (activate) {
        const active = await this._sendToBackground("gemini:ensureActive", {
          tabId: this._tabId,
          focusWindow,
        }).catch((error) => ({
          success: false,
          error: error?.message || "ACTIVATE_FAILED",
        }));
        if (!active?.success) {
          this._resetCache();
        } else {
          return { ready: true, tabId: this._tabId };
        }
      } else {
        return { ready: true, tabId: this._tabId };
      }
    }
    try {
      const findResp = await this._sendToBackground("gemini:findOrCreateTab", {
        createIfMissing,
        activate,
      });
      if (!findResp.success || !findResp.tabId) {
        const error = findResp.error || "NO_TAB";
        if (!silent) this._emit("gemini:error", { error });
        return { ready: false, error };
      }
      this._tabId = findResp.tabId;
      if (activate) {
        const activeResp = await this._sendToBackground("gemini:ensureActive", {
          tabId: this._tabId,
          focusWindow,
        });
        if (!activeResp.success) {
          this._ready = false;
          return {
            ready: false,
            error: activeResp.error || "ACTIVATE_FAILED",
            tabId: this._tabId,
          };
        }
      }
      const editorDeadline =
        Date.now() + Math.max(0, Number(waitForEditorMs) || 0);
      let injectResp;
      do {
        injectResp = await this._sendToBackground("gemini:injectScript", {
          tabId: this._tabId,
        });
        if (
          injectResp.success ||
          injectResp.error !== "GEMINI_LISTENER_UNRESPONSIVE" ||
          Date.now() >= editorDeadline
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (true);
      if (!injectResp.success) {
        const error = injectResp.error || "INJECT_FAILED";
        if (!silent) this._emit("gemini:error", { error });
        return { ready: false, error, tabId: this._tabId };
      }
      let loginResp = await this._sendToBackground("gemini:checkLogin", {
        tabId: this._tabId,
      });
      while (
        loginResp?.error === "EDITOR_NOT_FOUND" &&
        Date.now() < editorDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        loginResp = await this._sendToBackground("gemini:checkLogin", {
          tabId: this._tabId,
        });
      }
      if (!loginResp.success || !loginResp.ready) {
        const error = loginResp.error || "NOT_LOGGED_IN";
        if (!silent) {
          if (error === "NOT_LOGGED_IN") {
            this._emit("gemini:login_required", { tabId: this._tabId });
          } else {
            this._emit("gemini:error", { error });
          }
        }
        return { ready: false, error, tabId: this._tabId };
      }
      if (requireEditor) {
        let editor;
        do {
          editor = await this._sendToBackground("gemini:checkEditorReady", {
            tabId: this._tabId,
          });
          if (
            (editor?.success && editor.ready) ||
            editor?.error !== "EDITOR_NOT_FOUND" ||
            Date.now() >= editorDeadline
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        } while (true);
        if (!editor?.success || !editor.ready) {
          this._ready = false;
          return {
            ready: false,
            tabId: this._tabId,
            error: editor?.error || "EDITOR_NOT_FOUND",
          };
        }
      }
      this._ready = true;
      this._lastCheck = Date.now();
      this._emit("gemini:ready", { tabId: this._tabId });
      return { ready: true, tabId: this._tabId };
    } catch (err) {
      console.error("[GeminiSession] ensureReady l\u1ED7i:", err.message);
      if (!silent) this._emit("gemini:error", { error: err.message });
      return { ready: false, error: err.message };
    }
  }
  static async _ensureWorkerReady({ workerContext, waitForEditorMs = 0 } = {}) {
    const tabId = workerContext?.tabId;
    if (!Number.isInteger(tabId))
      return { ready: false, error: "WORKER_TAB_INVALID" };
    const deadline = Date.now() + Math.max(0, Number(waitForEditorMs) || 0);
    do {
      const verifyAction =
        workerContext.motionWorker === true
          ? "motionWorker:verify"
          : "providerWorker:verify";
      const owner = await this._sendToBackground(
        verifyAction,
        workerContext,
      ).catch((error) => ({
        success: false,
        error: error?.message || "WORKER_OWNER_MISMATCH",
      }));
      if (owner?.error === "WORKER_TAB_LOADING" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (!owner?.success || owner.worker?.tabId !== tabId)
        return {
          ready: false,
          tabId,
          error: owner?.error || "WORKER_OWNER_MISMATCH",
        };
      const injected = await this._sendToBackground("gemini:injectScript", {
        tabId,
      }).catch((error) => ({
        success: false,
        error: error?.message || "INJECT_FAILED",
      }));
      if (injected?.success) {
        const login = await this._sendToBackground("gemini:checkLogin", {
          tabId,
        }).catch((error) => ({
          success: false,
          error: error?.message || "LOGIN_CHECK_FAILED",
        }));
        if (login?.success && login.ready) {
          const editor = await this._sendToBackground(
            "gemini:checkEditorReady",
            { tabId },
          ).catch((error) => ({
            success: false,
            error: error?.message || "EDITOR_CHECK_FAILED",
          }));
          if (editor?.success && editor.ready) {
            const current = await this._sendToBackground(
              verifyAction,
              workerContext,
            ).catch((error) => ({
              success: false,
              error: error?.message || "WORKER_OWNER_MISMATCH",
            }));
            if (
              current?.error === "WORKER_TAB_LOADING" &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 500));
              continue;
            }
            if (!current?.success || current.worker?.tabId !== tabId)
              return {
                ready: false,
                tabId,
                error: current?.error || "WORKER_OWNER_MISMATCH",
              };
            return { ready: true, tabId };
          }
          if (editor?.error && editor.error !== "EDITOR_NOT_FOUND")
            return { ready: false, tabId, error: editor.error };
        }
        if (
          !(login?.success && login.ready) &&
          login?.error !== "EDITOR_NOT_FOUND"
        )
          return {
            ready: false,
            tabId,
            error: login?.error || "NOT_LOGGED_IN",
          };
      } else if (
        ![
          "NO_RECEIVER",
          "INJECT_FAILED",
          "GEMINI_LISTENER_UNRESPONSIVE",
        ].includes(injected?.error)
      ) {
        return {
          ready: false,
          tabId,
          error: injected?.error || "INJECT_FAILED",
        };
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (true);
    return { ready: false, tabId, error: "EDITOR_NOT_FOUND" };
  }
  static async ensureTabActive() {
    this._bindRuntimeListeners();
    if (!this._tabId) return;
    try {
      await this._sendToBackground("gemini:ensureActive", {
        tabId: this._tabId,
        focusWindow: false,
      });
    } catch (err) {
      console.warn("[GeminiSession] ensureTabActive l\u1ED7i:", err.message);
    }
  }
  static async forceRefresh(timeoutMs) {
    this._bindRuntimeListeners();
    if (!this._tabId) return { ready: false, error: "NO_TAB" };
    const tabId = this._tabId;
    this._ready = false;
    this._lastCheck = 0;
    await chrome.tabs.reload(tabId);
    if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0)
      return { ready: false, error: "REFRESH_CONFIG_INVALID" };
    const deadline = Date.now() + Number(timeoutMs);
    await new Promise((resolve) => setTimeout(resolve, 150));
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    while (Date.now() < deadline) {
      const ready = await this.ensureReady({
        createIfMissing: false,
        activate: true,
      });
      if (ready?.ready) return ready;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
    return { ready: false, error: "REFRESH_READY_TIMEOUT", tabId };
  }
  static async reconnectAfterNavigation(timeoutMs) {
    this._bindRuntimeListeners();
    if (!this._tabId) return { ready: false, error: "NO_TAB" };
    const tabId = this._tabId;
    const waitMs = Number(timeoutMs);
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return { ready: false, error: "RECONNECT_CONFIG_INVALID" };
    this._ready = false;
    this._lastCheck = 0;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (tab?.status === "complete") {
        const ready = await this.ensureReady({
          createIfMissing: false,
          activate: true,
          silent: true,
        });
        if (ready?.ready) return ready;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return { ready: false, error: "RECONNECT_READY_TIMEOUT", tabId };
  }
  static async getTabInfo() {
    this._bindRuntimeListeners();
    if (!this._tabId) {
      return { tabId: null, url: null, active: false };
    }
    try {
      const resp = await this._sendToBackground("gemini:getTabInfo", {
        tabId: this._tabId,
      });
      return {
        tabId: this._tabId,
        url: resp?.url || null,
        active: !!resp?.active,
      };
    } catch (err) {
      return { tabId: this._tabId, url: null, active: false };
    }
  }
  static async closeTab() {
    this._bindRuntimeListeners();
    if (!this._tabId) return;
    try {
      await this._sendToBackground("gemini:closeTab", { tabId: this._tabId });
    } catch (err) {
      console.warn("[GeminiSession] closeTab l\u1ED7i:", err.message);
    } finally {
      this._resetCache();
    }
  }
  static async deleteCurrentConversation(options = {}) {
    this._bindRuntimeListeners();
    const tabId = options.workerContext?.tabId || this._tabId;
    const expectedConversationUrl = options.expectedConversationUrl || null;
    if (
      options.workerContext &&
      (!expectedConversationUrl ||
        !/^https:\/\/gemini\.google\.com\/(?:u\/\d+\/)?app\/[^/?#]+\/?(?:[?#].*)?$/.test(
          expectedConversationUrl,
        ))
    ) {
      return { success: false, error: "CONVERSATION_URL_UNVERIFIED" };
    }
    if (!tabId) {
      console.warn(
        "[GeminiSession] deleteCurrentConversation: kh\xF4ng c\xF3 tabId",
      );
      return { success: false, error: "No tab" };
    }
    try {
      return await new Promise((resolve) => {
        chrome.tabs.sendMessage(
          tabId,
          {
            action: "gemini:deleteCurrentConversation",
            ...(expectedConversationUrl && { expectedConversationUrl }),
          },
          (response) =>
            resolve(
              chrome.runtime.lastError
                ? {
                    success: false,
                    error: chrome.runtime.lastError.message || "NO_RECEIVER",
                  }
                : response || { success: false, error: "No response" },
            ),
        );
      });
    } catch (err) {
      console.warn(
        "[GeminiSession] deleteCurrentConversation l\u1ED7i:",
        err.message,
      );
      return { success: false, error: err.message };
    }
  }
}
__publicField(GeminiSession, "_tabId", null);
__publicField(GeminiSession, "_ready", false);
__publicField(GeminiSession, "_lastCheck", 0);
__publicField(GeminiSession, "_readyTtlMs", 60 * 1e3);
__publicField(GeminiSession, "_listenersBound", false);
if (typeof window !== "undefined") {
  window.GeminiSession = GeminiSession;
}
