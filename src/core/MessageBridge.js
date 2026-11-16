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
const _MessageBridge = class _MessageBridge {
  static async _sendFlowMessage(
    tabId,
    payload,
    { timeoutMs, signal, onDispatch, onNotDispatched } = {},
  ) {
    if (signal?.aborted)
      throw Object.assign(new Error("Aborted"), {
        name: "AbortError",
        code: "ABORTED",
        noRetry: true,
      });
    const commandStartedAt = Date.now();
    let timer, onAbort;
    try {
      onDispatch?.();
      const response = await Promise.race([
        chrome.tabs.sendMessage(tabId, payload),
        new Promise((_, reject) => {
          if (Number.isFinite(timeoutMs))
            timer = setTimeout(
              () =>
                reject(
                  Object.assign(new Error("FLOW_COMMAND_ACK_TIMEOUT"), {
                    code: "FLOW_COMMAND_ACK_TIMEOUT",
                    noRetry: true,
                    notDispatched: false,
                    flowCommandAction: payload.action,
                    flowCommandWaitMs: Math.max(
                      0,
                      Date.now() - commandStartedAt,
                    ),
                  }),
                ),
              Math.max(0, timeoutMs),
            );
          if (signal) {
            onAbort = () =>
              reject(
                Object.assign(new Error("Aborted"), {
                  name: "AbortError",
                  code: "ABORTED",
                  noRetry: true,
                }),
              );
            signal.addEventListener("abort", onAbort, { once: true });
            if (signal.aborted) onAbort();
          }
        }),
      ]);
      if (response == null) {
        console.warn(
          "[FlowCommandResponse] missing acknowledgement",
          JSON.stringify({
            action: payload.action,
            tabId,
            responseType: typeof response,
          }),
        );
        throw Object.assign(new Error("FLOW_CONTENT_NO_RESPONSE"), {
          code: "FLOW_CONTENT_NO_RESPONSE",
          noRetry: true,
          notDispatched: false,
        });
      }
      return response;
    } catch (error) {
      const dispatchError = String(error?.message || "").toLowerCase();
      if (
        dispatchError.includes("could not establish connection") ||
        dispatchError.includes("receiving end does not exist")
      ) {
        error.notDispatched = true;
        onNotDispatched?.();
      }
      if (error?.code === "FLOW_COMMAND_ACK_TIMEOUT") {
        console.warn(
          "[FlowCommandResponse] acknowledgement timeout",
          JSON.stringify({
            action: payload.action,
            tabId,
            timeoutMs,
            elapsedMs: error.flowCommandWaitMs,
            driver: payload._flowTarget?.driverKey || null,
            projectId: payload._flowTarget?.projectId || null,
          }),
        );
        try {
          void chrome.tabs
            .get(tabId)
            .then((tab) =>
              console.warn(
                "[FlowCommandResponse] target tab state",
                JSON.stringify({
                  action: payload.action,
                  tabId,
                  active: tab.active === true,
                  discarded: tab.discarded === true,
                  frozen: typeof tab.frozen === "boolean" ? tab.frozen : null,
                  status: tab.status || null,
                }),
              ),
            )
            .catch(() => {});
        } catch (_) {}
      }
      const requestId = payload.flowScanRequestId || payload.metadataRequestId;
      if (
        requestId &&
        (error?.name === "AbortError" ||
          error?.code === "FLOW_COMMAND_ACK_TIMEOUT")
      ) {
        Promise.resolve(
          chrome.tabs.sendMessage(tabId, {
            action: "cancelFlowScanRequest",
            requestId,
            _flowTarget: payload._flowTarget,
          }),
        ).catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
  static _flowPerfMemorySnapshot() {
    const memory = globalThis.performance?.memory;
    return {
      usedJsHeapMb: Number.isFinite(memory?.usedJSHeapSize)
        ? Math.round(memory.usedJSHeapSize / 1048576)
        : null,
      totalJsHeapMb: Number.isFinite(memory?.totalJSHeapSize)
        ? Math.round(memory.totalJSHeapSize / 1048576)
        : null,
    };
  }
  static _isExpectedFlowControlError(action, error) {
    const code = String(error?.code || "");
    const message = String(error?.message || error || "");
    if (
      [
        "FLOW_EXECUTION_TARGET_CHANGED",
        "METADATA_SCAN_TIMEOUT",
        "UPLOAD_STOPPED",
      ].includes(code) ||
      [
        "FLOW_EXECUTION_TARGET_CHANGED",
        "METADATA_SCAN_TIMEOUT",
        "UPLOAD_STOPPED",
      ].includes(message)
    )
      return true;
    if (
      (code === "VIDEO_TILE_NOT_FOUND" || message === "VIDEO_TILE_NOT_FOUND") &&
      action === "resolveVideoPlaybackUrl"
    )
      return true;
    return (
      message === "Target tab is not a supported Flow page" ||
      message === "Google Flow tab not found" ||
      (action === "applyFlowPageSettings" &&
        message.includes("homepage or media viewer is not a generation editor"))
    );
  }
  static hasActiveWebUpload() {
    return [...this._uploadControls].some(
      (control) => control.activeRoute === "web",
    );
  }
  static createUploadControl(total, upstreamAbort) {
    if (!this._uploadControls.size || !this._uploadControlSettled) {
      this._uploadControlSettled = { completed: 0, total: 0 };
    }
    const control = {
      total,
      completed: 0,
      paused:
        this._uploadControls.size > 0 &&
        [...this._uploadControls].every((value) => value.paused),
      cancelled: false,
      cancelListeners: new Set(),
      onCancel: (listener) => {
        control.cancelListeners.add(listener);
        if (control.cancelled) listener();
        return () => control.cancelListeners.delete(listener);
      },
      cancel: () => {
        if (control.cancelled) return;
        control.cancelled = true;
        control.paused = false;
        for (const listener of control.cancelListeners) listener();
        this._renderUploadControls();
      },
      abortFn: () => control.cancelled || upstreamAbort?.() === true,
      checkpoint: async () => {
        while (control.paused && !control.abortFn())
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (control.abortFn()) throw new Error("UPLOAD_STOPPED");
      },
      progress: (completed) => {
        control.completed = completed;
        this._renderUploadControls();
      },
      finish: () => {
        if (this._uploadControls.delete(control)) {
          this._uploadControlSettled.completed += control.completed;
          this._uploadControlSettled.total += control.total;
        }
        this._renderUploadControls();
      },
    };
    this._uploadControls.add(control);
    this._renderUploadControls();
    return control;
  }
  static createUploadControlPanel({ id, onPause, onCancel } = {}) {
    if (typeof document === "undefined" || !document.body) return null;
    const t = (key, fallback) => {
      const value = window.I18n?.t?.(key);
      return value && value !== key ? value : fallback;
    };
    const panel = document.createElement("div");
    panel.className = "upload-controls-panel";
    if (id) panel.id = id;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", t("uploadControls.title", "Upload"));
    const icon = document.createElement("span");
    icon.className = "upload-controls-icon";
    icon.setAttribute("aria-hidden", "true");
    const content = document.createElement("div");
    content.className = "upload-controls-content";
    const label = document.createElement("span");
    label.className = "upload-controls-label";
    label.setAttribute("role", "status");
    const progress = document.createElement("div");
    progress.className = "upload-controls-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", t("uploadControls.title", "Upload"));
    progress.setAttribute("aria-valuemin", "0");
    const fill = document.createElement("span");
    fill.className = "upload-controls-progress-fill";
    progress.appendChild(fill);
    content.append(label, progress);
    const actions = document.createElement("div");
    actions.className = "upload-controls-actions";
    const pause = document.createElement("button");
    pause.type = "button";
    const cancel = document.createElement("button");
    cancel.type = "button";
    pause.className = "upload-controls-button";
    cancel.className = "upload-controls-button upload-controls-button--cancel";
    const pauseIcon = document.createElement("span");
    pauseIcon.className = "upload-controls-button-icon";
    pauseIcon.setAttribute("aria-hidden", "true");
    const pauseLabel = document.createElement("span");
    pause.append(pauseIcon, pauseLabel);
    let fallbackIconAnimation = null;
    if (
      !document.querySelector(
        'link[href="sidebar.css"], link[href="src/shared/upload-controls.css"]',
      )
    ) {
      panel.style.cssText =
        "position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #555;border-radius:10px;background:#202124;color:#fff;font:12px system-ui;box-shadow:0 4px 16px #0005;";
      icon.style.cssText =
        "width:14px;height:14px;border:2px solid #777;border-top-color:#ccff00;border-radius:50%;";
      fallbackIconAnimation = icon.animate?.(
        [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
        { duration: 850, iterations: Infinity },
      );
      content.style.cssText = "min-width:70px;";
      progress.style.cssText =
        "height:4px;margin-top:5px;background:#555;border-radius:4px;overflow:hidden;";
      fill.style.cssText = "display:block;height:100%;background:#ccff00;";
      for (const button of [pause, cancel])
        button.style.cssText =
          "display:inline-flex;align-items:center;gap:4px;padding:4px 8px;border:1px solid #666;border-radius:6px;background:#303134;color:inherit;cursor:pointer;font:inherit;";
    }
    pause.dataset.action = "pause";
    cancel.dataset.action = "stop";
    pause.addEventListener("click", () => onPause?.());
    cancel.addEventListener("click", () => onCancel?.());
    actions.append(pause, cancel);
    panel.append(icon, content, actions);
    document.body.appendChild(panel);
    const ui = {
      panel,
      label,
      progress,
      fill,
      pause,
      pauseIcon,
      pauseLabel,
      cancel,
      fallbackIconAnimation,
      remove: () => {
        fallbackIconAnimation?.cancel();
        panel.remove();
      },
    };
    ui.update = ({
      completed,
      total,
      paused = false,
      cancelled = false,
      pauseDisabled = false,
    }) => {
      if (paused) ui.fallbackIconAnimation?.pause();
      else ui.fallbackIconAnimation?.play();
      const percent =
        total > 0
          ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
          : 0;
      ui.panel.dataset.state = cancelled
        ? "cancelling"
        : paused
          ? "paused"
          : "uploading";
      ui.label.textContent =
        (cancelled
          ? t("uploadControls.cancelling", "Cancelling\u2026")
          : paused
            ? t("common.pause", "Pause")
            : t("uploadControls.title", "Upload")) + ` ${completed}/${total}`;
      ui.fill.style.width = `${percent}%`;
      ui.progress.setAttribute("aria-valuenow", String(completed));
      ui.progress.setAttribute("aria-valuemax", String(Math.max(total, 1)));
      ui.pauseIcon.innerHTML = paused
        ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><path d="M3 1.5v9l7-4.5-7-4.5Z"/></svg>'
        : '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="1.5" width="2.5" height="9" rx="0.5"/><rect x="7.5" y="1.5" width="2.5" height="9" rx="0.5"/></svg>';
      ui.pauseLabel.textContent = t(
        paused ? "common.resume" : "common.pause",
        paused ? "Resume" : "Pause",
      );
      ui.cancel.textContent = t("common.cancel", "Cancel");
      ui.pause.disabled = cancelled || pauseDisabled;
      ui.cancel.disabled = cancelled;
      ui.panel.title = t(
        "uploadControls.boundaryHint",
        "Pause stops before the next file. Cancel stops further uploads; an in-flight Web upload must finish verification first.",
      );
    };
    return ui;
  }
  static _renderUploadControls() {
    if (typeof document === "undefined" || !document.body) return;
    if (!this._uploadControls.size) {
      this._uploadControlPanel?.remove();
      this._uploadControlPanel = null;
      return;
    }
    if (!this._uploadControlPanel) {
      this._uploadControlPanel = this.createUploadControlPanel({
        onPause: () => {
          const paused = ![...this._uploadControls].every(
            (control) => control.paused,
          );
          for (const control of this._uploadControls) control.paused = paused;
          this._renderUploadControls();
        },
        onCancel: () => {
          for (const control of this._uploadControls) control.cancel();
        },
      });
    }
    const controls = [...this._uploadControls];
    this._uploadControlPanel.update({
      paused: controls.every((control) => control.paused),
      cancelled: controls.every((control) => control.abortFn()),
      completed: controls.reduce(
        (sum, control) => sum + control.completed,
        this._uploadControlSettled?.completed || 0,
      ),
      total: controls.reduce(
        (sum, control) => sum + control.total,
        this._uploadControlSettled?.total || 0,
      ),
    });
  }
  static beginExecutionTarget(executionId) {
    this._currentExecutionId = executionId ? String(executionId) : null;
  }
  static endExecutionTarget(executionId) {
    if (!executionId || this._currentExecutionId === String(executionId))
      this._currentExecutionId = null;
    if (executionId) this.releaseExecutionTarget(executionId);
  }
  static _startProviderTabHeartbeat(provider, tabId) {
    if (!provider || !tabId) return () => {};
    const action = `${provider}:ensureActive`;
    let pinnedPage = null;
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        pinnedPage = this._describeFlowUrl(tab?.url);
      })
      .catch(() => {});
    const activate = async () => {
      try {
        if (provider === "flow" && pinnedPage) {
          const tab = await chrome.tabs.get(tabId);
          const live = this._describeFlowUrl(tab?.url);
          if (
            !live ||
            live.driverKey !== pinnedPage.driverKey ||
            live.projectId !== pinnedPage.projectId ||
            (live.routePrefix || "") !== (pinnedPage.routePrefix || "")
          )
            return;
        }
        chrome.runtime.sendMessage(
          { action, tabId, focusWindow: false },
          () => {
            void chrome.runtime.lastError;
          },
        );
      } catch (_) {}
    };
    const timer = setInterval(activate, 8e3);
    return () => clearInterval(timer);
  }
  static async _getInputTimeout() {
    if (this._cachedInputTimeout !== null) return this._cachedInputTimeout;
    try {
      const result = await chrome.storage.local.get(["af_settings"]);
      this._cachedInputTimeout = result?.af_settings?.inputTimeout || 1200;
    } catch (e) {
      this._cachedInputTimeout = 1200;
    }
    return this._cachedInputTimeout;
  }
  static async _getTargetTabId() {
    if (window._targetFlowTabId) {
      try {
        const tab = await chrome.tabs.get(window._targetFlowTabId);
        if (this._isFlowUrl(tab?.url)) {
          return window._targetFlowTabId;
        }
        window._targetFlowTabId = null;
      } catch (e) {
        window._targetFlowTabId = null;
      }
    }
    try {
      const result = await chrome.storage?.session?.get("targetFlowTabId");
      if (result?.targetFlowTabId) {
        const tab = await chrome.tabs
          .get(result.targetFlowTabId)
          .catch(() => null);
        if (this._isFlowUrl(tab?.url)) {
          return result.targetFlowTabId;
        }
        await chrome.storage.session.remove([
          "targetFlowTabId",
          "targetFlowContext",
        ]);
        console.info("[FlowRouting] Removed retired/missing idle target");
      }
    } catch (e) {}
    return null;
  }
  static _describeFlowUrl(url) {
    return globalThis.FlowDriverRegistry?.describeUrl(url) || null;
  }
  static async _getStoredTargetContext() {
    try {
      const result = await chrome.storage?.session?.get("targetFlowContext");
      return result?.targetFlowContext || null;
    } catch (_) {
      return null;
    }
  }
  static async _storeTargetContext(tab) {
    const page = this._describeFlowUrl(tab?.url);
    if (!tab?.id || !page) return null;
    const context = { tabId: tab.id, ...page };
    try {
      await chrome.storage?.session?.set({ targetFlowContext: context });
    } catch (_) {}
    return context;
  }
  static async _waitForFlowTabSettlement(tabId, timeoutMs = 1e4) {
    const started = Date.now();
    let stableUrl = null;
    let stableReads = 0;
    let lastTab = null;
    while (Date.now() - started < timeoutMs) {
      lastTab = await chrome.tabs.get(tabId).catch(() => null);
      if (!lastTab || !this._isFlowUrl(lastTab.url)) return null;
      if (lastTab.url === stableUrl) stableReads++;
      else stableReads = 0;
      stableUrl = lastTab.url;
      if (
        (lastTab.status === "complete" && stableReads >= 1) ||
        stableReads >= 2
      )
        return lastTab;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (lastTab && this._isFlowUrl(lastTab.url)) {
      console.warn(
        "[MessageBridge] Flow tab URL stable but Chrome status is still loading; probing content script",
      );
      return lastTab;
    }
    return null;
  }
  static _isFlowUrl(url) {
    return !!this._describeFlowUrl(url);
  }
  static _selectFlowCandidate(tabs, preferredTabId = null) {
    const supported = (tabs || []).filter((tab) =>
      this._describeFlowUrl(tab?.url),
    );
    if (preferredTabId) {
      const preferred = supported.find((tab) => tab.id === preferredTabId);
      return preferred || null;
    }
    return (
      supported.find(
        (tab) =>
          tab.active && this._describeFlowUrl(tab.url)?.driverKey === "flow_v2",
      ) ||
      supported.find(
        (tab) => this._describeFlowUrl(tab.url)?.driverKey === "flow_v2",
      ) ||
      supported.find((tab) => tab.active) ||
      supported[0] ||
      null
    );
  }
  static async getTargetContext(expected = null) {
    const tabId = Number.isInteger(expected?.tabId)
      ? expected.tabId
      : await this._getTargetTabId();
    if (!tabId) return null;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const page = this._describeFlowUrl(tab?.url);
    return tab && page ? { tabId: tab.id, ...page } : null;
  }
  static async getProjectTargetContext(
    projectId,
    preferred = null,
    { remember = true } = {},
  ) {
    if (typeof projectId !== "string" || !projectId) return null;
    const current = await this.getTargetContext(preferred);
    if (current?.projectId === projectId) {
      if (remember) window._targetFlowTabId = current.tabId;
      return current;
    }
    const tabs = await chrome.tabs.query({});
    const matches = tabs.filter(
      (tab) => this._describeFlowUrl(tab.url)?.projectId === projectId,
    );
    const selected = matches.find((tab) => tab.active) || matches[0];
    if (!selected) return null;
    const live = await this.getTargetContext({ tabId: selected.id });
    if (live?.projectId !== projectId) return null;
    if (remember) window._targetFlowTabId = live.tabId;
    return live;
  }
  static async resolveUploadTarget(options = {}) {
    const expected = options.expectedFlowTarget;
    const projectId = options.expectedProjectId || expected?.projectId;
    const target = expected
      ? await this.getTargetContext(expected)
      : projectId
        ? await this.getProjectTargetContext(projectId, null, {
            remember: false,
          })
        : await this.getTargetContext();
    if (
      !target ||
      (projectId && target.projectId !== projectId) ||
      (expected &&
        ["tabId", "projectId", "driverKey", "origin"].some(
          (key) => expected[key] !== target[key],
        ))
    )
      throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    return target;
  }
  static async getFlowProjectTabs() {
    const targetContext = await this.getTargetContext().catch(() => null);
    const response = await chrome.runtime
      .sendMessage({
        action: "queryProviderTabs",
        provider: "flow",
        targetContext,
      })
      .catch(() => null);
    return {
      targetContext,
      projectTabs: Array.isArray(response?.projectTabs)
        ? response.projectTabs
        : [],
    };
  }
  static async closeFlowProjectTab(tabId, targetContext = null) {
    return chrome.runtime.sendMessage({
      action: "closeFlowProjectTab",
      tabId,
      targetContext,
    });
  }
  static async renderFlowProjectTabsAdvisory(container) {
    if (!container) return;
    const request = {
      signature: this._flowTabsAdvisoryState.get(container)?.signature || null,
    };
    this._flowTabsAdvisoryState.set(container, request);
    const { targetContext, projectTabs } = await this.getFlowProjectTabs();
    if (this._flowTabsAdvisoryState.get(container) !== request) return;
    const diagnostic = {
      stage: "render",
      targetTabId: targetContext?.tabId || null,
      projectTabIds: projectTabs.map((tab) => tab.id),
      warning: projectTabs.length > 1,
    };
    const signature = JSON.stringify(diagnostic);
    if (request.signature !== signature) {
      request.signature = signature;
      console.info("[FlowTabsAdvisory]", signature);
    }
    container.replaceChildren();
    container.classList.toggle("hidden", projectTabs.length <= 1);
    if (projectTabs.length <= 1) return;
    const heading = document.createElement("div");
    heading.className = "confirm-flow-tabs-heading";
    heading.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>';
    const title = document.createElement("span");
    title.textContent = window.I18n?.t?.("flowMultiTab.title") || "";
    heading.appendChild(title);
    const list = document.createElement("div");
    list.className = "confirm-flow-tabs-list";
    const canCloseNonTarget =
      !!targetContext &&
      projectTabs.some((tab) => tab.id === targetContext.tabId);
    for (const tab of projectTabs) {
      const row = document.createElement("div");
      row.className = "confirm-flow-tab-row";
      const label = document.createElement("span");
      label.className = "confirm-flow-tab-id";
      label.textContent = String(tab.projectId || tab.id);
      label.title = tab.url || label.textContent;
      row.appendChild(label);
      if (tab.id === targetContext?.tabId) {
        const current = document.createElement("span");
        current.className = "confirm-flow-tab-current";
        current.textContent = window.I18n?.t?.("flowMultiTab.current") || "";
        row.appendChild(current);
      } else if (canCloseNonTarget) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "confirm-flow-tab-close";
        close.innerHTML =
          '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>';
        const closeText = document.createElement("span");
        closeText.textContent = window.I18n?.t?.("flowMultiTab.close") || "";
        close.appendChild(closeText);
        close.addEventListener("click", async () => {
          close.disabled = true;
          const result = await this.closeFlowProjectTab(
            tab.id,
            targetContext,
          ).catch(() => null);
          if (result?.ok === true)
            await this.renderFlowProjectTabsAdvisory(container);
          else close.disabled = false;
        });
        row.appendChild(close);
      }
      list.appendChild(row);
    }
    container.append(heading, list);
  }
  static async getLiveTargetContext() {
    const context = await this.getTargetContext();
    if (context?.driverKey !== "flow_v2") return context;
    try {
      const live = await this.sendToContentScript("getFlowDriverContext");
      if (
        live?.success &&
        live.driverKey === context.driverKey &&
        live.projectId === context.projectId &&
        live.origin === context.origin &&
        (live.routePrefix || "") === (context.routePrefix || "") &&
        typeof live.compactLayout === "boolean"
      ) {
        return { ...context, compactLayout: live.compactLayout };
      }
    } catch (_) {}
    return { ...context, compactLayout: null };
  }
  static async _getExecutionTarget(executionId) {
    if (!executionId) return null;
    const key = String(executionId);
    const memory = this._executionTargets.get(key);
    if (memory) return memory;
    try {
      const stored = await chrome.storage?.session?.get(
        this._executionTargetsStorageKey,
      );
      const target = stored?.[this._executionTargetsStorageKey]?.[key] || null;
      if (
        target?.tabId &&
        target?.driverKey &&
        target?.origin &&
        Date.now() - Number(target.createdAt || 0) <= this._executionTargetTtlMs
      ) {
        this._executionTargets.set(key, target);
        return target;
      }
    } catch (_) {}
    return null;
  }
  static async _storeExecutionTarget(executionId, target) {
    if (!executionId || !target?.tabId) return;
    const key = String(executionId);
    const targetWithTimestamp = { ...target, createdAt: Date.now() };
    this._executionTargets.set(key, targetWithTimestamp);
    const previous = this._executionTargetsStorageQueue;
    let release;
    this._executionTargetsStorageQueue = new Promise((resolve) => {
      release = resolve;
    });
    try {
      await previous.catch(() => {});
      const stored = await chrome.storage?.session?.get(
        this._executionTargetsStorageKey,
      );
      const now = Date.now();
      const targets = Object.fromEntries(
        Object.entries(stored?.[this._executionTargetsStorageKey] || {}).filter(
          ([, value]) =>
            now - Number(value?.createdAt || 0) <= this._executionTargetTtlMs,
        ),
      );
      targets[key] = { ...targetWithTimestamp, createdAt: now };
      await chrome.storage?.session?.set({
        [this._executionTargetsStorageKey]: targets,
      });
    } catch (_) {
    } finally {
      release();
    }
  }
  static releaseExecutionTarget(executionId) {
    if (!executionId) return;
    const key = String(executionId);
    this._executionTargets.delete(key);
    (async () => {
      const previous = this._executionTargetsStorageQueue;
      let release;
      this._executionTargetsStorageQueue = new Promise((resolve) => {
        release = resolve;
      });
      try {
        await previous.catch(() => {});
        const stored = await chrome.storage?.session?.get(
          this._executionTargetsStorageKey,
        );
        const targets = {
          ...(stored?.[this._executionTargetsStorageKey] || {}),
        };
        delete targets[key];
        await chrome.storage?.session?.set({
          [this._executionTargetsStorageKey]: targets,
        });
      } catch (_) {
      } finally {
        release();
      }
    })();
  }
  static async setTargetTabId(tabId, source = "unspecified") {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!this._isFlowUrl(tab?.url)) return;
      const context = this._describeFlowUrl(tab?.url);
      const session = chrome.storage?.session;
      const previous = session?.get
        ? await session.get("targetFlowContext").catch(() => null)
        : null;
      const previousContext = previous?.targetFlowContext || null;
      window._targetFlowTabId = tabId;
      await session?.set?.({
        targetFlowTabId: tabId,
        ...(context ? { targetFlowContext: { tabId, ...context } } : {}),
      });
      const persisted = session?.get
        ? await session.get("targetFlowContext").catch(() => null)
        : null;
      const pinned = persisted?.targetFlowContext || null;
      const changed =
        previousContext?.tabId !== tabId ||
        previousContext?.projectId !== context?.projectId ||
        previousContext?.routePrefix !== context?.routePrefix;
      if (changed) {
        console.info(
          "[FlowTargetPin] updated",
          JSON.stringify({
            source,
            previous: previousContext
              ? {
                  tabId: previousContext.tabId,
                  projectId: previousContext.projectId || null,
                }
              : null,
            target: context
              ? {
                  tabId,
                  projectId: context.projectId || null,
                  routePrefix: context.routePrefix || "",
                }
              : { tabId, projectId: null },
            persisted:
              pinned?.tabId === tabId &&
              pinned?.projectId === context?.projectId,
          }),
        );
      }
    } catch (e) {
      console.warn("[FlowTargetPin] update failed", {
        source,
        tabId,
        error: e?.message || String(e),
      });
    }
  }
  static async sendToContentScript(action, data = {}, control = {}) {
    if (
      (action === "ensureFlowTilesLoaded" ||
        (action === "resolveVideoPlaybackUrl" &&
          (control.signal || data.allowVirtualScan !== false))) &&
      !data.flowScanRequestId
    ) {
      const budget = Number(
        window.SystemConfig?.safeGetTimeout?.("flow_ref_scan_timeout_ms"),
      );
      if (!Number.isFinite(budget) || budget <= 0)
        throw Object.assign(new Error("FLOW_SCAN_TIMEOUT_CONFIG_UNAVAILABLE"), {
          code: "FLOW_SCAN_TIMEOUT_CONFIG_UNAVAILABLE",
          noRetry: true,
        });
      data = {
        ...data,
        flowScanRequestId: crypto.randomUUID(),
        flowScanDeadline: Date.now() + budget,
      };
    }
    const traceObserverWait = action === "flowCorrelationWait";
    const perfStartedAt =
      this._flowPerfActions.has(action) ||
      traceObserverWait ||
      this._flowReadTraceFailures.has(action)
        ? Date.now()
        : 0;
    const bounded =
      this._boundedFlowReads.has(action) ||
      this._boundedFlowControls.has(action);
    const scanDeadline = data.flowScanRequestId
      ? data.flowScanDeadline
      : action === "getThumbnailsByIds"
        ? data.metadataDeadline
        : null;
    const ackTimeout =
      bounded || scanDeadline
        ? Number(window.SystemConfig?.safeGetTimeout?.("api_timeout_ms"))
        : void 0;
    const scanAckBudget = scanDeadline
      ? Math.max(1, scanDeadline - Date.now()) + ackTimeout
      : ackTimeout;
    const timeoutMs =
      control.timeoutMs ??
      (action === "waitForNewTiles"
        ? Number(data.timeout) + ackTimeout
        : scanAckBudget);
    if (
      (bounded || scanDeadline) &&
      (!Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        (control.timeoutMs == null &&
          (!Number.isFinite(ackTimeout) || ackTimeout <= 0)))
    ) {
      throw Object.assign(
        new Error("FLOW_COMMAND_TIMEOUT_CONFIG_UNAVAILABLE"),
        { code: "FLOW_COMMAND_TIMEOUT_CONFIG_UNAVAILABLE", noRetry: true },
      );
    }
    const signal =
      control.signal ||
      (this._boundedFlowReads.has(action) &&
      ![
        "scanFlowImages",
        "extractTileIdentifiers",
        "resolveVideoPlaybackUrl",
      ].includes(action)
        ? window.workflowExecutor?._flowReadAbortController?.signal
        : null);
    const assertActive = () => {
      if (signal?.aborted)
        throw Object.assign(new Error("Aborted"), {
          name: "AbortError",
          code: "ABORTED",
          noRetry: true,
        });
    };
    assertActive();
    try {
      const tabs = await chrome.tabs.query({
        url: window.ProviderConfigManager?.getTabQueryPatterns("flow") || [],
      });
      const perfAfterTabQuery = perfStartedAt ? Date.now() : 0;
      if (tabs.length === 0) {
        this._showNoFlowTabWarning();
        throw new Error(
          window.I18n?.t("msg.noFlowTab") || "Google Flow tab not found",
        );
      }
      const targetTabId = Number.isInteger(data?.expectedFlowTarget?.tabId)
        ? data.expectedFlowTarget.tabId
        : await this._getTargetTabId();
      let targetTab = null;
      if (targetTabId) {
        targetTab = tabs.find((t) => t.id === targetTabId);
      }
      const executionId =
        data?._flowExecutionId ||
        data?.executionId ||
        data?.operationId ||
        this._currentExecutionId ||
        null;
      const pinnedExecution = await this._getExecutionTarget(executionId);
      if (pinnedExecution)
        targetTab =
          tabs.find((tab) => tab.id === pinnedExecution.tabId) || null;
      if ((pinnedExecution || data?.expectedFlowTarget) && !targetTab)
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
      const perfAfterTargetLookup = perfStartedAt ? Date.now() : 0;
      if (!targetTab) {
        targetTab = this._selectFlowCandidate(tabs);
        if (targetTab && !window._targetFlowTabId) {
          this.setTargetTabId(targetTab.id);
        }
      }
      const currentContext = this._describeFlowUrl(targetTab?.url);
      if (!currentContext)
        throw new Error("Target tab is not a supported Flow page");
      const expectedTarget = data?.expectedFlowTarget;
      if (
        expectedTarget &&
        (targetTab.id !== expectedTarget.tabId ||
          currentContext.driverKey !== expectedTarget.driverKey ||
          currentContext.origin !== expectedTarget.origin ||
          currentContext.projectId !== expectedTarget.projectId)
      ) {
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
      }
      if (window._afDebug) {
        console.debug("[MessageBridge:FlowTarget]", {
          provider: "flow",
          driver: currentContext.driverKey,
          tabId: targetTab.id,
          projectId: currentContext.projectId || null,
        });
      }
      if (
        pinnedExecution &&
        (pinnedExecution.driverKey !== currentContext.driverKey ||
          pinnedExecution.origin !== currentContext.origin ||
          pinnedExecution.projectId !== currentContext.projectId ||
          (pinnedExecution.routePrefix || "") !==
            (currentContext.routePrefix || ""))
      ) {
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
      }
      if (executionId && !pinnedExecution) {
        await this._storeExecutionTarget(executionId, {
          tabId: targetTab.id,
          ...currentContext,
        });
      }
      const storedContext = await this._getStoredTargetContext();
      if (
        !storedContext ||
        storedContext.tabId !== targetTab.id ||
        storedContext.driverKey !== currentContext.driverKey ||
        storedContext.origin !== currentContext.origin ||
        storedContext.projectId !== currentContext.projectId ||
        (storedContext.routePrefix || "") !== (currentContext.routePrefix || "")
      ) {
        await this._storeTargetContext(targetTab);
      }
      if (
        action === "getThumbnailsByIds" &&
        data.activateForMetadata === true
      ) {
        assertActive();
        if (Date.now() >= data.metadataDeadline)
          throw new Error("METADATA_SCAN_TIMEOUT");
        await this._activateMetadataScanTarget(targetTab, currentContext);
      }
      const messagePayload = {
        action,
        ...data,
        _flowTarget: { tabId: targetTab.id, ...currentContext },
      };
      if (action === "pq:addRefImages" || action === "downloadTileMedia") {
        try {
          const owner = await chrome.tabs.getCurrent?.();
          if (
            owner &&
            ["workflow-editor.html", "motion-editor.html"].some((page) => {
              const base = chrome.runtime.getURL(page);
              return (
                owner.url === base ||
                owner.url?.startsWith(base + "?") ||
                owner.url?.startsWith(base + "#")
              );
            })
          )
            messagePayload.flowDomFocusOwnerTabId = owner.id;
        } catch (_) {}
      }
      if (action === "uploadFilesToFlow") {
        console.info(
          "[FlowUploadRoute]",
          JSON.stringify({
            requestId: data.uploadRequestId || null,
            tabId: targetTab.id,
            expectedTabId: expectedTarget?.tabId || null,
            trackedTabId: targetTabId || null,
            pinnedTabId: pinnedExecution?.tabId || null,
            projectId: currentContext.projectId || null,
            candidateTabIds: tabs.map((tab) => tab.id),
          }),
        );
      }
      const perfTrace = perfStartedAt
        ? {
            id: `${perfStartedAt.toString(36)}-${++this._flowPerfSequence}`,
            sentAt: Date.now(),
          }
        : null;
      if (perfTrace) {
        messagePayload._flowPerfTrace = perfTrace;
        console.info(
          "[FlowCommandTiming] dispatch",
          JSON.stringify({
            action,
            id: perfTrace.id,
            routeMs: perfTrace.sentAt - perfStartedAt,
            tabQueryMs: perfAfterTabQuery - perfStartedAt,
            targetLookupMs: perfAfterTargetLookup - perfAfterTabQuery,
            contextMs: perfTrace.sentAt - perfAfterTargetLookup,
            ...this._flowPerfMemorySnapshot(),
          }),
        );
      }
      try {
        if (data.metadataRequestId) {
          if (Date.now() >= data.metadataDeadline)
            throw new Error("METADATA_SCAN_TIMEOUT");
          console.log(
            "[FlowMetadataLookup] dispatch",
            JSON.stringify({
              requestId: data.metadataRequestId,
              tabId: targetTab.id,
              projectId: currentContext.projectId,
            }),
          );
        }
        const pendingTimer = perfTrace
          ? setTimeout(
              () =>
                console.info(
                  "[FlowCommandTiming] still waiting",
                  JSON.stringify({
                    action,
                    id: perfTrace.id,
                    elapsedMs: Date.now() - perfStartedAt,
                  }),
                ),
              5e3,
            )
          : null;
        let response;
        let sendError = null;
        try {
          response = await this._sendFlowMessage(targetTab.id, messagePayload, {
            timeoutMs,
            signal,
            onDispatch: control.onDispatch,
            onNotDispatched: control.onNotDispatched,
          });
          this._flowReadTraceFailures.delete(action);
        } catch (error) {
          if (
            this._boundedFlowReads.has(action) &&
            error?.code === "FLOW_COMMAND_ACK_TIMEOUT"
          ) {
            this._flowReadTraceFailures.add(action);
          }
          sendError = error;
          throw error;
        } finally {
          if (pendingTimer !== null) clearTimeout(pendingTimer);
          if (perfTrace)
            console.info(
              "[FlowCommandTiming] send settled",
              JSON.stringify({
                action,
                id: perfTrace.id,
                routeMs: perfTrace.sentAt - perfStartedAt,
                transitAndHandlerMs: Date.now() - perfTrace.sentAt,
                totalMs: Date.now() - perfStartedAt,
                success: sendError === null,
                error: sendError?.message || null,
                ...this._flowPerfMemorySnapshot(),
              }),
            );
        }
        if (action === "uploadFilesToFlow")
          response = this._normalizeFlowUploadResult(response);
        if (
          response?.error &&
          (response.success === false ||
            Object.keys(response).every(
              (key) => key === "error" || key === "code",
            ))
        ) {
          if (action === "uploadFilesToFlow") {
            console.warn(
              "[FlowUploadFailure]",
              JSON.stringify({
                error: response.error,
                stage: response.stage || null,
                diagnostics: response.diagnostics || null,
              }),
            );
          }
          const routeKey = {
            FLOW_LEGACY_GENERATION_DISABLED: "flowRouting.legacyDisabled",
            FLOW_PROJECT_REQUIRED: "flowRouting.projectRequired",
          }[response.error];
          const error = new Error(
            routeKey
              ? window.I18n?.t(routeKey) || response.error
              : response.error,
          );
          error.code = response.code || response.error;
          if (action === "downloadTileMedia") {
            if (response.downloadDiagnostic) {
              const source = response.downloadDiagnostic,
                diagnostic = {};
              if (/^[a-z_]{1,48}$/.test(source.stage || ""))
                diagnostic.stage = source.stage;
              for (const key of [
                "elapsedMs",
                "optionCount",
                "viewportWakeCount",
                "stalledViewportCount",
                "scanStepCount",
              ])
                if (Number.isFinite(source[key]) && source[key] >= 0)
                  diagnostic[key] = Math.min(36e5, Math.floor(source[key]));
              for (const key of [
                "hasResolutionSubmenu",
                "hasTarget",
                "targetDisabled",
                "targetConnected",
              ])
                if (typeof source[key] === "boolean")
                  diagnostic[key] = source[key];
              if (source.mediaType === "image" || source.mediaType === "video")
                diagnostic.mediaType = source.mediaType;
              error.downloadDiagnostic = diagnostic;
              console.warn(
                "[FlowDownloadFailure]",
                JSON.stringify({
                  requestId: data.requestId || null,
                  error: error.code,
                  diagnostic,
                }),
              );
            }
            for (const field of [
              "stage",
              "noRetry",
              "noReplay",
              "ambiguous",
              "dispatchStarted",
              "captureDiagnostic",
            ])
              if (Object.prototype.hasOwnProperty.call(response, field))
                error[field] = response[field];
          }
          if (action === "uploadFilesToFlow") {
            error.stage = response.stage || null;
            error.diagnostics = response.diagnostics || null;
          }
          error.notDispatched = response.notDispatched === true;
          if (
            action === "autoReloadFlow" &&
            response.identityRefreshDiagnostic
          ) {
            const diagnostic = response.identityRefreshDiagnostic;
            if (
              [
                "initial",
                "before_boundary",
                "background_boundary",
                "after_boundary",
                "boundary_exception",
              ].includes(diagnostic.stage) &&
              typeof diagnostic.reason === "string" &&
              /^[a-zA-Z0-9_]{1,80}$/.test(diagnostic.reason)
            ) {
              error.identityRefreshDiagnostic = {
                stage: diagnostic.stage,
                reason: diagnostic.reason,
              };
              console.warn(
                "[FlowIdentityRefreshBoundary]",
                JSON.stringify(error.identityRefreshDiagnostic),
              );
            }
          }
          if (action === "clickSubmit" && response.activationDiagnostic)
            error.activationDiagnostic = response.activationDiagnostic;
          if (response.flowGateDiagnostic)
            error.flowGateDiagnostic = response.flowGateDiagnostic;
          error._flowTarget = { tabId: targetTab.id, ...currentContext };
          throw error;
        }
        return response;
      } catch (sendErr) {
        const _emsg = String(sendErr.message || "").toLowerCase();
        const isExpectedDisconnect =
          _emsg.includes("could not establish connection") ||
          _emsg.includes("receiving end does not exist") ||
          _emsg.includes("message channel closed") ||
          _emsg.includes("message port closed") ||
          _emsg.includes("message channel is closed") ||
          _emsg.includes("back/forward cache") ||
          _emsg.includes("extension port");
        const isFireAndForgetAction =
          action === "pq:trackerUpdate" ||
          action === "correctStaleFileIds" ||
          action === "applyFlowPageSettings";
        const recoverEmptyAck =
          sendErr.code === "FLOW_CONTENT_NO_RESPONSE" &&
          [
            "flowUuidGatewayRead",
            "lookupFlowMediaCatalog",
            "checkTilesExist",
            "checkFilesExist",
            "resetStop",
          ].includes(action);
        if (isExpectedDisconnect || recoverEmptyAck) {
          if (action === "uploadFilesToFlow") {
            try {
              const snapshot = (
                await chrome.storage.local.get("toby_flow_upload_diagnostic")
              )?.toby_flow_upload_diagnostic;
              if (snapshot?.requestId === data.uploadRequestId) {
                console.warn(
                  "[FlowUploadLastCheckpoint]",
                  JSON.stringify({
                    ...snapshot,
                    ageMs: Math.max(
                      0,
                      Date.now() - Number(snapshot.at || Date.now()),
                    ),
                  }),
                );
              }
            } catch (_) {}
          }
          const missingReceiver =
            _emsg.includes("could not establish connection") ||
            _emsg.includes("receiving end does not exist");
          if (
            ["clickSubmit", "uploadFilesToFlow", "autoReloadFlow"].includes(
              action,
            ) &&
            !missingReceiver
          ) {
            sendErr.noReplay = true;
            sendErr.noRetry = true;
            const liveTab = await chrome.tabs
              .get(targetTab.id)
              .catch(() => null);
            console.warn(
              "[MessageBridge] mutation ACK lost; automatic replay suppressed:",
              JSON.stringify({
                action,
                tabId: targetTab.id,
                error: sendErr.message,
                url: liveTab?.url?.split(/[?#]/)[0] || null,
                pendingUrl: liveTab?.pendingUrl?.split(/[?#]/)[0] || null,
                status: liveTab?.status || null,
                discarded: liveTab?.discarded === true,
              }),
            );
            throw sendErr;
          }
          if (!isFireAndForgetAction) {
            console.info(
              "[MessageBridge] content script disconnected; starting recovery:",
              action,
            );
            console.log(
              "[MessageBridge] Content script ch\u01B0a s\u1EB5n s\xE0ng, \u0111ang inject l\u1EA1i...",
            );
            await this._injectContentScript(targetTab.id, action);
            const retryDelay = await this._getInputTimeout();
            await new Promise((r) => setTimeout(r, retryDelay));
            let retryResponse = null;
            const retryStartedAt = perfTrace ? Date.now() : 0;
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                if (
                  data.metadataRequestId &&
                  Date.now() >= data.metadataDeadline
                )
                  throw new Error("METADATA_SCAN_TIMEOUT");
                retryResponse = await this._sendFlowMessage(
                  targetTab.id,
                  messagePayload,
                  {
                    timeoutMs,
                    signal,
                    onDispatch: control.onDispatch,
                    onNotDispatched: control.onNotDispatched,
                  },
                );
                break;
              } catch (retryErr) {
                if (
                  attempt < 2 &&
                  retryErr.message?.includes("Could not establish connection")
                ) {
                  console.log(
                    `[MessageBridge] Retry ${attempt + 1} failed, waiting ${retryDelay}ms...`,
                  );
                  await new Promise((r) => setTimeout(r, retryDelay));
                } else {
                  throw retryErr;
                }
              }
            }
            if (perfTrace)
              console.info(
                "[FlowCommandTiming] reinject retry settled",
                JSON.stringify({
                  action,
                  id: perfTrace.id,
                  retryMs: Date.now() - retryStartedAt,
                  totalMs: Date.now() - perfStartedAt,
                }),
              );
            if (action === "uploadFilesToFlow")
              retryResponse = this._normalizeFlowUploadResult(retryResponse);
            if (
              retryResponse?.error &&
              (retryResponse.success === false ||
                Object.keys(retryResponse).every(
                  (key) => key === "error" || key === "code",
                ))
            ) {
              if (action === "uploadFilesToFlow") {
                console.warn(
                  "[FlowUploadFailure]",
                  JSON.stringify({
                    error: retryResponse.error,
                    stage: retryResponse.stage || null,
                    diagnostics: retryResponse.diagnostics || null,
                  }),
                );
              }
              throw Object.assign(new Error(retryResponse.error), {
                code: retryResponse.code || retryResponse.error,
                notDispatched: retryResponse.notDispatched === true,
                ...(action === "uploadFilesToFlow" && {
                  stage: retryResponse.stage || null,
                  diagnostics: retryResponse.diagnostics || null,
                }),
                ...(action === "downloadTileMedia" &&
                  Object.fromEntries(
                    [
                      "stage",
                      "noRetry",
                      "noReplay",
                      "ambiguous",
                      "dispatchStarted",
                      "captureDiagnostic",
                    ]
                      .filter((field) =>
                        Object.prototype.hasOwnProperty.call(
                          retryResponse,
                          field,
                        ),
                      )
                      .map((field) => [field, retryResponse[field]]),
                  )),
                flowGateDiagnostic: retryResponse.flowGateDiagnostic || null,
                _flowTarget: { tabId: targetTab.id, ...currentContext },
              });
            }
            return retryResponse;
          }
          sendErr._isFireAndForget = true;
          throw sendErr;
        }
        if (this._isExpectedFlowControlError(action, sendErr)) {
          console.info(
            "[MessageBridge] command skipped:",
            action,
            sendErr.message,
          );
        } else {
          console.warn(
            "[MessageBridge] sendMessage failed:",
            action,
            sendErr.message,
          );
        }
        throw sendErr;
      }
    } catch (err) {
      const expectedControlFlow = this._isExpectedFlowControlError(action, err);
      if (perfStartedAt) {
        const timing = JSON.stringify({
          action,
          totalMs: Date.now() - perfStartedAt,
          ...(action === "applySettings" && {
            settingsDiagnostic: err.flowGateDiagnostic || null,
          }),
          error: err?.message || String(err),
        });
        if (expectedControlFlow)
          console.info("[FlowCommandTiming] command skipped", timing);
        else console.warn("[FlowCommandTiming] command failed", timing);
      }
      if (!err._isFireAndForget) {
        if (expectedControlFlow)
          console.info(
            "[MessageBridge] command unavailable:",
            action,
            err.message,
          );
        else
          console.error(
            "[MessageBridge] L\u1ED7i g\u1EEDi message:",
            err.message,
          );
      }
      throw err;
    }
  }
  static async _injectContentScript(tabId, action = null) {
    let failedTabStatus = null;
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !this._isFlowUrl(tab.url)) {
        throw new Error(
          `Tab ${tabId} kh\xF4ng ph\u1EA3i Google Flow (url: ${tab?.url || "N/A"})`,
        );
      }
      const inject = async () => {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: [
            "src/core/ConfigSnapshotAccess.js",
            "src/core/FlowObserverConfigRelay.js",
            "src/core/flow/FlowPageDriver.js",
            "src/core/flow/FlowDriverRegistry.js",
            "src/core/flow/drivers/v2/FlowV2Editor.js",
            "src/core/flow/drivers/v2/FlowV2GenerationSettings.js",
            "src/core/flow/drivers/v2/FlowV2PageSettings.js",
            "src/core/flow/drivers/v2/FlowV2TileResolver.js",
            "src/core/flow/drivers/v2/FlowV2ComponentPicker.js",
            "src/core/flow/drivers/v2/FlowV2MediaMenu.js",
            "src/core/flow/drivers/FlowV2Driver.js",
            "src/core/FlowUuidGateway.js",
            "content.js",
            "src/core/TrackerRegenProjection.js",
            "floating-tracker-flow.js",
            "media-intercept-bridge.js",
          ],
        });
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["slate-bridge.js"],
            world: "MAIN",
          });
        } catch (slateErr) {
          console.warn(
            "[MessageBridge] Slate bridge inject failed:",
            slateErr.message,
          );
        }
      };
      try {
        await inject();
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.log(
          "[MessageBridge] Content script + slate bridge injected v\xE0o tab",
          tabId,
        );
        return;
      } catch (injectErr) {
        let liveTab = tab;
        let lastError = injectErr;
        if (tab.status === "unloaded") {
          const retryDelay = await this._getInputTimeout();
          for (let attempt = 0; attempt < 3; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, retryDelay));
            liveTab = await chrome.tabs.get(tabId).catch(() => null);
            if (
              !liveTab ||
              liveTab.url !== tab.url ||
              !this._isFlowUrl(liveTab.url)
            )
              break;
            if (liveTab.status === "unloaded") continue;
            try {
              await inject();
              await new Promise((resolve) => setTimeout(resolve, 500));
              console.info(
                "[MessageBridge] Content script reconnected after tab unloaded:",
                JSON.stringify({
                  tabId,
                  attempts: attempt + 1,
                  status: liveTab.status,
                }),
              );
              return;
            } catch (retryErr) {
              lastError = retryErr;
              if (liveTab.status !== "loading") break;
            }
          }
        }
        failedTabStatus = liveTab?.status || tab.status || null;
        console.warn(
          "[MessageBridge] Direct inject failed:",
          JSON.stringify({
            error: lastError.message,
            tabId,
            action,
            url: liveTab?.url?.split(/[?#]/)[0] || null,
            pendingUrl: liveTab?.pendingUrl?.split(/[?#]/)[0] || null,
            status: failedTabStatus,
            discarded: liveTab?.discarded === true,
          }),
        );
      }
      throw new Error("FLOW_CONTENT_REINJECT_FAILED");
    } catch (err) {
      console.error(
        "[MessageBridge] Kh\xF4ng th\u1EC3 inject content script:",
        err.message,
      );
      if (
        err?.code === "FLOW_CONTENT_REINJECT_FAILED" ||
        err?.message === "FLOW_CONTENT_REINJECT_FAILED"
      ) {
        const i18nKey = "flowErrors.codes.FLOW_CONTENT_REINJECT_FAILED";
        const localized = window.I18n?.t?.(i18nKey);
        const connectionError = new Error(
          localized && localized !== i18nKey
            ? localized
            : "FLOW_CONTENT_REINJECT_FAILED",
        );
        connectionError.code = "FLOW_CONTENT_REINJECT_FAILED";
        connectionError.tabId = tabId;
        connectionError.tabStatus = failedTabStatus;
        connectionError.flowCommandAction = action;
        throw connectionError;
      }
      throw new Error(
        `Kh\xF4ng th\u1EC3 k\u1EBFt n\u1ED1i v\u1EDBi Google Flow: ${err.message}`,
      );
    }
  }
  static _showNoFlowTabWarning() {
    if (this._warningShown) return;
    this._warningShown = true;
    const openFlow = () =>
      chrome.runtime.sendMessage({
        action: "openOrActivateTab",
        urlPattern:
          window.ProviderConfigManager?.getTabQueryPatterns("flow") || [],
        createUrl: window.ProviderConfigManager?.getCreateUrl("flow"),
        activate: true,
      });
    if (typeof window.workflowRunHostNotice === "function") {
      Promise.resolve()
        .then(() =>
          window.workflowRunHostNotice({
            code: "FLOW_PROJECT_REQUIRED",
            title:
              window.I18n?.t("msg.noFlowTabTitle") || "Google Flow Not Found",
            message:
              window.I18n?.t("flowRouting.projectRequired") ||
              window.I18n?.t("msg.openFlowTabDesc"),
            actionLabel:
              window.I18n?.t("msg.openFlowTab") || "Open Google Flow",
            closeLabel: window.I18n?.t("common.close") || "Close",
          }),
        )
        .then((choice) => (choice === "open" ? openFlow() : null))
        .catch((error) =>
          console.warn(
            "[MessageBridge] Flow notice failed:",
            error?.code || "NOTICE_FAILED",
          ),
        )
        .finally(() => {
          this._warningShown = false;
        });
      return;
    }
    if (window.customDialog?.alert) {
      Promise.resolve(
        window.customDialog.alert(
          window.I18n?.t("flowRouting.projectRequired") ||
            window.I18n?.t("msg.openFlowTabDesc"),
          {
            title:
              window.I18n?.t("msg.noFlowTabTitle") || "Google Flow Not Found",
            type: "warning",
          },
        ),
      )
        .then(() => {
          return openFlow();
        })
        .catch((error) =>
          console.warn(
            "[MessageBridge] Flow tab warning failed:",
            error?.message || error,
          ),
        )
        .finally(() => {
          this._warningShown = false;
        });
    } else this._warningShown = false;
  }
  static async runAutoPrompt(payload) {
    const enrichedPayload = { ...payload };
    if (payload?.modelName && payload?.genType === "Video") {
      enrichedPayload.skipFlowDurationControl =
        window.ModelRegistry?.findModel?.("flow", payload.modelName)?.config
          ?.duration_tier === "default";
    }
    if (payload?.modelName && !Array.isArray(payload.modelAliases)) {
      const aliases =
        window.ModelRegistry?.getDomNames?.("flow", payload.modelName) || [];
      if (aliases.length > 0) enrichedPayload.modelAliases = aliases;
    }
    if (
      payload?.modelName &&
      payload?.flowVideoResolution &&
      !payload.flowVideoResolutionDomValue
    ) {
      const cfg = window.ModelRegistry?.getGenerationResolutionConfig?.(
        "flow",
        payload.modelName,
      );
      const option = cfg?.options?.find?.(
        (o) => o.value === payload.flowVideoResolution,
      );
      if (option?.dom_value)
        enrichedPayload.flowVideoResolutionDomValue = option.dom_value;
    }
    if (payload?.genType === "Image" && payload.modelName) {
      enrichedPayload.flowThinkingLevel =
        window.ModelRegistry?.getThinkingLevelValue?.(
          "flow",
          payload.modelName,
          payload.flowThinkingLevel,
        );
      enrichedPayload.flowThinkingLevelDomValue =
        window.ModelRegistry?.getThinkingLevelDomSelection?.(
          "flow",
          payload.modelName,
          enrichedPayload.flowThinkingLevel,
        ) || null;
    }
    const target = await this.getTargetContext();
    if (target?.driverKey === "flow_v2") {
      const preparation = await this.prepareFlowForGen();
      if (preparation?.success === false) {
        throw new Error(preparation.error || "FLOW_PREPARE_FAILED");
      }
    }
    await this._ensureFlowTabActive();
    return this.sendToContentScript("runAutoPrompt", {
      payload: enrichedPayload,
    });
  }
  static async _ensureFlowTabActive(expectedFlowTarget = null) {
    let targetTabId =
      expectedFlowTarget?.tabId || window._targetFlowTabId || null;
    if (expectedFlowTarget) {
      const live = await this.getTargetContext(expectedFlowTarget);
      if (
        !live ||
        ["tabId", "projectId", "driverKey", "origin"].some(
          (key) => live[key] !== expectedFlowTarget[key],
        )
      )
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    }
    if (!targetTabId) {
      try {
        const res = await chrome.storage?.session?.get("targetFlowTabId");
        targetTabId = res?.targetFlowTabId || null;
      } catch (e) {}
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { action: "ensureFlowTabReady", targetTabId },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({ isOpen: false });
            return;
          }
          resolve(response || { isOpen: false });
        },
      );
    });
  }
  static beginFlowMonitorHeartbeat(isActive) {
    this._flowMonitorHeartbeats || (this._flowMonitorHeartbeats = new Map());
    const token = {};
    this._flowMonitorHeartbeats.set(token, isActive);
    const pulse = () => {
      this._flowMonitorHeartbeatTimer = null;
      for (const [key, active] of this._flowMonitorHeartbeats) {
        try {
          if (active() !== true) this._flowMonitorHeartbeats.delete(key);
        } catch (_) {
          this._flowMonitorHeartbeats.delete(key);
        }
      }
      if (!this._flowMonitorHeartbeats.size) return;
      this.heartbeatActivateFlowTab();
      this._flowMonitorHeartbeatTimer = setTimeout(
        pulse,
        this._FLOW_HEARTBEAT_INTERVAL_MS,
      );
    };
    if (this._flowMonitorHeartbeatTimer == null) pulse();
    return () => {
      this._flowMonitorHeartbeats.delete(token);
      if (this._flowMonitorHeartbeats.size) return;
      clearTimeout(this._flowMonitorHeartbeatTimer);
      this._flowMonitorHeartbeatTimer = null;
    };
  }
  static heartbeatActivateFlowTab() {
    const now = Date.now();
    if (
      this._lastHeartbeatActivateAt &&
      now - this._lastHeartbeatActivateAt < this._FLOW_HEARTBEAT_INTERVAL_MS
    )
      return;
    this._lastHeartbeatActivateAt = now;
    try {
      chrome.runtime.sendMessage(
        {
          action: "activateFlowTabForExecution",
          tabId: window._targetFlowTabId || null,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    } catch (_) {}
  }
  static async applySettings(
    genType,
    ratio,
    model,
    isFrames,
    quantity = 1,
    flowVideoDuration = null,
    flowVideoResolution = null,
    modelOnly = false,
    flowThinkingLevel = null,
    options = {},
  ) {
    const target = await this.getTargetContext();
    if (target?.driverKey === "flow_v2" && target.isProjectEditor !== true) {
      const prepared = await this.prepareFlowForGen();
      if (prepared?.success === false)
        throw new Error(prepared.error || "FLOW_PREPARE_FAILED");
    }
    const modelAliases = model
      ? window.ModelRegistry?.getDomNames?.("flow", model) || []
      : [];
    const resolutionCfg = flowVideoResolution
      ? window.ModelRegistry?.getGenerationResolutionConfig?.("flow", model)
      : null;
    const resolutionOption = resolutionCfg?.options?.find?.(
      (o) => o.value === flowVideoResolution,
    );
    flowThinkingLevel =
      genType === "Image"
        ? window.ModelRegistry?.getThinkingLevelValue?.(
            "flow",
            model,
            flowThinkingLevel,
          )
        : null;
    const flowThinkingLevelDomValue =
      genType === "Image"
        ? window.ModelRegistry?.getThinkingLevelDomSelection?.(
            "flow",
            model,
            flowThinkingLevel,
          ) || null
        : null;
    const skipFlowDurationControl =
      options.hasVideoReference === true ||
      window.ModelRegistry?.findModel?.("flow", model)?.config
        ?.duration_tier === "default";
    return this.sendToContentScript("applySettings", {
      genType,
      ratio,
      model,
      modelAliases,
      isFrames,
      quantity,
      flowVideoDuration,
      skipFlowDurationControl,
      modelOnly: modelOnly === true,
      flowThinkingLevel,
      flowThinkingLevelDomValue,
      flowVideoResolution,
      flowVideoResolutionDomValue: resolutionOption?.dom_value || null,
    });
  }
  static async getEditor() {
    return this.sendToContentScript("getEditor");
  }
  static async ensureFlowCorrelationObserver(timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return {
        success: false,
        error: "FLOW_RECOVERY_OBSERVER_UNAVAILABLE",
        observerCheckStage: "timeout_config_invalid",
      };
    }
    const pinned = await this._getExecutionTarget(this._currentExecutionId);
    let context;
    if (pinned) {
      const tab = await chrome.tabs.get(pinned.tabId).catch(() => null);
      const page = this._describeFlowUrl(tab?.url);
      if (
        !page ||
        page.driverKey !== pinned.driverKey ||
        page.origin !== pinned.origin ||
        page.projectId !== pinned.projectId ||
        (page.routePrefix || "") !== (pinned.routePrefix || "")
      ) {
        return {
          success: false,
          error: "FLOW_EXECUTION_TARGET_CHANGED",
          tabId: pinned.tabId,
        };
      }
      context = { ...page, tabId: pinned.tabId };
    } else {
      context = await this.getTargetContext();
    }
    if (context?.driverKey !== "flow_v2" || !Number.isInteger(context.tabId)) {
      return { success: false, error: "FLOW_V2_REQUIRED" };
    }
    let timer;
    try {
      return await Promise.race([
        chrome.runtime.sendMessage({
          action: "ensureFlowCorrelationObserver",
          tabId: context.tabId,
        }),
        new Promise((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                success: false,
                error: "FLOW_RECOVERY_OBSERVER_UNAVAILABLE",
                observerCheckStage: "ack_timeout",
              }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  static async insertText(text) {
    return this.sendToContentScript("insertText", { text });
  }
  static async clearEditor() {
    return this.sendToContentScript("clearEditor");
  }
  static async clickSubmit(options = {}) {
    return this.sendToContentScript("clickSubmit", options);
  }
  static async armFlowCorrelation(payload) {
    return this.sendToContentScript("flowCorrelationArm", payload);
  }
  static async waitFlowCorrelation(
    attemptId,
    stages,
    timeoutMs,
    afterSequence = 0,
  ) {
    return this.sendToContentScript("flowCorrelationWait", {
      attemptId,
      stages,
      timeoutMs,
      afterSequence,
    });
  }
  static async snapshotFlowCorrelation(attemptId) {
    return this.sendToContentScript("flowCorrelationSnapshot", { attemptId });
  }
  static async disarmFlowCorrelation(
    attemptId,
    dispatched = true,
    discardOnStop = false,
  ) {
    return this.sendToContentScript("flowCorrelationDisarm", {
      attemptId,
      dispatched,
      discardOnStop,
    });
  }
  static async addFileToPrompt(fileId, fileName, flowFileId) {
    return this.addRefImages(
      [fileId],
      { [fileId]: fileName },
      { [fileId]: "image" },
      { [fileId]: flowFileId || null },
    );
  }
  static async getCurrentTileIds() {
    return this.sendToContentScript("getCurrentTileIds");
  }
  static async waitForNewTiles(preTileIds, timeout, options = {}) {
    return this.sendToContentScript(
      "waitForNewTiles",
      {
        preTileIds,
        timeout,
        captureFileNames: options.captureFileNames || false,
        preFileNames: options.preFileNames || null,
        maxQuantity: options.maxQuantity || 0,
        operationId: options.operationId || null,
        expectedMediaType: options.expectedMediaType || null,
      },
      { signal: options.signal },
    );
  }
  static async stopExecution() {
    console.info(
      "[FlowBatchControlAudit]",
      JSON.stringify({
        event: "stop_requested",
        caller: String(new Error().stack || "")
          .split("\n")
          .slice(1, 7)
          .join("\n"),
      }),
    );
    let lastAck = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        lastAck = await this.sendToContentScript("stopExecution");
        if (lastAck?.success === true && lastAck.released === true) {
          console.info(
            "[ExecutionBlockerAudit] stop acknowledged",
            JSON.stringify({ attempt: attempt + 1 }),
          );
          return lastAck;
        }
      } catch (error) {
        console.warn(
          "[MessageBridge] Flow stop delivery failed:",
          error?.message || error,
        );
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.warn(
      "[ExecutionBlockerAudit] stop not acknowledged after retries",
      lastAck,
    );
    return lastAck || { success: false, released: false };
  }
  static async releaseFlowBlocker({
    blockerRunId = null,
    stopRelease = false,
  } = {}) {
    let lastAck = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        lastAck = await this.sendToContentScript("pq:hideBlocker", {
          immediate: true,
          blockerRunId: blockerRunId || null,
          stopRelease: stopRelease === true,
        });
        if (lastAck?.success === true && lastAck.released === true) {
          console.info(
            "[ExecutionBlockerAudit] release acknowledged",
            JSON.stringify({ blockerRunId, stopRelease, attempt: attempt + 1 }),
          );
          return lastAck;
        }
        if (lastAck?.success === true && lastAck.stale === true) {
          console.info(
            "[ExecutionBlockerAudit] stale release ignored safely",
            JSON.stringify({
              blockerRunId,
              activeBlockerRunId: lastAck.activeBlockerRunId || null,
              attempt: attempt + 1,
            }),
          );
          return lastAck;
        }
        console.warn(
          "[MessageBridge] Flow blocker release not confirmed:",
          lastAck,
        );
      } catch (error) {
        console.warn(
          "[MessageBridge] Flow blocker release failed:",
          error?.message || error,
        );
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    console.warn(
      "[ExecutionBlockerAudit] release not acknowledged after retries",
      { blockerRunId, stopRelease, lastAck },
    );
    return lastAck || { success: false, released: false };
  }
  static async pauseExecution() {
    return this.sendToContentScript("pauseExecution");
  }
  static async resumeExecution() {
    return this.sendToContentScript("resumeExecution");
  }
  static async getRunningState() {
    return this.sendToContentScript("getRunningState");
  }
  static async getFailedPrompts() {
    return this.sendToContentScript("getFailedPrompts");
  }
  static async clearFailedPrompts() {
    return this.sendToContentScript("clearFailedPrompts");
  }
  static async scanFlowImages(deep = false, options = {}) {
    if (window.flow_uuid_gateway)
      return window.flow_uuid_gateway.listMedia(options);
    return this.sendToContentScript("scanFlowImages", {
      deep: false,
      ...(options.expectedFlowTarget && {
        expectedFlowTarget: options.expectedFlowTarget,
      }),
    });
  }
  static async getThumbnailsByIds(fileIds, options = {}) {
    const lookup = {
      fileIds,
      nativeVideoIdentitiesOnly: options.nativeVideoIdentitiesOnly === true,
      nativeMediaIdentitiesOnly: options.nativeMediaIdentitiesOnly === true,
      activateForMetadata: options.activateForMetadata === true,
      fileNamesById: options.fileNamesById || {},
      displayNamesById: options.displayNamesById || {},
      ownerRecords: Array.isArray(options.ownerRecords)
        ? options.ownerRecords
        : [],
      allowOwnerIdentityPromotion: false,
      excludedPersistentMediaIds: Array.isArray(
        options.excludedPersistentMediaIds,
      )
        ? options.excludedPersistentMediaIds
        : [],
      exactIdentityOnly: options.exactIdentityOnly === true,
      deep:
        options.nativeMediaIdentitiesOnly === true ||
        options.nativeVideoIdentitiesOnly === true ||
        options.exactIdentityOnly === true
          ? false
          : options.deep !== false,
      waitMountedMs: Math.max(0, Number(options.waitMountedMs) || 0),
    };
    if (lookup.nativeMediaIdentitiesOnly || lookup.nativeVideoIdentitiesOnly) {
      lookup.activateForMetadata = false;
      lookup.waitMountedMs = 0;
    }
    if (window.flow_uuid_gateway && fileIds?.length) {
      const identities = fileIds.map((id) =>
        window.flow_uuid_gateway.identity(
          lookup.ownerRecords.find((owner) => owner.resultId === id),
          lookup.fileNamesById[id] || id,
        ),
      );
      const gated = await window.flow_uuid_gateway.resolve(identities, {
        ...options,
        mode: options.mode || "web",
        ownerRecords: lookup.ownerRecords,
      });
      if (gated.target || options.expectedFlowTarget)
        lookup.expectedFlowTarget = gated.target || options.expectedFlowTarget;
      const results = {},
        statuses = {};
      fileIds.forEach((id, index) => {
        const verdict = gated.results[identities[index]];
        if (verdict?.ok) {
          results[id] = verdict.metadata;
          statuses[id] = "resolved";
        } else
          statuses[id] =
            verdict?.status === "not_found" ? "missing" : "unresolved";
      });
      if (
        lookup.nativeMediaIdentitiesOnly ||
        lookup.nativeVideoIdentitiesOnly ||
        fileIds.every(
          (id) => results[id]?.thumbnail || results[id]?.source_thumbnail,
        )
      ) {
        const target = gated.target || options.expectedFlowTarget || null;
        return { results, statuses, projectId: target?.projectId || null };
      }
      lookup._gatewayResults = results;
      lookup._gatewayStatuses = statuses;
      lookup.fileIds = fileIds.filter(
        (id) => statuses[id] !== "missing" && !results[id]?.thumbnail,
      );
      if (!lookup.fileIds.length) return { results, statuses };
    }
    const gatewayResults = lookup._gatewayResults || {},
      gatewayStatuses = lookup._gatewayStatuses || {};
    delete lookup._gatewayResults;
    delete lookup._gatewayStatuses;
    const mergeGateway = (response) => {
      const results = { ...gatewayResults },
        statuses = { ...gatewayStatuses };
      for (const [id, info] of Object.entries(response?.results || {})) {
        results[id] =
          window.flow_uuid_gateway?.mergeMetadata?.(results[id], info) || info;
      }
      for (const [id, status] of Object.entries(response?.statuses || {})) {
        statuses[id] =
          status === "missing" &&
          ["resolved", "unresolved"].includes(gatewayStatuses[id])
            ? gatewayStatuses[id]
            : status;
      }
      return { ...response, results, statuses };
    };
    const requiresBoundedScan = lookup.activateForMetadata || lookup.deep;
    if (!requiresBoundedScan)
      return mergeGateway(
        await this.sendToContentScript("getThumbnailsByIds", lookup, {
          signal: options.signal,
        }),
      );
    const timeoutMs = Number(
      window.SystemConfig?.getTimeout?.("flow_ref_scan_timeout_ms"),
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      console.warn(
        "[FlowMetadataLookup] config missing",
        JSON.stringify({ key: "flow_ref_scan_timeout_ms" }),
      );
      throw new Error("METADATA_SCAN_TIMEOUT_CONFIG_UNAVAILABLE");
    }
    const started = Date.now();
    lookup.metadataRequestId = crypto.randomUUID();
    lookup.metadataDeadline = started + timeoutMs;
    const audit = {
      requestId: lookup.metadataRequestId,
      requested: fileIds.length,
      timeoutMs,
      deep: lookup.deep,
      activateForMetadata: lookup.activateForMetadata,
    };
    console.log("[FlowMetadataLookup] start", JSON.stringify(audit));
    let timer;
    let expired = false;
    try {
      return await Promise.race([
        this.sendToContentScript("getThumbnailsByIds", lookup, {
          signal: options.signal,
        }).then((response) => {
          console.log(
            "[FlowMetadataLookup] response",
            JSON.stringify({
              ...audit,
              elapsedMs: Date.now() - started,
              late: expired,
              returned: Object.keys(response?.results || {}).length,
              statuses: response?.statuses || {},
            }),
          );
          return mergeGateway(response);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error("METADATA_SCAN_TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      console.warn(
        "[FlowMetadataLookup] failed",
        JSON.stringify({
          ...audit,
          elapsedMs: Date.now() - started,
          error: error?.message || String(error),
        }),
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  static async _activateMetadataScanTarget(tab, context) {
    const busy = () =>
      window.workflowExecutor?.isRunning === true ||
      window.PromptQueue?._instance?._isRunning === true;
    if (busy()) throw new Error("METADATA_SCAN_EXECUTION_BUSY");
    if (!tab.active) await chrome.tabs.update(tab.id, { active: true });
    const current = await chrome.tabs.get(tab.id);
    const resolved = this._describeFlowUrl(current.url);
    if (busy()) throw new Error("METADATA_SCAN_EXECUTION_BUSY");
    if (
      !resolved ||
      resolved.origin !== context.origin ||
      resolved.projectId !== context.projectId
    ) {
      throw new Error("METADATA_SCAN_TARGET_CHANGED");
    }
    console.log(
      "[FlowMetadataActivation]",
      JSON.stringify({
        tabId: tab.id,
        projectId: context.projectId || null,
        previouslyActive: tab.active === true,
        focusWindow: false,
      }),
    );
  }
  static async resolveVideoPlaybackUrl(fileId, options = {}) {
    const abortFn =
      options.abortFn || (options.signal ? () => options.signal.aborted : null);
    const assertActive = () => {
      if (abortFn?.())
        throw Object.assign(new Error("ABORTED"), {
          code: "ABORTED",
          name: "AbortError",
          noRetry: true,
        });
    };
    assertActive();
    const rejectedVideoUrls = (
      Array.isArray(options.rejectedVideoUrls) ? options.rejectedVideoUrls : []
    )
      .filter((value) => typeof value === "string")
      .slice(0, 8);
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const mediaIds = [];
    const addMediaId = (value) => {
      const normalized = String(value || "").replace(/^flow-v2-result:/i, "");
      if (uuidPattern.test(normalized) && !mediaIds.includes(normalized))
        mediaIds.push(normalized);
    };
    addMediaId(options.persistentMediaId);
    addMediaId(options.fileName);
    if (options.sourceUrl) {
      try {
        const parsed = new URL(options.sourceUrl);
        const matched = parsed.pathname.match(
          /\/(?:image|video)\/([0-9a-f-]{36})(?:\/|$)/i,
        );
        if (matched) addMediaId(matched[1]);
      } catch (_) {}
    }
    addMediaId(fileId);
    if (window.flow_uuid_gateway && mediaIds.length) {
      const mode =
        options.forceDomResolve || options.skipMediaApiResolve
          ? "web"
          : options.mode ||
            window.storageSettings?.getSettings?.()?.defaultGenMode;
      if (mode === "api" && options.providerData?.api_driver === "v1") {
        for (const mediaId of mediaIds) {
          let legacy;
          try {
            legacy = await window.flow_uuid_gateway.resolveMedia({
              ...options,
              mediaId,
              apiDriver: "v1",
              mediaType: "video",
              mode,
              abortFn,
            });
          } catch (error) {
            assertActive();
            if (
              error?.name === "AbortError" ||
              [
                "FLOW_EXECUTION_TARGET_CHANGED",
                "PROJECT_MISMATCH",
                "FLOW_MEDIA_LOOKUP_SCOPE_CHANGED",
              ].includes(error?.code)
            )
              throw error;
          }
          assertActive();
          if (
            legacy?.url &&
            !/\/image\//i.test(legacy.url) &&
            !/[=]w\d+/i.test(legacy.url) &&
            !rejectedVideoUrls.includes(legacy.url)
          ) {
            return {
              success: true,
              video_url: legacy.url,
              ...(legacy.posterUrl && { thumbnail: legacy.posterUrl }),
              persistent_media_id: mediaId,
              resolved_by_media_id: true,
              revoke_on_close: legacy.revoke === true,
            };
          }
        }
      }
      const gated = await window.flow_uuid_gateway.resolve(mediaIds, {
        ...options,
        mediaType: "video",
        mode:
          options.forceDomResolve || options.skipMediaApiResolve
            ? "web"
            : options.mode,
      });
      if (gated.failed.length) throw window.flow_uuid_gateway.error();
      const info = mediaIds
        .map((id) => gated.results[id]?.metadata)
        .find(
          (info2) =>
            info2?.video_url && !rejectedVideoUrls.includes(info2.video_url),
        );
      if (info) return { success: true, ...info };
      options = { ...options, skipMediaApiResolve: true };
    }
    const identityValues = [
      options.persistentMediaId,
      options.fileName,
      options.sourceUrl,
    ].map((value) => String(value || ""));
    const hasAsbIdentity = identityValues.some(
      (value) =>
        /^(?![0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$)[A-Za-z0-9_-]{32,1024}$/i.test(
          value,
        ) || /\/asb\/[A-Za-z0-9_-]{32,}/.test(value),
    );
    let lookupProviderData = options.providerData || null;
    if (
      mediaIds.length &&
      !lookupProviderData?.api_driver &&
      options.forceDomResolve !== true &&
      options.skipMediaApiResolve !== true &&
      [true, "true", 1].includes(
        window.storageSettings?.getSettings?.()?.apiModeEnabled,
      )
    ) {
      try {
        const target = await this.getTargetContext();
        const projectId = target?.projectId;
        if (
          projectId &&
          (!options.projectId || options.projectId === projectId)
        ) {
          const health = await window.FlowApiSessionCoordinator?.check?.({
            projectId,
            surface: options.surface || "gen",
            mediaType: "video",
            passive: true,
          });
          if (health?.ready === true && health.driver === "v2") {
            const config =
              await window.ProviderConfigManager?.fetchFlowApiV2Configs?.();
            const fingerprint =
              config && window.FlowApiV2CheckpointStore?.fingerprint?.(config);
            if (fingerprint)
              lookupProviderData = {
                provider: "flow",
                api_driver: "v2",
                project_id: projectId,
                uuidLookup: true,
                media_type: "video",
                protocol_revision: Number(config.protocol?.schema_version || 0),
                protocol_fingerprint: fingerprint,
              };
          }
        }
      } catch (_) {}
    }
    if (
      mediaIds.length &&
      lookupProviderData?.api_driver &&
      options.forceDomResolve !== true &&
      options.skipMediaApiResolve !== true &&
      window.FlowApiFacade?.resolveMedia
    ) {
      for (const mediaId of mediaIds) {
        assertActive();
        let lookupError = null;
        let lineageCheck = null;
        const resolved = await window.FlowApiFacade.resolveMedia({
          mediaId,
          mediaType: "video",
          providerData: lookupProviderData,
          waitForMaterialization: !hasAsbIdentity,
          thumbnail: options.thumbnail || options.mediaInfo || options,
          abortFn,
        }).catch((error) => {
          if ((error?.code || error?.message) === "ABORTED") throw error;
          lookupError = error?.code || error?.message || "MEDIA_LOOKUP_FAILED";
          lineageCheck =
            window.FlowApiDriverError?.safeLineageCheck?.(error) || null;
          return null;
        });
        assertActive();
        if (lookupError)
          console.warn(
            "[FlowVideoPlaybackLookup]",
            JSON.stringify({
              mediaId,
              driver: lookupProviderData?.api_driver || null,
              reason: String(lookupError).slice(0, 200),
              lineageCheck,
            }),
          );
        if (
          resolved?.url &&
          !/\/image\//i.test(resolved.url) &&
          !/[=]w\d+/i.test(resolved.url) &&
          !rejectedVideoUrls.includes(resolved.url)
        ) {
          console.log(
            "[MessageBridge] video playback recovered by media UUID",
            JSON.stringify({ mediaId }),
          );
          return {
            success: true,
            video_url: resolved.url,
            thumbnail: resolved.posterUrl || options.sourceUrl || "",
            persistent_media_id: mediaId,
            resolved_by_media_id: true,
            revoke_on_close: resolved.revoke === true,
          };
        }
      }
      console.warn(
        "[MessageBridge] media UUID playback recovery unavailable",
        JSON.stringify({
          candidates: mediaIds,
          bridgeInstalled: !!window.BridgeClient,
        }),
      );
    }
    const uuidOnly = mediaIds.length > 0 && !hasAsbIdentity;
    assertActive();
    const allowVirtualScan =
      options.allowVirtualScan !== false &&
      (!uuidOnly || options.allowUuidVirtualScan === true);
    if (uuidOnly && !allowVirtualScan) {
      console.warn(
        "[MessageBridge] UUID-only video: virtual DOM scan suppressed",
      );
    }
    return this.sendToContentScript(
      "resolveVideoPlaybackUrl",
      {
        fileId,
        fileName: options.fileName || "",
        ...(options.projectId ? { projectId: options.projectId } : {}),
        sourceUrl: options.sourceUrl || "",
        forceDomResolve: options.forceDomResolve === true,
        rejectedVideoUrls,
        skipMediaApiResolve: options.skipMediaApiResolve === true,
        allowVirtualScan,
        ...(Object.prototype.hasOwnProperty.call(options, "activationTimeoutMs")
          ? {
              activationTimeoutMs: Math.max(
                0,
                Number(options.activationTimeoutMs) || 0,
              ),
            }
          : {}),
      },
      { signal: options.signal },
    );
  }
  static async prepareFlowForScan() {
    return this.sendToContentScript("prepareFlowForScan");
  }
  static async findTileByFileName(fileName) {
    return this.sendToContentScript("findTileByFileName", { fileName });
  }
  static async correctStaleFileIds(
    idToUrlMap,
    fileNameMap = {},
    fileIdMap = {},
    options = {},
  ) {
    return this.sendToContentScript(
      "correctStaleFileIds",
      {
        idToUrlMap,
        fileNameMap,
        fileIdMap,
        skipZoomScan: options.skipZoomScan === true,
        trustedFileNameIds: Array.isArray(options.trustedFileNameIds)
          ? options.trustedFileNameIds
          : [],
      },
      { signal: options.signal },
    );
  }
  static _normalizeFlowUploadResult(result) {
    if (result?.stage !== "close_upload_menu" || !result.error) return result;
    const verified = result.tileDetails?.some(
      (detail) =>
        detail.id &&
        detail.file_name &&
        (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          detail.id,
        ) ||
          /^(?![0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$)[A-Za-z0-9_-]{32,1024}$/i.test(
            detail.id,
          )),
    );
    if (!verified) return result;
    const { error, ...receipt } = result;
    return { ...receipt, success: true, warning: error, editorReady: false };
  }
  static async _uploadFlowBatch(filesData, options = {}) {
    if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
    if (
      options.requiredMode === "api" &&
      (!window.FlowApiV2Driver?.uploadReference ||
        ![true, "true", 1].includes(
          window.storageSettings?.getSettings?.().apiModeEnabled,
        ) ||
        window.featureGate?.canUse?.("flow_api_enabled") !== true)
    ) {
      throw Object.assign(new Error("FLOW_PINNED_API_MODE_UNAVAILABLE"), {
        noRetry: true,
        noReplay: true,
      });
    }
    const assertUploadTarget = (target2) => {
      const expected = options.expectedFlowTarget;
      if (
        expected &&
        (!target2 ||
          target2.tabId !== expected.tabId ||
          target2.projectId !== expected.projectId ||
          target2.driverKey !== expected.driverKey ||
          target2.origin !== expected.origin)
      )
        throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
    };
    for (const file of filesData) {
      if (!file.key) continue;
      for (const [key, entry] of this._apiUploadResults) {
        if (key.endsWith(`:${file.key}`) && entry?.noReplay) throw entry;
      }
    }
    const domUpload = async (batch) => {
      if (options.requiredMode === "api")
        throw Object.assign(
          new Error("FLOW_PINNED_API_UPLOAD_FALLBACK_BLOCKED"),
          { noRetry: true, noReplay: true, notDispatched: true },
        );
      const uploadControl = options._uploadCancelControl;
      const previousRoute = uploadControl?.activeRoute;
      if (uploadControl) uploadControl.activeRoute = "web";
      try {
        if (options._flowWebPrepared !== true) {
          await this._ensureFlowTabActive(options.expectedFlowTarget);
          const preparation = await this.prepareFlowForGen(
            options.expectedFlowTarget,
          );
          if (preparation?.success === false)
            throw new Error(preparation.error || "FLOW_PREPARE_FAILED");
          options._flowWebPrepared = true;
        }
        const target2 = await this.getTargetContext(options.expectedFlowTarget);
        if (!target2) throw new Error("FLOW_PROJECT_REQUIRED");
        assertUploadTarget(target2);
        if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
        let configuredRetries = 0;
        try {
          configuredRetries = window.ExecutionConfig?.getMaxRetries?.();
        } catch (_) {}
        const maxRetries =
          Number.isInteger(configuredRetries) &&
          configuredRetries >= 0 &&
          configuredRetries <= 10
            ? configuredRetries
            : 0;
        const uploadRequestId = crypto.randomUUID();
        let uploadMenuOwnerTabId = null;
        if (options.surface === "workflow") {
          try {
            const current = await chrome.tabs.getCurrent?.();
            uploadMenuOwnerTabId = current?.id ?? null;
            if (
              current?.url?.split(/[?#]/)[0] ===
              chrome.runtime.getURL("run-window.html")
            ) {
              const workflowId =
                window.workflowExecutor?.currentWorkflow?.wf_id;
              const candidates = await chrome.tabs.query({
                active: true,
                lastFocusedWindow: true,
              });
              const space = candidates.find((tab) => {
                try {
                  const url = new URL(tab.url);
                  return (
                    [
                      "https://local.566flow.invalid",
                      "https://566flow.invalid",
                    ].includes(url.origin) &&
                    !!workflowId &&
                    url.pathname ===
                      `/app/spaces/${encodeURIComponent(workflowId)}`
                  );
                } catch (_) {
                  return false;
                }
              });
              if (space) uploadMenuOwnerTabId = space.id;
            }
          } catch (_) {}
        }
        let settleMonitorWake;
        const uploadSettled = new Promise((resolve) => {
          settleMonitorWake = resolve;
        });
        let monitorWakeTask = null;
        const monitorWakeTimer =
          options.surface === "workflow"
            ? setTimeout(() => {
                monitorWakeTask = (async () => {
                  let focus = null;
                  let releaseTimer = null;
                  try {
                    if (options.abortFn?.()) return;
                    focus = await chrome.runtime.sendMessage({
                      action: "flow:uploadMenuFocus",
                      phase: "begin",
                      stage: "result_monitor",
                      tabId: target2.tabId,
                      projectId: target2.projectId,
                      requestId: uploadRequestId,
                    });
                    console.info(
                      "[FlowUploadMonitorWake] decision",
                      JSON.stringify({
                        requestId: uploadRequestId,
                        tabId: target2.tabId,
                        focused: focus?.focused === true,
                        reason: focus?.reason || focus?.error || null,
                      }),
                    );
                    if (focus?.focused === true) {
                      await Promise.race([
                        uploadSettled,
                        new Promise((resolve) => {
                          releaseTimer = setTimeout(resolve, 800);
                        }),
                      ]);
                    }
                  } catch (error) {
                    console.warn(
                      "[FlowUploadMonitorWake] failed:",
                      error?.message || error,
                    );
                  } finally {
                    if (releaseTimer !== null) clearTimeout(releaseTimer);
                    if (focus?.focused === true) {
                      try {
                        await chrome.runtime.sendMessage({
                          action: "flow:uploadMenuFocus",
                          phase: "end",
                          tabId: target2.tabId,
                          requestId: uploadRequestId,
                        });
                      } catch (error) {
                        console.warn(
                          "[FlowUploadMonitorWake] restore failed:",
                          error?.message || error,
                        );
                      }
                    }
                  }
                })();
              }, 15e3)
            : null;
        const unsubscribe = options._uploadCancelControl?.onCancel?.(() => {
          try {
            console.log(
              "[FlowUploadCancel] sent",
              JSON.stringify({ uploadRequestId, tabId: target2.tabId }),
            );
            chrome.tabs
              .sendMessage(target2.tabId, {
                action: "cancelFlowUpload",
                uploadRequestId,
                _flowTarget: target2,
              })
              .then((response) => {
                console.log(
                  "[FlowUploadCancel] acknowledged",
                  JSON.stringify({
                    uploadRequestId,
                    accepted: response?.success === true,
                    matchedActive: response?.matchedActive === true,
                    error: response?.error || null,
                  }),
                );
              })
              .catch((error) => {
                console.warn(
                  "[FlowUploadCancel] signal failed",
                  error?.message || String(error),
                );
              });
          } catch (error) {
            console.warn(
              "[FlowUploadCancel] signal failed",
              error?.message || String(error),
            );
          }
        });
        try {
          let firstError = null;
          for (let attempt = 0; ; attempt++) {
            if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
            try {
              if (attempt === 0) await options.onBeforeTransport?.();
              return this._normalizeFlowUploadResult(
                await this.sendToContentScript("uploadFilesToFlow", {
                  filesData: batch,
                  manualUpload: options.manualUpload === true,
                  uploadRequestId,
                  uploadMaxRetries: attempt === 0 ? maxRetries : 0,
                  workflowUploadMenuFocus: options.surface === "workflow",
                  uploadMenuOwnerTabId,
                  ...(attempt > 0 && { uploadReconcileOnly: true }),
                  expectedFlowTarget: target2,
                }),
              );
            } catch (error) {
              const uncertain =
                error?.noReplay === true ||
                error?.code === "V2_UPLOAD_RESULT_UNVERIFIED" ||
                error?.code === "V2_UPLOAD_TRAP_NOT_FIRED" ||
                error?.code === "V2_UPLOAD_MENU_CLEANUP_FAILED";
              if (attempt === 0 && uncertain) firstError = error;
              if (!firstError || attempt >= maxRetries || options.abortFn?.())
                throw firstError || error;
              if (attempt > 0 && error?.code !== "V2_UPLOAD_RESULT_UNVERIFIED")
                throw error;
              console.info(
                "[FlowUploadRetry] reconciling dispatched file",
                JSON.stringify({
                  retry: attempt + 1,
                  maxRetries,
                  tabId: target2.tabId,
                  originalCode: firstError.code || firstError.message,
                }),
              );
              await new Promise((resolve) => setTimeout(resolve, 750));
            }
          }
        } finally {
          if (monitorWakeTimer !== null) clearTimeout(monitorWakeTimer);
          settleMonitorWake();
          if (monitorWakeTask) await monitorWakeTask;
          unsubscribe?.();
        }
      } finally {
        if (uploadControl) uploadControl.activeRoute = previousRoute;
      }
    };
    if (
      options.control &&
      (options.forceDom === true ||
        !window.FlowApiV2Driver?.uploadReference ||
        ![true, "true", 1].includes(
          window.storageSettings?.getSettings?.().apiModeEnabled,
        ) ||
        window.featureGate?.canUse?.("flow_api_enabled") !== true)
    ) {
      const merged = {
        tileIds: [],
        orderedTileIds: [],
        tileDetails: [],
        keyMapping: {},
      };
      try {
        for (const file of filesData) {
          await options.control.checkpoint();
          const receipt = await this._uploadFlowBatch([file], {
            ...options,
            control: null,
          });
          if (receipt?.error || receipt?.success === false)
            return {
              ...receipt,
              ...merged,
              error: receipt.error || "UPLOAD_FAILED",
            };
          for (const key of ["tileIds", "orderedTileIds", "tileDetails"])
            merged[key].push(...(receipt?.[key] || []));
          Object.assign(merged.keyMapping, receipt?.keyMapping || {});
          if (options.reportProgress !== false)
            options.control.progress(++options._uploadCompleted.value);
        }
      } catch (error) {
        error.partialResult = merged;
        throw error;
      }
      return merged;
    }
    if (options.forceDom === true || !window.FlowApiV2Driver?.uploadReference)
      return domUpload(filesData);
    const settings = window.storageSettings?.getSettings?.() || {};
    if (
      ![true, "true", 1].includes(settings.apiModeEnabled) ||
      window.featureGate?.canUse?.("flow_api_enabled") !== true
    )
      return domUpload(filesData);
    const target = await this.getTargetContext(options.expectedFlowTarget);
    assertUploadTarget(target);
    const result = {
      tileIds: [],
      orderedTileIds: [],
      tileDetails: [],
      keyMapping: {},
    };
    for (const file of filesData) {
      try {
        await options.control?.checkpoint();
      } catch (error) {
        error.partialResult = result;
        throw error;
      }
      if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
      const cacheKey =
        file.key && target?.projectId
          ? `${target.projectId}:${file.key}`
          : null;
      let uploaded = cacheKey ? this._apiUploadResults.get(cacheKey) : null;
      if (uploaded?.noReplay === true || uploaded instanceof Error)
        throw uploaded;
      if (!uploaded) {
        try {
          uploaded = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "video/mp4",
            "video/webm",
            "video/quicktime",
          ].includes(file.type)
            ? await window.FlowApiV2Driver.uploadReference({
                base64: file.base64,
                fileName: file.name,
                mimeType: file.type,
                projectId: target?.projectId || null,
                flowTabId: target?.tabId,
                surface: options.surface || "gen",
                abortFn: options.abortFn,
                onBeforeTransport: options.onBeforeTransport,
                domUpload: () =>
                  options.requiredMode === "api"
                    ? Promise.reject(
                        Object.assign(
                          new Error("FLOW_PINNED_API_UPLOAD_FALLBACK_BLOCKED"),
                          { noRetry: true, noReplay: true },
                        ),
                      )
                    : domUpload([file]),
              })
            : options.requiredMode === "api"
              ? Promise.reject(
                  Object.assign(
                    new Error("FLOW_PINNED_API_UPLOAD_TYPE_UNSUPPORTED"),
                    { noRetry: true, noReplay: true },
                  ),
                )
              : await domUpload([file]);
        } catch (error) {
          if (cacheKey && error.noReplay)
            this._apiUploadResults.set(cacheKey, error);
          error.partialResult = result;
          throw error;
        }
        if (cacheKey && uploaded?.ok === true && uploaded.file_id)
          this._apiUploadResults.set(cacheKey, uploaded);
      }
      if (uploaded?.file_id) {
        const detail = {
          id: uploaded.file_id,
          file_name: uploaded.file_name || uploaded.file_id,
          type:
            uploaded.media_type ||
            (String(file.type || "").startsWith("video/") ? "video" : "image"),
          originalKey: file.key || null,
          originalName: file.name,
          uploadName: file.name,
          thumbnail: file.thumbnail || "",
          thumbnailUrl: uploaded.thumbnailUrl || "",
          ...(uploaded.video_url && { video_url: uploaded.video_url }),
          media_uuid: uploaded.media_uuid,
          persistent_media_id: uploaded.persistent_media_id,
          identity_kind: uploaded.identity_kind,
          identity_durability: uploaded.identity_durability,
          identity_aliases: uploaded.identity_aliases,
          protocol_revision: uploaded.protocol_revision,
          protocol_fingerprint: uploaded.protocol_fingerprint,
          api_driver: uploaded.api_driver,
          project_id: uploaded.project_id,
        };
        result.tileIds.push(detail.id);
        result.orderedTileIds.push(detail.id);
        result.tileDetails.push(detail);
        if (file.key) result.keyMapping[file.key] = detail.id;
      } else {
        if (uploaded?.error || uploaded?.success === false) return uploaded;
        result.tileIds.push(...(uploaded?.tileIds || []));
        result.orderedTileIds.push(
          ...(uploaded?.orderedTileIds || uploaded?.tileIds || []),
        );
        result.tileDetails.push(...(uploaded?.tileDetails || []));
        Object.assign(result.keyMapping, uploaded?.keyMapping || {});
        if (uploaded?.warning) result.warning = uploaded.warning;
        if (uploaded?.editorReady === false) result.editorReady = false;
      }
      if (options.control && options.reportProgress !== false)
        options.control.progress(++options._uploadCompleted.value);
    }
    if (this._apiUploadResults.size > 256) {
      const evictable = [...this._apiUploadResults].find(
        ([, entry]) => !entry?.noReplay,
      );
      if (evictable) this._apiUploadResults.delete(evictable[0]);
    }
    return result;
  }
  static _normalizeUploadFiles(filesData) {
    if (!Array.isArray(filesData)) return [];
    return filesData.map((file) => {
      if (!file || typeof file !== "object" || typeof file.base64 !== "string")
        return file;
      let value = file.base64.trim();
      const data =
        /^data:((?:image|video)\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(
          value,
        );
      if (data) value = data[2];
      value = value.replace(/\s+/g, "");
      if (!value || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(value)) {
        return {
          ...file,
          _flowUploadBase64Error: "FLOW_UPLOAD_BASE64_INVALID",
        };
      }
      value = value.replace(/-/g, "+").replace(/_/g, "/");
      const unpadded = value.replace(/=+$/, "");
      if (unpadded.length % 4 === 1) {
        return {
          ...file,
          _flowUploadBase64Error: "FLOW_UPLOAD_BASE64_INVALID",
        };
      }
      value = unpadded;
      if (value.length % 4) value += "=".repeat(4 - (value.length % 4));
      if (!data && value === file.base64) return file;
      const normalized = { ...file, base64: value };
      if (data) normalized.type = data[1].toLowerCase();
      return normalized;
    });
  }
  static usesApiUpload(options = {}) {
    return (
      options.forceDom !== true &&
      typeof window.FlowApiV2Driver?.uploadReference === "function" &&
      [true, "true", 1].includes(
        window.storageSettings?.getSettings?.().apiModeEnabled,
      ) &&
      window.featureGate?.canUse?.("flow_api_enabled") === true
    );
  }
  static async _prepareFlowVideoUploads(filesData, options = {}) {
    if (!filesData.some((file) => /^video\//i.test(file?.type || ""))) return;
    const assertNotStopped = (error) => {
      if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
      if (
        error?.name === "AbortError" ||
        [
          "UPLOAD_STOPPED",
          "MOTION_CANCELLED",
          "ABORTED",
          "USER_CANCELLED",
        ].includes(error?.code || error?.message)
      )
        throw error;
    };
    const bypass = (stage, error, index = null) => {
      assertNotStopped(error);
      const raw = String(
        error?.code || error?.message || "FLOW_UPLOAD_MUTE_FAILED",
      );
      console.warn(
        "[FlowUploadMute]",
        JSON.stringify({
          stage,
          outcome: "bypass_original",
          index,
          code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
            ? raw
            : "FLOW_UPLOAD_MUTE_FAILED",
        }),
      );
    };
    assertNotStopped();
    let enabled;
    try {
      await window.storageSettings?.ensureAuthSettingsReady?.();
      enabled = window.storageSettings?.getSettings?.().autoMuteFlowVideoUpload;
      if (typeof enabled !== "boolean")
        throw new Error("CONFIG_REQUIRED:autoMuteFlowVideoUpload");
    } catch (error) {
      bypass("settings", error);
      return;
    }
    assertNotStopped();
    if (!enabled) return;
    for (let index = 0; index < filesData.length; index++) {
      const file = filesData[index];
      if (!/^video\//i.test(file?.type || "")) continue;
      await options.control?.checkpoint();
      assertNotStopped();
      const muteStartedAt = Date.now();
      try {
        filesData[index] = await this._muteFlowVideoUpload(file, options);
      } catch (error) {
        bypass("processing", error, index);
      } finally {
        console.info(
          "[FlowUploadPerf] mute",
          JSON.stringify({
            operationId: options._uploadPerfId || null,
            index,
            elapsedMs: Date.now() - muteStartedAt,
            inputBase64Chars: file.base64?.length || 0,
          }),
        );
      }
      assertNotStopped();
      await options.control?.checkpoint();
    }
  }
  static _flowUploadMuteError(code) {
    const key = "flowErrors.codes." + code;
    const translated = window.I18n?.t?.(key);
    return Object.assign(
      new Error(translated && translated !== key ? translated : code),
      { code, noRetry: true, notDispatched: true },
    );
  }
  static _muteFlowVideoUpload(file, options = {}) {
    const timeoutMs = Number(
      window.SystemConfig?.safeGetTimeout?.(
        "flow_video_upload_mute_timeout_ms",
      ),
    );
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2147483647
    )
      throw Object.assign(
        new Error("CONFIG_REQUIRED:flow_video_upload_mute_timeout_ms"),
        { noRetry: true, notDispatched: true },
      );
    if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(
          chrome.runtime.getURL("src/core/flow-video-mute-worker.js"),
        );
      } catch (_) {
        reject(this._flowUploadMuteError("FLOW_UPLOAD_MUTE_FAILED"));
        return;
      }
      const id = crypto.randomUUID();
      let timer,
        poll,
        unsubscribe,
        settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        unsubscribe?.();
        worker.onmessage = worker.onerror = null;
        worker.terminate();
        if (error) {
          error.notDispatched = true;
          error.noRetry = true;
          reject(error);
        } else resolve(result);
      };
      const stop = () => finish(new Error("UPLOAD_STOPPED"));
      worker.onerror = () =>
        finish(this._flowUploadMuteError("FLOW_UPLOAD_MUTE_FAILED"));
      worker.onmessage = ({ data }) => {
        if (data?.id !== id) return;
        if (options.abortFn?.()) return stop();
        if (
          data.success !== true ||
          (!data.unchanged && (typeof data.base64 !== "string" || !data.base64))
        )
          return finish(this._flowUploadMuteError("FLOW_UPLOAD_MUTE_FAILED"));
        finish(
          null,
          data.unchanged
            ? file
            : { ...file, base64: data.base64, type: data.type },
        );
      };
      timer = setTimeout(
        () => finish(this._flowUploadMuteError("FLOW_UPLOAD_MUTE_TIMEOUT")),
        timeoutMs,
      );
      poll = setInterval(() => {
        if (options.abortFn?.()) stop();
      }, 100);
      unsubscribe = options.control?.onCancel?.(stop);
      if (settled) {
        unsubscribe?.();
        return;
      }
      try {
        worker.postMessage({ id, base64: file.base64, type: file.type });
      } catch (_) {
        finish(this._flowUploadMuteError("FLOW_UPLOAD_MUTE_FAILED"));
      }
    });
  }
  static async uploadFilesToFlow(filesData, options = {}) {
    filesData = this._normalizeUploadFiles(
      Array.isArray(filesData)
        ? filesData.map((file) =>
            file && typeof file === "object" ? { ...file } : file,
          )
        : filesData,
    );
    if (filesData.some((file) => file?._flowUploadBase64Error)) {
      const error = new Error("FLOW_UPLOAD_BASE64_INVALID");
      error.code = "FLOW_UPLOAD_BASE64_INVALID";
      error.noRetry = true;
      throw error;
    }
    const ownControl = !options.control;
    const control =
      options.control ||
      this.createUploadControl(filesData.length, options.abortFn);
    const previousActiveRoute = control.activeRoute;
    options = {
      ...options,
      control,
      _uploadCancelControl: control,
      abortFn: control.abortFn,
      _uploadCompleted: { value: 0 },
      _uploadPerfId: globalThis.crypto?.randomUUID?.() || null,
    };
    const queuedAt = Date.now();
    let acquiredAt = null;
    const motionApiParallel =
      options.motionApiParallel === true &&
      options.requiredMode === "api" &&
      options.forceDom !== true &&
      !!options.expectedFlowTarget &&
      filesData.length > 0 &&
      filesData.every((file) => /^video\//i.test(file.type || ""));
    const prev = motionApiParallel
      ? Promise.resolve()
      : _MessageBridge._uploadFlowQueue;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    if (!motionApiParallel)
      _MessageBridge._uploadFlowQueue = prev.catch(() => {}).then(() => gate);
    try {
      let acquired = false;
      const ready = prev
        .catch(() => {})
        .then(() => {
          acquired = true;
        });
      while (!acquired) {
        if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
        await Promise.race([
          ready,
          new Promise((resolve) => setTimeout(resolve, 200)),
        ]);
      }
      if (options.abortFn?.()) throw new Error("UPLOAD_STOPPED");
      acquiredAt = Date.now();
      console.info(
        "[FlowUploadPerf] queue_acquired",
        JSON.stringify({
          operationId: options._uploadPerfId,
          files: filesData.length,
          queueMs: acquiredAt - queuedAt,
          motionApiParallel,
        }),
      );
      if (options.expectedProjectId)
        options.expectedFlowTarget = await this.resolveUploadTarget(options);
      await this._prepareFlowVideoUploads(filesData, options);
      if (options.expectedFlowTarget) {
        const target = await this.getTargetContext(options.expectedFlowTarget);
        if (
          !target ||
          target.tabId !== options.expectedFlowTarget.tabId ||
          target.projectId !== options.expectedFlowTarget.projectId ||
          target.driverKey !== options.expectedFlowTarget.driverKey ||
          target.origin !== options.expectedFlowTarget.origin
        ) {
          throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
        }
      }
      const webUpload = !this.usesApiUpload(options);
      if (options.requiredMode === "api" && webUpload) {
        throw Object.assign(new Error("FLOW_PINNED_API_MODE_UNAVAILABLE"), {
          noRetry: true,
          noReplay: true,
        });
      }
      if (options.requiredMode === "web" && options.forceDom !== true) {
        throw Object.assign(new Error("FLOW_PINNED_WEB_MODE_REQUIRED"), {
          noRetry: true,
        });
      }
      if (webUpload) {
        control.activeRoute = "web";
        await this._ensureFlowTabActive(options.expectedFlowTarget);
        let preparation;
        try {
          preparation = await this.prepareFlowForGen(
            options.expectedFlowTarget,
          );
        } catch (error) {
          if (
            [
              "FLOW_VIEWER_NAVIGATION_TIMEOUT",
              "FLOW_PROJECT_NAVIGATION_TIMEOUT",
            ].includes(error?.code || error?.message)
          ) {
            error.notDispatched = true;
          }
          throw error;
        }
        if (preparation?.success === false) {
          throw new Error(preparation.error || "FLOW_PREPARE_FAILED");
        }
        options._flowWebPrepared = true;
      }
      if (options.expectedFlowTarget) {
        const target = await this.getTargetContext(options.expectedFlowTarget);
        if (
          !target ||
          target.tabId !== options.expectedFlowTarget.tabId ||
          target.projectId !== options.expectedFlowTarget.projectId ||
          target.driverKey !== options.expectedFlowTarget.driverKey ||
          target.origin !== options.expectedFlowTarget.origin
        ) {
          throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
        }
      }
      const batches = _MessageBridge._chunkFilesBySize(filesData);
      if (batches.length > 1) {
        console.log(
          `[MessageBridge] uploadFilesToFlow \u2192 ${filesData.length} file(s) chia ${batches.length} batch (tr\xE1nh 64MiB IPC limit)`,
        );
      }
      const merged = {
        tileIds: [],
        orderedTileIds: [],
        tileDetails: [],
        keyMapping: {},
      };
      const batchErrors = [];
      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        console.log(
          "[MessageBridge] uploadFilesToFlow \u2192 sending batch",
          bi + 1 + "/" + batches.length,
          ":",
          batch.length,
          "file(s)",
        );
        let result;
        try {
          result = await this._uploadFlowBatch(batch, options);
        } catch (e) {
          if (e?.noReplay || options.abortFn?.()) {
            e.partialResult = {
              tileIds: [...merged.tileIds, ...(e.partialResult?.tileIds || [])],
              orderedTileIds: [
                ...merged.orderedTileIds,
                ...(e.partialResult?.orderedTileIds || []),
              ],
              tileDetails: [
                ...merged.tileDetails,
                ...(e.partialResult?.tileDetails || []),
              ],
              keyMapping: {
                ...merged.keyMapping,
                ...(e.partialResult?.keyMapping || {}),
              },
            };
            throw e;
          }
          console.warn(
            `[MessageBridge] uploadFilesToFlow batch ${bi + 1}/${batches.length} l\u1ED7i (${batch.length} file):`,
            e?.message || e,
          );
          batchErrors.push(
            e instanceof Error
              ? e
              : new Error(String(e || "UPLOAD_BATCH_FAILED")),
          );
          continue;
        } finally {
          for (const file of batch) {
            if (file && typeof file === "object") file.base64 = "";
          }
        }
        if (result?.error && result.error !== "UPLOAD_BLOCKED") {
          for (const key of ["tileIds", "orderedTileIds", "tileDetails"])
            merged[key].push(...(result[key] || []));
          Object.assign(merged.keyMapping, result.keyMapping || {});
          const terminal = new Error(result.errorMessage || result.error);
          terminal.code = result.error;
          batchErrors.push(terminal);
          continue;
        }
        if (Array.isArray(result?.tileIds))
          merged.tileIds.push(...result.tileIds);
        if (Array.isArray(result?.orderedTileIds))
          merged.orderedTileIds.push(...result.orderedTileIds);
        if (Array.isArray(result?.tileDetails))
          merged.tileDetails.push(...result.tileDetails);
        if (result?.keyMapping && typeof result.keyMapping === "object")
          Object.assign(merged.keyMapping, result.keyMapping);
        if (result?.warning) merged.warning = result.warning;
        if (result?.errorCode) merged.errorCode = result.errorCode;
        if (result && result.error === "UPLOAD_BLOCKED") {
          merged.error = result.error;
          merged.errorMessage = result.errorMessage;
          merged.blockedFile = result.blockedFile;
          break;
        }
      }
      if (
        batchErrors.length &&
        merged.orderedTileIds.length === 0 &&
        merged.tileIds.length === 0
      ) {
        throw batchErrors[0];
      }
      if (batchErrors.length) {
        merged.warning =
          merged.warning ||
          `UPLOAD_PARTIAL_BATCH_FAILURE:${batchErrors[0].message}`;
      }
      let registeredDetails = 0;
      for (const detail of merged.tileDetails) {
        const tileId = detail?.id || detail?.tileId || null;
        const fileName = detail?.file_name || detail?.file_id || null;
        const thumbnail =
          detail?.thumbnailUrl ||
          detail?.thumbnail_url ||
          detail?.thumbnail ||
          "";
        if (!tileId) continue;
        if (window.MediaRegistry?.set) {
          window.MediaRegistry.set(tileId, thumbnail, fileName || void 0);
        } else if (typeof MediaRegistry !== "undefined" && MediaRegistry?.set) {
          MediaRegistry.set(tileId, thumbnail, fileName || void 0);
        }
        if (fileName && window.workflowExecutor?.isRunning === true) {
          if (!(window._workflowRefPreflightCache instanceof Map)) {
            window._workflowRefPreflightCache = new Map();
          }
          window._workflowRefPreflightCache.set(fileName, tileId);
        }
        registeredDetails++;
      }
      if (registeredDetails > 0) {
        console.log(
          `[MessageBridge] upload identity registered: ${registeredDetails}/${merged.tileDetails.length}`,
        );
      }
      console.log(
        "[FlowUploadContract] completed",
        JSON.stringify({
          contract: "uuid-media-v1",
          files: (merged.tileDetails || []).map((detail) => ({
            sourceIdentity: window.MediaRegistry?.describeIdentity?.(
              detail.originalKey,
            ) || { kind: "redacted" },
            identity: window.MediaRegistry?.describeIdentity?.(detail.id) || {
              kind: "redacted",
            },
            type: detail.type || null,
            hasDisplayName: !!(
              detail.display_name ||
              detail.originalName ||
              detail.uploadName
            ),
            fileIdentity: window.MediaRegistry?.describeIdentity?.(
              detail.file_name,
            ) || { kind: "redacted" },
            hasVideoUrl: !!detail.video_url,
          })),
        }),
      );
      console.log(
        "[MessageBridge] uploadFilesToFlow merged result",
        JSON.stringify({
          tileCount: merged.tileIds?.length || 0,
          orderedCount: merged.orderedTileIds?.length || 0,
          detailCount: merged.tileDetails?.length || 0,
          mappingCount: Object.keys(merged.keyMapping || {}).length,
          warning: merged.warning || null,
          error: merged.error || null,
        }),
      );
      if (merged.error === "UPLOAD_BLOCKED") {
        const reason =
          merged.errorMessage ||
          window.I18n?.t("workflow.uploadBlockedReason") ||
          "Flow rejected the image (content policy violation).";
        console.warn("[MessageBridge] Flow blocked upload:", reason);
        try {
          if (typeof window.showNotification === "function") {
            window.showNotification(reason, "error", 6e3);
          } else if (typeof window.showToast === "function") {
            window.showToast(reason);
          } else if (
            window.customDialog &&
            typeof window.customDialog.alert === "function"
          ) {
            window.customDialog.alert(reason, {
              type: "error",
              title:
                window.I18n?.t("workflow.uploadBlocked") || "Image rejected",
            });
          }
        } catch (_) {}
      }
      return merged;
    } finally {
      console.info(
        "[FlowUploadPerf] settled",
        JSON.stringify({
          operationId: options._uploadPerfId,
          elapsedMs: Date.now() - queuedAt,
          activeMs: acquiredAt === null ? null : Date.now() - acquiredAt,
        }),
      );
      control.activeRoute = previousActiveRoute;
      release();
      if (ownControl) control.finish();
    }
  }
  static _chunkFilesBySize(filesData, maxBytes = 40 * 1024 * 1024) {
    if (!Array.isArray(filesData) || filesData.length <= 1)
      return [filesData || []];
    const batches = [];
    let cur = [];
    let curSize = 0;
    for (const fd of filesData) {
      const size = fd && typeof fd.base64 === "string" ? fd.base64.length : 0;
      if (cur.length > 0 && curSize + size > maxBytes) {
        batches.push(cur);
        cur = [];
        curSize = 0;
      }
      cur.push(fd);
      curSize += size;
    }
    if (cur.length > 0) batches.push(cur);
    return batches.length > 0 ? batches : [filesData];
  }
  static async checkTilesExist(tileIds) {
    return this.sendToContentScript("checkTilesExist", { tileIds });
  }
  static async checkFilesExist(fileNames, options = {}) {
    const gateway = window.flow_uuid_gateway;
    const uuids = gateway
      ? (fileNames || []).filter((id) => gateway.isUuid(id))
      : [];
    if (!uuids.length)
      return this.sendToContentScript(
        "checkFilesExist",
        { fileNames },
        { signal: options.signal },
      );
    const lookup = await gateway.resolve(uuids, {
      ...options,
      mode: "web",
      passive: true,
      purpose: "existence",
    });
    const response = {
      existing: [],
      missing: [],
      found: {},
      unresolved: [],
      projectId: lookup.target?.projectId || null,
    };
    for (const id of uuids) {
      const verdict = lookup.results[id];
      if (verdict?.ok) {
        response.existing.push(id);
        response.found[id] = id;
      } else if (verdict?.status === "not_found") response.missing.push(id);
      else response.unresolved.push(id);
    }
    const legacy = (fileNames || []).filter((id) => !gateway.isUuid(id));
    if (legacy.length) {
      const located = await this.sendToContentScript(
        "checkFilesExist",
        {
          fileNames: legacy,
          ...(lookup.target && { expectedFlowTarget: lookup.target }),
        },
        { signal: options.signal },
      );
      response.existing.push(...(located?.existing || []));
      response.missing.push(...(located?.missing || []));
      Object.assign(response.found, located?.found || {});
    }
    return response;
  }
  static async lookupFlowMediaCatalog(identities, options = {}) {
    if (!window.flow_uuid_gateway)
      return this.sendToContentScript(
        "lookupFlowMediaCatalog",
        { identities },
        { signal: options.signal },
      );
    return window.flow_uuid_gateway.lookupCatalog(identities, options);
  }
  static async downloadTileMedia(
    tileId,
    promptText,
    taskName,
    fileName,
    resolution,
    flowFileId,
    index,
    videoResolution,
    watermarkMode,
    plannedFilename = null,
    requestId = null,
  ) {
    return this.sendToContentScript("downloadTileMedia", {
      tileId,
      promptText,
      taskName,
      fileName,
      resolution,
      plannedFilename,
      requestId,
      flowFileId: flowFileId || null,
      index: index ?? null,
      videoResolution: videoResolution || null,
      watermarkMode: watermarkMode || null,
    });
  }
  static async startCropSelection() {
    return this.sendToContentScript("startCropSelection");
  }
  static async cancelCropSelection() {
    return this.sendToContentScript("cancelCropSelection");
  }
  static async getPreTileSnapshot() {
    return this.sendToContentScript("pq:getPreTileSnapshot");
  }
  static async addRefImages(
    fileIds,
    fileNameMap,
    mediaTypeMap,
    identityMap = {},
    options = {},
  ) {
    const budget = Number(
      window.SystemConfig?.safeGetTimeout?.("flow_ref_scan_timeout_ms"),
    );
    if (!Number.isFinite(budget) || budget <= 0)
      throw Object.assign(new Error("FLOW_SCAN_TIMEOUT_CONFIG_UNAVAILABLE"), {
        code: "FLOW_SCAN_TIMEOUT_CONFIG_UNAVAILABLE",
        noRetry: true,
      });
    const requestId = crypto.randomUUID();
    const signal = options.signal;
    const cancel = () =>
      this.sendToContentScript("cancelFlowScanRequest", { requestId }).catch(
        () => {},
      );
    if (signal?.aborted || options.abortFn?.())
      return { success: false, aborted: true, failedIds: [], addedCount: 0 };
    let cancelSent = false;
    const poll = options.abortFn
      ? setInterval(() => {
          if (!cancelSent && options.abortFn()) {
            cancelSent = true;
            cancel();
          }
        }, 100)
      : null;
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      const result = await this.sendToContentScript("pq:addRefImages", {
        fileIds,
        fileNameMap,
        mediaTypeMap,
        identityMap,
        referenceMetadata: options.referenceMetadata || null,
        preserveReferenceOrder: options.referenceOwner?._owner === "motion",
        flowScanRequestId: requestId,
        flowScanDeadline: Date.now() + budget,
      });
      if (
        options.referenceOwner &&
        result?.referenceIdentities &&
        !result.aborted &&
        !signal?.aborted &&
        !options.abortFn?.()
      ) {
        window.flow_uuid_gateway?.adoptAttachedReferenceIdentities?.(
          options.referenceOwner,
          result.referenceIdentities,
        );
      }
      return result;
    } finally {
      clearInterval(poll);
      signal?.removeEventListener("abort", cancel);
    }
  }
  static async verifyRefAttachments() {
    return this.sendToContentScript("pq:verifyRefAttachments");
  }
  static async removeExistingRefImages() {
    return this.sendToContentScript("pq:removeExistingRefImages");
  }
  static async prepareFlowForGen(expectedFlowTarget = null) {
    await this._ensureFlowTabActive(expectedFlowTarget);
    try {
      return await this.sendToContentScript(
        "prepareFlowForGen",
        expectedFlowTarget ? { expectedFlowTarget } : {},
      );
    } catch (error) {
      if (
        !["FLOW_VIEWER_NAVIGATING", "FLOW_PROJECT_NAVIGATING"].includes(
          error.code || error.message,
        )
      )
        throw error;
      const target = error._flowTarget;
      if (!target?.tabId || !target.projectId) throw error;
      const deadline = Date.now() + 15e3;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const tab = await chrome.tabs.get(target.tabId).catch(() => null);
        const live = this._describeFlowUrl(tab?.url);
        if (
          !live ||
          live.origin !== target.origin ||
          live.projectId !== target.projectId ||
          (live.routePrefix || "") !== (target.routePrefix || "")
        ) {
          throw new Error("FLOW_EXECUTION_TARGET_CHANGED");
        }
        if (!FlowDriverRegistry.isProjectEditor(tab.url)) continue;
        const ping = await chrome.tabs
          .sendMessage(tab.id, { action: "ping" })
          .catch(() => null);
        if (ping?.pong && ping.projectId === target.projectId)
          return this.sendToContentScript("prepareFlowForGen", {
            expectedFlowTarget: target,
          });
      }
      throw new Error(
        error.code === "FLOW_PROJECT_NAVIGATING" ||
          error.message === "FLOW_PROJECT_NAVIGATING"
          ? "FLOW_PROJECT_NAVIGATION_TIMEOUT"
          : "FLOW_VIEWER_NAVIGATION_TIMEOUT",
      );
    }
  }
  static async stabilizeFlowResultViewport() {
    const result = await this.sendToContentScript(
      "stabilizeFlowResultViewport",
    );
    console.info(
      "[FlowViewportSettle] result",
      JSON.stringify({
        moved: result?.moved === true,
        elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : null,
        settleReason: result?.settleReason || null,
        visibility: result?.visibility || null,
      }),
    );
    return result;
  }
  static async verifySlateModel() {
    return this.sendToContentScript("pq:verifySlateModel");
  }
  static async _ensureFlowTabReadyForScrape() {
    const flowUrlPattern =
      window.ProviderConfigManager?.getTabQueryPatterns?.("flow") || [];
    const flowCreateUrl = window.ProviderConfigManager?.getCreateUrl?.("flow");
    let tabs;
    try {
      tabs = await chrome.tabs.query({ url: flowUrlPattern });
    } catch (e) {
      throw new Error(
        "Kh\xF4ng truy c\u1EADp \u0111\u01B0\u1EE3c chrome.tabs (permission thi\u1EBFu ho\u1EB7c context invalid)",
      );
    }
    let flowTab = tabs && tabs[0];
    if (!flowTab) {
      flowTab = await new Promise((resolve, reject) => {
        chrome.tabs.create({ url: flowCreateUrl, active: true }, (tab) => {
          if (chrome.runtime.lastError)
            return reject(new Error(chrome.runtime.lastError.message));
          resolve(tab);
        });
      });
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 3e4;
        const listener = (tabId, changeInfo) => {
          if (tabId === flowTab.id && changeInfo.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        const poll = setInterval(async () => {
          try {
            const t = await chrome.tabs.get(flowTab.id);
            if (t.status === "complete") {
              clearInterval(poll);
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            } else if (Date.now() > deadline) {
              clearInterval(poll);
              chrome.tabs.onUpdated.removeListener(listener);
              reject(new Error("Flow tab load timeout (30s)"));
            }
          } catch (_) {}
        }, 500);
      });
      await new Promise((r) => setTimeout(r, 2e3));
    } else {
      try {
        await chrome.tabs.update(flowTab.id, { active: true });
        if (flowTab.windowId) {
          await chrome.windows.update(flowTab.windowId, { focused: true });
        }
      } catch (_) {}
    }
    try {
      window._targetFlowTabId = flowTab.id;
      await chrome.storage?.session?.set?.({ targetFlowTabId: flowTab.id });
    } catch (_) {}
    return flowTab;
  }
  static async syncFlowVoices() {
    await this._ensureFlowTabReadyForScrape();
    const res = await this.sendToContentScript("scrapeFlowVoices");
    if (!res?.success || !Array.isArray(res.voices)) {
      throw new Error(res?.error || "Scrape failed");
    }
    const merged = await window.VoiceRegistry.saveScrapedList(
      res.voices,
      "flow",
    );
    const customCount = merged.filter((v) => v.is_custom).length;
    const baseCount = merged.length - customCount;
    let uploadedToServer = false;
    try {
      const user = window.authManager?.user;
      const isAdmin = !!(user?.role === "admin" || user?.is_admin === true);
      console.log("[MessageBridge] Voice sync admin check:", {
        hasAuthManager: !!window.authManager,
        hasUser: !!user,
        userEmail: user?.email,
        userRole: user?.role,
        isAdmin,
      });
      if (isAdmin) {
        const baseUrl =
          window.ApiBaseConfig?.getWebBase?.() ||
          "https://local.566flow.invalid";
        const token = window.authManager?.token;
        const headers = {
          Accept: "application/json",
          "Content-Type": "application/json",
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        try {
          if (chrome?.runtime?.id)
            headers["X-Extension-Id"] = chrome.runtime.id;
        } catch (_) {}
        try {
          const v = chrome?.runtime?.getManifest?.()?.version;
          if (v) headers["X-Ext-Version"] = v;
        } catch (_) {}
        const url = `${baseUrl}/api/v1/provider-voices/sync-from-scrape`;
        const body = JSON.stringify({
          provider: "flow",
          scraped_voices: res.voices.map((v) => ({
            name: v.name,
            description: v.description || null,
          })),
          extension_version: chrome?.runtime?.getManifest?.()?.version || null,
        });
        if (!window.RequestSigner) throw new Error("ENROLLMENT_REQUIRED");
        const sigHeaders = await window.RequestSigner.headers(
          "POST",
          new URL(url).pathname,
          body,
        );
        const resp = await fetch(url, {
          method: "POST",
          headers: { ...headers, ...sigHeaders },
          body,
        });
        if (resp.ok) {
          const json = await resp.json();
          uploadedToServer = true;
          console.log("[MessageBridge] \u2713 Voice sync uploaded:", json.data);
        } else if (resp.status === 403) {
          const txt = await resp.text().catch(() => "");
          console.warn(
            "[MessageBridge] \u2717 Voice sync 403 \u2014 admin role required:",
            txt,
          );
        } else if (resp.status === 429) {
          const retryAfter =
            resp.headers.get("Retry-After") ||
            resp.headers.get("X-RateLimit-Reset") ||
            "?";
          console.warn(
            `[MessageBridge] \u2717 Voice sync 429 \u2014 rate limited. Retry after ${retryAfter}s`,
          );
          throw new Error(
            `Server rate limit (429). \u0110\u1EE3i ${retryAfter}s r\u1ED3i th\u1EED l\u1EA1i.`,
          );
        } else {
          console.warn("[MessageBridge] Voice sync failed:", resp.status);
        }
      }
    } catch (e) {
      console.warn(
        "[MessageBridge] Voice sync POST error (non-blocking):",
        e.message,
      );
    }
    return {
      total: merged.length,
      base: baseCount,
      custom: customCount,
      uploaded_to_server: uploadedToServer,
    };
  }
  static async selectFlowVoice(voice) {
    if (!voice || !voice.search_value) return { success: true, skipped: true };
    return this.sendToContentScript("selectFlowVoice", { voice });
  }
  static async syncFlowCharacters() {
    await this._ensureFlowTabReadyForScrape();
    const res = await this.sendToContentScript("scrapeFlowCharacters");
    if (!res?.success || !Array.isArray(res.characters)) {
      throw new Error(res?.error || "Scrape failed");
    }
    const merged = await window.CharacterRegistry.saveScrapedList(
      res.characters,
    );
    return { total: merged.length, characters: merged };
  }
  static async selectFlowCharacter(character) {
    if (!character || !character.search_value)
      return { success: true, skipped: true };
    return this.sendToContentScript("selectFlowCharacter", { character });
  }
  static async addVoiceInline(name) {
    if (!name) return { success: false, error: "empty_name" };
    return this.sendToContentScript("addVoiceInline", { name });
  }
  static async addCharacterInline(name) {
    if (!name) return { success: false, error: "empty_name" };
    return this.sendToContentScript("addCharacterInline", { name });
  }
  static async insertTextSegment(text) {
    return this.sendToContentScript("insertText", { text, segmentMode: true });
  }
  static async countInlineChips(segments = null) {
    return this.sendToContentScript("countInlineChips", { segments });
  }
  static async chatGPTSubmitAndWait({
    text,
    images,
    settings,
    timeout,
    inputTimeoutMs,
    tabId,
    taskName,
    workerAttempt = null,
  }) {
    if (!tabId) {
      return { success: false, error: "MISSING_TAB_ID" };
    }
    const bridgeOperationId = `chatgpt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const bridgeStartedAt = Date.now();
    console.log(
      "[MessageBridge] chatGPTSubmitAndWait \u2192 tab",
      tabId,
      "text len:",
      (text || "").length,
      "images:",
      (images || []).length,
    );
    const _settings = { ...(settings || {}) };
    if (["gen", "task"].includes(_settings.source)) {
      _settings.sourceWindowId =
        (await chrome.windows.getCurrent().catch(() => null))?.id ?? null;
    }
    _settings.editorWaitMs =
      await window.ExecutionConfig.getProviderStartupTimeoutMs("chatgpt");
    if (_settings.scrollDuringGen === void 0) {
      const _raw = window.SystemConfig?.get?.(
        "chatgpt_scroll_during_gen",
        true,
      );
      _settings.scrollDuringGen = !(
        _raw === false ||
        _raw === "0" ||
        _raw === 0 ||
        _raw === "false"
      );
    }
    const effectiveInputTimeoutMs =
      inputTimeoutMs ?? window.storageSettings?.getSettings?.()?.inputTimeout;
    return new Promise((resolve) => {
      const stopHeartbeat = this._startProviderTabHeartbeat("chatgpt", tabId);
      const lifecycle = {
        loadingObserved: false,
        urlChangeObserved: false,
        tabRemovedObserved: false,
      };
      const onUpdated = (id, change) => {
        if (id !== tabId) return;
        lifecycle.loadingObserved ||
          (lifecycle.loadingObserved = change.status === "loading");
        lifecycle.urlChangeObserved ||
          (lifecycle.urlChangeObserved = typeof change.url === "string");
      };
      const onRemoved = (id) => {
        if (id === tabId) lifecycle.tabRemovedObserved = true;
      };
      chrome.tabs.onUpdated?.addListener(onUpdated);
      chrome.tabs.onRemoved?.addListener(onRemoved);
      const audit = (stage, facts = {}) => {
        try {
          console.info?.(
            "[ChatGPTBridge]",
            JSON.stringify({
              bridgeOperationId,
              tabId,
              stage,
              elapsedMs: Date.now() - bridgeStartedAt,
              ...facts,
            }),
          );
        } catch (_) {}
      };
      const finish = (response) => {
        stopHeartbeat();
        chrome.tabs.onUpdated?.removeListener(onUpdated);
        chrome.tabs.onRemoved?.removeListener(onRemoved);
        resolve(response);
      };
      try {
        audit("dispatch");
        chrome.tabs.sendMessage(
          tabId,
          {
            action: "chatgpt:submitAndWait",
            bridgeOperationId,
            text: text || "",
            images: images || [],
            settings: _settings,
            timeout: timeout || 12e4,
            ...(Number.isFinite(Number(effectiveInputTimeoutMs)) &&
            Number(effectiveInputTimeoutMs) > 0
              ? { inputTimeoutMs: Number(effectiveInputTimeoutMs) }
              : {}),
            taskName: taskName || null,
            ...(workerAttempt && { workerAttempt }),
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              const channelMessage = chrome.runtime.lastError.message || "";
              const channelCause =
                /asynchronous response.*channel closed/i.test(channelMessage)
                  ? "async_channel_closed"
                  : /receiving end does not exist/i.test(channelMessage)
                    ? "receiver_missing"
                    : /message (?:port|channel) closed/i.test(channelMessage)
                      ? "channel_closed"
                      : "send_message_error";
              audit("response_channel_failed", { channelCause, ...lifecycle });
              finish({
                success: false,
                error: "SEND_FAILED",
                message: channelMessage,
              });
              return;
            }
            audit("response_received", {
              success: resp?.success === true,
              responsePresent: !!resp,
            });
            finish(resp || { success: false, error: "NO_RESPONSE" });
          },
        );
      } catch (err) {
        audit("dispatch_exception");
        finish({
          success: false,
          error: "EXCEPTION",
          message: err.message,
          diagnostic: { exceptionOrigin: "bridge_dispatch" },
        });
      }
    });
  }
  static async chatGPTFetchImage(url, tabId) {
    return new Promise((resolve) => {
      const stopHeartbeat = this._startProviderTabHeartbeat("chatgpt", tabId);
      const finish = (response) => {
        stopHeartbeat();
        resolve(response);
      };
      try {
        chrome.runtime.sendMessage(
          { action: "chatgpt:fetchImage", url, tabId },
          (resp) => {
            if (chrome.runtime.lastError) {
              finish({
                success: false,
                error: "SEND_FAILED",
                message: chrome.runtime.lastError.message,
              });
              return;
            }
            finish(resp || { success: false, error: "NO_RESPONSE" });
          },
        );
      } catch (err) {
        finish({ success: false, error: "EXCEPTION", message: err.message });
      }
    });
  }
  static async geminiSubmitAndWait({
    text,
    images,
    timeout,
    tabId,
    expect = "text",
    settings = {},
    runId = null,
    model = null,
    ratio = null,
    ratioPromptSuffix = "",
    newChat = true,
    workerAttempt = null,
  }) {
    if (!tabId) {
      return { success: false, error: "MISSING_TAB_ID" };
    }
    const imgArr = Array.isArray(images) ? images : [];
    const sourceWindowId = ["gen", "task"].includes(settings.source)
      ? ((await chrome.windows.getCurrent().catch(() => null))?.id ?? null)
      : null;
    const editorWaitMs =
      await window.ExecutionConfig.getProviderStartupTimeoutMs("gemini");
    const scrollDuringGen =
      expect === "text"
        ? settings.scrollDuringGen
        : (settings.scrollDuringGen ??
          window.SystemConfig?.getBool?.("gemini_scroll_during_gen"));
    const inputTimeoutMs =
      Number(settings.inputTimeoutMs) || (await this._getInputTimeout());
    const requestTimeoutMs =
      Number(timeout) ||
      Number(window.SystemConfig?.getTimeout?.("api_timeout_ms"));
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      return { success: false, error: "TIMEOUT_CONFIG_UNAVAILABLE" };
    }
    console.log(
      "[MessageBridge] geminiSubmitAndWait \u2192 tab",
      tabId,
      "expect:",
      expect,
      "text len:",
      (text || "").length,
      "images:",
      imgArr.length,
    );
    return new Promise((resolve) => {
      const stopHeartbeat = this._startProviderTabHeartbeat("gemini", tabId);
      console.info(
        "[MessageBridge] Gemini heartbeat started; dispatching submitAndWait",
        { tabId, expect },
      );
      const finish = (response) => {
        stopHeartbeat();
        resolve(response);
      };
      try {
        chrome.tabs.sendMessage(
          tabId,
          {
            action: "gemini:submitAndWait",
            text: text || "",
            images: imgArr,
            timeout: requestTimeoutMs,
            expect,
            settings: {
              ...settings,
              ...(["gen", "task"].includes(settings.source) && {
                sourceWindowId,
              }),
              editorWaitMs,
              scrollDuringGen: !!scrollDuringGen,
              inputTimeoutMs,
            },
            runId,
            model,
            ratio,
            ratioPromptSuffix,
            newChat,
            ...(workerAttempt && { workerAttempt }),
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              console.warn(
                "[MessageBridge] Gemini submitAndWait delivery failed",
                { tabId, message: chrome.runtime.lastError.message },
              );
              finish({
                success: false,
                error: "SEND_FAILED",
                message: chrome.runtime.lastError.message,
              });
              return;
            }
            console.info("[MessageBridge] Gemini submitAndWait response", {
              tabId,
              success: resp?.success,
              error: resp?.error,
              textLength: resp?.text?.length || 0,
            });
            finish(resp || { success: false, error: "NO_RESPONSE" });
          },
        );
      } catch (err) {
        finish({ success: false, error: "EXCEPTION", message: err.message });
      }
    });
  }
  static async geminiFetchMedia(
    url,
    tabId,
    maxBytes,
    { mediaType = null, fingerprint = null } = {},
  ) {
    if (maxBytes == null) {
      if (!url || !Number.isInteger(tabId))
        return { success: false, error: "INVALID_FETCH_ARGUMENTS" };
      const timeoutMs =
        mediaType === null
          ? null
          : Number(
              ["image", "video"].includes(mediaType)
                ? window.ProviderConfigManager?.getApiConfigValueSync?.(
                    "gemini",
                    "generation_monitor",
                  )?.[mediaType]?.absolute_max_wait_ms
                : null,
            );
      if (
        mediaType !== null &&
        (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      )
        return { success: false, error: "MONITOR_CONFIG_INVALID" };
      const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
      const token = crypto.randomUUID();
      const read = (stage, offset = 0) =>
        new Promise((resolve) => {
          const remaining =
            deadline === null ? null : Math.max(0, deadline - Date.now());
          if (remaining === 0 && stage !== "close")
            return resolve({ success: false, error: "MEDIA_FETCH_TIMEOUT" });
          let timer;
          const finish = (value) => {
            if (timer !== void 0) clearTimeout(timer);
            resolve(value);
          };
          if (remaining !== null && remaining > 0)
            timer = setTimeout(
              () => finish({ success: false, error: "MEDIA_FETCH_TIMEOUT" }),
              remaining,
            );
          try {
            chrome.tabs.sendMessage(
              tabId,
              {
                action: "gemini:fetchMedia",
                url,
                chunk: {
                  stage,
                  token,
                  offset,
                  ...(remaining !== null && { timeoutMs: remaining }),
                  ...(mediaType === "image" &&
                    typeof fingerprint === "string" &&
                    fingerprint && { mediaType, fingerprint }),
                },
              },
              (response) => {
                finish(
                  chrome.runtime.lastError
                    ? { success: false, error: "SEND_FAILED" }
                    : response || { success: false, error: "NO_RESPONSE" },
                );
              },
            );
          } catch (_) {
            finish({ success: false, error: "SEND_FAILED" });
          }
          if (remaining === 0) finish({ success: true });
        });
      try {
        const opened = await read("open");
        if (!opened?.success) return opened;
        if (
          !Number.isSafeInteger(opened.size) ||
          opened.size <= 0 ||
          !Number.isSafeInteger(opened.chunkBytes) ||
          opened.chunkBytes <= 0 ||
          !/^(image|video)\/[a-z0-9.+-]+$/i.test(opened.mime || "")
        )
          throw new Error("MEDIA_CHUNK_METADATA_INVALID");
        const parts = [];
        let offset = 0;
        while (offset < opened.size) {
          const part = await read("read", offset);
          if (!part?.success) return part;
          const nextOffset = Math.min(offset + opened.chunkBytes, opened.size);
          if (
            part.offset !== offset ||
            part.nextOffset !== nextOffset ||
            part.size !== opened.size ||
            part.mime !== opened.mime ||
            part.done !== (nextOffset === opened.size) ||
            typeof part.dataUrl !== "string" ||
            !/^data:(image|video)\/[a-z0-9.+-]+;base64,/i.test(part.dataUrl) ||
            part.dataUrl.length > Math.ceil(opened.chunkBytes / 3) * 4 + 128
          )
            throw new Error("MEDIA_CHUNK_INVALID");
          const blob2 = await (await fetch(part.dataUrl)).blob();
          if (blob2.size !== nextOffset - offset || blob2.type !== opened.mime)
            throw new Error("MEDIA_CHUNK_SIZE_MISMATCH");
          parts.push(blob2);
          offset = nextOffset;
        }
        if (deadline !== null && Date.now() >= deadline)
          throw new Error("MEDIA_FETCH_TIMEOUT");
        const blob = new Blob(parts, { type: opened.mime });
        if (blob.size !== opened.size)
          throw new Error("MEDIA_CHUNK_SIZE_MISMATCH");
        return {
          success: true,
          blob,
          size: blob.size,
          mime: blob.type,
          mimeType: blob.type,
        };
      } catch (error) {
        return {
          success: false,
          error: error?.message || "MEDIA_FETCH_FAILED",
        };
      } finally {
        await read("close").catch(() => {});
      }
    }
    if (!url || !tabId || !Number.isFinite(Number(maxBytes)))
      return { success: false, error: "INVALID_FETCH_ARGUMENTS" };
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { action: "gemini:fetchMedia", url, maxBytes: Number(maxBytes) },
        (response) => {
          if (chrome.runtime.lastError) {
            resolve({
              success: false,
              error: "SEND_FAILED",
              message: chrome.runtime.lastError.message,
            });
            return;
          }
          resolve(response || { success: false, error: "NO_RESPONSE" });
        },
      );
    });
  }
  static async geminiBridgeToFlow({
    url,
    tabId,
    fileName = "gemini-result.png",
    maxBytes,
    prefetchedDataUrl = null,
    onMaterialized = null,
  } = {}) {
    try {
      let dataUrl =
        typeof prefetchedDataUrl === "string" &&
        prefetchedDataUrl.startsWith("data:")
          ? prefetchedDataUrl
          : null;
      let fetched = null;
      if (!dataUrl) {
        fetched = await this.geminiFetchMedia(url, tabId, maxBytes);
        if (!fetched?.success || !fetched.base64) {
          return { success: false, error: fetched?.error || "FETCH_FAILED" };
        }
        dataUrl = fetched.base64;
      }
      let match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match || !match[1].startsWith("image/"))
        return { success: false, error: "INVALID_IMAGE_DATA" };
      if (onMaterialized) {
        try {
          await onMaterialized(dataUrl);
        } catch (error) {
          console.warn(
            "[Gemini Bridge] local result save failed:",
            error?.message || error,
          );
        }
      }
      const payload = [{ name: fileName, type: match[1], base64: match[2] }];
      const uploadPromise = this.uploadFilesToFlow(payload, {
        surface: "workflow",
      });
      payload[0].base64 = "";
      if (fetched) fetched.base64 = "";
      prefetchedDataUrl = null;
      dataUrl = null;
      match = null;
      const uploaded = await uploadPromise;
      const detail = Array.isArray(uploaded?.tileDetails)
        ? uploaded.tileDetails[0]
        : null;
      const tileId = detail?.id || detail?.tile_id || detail?.tileId;
      if (!tileId)
        return { success: false, error: uploaded?.error || "UPLOAD_FAILED" };
      return {
        success: true,
        tileId,
        fileName: detail.file_name || "",
        thumbnailUrl: detail.thumbnailUrl || detail.thumbnail_url || "",
      };
    } catch (error) {
      return {
        success: false,
        error: "BRIDGE_ERROR",
        message: error?.message || String(error),
      };
    }
  }
  static async geminiDownloadImageNative({
    tabId,
    fingerprint,
    filename,
    removeWatermark = false,
  } = {}) {
    if (!tabId || !fingerprint || !filename)
      return { success: false, error: "INVALID_DOWNLOAD_ARGUMENTS" };
    const monitor = window.ProviderConfigManager?.getApiConfigValueSync?.(
      "gemini",
      "generation_monitor",
    )?.image;
    const completionTimeoutMs = Number(monitor?.absolute_max_wait_ms);
    if (!Number.isSafeInteger(completionTimeoutMs) || completionTimeoutMs <= 0)
      return {
        success: false,
        error: "NATIVE_DOWNLOAD_COMPLETION_CONFIG_MISSING",
      };
    const scrollDuringGen =
      window.SystemConfig?.getBool?.("gemini_scroll_during_gen") === true;
    if (scrollDuringGen && !(Number(monitor?.poll_interval_ms) > 0))
      return { success: false, error: "MONITOR_CONFIG_INVALID" };
    const slash = filename.lastIndexOf("/");
    const folder = slash >= 0 ? filename.slice(0, slash) : "";
    const baseName = slash >= 0 ? filename.slice(slash + 1) : filename;
    const requestId = `gemini-image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const armed = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "prepareDownloadRename",
          folder,
          filename: baseName,
          identifier: fingerprint,
          sourceProvider: "gemini",
          tabId,
          removeWatermark: removeWatermark === true,
          requestId,
        },
        (response) => resolve(response || { ok: false }),
      );
    });
    if (!armed?.ok)
      return { success: false, error: "DOWNLOAD_RENAME_PREPARE_FAILED" };
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        {
          action: "gemini:downloadImageNative",
          fingerprint,
          settings: {
            scrollDuringGen,
            scrollSettleMs: Number(monitor?.poll_interval_ms),
          },
        },
        (response) => {
          if (chrome.runtime.lastError) {
            const message = chrome.runtime.lastError.message;
            chrome.runtime.sendMessage(
              {
                action: "cancelDownloadRename",
                sourceProvider: "gemini",
                identifier: fingerprint,
                tabId,
              },
              () => resolve({ success: false, error: "SEND_FAILED", message }),
            );
            return;
          }
          const result = response || { success: false, error: "NO_RESPONSE" };
          if (!result.success) {
            chrome.runtime.sendMessage(
              {
                action: "cancelDownloadRename",
                sourceProvider: "gemini",
                identifier: fingerprint,
                tabId,
              },
              () => resolve(result),
            );
            return;
          }
          console.info(
            "[MessageBridge] gemini_native_download_wait",
            JSON.stringify({ requestId, completionTimeoutMs }),
          );
          chrome.runtime.sendMessage(
            {
              action: "awaitPreparedDownload",
              requestId,
              sourceProvider: "gemini",
              timeoutMs: completionTimeoutMs,
            },
            (completed) => {
              resolve(
                completed?.success
                  ? { ...result, ...completed }
                  : completed || {
                      success: false,
                      error: "DOWNLOAD_NOT_CONFIRMED",
                    },
              );
            },
          );
        },
      );
    });
  }
  static async geminiDownloadVideoNative({
    tabId,
    fingerprint,
    filename,
    removeWatermark = false,
  } = {}) {
    if (!tabId || !fingerprint || !filename)
      return { success: false, error: "INVALID_DOWNLOAD_ARGUMENTS" };
    if (removeWatermark === true)
      return {
        success: false,
        error: "CLEAN_VIDEO_REQUIRES_MATERIALIZED_DOWNLOAD",
      };
    const slash = filename.lastIndexOf("/");
    const folder = slash >= 0 ? filename.slice(0, slash) : "";
    const baseName = slash >= 0 ? filename.slice(slash + 1) : filename;
    const requestId = `gemini-video-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const armed = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          action: "prepareDownloadRename",
          folder,
          filename: baseName,
          identifier: fingerprint,
          sourceProvider: "gemini",
          tabId,
          removeWatermark: false,
          requestId,
        },
        (response) => resolve(response || { ok: false }),
      );
    });
    if (!armed?.ok)
      return { success: false, error: "DOWNLOAD_RENAME_PREPARE_FAILED" };
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { action: "gemini:downloadVideoNative", fingerprint },
        (response) => {
          if (chrome.runtime.lastError) {
            const message = chrome.runtime.lastError.message;
            chrome.runtime.sendMessage(
              {
                action: "cancelDownloadRename",
                sourceProvider: "gemini",
                identifier: fingerprint,
                tabId,
              },
              () => resolve({ success: false, error: "SEND_FAILED", message }),
            );
            return;
          }
          const result = response || { success: false, error: "NO_RESPONSE" };
          if (!result.success) {
            chrome.runtime.sendMessage(
              {
                action: "cancelDownloadRename",
                sourceProvider: "gemini",
                identifier: fingerprint,
                tabId,
              },
              () => resolve(result),
            );
            return;
          }
          chrome.runtime.sendMessage(
            {
              action: "awaitPreparedDownload",
              requestId,
              timeoutMs: 10 * 60 * 1e3,
            },
            (completed) => {
              resolve(
                completed?.success
                  ? { ...result, ...completed }
                  : completed || {
                      success: false,
                      error: "DOWNLOAD_NOT_CONFIRMED",
                    },
              );
            },
          );
        },
      );
    });
  }
  static async chatGPTBridgeToFlow(
    url,
    tabId,
    fileName = "chatgpt-result.png",
    onStage = null,
    onMaterialized = null,
  ) {
    try {
      onStage?.("fetching");
    } catch (_) {}
    const fetchResult = await this.chatGPTFetchImage(url, tabId);
    if (!fetchResult?.success) {
      return { success: false, error: fetchResult?.error || "FETCH_FAILED" };
    }
    let matches = (fetchResult.base64 || "").match(/^data:(.+?);base64,(.+)$/);
    if (!matches) {
      return { success: false, error: "INVALID_BASE64" };
    }
    const mime = matches[1] || fetchResult.mime || "image/png";
    let base64Body = matches[2];
    if (onMaterialized) {
      try {
        await onMaterialized(fetchResult.base64);
      } catch (error) {
        console.warn(
          "[ChatGPT Bridge] local result save failed:",
          error?.message || error,
        );
      }
    }
    try {
      try {
        onStage?.("uploading");
      } catch (_) {}
      const payload = [{ name: fileName, type: mime, base64: base64Body }];
      const uploadPromise = this.uploadFilesToFlow(payload, {
        surface: "workflow",
      });
      payload[0].base64 = "";
      fetchResult.base64 = "";
      base64Body = null;
      matches = null;
      const uploadResult = await uploadPromise;
      if (!uploadResult || uploadResult.success === false) {
        return {
          success: false,
          error: uploadResult?.error || "UPLOAD_FAILED",
        };
      }
      return {
        success: true,
        tileDetails: uploadResult.tileDetails || uploadResult,
      };
    } catch (err) {
      return {
        success: false,
        error: "UPLOAD_EXCEPTION",
        message: err.message,
      };
    }
  }
  static async grokSubmitAndWait({
    text,
    images,
    settings,
    timeout,
    tabId,
    taskName,
    inputTimeoutMs,
    requestId,
    recover = false,
    prefetchMedia = true,
  }) {
    if (!tabId) {
      return { success: false, error: "MISSING_TAB_ID" };
    }
    console.log(
      "[MessageBridge] grokSubmitAndWait \u2192 tab",
      tabId,
      "text len:",
      (text || "").length,
      "images:",
      (images || []).length,
    );
    return new Promise((resolve) => {
      const stopHeartbeat = this._startProviderTabHeartbeat("grok", tabId);
      const finish = (response) => {
        stopHeartbeat();
        resolve(response);
      };
      try {
        chrome.runtime.sendMessage(
          {
            action: "grok:submitAndWait",
            tabId,
            payload: {
              text: text || "",
              images: images || [],
              settings: settings || {},
              timeout:
                timeout ||
                window.SystemConfig?.getTimeout("image_timeout_ms") ||
                18e4,
              taskName: taskName || null,
              inputTimeoutMs,
              requestId,
              recover,
              prefetchMedia,
            },
          },
          (resp) => {
            if (chrome.runtime.lastError) {
              finish({
                success: false,
                error: "BRIDGE_ERROR",
                message: chrome.runtime.lastError.message,
              });
              return;
            }
            finish(resp || { success: false, error: "NO_RESPONSE" });
          },
        );
      } catch (err) {
        finish({ success: false, error: "EXCEPTION", message: err.message });
      }
    });
  }
  static async revealHiddenWorkflowProvider(provider, tabId, stage = "input") {
    if (
      !["chatgpt", "muse", "gemini"].includes(provider) ||
      !Number.isInteger(tabId)
    )
      return { success: false, error: "LEGACY_REVEAL_OWNER_INVALID" };
    try {
      return await chrome.runtime.sendMessage({
        action: "provider:revealLegacyForWorkflow",
        provider,
        tabId,
        stage,
      });
    } catch (error) {
      return {
        success: false,
        error: error?.message || "LEGACY_REVEAL_CHANNEL_FAILED",
      };
    }
  }
  static async revealHiddenSidebarProvider(provider, tabId, stage = "input") {
    if (
      !["chatgpt", "muse", "gemini"].includes(provider) ||
      !Number.isInteger(tabId)
    )
      return { success: false, error: "LEGACY_REVEAL_OWNER_INVALID" };
    try {
      const sourceWindowId = (
        await chrome.windows.getCurrent().catch(() => null)
      )?.id;
      return await chrome.runtime.sendMessage({
        action: "provider:revealLegacyForSidebar",
        provider,
        tabId,
        stage,
        sourceWindowId,
      });
    } catch (error) {
      return {
        success: false,
        error: error?.message || "LEGACY_REVEAL_CHANNEL_FAILED",
      };
    }
  }
  static async museSubmitAndWait({
    text,
    mode = "image",
    images = [],
    timeout,
    editorWaitMs,
    tabId,
    taskName,
    autoDownload = false,
    source = null,
    workerAttempt = null,
  }) {
    if (!tabId) return { success: false, error: "MISSING_TAB_ID" };
    const sourceWindowId = ["gen", "task"].includes(source)
      ? ((await chrome.windows.getCurrent().catch(() => null))?.id ?? null)
      : null;
    return new Promise((resolve) => {
      const stopHeartbeat = this._startProviderTabHeartbeat("muse", tabId);
      chrome.runtime.sendMessage(
        {
          action: "muse:submitAndWait",
          tabId,
          payload: {
            text,
            mode,
            images,
            timeout,
            editorWaitMs,
            taskName,
            autoDownload,
            ...(source === "workflow" && { source: "workflow" }),
            ...(["gen", "task"].includes(source) && { source, sourceWindowId }),
            ...(workerAttempt && { workerAttempt }),
          },
        },
        (response) => {
          stopHeartbeat();
          const result = chrome.runtime.lastError
            ? {
                success: false,
                error: "BRIDGE_ERROR",
                message: chrome.runtime.lastError.message,
              }
            : response || { success: false, error: "NO_RESPONSE" };
          resolve({ ...result, tabId });
        },
      );
    });
  }
  static async museVideoBridgeToFlow({
    url,
    tabId,
    sourceBlob = null,
    fileName = "muse-result.mp4",
    onFetched = null,
  } = {}) {
    const hasBlob = typeof Blob !== "undefined" && sourceBlob instanceof Blob;
    if (!hasBlob && (!url || !Number.isInteger(tabId)))
      return { success: false, error: "INVALID_MUSE_VIDEO_BRIDGE_ARGUMENTS" };
    await window.ProviderConfigManager?.fetchPrivateConfigs?.();
    const bridgeConfig = window.ProviderConfigManager?.getApiConfigValueSync?.(
      "muse",
      "video_flow_bridge",
    );
    const maxBytes = Number(bridgeConfig?.max_bytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return { success: false, error: "MUSE_VIDEO_FLOW_BRIDGE_CONFIG_MISSING" };
    }
    let fetched = null;
    let dataUrl = null;
    let base64 = null;
    try {
      if (hasBlob) {
        if (
          !sourceBlob.type.startsWith("video/") ||
          sourceBlob.size <= 0 ||
          sourceBlob.size > maxBytes
        )
          return { success: false, error: "MUSE_VIDEO_TOO_LARGE_OR_INVALID" };
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("MUSE_VIDEO_READ_FAILED"));
          reader.readAsDataURL(sourceBlob);
        });
        fetched = { success: true, dataUrl: encoded };
      } else
        fetched = await new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(
              { action: "muse:fetchVideoForFlow", tabId, url, maxBytes },
              (response) => {
                resolve(
                  chrome.runtime.lastError
                    ? {
                        success: false,
                        error: "MUSE_VIDEO_FETCH_SEND_FAILED",
                        message: chrome.runtime.lastError.message,
                      }
                    : response || {
                        success: false,
                        error: "MUSE_VIDEO_FETCH_NO_RESPONSE",
                      },
                );
              },
            );
          } catch (error) {
            resolve({
              success: false,
              error: "MUSE_VIDEO_FETCH_SEND_FAILED",
              message: error?.message || String(error),
            });
          }
        });
      if (!fetched?.success || typeof fetched.dataUrl !== "string") {
        return {
          success: false,
          error: fetched?.error || "MUSE_VIDEO_FETCH_FAILED",
          message: fetched?.message,
        };
      }
      dataUrl = fetched.dataUrl;
      const match = /^data:(video\/[a-z0-9.+-]+);base64,([\s\S]+)$/i.exec(
        dataUrl,
      );
      if (!match) return { success: false, error: "MUSE_VIDEO_DATA_INVALID" };
      const mime = match[1].toLowerCase();
      base64 = match[2];
      if (Math.floor((base64.length * 3) / 4) > maxBytes) {
        return { success: false, error: "MUSE_VIDEO_TOO_LARGE" };
      }
      if (typeof onFetched === "function") {
        try {
          await onFetched(
            hasBlob ? sourceBlob : await (await fetch(dataUrl)).blob(),
          );
        } catch (error) {
          console.warn(
            "[MuseVideoFlowBridge] local copy failed:",
            error?.message || error,
          );
        }
      }
      const ext =
        mime === "video/quicktime"
          ? "mov"
          : mime === "video/webm"
            ? "webm"
            : "mp4";
      const safeName = /\.(?:mp4|mov|webm)$/i.test(fileName)
        ? fileName
        : `${fileName}.${ext}`;
      const payload = [
        {
          name: safeName,
          type: mime,
          base64,
          bridge_source: "muse_video_flow",
        },
      ];
      const uploadPromise = this.uploadFilesToFlow(payload, {
        surface: "workflow",
      });
      payload[0].base64 = "";
      fetched.dataUrl = "";
      dataUrl = null;
      base64 = null;
      const uploaded = await uploadPromise;
      const detail = Array.isArray(uploaded?.tileDetails)
        ? uploaded.tileDetails[0]
        : null;
      if (!detail?.id)
        return {
          success: false,
          error: uploaded?.error || "MUSE_VIDEO_FLOW_UPLOAD_FAILED",
        };
      let playback = null;
      try {
        playback = await this.resolveVideoPlaybackUrl(detail.id, {
          fileName: detail.file_name || detail.id,
          persistentMediaId: detail.persistent_media_id || detail.id,
          sourceUrl:
            detail.thumbnailUrl ||
            detail.thumbnail_url ||
            detail.thumbnail ||
            "",
          surface: "workflow",
          allowUuidVirtualScan: true,
        });
      } catch (error) {
        console.warn(
          "[MuseVideoFlowBridge] Flow playback hydration failed",
          String(error?.message || error).slice(0, 200),
        );
      }
      return {
        success: true,
        tileId: detail.id,
        fileName: detail.file_name || "",
        thumbnailUrl:
          playback?.thumbnail ||
          detail.thumbnailUrl ||
          detail.thumbnail_url ||
          detail.thumbnail ||
          "",
        videoUrl: playback?.video_url || detail.video_url || "",
        media_uuid: detail.media_uuid || detail.id,
        persistent_media_id:
          playback?.persistent_media_id ||
          detail.persistent_media_id ||
          detail.id,
        identity_kind:
          detail.identity_kind ||
          (playback?.persistent_media_id ? "flow-media-id" : null),
        identity_durability:
          detail.identity_durability ||
          (playback?.persistent_media_id ? "durable-resolver" : null),
        api_driver: detail.api_driver || null,
        project_id: detail.project_id || null,
      };
    } catch (error) {
      return {
        success: false,
        error: "MUSE_VIDEO_BRIDGE_ERROR",
        message: error?.message || String(error),
      };
    } finally {
      if (fetched && typeof fetched === "object") fetched.dataUrl = "";
      dataUrl = null;
      base64 = null;
    }
  }
  static async museDownloadImageResult({
    tabId,
    url,
    base64,
    filename,
    waitForComplete = false,
  }) {
    if (typeof base64 === "string" && base64.startsWith("data:image/")) {
      try {
        return await window.DownloadHelper.downloadImageAsJpeg({
          dataUrl: base64,
          filename,
          waitForComplete,
        });
      } catch (error) {
        console.warn(
          "[MuseDownload] JPEG preparation failed; using native image menu:",
          error?.message || "unknown",
        );
      }
    }
    return this.museDownloadNative(tabId, filename, url, 6e5, "image");
  }
  static async museDownloadNative(
    tabId,
    filename,
    mediaUrl,
    waitTimeoutMs = 6e5,
    mediaType = "video",
  ) {
    if (!Number.isInteger(tabId) || !filename || !mediaUrl) {
      return { success: false, error: "INVALID_MUSE_DOWNLOAD_ARGUMENTS" };
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            action:
              mediaType === "image"
                ? "muse:downloadImage"
                : "muse:downloadVideo",
            tabId,
            filename,
            url: mediaUrl,
            waitTimeoutMs,
          },
          (response) =>
            resolve(
              chrome.runtime.lastError
                ? { success: false, error: chrome.runtime.lastError.message }
                : response || { success: false, error: "NO_RESPONSE" },
            ),
        );
      } catch (error) {
        resolve({
          success: false,
          error: error?.message || "MUSE_DOWNLOAD_SEND_FAILED",
        });
      }
    });
  }
  static async museCaptureVideoPoster(tabId, mediaUrl) {
    if (!Number.isInteger(tabId) || !mediaUrl) {
      return { success: false, error: "INVALID_MUSE_POSTER_ARGUMENTS" };
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: "muse:captureVideoPoster", tabId, url: mediaUrl },
          (response) =>
            resolve(
              chrome.runtime.lastError
                ? { success: false, error: chrome.runtime.lastError.message }
                : response || { success: false, error: "NO_RESPONSE" },
            ),
        );
      } catch (error) {
        resolve({
          success: false,
          error: error?.message || "MUSE_POSTER_CAPTURE_SEND_FAILED",
        });
      }
    });
  }
  static async museCreateRuntimeVideoUrl(tabId, mediaUrl) {
    if (!Number.isInteger(tabId) || !mediaUrl) {
      return { success: false, error: "INVALID_MUSE_RUNTIME_VIDEO_ARGUMENTS" };
    }
    await window.ProviderConfigManager?.fetchPrivateConfigs?.();
    const bridgeConfig = window.ProviderConfigManager?.getApiConfigValueSync?.(
      "muse",
      "video_flow_bridge",
    );
    const maxBytes = Number(bridgeConfig?.max_bytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      return { success: false, error: "MUSE_VIDEO_FLOW_BRIDGE_CONFIG_MISSING" };
    }
    const fetched = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: "muse:fetchVideoForFlow", tabId, url: mediaUrl, maxBytes },
          (response) => {
            resolve(
              chrome.runtime.lastError
                ? {
                    success: false,
                    error: "MUSE_VIDEO_FETCH_SEND_FAILED",
                    message: chrome.runtime.lastError.message,
                  }
                : response || {
                    success: false,
                    error: "MUSE_VIDEO_FETCH_NO_RESPONSE",
                  },
            );
          },
        );
      } catch (error) {
        resolve({
          success: false,
          error: "MUSE_VIDEO_FETCH_SEND_FAILED",
          message: error?.message || String(error),
        });
      }
    });
    if (!fetched?.success || typeof fetched.dataUrl !== "string") {
      return {
        success: false,
        error: fetched?.error || "MUSE_VIDEO_FETCH_FAILED",
        message: fetched?.message,
      };
    }
    try {
      const blob = await (await fetch(fetched.dataUrl)).blob();
      if (
        !/^video\//i.test(blob.type || "") ||
        blob.size <= 0 ||
        blob.size > maxBytes
      ) {
        return { success: false, error: "MUSE_VIDEO_RUNTIME_MEDIA_INVALID" };
      }
      return {
        success: true,
        videoUrl: URL.createObjectURL(blob),
        size: blob.size,
      };
    } catch (error) {
      return {
        success: false,
        error: "MUSE_VIDEO_RUNTIME_URL_FAILED",
        message: error?.message || String(error),
      };
    } finally {
      if (fetched && typeof fetched === "object") fetched.dataUrl = "";
    }
  }
  static async musePlayNative(tabId, mediaUrl) {
    if (!Number.isInteger(tabId) || !mediaUrl) {
      return { success: false, error: "INVALID_MUSE_PLAY_ARGUMENTS" };
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: "muse:playVideo", tabId, url: mediaUrl },
          (response) =>
            resolve(
              chrome.runtime.lastError
                ? { success: false, error: chrome.runtime.lastError.message }
                : response || { success: false, error: "NO_RESPONSE" },
            ),
        );
      } catch (error) {
        resolve({
          success: false,
          error: error?.message || "MUSE_PLAY_SEND_FAILED",
        });
      }
    });
  }
  static async grokDownloadNative(
    tabId,
    filename,
    mediaUrl,
    mediaType = "image",
  ) {
    if (!tabId || !filename || !mediaUrl)
      return { success: false, error: "INVALID_DOWNLOAD_ARGUMENTS" };
    const monitor = window.ProviderConfigManager?.getApiConfigValueSync?.(
      "grok",
      "native_download",
    );
    const creationTimeoutMs = Number(monitor?.creation_timeout_ms);
    const timeoutMs = Number(
      mediaType === "video"
        ? monitor?.video_timeout_ms
        : monitor?.image_timeout_ms,
    );
    if (
      !Number.isFinite(creationTimeoutMs) ||
      creationTimeoutMs <= 0 ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      return {
        success: false,
        error: "NATIVE_DOWNLOAD_CONFIRM_CONFIG_MISSING",
      };
    }
    const slash = filename.lastIndexOf("/");
    const folder = slash >= 0 ? filename.slice(0, slash) : "";
    const baseName = slash >= 0 ? filename.slice(slash + 1) : filename;
    const requestId = `grok-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const mediaIdPattern = "[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}";
    const identifier =
      mediaUrl.match(new RegExp(`/generated/(${mediaIdPattern})`, "i"))?.[1] ||
      mediaUrl.match(new RegExp(`/images/(${mediaIdPattern})`, "i"))?.[1] ||
      [...mediaUrl.matchAll(new RegExp(mediaIdPattern, "gi"))].at(-1)?.[0] ||
      "";
    const sendBackground = (payload) =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage(payload, (response) =>
          resolve(
            chrome.runtime.lastError
              ? { success: false, error: chrome.runtime.lastError.message }
              : response || { success: false, error: "NO_RESPONSE" },
          ),
        );
      });
    const armed = await sendBackground({
      action: "prepareDownloadRename",
      sourceProvider: "grok",
      requestId,
      folder,
      filename: baseName,
      identifier,
      tabId,
    });
    if (!armed?.ok)
      return {
        success: false,
        error: armed?.error || "DOWNLOAD_RENAME_PREPARE_FAILED",
      };
    const cancelReservation = () =>
      sendBackground({ action: "cancelDownloadRename", requestId });
    const clicked = await new Promise((resolve) => {
      chrome.tabs.sendMessage(
        tabId,
        { action: "grok:downloadNative", expectedMediaUrl: mediaUrl },
        (response) =>
          resolve(
            chrome.runtime.lastError
              ? {
                  success: false,
                  error: "SEND_FAILED",
                  message: chrome.runtime.lastError.message,
                }
              : response || { success: false, error: "NO_RESPONSE" },
          ),
      );
    });
    if (!clicked?.success) {
      await cancelReservation();
      return clicked;
    }
    const completed = await sendBackground({
      action: "awaitPreparedDownload",
      requestId,
      timeoutMs,
      creationTimeoutMs,
    });
    if (!completed?.success) await cancelReservation();
    return completed?.success
      ? { ...clicked, ...completed, method: "native_button" }
      : {
          success: false,
          error: completed?.error || "DOWNLOAD_NOT_CONFIRMED",
          clicked: true,
        };
  }
  static async grokAbort(tabId, options = {}) {
    return this._abortProvider(tabId, "grok", options);
  }
  static async chatgptAbort(tabId, options = {}) {
    return this._abortProvider(tabId, "chatgpt", options);
  }
  static async geminiAbort(tabId, options = {}) {
    return this._abortProvider(tabId, "gemini", options);
  }
  static _abortProvider(tabId, provider, { requestedAt = Date.now() } = {}) {
    if (!tabId)
      return Promise.resolve({
        success: false,
        abortReceived: false,
        error: "MISSING_TAB_ID",
      });
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          resolve({
            success: false,
            abortReceived: false,
            error: "ABORT_ACK_TIMEOUT",
          }),
        5e3,
      );
      const finish = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      try {
        chrome.tabs.sendMessage(
          tabId,
          { action: `${provider}:abort`, requestedAt },
          (response) => {
            const error = chrome.runtime.lastError;
            finish(
              error
                ? { success: false, abortReceived: false, error: error.message }
                : response || {
                    success: false,
                    abortReceived: false,
                    error: "ABORT_NO_ACK",
                  },
            );
          },
        );
      } catch (error) {
        finish({ success: false, abortReceived: false, error: error.message });
      }
    });
  }
  static async grokFetchImage(url, tabId) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: "grok:fetchImage", url, tabId },
          (resp) => {
            if (chrome.runtime.lastError) {
              resolve({
                success: false,
                error: "SEND_FAILED",
                message: chrome.runtime.lastError.message,
              });
              return;
            }
            resolve(resp || { success: false, error: "NO_RESPONSE" });
          },
        );
      } catch (err) {
        resolve({ success: false, error: "EXCEPTION", message: err.message });
      }
    });
  }
  static async grokMaterializeMedia(url, tabId, prefetchedBase64 = null) {
    if (prefetchedBase64)
      return { success: true, base64: prefetchedBase64, tier: 1 };
    const result = await this.grokFetchImage(url, tabId).catch(() => null);
    if (result?.success && result.base64) return { ...result, tier: 2 };
    const queried = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { action: "queryProviderTabs", provider: "grok" },
          resolve,
        );
      } catch (_) {
        resolve(null);
      }
    });
    const currentTab = queried?.tabs?.[0]?.id;
    if (Number.isInteger(currentTab) && currentTab !== tabId) {
      const refreshed = await this.grokFetchImage(url, currentTab).catch(
        () => null,
      );
      if (refreshed?.success && refreshed.base64)
        return { ...refreshed, tier: 2 };
    }
    return {
      success: false,
      error: result?.error || "GROK_MEDIA_BYTES_UNAVAILABLE",
    };
  }
  static async grokDownloadMedia(
    url,
    tabId,
    filename,
    prefetchedBase64 = null,
    { nativeFirst = false } = {},
  ) {
    const dataMime = /^data:image\/(jpeg|png|webp);base64,/i
      .exec(prefetchedBase64 || "")?.[1]
      ?.toLowerCase();
    const urlImageExt = /\.(jpe?g|png|webp)(?:\?|$)/i
      .exec(url || "")?.[1]
      ?.toLowerCase();
    const imageExt =
      dataMime === "jpeg"
        ? "jpg"
        : dataMime || (urlImageExt === "jpeg" ? "jpg" : urlImageExt);
    const downloadFilename =
      imageExt && /\.(?:png|jpe?g|webp)$/i.test(filename)
        ? filename.replace(/\.(?:png|jpe?g|webp)$/i, `.${imageExt}`)
        : filename;
    if (nativeFirst && tabId) {
      const native = await this.grokDownloadNative(
        tabId,
        downloadFilename,
        url,
        /\.mp4$/i.test(downloadFilename) ? "video" : "image",
      ).catch((error) => ({
        success: false,
        error: error?.message || "NATIVE_DOWNLOAD_FAILED",
      }));
      if (native?.success)
        return {
          success: true,
          tier: 0,
          method: "native_button",
          downloadId: native.downloadId,
        };
      console.warn(
        "[MessageBridge] Grok native Download unavailable; using media URL:",
        native?.error || "unknown",
      );
    }
    const _chromeDl = (dlUrl) =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage(
            {
              action: "chromeDownload",
              url: dlUrl,
              filename: downloadFilename,
              waitForComplete: true,
              waitTimeoutMs: /\.mp4$/i.test(downloadFilename) ? 6e5 : 12e4,
            },
            (r) => resolve(r || { success: false, error: "NO_RESPONSE" }),
          );
        } catch (e) {
          resolve({ success: false, error: e.message });
        }
      });
    const materialized = await this.grokMaterializeMedia(
      url,
      tabId,
      prefetchedBase64,
    );
    const base64 = materialized?.base64;
    let fetchErr = materialized?.error;
    if (base64) {
      try {
        const blob = await (await fetch(base64)).blob();
        const blobUrl = URL.createObjectURL(blob);
        const dl2 = await _chromeDl(blobUrl);
        setTimeout(() => {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch (_) {}
        }, 6e4);
        if (dl2?.success)
          return { success: true, tier: prefetchedBase64 ? 1 : 2 };
        fetchErr = dl2?.error || "CHROME_DL_FAILED";
      } catch (e) {
        fetchErr = e.message;
      }
    }
    const dl = await _chromeDl(url);
    return {
      success: !!dl?.success,
      tier: 3,
      error: dl?.success ? void 0 : dl?.error || fetchErr,
    };
  }
  static async grokBridgeToFlow(
    url,
    tabId,
    fileName = "grok-result.png",
    onStage = null,
    onMaterialized = null,
  ) {
    try {
      try {
        onStage?.("fetching");
      } catch (_) {}
      const fetchResp = await this.grokFetchImage(url, tabId);
      if (!fetchResp?.success || !fetchResp.base64) {
        return { success: false, error: fetchResp?.error || "FETCH_FAILED" };
      }
      let base64Match = (fetchResp.base64 || "").match(
        /^data:([^;]+);base64,(.+)$/,
      );
      if (!base64Match) {
        return { success: false, error: "INVALID_DATA_URL" };
      }
      const mime = base64Match[1];
      let base64Data = base64Match[2];
      if (onMaterialized) {
        try {
          await onMaterialized(fetchResp.base64);
        } catch (error) {
          console.warn(
            "[Grok Bridge] local result save failed:",
            error?.message || error,
          );
        }
      }
      const ext = mime.includes("video") ? "mp4" : mime.split("/")[1] || "png";
      const finalName = fileName.includes(".")
        ? fileName
        : `${fileName}.${ext}`;
      try {
        onStage?.("uploading");
      } catch (_) {}
      const payload = [{ name: finalName, type: mime, base64: base64Data }];
      const uploadPromise = this.uploadFilesToFlow(payload, {
        surface: "workflow",
      });
      payload[0].base64 = "";
      fetchResp.base64 = "";
      base64Data = null;
      base64Match = null;
      const uploadResp = await uploadPromise;
      const tileDetails = uploadResp?.tileDetails?.[0];
      if (!tileDetails?.id) {
        return { success: false, error: "UPLOAD_FAILED" };
      }
      return {
        success: true,
        tileId: tileDetails.id,
        fileName: tileDetails.file_name || "",
        thumbnailUrl: tileDetails.thumbnailUrl || "",
        media_uuid: tileDetails.media_uuid || null,
        api_driver: tileDetails.api_driver || null,
        project_id: tileDetails.project_id || null,
      };
    } catch (err) {
      return { success: false, error: "BRIDGE_ERROR", message: err?.message };
    }
  }
};
__publicField(_MessageBridge, "_flowTabsAdvisoryState", new WeakMap());
__publicField(
  _MessageBridge,
  "_boundedFlowReads",
  new Set([
    "checkContentScriptAlive",
    "getEditor",
    "getFlowReloadPendingCount",
    "getFlowDriverContext",
    "getCurrentTileIds",
    "scanNewTiles",
    "getTileStatuses",
    "getFlowErrorState",
    "getPendingTileCount",
    "detectTileStatus",
    "getRunningState",
    "getThumbnailsByIds",
    "checkTilesExist",
    "checkFilesExist",
    "lookupFlowMediaCatalog",
    "flowUuidGatewayRead",
    "scanFlowImages",
    "extractTileIdentifiers",
    "resolveVideoPlaybackUrl",
    "waitForNewTiles",
    "ensureFlowTilesLoaded",
  ]),
);
__publicField(
  _MessageBridge,
  "_boundedFlowControls",
  new Set([
    "autoReloadFlow",
    "resetStop",
    "stopExecution",
    "cancelFlowScanRequest",
    "cancelFlowScans",
    "pq:showBlocker",
    "pq:hideBlocker",
    "beginFlowZoomSession",
    "endFlowZoomSession",
  ]),
);
__publicField(_MessageBridge, "_cachedInputTimeout", null);
__publicField(_MessageBridge, "_flowPerfSequence", 0);
__publicField(_MessageBridge, "_flowReadTraceFailures", new Set());
__publicField(
  _MessageBridge,
  "_flowPerfActions",
  new Set([
    "flowUuidGatewayRead",
    "scanFlowImages",
    "extractTileIdentifiers",
    "resolveVideoPlaybackUrl",
    "prepareFlowForGen",
    "pq:removeExistingRefImages",
    "applySettings",
    "selectFlowVoice",
    "selectFlowCharacter",
    "pq:addRefImages",
    "pq:verifyRefAttachments",
    "clearEditor",
    "insertText",
    "pq:verifySlateModel",
    "stabilizeFlowResultViewport",
    "pq:getPreTileSnapshot",
    "clickSubmit",
    "flowCorrelationArm",
    "flowCorrelationSnapshot",
    "countInlineChips",
  ]),
);
__publicField(_MessageBridge, "_uploadFlowQueue", Promise.resolve());
__publicField(_MessageBridge, "_uploadControls", new Set());
__publicField(_MessageBridge, "_uploadControlPanel", null);
__publicField(_MessageBridge, "_executionTargets", new Map());
__publicField(
  _MessageBridge,
  "_executionTargetsStorageKey",
  "flowExecutionTargets",
);
__publicField(
  _MessageBridge,
  "_executionTargetsStorageQueue",
  Promise.resolve(),
);
__publicField(_MessageBridge, "_currentExecutionId", null);
__publicField(_MessageBridge, "_executionTargetTtlMs", 30 * 60 * 1e3);
__publicField(_MessageBridge, "_FLOW_HEARTBEAT_INTERVAL_MS", 8e3);
__publicField(_MessageBridge, "_apiUploadResults", new Map());
let MessageBridge = _MessageBridge;
window.MessageBridge = MessageBridge;
