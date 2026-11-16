class MotionTemplateTab {
  constructor() {
    this.container = document.getElementById("tab-motion-templates");
    this.active = "motion";
    this.requests = new Map();
    document
      .getElementById("motionTemplatesSubtab")
      ?.addEventListener("click", () => {
        void this.open();
      });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (
        this.websitePreviewsReady &&
        area === "session" &&
        changes.tobyflow_pending_motion_template?.newValue
      )
        void this.consumeWebsitePreview();
    });
  }
  startWebsitePreviews() {
    this.websitePreviewsReady = true;
    void this.consumeWebsitePreview();
  }
  async consumeWebsitePreview() {
    if (this.consumingWebsitePreview) {
      this.websitePreviewChanged = true;
      return;
    }
    this.consumingWebsitePreview = true;
    try {
      const key = "tobyflow_pending_motion_template";
      const pending = (await chrome.storage.session.get(key))[key];
      if (!pending) return;
      const current = await chrome.windows.getCurrent();
      if (current.id !== pending.windowId) return;
      await chrome.storage.session.remove(key);
      if (
        !Number.isSafeInteger(pending.templateId) ||
        pending.templateId <= 0 ||
        !Number.isFinite(pending.timestamp) ||
        Date.now() - pending.timestamp > 3e4
      )
        return;
      if (this.library?.applying) throw new Error("MOTION_TEMPLATE_BUSY");
      this.library?.closePreview();
      document.querySelector('[data-tab="tab-studio"]')?.click();
      await this.open();
      await this.library.preview({ id: pending.templateId });
    } catch (error) {
      console.warn(
        "[MotionTemplates] Website preview failed:",
        error?.code || error?.message,
      );
      window.showNotification?.(this.text("launchFailed"), "error");
    } finally {
      this.consumingWebsitePreview = false;
      if (this.websitePreviewChanged) {
        this.websitePreviewChanged = false;
        void this.consumeWebsitePreview();
      }
    }
  }
  text(key, values) {
    return window.I18n.t(`motionTemplates.${key}`, values);
  }
  select(name) {
    this.active = name;
    for (const [key, button, pane] of [
      ["motion", "motionStudioSubtab", "tab-motion"],
      ["templates", "motionTemplatesSubtab", "tab-motion-templates"],
    ]) {
      const selected = name === key,
        control = document.getElementById(button),
        content = document.getElementById(pane);
      control.classList.toggle("active", selected);
      control.setAttribute("aria-selected", String(selected));
      if (selected) control.setAttribute("aria-current", "page");
      else control.removeAttribute("aria-current");
      content.classList.toggle("active", selected);
      content.classList.toggle("hidden", !selected);
    }
    if (name !== "templates") this.library?.stopPreviews();
  }
  async openActive() {
    if (this.active === "templates") await this.open();
    else await window.motionStudioList?.openTab();
  }
  async open() {
    this.select("templates");
    if (this.openFlight) return this.openFlight;
    if (this.library?.dialog?.open) {
      this.library.reset();
      return;
    }
    this.library = new MotionTemplateLibrary({
      container: this.container,
      api: MotionTemplateLibrary.publicApi,
      text: (key, values) => this.text(key, values),
      onApply: (entry) => this.use(entry),
    });
    this.openFlight = this.library.open();
    try {
      await this.openFlight;
    } finally {
      this.openFlight = null;
    }
  }
  async use(template) {
    if (this.using) return false;
    this.using = true;
    let lock = null,
      timer = null;
    const controller = new AbortController();
    try {
      const studio = window.motionStudioList;
      if ((await studio.gateForAction()) !== true) {
        await studio.showAccessModal();
        return false;
      }
      const scope = await studio._creationProjectContext();
      if (!scope) return false;
      const assertCurrent = () => {
        if (
          !window.authManager.isLoggedIn() ||
          Number(window.authManager.getUser()?.id) !== scope.accountId
        )
          throw new Error("ACCOUNT_SCOPE_CHANGED");
      };
      const key = `${scope.accountId}:${scope.flowProjectId}:${template.id}:${template.revision}`;
      if (!this.requests.has(key)) this.requests.set(key, crypto.randomUUID());
      lock = MotionTemplateLibrary.lock(this.text("creating"));
      const notice = (name, values) => {
        const message = this.text(name, values);
        lock.update(message);
        window.showNotification?.(message, "info");
      };
      const project = await window.authManager._apiCall(
        "POST",
        `tools/motion-studio/templates/${template.id}/use`,
        {
          flow_project_id: scope.flowProjectId,
          revision: template.revision,
          request_id: this.requests.get(key),
        },
      );
      assertCurrent();
      if (
        !project?.tool_project_id ||
        project.flow_project_id !== scope.flowProjectId
      )
        throw new Error("PROJECT_SCOPE_MISMATCH");
      if (Number(project.data_json?.source_revision || 0) === 0) {
        const timeout = Number(
          window.SystemConfig?.safeGetTimeout?.("api_timeout_ms"),
        );
        if (!Number.isFinite(timeout) || timeout <= 0)
          throw new Error("CONFIG_REQUIRED:api_timeout_ms");
        timer = setTimeout(() => controller.abort(), timeout);
        let last = -1;
        const file = await MotionTemplateLibrary.download(template, {
          signal: controller.signal,
          assertCurrent,
          progress: (percent) => {
            if (percent !== last) {
              last = percent;
              notice("downloading", { percent });
            }
          },
        });
        clearTimeout(timer);
        timer = null;
        assertCurrent();
        notice("downloaded");
        await MotionArtifactStore.saveSourceDraft({
          userId: scope.accountId,
          toolProjectId: project.tool_project_id,
          flowProjectId: scope.flowProjectId,
          blob: file,
          fileName: file.name,
          baseSourceRevision: 0,
        });
      }
      assertCurrent();
      notice("opening");
      const context = await window.ProjectHelper.getOpenProjectContext();
      if (context?.projectId !== scope.flowProjectId)
        throw new Error("PROJECT_SCOPE_MISMATCH");
      const ready = await window.ProjectHelper.waitForProjectReady(
        scope.flowProjectId,
        {
          tabId: context.tabId,
          shouldContinue: () =>
            window.authManager.isLoggedIn() &&
            Number(window.authManager.getUser()?.id) === scope.accountId,
          readinessScope: "editor",
        },
      );
      assertCurrent();
      if (!ready) throw new Error("FLOW_PROJECT_NOT_READY");
      const result = await chrome.runtime.sendMessage({
        action: "openMotionStudioEditor",
        toolProjectId: project.tool_project_id,
        newlyCreated: true,
      });
      if (result?.ok !== true)
        throw new Error(result?.error || "MOTION_EDITOR_OPEN_FAILED");
      this.requests.delete(key);
      window.showNotification?.(this.text("opened"), "success");
      return true;
    } catch (error) {
      if (error?.code === "MOTION_PROJECT_QUOTA_EXCEEDED") {
        lock?.close();
        lock = null;
        await this.showProjectLimit(error.serverData);
        return false;
      }
      if (error?.code === "MOTION_ENTITLEMENT_DENIED") {
        lock?.close();
        lock = null;
        await window.featureGate.showModuleBlockedDialog("motion_tool_enabled");
        return false;
      }
      const message =
        error?.code === "MOTION_TEMPLATE_CHANGED"
          ? this.text("changed")
          : this.text("launchFailed");
      window.showNotification?.(message, "error");
      return false;
    } finally {
      clearTimeout(timer);
      lock?.close();
      this.using = false;
    }
  }
  async showProjectLimit(data = {}) {
    const used = Number(data?.used),
      limit = Number(data?.limit);
    const usage =
      data?.used != null &&
      data?.limit != null &&
      Number.isSafeInteger(used) &&
      used >= 0 &&
      Number.isSafeInteger(limit) &&
      limit >= 0
        ? this.text("quotaUsage", { used, limit })
        : "";
    const upgrade = await window.customDialog.confirm(
      [this.text("quotaReached"), usage].filter(Boolean).join("\n\n"),
      {
        title: this.text("quotaTitle"),
        type: "warning",
        confirmText: window.I18n.t("common.upgrade"),
        cancelText: window.I18n.t("common.close"),
      },
    );
    if (upgrade) {
      if (typeof window.openUpgradeModal === "function")
        window.openUpgradeModal();
      else await chrome.runtime.sendMessage({ action: "showUpgradeModal" });
    }
  }
}
window.MotionTemplateTab = MotionTemplateTab;
