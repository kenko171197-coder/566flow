(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const headerVersion = $("motionHeaderVersion");
  if (headerVersion) {
    const extensionVersion =
      globalThis.chrome?.runtime?.getManifest?.()?.version;
    headerVersion.textContent = extensionVersion ? `v${extensionVersion}` : "";
  }
  const helperTimers = new Map();
  const helperObserver = new MutationObserver((records) => {
    for (const element of new Set(
      records.map((record) =>
        record.target.nodeType === Node.ELEMENT_NODE
          ? record.target.closest(".helper-text")
          : record.target.parentElement?.closest(".helper-text"),
      ),
    )) {
      if (!element) continue;
      clearTimeout(helperTimers.get(element));
      helperTimers.delete(element);
      if (!element.textContent.trim()) continue;
      const message = element.textContent;
      helperTimers.set(
        element,
        setTimeout(() => {
          helperTimers.delete(element);
          if (element.textContent === message) {
            element.textContent = "";
            element.classList.remove("is-saved");
          }
        }, 5e3),
      );
    }
  });
  document.querySelectorAll(".helper-text").forEach((element) =>
    helperObserver.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    }),
  );
  const motionLoadingKeys = new Set([
    "regeneratingAudio",
    "text003",
    "text015",
    "text023",
    "text048",
    "text053",
    "text056",
    "text079",
    "text081",
    "text082",
    "text083",
    "text088",
    "text089",
    "text092",
    "text114",
    "text124",
    "text130",
    "text131",
    "text139",
    "text155",
    "text168",
    "text178",
    "text183",
    "text198",
    "text202",
    "text204",
    "text206",
    "text208",
    "text209",
    "text212",
    "text213",
    "text215",
    "text224",
    "text232",
    "text238",
  ]);
  const motionText = (key, fallback) => {
    const value = window.I18n?.t?.(`motionEditor.${key}`) ?? fallback;
    return motionLoadingKeys.has(key) &&
      typeof value === "string" &&
      value !== `motionEditor.${key}`
      ? value.replace(/[.…]+$/, "") + "..."
      : value;
  };
  const motionFormat = (key, fallback, values) =>
    motionText(key, fallback).replace(/\{(\d+)\}/g, (_match, index) =>
      String(values[Number(index)] ?? ""),
    );
  const referenceIcon =
    '<svg class="ref-btn-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 8h.01"></path><path d="M12.5 21h-6.5a3 3 0 0 1 -3 -3v-12a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v6.5"></path><path d="M3 16l5 -5c.928 -.893 2.072 -.893 3 0l3.5 3.5"></path><path d="M14 14l1 -1c.679 -.653 1.473 -.829 2.214 -.526"></path><path d="M19 22v-6"></path><path d="M22 19l-3 -3l-3 3"></path></svg>';
  const projectId = new URL(location.href).searchParams.get("project");
  let newProjectSpeedOffer =
    new URL(location.href).searchParams.get("new") === "1";
  const endpoint = `tools/motion-studio/projects/${encodeURIComponent(projectId || "")}`;
  let project = null;
  let userId = null;
  let profile = null;
  let worker = null;
  let runId = null;
  let busy = false;
  let resettingAllFlowResults = false;
  let finalDownloadPending = false;
  let cancelled = false;
  let scopeInvalid = false;
  let profileDirty = false;
  let settingsReady = false;
  let configBootFailed = false;
  let settingsSaveTimer = null;
  let settingsDirty = false;
  let voiceDescriptionDirty = false;
  let externalProjectDirty = false;
  let externalProjectRefreshTimer = null;
  let externalProjectRefreshFlight = null;
  let externalProjectRefreshStopped = false;
  let headerSaving = false;
  let resetConfirmationOpen = false;
  let savedHintTimer = null;
  let referenceStatusTimer = null;
  let agentStatusEpoch = 0;
  let agentHealth = null;
  let agentHealthTimer = null;
  let agentHealthDebounce = null;
  let agentHealthInFlight = null;
  let agentHealthPending = false;
  let agentConnection = null;
  let flowProjectCheckEpoch = 0;
  let flowProjectCheckTimer = null;
  let flowProjectMonitor = null;
  let cancelSplit = null;
  let previewUrl = null;
  let resolutions = [];
  let ratios = [];
  let i18nReady = false;
  let canMerge = false;
  let mergeConfirmationOpen = false;
  let finalArtifact = null;
  let stageSourceUrl = null;
  let stageSourceKey = null;
  let stageResultUrl = null;
  let stageResultKey = null;
  let frameDialogUrl = null;
  let frameDialogSourceUrl = null;
  let frameDialogAudioUrl = null;
  let selectedFrameId = null;
  let activeResultEditFrameId = null;
  let selectedFrameKind = "source_clip";
  let generatedFrameIds = new Set();
  let generatedPreviewRevisions = new Map();
  let sourceUploadReceipts = new Map();
  let sourceBlobFrameIds = new Set();
  let activeAudioFrameId = null;
  let audioFrameIds = new Set();
  let frameMediaEpoch = 0;
  let frameCompareOffset = 0;
  let frameSourceBounds = null;
  let voicePicker = null;
  let references = { mode: "character_only", character: [], background: [] };
  const referencePreviewCache = new Map();
  const referenceScanAttempts = new Set();
  let referenceScanController = null;
  let pendingSourceFile = null;
  const sourcePlaybackRates = new WeakMap();
  let pendingBulkDraftKey = null;
  let flowRuntimeReady = false;
  let motionRunning = false;
  let externalMotionRun = null;
  const externalFrameProviderStates = new Map();
  let externalMotionStatusTicket = 0;
  let externalMotionNoticesReady = false;
  let lastExternalMotionFailure = null;
  let lastExternalMotionStatusSignature = null;
  let lastExternalDownloadNotice = null;
  let motionQueueJobId = null;
  let localMotionProviderPause = null;
  let motionQueuePauseRequested = false;
  let motionPauseTransition = null;
  let deferredUploadPause = false;
  let pausedStandaloneTask = null;
  let activeMotionFrameId = null;
  let activeMotionStage = null;
  let activeContinuityPhase = null;
  let motionGenerateIcon = null;
  let activeUploadFrameId = null;
  let activeUploadStartedAt = 0;
  let activeFlowStartedAt = 0;
  let activeFlowRetryLabel = "";
  let openManualRunConfirmation = null;
  let openSubRunConfirmation = null;
  let openBatchSubConfirmation = null;
  let batchSubFrameIds = new Set();
  let openUploadConfirmation = null;
  let openBatchUploadConfirmation = null;
  let activeFrameMenu = null;
  let activityStartedAt = null;
  const externalUploadFrames = new Set();
  let externalUploadToolbarRun = null;
  let externalUploadToolbar = null;
  let externalUploadCompleted = 0,
    externalUploadTotal = 0;
  let activityTimer = null;
  let stopMotionQueueStatus = null;
  let toastTimer = null;
  let languageChoices = null;
  let confirmStatusTimer = null;
  let timelineRenderEpoch = 0;
  let timelineStructureKey = null;
  let flowHeaderHealth = null;
  let flowHeaderHealthAt = 0;
  let flowHeaderHealthFlight = null;
  let flowHeaderTimer = null;
  const timelineThumbUrls = new Set();
  let audioWaveJobs = Promise.resolve();
  function renderProjectFlowMode(
    settings = window.storageSettings?.getSettings?.(),
  ) {
    const button = $("projectFlowMode");
    if (!button) return;
    const pinned = project?.data_json?.flow_run_mode;
    const mode = settings
      ? window.SystemConfig?.get?.("flow_api_driver", null) !== "disabled" &&
        window.featureGate?.canUse?.("flow_api_enabled") === true &&
        [true, "true", 1].includes(settings.apiModeEnabled) &&
        !["ui", "web"].includes(settings.defaultGenMode || settings.gen_mode)
        ? "api"
        : "web"
      : ["api", "web"].includes(pinned)
        ? pinned
        : null;
    button.classList.toggle("is-on", mode === "api");
    const dot = button.querySelector(".motion-flow-dot");
    dot?.classList.toggle(
      "is-ready",
      mode === "api" && flowHeaderHealth?.ready === true,
    );
    const configuredDriver = window.SystemConfig?.get?.(
      "flow_api_driver",
      null,
    );
    const driver = ["v1", "v2"].includes(flowHeaderHealth?.driver)
      ? flowHeaderHealth.driver
      : ["v1", "v2"].includes(configuredDriver)
        ? configuredDriver
        : null;
    const version = button.querySelector(".motion-flow-version");
    if (version) {
      version.hidden = !driver;
      version.textContent = driver ? driver.toUpperCase() : "";
      version.dataset.driver = driver || "";
    }
    button.setAttribute(
      "aria-label",
      mode === "api"
        ? "Flow Max Speed \u0111\xE3 ch\u1ECDn \xB7 M\u1EDF c\xE0i \u0111\u1EB7t Flow"
        : mode === "web"
          ? "Flow Web \u0111\xE3 ch\u1ECDn \xB7 M\u1EDF c\xE0i \u0111\u1EB7t Flow"
          : "M\u1EDF c\xE0i \u0111\u1EB7t Flow mode",
    );
    button.title =
      pinned && pinned !== mode
        ? `Flow mode trong c\xE0i \u0111\u1EB7t \xB7 Project \u0111ang gi\u1EEF ${pinned.toUpperCase()} cho l\u01B0\u1EE3t ch\u1EA1y`
        : "Flow mode trong c\xE0i \u0111\u1EB7t \xB7 M\u1EDF c\xE0i \u0111\u1EB7t Flow";
    if (
      mode === "api" &&
      project?.flow_project_id &&
      !flowHeaderHealthFlight &&
      Date.now() - flowHeaderHealthAt > 5e3 &&
      window.FlowApiSessionCoordinator?.check
    ) {
      const expectedProject = project?.flow_project_id;
      flowHeaderHealthAt = Date.now();
      flowHeaderHealthFlight = window.FlowApiSessionCoordinator.check({
        projectId: expectedProject,
        surface: "gen",
        mediaType: "image",
        passive: true,
      })
        .then((result) => {
          if (scopeInvalid || project?.flow_project_id !== expectedProject)
            return;
          flowHeaderHealth = result;
        })
        .catch(() => {
          flowHeaderHealth = null;
        })
        .finally(() => {
          flowHeaderHealthFlight = null;
          if (!scopeInvalid) renderProjectFlowMode();
        });
    }
  }
  function initRatioPicker() {
    const select = $("motionRatio");
    const wrapper = document.createElement("div");
    wrapper.className = "motion-ratio-picker";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "motion-ratio-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-label", "Ch\u1ECDn t\u1EC9 l\u1EC7 video");
    const list = document.createElement("div");
    list.className = "motion-ratio-options";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    select.before(wrapper);
    wrapper.append(trigger, list);
    select.hidden = true;
    const icon = (value) => {
      const [w, h] = String(value).split(":").map(Number);
      const width =
        w && h ? Math.max(7, Math.round((16 * w) / Math.max(w, h))) : 16;
      const height =
        w && h ? Math.max(7, Math.round((16 * h) / Math.max(w, h))) : 10;
      const mark = document.createElement("span");
      mark.className = "motion-ratio-option-icon";
      mark.style.width = `${width}px`;
      mark.style.height = `${height}px`;
      mark.setAttribute("aria-hidden", "true");
      return mark;
    };
    const render = () => {
      trigger.replaceChildren(
        icon(select.value),
        document.createTextNode(
          select.selectedOptions[0]?.textContent || "\u2014",
        ),
      );
      const arrow = document.createElement("span");
      arrow.className = "motion-select-arrow";
      arrow.setAttribute("aria-hidden", "true");
      trigger.append(arrow);
      trigger.disabled = select.disabled;
      list.replaceChildren();
      for (const option of select.options) {
        if (!option.value) continue;
        const row = document.createElement("button");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute(
          "aria-selected",
          String(option.value === select.value),
        );
        row.append(
          icon(option.value),
          document.createTextNode(option.textContent),
        );
        row.addEventListener("click", () => {
          select.value = option.value;
          list.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
          select.dispatchEvent(new Event("change", { bubbles: true }));
          trigger.focus();
        });
        list.append(row);
      }
    };
    trigger.addEventListener("click", () => {
      if (select.disabled) return;
      list.hidden = !list.hidden;
      trigger.setAttribute("aria-expanded", String(!list.hidden));
    });
    wrapper.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (list.hidden) {
        list.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      }
      const options = [...list.querySelectorAll("button")];
      if (!options.length) return;
      const current = options.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : current < 0
              ? event.key === "ArrowDown"
                ? 0
                : options.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length;
      options[next].focus();
    });
    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    });
    select.addEventListener("change", render);
    window.motionRatioPickerRender = render;
    render();
  }
  function initMotionPromptResizers() {
    for (const id of ["voiceDescription", "motionCustomPrompt"]) {
      const textarea = $(id);
      if (!textarea || $(id + "Resizer")) continue;
      const min = 53,
        max = 600;
      const handle = document.createElement("div");
      handle.id = id + "Resizer";
      handle.className = "gen-prompt-resizer motion-prompt-resizer";
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "horizontal");
      handle.setAttribute(
        "aria-label",
        motionText("resizePrompt", "Resize prompt"),
      );
      handle.setAttribute("aria-controls", id);
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(max));
      const height = () => textarea.getBoundingClientRect().height || min;
      handle.setAttribute("aria-valuenow", String(Math.round(height())));
      const resize = (value) => {
        const next = Math.round(Math.max(min, Math.min(max, value)));
        textarea.style.height = next + "px";
        handle.setAttribute("aria-valuenow", String(next));
      };
      let drag = null;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || textarea.disabled || textarea.readOnly)
          return;
        event.preventDefault();
        event.stopPropagation();
        drag = { id: event.pointerId, y: event.clientY, height: height() };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener("pointermove", (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (!textarea.disabled && !textarea.readOnly)
          resize(drag.height + event.clientY - drag.y);
      });
      const end = (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        drag = null;
        if (handle.hasPointerCapture(event.pointerId))
          handle.releasePointerCapture(event.pointerId);
      };
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
      handle.addEventListener("lostpointercapture", () => {
        drag = null;
      });
      handle.addEventListener("keydown", (event) => {
        if (
          textarea.disabled ||
          textarea.readOnly ||
          !["ArrowUp", "ArrowDown"].includes(event.key)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        resize(height() + (event.key === "ArrowDown" ? 20 : -20));
      });
      (textarea.closest(".motion-prompt-input-wrap") || textarea).after(handle);
    }
  }
  async function ensureMotionAgentReady(provider, options) {
    const session =
      provider === "chatgpt"
        ? window.ChatGPTSession
        : provider === "gemini"
          ? window.GeminiSession
          : null;
    if (typeof session?.ensureReady !== "function") return null;
    const waitForEditorMs =
      await window.ExecutionConfig.getProviderStartupTimeoutMs(provider);
    return session.ensureReady({
      ...options,
      waitForEditorMs,
      ...(provider === "gemini" && { requireEditor: true }),
    });
  }
  function initReferenceModePicker() {
    const select = $("referenceMode");
    const wrapper = document.createElement("div");
    wrapper.className = "motion-ratio-picker motion-reference-mode-picker";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.id = "referenceModeTrigger";
    trigger.className = "motion-ratio-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute(
      "aria-label",
      motionText("text017", "\u1EA2nh tham chi\u1EBFu"),
    );
    const list = document.createElement("div");
    list.className = "motion-ratio-options";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    select.before(wrapper);
    wrapper.append(trigger, list);
    select.hidden = true;
    const icon = (value) => {
      const mark = document.createElement("span");
      mark.className = "motion-reference-mode-icon";
      mark.dataset.mode = value;
      mark.setAttribute("aria-hidden", "true");
      return mark;
    };
    const render = () => {
      trigger.replaceChildren(
        icon(select.value),
        document.createTextNode(
          select.selectedOptions[0]?.textContent || "\u2014",
        ),
      );
      const arrow = document.createElement("span");
      arrow.className = "motion-select-arrow";
      arrow.setAttribute("aria-hidden", "true");
      trigger.append(arrow);
      trigger.disabled = select.disabled;
      if (select.disabled) {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
      list.replaceChildren();
      for (const option of select.options) {
        if (!option.value) continue;
        const row = document.createElement("button");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute(
          "aria-selected",
          String(option.value === select.value),
        );
        row.append(
          icon(option.value),
          document.createTextNode(option.textContent),
        );
        row.addEventListener("click", () => {
          select.value = option.value;
          list.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
          select.dispatchEvent(new Event("change", { bubbles: true }));
          trigger.focus();
        });
        list.append(row);
      }
    };
    trigger.addEventListener("click", () => {
      if (select.disabled) return;
      list.hidden = !list.hidden;
      trigger.setAttribute("aria-expanded", String(!list.hidden));
    });
    wrapper.addEventListener("keydown", (event) => {
      if (select.disabled) return;
      if (event.key === "Escape") {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (list.hidden) {
        list.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      }
      const options = [...list.querySelectorAll("button")];
      if (!options.length) return;
      const current = options.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : current < 0
              ? event.key === "ArrowDown"
                ? 0
                : options.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length;
      options[next].focus();
    });
    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    });
    select.addEventListener("change", render);
    window.motionReferenceModePickerRender = render;
    render();
  }
  function initCharacterCountPicker() {
    const select = $("characterCount");
    const wrapper = document.createElement("div");
    wrapper.className = "motion-ratio-picker";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.id = "characterCountTrigger";
    trigger.className = "motion-ratio-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute(
      "aria-label",
      window.I18n?.t?.("motionEditor.characterCount") || "",
    );
    const list = document.createElement("div");
    list.className = "motion-ratio-options";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    select.before(wrapper);
    wrapper.append(trigger, list);
    select.hidden = true;
    const icon = () =>
      $("characterCountGroup")
        .querySelector(".ratio-field-label svg")
        .cloneNode(true);
    const render = () => {
      trigger.replaceChildren(
        icon(select.value),
        document.createTextNode(
          select.selectedOptions[0]?.textContent || "\u2014",
        ),
      );
      const arrow = document.createElement("span");
      arrow.className = "motion-select-arrow";
      arrow.setAttribute("aria-hidden", "true");
      trigger.append(arrow);
      trigger.disabled = select.disabled;
      if (select.disabled || $("characterCountGroup").hidden) {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
      list.replaceChildren();
      for (const option of select.options) {
        if (!option.value) continue;
        const row = document.createElement("button");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute(
          "aria-selected",
          String(option.value === select.value),
        );
        row.disabled = option.disabled;
        row.append(
          icon(option.value),
          document.createTextNode(option.textContent),
        );
        row.addEventListener("click", () => {
          if (select.disabled || option.disabled) return;
          select.value = option.value;
          list.hidden = true;
          trigger.setAttribute("aria-expanded", "false");
          select.dispatchEvent(new Event("change", { bubbles: true }));
          trigger.focus();
        });
        list.append(row);
      }
    };
    trigger.addEventListener("click", () => {
      if (select.disabled) return;
      list.hidden = !list.hidden;
      trigger.setAttribute("aria-expanded", String(!list.hidden));
    });
    wrapper.addEventListener("keydown", (event) => {
      if (select.disabled) return;
      if (event.key === "Escape") {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        trigger.focus();
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      if (list.hidden) {
        list.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      }
      const options = [...list.querySelectorAll("button:not(:disabled)")];
      if (!options.length) return;
      const current = options.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : current < 0
              ? event.key === "ArrowDown"
                ? 0
                : options.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                options.length;
      options[next].focus();
    });
    document.addEventListener("click", (event) => {
      if (!wrapper.contains(event.target)) {
        list.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }
    });
    select.addEventListener("change", render);
    window.motionCharacterCountPickerRender = render;
    render();
  }
  function initRunConfirmation() {
    let checkId = 0;
    let flowActivation = null;
    let flowRepairAttempted = false;
    let requestedFrameId = null;
    let requestedAction = "generate";
    let checkFlight = null;
    let initialCheck = true;
    let confirming = false;
    const start = document.createElement("button");
    start.id = "motionRunBtn";
    start.type = "button";
    start.className = "wide-button";
    start.innerHTML =
      '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M11.8525 4.21651L11.7221 3.2387C11.6906 3.00226 11.4889 2.82568 11.2504 2.82568C11.0118 2.82568 10.8102 3.00226 10.7786 3.23869L10.6483 4.21651C10.2658 7.0847 8.00939 9.34115 5.14119 9.72358L4.16338 9.85396C3.92694 9.88549 3.75037 10.0872 3.75037 10.3257C3.75037 10.5642 3.92694 10.7659 4.16338 10.7974L5.14119 10.9278C8.00938 11.3102 10.2658 13.5667 10.6483 16.4349L10.7786 17.4127C10.8102 17.6491 11.0118 17.8257 11.2504 17.8257C11.4889 17.8257 11.6906 17.6491 11.7221 17.4127L11.8525 16.4349C12.2349 13.5667 14.4913 11.3102 17.3595 10.9278L18.3374 10.7974C18.5738 10.7659 18.7504 10.5642 18.7504 10.3257C18.7504 10.0872 18.5738 9.88549 18.3374 9.85396L17.3595 9.72358C14.4913 9.34115 12.2349 7.0847 11.8525 4.21651Z"></path><path d="M4.6519 14.7568L4.82063 14.2084C4.84491 14.1295 4.91781 14.0757 5.00037 14.0757C5.08292 14.0757 5.15582 14.1295 5.1801 14.2084L5.34883 14.7568C5.56525 15.4602 6.11587 16.0108 6.81925 16.2272L7.36762 16.3959C7.44652 16.4202 7.50037 16.4931 7.50037 16.5757C7.50037 16.6582 7.44652 16.7311 7.36762 16.7554L6.81926 16.9241C6.11587 17.1406 5.56525 17.6912 5.34883 18.3946L5.1801 18.9429C5.15582 19.0218 5.08292 19.0757 5.00037 19.0757C4.91781 19.0757 4.84491 19.0218 4.82063 18.9429L4.65191 18.3946C4.43548 17.6912 3.88486 17.1406 3.18147 16.9241L2.63311 16.7554C2.55421 16.7311 2.50037 16.6582 2.50037 16.5757C2.50037 16.4931 2.55421 16.4202 2.63311 16.3959L3.18148 16.2272C3.88486 16.0108 4.43548 15.4602 4.6519 14.7568Z"></path></svg><span>Generate</span>';
    motionGenerateIcon = start.querySelector("svg").cloneNode(true);
    $("pauseBtn").before(start);
    const forceStop = document.createElement("button");
    forceStop.id = "motionForceStopBtn";
    forceStop.type = "button";
    forceStop.className = "wide-button motion-force-stop";
    forceStop.hidden = true;
    forceStop.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg><span data-i18n="common.stop"></span>';
    forceStop.querySelector("span").textContent = window.I18n.t("common.stop");
    forceStop.addEventListener("click", cancelMotionTask);
    start.after(forceStop);
    const dialog = document.createElement("dialog");
    dialog.id = "motionRunDialog";
    dialog.className = "motion-confirm-run";
    dialog.innerHTML =
      '<div class="confirm-run-header"><strong class="confirm-run-title">Confirm Run</strong><button id="motionRunClose" class="icon-button" type="button" aria-label="\u0110\xF3ng"></button></div><div class="confirm-run-body"><div class="confirm-run-provider-status"><span class="confirm-provider-info"><span id="motionFlowLogo" class="confirm-provider-logo" aria-hidden="true"></span><span id="motionFlowLabel">Flow</span></span><span id="motionFlowStatus" class="confirm-run-provider-badge" role="status">\u0110ang ki\u1EC3m tra\u2026</span></div><div id="motionAgentRow" class="confirm-run-provider-status" hidden><span class="confirm-provider-info"><span id="motionAgentLogo" class="confirm-provider-logo" aria-hidden="true"></span><span id="motionAgentLabel"></span></span><span id="motionAgentStatus" class="confirm-run-provider-badge" role="status"></span></div><div id="motionRunReviewRow" class="setting-toggle" hidden><span><strong data-i18n="motionEditor.reviewSubtitle">Review sub</strong><small data-i18n="motionEditor.reviewSubtitleHint">D\u1EEBng tr\u01B0\u1EDBc khi t\u1EA1o video \u0111\u1EC3 ki\u1EC3m tra sub</small></span><input id="motionRunReviewSubtitle" type="checkbox" role="switch" aria-label="Review sub"></div><p id="motionRunWarning" class="confirm-run-warning" role="status"></p></div><div class="confirm-run-footer"><button id="motionRunCancel" class="confirm-run-cancel" type="button">H\u1EE7y</button><button id="motionRunConfirm" class="confirm-run-submit" type="button" disabled><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Generate</span></button></div>';
    document.body.append(dialog);
    $("motionRunCancel").dataset.i18n = "motionEditor.text006";
    $("motionFlowLogo").innerHTML =
      window.ProviderBrandIcons?.get?.("flow") || "";
    const hasSelectedFlowVoice = () =>
      requestedAction === "generate" &&
      project?.data_json?.preferences?.voice_enabled === true &&
      !!project?.data_json?.preferences?.voice_slug;
    let autoWebConfirmed = false;
    let autoWebReason = null;
    const selectedMode = () =>
      hasSelectedFlowVoice() ||
      (autoWebConfirmed &&
        (window.storageSettings?.getSettings?.()?.defaultGenMode ||
          window.storageSettings?.getSettings?.()?.gen_mode) === "auto")
        ? "web"
        : window.SystemConfig?.get?.("flow_api_driver", null) !== "disabled" &&
            window.featureGate?.canUse?.("flow_api_enabled") === true &&
            [true, "true", 1].includes(
              window.storageSettings?.getSettings?.()?.apiModeEnabled,
            ) &&
            !["ui", "web"].includes(
              window.storageSettings?.getSettings?.()?.defaultGenMode ||
                window.storageSettings?.getSettings?.()?.gen_mode,
            )
          ? "api"
          : "web";
    const paintStatus = (id, state, message) => {
      const badge = $(id);
      if (badge.dataset.state === state && badge.dataset.message === message)
        return;
      badge.dataset.state = state;
      badge.dataset.message = message;
      badge.replaceChildren();
      badge.classList.toggle("is-checking", state === "checking");
      badge.classList.toggle("is-ready", state === "ready");
      badge.classList.toggle("is-warning", state === "warning");
      if (state === "checking") {
        const spinner = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "svg",
        );
        spinner.setAttribute("viewBox", "0 0 24 24");
        spinner.setAttribute("fill", "none");
        spinner.setAttribute("stroke", "currentColor");
        spinner.setAttribute("stroke-width", "2");
        spinner.setAttribute("aria-hidden", "true");
        spinner.classList.add("motion-check-spinner");
        const circle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        circle.setAttribute("cx", "12");
        circle.setAttribute("cy", "12");
        circle.setAttribute("r", "10");
        const path = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "path",
        );
        path.setAttribute("d", "M12 6v6l4 2");
        spinner.append(circle, path);
        badge.append(spinner);
      }
      const text = document.createElement("span");
      text.textContent = message;
      badge.append(text);
    };
    const performCheck = async () => {
      if (!dialog.open || scopeInvalid || busy) return;
      const currentCheck = ++checkId;
      let mode = selectedMode();
      $("motionFlowLabel").textContent =
        mode === "api" ? "Flow \xB7 API" : "Flow \xB7 Web";
      const agent =
        project?.data_json?.preferences?.transcription_provider ||
        profile?.settings?.transcription_provider;
      const prefs = project?.data_json?.preferences || {};
      const candidateFrames = Object.entries(
        project?.data_json?.frames || {},
      ).filter(
        ([id, frame]) =>
          (!requestedFrameId || id === requestedFrameId) &&
          (requestedAction !== "generate" ||
            requestedFrameId ||
            (frame.stages?.persist?.state !== "ready" &&
              frame.stages?.monitor?.state !== "ready")),
      );
      const needsAgent =
        (["transcribe", "transcribe_batch"].includes(requestedAction) &&
          candidateFrames.some(
            ([, frame]) => frame.stages?.split?.audio_state === "audio_present",
          )) ||
        (requestedAction === "generate" &&
          (prefs.voice_enabled === true || prefs.subtitle_enabled === true) &&
          (!!pendingSourceFile ||
            (!Object.keys(project?.data_json?.frames || {}).length &&
              !!stageSourceUrl) ||
            candidateFrames.some(
              ([, frame]) =>
                frame.stages?.split?.audio_state === "audio_present" &&
                (!frame.transcript ||
                  (prefs.translate_enabled === true &&
                    frame.transcript.has_speech === true &&
                    (frame.transcript.translation_stale === true ||
                      !frame.transcript.translated_text?.trim()))),
            )));
      if (initialCheck) {
        $("motionRunConfirm").disabled = true;
        paintStatus(
          "motionFlowStatus",
          "checking",
          motionText("text023", "\u0110ang ki\u1EC3m tra..."),
        );
      }
      $("motionAgentRow").hidden = !needsAgent;
      if (needsAgent) {
        $("motionAgentLabel").textContent =
          agent === "chatgpt"
            ? "ChatGPT"
            : agent === "gemini"
              ? "Gemini"
              : motionText("text022", "Agent l\u1EDDi tho\u1EA1i");
        $("motionAgentLogo").innerHTML =
          window.ProviderBrandIcons?.get?.(agent) || "";
        if (initialCheck)
          paintStatus(
            "motionAgentStatus",
            "checking",
            motionText("text023", "\u0110ang ki\u1EC3m tra..."),
          );
      }
      const showIntermediate = initialCheck;
      initialCheck = false;
      if (["transcribe", "transcribe_batch"].includes(requestedAction)) {
        if (!needsAgent) {
          $("motionRunWarning").textContent =
            requestedAction === "transcribe_batch"
              ? motionText(
                  "text253",
                  "Sub m\u1EDBi s\u1EBD thay l\u1EDDi tho\u1EA1i hi\u1EC7n c\xF3 c\u1EE7a c\xE1c frame sau khi x\u1EED l\xFD th\xE0nh c\xF4ng.",
                )
              : "";
          $("motionRunConfirm").disabled = confirming;
          clearInterval(confirmStatusTimer);
          confirmStatusTimer = null;
          return true;
        }
        const result = await ensureMotionAgentReady(agent, {
          createIfMissing: true,
          activate: showIntermediate,
          focusWindow: false,
          silent: true,
          forceCheck: true,
        }).catch((error) => ({ error: error.message }));
        if (
          !dialog.open ||
          currentCheck !== checkId ||
          !["transcribe", "transcribe_batch"].includes(requestedAction)
        )
          return false;
        const ready2 = result?.ready === true;
        paintStatus(
          "motionAgentStatus",
          ready2 ? "ready" : "warning",
          ready2
            ? motionText("text007", "S\u1EB5n s\xE0ng")
            : result?.error ||
                motionText("text145", "Ch\u01B0a c\u1EA5u h\xECnh"),
        );
        $("motionRunWarning").textContent = ready2
          ? requestedAction === "transcribe_batch"
            ? motionText(
                "text253",
                "Sub m\u1EDBi s\u1EBD thay l\u1EDDi tho\u1EA1i hi\u1EC7n c\xF3 c\u1EE7a c\xE1c frame sau khi x\u1EED l\xFD th\xE0nh c\xF4ng.",
              )
            : ""
          : motionText(
              "text143",
              "Ki\u1EC3m tra \u0111\u0103ng nh\u1EADp v\xE0 tr\u1EA1ng th\xE1i agent, sau \u0111\xF3 th\u1EED l\u1EA1i.",
            );
        $("motionRunConfirm").disabled = confirming || !ready2;
        if (ready2) {
          clearInterval(confirmStatusTimer);
          confirmStatusTimer = null;
        }
        return ready2;
      }
      const target = await getMotionFlowTarget().catch(() => null);
      const activation = await flowActivation?.catch(() => null);
      const sameProject =
        target?.projectId === project?.flow_project_id &&
        activation?.ok === true &&
        activation.projectId === project.flow_project_id &&
        activation.tabId === target.tabId;
      const repair = !flowRepairAttempted;
      flowRepairAttempted = true;
      const flow = sameProject
        ? await chrome.runtime
            .sendMessage({
              action: "checkFlowTabOpen",
              passive: !repair,
              readOnly: !repair,
              readinessScope: "project",
              targetTabId: target.tabId,
            })
            .catch(() => null)
        : null;
      if (!dialog.open || currentCheck !== checkId || selectedMode() !== mode)
        return false;
      const flowReady =
        flow?.ready === true && flow.projectId === project?.flow_project_id;
      if (!flowReady || mode !== "api" || showIntermediate) {
        paintStatus(
          "motionFlowStatus",
          flowReady ? (mode === "api" ? "checking" : "ready") : "warning",
          flowReady
            ? mode === "api"
              ? motionText("text023", "\u0110ang ki\u1EC3m tra...")
              : motionText("text007", "S\u1EB5n s\xE0ng")
            : flow?.error ||
                motionText("text146", "Ch\u01B0a s\u1EB5n s\xE0ng"),
        );
      }
      let agentReady = !needsAgent;
      $("motionAgentRow").hidden = !needsAgent;
      if (needsAgent && ["chatgpt", "gemini"].includes(agent)) {
        $("motionAgentLabel").textContent =
          agent === "chatgpt" ? "ChatGPT" : "Gemini";
        $("motionAgentLogo").innerHTML =
          window.ProviderBrandIcons?.get?.(agent) || "";
        const result = await ensureMotionAgentReady(agent, {
          createIfMissing: false,
          activate: repair,
          focusWindow: false,
          silent: true,
          forceCheck: true,
        }).catch((error) => ({ error: error.message }));
        if (!dialog.open || currentCheck !== checkId || selectedMode() !== mode)
          return false;
        agentReady = result?.ready === true;
        paintStatus(
          "motionAgentStatus",
          agentReady ? "ready" : "warning",
          agentReady
            ? motionText("text007", "S\u1EB5n s\xE0ng")
            : result?.error ||
                motionText("text146", "Ch\u01B0a s\u1EB5n s\xE0ng"),
        );
      } else if (needsAgent) {
        $("motionAgentLabel").textContent = motionText(
          "text022",
          "Agent l\u1EDDi tho\u1EA1i",
        );
        $("motionAgentLogo").replaceChildren();
        paintStatus(
          "motionAgentStatus",
          "warning",
          motionText("text145", "Ch\u01B0a c\u1EA5u h\xECnh"),
        );
      }
      const apiToggle = [true, "true", 1].includes(
        window.storageSettings?.getSettings?.()?.apiModeEnabled,
      );
      let apiReady =
        mode !== "api" ||
        (apiToggle &&
          window.FlowApiAdapter?.isApiModeIntended?.({
            executionMode: "api",
          }) === true);
      let apiError = null;
      let apiHealthReason = null;
      if (mode === "api" && apiReady) {
        const health = await window.FlowApiSessionCoordinator?.check?.({
          surface: requestedAction === "generate" ? "gen" : "workflow",
          mediaType: "video",
          force: true,
          passive: true,
        }).catch((error) => ({ reason: error.message }));
        if (!dialog.open || currentCheck !== checkId || selectedMode() !== mode)
          return false;
        apiReady = health?.ready === true;
        if (!apiReady) {
          apiError = health?.reason || null;
          apiHealthReason =
            health?.reason || health?.error || "health_unavailable";
        } else if (flowReady)
          paintStatus(
            "motionFlowStatus",
            "ready",
            motionText("text007", "S\u1EB5n s\xE0ng"),
          );
      }
      const configuredMode =
        window.storageSettings?.getSettings?.()?.defaultGenMode ||
        window.storageSettings?.getSettings?.()?.gen_mode;
      if (mode === "api" && !apiReady && configuredMode === "auto") {
        apiHealthReason || (apiHealthReason = "api_not_intended");
        autoWebReason = apiHealthReason;
        autoWebConfirmed = true;
        mode = "web";
        apiReady = true;
        apiError = null;
        $("motionFlowLabel").textContent = "Flow \xB7 Web";
        if (flowReady)
          paintStatus(
            "motionFlowStatus",
            "ready",
            motionText("text007", "S\u1EB5n s\xE0ng"),
          );
      }
      if (mode === "api" && !apiReady && flowReady) {
        paintStatus(
          "motionFlowStatus",
          apiError ? "warning" : "checking",
          apiError || motionText("text023", "\u0110ang ki\u1EC3m tra..."),
        );
      }
      const modeCompatible = true;
      const selectedVoice = hasSelectedFlowVoice()
        ? await window.MotionFlowQueueRequest?.resolveVoice?.(
            project.data_json.preferences.voice_slug,
          )
        : null;
      if (!dialog.open || currentCheck !== checkId || selectedMode() !== mode)
        return false;
      const voiceReady =
        !hasSelectedFlowVoice() || !!selectedVoice?.search_value;
      $("motionRunWarning").textContent = !voiceReady
        ? motionText(
            "text141",
            "Kh\xF4ng t\xECm th\u1EA5y Flow Voice \u0111\xE3 ch\u1ECDn. H\xE3y ch\u1ECDn l\u1EA1i gi\u1ECDng.",
          )
        : !agentReady
          ? motionText(
              "text143",
              "Ki\u1EC3m tra \u0111\u0103ng nh\u1EADp v\xE0 tr\u1EA1ng th\xE1i agent, sau \u0111\xF3 th\u1EED l\u1EA1i.",
            )
          : apiReady
            ? hasSelectedFlowVoice()
              ? motionText(
                  "text142",
                  "Flow Voice d\xF9ng Web mode; mode \u0111\u01B0\u1EE3c gi\u1EEF c\u1ED1 \u0111\u1ECBnh \u0111\u1EBFn h\u1EBFt l\u01B0\u1EE3t ch\u1EA1y.",
                )
              : motionFormat(
                  "text259",
                  "Flow {0} theo Settings; gi\u1EEF c\u1ED1 \u0111\u1ECBnh \u0111\u1EBFn h\u1EBFt l\u01B0\u1EE3t ch\u1EA1y.",
                  [mode === "api" ? "Max Speed" : "Web"],
                )
            : apiError
              ? motionText(
                  "text140",
                  "Flow API ch\u01B0a s\u1EB5n s\xE0ng; ki\u1EC3m tra tr\u1EA1ng th\xE1i b\xEAn tr\xEAn.",
                )
              : motionText(
                  "text139",
                  "\u0110ang ki\u1EC3m tra tr\u1EA1ng th\xE1i Flow API...",
                );
      const ready =
        flowReady && agentReady && apiReady && modeCompatible && voiceReady;
      console.info(
        "[MotionConfirmRun]",
        JSON.stringify({
          action: requestedAction,
          frameId: requestedFrameId,
          selectedModel: $("motionFlowModel")?.value || null,
          savedModel: project?.data_json?.preferences?.flow_model || null,
          defaultModel: profile?.settings?.flow_model || null,
          continuitySelected: $("continuityEnabled")?.checked === true,
          continuitySaved:
            project?.data_json?.preferences?.continuity_enabled === true,
          mode,
          flowReady,
          needsAgent,
          agentReady,
          apiReady,
          modeCompatible,
          voiceReady,
          confirming,
          ready,
          configuredMode,
          apiToggle,
          systemDriver: window.SystemConfig?.get?.("flow_api_driver", null),
          apiAllowed: window.featureGate?.canUse?.("flow_api_enabled") === true,
          voiceForcesWeb: hasSelectedFlowVoice(),
          autoWebConfirmed,
          apiHealthReason: apiHealthReason || autoWebReason,
        }),
      );
      $("motionRunConfirm").disabled = confirming || !ready;
      if (ready) {
        clearInterval(confirmStatusTimer);
        confirmStatusTimer = null;
      }
      return ready;
    };
    const check = () => {
      if (checkFlight) return checkFlight;
      const flight = performCheck();
      checkFlight = flight;
      return flight.finally(() => {
        if (checkFlight === flight) checkFlight = null;
      });
    };
    let opening = false;
    const open = async (frameId, action = "generate") => {
      if (scopeInvalid || busy || motionRunning) return;
      if (opening) return;
      if (settingsDirty || settingsSaveTimer) {
        opening = true;
        if (frameId && action === "generate")
          motionToast(motionText("text183", "\u0110ang l\u01B0u..."));
        try {
          await saveMotionSettings();
        } finally {
          opening = false;
        }
        if (
          settingsDirty ||
          settingsSaveTimer ||
          scopeInvalid ||
          busy ||
          motionRunning
        ) {
          if (!scopeInvalid) {
            const message =
              $("motionSettingsStatus").textContent ||
              motionText(
                "text117",
                "H\xE3y l\u01B0u thi\u1EBFt l\u1EADp Motion tr\u01B0\u1EDBc khi ch\u1EA1y.",
              );
            status(message);
            if (frameId && action === "generate")
              motionToast(message, { error: true });
          }
          return;
        }
      }
      const pendingCharacter =
        action === "generate" &&
        !project?.data_json?.references?.character?.length
          ? await window.MotionLocalReferences.access({
              userId,
              projectId,
              kind: "character",
            })
          : null;
      if (
        action === "generate" &&
        !project?.data_json?.references?.character?.length &&
        !pendingCharacter?.file
      ) {
        $("characterDropZone").focus();
        status(motionText("text020", "Ch\u1ECDn / thay \u1EA3nh character"));
        return;
      }
      if (
        action === "generate" &&
        project?.data_json?.preferences?.voice_enabled === true &&
        !window.MotionPromptComposer.hasVoiceStyle(
          profile,
          project.data_json.preferences.voice_mode || "character",
        )
      ) {
        status(
          motionText(
            "voiceStyleUnavailable",
            "Admin c\u1EA7n c\u1EA5u h\xECnh v\xE0 publish prompt cho ch\u1EBF \u0111\u1ED9 tho\u1EA1i \u0111\xE3 ch\u1ECDn.",
          ),
        );
        return;
      }
      const reviewAvailable =
        action === "generate" &&
        !frameId &&
        window.ExecutionConfig?.getMotionExecutionModeSync(
          profile?.settings?.execution_mode,
          project?.data_json?.preferences?.transcription_provider ||
            profile?.settings?.transcription_provider,
        ) === "parallel" &&
        (project?.data_json?.preferences?.voice_enabled === true ||
          project?.data_json?.preferences?.subtitle_enabled === true);
      $("motionRunReviewRow").hidden = !reviewAvailable;
      for (const node of $("motionRunReviewRow").querySelectorAll(
        "[data-i18n]",
      )) {
        const key = node.dataset.i18n;
        const translated = window.I18n?.t?.(key);
        if (translated && translated !== key) node.textContent = translated;
      }
      $("motionRunReviewSubtitle").checked =
        project?.data_json?.preferences?.review_subtitle === true;
      requestedFrameId = frameId;
      requestedAction = action;
      autoWebConfirmed = false;
      autoWebReason = null;
      dialog.classList.toggle(
        "is-sub-confirm",
        ["transcribe", "transcribe_batch"].includes(action),
      );
      $("motionFlowStatus").closest(".confirm-run-provider-status").hidden = [
        "transcribe",
        "transcribe_batch",
      ].includes(action);
      $("motionRunConfirm").querySelector("span").textContent = [
        "transcribe_batch",
        "transcribe",
      ].includes(action)
        ? motionText("text067", "T\u1EA1o Sub")
        : action === "upload_batch"
          ? "Upload h\xE0ng lo\u1EA1t"
          : action === "upload"
            ? "Upload to Flow"
            : "Generate";
      confirming = false;
      $("motionRunConfirm").disabled = true;
      initialCheck = true;
      flowRepairAttempted = false;
      dialog.showModal();
      flowActivation = ["transcribe", "transcribe_batch"].includes(action)
        ? null
        : getMotionFlowTarget()
            .then((target) => {
              assertPinnedFlowTarget(target);
              return chrome.runtime.sendMessage({
                action: "ensureFlowTabActive",
                targetTabId: target.tabId,
                focusWindow: false,
              });
            })
            .catch((error) => ({ ok: false, error: error.message }));
      check();
      clearInterval(confirmStatusTimer);
      confirmStatusTimer = setInterval(check, 5e3);
    };
    start.addEventListener("click", () => {
      if (externalMotionRun?.state === "needs_review") {
        void setPaused(false);
        return;
      }
      if (project?.data_json?.paused === true || localMotionProviderPause) {
        void setPaused(false);
        return;
      }
      if (start.dataset.controlState === "running") {
        void setPaused(true);
        return;
      }
      open(null);
    });
    openManualRunConfirmation = (frameId) => open(frameId);
    openSubRunConfirmation = (frameId) => open(frameId, "transcribe");
    openBatchSubConfirmation = () => open(null, "transcribe_batch");
    openUploadConfirmation = (frameId) => open(frameId, "upload");
    openBatchUploadConfirmation = () => open(null, "upload_batch");
    $("motionRunClose").addEventListener("click", () => {
      checkId++;
      clearInterval(confirmStatusTimer);
      confirmStatusTimer = null;
      dialog.close();
    });
    $("motionRunCancel").addEventListener("click", () => dialog.close());
    dialog.addEventListener("close", () => {
      checkId++;
      checkFlight = null;
      clearInterval(confirmStatusTimer);
      confirmStatusTimer = null;
    });
    $("motionRunConfirm").addEventListener("click", async () => {
      if ($("motionRunConfirm").disabled || scopeInvalid || busy || confirming)
        return;
      const mode = selectedMode();
      confirming = true;
      try {
        clearInterval(confirmStatusTimer);
        confirmStatusTimer = null;
        $("motionRunConfirm").disabled = true;
        if (
          (await check()) !== true ||
          (!["transcribe", "transcribe_batch"].includes(requestedAction) &&
            selectedMode() !== mode)
        )
          throw new Error("MOTION_PROVIDER_NOT_READY");
        $("motionRunConfirm").disabled = true;
        if (requestedAction === "transcribe") {
          const frameId2 = requestedFrameId;
          dialog.close();
          void generateFrameTranscript(frameId2);
          return;
        }
        if (requestedAction === "transcribe_batch") {
          dialog.close();
          void generateBatchTranscripts();
          return;
        }
        if (
          requestedAction === "generate" &&
          (pendingSourceFile ||
            !Object.keys(project?.data_json?.frames || {}).length)
        ) {
          dialog.close();
          const prepared = await prepareSource({
            forceResplit: !pendingSourceFile,
          });
          if (!prepared || scopeInvalid) return;
        }
        if (requestedAction === "generate" && requestedFrameId)
          await forceResetForManualRegen(requestedFrameId);
        let current = await api("GET", endpoint);
        if (
          requestedAction === "generate" &&
          !$("motionRunReviewRow").hidden &&
          (current.data_json?.preferences?.review_subtitle === true) !==
            $("motionRunReviewSubtitle").checked
        ) {
          current = await api("PATCH", endpoint, {
            revision: current.revision,
            review_subtitle: $("motionRunReviewSubtitle").checked,
          });
        }
        project =
          current.data_json?.flow_run_mode === mode
            ? current
            : await api("PATCH", endpoint, {
                revision: current.revision,
                flow_run_mode: mode,
              });
        checkId++;
        clearInterval(confirmStatusTimer);
        confirmStatusTimer = null;
        const frameId = requestedFrameId;
        const action = requestedAction;
        if (dialog.open) dialog.close();
        await refresh();
        if (action === "upload_batch")
          void uploadAllSourceFrames({ manual: true, confirmedFlowMode: mode });
        else if (action === "upload")
          void uploadFrameClip(frameId, {
            manual: true,
            confirmedFlowMode: mode,
          });
        else {
          if (frameId)
            motionToast(
              motionFormat(
                "text212",
                "{0}: \u0111ang t\u1EA1o video Flow {1}...",
                [frameId, mode.toUpperCase()],
              ),
            );
          void runMotionFrames(frameId, mode);
        }
      } catch (error) {
        $("motionRunWarning").textContent = motionErrorMessage(error);
        if (requestedFrameId && requestedAction === "generate")
          motionToast($("motionRunWarning").textContent, { error: true });
        if (dialog.open && !confirmStatusTimer)
          confirmStatusTimer = setInterval(check, 5e3);
      } finally {
        confirming = false;
        if (dialog.open && !scopeInvalid && !busy) void check();
      }
    });
  }
  function formatElapsed(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1e3));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  }
  function tickActivity() {
    const timer = $("motionTimer");
    if (timer) {
      timer.textContent = formatElapsed(
        activityStartedAt
          ? Date.now() - activityStartedAt
          : Number(timer.dataset.elapsedMs) || 0,
      );
      timer.classList.toggle("is-active", !!activityStartedAt);
    }
    document.querySelectorAll(".motion-frame-timer").forEach((element) => {
      const tile = element.closest(".timeline-clip");
      const started =
        Number(element.dataset.startedAt) ||
        (tile?.dataset.frameId === activeUploadFrameId &&
        tile.classList.contains("source")
          ? activeUploadStartedAt
          : tile?.dataset.frameId === activeMotionFrameId &&
              tile.classList.contains("result")
            ? activeFlowStartedAt
            : 0);
      element.textContent = started
        ? formatElapsed(Date.now() - started)
        : "00:00";
    });
  }
  function updateMotionQueueStatus(snapshot) {
    const frameId = activeMotionFrameId;
    if (
      !frameId ||
      activeMotionStage !== "flow" ||
      !motionQueueJobId ||
      localMotionProviderPause?.frameId === frameId
    )
      return;
    const item = (snapshot?.jobs || []).find(
      (job) => job.owner === "motion" && job.id === motionQueueJobId,
    )?.items?.[0];
    if (!item) return;
    const count = Number(item.retryCount) || 0;
    const retrying =
      item.statusKind === "retrying" ||
      item.state === "RETRY_SUBMIT" ||
      (count > 0 &&
        ![
          "COMPLETED",
          "FAILED",
          "CANCELLED",
          "PARTIAL_FAIL",
          "BLOCKED",
        ].includes(item.state));
    const translated = window.I18n?.t?.("flowStatus.retrying");
    const label =
      translated && translated !== "flowStatus.retrying"
        ? translated
        : "\u0110ang th\u1EED l\u1EA1i";
    const providerRetry = externalFlowProviderError(frameId, true);
    activeFlowRetryLabel =
      retrying || providerRetry
        ? `${label.replace(/[.…]+$/, "")}...${typeof providerRetry === "string" ? ` \xB7 (${providerRetry})` : count > 0 ? ` \xB7 ${count}` : ""}`
        : "";
    for (const tile of $("resultTrack").children) {
      if (tile.dataset.frameId !== frameId) continue;
      const text = tile.querySelector(".timeline-flow-status");
      if (text)
        text.textContent =
          activeFlowRetryLabel ||
          frameStage(project.data_json.frames[frameId]).label;
    }
  }
  function startActivity() {
    if ($("motionTimer")) delete $("motionTimer").dataset.reset;
    if (!activityStartedAt) {
      activityStartedAt = Date.now();
      if ($("motionTimer")) delete $("motionTimer").dataset.elapsedMs;
    }
    tickActivity();
  }
  function settleActivity(force = false) {
    if (!force && (busy || motionRunning)) return;
    if ($("motionTimer")?.dataset.reset === "true") {
      activityStartedAt = null;
      tickActivity();
      return;
    }
    if (activityStartedAt && $("motionTimer"))
      $("motionTimer").dataset.elapsedMs = String(
        Math.max(0, Date.now() - activityStartedAt),
      );
    activityStartedAt = null;
    tickActivity();
  }
  async function resetMotionHeaderTimer() {
    activityStartedAt = null;
    if ($("motionTimer")) {
      $("motionTimer").dataset.elapsedMs = "0";
      $("motionTimer").dataset.reset = "true";
    }
    tickActivity();
    try {
      const key = `motion_runner_status:${userId}:${projectId}`;
      const saved = (await chrome.storage.local.get(key))?.[key];
      if (
        !scopeInvalid &&
        saved?.userId === userId &&
        saved.projectId === projectId &&
        saved.flowProjectId === project?.flow_project_id
      ) {
        await chrome.storage.local.set({
          [key]: {
            ...saved,
            startedAt: Date.now(),
            elapsedMs: 0,
            finishedAt: Date.now(),
            timerReset: true,
          },
        });
      }
    } catch (error) {
      console.warn("[MotionControl]", {
        stage: "timer_reset_persistence",
        code: error?.code || error?.message,
      });
    }
  }
  function countryChoices() {
    if (languageChoices) return languageChoices;
    const countryVi = new Intl.DisplayNames(
      [window.I18n?.getLocale?.() || "vi"],
      { type: "region" },
    );
    const countryEn = new Intl.DisplayNames(["en"], { type: "region" });
    const languageEn = new Intl.DisplayNames(["en"], { type: "language" });
    const rows = [];
    for (let a = 65; a <= 90; a++)
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        const locale = new Intl.Locale(`und-${code}`);
        if (locale.region !== code) continue;
        const english = countryEn.of(code);
        if (
          !english ||
          english === code ||
          ["EU", "UN", "XA", "XB"].includes(code)
        )
          continue;
        const language = locale.maximize().language;
        if (!language || language === "und") continue;
        rows.push({
          code,
          country: countryVi.of(code) || english,
          english,
          language: languageEn.of(language) || language,
          value: `${languageEn.of(language) || language} (${code})`,
        });
      }
    languageChoices = rows.sort((a, b) =>
      a.country.localeCompare(b.country, "vi"),
    );
    return languageChoices;
  }
  function initLanguagePicker() {
    const row = $("targetLanguageRow");
    const input = $("targetLanguage");
    input.type = "hidden";
    const trigger = document.createElement("button");
    trigger.id = "targetLanguageTrigger";
    trigger.type = "button";
    trigger.className = "language-trigger";
    trigger.setAttribute("aria-labelledby", "targetLanguageHeading");
    row.append(trigger);
    const dialog = document.createElement("dialog");
    dialog.id = "targetLanguageDialog";
    dialog.className = "language-picker-dialog";
    const header = document.createElement("div");
    header.className = "language-picker-header";
    const heading = document.createElement("strong");
    heading.textContent = motionText(
      "text170",
      "Ch\u1ECDn ng\xF4n ng\u1EEF theo qu\u1ED1c gia",
    );
    heading.dataset.i18n = "motionEditor.text170";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "\u2715";
    close.setAttribute("aria-label", "\u0110\xF3ng ch\u1ECDn ng\xF4n ng\u1EEF");
    close.addEventListener("click", () => dialog.close());
    header.append(heading, close);
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder =
      "T\xECm qu\u1ED1c gia ho\u1EB7c ng\xF4n ng\u1EEF\u2026";
    search.setAttribute("aria-label", "T\xECm ng\xF4n ng\u1EEF");
    const list = document.createElement("div");
    list.className = "language-picker-list";
    dialog.append(header, search, list);
    document.body.append(dialog);
    const normalize = (value) =>
      String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
    const choose = (value) => {
      if (scopeInvalid || busy || motionSettingsRunLocked()) return;
      input.value = value;
      if (!value) $("translateEnabled").checked = false;
      trigger.textContent =
        value || motionText("text107", "Gi\u1EEF ng\xF4n ng\u1EEF g\u1ED1c");
      dialog.close();
      updateMotionVisibility();
      scheduleSettingsSave();
    };
    const render = () => {
      list.replaceChildren();
      const query = normalize(search.value.trim());
      if (!query) {
        const original = document.createElement("button");
        original.type = "button";
        original.textContent = motionText(
          "text171",
          "Gi\u1EEF ng\xF4n ng\u1EEF g\u1ED1c \xB7 kh\xF4ng d\u1ECBch",
        );
        original.addEventListener("click", () => choose(""));
        list.append(original);
      }
      const matches = countryChoices().filter(
        (item) =>
          !query ||
          normalize(
            `${item.country} ${item.english} ${item.language} ${item.code}`,
          ).includes(query),
      );
      if (query) {
        const rank = (item) => {
          const names = [item.country, item.english].map(normalize);
          const code = normalize(item.code);
          if (code === query || names.includes(query)) return 0;
          if (names.some((name) => name.startsWith(query))) return 1;
          if (names.some((name) => name.includes(query))) return 2;
          return 3;
        };
        matches.sort((a, b) => rank(a) - rank(b));
      }
      for (const item of matches) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${item.country} \xB7 ${item.language} (${item.code})`;
        button.addEventListener("click", () => choose(item.value));
        list.append(button);
      }
      if (!list.childElementCount)
        list.textContent = motionText(
          "text172",
          "Kh\xF4ng t\xECm th\u1EA5y qu\u1ED1c gia.",
        );
    };
    trigger.addEventListener("click", () => {
      if (scopeInvalid || busy || motionSettingsRunLocked()) return;
      search.value = "";
      render();
      dialog.showModal();
      search.focus();
    });
    search.addEventListener("input", render);
    trigger.textContent =
      input.value ||
      motionText("text107", "Gi\u1EEF ng\xF4n ng\u1EEF g\u1ED1c");
  }
  function activeReferenceData() {
    return {
      references: { ...references, mode: $("referenceMode").value },
      preferences: {
        ...project?.data_json?.preferences,
        character_count: Number($("characterCount").value),
      },
    };
  }
  function otherReferenceCount(kind, mode = $("referenceMode").value) {
    const data = activeReferenceData();
    data.references.mode = mode;
    const kinds = [
      "character",
      ...(data.preferences.character_count === 2 ? ["character2"] : []),
      ...(mode === "character_background" ? ["background"] : []),
    ];
    return kinds
      .filter((value) => value !== kind)
      .reduce((count, value) => count + (references[value]?.length || 0), 0);
  }
  function renderReferences() {
    const backgroundEnabled =
      !!profile && profile.settings?.show_background_refs !== false;
    const twoEnabled = profile?.settings?.show_two_characters === true;
    const count = Number($("characterCount").value);
    $("characterCountGroup").hidden = !twoEnabled && count !== 2;
    $("character2RefGroup").hidden = count !== 2;
    $("characterRefLabel").textContent =
      count === 2
        ? window.I18n?.t("motionEditor.character1") || ""
        : "Character";
    const select = $("referenceMode");
    const backgroundOption = select.querySelector(
      'option[value="character_background"]',
    );
    if (!backgroundEnabled) {
      backgroundOption?.remove();
      select.value = "character_only";
    } else if (!backgroundOption) {
      const option = document.createElement("option");
      option.value = "character_background";
      option.textContent = "Character + background";
      select.append(option);
      select.value = references.mode || "character_only";
    }
    const mode = select.value;
    const secondOption = $("characterCount").querySelector('option[value="2"]');
    secondOption.disabled = !twoEnabled;
    if (twoEnabled) {
      try {
        const caps = window.ImagePickerModal.resolveCapsMulti({
          provider: "flow",
          mode: "video",
          isFrames: false,
          modelValue: effectiveFlowModel(),
          duration: profile.settings?.flow_duration,
        });
        const budget = Math.min(
          caps.image,
          Number.isInteger(caps.total) ? caps.total - 1 : caps.image,
        );
        const countRequired =
          2 +
          ($("referenceMode").value === "character_background" ? 1 : 0) +
          ($("continuityEnabled").checked &&
          Object.keys(project?.data_json?.frames || {}).length > 1
            ? 1
            : 0);
        secondOption.disabled =
          !Number.isFinite(budget) ||
          budget < countRequired ||
          !(caps.video >= 1);
      } catch (_) {
        secondOption.disabled = true;
      }
    }
    window.motionReferenceModePickerRender?.();
    window.motionCharacterCountPickerRender?.();
    $("backgroundRefGroup").hidden =
      !backgroundEnabled || mode !== "character_background";
    $("characterRefSummary").textContent = references.character.length
      ? references.character
          .map((ref) => ref.display_name || ref.file_name || ref.fileId)
          .join(", ")
      : motionText(
          "text019",
          "Th\u1EA3 \u1EA3nh ho\u1EB7c ch\u1ECDn t\u1EEB th\u01B0 vi\u1EC7n",
        );
    $("backgroundRefSummary").textContent = references.background.length
      ? references.background
          .map((ref) => ref.display_name || ref.file_name || ref.fileId)
          .join(", ")
      : motionText(
          "text019",
          "Th\u1EA3 \u1EA3nh ho\u1EB7c ch\u1ECDn t\u1EEB th\u01B0 vi\u1EC7n",
        );
    for (const kind of ["character", "character2", "background"]) {
      if (kind === "character2")
        $("character2RefSummary").textContent = references.character2?.length
          ? references.character2
              .map((ref2) => ref2.display_name || ref2.file_name || ref2.fileId)
              .join(", ")
          : motionText(
              "text019",
              "Th\u1EA3 \u1EA3nh ho\u1EB7c ch\u1ECDn t\u1EEB th\u01B0 vi\u1EC7n",
            );
      const preview = $(kind + "RefPreview");
      const zone = $(kind + "DropZone");
      const summary = $(kind + "RefSummary");
      if (zone.getAttribute("aria-busy") === "true")
        summary.textContent = motionText(
          "text124",
          "\u0110ang x\xE1c minh v\xE0 l\u01B0u \u1EA3nh tham chi\u1EBFu...",
        );
      preview.removeAttribute("aria-hidden");
      const icon =
        kind !== "background"
          ? '<span class="character-reference-icon" aria-hidden="true"></span>'
          : referenceIcon;
      preview.replaceChildren();
      const ref = references[kind]?.[0];
      const replaceLabel =
        kind !== "background"
          ? motionText("text020", "Ch\u1ECDn / thay \u1EA3nh character")
          : motionText("text021", "Ch\u1ECDn / thay \u1EA3nh background");
      zone.title = replaceLabel;
      zone.setAttribute("aria-label", replaceLabel);
      let replaceHint = summary.parentElement.querySelector(
        ".motion-ref-replace-hint",
      );
      if (!replaceHint) {
        replaceHint = document.createElement("small");
        replaceHint.className = "motion-ref-replace-hint";
        summary.after(replaceHint);
      }
      replaceHint.innerHTML = icon;
      replaceHint.append(document.createTextNode(replaceLabel));
      replaceHint.hidden = !ref;
      const emptyIcon = ref
        ? icon
        : `${icon}<span class="motion-ref-add" aria-hidden="true">+</span>`;
      preview.classList.toggle("is-empty", !ref);
      const cached = ref && referencePreviewCache.get(`${kind}:${ref.fileId}`);
      const source = cached?.thumbnail || safeReferencePreview(ref?.thumbnail);
      const thumbnail =
        window.flow_uuid_gateway?.displayThumbnailUrl?.(source) || source;
      if (safeReferencePreview(thumbnail)) {
        const image = document.createElement("img");
        image.src = thumbnail;
        image.alt = "";
        image.addEventListener(
          "error",
          () => {
            if (!preview.contains(image)) return;
            chrome.runtime
              .sendMessage({ action: "fetchImageAsBase64", url: thumbnail })
              .then((result) => {
                if (!preview.contains(image)) return;
                if (
                  result?.success &&
                  result.base64 &&
                  /^image\//i.test(result.contentType || "")
                ) {
                  image.src = `data:${result.contentType};base64,${result.base64}`;
                } else preview.innerHTML = emptyIcon;
              })
              .catch(() => {
                if (preview.contains(image)) preview.innerHTML = emptyIcon;
              });
          },
          { once: true },
        );
        image.referrerPolicy = "no-referrer";
        preview.append(image);
        const view = document.createElement("button");
        view.type = "button";
        view.className = "motion-reference-view";
        view.setAttribute(
          "aria-label",
          `${window.I18n?.t?.("common.view") || "View"} ${kind}`,
        );
        view.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
        view.addEventListener("click", (event) => {
          event.stopPropagation();
          openReferencePreview(
            window.flow_uuid_gateway?.imagePreviewUrl?.(
              cached?.corrected || ref,
              source,
            ) || source,
            kind,
          );
        });
        view.addEventListener("keydown", (event) => event.stopPropagation());
        preview.append(view);
      } else preview.innerHTML = emptyIcon;
      const failed = !!zone.dataset.referenceFailure;
      zone.classList.toggle("is-reference-error", failed);
      zone.setAttribute("aria-invalid", String(failed));
      let errorHint = summary.parentElement.querySelector(".motion-ref-error");
      if (!errorHint) {
        errorHint = document.createElement("small");
        errorHint.className = "motion-ref-error";
        errorHint.setAttribute("role", "status");
        summary.after(errorHint);
      }
      errorHint.hidden = !failed;
      errorHint.textContent = failed ? zone.dataset.referenceFailure : "";
      const reuploadButton = $(kind + "RefReupload");
      if (reuploadButton)
        reuploadButton.disabled = busy || motionRunning || scopeInvalid;
      const scanButton = $(kind + "RefRescan");
      if (scanButton)
        scanButton.disabled = !ref || busy || motionRunning || scopeInvalid;
      const removeButton = $(kind + "RefRemove");
      if (removeButton) {
        removeButton.hidden = !ref;
        removeButton.disabled = busy || motionRunning || scopeInvalid;
      }
      const key = ref && `${kind}:${ref.fileId}`;
      if (
        (kind !== "character2" || count === 2) &&
        key &&
        !referenceScanAttempts.has(key) &&
        !referenceScanController &&
        !busy &&
        !motionRunning &&
        !scopeInvalid
      ) {
        referenceScanAttempts.add(key);
        void rescanReference(kind, false);
      }
    }
  }
  function openReferencePreview(src, kind) {
    if (scopeInvalid || !safeReferencePreview(src)) return;
    let dialog = $("motionReferencePreview");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "motionReferencePreview";
      dialog.className = "motion-reference-preview-dialog";
      const close = document.createElement("button");
      close.type = "button";
      close.className = "icon-button";
      close.setAttribute(
        "aria-label",
        window.I18n?.t?.("common.close") || "Close",
      );
      close.textContent = "\xD7";
      const image2 = document.createElement("img");
      image2.referrerPolicy = "no-referrer";
      close.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      dialog.addEventListener("close", () => image2.removeAttribute("src"));
      dialog.append(close, image2);
      document.body.append(dialog);
    }
    const image = dialog.querySelector("img");
    image.onerror = async () => {
      image.onerror = null;
      if (
        !dialog.open ||
        image.getAttribute("src") !== src ||
        !/^https?:/i.test(src)
      )
        return;
      try {
        const result = await chrome.runtime.sendMessage({
          action: "fetchImageAsBase64",
          url: src,
        });
        if (
          dialog.open &&
          image.getAttribute("src") === src &&
          result?.success &&
          result.base64 &&
          /^image\//i.test(result.contentType || "")
        ) {
          image.src = `data:${result.contentType};base64,${result.base64}`;
        }
      } catch (_) {}
    };
    image.alt = kind;
    image.src = src;
    if (!dialog.open) dialog.showModal();
  }
  function referenceFailed(kind, message = "") {
    const zone = $(kind + "DropZone");
    if (message) zone.dataset.referenceFailure = message;
    else delete zone.dataset.referenceFailure;
    renderReferences();
  }
  async function reuploadReference(kind) {
    const trace = await prepareReferenceInteraction(kind, "reupload");
    if (!trace) return;
    try {
      const ref = references[kind]?.[0],
        openedRevision = project.revision;
      const openedSourceRevision = Number(
        project.data_json?.source_revision || 0,
      );
      const local = await window.MotionLocalReferences.access({
        userId,
        projectId,
        kind,
      });
      let file =
        local?.flowProjectId === project.flow_project_id ? local.file : null;
      if (!file && ref?.fileId)
        file = await window.PendingUploadStore.getCachedFile(ref.fileId);
      if (
        scopeInvalid ||
        busy ||
        motionRunning ||
        project.revision !== openedRevision
      )
        return;
      if (!file) {
        setReferenceStatus(
          window.I18n?.t?.("motionEditor.refLocalMissing") || "",
        );
        await openReferencePicker(kind);
        return;
      }
      const target = await getMotionFlowTarget();
      assertPinnedFlowTarget(target);
      await savePickedReferences(
        kind,
        [{ source: "upload", file }],
        target,
        openedRevision,
        openedSourceRevision,
        trace,
      );
    } catch (error) {
      referenceFailed(kind, motionErrorMessage(error));
    }
  }
  async function rescanReference(kind, manual = true) {
    const ref = references[kind]?.[0];
    if (!ref || scopeInvalid || busy || motionRunning) return;
    if (referenceScanController) {
      if (!manual) return;
      referenceScanController.abort();
      referenceScanController = null;
    }
    const controller = new AbortController();
    referenceScanController = controller;
    const key = `${kind}:${ref.fileId}`;
    const same = () =>
      !controller.signal.aborted &&
      !scopeInvalid &&
      !busy &&
      !motionRunning &&
      project?.flow_project_id === ref.project_id &&
      references[kind]?.[0]?.fileId === ref.fileId &&
      references[kind]?.[0]?.media_uuid === ref.media_uuid;
    const button = $(kind + "RefRescan");
    if (button) button.disabled = true;
    try {
      const target = await getMotionFlowTarget();
      assertPinnedFlowTarget(target);
      const gateway = window.flow_uuid_gateway;
      const uuid = gateway.identity(ref, ref.fileId);
      if (manual) {
        const verdict = await gateway.resolve([uuid], {
          mode: "web",
          requireWebInteraction: true,
          purpose: "reference",
          expectedFlowTarget: target,
          projectId: target.projectId,
          signal: controller.signal,
          abortFn: () => !same(),
          ownerRecords: [{ ...ref, resultId: ref.fileId }],
        });
        if (!same()) return;
        if (verdict.results?.[uuid]?.ok !== true) {
          const message = window.I18n?.t?.("motionEditor.refNotFound") || "";
          referenceFailed(kind, message);
          setReferenceStatus(message);
          return;
        }
        referenceFailed(kind);
      }
      const response = await gateway.recoverMetadata(
        [{ id: ref.fileId, record: { ...ref, type: "image" } }],
        {
          signal: controller.signal,
          abortFn: () => !same(),
          projectId: target.projectId,
          expectedFlowTarget: target,
          surface: "motion",
          deep: manual,
          fields: ["thumbnail"],
        },
      );
      if (!same()) return;
      const info = response.records[ref.fileId];
      const corrected = gateway.isAsb(info?.persistent_media_id) ? info : null;
      const thumbnail = safeReferencePreview(
        info?.thumbnail || info?.source_thumbnail,
      );
      const current = await getMotionFlowTarget();
      assertPinnedFlowTarget(current, target);
      if (!same()) return;
      const previous = referencePreviewCache.get(key);
      referencePreviewCache.set(key, {
        corrected: corrected || previous?.corrected || null,
        thumbnail: thumbnail || previous?.thumbnail || null,
      });
      console.info(
        "[MotionRefScan]",
        JSON.stringify({
          kind,
          manual,
          hasUuid: !!uuid,
          corrected: !!corrected,
          thumbnailFound: !!thumbnail,
          hasCachedPreview: !!previous?.thumbnail,
        }),
      );
      renderReferences();
      if (manual)
        setReferenceStatus(
          window.I18n?.t?.("motionEditor.refVerified") || "",
          true,
        );
    } catch (error) {
      if (manual && !controller.signal.aborted) {
        referenceFailed(kind, motionErrorMessage(error));
        setReferenceStatus(motionErrorMessage(error));
      }
    } finally {
      if (referenceScanController === controller)
        referenceScanController = null;
      if (button)
        button.disabled =
          scopeInvalid || busy || motionRunning || !references[kind]?.length;
      if (!scopeInvalid && !busy && !motionRunning) renderReferences();
    }
  }
  let motionTargetLookup = null;
  async function getMotionFlowTarget(expected = null) {
    if (expected?.tabId != null)
      return window.MessageBridge.getTargetContext(expected);
    const ownerUser = userId,
      ownerProject = projectId,
      flowProject = project?.flow_project_id;
    if (!flowProject) return window.MessageBridge.getTargetContext();
    const key = `${ownerUser}:${ownerProject}:${flowProject}`;
    if (!motionTargetLookup || motionTargetLookup.key !== key) {
      const lookup = {
        key,
        promise: window.MessageBridge.getProjectTargetContext(flowProject),
      };
      motionTargetLookup = lookup;
      lookup.promise
        .finally(() => {
          if (motionTargetLookup === lookup) motionTargetLookup = null;
        })
        .catch(() => {});
    }
    const target = await motionTargetLookup.promise;
    if (scopeInvalid || userId !== ownerUser)
      throw new Error("ACCOUNT_SCOPE_CHANGED");
    if (projectId !== ownerProject || project?.flow_project_id !== flowProject)
      throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
    return target;
  }
  function assertPinnedFlowTarget(target, expected = null) {
    if (
      !target ||
      !project ||
      target.projectId !== project.flow_project_id ||
      !Number.isInteger(target.tabId) ||
      !target.driverKey ||
      (expected &&
        (target.tabId !== expected.tabId ||
          target.driverKey !== expected.driverKey ||
          target.origin !== expected.origin))
    ) {
      console.warn(
        "[MotionFlowTarget] Target rejected",
        JSON.stringify({
          expectedProjectId: project?.flow_project_id || null,
          projectId: target?.projectId || null,
          tabId: target?.tabId || null,
          expectedTabId: expected?.tabId || null,
          driver: target?.driverKey || null,
          registryLoaded: !!window.FlowDriverRegistry,
          reason: !target
            ? "target_missing"
            : target.projectId !== project?.flow_project_id
              ? "project_mismatch"
              : !target.driverKey
                ? "driver_missing"
                : "execution_target_changed",
        }),
      );
      throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
    }
  }
  let lastFlowProjectCheck = null;
  async function checkOpenFlowProject({ manual = false } = {}) {
    if (!project || scopeInvalid) return;
    const epoch = ++flowProjectCheckEpoch;
    const expected = project.flow_project_id;
    const button = $("motionFlowProjectRetry");
    const label = button?.querySelector("[data-i18n]") || button;
    if (manual && button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      label.dataset.i18n = "motionEditor.text023";
      label.textContent = motionText("text023", "");
    }
    try {
      let target = null,
        lookupError = null;
      try {
        target = await getMotionFlowTarget();
      } catch (error) {
        lookupError = error;
      }
      if (
        epoch !== flowProjectCheckEpoch ||
        scopeInvalid ||
        project?.flow_project_id !== expected
      )
        return;
      const overlay = $("motionFlowProjectOverlay");
      const ready =
        !!target?.tabId && !!target.driverKey && target.projectId === expected;
      const reason = ready
        ? "ready"
        : lookupError
          ? "lookup_failed"
          : target?.projectId
            ? "project_mismatch"
            : "matching_project_tab_missing";
      const diagnostic = {
        expectedProjectId: expected,
        projectId: target?.projectId || null,
        tabId: target?.tabId || null,
        driver: target?.driverKey || null,
        ready,
        reason,
      };
      const signature = JSON.stringify(diagnostic);
      if (manual || lastFlowProjectCheck !== signature) {
        lastFlowProjectCheck = signature;
        console.info(
          "[MotionFlowProjectCheck]",
          JSON.stringify({ checkId: epoch, manual, ...diagnostic }),
        );
      }
      overlay.hidden = ready;
      if (!ready) {
        const title = $("motionFlowProjectTitle");
        if (title) {
          if (lookupError || target?.projectId) {
            title.removeAttribute("data-i18n");
            title.textContent = "Google Flow";
          } else {
            title.dataset.i18n = "motionEditor.text000";
            title.textContent = motionText("text000", "");
          }
        }
        $("motionFlowProjectMessage").textContent = lookupError
          ? motionErrorMessage(lookupError)
          : target?.projectId
            ? motionText("text119", "")
            : motionText("text118", "");
      }
    } finally {
      if (manual && button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
        label.dataset.i18n = "motionEditor.text001";
        label.textContent = motionText("text001", "");
      }
    }
  }
  async function offerNewProjectMaxSpeed() {
    if (!newProjectSpeedOffer || scopeInvalid) return;
    newProjectSpeedOffer = false;
    const url = new URL(location.href);
    url.searchParams.delete("new");
    history.replaceState(history.state, "", url.href);
    const t = (key, fallback) => {
      const value = window.I18n?.t?.(key);
      return value && value !== key ? value : fallback;
    };
    const selected = await window.customDialog.confirm("", {
      title: t("motionEditor.getStartedTitle", "Get started with Motion"),
      type: "video-gen",
      confirmIcon: "max-speed",
      initialFocus: "none",
      steps: [
        t(
          "motionEditor.getStartedVideo",
          "Upload a video with one person and a simple product.",
        ),
        t(
          "motionEditor.getStartedReference",
          "Upload a character reference showing the face and outfit clearly.",
        ),
        t(
          "motionEditor.getStartedSpeed",
          "Use Max Speed for faster uploads and image/video generation.",
        ),
      ],
      warningText: t(
        "motionEditor.getStartedUploadWarning",
        "To upload videos, your Google Flow account and Chrome profile must use the same email address.",
      ),
      warningIcon: "chrome",
      cancelText: t("common.cancel", "Cancel"),
      confirmText: t("common.flowApiLabel", "Max Speed"),
    });
    if (selected && !scopeInvalid)
      await chrome.runtime.sendMessage({
        action: "openSettings",
        tab: "max-speed",
      });
  }
  function scheduleFlowProjectCheck() {
    clearTimeout(flowProjectCheckTimer);
    flowProjectCheckTimer = setTimeout(() => void checkOpenFlowProject(), 250);
  }
  async function fileBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(String(reader.result || "").split(",")[1] || "");
      reader.onerror = () =>
        reject(reader.error || new Error("MOTION_REF_READ_FAILED"));
      reader.readAsDataURL(file);
    });
  }
  function safeReferenceThumbnail(value) {
    return typeof value === "string" &&
      value.length <= 8192 &&
      (/^https:\/\//i.test(value) ||
        /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(value))
      ? value
      : null;
  }
  function safeReferencePreview(value) {
    return typeof value === "string" &&
      (/^https:\/\//i.test(value) ||
        /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/i.test(value))
      ? value
      : null;
  }
  async function prepareReference(item, target, { kind = null } = {}) {
    let file = item.source === "upload" ? item.file : null;
    let pendingKey = null;
    if (item.source === "album") {
      const prepared2 =
        await window.ImagePickerModal.prepareAlbumImageForRef(item);
      pendingKey = prepared2?.key || null;
      file = window.pendingUploadFiles?.get?.(pendingKey)?.file || null;
    }
    if (file) {
      if (kind)
        await window.MotionLocalReferences.pending(
          { userId, projectId, kind },
          file,
          target.projectId,
        );
      if (!file.type?.startsWith("image/"))
        throw new Error("MOTION_REF_IMAGE_REQUIRED");
      const payload = [
        {
          key: `motion_ref_${crypto.randomUUID()}`,
          name: file.name || "motion-ref.png",
          type: file.type,
          base64: await fileBase64(file),
        },
      ];
      const uploaded = await window.MessageBridge.uploadFilesToFlow(payload, {
        surface: "workflow",
        expectedFlowTarget: target,
      });
      payload[0].base64 = "";
      const detail = uploaded?.tileDetails?.[0];
      const uuid = [
        detail?.media_uuid,
        detail?.file_id,
        detail?.id,
        detail?.file_name,
      ].find(
        (value) =>
          typeof value === "string" &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value),
      );
      if (
        uploaded?.error ||
        !uuid ||
        uploaded?.tileDetails?.length !== 1 ||
        (detail.type && detail.type !== "image")
      )
        throw new Error(uploaded?.error || "MOTION_REF_UPLOAD_UNCONFIRMED");
      if (detail.project_id && detail.project_id !== target.projectId)
        throw new Error("MOTION_REF_PROJECT_MISMATCH");
      item = {
        ...item,
        fileId: detail.persistent_media_id || detail.id,
        media_uuid: uuid,
        persistent_media_id: detail.persistent_media_id || null,
        file_name: detail.file_name || null,
        thumbnail: detail.thumbnailUrl || detail.thumbnail || "",
        upload_name: detail.uploadName || file.name,
        ...(detail.display_name && { display_name: detail.display_name }),
        identity_aliases: detail.identity_aliases || [detail.id],
        identity_durability: detail.identity_durability || "session",
        source: "flow",
      };
    } else if (item.source !== "flow" && item.source !== "existing") {
      throw new Error("MOTION_REF_SOURCE_UNVERIFIED");
    }
    const fileId = String(item.fileId || "").trim();
    if (!fileId || fileId.startsWith("upload_"))
      throw new Error("MOTION_REF_ID_UNVERIFIED");
    if (item.project_id && item.project_id !== target.projectId)
      throw new Error("MOTION_REF_PROJECT_MISMATCH");
    if (file) {
      if (window.PendingUploadStore) {
        await window.PendingUploadStore.cacheUploaded(fileId, file);
      } else {
        if (!window.uploadedFileCache) window.uploadedFileCache = new Map();
        window.uploadedFileCache.set(fileId, { file });
      }
      if (pendingKey) window.pendingUploadFiles?.delete?.(pendingKey);
    }
    const thumbnail =
      [item.source_thumbnail, item.thumbnail].find(
        (value) =>
          typeof value === "string" &&
          value.startsWith("https://") &&
          safeReferenceThumbnail(value),
      ) || null;
    const prepared = {
      fileId,
      media_uuid: item.media_uuid || null,
      persistent_media_id: item.persistent_media_id || null,
      file_name: item.file_name || null,
      identity_aliases: Array.isArray(item.identity_aliases)
        ? item.identity_aliases.filter(Boolean).slice(0, 20)
        : [],
      identity_durability: ["durable", "session"].includes(
        item.identity_durability,
      )
        ? item.identity_durability
        : "session",
      type: "image",
      project_id: target.projectId,
      thumbnail,
      display_name:
        Array.from(String(item.display_name || item.name || ""))
          .slice(0, 255)
          .join("") || null,
      ...(item.upload_name && {
        upload_name: Array.from(String(item.upload_name))
          .slice(0, 255)
          .join(""),
      }),
    };
    if (kind && file)
      await window.MotionLocalReferences.ready(
        { userId, projectId, kind },
        prepared,
      );
    return prepared;
  }
  function setReferenceStatus(message, saved = false) {
    clearTimeout(referenceStatusTimer);
    const element = $("referenceStatus");
    element.textContent = message;
    element.classList.toggle("is-saved", saved);
    if (saved)
      referenceStatusTimer = setTimeout(() => {
        if (element.textContent === message) element.textContent = "";
        element.classList.remove("is-saved");
      }, 3e3);
  }
  async function clearReferenceGroup(kind) {
    const savedRefs = project.data_json?.references;
    if (!savedRefs || !Array.isArray(savedRefs[kind]))
      throw new Error("MOTION_REF_SHAPE_INVALID");
    const removed = savedRefs[kind];
    project = await api("PATCH", endpoint, {
      revision: project.revision,
      references: { ...savedRefs, [kind]: [] },
    });
    references = project.data_json.references;
    if (references[kind]?.length !== 0)
      throw new Error("MOTION_REF_CLEAR_UNVERIFIED");
    for (const ref of removed) {
      const key = `${kind}:${ref.fileId}`;
      referencePreviewCache.delete(key);
      referenceScanAttempts.delete(key);
    }
    renderReferences();
  }
  async function removeReference(kind) {
    if (scopeInvalid || busy || motionRunning || !references[kind]?.length)
      return;
    if (settingsDirty || settingsSaveTimer) {
      await saveMotionSettings();
      if (settingsDirty || scopeInvalid || busy) return;
    }
    referenceScanController?.abort();
    busy = true;
    updateButtons();
    renderReferences();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh();
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          await clearReferenceGroup(kind);
          await window.MotionLocalReferences.remove({
            userId,
            projectId,
            kind,
          });
          referenceFailed(kind);
          await refresh();
          setReferenceStatus("");
          showSettingsSaved(
            motionText(
              "text123",
              "\u0110\xE3 l\u01B0u \u1EA3nh tham chi\u1EBFu. K\u1EBFt qu\u1EA3 Flow c\u0169 c\u1EA7n t\u1EA1o l\u1EA1i.",
            ),
          );
        },
      );
    } catch (error) {
      setReferenceStatus(motionErrorMessage(error));
    } finally {
      busy = false;
      renderReferences();
      updateButtons();
    }
  }
  async function savePickedReferences(
    kind,
    items,
    target,
    openedRevision,
    openedSourceRevision,
    trace = () => {},
  ) {
    if (scopeInvalid || busy || motionSettingsRunLocked()) {
      trace("save_blocked");
      return false;
    }
    if (
      kind === "character2" &&
      (profile?.settings?.show_two_characters !== true ||
        Number($("characterCount").value) !== 2)
    ) {
      trace("save_blocked", "MOTION_TWO_CHARACTERS_DISABLED");
      return false;
    }
    if (
      kind === "background" &&
      profile?.settings?.show_background_refs === false
    ) {
      trace("save_blocked", "MOTION_BACKGROUND_REFERENCES_DISABLED");
      return false;
    }
    if (!Array.isArray(items) || items.length > 1) {
      setReferenceStatus(
        motionText(
          "text126",
          "M\u1ED7i nh\xF3m ch\u1EC9 \u0111\u01B0\u1EE3c ch\u1ECDn m\u1ED9t \u1EA3nh.",
        ),
      );
      return false;
    }
    const requestedMode = $("referenceMode").value;
    const uploadPreview = $(kind + "RefPreview");
    const uploading = items.some(
      (item) => item.source === "upload" || item.source === "album",
    );
    if (uploading) {
      delete $(kind + "DropZone").dataset.referenceFailure;
      uploadPreview.classList.add("is-uploading");
      $(kind + "DropZone").setAttribute("aria-busy", "true");
    }
    busy = true;
    updateButtons();
    setReferenceStatus(
      motionText(
        "text124",
        "\u0110ang x\xE1c minh v\xE0 l\u01B0u \u1EA3nh tham chi\u1EBFu...",
      ),
    );
    renderReferences();
    let saveStage = "project_lock";
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          saveStage = "project_refresh";
          trace(saveStage);
          await refresh();
          if (
            scopeInvalid ||
            project.revision !== openedRevision ||
            Number(project.data_json?.source_revision || 0) !==
              openedSourceRevision
          ) {
            throw new Error("MOTION_REF_SELECTION_STALE");
          }
          assertPinnedFlowTarget(await getMotionFlowTarget(), target);
          const caps = window.ImagePickerModal.resolveCapsMulti({
            provider: "flow",
            mode: "video",
            isFrames: false,
            modelValue: effectiveFlowModel(),
            duration: profile.settings?.flow_duration,
          });
          const otherCount = otherReferenceCount(kind, requestedMode);
          const totalImageSlots = Number.isInteger(caps.total)
            ? Math.max(0, caps.total - 1)
            : caps.image;
          const allowed =
            Math.min(caps.image ?? NaN, totalImageSlots ?? NaN) - otherCount;
          if (!Number.isFinite(allowed) || items.length > allowed)
            throw (
              window.ImagePickerModal.motionReferenceCapError?.({
                caps,
                imageCount: items.length + otherCount,
                stage: "prepare",
                modelValue: effectiveFlowModel(),
              }) || new Error("MOTION_REF_CAP_EXCEEDED")
            );
          if (uploading && references[kind]?.length) {
            referenceScanController?.abort();
            saveStage = "clear_previous_reference";
            trace(saveStage);
            await clearReferenceGroup(kind);
            trace("previous_reference_cleared");
          }
          const next = [],
            previews = [];
          for (const item of items) {
            if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
            saveStage = "prepare_reference";
            trace(saveStage);
            const prepared = await prepareReference(item, target, { kind });
            console.info(
              "[MotionReferencePrepared]",
              JSON.stringify({
                kind,
                hasIdentity: !!prepared.fileId,
                identityLength: prepared.fileId?.length || 0,
                fileNameLength: prepared.file_name?.length || 0,
                hasThumbnail: !!prepared.thumbnail,
                durability: prepared.identity_durability,
              }),
            );
            next.push(prepared);
            previews.push(
              item.source === "flow" || item.source === "existing"
                ? safeReferencePreview(item.thumbnail) ||
                    safeReferencePreview(item.source_thumbnail)
                : safeReferencePreview(prepared.thumbnail),
            );
            assertPinnedFlowTarget(await getMotionFlowTarget(), target);
          }
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          const updatedRefs = {
            ...references,
            mode: requestedMode,
            [kind]: next,
          };
          saveStage = "save_project";
          trace(saveStage);
          project = await api("PATCH", endpoint, {
            revision: project.revision,
            references: updatedRefs,
          });
          trace("project_saved");
          const localScope = { userId, projectId, kind };
          if (uploading) {
            if (next[0])
              await window.MotionLocalReferences.ready(localScope, next[0]);
          } else {
            const local = await window.MotionLocalReferences.access(localScope);
            if (local && !next.some((ref) => ref.fileId === local.ref?.fileId))
              await window.MotionLocalReferences.remove(localScope);
          }
          delete $(kind + "DropZone").dataset.referenceFailure;
          next.forEach((ref, index) => {
            if (previews[index])
              referencePreviewCache.set(`${kind}:${ref.fileId}`, {
                thumbnail: previews[index],
                corrected: null,
              });
          });
          saveStage = "render_saved_reference";
          await refresh();
          trace("reference_rendered");
          setReferenceStatus("");
          showSettingsSaved(
            motionText(
              "text123",
              "\u0110\xE3 l\u01B0u \u1EA3nh tham chi\u1EBFu. K\u1EBFt qu\u1EA3 Flow c\u0169 c\u1EA7n t\u1EA1o l\u1EA1i.",
            ),
          );
        },
      );
      return true;
    } catch (error) {
      const raw = String(error?.code || error?.message || "");
      const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
        ? raw
        : "MOTION_REF_SAVE_FAILED";
      trace("save_failed", code);
      console.warn(
        "[MotionReferenceSaveFailure]",
        JSON.stringify({
          kind,
          stage: saveStage,
          code,
          httpStatus: Number.isInteger(error?.httpStatus)
            ? error.httpStatus
            : null,
          validationFields: Object.keys(error?.details || {})
            .filter((key) =>
              /^references(?:\.(?:character|character2|background|mode))?(?:\.\d+)?(?:\.[a-z_]+)?$/.test(
                key,
              ),
            )
            .slice(0, 20),
        }),
      );
      const message = motionErrorMessage(error);
      $(kind + "DropZone").dataset.referenceFailure = message;
      setReferenceStatus(message);
      motionToast(message, { error: true });
      return false;
    } finally {
      uploadPreview.classList.remove("is-uploading");
      $(kind + "DropZone").removeAttribute("aria-busy");
      busy = false;
      renderReferences();
      updateButtons();
    }
  }
  let referenceInteractionSequence = 0;
  async function prepareReferenceInteraction(kind, source) {
    const operationId = `motion-ref-${Date.now()}-${++referenceInteractionSequence}`;
    const startedAt = Date.now();
    const trace = (stage, reason = null) =>
      console.info(
        "[MotionReferenceInteraction]",
        JSON.stringify({
          operationId,
          stage,
          kind,
          source,
          elapsedMs: Date.now() - startedAt,
          reason:
            reason == null
              ? null
              : /^[a-zA-Z][a-zA-Z0-9_:.-]{0,120}$/.test(reason)
                ? reason
                : "unclassified_error",
          scopeInvalid,
          busy,
          settingsLocked: motionSettingsRunLocked(),
          settingsPending: !!settingsSaveTimer || settingsDirty,
          profileReady: !!profile,
          pickerReady: !!window.imagePickerModal,
          bridgeReady: !!window.MessageBridge,
        }),
      );
    trace("start");
    try {
      if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (busy) throw new Error("PROJECT_ALREADY_EDITING");
      if (motionSettingsRunLocked()) throw new Error("MOTION_SETTINGS_LOCKED");
      if (!profile) {
        trace("profile_refresh");
        await refreshProfile({ required: true });
      }
      if (settingsSaveTimer || settingsDirty) {
        trace("settings_save");
        await saveMotionSettings();
        if (settingsSaveTimer || settingsDirty)
          throw new Error("MOTION_SETTINGS_NOT_SAVED");
      }
      if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (busy) throw new Error("PROJECT_ALREADY_EDITING");
      if (motionSettingsRunLocked()) throw new Error("MOTION_SETTINGS_LOCKED");
      if (!profile) throw new Error("MOTION_PROFILE_UNAVAILABLE");
      if (
        !window.MessageBridge ||
        (source === "picker" && !window.imagePickerModal)
      )
        throw new Error("MOTION_REFERENCE_PICKER_UNAVAILABLE");
      if (
        kind === "character2" &&
        (profile.settings?.show_two_characters !== true ||
          Number($("characterCount").value) !== 2)
      )
        throw new Error("MOTION_TWO_CHARACTERS_DISABLED");
      if (
        kind === "background" &&
        profile.settings?.show_background_refs === false
      )
        throw new Error("MOTION_BACKGROUND_REFERENCES_DISABLED");
      if (
        kind === "background" &&
        $("referenceMode").value !== "character_background"
      )
        throw new Error("MOTION_BACKGROUND_REFERENCES_DISABLED");
      trace("ready");
      return trace;
    } catch (error) {
      trace(
        "blocked",
        error?.code || error?.message || "MOTION_REFERENCE_UNAVAILABLE",
      );
      setReferenceStatus(motionErrorMessage(error));
      return null;
    }
  }
  async function openReferencePicker(kind) {
    const trace = await prepareReferenceInteraction(kind, "picker");
    if (!trace) return;
    referenceScanController?.abort();
    try {
      trace("target_lookup");
      const target = await getMotionFlowTarget();
      assertPinnedFlowTarget(target);
      const modelValue = effectiveFlowModel();
      const caps = window.ImagePickerModal.resolveCapsMulti({
        provider: "flow",
        mode: "video",
        isFrames: false,
        modelValue,
        duration: profile.settings?.flow_duration,
      });
      const otherCount = otherReferenceCount(kind);
      const totalImageSlots = Number.isInteger(caps.total)
        ? Math.max(0, caps.total - 1)
        : caps.image;
      const available =
        Math.min(caps.image ?? NaN, totalImageSlots ?? NaN) - otherCount;
      if (!Number.isFinite(available) || available < 0)
        throw new Error("MOTION_REF_CAP_CONFIG_UNAVAILABLE");
      const selected = references[kind] || [];
      const existingMedia = Object.fromEntries(
        selected.map((ref) => [ref.fileId, ref]),
      );
      const openedRevision = project.revision;
      const openedSourceRevision = Number(
        project.data_json?.source_revision || 0,
      );
      window.imagePickerModal.open({
        refAuditContext: { surface: "motion", toolProjectId: projectId },
        expectedFlowTarget: target,
        cleanFlowRefs: false,
        mediaFilter: "image",
        singleSelect: available > 0,
        maxSelections: Math.min(1, available),
        maxImageSelections: Math.min(1, available),
        maxVideoSelections: 0,
        maxTotalSelections: Math.min(1, available),
        existingFileIds: selected.map((ref) => ref.fileId),
        existingMedia,
        onConfirm: (items) => {
          void savePickedReferences(
            kind,
            items,
            target,
            openedRevision,
            openedSourceRevision,
            trace,
          );
        },
      });
      trace("picker_opened");
      setReferenceStatus("");
    } catch (error) {
      trace("failed", error?.code || error?.message);
      setReferenceStatus(motionErrorMessage(error));
    }
  }
  function revokeUrl(url) {
    if (url) URL.revokeObjectURL(url);
  }
  let stageCompareActive = false;
  function updateStageCompareButton() {
    const button = $("playBothVideos");
    if (!button) return;
    button.hidden = !stageResultUrl;
    button.disabled = !stageSourceUrl || !stageResultUrl;
    button.classList.toggle(
      "is-playing",
      stageCompareActive && !$("resultStageVideo").paused,
    );
  }
  function releaseStageMedia() {
    if (stageCompareActive) {
      $("sourceStageVideo").pause();
      $("resultStageVideo").pause();
    }
    stageCompareActive = false;
    for (const video of [$("sourceStageVideo"), $("resultStageVideo")]) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.hidden = true;
    }
    revokeUrl(stageSourceUrl);
    revokeUrl(stageResultUrl);
    stageSourceUrl = stageResultUrl = stageSourceKey = stageResultKey = null;
    updateStageCompareButton();
    $("sourcePlaceholder").hidden = false;
    $("resultPlaceholder").hidden = false;
  }
  function closeFrameDialog() {
    frameMediaEpoch++;
    $("frameDialogVideo").pause();
    $("frameDialogVideo").removeAttribute("src");
    $("frameDialogVideo").load();
    $("frameCompareSourceVideo").pause();
    $("frameCompareSourceVideo").removeAttribute("src");
    $("frameCompareSourceVideo").load();
    $("frameDialogAudio").pause();
    $("frameDialogAudio").removeAttribute("src");
    $("frameDialogAudio").load();
    $("frameDialogAudio").hidden = true;
    revokeUrl(frameDialogUrl);
    revokeUrl(frameDialogAudioUrl);
    revokeUrl(frameDialogSourceUrl);
    frameDialogSourceUrl = null;
    frameDialogUrl = frameDialogAudioUrl = null;
    selectedFrameId = null;
    if ($("frameDialog").open) $("frameDialog").close();
  }
  function motionTranscriptState(frame, locallyRunning) {
    const stage = frame?.stages?.transcribe;
    const state =
      locallyRunning || (stage?.worker && stage.state === "running")
        ? "running"
        : stage?.state === "failed"
          ? "failed"
          : frame?.transcript
            ? "ready"
            : "empty";
    return {
      state,
      retryCount: Number.isSafeInteger(stage?.worker?.retry_count)
        ? stage.worker.retry_count
        : 0,
      errorCode: stage?.error_code || null,
    };
  }
  function continuityStatusText(frame = null) {
    const extracting =
      activeMotionStage === "continuity" &&
      activeContinuityPhase === "extracting" &&
      (!frame || project?.data_json?.frames?.[activeMotionFrameId] === frame);
    return extracting
      ? window.VideoFrameExtractor.statusText("extracting")
      : motionText("continuityUpload", "Upload \u1EA3nh n\u1ED1i c\u1EA3nh");
  }
  function frameStage(frame, { resultOnly = false } = {}) {
    const stages = resultOnly
      ? Object.fromEntries(
          Object.entries(frame?.stages || {}).filter(([name]) =>
            ["split", "continuity", "submit", "monitor", "persist"].includes(
              name,
            ),
          ),
        )
      : frame?.stages || {};
    const labels = {
      split: motionText("text219", "c\u1EAFt video"),
      transcribe: motionText("text220", "l\u1EA5y l\u1EDDi tho\u1EA1i"),
      upload: motionText("text221", "t\u1EA3i l\xEAn Flow"),
      continuity: continuityStatusText(frame),
      submit: motionText("text222", "gen"),
      monitor: motionText("text222", "gen"),
      persist: motionText("text223", "l\u01B0u k\u1EBFt qu\u1EA3"),
    };
    const failure = Object.entries(stages).find(
      ([, value]) => value?.state === "failed",
    );
    if (failure)
      return {
        state:
          failure[0] === "persist" &&
          window.MotionFrameSteps.downloadWarning(frame)
            ? "warning"
            : "failed",
        label:
          failure[0] === "persist" &&
          window.MotionFrameSteps.downloadWarning(frame)
            ? motionText(
                "flowResultNotSaved",
                "\u0110\xE3 gen \xB7 Ch\u01B0a l\u01B0u video",
              )
            : motionText("text057", "L\u1ED7i"),
        stage: failure[0],
        data: failure[1],
      };
    if (window.MotionFrameSteps.downloadWarning(frame))
      return {
        state: "warning",
        label: motionText(
          "flowResultNotSaved",
          "\u0110\xE3 gen \xB7 Ch\u01B0a l\u01B0u video",
        ),
        stage: "persist",
        data: stages.persist,
      };
    for (const name of [
      "persist",
      "monitor",
      "submit",
      "continuity",
      "upload",
      "transcribe",
      "split",
    ]) {
      if (
        stages[name]?.state === "running" ||
        stages[name]?.state === "pending"
      ) {
        return {
          state: "running",
          label:
            name === "continuity"
              ? labels[name]
              : motionFormat("text224", "\u0110ang {0}...", [labels[name]]),
          stage: name,
          data: stages[name],
        };
      }
    }
    if (stages.persist?.state === "ready")
      return {
        state: "ready",
        label: motionText("text080", "K\u1EBFt qu\u1EA3 s\u1EB5n s\xE0ng"),
        stage: "persist",
      };
    if (stages.monitor?.state === "ready")
      return {
        state: "running",
        label: motionText("text081", "\u0110ang l\u01B0u video..."),
        stage: "persist",
      };
    if (stages.submit?.state === "ready")
      return {
        state: "running",
        label: motionText("text082", "\u0110ang theo d\xF5i Flow..."),
        stage: "monitor",
      };
    if (stages.split?.state === "ready")
      return {
        state: "waiting",
        label: motionText("text079", "Ch\u1EDD t\u1EA1o video..."),
        stage: "split",
      };
    return {
      state: "waiting",
      label: motionText("text083", "Ch\u1EDD x\u1EED l\xFD..."),
      stage: null,
    };
  }
  function motionErrorMessage(
    error,
    {
      videoUpload: uploadContext = false,
      includeUploadHint = true,
      transcript: transcriptContext = false,
    } = {},
  ) {
    const raw = String(
      error?.code ||
        error?.error_code ||
        error?.message ||
        error ||
        "MOTION_RUN_FAILED",
    ).trim();
    const match =
      /^(?:(f\d+):\s*)?(?:Error:\s*)?([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)$/.exec(
        raw,
      );
    const mappedType = match?.[2]
      ? window.FlowApiAdapter?.classifyError?.(match[2])
      : null;
    const quotaCategory = ["quota_exceeded", "per_model_daily"].includes(raw)
      ? raw
      : ["quota_exceeded", "per_model_daily"].includes(mappedType)
        ? mappedType
        : null;
    const code = match?.[2] || quotaCategory;
    const failedFrame = /^(f\d+):\s*/.exec(raw)?.[1];
    let diagnosticId = null;
    const failureStage =
      typeof activeMotionStage === "string" &&
      /^[a-z_]{1,40}$/.test(activeMotionStage)
        ? activeMotionStage
        : null;
    const errorName = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(error?.name || "")
      ? error.name
      : null;
    const flowWrapper =
      /^(?:(f\d+):\s*)?(?:Error:\s*)?(Google Flow:\s*.+)$/.exec(raw);
    const formattedFlow = flowWrapper
      ? window.FlowApiAdapter?.formatError?.(flowWrapper[2])
      : null;
    const translated = (key, params) => {
      const value = window.I18n?.t?.(key, params);
      return value && value !== key && value !== code ? value : null;
    };
    const runStateError =
      /^(?:ACCOUNT_|AUTH_|INVALID_ACCOUNT|PROJECT_|FRAME_(?:SCOPE|OPERATION|NOT)|MOTION_(?:TWO_CHARACTERS_|TWO_CHARACTER_|CHARACTER_|REF_|REFERENCES_REQUIRED$|REFERENCE_LIMIT_ONE$|DUPLICATE_REFERENCE$|BACKGROUND_DISABLED$|SETTINGS_|EXECUTION_|SOURCE_|RUN_|RUNNER_|PROFILE_|FRAME_|FLOW_(?:MODEL_UNAVAILABLE$|PROJECT|MODE|SCOPE|CONFIG|TARGET|RUNTIME|QUEUE)|UPLOAD_(?:CONFIG|SCOPE|CHECKPOINT)|TRANSCRIPT_|AUDIO_|SPLIT_|FEATURE_|BATCH_|WORKER_))/.test(
        code || "",
      );
    const videoUpload =
      !runStateError &&
      (uploadContext ||
        (code &&
          /^(?:MOTION_UPLOAD_|MOTION_CLIP_UPLOAD_|MOTION_FLOW_UPLOAD_|FLOW_API_VIDEO_UPLOAD_|MOTION_FLOW_MODE_CHANGED_DURING_UPLOAD$)/.test(
            code,
          )));
    const apiMessage =
      [400, 401, 402, 403, 404, 409, 422, 429].includes(error?.httpStatus) &&
      typeof error?.message === "string" &&
      error.message.trim() !== raw &&
      !/https?:\/\/|[<>]|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.test(error.message)
        ? error.message.trim()
        : null;
    const gatewayMessage =
      code === "FLOW_MEDIA_UUID_NOT_FOUND"
        ? window.flow_uuid_gateway?.formatErrorSync?.(code)
        : null;
    const serviceMessage =
      code === "HTTP_SERVICE_UNAVAILABLE"
        ? translated("dialog.offlineDescription")
        : null;
    const downloadMessage = [
      "FLOW_DOWNLOAD_RESOLUTION_UNAVAILABLE",
      "FLOW_DOWNLOAD_FILE_RESOLUTION_UNSUPPORTED",
      "DOWNLOAD_NOT_COMPLETED",
      "MOTION_FLOW_DOWNLOAD_FAILED",
      "MOTION_PERSIST_STAGE_MISSING",
    ].includes(code)
      ? translated("motionEditor.frameDownloadRetryHint")
      : null;
    const specificDescription =
      downloadMessage ||
      serviceMessage ||
      (formattedFlow && formattedFlow !== flowWrapper[2] && formattedFlow) ||
      (code &&
        ((gatewayMessage && gatewayMessage !== code && gatewayMessage) ||
          translated(`flowErrors.codes.${code}`))) ||
      (quotaCategory && translated(`gen.flowErr_${quotaCategory}`)) ||
      (code?.startsWith("PUBLIC_ERROR_") &&
        translated(`flowErrors.codes.${code.slice("PUBLIC_ERROR_".length)}`)) ||
      (code?.startsWith("PUBLIC_") &&
        translated("flowErrors.publicUnknownReason", { code })) ||
      (code?.startsWith("FRAME_VIDEO_") &&
        window.VideoFrameExtractor?.failureStatus?.({ code })) ||
      apiMessage ||
      (videoUpload && translated("motionEditor.videoUploadFailed"));
    const transcript =
      transcriptContext ||
      (typeof activeMotionStage === "string" &&
        ["transcribe", "transcript", "transcript_batch"].includes(
          activeMotionStage,
        ));
    const description =
      specificDescription ||
      (transcript && translated("motionEditor.transcriptFailed")) ||
      translated("motionEditor.errorGeneric") ||
      translated("common.error") ||
      "";
    if (!specificDescription) {
      try {
        const sourceLines = (stack) =>
          [
            ...new Set(
              [
                ...String(stack || "").matchAll(/MotionEditor\.js:(\d+):\d+/g),
              ].map((value) => Number(value[1])),
            ),
          ].slice(0, 4);
        const callerLines = sourceLines(new Error().stack);
        const diagnostic = {
          code: /^[A-Z][A-Z0-9_]{0,99}$/.test(code || "") ? code : null,
          errorName: /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(error?.name || "")
            ? error.name
            : null,
          httpStatus: Number.isInteger(error?.httpStatus)
            ? error.httpStatus
            : null,
          stage:
            typeof activeMotionStage === "string" ? activeMotionStage : null,
          frameId:
            failedFrame ||
            (typeof activeMotionFrameId === "string"
              ? activeMotionFrameId
              : null),
          sourceRevision:
            typeof project !== "undefined" &&
            Number.isSafeInteger(project?.data_json?.source_revision)
              ? project.data_json.source_revision
              : null,
          callerLines,
          originLines: sourceLines(error?.stack),
        };
        const signature = JSON.stringify(diagnostic);
        let fingerprint = 2166136261;
        for (const char of signature)
          fingerprint = Math.imul(fingerprint ^ char.charCodeAt(0), 16777619);
        diagnosticId = `MOTION-D${(fingerprint >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
        if (motionErrorMessage.lastFallbackDiagnostic !== signature) {
          motionErrorMessage.lastFallbackDiagnostic = signature;
          console.warn?.(
            "[MotionErrorPresentation]",
            JSON.stringify({ reference: diagnosticId, ...diagnostic }),
          );
        }
      } catch (_) {}
    }
    const hint =
      videoUpload && includeUploadHint
        ? translated("motionEditor.videoUploadAccountHint")
        : null;
    const frameId = failedFrame || flowWrapper?.[1];
    const uploadCode =
      videoUpload &&
      (code || (/^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw) ? raw : null));
    const scopeCode =
      code &&
      (/^MOTION_FLOW_(?:SCOPE|PROJECT|SOURCE|MODE|FRAME|SUBMIT_STATE|SUBMIT_MODE|PROFILE)_CHANGED$/.test(
        code,
      ) ||
        [
          "MOTION_SUBMIT_RECONCILE_REQUIRED",
          "MOTION_REGEN_RESET_UNVERIFIED",
          "MOTION_SETTINGS_LOCKED",
          "MOTION_EXECUTION_SETTINGS_CHANGED",
          "MOTION_EXECUTION_SCOPE_CHANGED",
        ].includes(code))
        ? code
        : null;
    const httpStatus =
      Number.isInteger(error?.httpStatus) &&
      error.httpStatus >= 100 &&
      error.httpStatus <= 599
        ? `HTTP ${error.httpStatus}`
        : null;
    const visibleCode =
      uploadCode ||
      scopeCode ||
      (/^[A-Z][A-Z0-9_]{0,99}$/.test(code || "") ? code : quotaCategory);
    const scopeDiagnostic =
      error?.apiDiagnostic ||
      (typeof externalMotionRun !== "undefined" &&
      externalMotionRun?.apiDiagnostic?.code === code
        ? externalMotionRun?.apiDiagnostic
        : null);
    const submitState = [
      "pending",
      "running",
      "ready",
      "failed",
      "needs_review",
    ].includes(scopeDiagnostic?.submitState)
      ? scopeDiagnostic.submitState
      : null;
    const checkpointState =
      submitState || (scopeDiagnostic?.submitState === null ? "\u2205" : null);
    const checkpointDetail =
      code === "MOTION_FLOW_SUBMIT_STATE_CHANGED" && checkpointState
        ? `submit: running \u2192 ${checkpointState}`
        : null;
    const providerCode = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(
      scopeDiagnostic?.providerCode || "",
    )
      ? scopeDiagnostic.providerCode
      : null;
    const providerDetail =
      providerCode && providerCode !== code
        ? translated(`flowErrors.codes.${providerCode}`) || providerCode
        : null;
    const reference =
      code === "MOTION_FLOW_MODEL_UNAVAILABLE" ||
      /^MOTION_(?:REF_|DUPLICATE_REFERENCE)/.test(code || "")
        ? error?.referenceDiagnostic ||
          (typeof externalMotionRun !== "undefined" &&
          externalMotionRun?.error === code
            ? externalMotionRun.referenceDiagnostic
            : null)
        : null;
    const refNumber = (value) =>
      Number.isSafeInteger(value) && value >= 0 ? value : "\u2205";
    const referenceDetail =
      reference &&
      [
        "CAP_CONFIG_INVALID",
        "VIDEO_REF_LIMIT",
        "IMAGE_REF_LIMIT",
        "TOTAL_REF_LIMIT",
        "REFERENCE_FILTERED",
        "REFERENCE_IDENTITY_CHANGED",
        "REFERENCE_DUPLICATE",
        "REFERENCE_OTHER_PROJECT",
        "MODEL_UNAVAILABLE",
      ].includes(reference.reason)
        ? `${reference.reason} \xB7 \u{1F5BC} ${refNumber(reference.imageCount)}/${refNumber(reference.imageCap)} \xB7 \u{1F39E} ${refNumber(reference.videoCount)}/${refNumber(reference.videoCap)} \xB7 \u2211 ${Number.isSafeInteger(reference.imageCount) && Number.isSafeInteger(reference.videoCount) ? reference.imageCount + reference.videoCount : "\u2205"}/${refNumber(reference.totalCap)}`
        : null;
    const detail = [
      visibleCode && !description.includes(visibleCode) ? visibleCode : null,
      httpStatus,
      !specificDescription && !visibleCode
        ? errorName || "MOTION_UNCLASSIFIED_ERROR"
        : null,
      !specificDescription ? failureStage : null,
      !specificDescription && !visibleCode ? diagnosticId : null,
      checkpointDetail,
      providerDetail,
      referenceDetail,
    ]
      .filter(Boolean)
      .join(" \xB7 ");
    return [
      frameId ? `${frameId}:` : null,
      description,
      detail ? `(${detail})` : null,
      hint,
    ]
      .filter(Boolean)
      .join(" ");
  }
  function showVideoUploadFailure(error, frameId = null) {
    const code = String(
      error?.code || error?.message || error || "MOTION_UPLOAD_FAILED",
    );
    if (
      scopeInvalid ||
      cancelled ||
      [
        "MOTION_CANCELLED",
        "ABORTED",
        "UPLOAD_STOPPED",
        "ACCOUNT_SCOPE_CHANGED",
        "FRAME_SCOPE_CHANGED",
      ].includes(code)
    )
      return;
    const message = [
      frameId,
      motionErrorMessage(error, {
        videoUpload: true,
        includeUploadHint: false,
      }),
    ]
      .filter(Boolean)
      .join(": ");
    if (
      /^(?:ACCOUNT_|AUTH_|INVALID_ACCOUNT|PROJECT_|FRAME_(?:SCOPE|OPERATION|NOT)|MOTION_(?:TWO_CHARACTERS_|TWO_CHARACTER_|CHARACTER_|REF_|REFERENCES_REQUIRED$|REFERENCE_LIMIT_ONE$|DUPLICATE_REFERENCE$|BACKGROUND_DISABLED$|SETTINGS_|EXECUTION_|SOURCE_|RUN_|RUNNER_|PROFILE_|FRAME_|FLOW_(?:MODEL_UNAVAILABLE$|PROJECT|MODE|SCOPE|CONFIG|TARGET|RUNTIME|QUEUE)|UPLOAD_(?:CONFIG|SCOPE|CHECKPOINT)|TRANSCRIPT_|AUDIO_|SPLIT_|FEATURE_|BATCH_|WORKER_))/.test(
        code,
      )
    )
      return window.customDialog?.alert?.(message, {
        title: "Motion",
        type: "error",
      });
    return window.customDialog?.videoUploadFailure?.(message);
  }
  function motionFailureMessage(value) {
    return window.MotionFailureNotice.format(value, {
      errorMessage: motionErrorMessage,
      text: motionText,
      format: motionFormat,
    });
  }
  function errorDescription(stage) {
    if (!stage || stage.state !== "failed") return "";
    const code = String(stage.data?.error_code || "UNKNOWN_ERROR");
    const labels = {
      split: motionText("text219", "c\u1EAFt video"),
      transcribe: motionText("text220", "l\u1EA5y l\u1EDDi tho\u1EA1i"),
      upload: motionText("text221", "t\u1EA3i l\xEAn Flow"),
      continuity: motionText(
        "continuityUpload",
        "Upload \u1EA3nh n\u1ED1i c\u1EA3nh",
      ),
      submit: motionText("text222", "gen"),
      monitor: motionText("text222", "gen"),
      persist: motionText("text223", "l\u01B0u k\u1EBFt qu\u1EA3"),
    };
    return [
      labels[stage.stage],
      motionErrorMessage(code, { videoUpload: stage.stage === "upload" }),
    ]
      .filter(Boolean)
      .join(": ");
  }
  function timelineError(stage) {
    const code = String(stage?.data?.error_code || "UNKNOWN_ERROR");
    return motionErrorMessage(code, { videoUpload: stage?.stage === "upload" });
  }
  async function setStageVideo(kind, key, blob) {
    const source = kind === "source";
    const currentKey = source ? stageSourceKey : stageResultKey;
    if (currentKey === key) return;
    if (stageCompareActive) {
      $("sourceStageVideo").pause();
      $("resultStageVideo").pause();
    }
    stageCompareActive = false;
    const video = $(source ? "sourceStageVideo" : "resultStageVideo");
    const placeholder = $(source ? "sourcePlaceholder" : "resultPlaceholder");
    const oldUrl = source ? stageSourceUrl : stageResultUrl;
    video.pause();
    video.removeAttribute("src");
    video.load();
    revokeUrl(oldUrl);
    if (source) {
      stageSourceUrl = null;
      stageSourceKey = key;
    } else {
      stageResultUrl = null;
      stageResultKey = key;
    }
    if (blob) {
      const url = URL.createObjectURL(blob);
      video.src = url;
      video.hidden = false;
      placeholder.hidden = true;
      if (source) stageSourceUrl = url;
      else stageResultUrl = url;
    } else {
      video.hidden = true;
      placeholder.hidden = false;
    }
    updateStageCompareButton();
  }
  async function refreshStageVideos(sourceRevision, final) {
    const sourceKey = `source:${sourceRevision}`;
    if (pendingSourceFile) {
      if (!stageSourceUrl)
        await setStageVideo(
          "source",
          `pending:${Date.now()}`,
          pendingSourceFile,
        );
    } else if (sourceRevision > 0 && stageSourceKey !== sourceKey) {
      const record = await MotionArtifactStore.get({
        userId,
        toolProjectId: projectId,
        sourceRevision,
        kind: "source_video",
      });
      if (
        scopeInvalid ||
        Number(project?.data_json?.source_revision || 0) !== sourceRevision
      )
        return;
      await setStageVideo("source", sourceKey, record?.blob || null);
    } else if (sourceRevision < 1)
      await setStageVideo("source", "source:none", null);
    const finalKey = final
      ? `final:${sourceRevision}:${final.artifact_revision}`
      : `final:none:${sourceRevision}`;
    if (stageResultKey !== finalKey) {
      const record = final
        ? await MotionArtifactStore.get({
            userId,
            toolProjectId: projectId,
            sourceRevision,
            kind: "merged_video",
            artifactRevision: Number(final.artifact_revision),
          })
        : null;
      if (
        scopeInvalid ||
        Number(project?.data_json?.source_revision || 0) !== sourceRevision ||
        (final &&
          Number(project.data_json?.final?.artifact_revision) !==
            Number(final.artifact_revision))
      )
        return;
      await setStageVideo("result", finalKey, record?.blob || null);
    }
  }
  function motionToast(
    message,
    { persistent = false, error = false, loading = false } = {},
  ) {
    let toast = $("motionProcessToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "motionProcessToast";
      toast.className = "tobyflow-notification success";
      toast.innerHTML =
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg><span></span>';
      toast.setAttribute("role", "status");
      document.body.append(toast);
      toast.addEventListener("mouseenter", () => clearTimeout(toastTimer));
      toast.addEventListener("mouseleave", () => {
        if (toast.dataset.persistent !== "true")
          toastTimer = setTimeout(
            () => toast.classList.remove("is-visible"),
            1500,
          );
      });
    }
    toast.dataset.persistent = String(persistent);
    toast.classList.toggle("is-loading", loading && !error);
    toast
      .querySelector("path")
      .setAttribute(
        "d",
        loading && !error
          ? "M21 12a9 9 0 1 1-9-9"
          : error
            ? "m6 6 12 12M6 18 18 6"
            : "m5 12 4 4L19 6",
      );
    toast.classList.toggle("success", !error);
    toast.classList.toggle("error", error);
    toast.querySelector("span").textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    if (!persistent)
      toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4e3);
  }
  function status(
    message,
    { state: explicitState = null, notify = true } = {},
  ) {
    const text = String(message?.code || message?.message || message || "");
    const isCode =
      /^(?:(f\d+):\s*)?(?:Error:\s*)?[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(text);
    const display = isCode ? motionErrorMessage(text) : text;
    $("status").textContent = display;
    $("status").title = display;
    const state = explicitState
      ? {
          preparing: "running",
          pausing: "running",
          stopped: "paused",
          cancelled: "paused",
          needs_review: "warning",
          sync_pending: "warning",
        }[explicitState] || explicitState
      : text === "MOTION_CANCELLED"
        ? "paused"
        : isCode
          ? "failed"
          : /(?:không|thất bại|lỗi|failed|error|required|unavailable|invalid|mismatch)/i.test(
                text,
              )
            ? "failed"
            : /(?:đang|processing|running|saving|uploading|generating|splitting)/i.test(
                  text,
                )
              ? "running"
              : /(?:đã|sẵn sàng|thành công|ready|completed|saved)/i.test(text)
                ? "ready"
                : "waiting";
    $("status").closest(".activity-copy").dataset.state = state;
    if (
      notify &&
      $("motionProcessToast")?.dataset.persistent !== "true" &&
      /^(Đang|Đã|Sẵn sàng|Saving|Saved|Ready|Uploading|Uploaded|Downloading|Merging|Merged|Splitting|Created)/i.test(
        text,
      )
    )
      motionToast(message);
  }
  function renderAudioTile(
    tile,
    frameId,
    ready,
    sourceRevision,
    suppliedBlob = null,
  ) {
    tile.replaceChildren();
    const audioState =
      project?.data_json?.frames?.[frameId]?.stages?.split?.audio_state;
    const missingLabel =
      audioState === "audio_decode_unsupported"
        ? motionErrorMessage("AUDIO_DECODE_UNSUPPORTED")
        : audioState === "audio_not_requested" || !audioState
          ? motionText(
              "text175",
              "Ch\u01B0a c\xF3 audio c\u1EE7a frame. D\xF9ng menu Audio \u0111\u1EC3 t\u1EA1o l\u1EA1i audio t\u1EA5t c\u1EA3 frame.",
            )
          : motionText("text104", "Kh\xF4ng c\xF3 audio");
    tile.setAttribute(
      "aria-label",
      `${frameId} \xB7 ${ready ? "Ph\xE1t audio" : missingLabel}`,
    );
    if (!ready) {
      tile.textContent = missingLabel;
      return;
    }
    const wave = document.createElement("canvas");
    wave.className = "audio-wave";
    wave.setAttribute("aria-hidden", "true");
    wave.width = 180;
    wave.height = 30;
    tile.append(wave);
    const expectedUserId = userId;
    audioWaveJobs = audioWaveJobs
      .catch(() => {})
      .then(async () => {
        if (!tile.isConnected || scopeInvalid || userId !== expectedUserId)
          return;
        const record = suppliedBlob
          ? { blob: suppliedBlob }
          : await MotionArtifactStore.get({
              userId: expectedUserId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              kind: "source_audio",
            });
        if (
          !record?.blob ||
          !tile.isConnected ||
          scopeInvalid ||
          userId !== expectedUserId
        )
          return;
        const AudioContextClass =
          window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        const context = new AudioContextClass();
        try {
          const audio = await context.decodeAudioData(
            await record.blob.arrayBuffer(),
          );
          if (!tile.isConnected || scopeInvalid || userId !== expectedUserId)
            return;
          const drawing = wave.getContext("2d");
          if (!drawing) return;
          drawing.clearRect(0, 0, wave.width, wave.height);
          drawing.fillStyle =
            getComputedStyle(tile).getPropertyValue("--success").trim() ||
            "currentColor";
          const channels = Array.from(
            { length: audio.numberOfChannels },
            (_, index) => audio.getChannelData(index),
          );
          const count = 60;
          for (let bar = 0; bar < count; bar++) {
            const start = Math.floor((bar * audio.length) / count);
            const end = Math.floor(((bar + 1) * audio.length) / count);
            let peak = 0;
            for (
              let sample = start;
              sample < end;
              sample += Math.max(1, Math.floor((end - start) / 128))
            ) {
              for (const channel of channels)
                peak = Math.max(peak, Math.abs(channel[sample] || 0));
            }
            const height = Math.max(2, Math.min(28, peak * 28));
            drawing.fillRect(bar * 3, (30 - height) / 2, 1.5, height);
          }
        } finally {
          await context.close().catch(() => {});
        }
      })
      .catch((error) =>
        console.warn("[Motion] Audio waveform unavailable", error?.message),
      );
  }
  function formatBytes(bytes) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  let projectChangeTimer = null;
  async function api(method, path, data = null) {
    if (
      data?.stage === "submit" &&
      data.state === "running" &&
      project?.data_json?.preferences?.character_count === 2
    )
      data = { ...data, character_count: 2 };
    const startupRead = method === "GET" && path === endpoint && !settingsReady;
    let result;
    for (let attempt = 0; ; attempt++) {
      if (
        startupRead &&
        (scopeInvalid || Number(window.authManager.getUser?.()?.id) !== userId)
      )
        throw Object.assign(new Error("ACCOUNT_SCOPE_CHANGED"), {
          code: "ACCOUNT_SCOPE_CHANGED",
        });
      try {
        result = await window.authManager._apiCall(method, path, data);
        if (
          startupRead &&
          (scopeInvalid ||
            Number(window.authManager.getUser?.()?.id) !== userId)
        )
          throw Object.assign(new Error("ACCOUNT_SCOPE_CHANGED"), {
            code: "ACCOUNT_SCOPE_CHANGED",
          });
        break;
      } catch (error) {
        if (
          !startupRead ||
          error?.code !== "HTTP_SERVICE_UNAVAILABLE" ||
          ![502, 503, 504].includes(Number(error.httpStatus)) ||
          attempt >= 2
        ) {
          if (startupRead) error.motionBootStage = "project_read";
          throw error;
        }
        console.info(
          "[MotionBoot]",
          JSON.stringify({
            stage: "project_read",
            state: "retrying",
            code: error.code,
            httpStatus: error.httpStatus,
            attempt: attempt + 1,
          }),
        );
        await new Promise((resolve) =>
          setTimeout(resolve, attempt === 0 ? 500 : 1200),
        );
      }
    }
    if (method !== "GET" && path.startsWith(endpoint) && !scopeInvalid) {
      clearTimeout(projectChangeTimer);
      projectChangeTimer = setTimeout(() => {
        if (scopeInvalid) return;
        chrome.storage.local
          .set({
            motion_project_changed: {
              userId,
              projectId,
              nonce: crypto.randomUUID(),
            },
          })
          .catch((error) =>
            console.warn(
              "[Motion] Project list notification failed",
              error?.message,
            ),
          );
      }, 250);
    }
    return result;
  }
  function closePreview() {
    $("previewVideo").pause();
    $("previewVideo").removeAttribute("src");
    $("previewVideo").load();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if ($("previewDialog").open) $("previewDialog").close();
  }
  function playBlob(blob, title, { final = false } = {}) {
    closePreview();
    $("previewDialog").classList.toggle("is-final-preview", final);
    previewUrl = URL.createObjectURL(blob);
    $("previewTitle").textContent = title;
    $("previewVideo").src = previewUrl;
    $("previewDialog").showModal();
    $("previewVideo")
      .play()
      .catch(() => {});
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 6e4);
  }
  async function mediaAction(frameId, kind, action) {
    if (scopeInvalid || busy) return;
    const sourceRevision = Number(project?.data_json?.source_revision || 0);
    const expectedUserId = userId;
    const record = await MotionArtifactStore.get({
      userId,
      toolProjectId: projectId,
      sourceRevision,
      frameId,
      kind,
      artifactRevision:
        kind === "generated_clip"
          ? generatedPreviewRevisions.get(frameId) || 1
          : 1,
    });
    if (
      scopeInvalid ||
      userId !== expectedUserId ||
      Number(project?.data_json?.source_revision || 0) !== sourceRevision
    )
      return;
    if (
      kind === "source_clip" &&
      record?.uploadReceipt &&
      action === "download"
    ) {
      await openSourceFlowDownload(frameId, record);
      return;
    }
    if (!record?.blob && kind === "source_clip" && record?.uploadReceipt) {
      const url = await resolveUploadedSource(record);
      if (
        !url ||
        scopeInvalid ||
        userId !== expectedUserId ||
        Number(project?.data_json?.source_revision || 0) !== sourceRevision
      ) {
        status(
          motionText(
            "text121",
            "Kh\xF4ng t\xECm th\u1EA5y video ngu\u1ED3n tr\xEAn Flow.",
          ),
        );
        return;
      }
      if (action === "play") {
        await openFrameDialog(frameId, kind);
        return;
      }
      const filename = await window.DownloadHelper.buildMotionFilename(
        project,
        { frameId, kind },
      );
      const result = await chrome.runtime.sendMessage({
        action: "chromeDownload",
        url,
        filename,
        waitForComplete: true,
      });
      if (!result?.success)
        throw new Error(result?.error || "MOTION_SOURCE_DOWNLOAD_FAILED");
      return;
    }
    if (!record?.blob) {
      status(
        motionText(
          "text120",
          "Kh\xF4ng t\xECm th\u1EA5y video local c\u1EE7a frame n\xE0y.",
        ),
      );
      return;
    }
    if (action === "play") {
      playBlob(
        record.blob,
        `${frameId} \xB7 ${kind === "source_clip" ? motionText("text084", "Clip ngu\u1ED3n") : motionText("text165", "K\u1EBFt qu\u1EA3 Flow")}`,
      );
      return;
    }
    saveBlob(
      record.blob,
      `${project.name.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60)}_${frameId}_${kind}.mp4`,
    );
  }
  async function openSourceFlowDownload(frameId, record) {
    const receipt = record?.uploadReceipt,
      frame = project?.data_json?.frames?.[frameId];
    if (!receipt || !frame || receipt.projectId !== project.flow_project_id)
      throw new Error("MOTION_FLOW_RECEIPT_INVALID");
    const expected = {
      userId,
      sourceRevision: Number(project.data_json.source_revision),
      runId: frame.run_id,
      inputRevision: frame.input_revision,
      projectId: project.flow_project_id,
    };
    const mediaId = receipt.mediaUuid || receipt.mediaId;
    const fileName = receipt.persistentMediaId || receipt.fileName || "";
    const assertCurrent = async () => {
      if (
        scopeInvalid ||
        userId !== expected.userId ||
        project?.flow_project_id !== expected.projectId ||
        Number(project?.data_json?.source_revision) !==
          expected.sourceRevision ||
        project.data_json.frames?.[frameId]?.run_id !== expected.runId ||
        project.data_json.frames[frameId].input_revision !==
          expected.inputRevision
      )
        throw new Error("FRAME_SCOPE_CHANGED");
      assertPinnedFlowTarget(await getMotionFlowTarget());
    };
    await window.storageSettings.init();
    await window.featureGate.init();
    await assertCurrent();
    await window.DownloadHelper.showModal({
      tileId: mediaId,
      fileName,
      flowFileId: receipt.mediaId,
      mediaType: "video",
      taskName: project.name,
      promptText: frameId,
      index: 1,
      projectId: expected.projectId,
      apiOnly: true,
      apiDownload: async ({ resolution, watermarkMode, abortFn, signal }) => {
        await assertCurrent();
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        const filename = await window.DownloadHelper.buildMotionFilename(
          project,
          { frameId, kind: "source_clip" },
        );
        const mode = window.MotionFlowDownload.downloadMode("api");
        if (window.flow_uuid_gateway)
          await window.flow_uuid_gateway.requireDownload([mediaId], {
            mode,
            projectId: expected.projectId,
            surface: "motion",
            mediaType: "video",
            signal,
            abortFn,
          });
        console.info(
          "[MotionSourceDownload]",
          JSON.stringify({
            frameId,
            stage: "download",
            mode,
            resolution,
            hasUuid: !!receipt.mediaUuid,
          }),
        );
        if (mode === "web") {
          const target = await getMotionFlowTarget();
          assertPinnedFlowTarget(target);
          const currentReceipt = await correctUploadedSourceReceipt(
            record,
            target,
            { persist: false },
          );
          await assertCurrent();
          if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
          const currentFileName =
            currentReceipt.persistentMediaId ||
            currentReceipt.fileName ||
            fileName;
          console.info(
            "[MotionSourceDownload]",
            JSON.stringify({
              frameId,
              stage: "catalog_identity",
              hasUuid: !!currentReceipt.mediaUuid,
              hasAsb: !!currentFileName,
              refreshed: currentFileName !== fileName,
            }),
          );
          const requestId = crypto.randomUUID();
          const cancel = () => {
            void MessageBridge.sendToContentScript("cancelTileMediaDownload", {
              requestId,
            }).catch(() => {});
          };
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            const result = await MessageBridge.downloadTileMedia(
              mediaId,
              frameId,
              project.name,
              currentFileName,
              resolution,
              receipt.mediaId,
              null,
              resolution,
              watermarkMode,
              filename,
              requestId,
            );
            if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
            const completed =
              window.flow_uuid_gateway?.downloadSucceeded?.(result) ??
              (result === true || result?.success === true);
            if (!completed)
              throw new Error(result?.error || "MOTION_SOURCE_DOWNLOAD_FAILED");
            return result === true ? { success: true } : result;
          } finally {
            signal?.removeEventListener("abort", cancel);
          }
        }
        const health = await window.FlowApiSessionCoordinator.check({
          projectId: expected.projectId,
          surface: "workflow",
          mediaType: "video",
          passive: true,
        });
        if (health?.ready !== true || !["v1", "v2"].includes(health.driver))
          throw new Error("FLOW_API_NOT_READY");
        if (health.projectId && health.projectId !== expected.projectId)
          throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
        let protocol = {};
        if (health.driver === "v2") {
          const config =
            await window.ProviderConfigManager.fetchFlowApiV2Configs();
          const fingerprint =
            window.FlowApiV2CheckpointStore.fingerprint(config);
          if (!config || !fingerprint)
            throw new Error("FLOW_API_V2_CONFIG_MISSING");
          protocol = {
            uuidLookup: true,
            protocolRevision: Number(config.protocol?.schema_version),
            protocolFingerprint: fingerprint,
          };
        }
        await assertCurrent();
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        const input = {
          mediaId,
          projectId: expected.projectId,
          mediaType: "video",
          surface: "workflow",
          apiDriver: health.driver,
          ...protocol,
          ratio: project.data_json?.preferences?.ratio || null,
          abortFn,
        };
        const selected = await window.MotionResolutionPolicy.resolveBest(
          window.ProviderConfigManager.getDownloadResolutionsSync("flow"),
          resolution,
          {
            resolveNative: async () => {
              const result = await window.FlowApiFacade.resolveDownload(input);
              return result?.url
                ? { ok: true, url: result.url }
                : { ok: false, error: "MOTION_FLOW_NATIVE_URL_MISSING" };
            },
            upscale: (option) =>
              window.FlowApiFacade.upscaleVideo({
                ...input,
                resolution: option.value,
              }),
          },
        );
        const url = selected.videoUrl || selected.url;
        if (!/^https:\/\//i.test(String(url || "")))
          throw new Error("MOTION_FLOW_VIDEO_URL_INVALID");
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        let response = await fetch(url, {
          credentials: "omit",
          cache: "no-store",
          signal,
        });
        if (
          response.status === 401 &&
          /^https:\/\/flow\.google\.com\/asb\//i.test(url)
        )
          response = await fetch(url, {
            credentials: "include",
            cache: "no-store",
            signal,
          });
        if (!response.ok)
          throw new Error(`FLOW_DOWNLOAD_HTTP_${response.status}`);
        let blob = await response.blob();
        if (!blob.size || !/^video\//i.test(blob.type))
          throw new Error("MOTION_FLOW_VIDEO_INVALID");
        const clean =
          watermarkMode === "clean" ||
          (watermarkMode === "inherit" &&
            [true, 1, "1"].includes(
              window.storageSettings.getSettings()?.autoRemoveWatermarkVideo,
            ));
        if (clean) {
          const result = await window.DownloadHelper.cleanMediaBlob(
            blob,
            "video",
            { force: true },
          );
          if (!result.cleaned && !result.noWatermark)
            throw new Error(result.reason || "VIDEO_WM_NOT_APPLIED");
          blob = result.blob;
        }
        await assertCurrent();
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        const localUrl = URL.createObjectURL(blob);
        try {
          const saved = await chrome.runtime.sendMessage({
            action: "chromeDownload",
            url: localUrl,
            filename,
            waitForComplete: true,
          });
          if (!saved?.success)
            throw new Error(saved?.error || "MOTION_SOURCE_DOWNLOAD_FAILED");
        } finally {
          URL.revokeObjectURL(localUrl);
        }
        return { success: true, resolution: selected.resolution };
      },
    });
  }
  function openFlowDownload(frameId) {
    const frame = project?.data_json?.frames?.[frameId];
    const monitor = frame?.stages?.monitor;
    const mode = monitor?.flow_mode;
    if (
      scopeInvalid ||
      !frame ||
      monitor?.state !== "ready" ||
      !["web", "api"].includes(mode) ||
      (!monitor.provider_operation_id &&
        !(mode === "web" && monitor.manual_result === true)) ||
      !monitor.provider_media_id ||
      !resolutions.length ||
      (mode === "api" && !monitor.api_driver)
    )
      return;
    const select = $("frameFlowResolution");
    select.replaceChildren();
    for (const option of resolutions) {
      const row = document.createElement("option");
      row.value = option.value;
      row.textContent = option.label;
      select.append(row);
    }
    select.value = MotionResolutionPolicy.preferredValue(
      resolutions,
      project.data_json?.preferences?.flow_download_resolution,
    );
    $("flowDownloadTitle").textContent = motionFormat(
      "text216",
      "T\u1EA3i video Flow \xB7 {0}",
      [mode.toUpperCase()],
    );
    $("confirmFlowDownload").textContent = motionText(
      "text077",
      "T\u1EA3i v\xE0 l\u01B0u frame",
    );
    $("flowDownloadStatus").textContent =
      mode === "api"
        ? motionText(
            "text246",
            "Ch\u1ECDn \u0111\u1ED9 ph\xE2n gi\u1EA3i. N\u1EBFu kh\xF4ng kh\u1EA3 d\u1EE5ng, Flow s\u1EBD th\u1EED m\u1EE9c th\u1EA5p h\u01A1n.",
          )
        : motionText(
            "text247",
            "Flow Web l\u01B0u video g\u1ED1c v\xE0o project; \u0111\u1ED9 ph\xE2n gi\u1EA3i th\u1EF1c t\u1EBF theo b\u1EA3n g\u1ED1c c\u1EE7a Flow.",
          );
    $("flowDownloadDialog").dataset.frameId = frameId;
    $("flowDownloadDialog").showModal();
  }
  async function replaceDownloadedFrame(frameId, expected, blob, resolution) {
    if (
      !(blob instanceof Blob) ||
      blob.size < 12 ||
      !/^video\//i.test(blob.type)
    )
      throw new Error("MOTION_FLOW_VIDEO_INVALID");
    const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    if (String.fromCharCode(...header.slice(4, 8)) !== "ftyp")
      throw new Error("MOTION_FLOW_VIDEO_INVALID");
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    await navigator.locks.request(
      `motion:${userId}:${projectId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
        await refresh();
        const frame = project?.data_json?.frames?.[frameId];
        if (
          scopeInvalid ||
          Number(project?.data_json?.source_revision) !==
            expected.sourceRevision ||
          project?.flow_project_id !== expected.flowProjectId ||
          frame?.run_id !== expected.runId ||
          Number(frame?.input_revision) !== expected.inputRevision ||
          frame?.stages?.monitor?.provider_media_id !== expected.mediaId ||
          frame?.stages?.monitor?.provider_operation_id !== expected.operationId
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        const scope = {
          userId,
          toolProjectId: projectId,
          sourceRevision: expected.sourceRevision,
          frameId,
          kind: "generated_clip",
          artifactRevision: expected.inputRevision,
        };
        const previous = await MotionArtifactStore.get(scope);
        const previousFinal = project.data_json?.final;
        const artifactId =
          frame.stages?.persist?.artifact_id ||
          `result_${expected.sourceRevision}_${frameId}_${expected.inputRevision}`;
        const mediaUuid =
          window.MotionFlowDownload?._mediaUuid?.(expected.mediaId) || null;
        await MotionArtifactStore.put({
          ...scope,
          flowProjectId: expected.flowProjectId,
          blob,
          resolution,
          media_uuid: mediaUuid,
          persistent_media_id: mediaUuid
            ? frame.stages.monitor.persistent_media_id ||
              (previous?.media_uuid === expected.mediaId
                ? previous.persistent_media_id
                : null) ||
              null
            : null,
        });
        try {
          await api(
            "PATCH",
            `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
            {
              source_revision: expected.sourceRevision,
              run_id: expected.runId,
              input_revision: expected.inputRevision,
              stage: "persist",
              state: "ready",
              artifact_id: artifactId,
              resolution,
              replace_existing: frame.stages?.persist?.state === "ready",
            },
          );
        } catch (error) {
          const fresh = await api("GET", endpoint).catch(() => null);
          const saved = fresh?.data_json?.frames?.[frameId]?.stages?.persist;
          if (!fresh) throw error;
          if (
            saved?.state !== "ready" ||
            saved.artifact_id !== artifactId ||
            saved.resolution !== resolution
          ) {
            if (previous?.blob)
              await MotionArtifactStore.put({
                ...scope,
                flowProjectId: expected.flowProjectId,
                blob: previous.blob,
                resolution: previous.resolution || null,
                duration: previous.duration || null,
                media_uuid: previous.media_uuid || null,
                persistent_media_id: previous.persistent_media_id || null,
              });
            else await MotionArtifactStore.delete(scope);
            throw error;
          }
        }
        await refresh();
        if (
          project?.data_json?.frames?.[frameId]?.stages?.persist?.state ===
            "ready" &&
          Number(project.data_json.frames[frameId].input_revision) ===
            expected.inputRevision
        ) {
          await cleanupInvalidatedFrameArtifacts(
            frameId,
            expected.sourceRevision,
            expected.inputRevision - 1,
            null,
          ).catch((error) =>
            console.warn(
              "[Motion] Superseded frame cleanup failed",
              error?.message,
            ),
          );
        }
        if (previousFinal && !project.data_json?.final)
          await MotionArtifactStore.delete({
            userId,
            toolProjectId: projectId,
            sourceRevision: expected.sourceRevision,
            kind: "merged_video",
            artifactRevision: Number(previousFinal.artifact_revision),
          }).catch((error) =>
            console.warn(
              "[MotionDownload] Final cleanup failed",
              error?.message,
            ),
          );
        if (selectedFrameId === frameId && $("frameDialog").open)
          await showFrameVideo(frameId, "generated_clip");
      },
    );
  }
  async function openDirectFlowDownload(frameId) {
    const frame = project?.data_json?.frames?.[frameId];
    const monitor = frame?.stages?.monitor;
    const mode = monitor?.flow_mode;
    if (
      !scopeInvalid &&
      (!monitor || monitor.state !== "ready") &&
      generatedPreviewRevisions.has(frameId)
    ) {
      await mediaAction(frameId, "generated_clip", "download");
      return;
    }
    if (
      scopeInvalid ||
      !monitor ||
      monitor.state !== "ready" ||
      !["web", "api"].includes(mode) ||
      !monitor.provider_media_id ||
      (!monitor.provider_operation_id &&
        !(mode === "web" && monitor.manual_result === true))
    )
      throw new Error("MOTION_MONITOR_RECEIPT_REQUIRED");
    await window.storageSettings.init();
    await window.featureGate.init();
    const mediaId = monitor.provider_media_id;
    const projectIdForDownload = project.flow_project_id;
    const projectName = project.name;
    const expected = {
      sourceRevision: Number(project.data_json?.source_revision),
      runId: frame.run_id,
      inputRevision: Number(frame.input_revision),
      mediaId,
      operationId: monitor.provider_operation_id,
      flowProjectId: projectIdForDownload,
    };
    await window.DownloadHelper.showModal({
      tileId: mediaId,
      mediaType: "video",
      taskName: projectName,
      promptText: frameId,
      index: 1,
      projectId: projectIdForDownload,
      apiOnly: true,
      apiDownload: async ({
        resolution,
        watermarkMode,
        plannedFilename,
        abortFn,
        signal,
      }) => {
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        const target = await getMotionFlowTarget();
        assertPinnedFlowTarget(target);
        if (target.projectId !== projectIdForDownload)
          throw new Error("MOTION_FLOW_PROJECT_MISMATCH");
        const settings = await window.DownloadHelper.getSettings();
        const filename = await window.DownloadHelper.buildMotionFilename(
          project,
          { frameId, kind: "flow" },
        );
        const downloadMode = window.MotionFlowDownload.downloadMode(mode);
        if (window.flow_uuid_gateway)
          await window.flow_uuid_gateway.requireDownload([mediaId], {
            mode: downloadMode,
            projectId: projectIdForDownload,
            surface: "motion",
            mediaType: "video",
            signal,
            abortFn,
          });
        console.info(
          "[MotionFlowDownload]",
          JSON.stringify({
            stage: "manual_route",
            frameId,
            mode: downloadMode,
            generationMode: mode,
            resolution,
          }),
        );
        if (downloadMode === "api") {
          const input = {
            apiDriver: monitor.api_driver,
            mediaId,
            operationId: monitor.provider_operation_id,
            projectId: projectIdForDownload,
            protocolRevision: monitor.protocol_revision || null,
            protocolFingerprint: monitor.protocol_fingerprint || null,
            mediaType: "video",
            surface: "workflow",
            ratio: project.data_json?.preferences?.ratio || null,
          };
          const selected = await window.MotionResolutionPolicy.resolveBest(
            window.ProviderConfigManager.getDownloadResolutionsSync("flow"),
            resolution,
            {
              resolveNative: async () => {
                const result =
                  await window.FlowApiFacade.resolveDownload(input);
                return result?.url
                  ? { ok: true, url: result.url }
                  : { ok: false, error: "MOTION_FLOW_NATIVE_URL_MISSING" };
              },
              upscale: (option) =>
                window.FlowApiFacade.upscaleVideo({
                  ...input,
                  resolution: option.value,
                }),
            },
          );
          const url = selected.videoUrl || selected.url;
          if (!/^https:\/\//i.test(String(url || "")))
            throw new Error("MOTION_FLOW_VIDEO_URL_INVALID");
          if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
          const clean2 =
            watermarkMode === "clean" ||
            (watermarkMode === "inherit" &&
              [true, 1, "1"].includes(
                window.storageSettings.getSettings()?.autoRemoveWatermarkVideo,
              ));
          let response = await fetch(url, {
            credentials: "omit",
            cache: "no-store",
            signal,
          });
          if (
            response.status === 401 &&
            /^https:\/\/flow\.google\.com\/asb\//i.test(url)
          ) {
            response = await fetch(url, {
              credentials: "include",
              cache: "no-store",
              signal,
            });
          }
          if (!response.ok)
            throw new Error(`FLOW_DOWNLOAD_HTTP_${response.status}`);
          let blob2 = await response.blob();
          if (!blob2.size || !/^video\//i.test(blob2.type))
            throw new Error("MOTION_FLOW_VIDEO_INVALID");
          if (clean2) {
            const cleaned = await window.DownloadHelper.cleanMediaBlob(
              blob2,
              "video",
              { force: true },
            );
            if (!cleaned.cleaned && !cleaned.noWatermark)
              throw new Error(cleaned.reason || "VIDEO_WM_NOT_APPLIED");
            blob2 = cleaned.blob;
          }
          if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
          const localUrl2 = URL.createObjectURL(blob2);
          try {
            const saved = await chrome.runtime.sendMessage({
              action: "chromeDownload",
              url: localUrl2,
              filename,
              waitForComplete: true,
              waitTimeoutMs: 6e5,
            });
            if (!saved?.success)
              throw new Error(saved?.error || "MOTION_FLOW_DOWNLOAD_FAILED");
          } finally {
            setTimeout(() => URL.revokeObjectURL(localUrl2), 6e4);
          }
          await replaceDownloadedFrame(
            frameId,
            expected,
            blob2,
            selected.resolution,
          );
          return { success: true, resolution: selected.resolution };
        }
        await refresh();
        const downloadFrame = project?.data_json?.frames?.[frameId];
        if (
          scopeInvalid ||
          Number(project.data_json?.source_revision) !==
            expected.sourceRevision ||
          project.flow_project_id !== expected.flowProjectId ||
          downloadFrame?.run_id !== expected.runId ||
          Number(downloadFrame?.input_revision) !== expected.inputRevision ||
          downloadFrame.stages?.monitor?.provider_media_id !== expected.mediaId
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        await downloadFrameFromFlow({
          frameId,
          automatic: true,
          resolutionOverride: resolution,
        });
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        const currentFrame = project?.data_json?.frames?.[frameId];
        if (
          scopeInvalid ||
          Number(project.data_json?.source_revision) !==
            expected.sourceRevision ||
          currentFrame?.run_id !== expected.runId ||
          Number(currentFrame?.input_revision) !== expected.inputRevision ||
          project.flow_project_id !== expected.flowProjectId ||
          currentFrame?.stages?.monitor?.provider_media_id !==
            expected.mediaId ||
          currentFrame?.stages?.persist?.state !== "ready"
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        const record = await MotionArtifactStore.get({
          userId,
          toolProjectId: projectId,
          sourceRevision: expected.sourceRevision,
          frameId,
          kind: "generated_clip",
          artifactRevision: expected.inputRevision,
        });
        if (!record?.blob || record.flowProjectId !== expected.flowProjectId)
          throw new Error("MOTION_FLOW_VIDEO_LOCAL_VERIFY_FAILED");
        console.info(
          "[MotionFlowDownload]",
          JSON.stringify({
            stage: "manual_local_ready",
            frameId,
            requestedResolution: resolution,
            actualResolution: record.resolution || null,
            bytes: record.blob.size,
          }),
        );
        let blob = record.blob;
        const clean =
          watermarkMode === "clean" ||
          (watermarkMode === "inherit" &&
            [true, 1, "1"].includes(
              window.storageSettings.getSettings()?.autoRemoveWatermarkVideo,
            ));
        if (clean) {
          console.info(
            "[MotionFlowDownload]",
            JSON.stringify({
              stage: "manual_cleaning",
              frameId,
              bytes: blob.size,
            }),
          );
          const cleaned = await window.DownloadHelper.cleanMediaBlob(
            blob,
            "video",
            { force: true },
          );
          if (!cleaned.cleaned && !cleaned.noWatermark)
            throw new Error(cleaned.reason || "VIDEO_WM_NOT_APPLIED");
          blob = cleaned.blob;
          console.info(
            "[MotionFlowDownload]",
            JSON.stringify({
              stage: "manual_cleaned",
              frameId,
              bytes: blob.size,
            }),
          );
        }
        if (abortFn?.()) throw new Error("DOWNLOAD_STOPPED");
        if (
          scopeInvalid ||
          Number(project.data_json?.source_revision) !==
            expected.sourceRevision ||
          project.data_json?.frames?.[frameId]?.run_id !== expected.runId
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        const localUrl = URL.createObjectURL(blob);
        try {
          console.info(
            "[MotionFlowDownload]",
            JSON.stringify({
              stage: "manual_export",
              frameId,
              actualResolution: record.resolution || null,
              bytes: blob.size,
            }),
          );
          const saved = await chrome.runtime.sendMessage({
            action: "chromeDownload",
            url: localUrl,
            filename,
            waitForComplete: true,
            waitTimeoutMs: 6e5,
          });
          if (!saved?.success)
            throw new Error(saved?.error || "MOTION_FLOW_DOWNLOAD_FAILED");
          console.info(
            "[MotionFlowDownload]",
            JSON.stringify({
              stage: "manual_exported",
              frameId,
              actualResolution: record.resolution || null,
            }),
          );
        } finally {
          setTimeout(() => URL.revokeObjectURL(localUrl), 6e4);
        }
        return { success: true, resolution: record.resolution || null };
      },
    });
  }
  async function downloadFrameFromFlow({
    frameId = $("flowDownloadDialog").dataset.frameId,
    automatic = false,
    resolutionOverride = null,
  } = {}) {
    if (!frameId || scopeInvalid || (busy && !automatic)) {
      if (automatic)
        throw new Error(
          scopeInvalid ? "ACCOUNT_SCOPE_CHANGED" : "FRAME_SCOPE_CHANGED",
        );
      return;
    }
    let ownsBusy = false;
    const waitingAt = performance.now();
    console.info(
      "[MotionDownload]",
      JSON.stringify({ frameId, automatic, stage: "waiting_editor", busy }),
    );
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        automatic ? {} : { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          ownsBusy = true;
          busy = true;
          startActivity();
          updateButtons();
          $("confirmFlowDownload").disabled = true;
          $("flowDownloadStatus").textContent = motionFormat(
            "text198",
            "\u0110ang t\u1EA3i video {0}...",
            [frameId],
          );
          console.info(
            "[MotionDownload]",
            JSON.stringify({
              frameId,
              automatic,
              stage: "editor_acquired",
              elapsedMs: Math.round(performance.now() - waitingAt),
            }),
          );
          await refresh();
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          const frame = project.data_json?.frames?.[frameId];
          const monitor = frame?.stages?.monitor;
          const runMode = monitor?.flow_mode;
          if (
            monitor?.state !== "ready" ||
            !["web", "api"].includes(runMode) ||
            !monitor.provider_media_id ||
            (!monitor.provider_operation_id &&
              !(runMode === "web" && monitor.manual_result === true))
          )
            throw new Error("MOTION_MONITOR_RECEIPT_REQUIRED");
          const sourceRevision = Number(project.data_json.source_revision);
          const source = await MotionArtifactStore.get({
            userId,
            toolProjectId: projectId,
            sourceRevision,
            frameId,
            kind: "source_clip",
          });
          if (
            !(runMode === "web" && monitor.manual_result === true) &&
            source?.uploadReceipt &&
            source.uploadReceipt.projectId !== project.flow_project_id
          ) {
            throw new Error("MOTION_FLOW_PROJECT_RECEIPT_REQUIRED");
          }
          const target = await getMotionFlowTarget();
          assertPinnedFlowTarget(target);
          if (!flowRuntimeReady) {
            await window.storageSettings.init();
            await window.featureGate.init();
            flowRuntimeReady = true;
          }
          const config =
            ProviderConfigManager.getDownloadResolutionsSync("flow");
          const receipt = {
            apiDriver: monitor.api_driver,
            mediaId: monitor.provider_media_id,
            operationId: monitor.provider_operation_id,
            fileName: monitor.persistent_media_id || "",
            manualResult: monitor.manual_result === true,
            projectId: project.flow_project_id,
            protocolRevision: monitor.protocol_revision,
            protocolFingerprint: monitor.protocol_fingerprint,
            ratio: project.data_json?.preferences?.ratio,
          };
          const artifactRevision = Number(frame.input_revision);
          const previousFinal = project.data_json?.final;
          const previous = await MotionArtifactStore.get({
            userId,
            toolProjectId: projectId,
            sourceRevision,
            frameId,
            kind: "generated_clip",
            artifactRevision,
          });
          if (
            !receipt.fileName &&
            previous?.flowProjectId === receipt.projectId &&
            previous.media_uuid === receipt.mediaId
          )
            receipt.fileName = previous.persistent_media_id || "";
          const persist =
            runMode === "web"
              ? MotionFlowDownload.persistWeb
              : MotionFlowDownload.persistApi;
          const preferred =
            project.data_json?.preferences?.flow_download_resolution;
          const selectedResolution =
            resolutionOverride ||
            (automatic
              ? resolutions.some((option) => option.value === preferred)
                ? preferred
                : $("flowResolution").value
              : $("frameFlowResolution").value);
          if (!selectedResolution)
            throw new Error("FLOW_DOWNLOAD_RESOLUTION_UNAVAILABLE");
          console.info(
            "[MotionDownload]",
            JSON.stringify({
              frameId,
              automatic,
              stage: "resolve_video",
              generationMode: runMode,
              resolution: selectedResolution,
            }),
          );
          const retryPolicy = (await window.ExecutionConfig.getConfig())
            ?.workflow;
          if (
            !Number.isSafeInteger(retryPolicy?.max_retries) ||
            retryPolicy.max_retries < 0 ||
            !Number.isFinite(retryPolicy?.delay_nodes_sec) ||
            retryPolicy.delay_nodes_sec < 0
          )
            throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
          const maxRetries =
            window.featureGate.canUse("retry_on_fail") === true
              ? retryPolicy.max_retries
              : 0;
          const frameRunId = frame.run_id,
            retryState = {};
          let result;
          for (let retry = 0; ; retry++) {
            await refresh();
            if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
            const current = project.data_json?.frames?.[frameId],
              currentTarget = await getMotionFlowTarget();
            assertPinnedFlowTarget(currentTarget);
            if (
              project.flow_project_id !== receipt.projectId ||
              Number(project.data_json?.source_revision) !== sourceRevision ||
              current?.run_id !== frameRunId ||
              Number(current?.input_revision) !== artifactRevision ||
              current?.stages?.monitor?.state !== "ready" ||
              current.stages.monitor.provider_media_id !== receipt.mediaId ||
              current.stages.monitor.provider_operation_id !==
                receipt.operationId ||
              ["tabId", "projectId", "driverKey", "origin"].some(
                (key) => currentTarget?.[key] !== target[key],
              )
            )
              throw new Error("MOTION_DOWNLOAD_SCOPE_CHANGED");
            if (
              retry &&
              (cancelled || deferredUploadPause || project.data_json?.paused)
            )
              throw new Error("DOWNLOAD_STOPPED");
            try {
              result = await persist.call(MotionFlowDownload, {
                receipt,
                config,
                selectedResolution,
                retryState,
                scope: {
                  userId,
                  toolProjectId: projectId,
                  flowProjectId: receipt.projectId,
                  sourceRevision,
                  frameId,
                  artifactRevision,
                },
              });
              break;
            } catch (error) {
              const raw = String(
                error?.code || error?.message || "MOTION_FLOW_DOWNLOAD_FAILED",
              );
              const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                ? raw
                : "MOTION_FLOW_DOWNLOAD_FAILED";
              if (
                retry >= maxRetries ||
                error?.noReplay === true ||
                error?.ambiguous === true ||
                error?.name === "AbortError" ||
                ["ABORTED", "DOWNLOAD_STOPPED", "MOTION_CANCELLED"].includes(
                  code,
                ) ||
                scopeInvalid ||
                cancelled ||
                deferredUploadPause ||
                project.data_json?.paused
              )
                throw error;
              console.info(
                "[MotionDownloadRetry]",
                JSON.stringify({
                  frameId,
                  automatic,
                  sourceRevision,
                  retryCount: retry + 1,
                  maxRetries,
                  code,
                }),
              );
              const key = "flowStatus.retrying",
                translated = window.I18n?.t?.(key);
              $("flowDownloadStatus").textContent =
                `${translated && translated !== key ? translated : "Retrying"}... \xB7 ${retry + 1}/${maxRetries}`;
              if (retryPolicy.delay_nodes_sec > 0)
                await new Promise((resolve) =>
                  setTimeout(resolve, retryPolicy.delay_nodes_sec * 1e3),
                );
            }
          }
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          const checkpoint = {
            source_revision: sourceRevision,
            run_id: frame.run_id,
            input_revision: frame.input_revision,
            stage: "persist",
            state: "ready",
            artifact_id:
              frame.stages?.persist?.artifact_id || result.artifactId,
            resolution: result.resolution,
            replace_existing: frame.stages?.persist?.state === "ready",
          };
          try {
            await api(
              "PATCH",
              `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
              checkpoint,
            );
          } catch (checkpointError) {
            const fresh = await api("GET", endpoint).catch(() => null);
            const saved = fresh?.data_json?.frames?.[frameId]?.stages?.persist;
            const committed =
              saved?.state === "ready" &&
              saved.artifact_id === checkpoint.artifact_id &&
              saved.resolution === result.resolution;
            if (committed) {
              project = fresh;
            } else if (fresh && !scopeInvalid) {
              if (previous?.blob)
                await MotionArtifactStore.put({
                  userId,
                  toolProjectId: projectId,
                  flowProjectId: receipt.projectId,
                  sourceRevision,
                  frameId,
                  kind: "generated_clip",
                  artifactRevision,
                  blob: previous.blob,
                  duration: previous.duration || null,
                  resolution: previous.resolution || null,
                  media_uuid: previous.media_uuid || null,
                  persistent_media_id: previous.persistent_media_id || null,
                });
              else
                await MotionArtifactStore.delete({
                  userId,
                  toolProjectId: projectId,
                  sourceRevision,
                  frameId,
                  kind: "generated_clip",
                  artifactRevision,
                });
            }
            if (!committed) {
              checkpointError.motionCheckpointUncertain = !fresh;
              throw checkpointError;
            }
          }
          await refresh();
          if (
            project?.data_json?.frames?.[frameId]?.stages?.persist?.state ===
              "ready" &&
            Number(project.data_json.frames[frameId].input_revision) ===
              artifactRevision
          ) {
            await cleanupInvalidatedFrameArtifacts(
              frameId,
              sourceRevision,
              artifactRevision - 1,
              null,
            ).catch((error) =>
              console.warn(
                "[Motion] Superseded frame cleanup failed",
                error?.message,
              ),
            );
          }
          if (previousFinal && !project.data_json?.final) {
            await MotionArtifactStore.delete({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              kind: "merged_video",
              artifactRevision: Number(previousFinal.artifact_revision),
            }).catch((error) =>
              console.warn(
                "[MotionDownload] Stale merged video cleanup failed",
                error?.message,
              ),
            );
          }
          $("flowDownloadStatus").textContent = motionFormat(
            "text199",
            "\u0110\xE3 l\u01B0u {0} \xB7 {1}.",
            [result.resolution, formatBytes(result.bytes)],
          );
          status(
            motionFormat(
              "text200",
              "{0}: \u0111\xE3 l\u01B0u video Flow {1}.",
              [frameId, result.resolution],
            ),
          );
          await showFrameVideo(frameId, "generated_clip");
        },
      );
    } catch (error) {
      const code = String(
        error?.code || error?.message || "MOTION_FLOW_DOWNLOAD_FAILED",
      );
      console.warn(
        "[MotionDownload]",
        JSON.stringify({
          frameId,
          automatic,
          stage: "persist_failed",
          code,
          checkpointUncertain: error?.motionCheckpointUncertain === true,
        }),
      );
      $("flowDownloadStatus").textContent = motionFormat(
        "text201",
        "T\u1EA3i th\u1EA5t b\u1EA1i: {0}. B\u1EA5m \u201CT\u1EA3i v\xE0 l\u01B0u frame\u201D \u0111\u1EC3 th\u1EED l\u1EA1i.",
        [code],
      );
      const frame = project?.data_json?.frames?.[frameId];
      if (
        !error?.motionCheckpointUncertain &&
        !scopeInvalid &&
        frame?.stages?.monitor?.state === "ready" &&
        frame.stages?.persist?.state !== "ready"
      ) {
        try {
          await api(
            "PATCH",
            `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
            {
              source_revision: project.data_json.source_revision,
              run_id: frame.run_id,
              input_revision: frame.input_revision,
              stage: "persist",
              state: "failed",
              error_code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(code)
                ? code
                : "MOTION_FLOW_DOWNLOAD_FAILED",
              retry_exhausted: true,
            },
          );
          await refresh();
        } catch (checkpointError) {
          console.warn(
            "[MotionDownload] Failed to checkpoint download error",
            checkpointError?.message,
          );
        }
      }
      if (automatic) throw error;
    } finally {
      if (ownsBusy) {
        busy = false;
        settleActivity();
        updateButtons();
        $("confirmFlowDownload").disabled = false;
        if (deferredUploadPause && !scopeInvalid) {
          deferredUploadPause = false;
          if (!(await setPaused(true))) {
            motionQueuePauseRequested = true;
            throw new Error("MOTION_PAUSE_SAVE_FAILED");
          }
        }
      }
    }
  }
  async function correctUploadedSourceReceipt(
    record,
    target,
    { persist = true } = {},
  ) {
    const receipt = record?.uploadReceipt;
    if (!receipt || scopeInvalid || receipt.projectId !== target?.projectId)
      return receipt;
    const corrected = await window.flow_uuid_gateway.correctUploadReceipt(
      receipt,
      { expectedFlowTarget: target, projectId: target.projectId },
    );
    if (corrected === receipt) return receipt;
    const current = await getMotionFlowTarget();
    assertPinnedFlowTarget(current, target);
    if (
      scopeInvalid ||
      Number(project?.data_json?.source_revision) !== record.sourceRevision
    )
      return receipt;
    if (persist)
      await MotionArtifactStore.setUploadReceipt({
        userId,
        toolProjectId: projectId,
        sourceRevision: record.sourceRevision,
        frameId: record.frameId,
        receipt: corrected,
      });
    return corrected;
  }
  async function resolveUploadedSource(
    record,
    { persistReceipt = true, correctReceipt = true } = {},
  ) {
    const receipt = record?.uploadReceipt;
    if (
      scopeInvalid ||
      !receipt?.mediaId ||
      receipt.projectId !== project?.flow_project_id ||
      !["api", "web"].includes(receipt.mode) ||
      Number(project?.data_json?.source_revision) !== record.sourceRevision
    )
      return null;
    const target = await getMotionFlowTarget();
    assertPinnedFlowTarget(target);
    const gateway = window.flow_uuid_gateway;
    const providerData =
      receipt.mode === "api"
        ? {
            provider: "flow",
            api_driver: receipt.apiDriver,
            uuidLookup: true,
            project_id: receipt.projectId,
            protocol_revision: receipt.protocolRevision,
            protocol_fingerprint: receipt.protocolFingerprint,
            media_uuid: receipt.mediaUuid,
          }
        : null;
    const media = {
      type: "video",
      project_id: receipt.projectId,
      media_uuid: gateway.identity(
        { media_uuid: receipt.mediaUuid },
        receipt.mediaId,
      ),
      file_name: receipt.fileName || receipt.persistentMediaId,
      persistent_media_id: receipt.persistentMediaId || receipt.mediaUuid,
    };
    const response = await gateway.recoverMetadata(
      [
        {
          id: receipt.mediaId,
          record: media,
          providerData,
          fields: ["video_url"],
        },
      ],
      {
        expectedFlowTarget: target,
        projectId: receipt.projectId,
        surface: "motion",
        purpose: "preview",
        operationId: `${projectId}:${record.sourceRevision}:${record.frameId}`,
        mode: gateway.downloadMode(receipt.mode),
        deep: false,
        allowLocal: false,
        abortFn: () =>
          scopeInvalid ||
          Number(project?.data_json?.source_revision) !== record.sourceRevision,
      },
    );
    const current = await getMotionFlowTarget();
    assertPinnedFlowTarget(current, target);
    if (
      scopeInvalid ||
      Number(project?.data_json?.source_revision) !== record.sourceRevision
    )
      return null;
    const info = response.records?.[receipt.mediaId];
    if (
      response.failed?.includes(receipt.mediaId) ||
      response.unresolved?.includes(receipt.mediaId) ||
      !gateway.metadataMatches(media, info, { projectId: receipt.projectId }) ||
      typeof info?.video_url !== "string" ||
      !info.video_url.startsWith("https://")
    )
      return null;
    if (persistReceipt && correctReceipt) {
      const corrected = gateway.uploadReceiptMetadata(receipt, info);
      if (corrected !== receipt) {
        await MotionArtifactStore.setUploadReceipt({
          userId,
          toolProjectId: projectId,
          sourceRevision: record.sourceRevision,
          frameId: record.frameId,
          receipt: corrected,
        });
        gateway.observeMetadataUpdate(media, info, {
          surface: "motion",
          purpose: "preview",
          projectId: receipt.projectId,
          operationId: `${projectId}:${record.sourceRevision}:${record.frameId}`,
        });
      }
    }
    return info.video_url;
  }
  async function resolveGeneratedFlowPreview(frameId, fields = ["video_url"]) {
    const frame = project?.data_json?.frames?.[frameId];
    if (scopeInvalid || !window.MotionFrameSteps.hasFlowResult(frame))
      return null;
    const scopeKey = () => {
      const current2 = project?.data_json?.frames?.[frameId];
      return JSON.stringify([
        project?.flow_project_id,
        project?.data_json?.source_revision,
        current2?.run_id,
        current2?.input_revision,
        current2?.stages?.monitor,
      ]);
    };
    const expected = scopeKey(),
      monitor = frame.stages.monitor,
      gateway = window.flow_uuid_gateway;
    const flowProjectId = project.flow_project_id;
    const target = await getMotionFlowTarget();
    assertPinnedFlowTarget(target);
    if (
      scopeInvalid ||
      scopeKey() !== expected ||
      target.projectId !== flowProjectId
    )
      return null;
    const id = monitor.provider_media_id;
    const media = {
      type: "video",
      project_id: flowProjectId,
      media_uuid: gateway.identity({}, id),
      ...(gateway.isAsb(id) ? { persistent_media_id: id, file_name: id } : {}),
    };
    const providerData =
      monitor.flow_mode === "api"
        ? {
            provider: "flow",
            api_driver: monitor.api_driver,
            project_id: flowProjectId,
            media_uuid: media.media_uuid,
            uuidLookup: true,
            protocol_revision: monitor.protocol_revision,
            protocol_fingerprint: monitor.protocol_fingerprint,
          }
        : null;
    const response = await gateway.recoverMetadata(
      [{ id, record: media, providerData, fields }],
      {
        expectedFlowTarget: target,
        projectId: flowProjectId,
        surface: "motion",
        purpose: "preview",
        operationId: `${projectId}:${frameId}:${monitor.provider_operation_id || id}`,
        mode: monitor.flow_mode,
        deep: false,
        allowLocal: false,
        abortFn: () => scopeInvalid || scopeKey() !== expected,
      },
    );
    const current = await getMotionFlowTarget();
    assertPinnedFlowTarget(current, target);
    if (scopeInvalid || scopeKey() !== expected) return null;
    const info = response.records?.[id];
    if (
      response.failed?.includes(id) ||
      !gateway.metadataMatches(media, info, { projectId: flowProjectId })
    )
      return null;
    return {
      thumbnail:
        typeof info?.thumbnail === "string" &&
        info.thumbnail.startsWith("https://")
          ? gateway.displayThumbnailUrl(info.thumbnail)
          : null,
      video_url:
        typeof info?.video_url === "string" &&
        info.video_url.startsWith("https://")
          ? info.video_url
          : null,
    };
  }
  async function cleanPlayedUploadedSource(frameId, sourceRevision, receipt) {
    if (scopeInvalid || busy || motionRunning || !navigator.locks?.request)
      return;
    await navigator.locks.request(
      `motion-run:${userId}:${projectId}`,
      { ifAvailable: true },
      async (runLock) => {
        if (!runLock || scopeInvalid || busy || motionRunning) return;
        await navigator.locks.request(
          `motion:${userId}:${projectId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock || scopeInvalid || busy || motionRunning) return;
            const fresh = await api("GET", endpoint);
            const stage = fresh?.data_json?.frames?.[frameId]?.stages?.upload;
            if (
              fresh?.tool_project_id !== projectId ||
              fresh?.flow_project_id !== receipt.projectId ||
              Number(fresh?.data_json?.source_revision) !== sourceRevision ||
              stage?.state !== "ready" ||
              stage.provider_media_id !== receipt.mediaId ||
              stage.flow_mode !== receipt.mode ||
              scopeInvalid
            )
              return;
            const target = await getMotionFlowTarget();
            assertPinnedFlowTarget(target);
            const record = await MotionArtifactStore.get({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              kind: "source_clip",
            });
            const saved = record?.uploadReceipt;
            if (
              !record?.blob ||
              saved?.mediaId !== receipt.mediaId ||
              saved?.projectId !== receipt.projectId ||
              saved?.mode !== receipt.mode ||
              saved?.mediaUuid !== receipt.mediaUuid ||
              scopeInvalid
            )
              return;
            const poster = await MotionArtifactStore.get({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              kind: "poster",
            });
            if (!poster?.blob)
              await saveSourcePoster(record.blob, sourceRevision, frameId);
            if (scopeInvalid) return;
            await MotionArtifactStore.clearUploadedSourceBlob({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              mediaId: receipt.mediaId,
              projectId: receipt.projectId,
            });
            const usage = await MotionArtifactStore.usage(userId, projectId);
            $("usage").textContent =
              `${formatBytes(usage.bytes)} \xB7 ${usage.artifacts} files`;
            const estimate = await navigator.storage?.estimate?.();
            const quota = Number(estimate?.quota || 0);
            $("usageFill").style.width =
              quota > 0
                ? `${Math.min(100, (usage.bytes / quota) * 100)}%`
                : "0%";
            console.info("[Motion] Played uploaded source cleaned", {
              frameId,
              mode: receipt.mode,
              sourceRevision,
            });
          },
        );
      },
    );
  }
  function setFrameResultPlaceholderRatio() {
    const wrap = $("frameDialogVideo").closest(".frame-video-wrap");
    const dialog = $("frameDialog");
    const ratio = String(
      project?.data_json?.preferences?.ratio || $("motionRatio").value || "",
    );
    const match = /^(\d+):(\d+)$/.exec(ratio);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (width > 0 && height > 0) {
      dialog.dataset.videoLayout = width >= height ? "landscape" : "portrait";
      wrap.style.aspectRatio = `${width} / ${height}`;
      wrap.style.setProperty("--frame-video-ratio", String(width / height));
    } else {
      delete dialog.dataset.videoLayout;
      wrap.style.removeProperty("aspect-ratio");
      wrap.style.removeProperty("--frame-video-ratio");
    }
  }
  function canGetFrameSub(frame) {
    const submit = frame?.stages?.submit;
    const unsettled =
      ["running", "needs_review"].includes(submit?.state) ||
      (submit?.state === "ready" &&
        !["ready", "failed"].includes(frame?.stages?.monitor?.state));
    return (
      !busy &&
      !motionRunning &&
      !scopeInvalid &&
      frame?.stages?.split?.state === "ready" &&
      !unsettled
    );
  }
  function renderFrameDialogStatus(frameId, kind = selectedFrameKind) {
    const stage = frameStage(project?.data_json?.frames?.[frameId], {
      resultOnly: kind === "generated_clip",
    });
    $("frameDialogStatus").textContent = stage.label;
    $("frameDialogStatus").dataset.state = stage.state;
    const error = errorDescription(stage);
    $("frameDialogError").hidden = true;
    $("frameDialogError").textContent = error;
    renderFrameTranscriptStatus(frameId, project?.data_json?.frames?.[frameId]);
  }
  function renderFrameTranscriptStatus(frameId, frame) {
    renderFrameSpeechTimeline(frame);
    $("frameTranscriptError").hidden = true;
    for (const id of [
      "frameTranscriptErrorTitle",
      "frameTranscriptErrorReason",
      "frameTranscriptErrorCode",
    ])
      $(id).textContent = "";
    window.MotionFrameSteps?.render($("frameDialogSteps"), {
      frame,
      frameId,
      copyLabel: window.I18n?.t?.("common.copy"),
      copiedLabel: window.I18n?.t?.("common.copied"),
      copyFailedLabel: window.I18n?.t?.("common.error"),
      continuityLabel: continuityStatusText(frame),
      preferences: project?.data_json?.preferences,
      sourceReady: hasUploadedSourceUuid(frameId),
      audioReady: audioFrameIds.has(frameId),
      resultReady: generatedFrameIds.has(frameId),
      transcribing:
        (activeMotionFrameId === frameId &&
          activeMotionStage === "transcribe") ||
        batchSubFrameIds.has(frameId),
      uploading:
        activeUploadFrameId === frameId ||
        window.MotionFlowUpload?.activeSourceUploads?.has(frameId) === true,
      audioRunning: activeAudioFrameId === frameId,
      paused: project?.data_json?.paused === true,
      text: motionText,
      format: motionFormat,
      errorMessage: (code, step) => {
        if (!code && step?.id === "sub")
          return motionText(
            "transcriptFailed",
            "L\u1ED7i t\u1EA1o sub, h\xE3y th\u1EED l\u1EA1i",
          );
        if (step?.id === "sub") {
          const key = `providerWebErrors.codes.${code}`,
            translated = window.I18n?.t?.(key);
          if (translated && translated !== key) return translated;
        }
        return motionErrorMessage(code || "MOTION_RUN_FAILED", {
          transcript: step?.id === "sub",
          videoUpload: step?.stage === "upload",
        });
      },
    });
  }
  function updateFrameSpeechEditor() {
    if (!$("frameDialog")?.open || !selectedFrameId) return;
    const frame = project?.data_json?.frames?.[selectedFrameId];
    if (!frame) return;
    const noSpeech = !$("frameHasSpeech").checked;
    const hasDialogue = !!$("frameTranscriptInput").value.trim();
    const preferences = project.data_json.preferences || {};
    const usedForGeneration =
      preferences.voice_enabled === true ||
      preferences.subtitle_enabled === true;
    for (const id of ["frameTranscriptInput", "frameTranslationInput"]) {
      $(id).closest(".transcript-field").hidden =
        !usedForGeneration ||
        (id === "frameTranslationInput" && !$("translateEnabled").checked);
      $(id).disabled = !usedForGeneration || noSpeech;
    }
    $("frameHasSpeech").disabled = !usedForGeneration;
    $("frameHasSpeech").closest(".speech-check").hidden = !usedForGeneration;
    $("frameSaveTranscript").hidden = !usedForGeneration;
    $("frameResub").hidden = !usedForGeneration;
    $("frameSaveTranscript").closest(".frame-transcript-actions").hidden =
      !usedForGeneration;
    $("frameSubEmpty").hidden = !!frame.transcript || noSpeech || hasDialogue;
    const key = !usedForGeneration
      ? "frameSpeechSavedOnlyHint"
      : noSpeech
        ? "frameSpeechNoneHint"
        : hasDialogue
          ? "frameSpeechUsedHint"
          : "frameSpeechEmptyHint";
    const translationKey = `motionEditor.${key}`;
    const message = window.I18n?.t?.(translationKey);
    const hint = $("frameSpeechUsage");
    const label = message && message !== translationKey ? message : "";
    if (hint.textContent !== label) hint.textContent = label;
    hint.hidden = !label;
    hint.dataset.speechMode = !usedForGeneration
      ? "disabled"
      : noSpeech
        ? "none"
        : hasDialogue
          ? "used"
          : "empty";
    if (hint.dataset.speechMode === "empty") $("frameSubEmpty").after(hint);
    else $("frameHasSpeech").closest(".frame-transcript-heading").after(hint);
    renderFrameSpeechTimeline(frame);
    if (!usedForGeneration || noSpeech) $("frameSpeechTimeline").hidden = true;
  }
  function renderFrameSpeechTimeline(frame) {
    const panel = $("frameSpeechTimeline");
    if (!panel) return;
    panel.hidden =
      frame?.transcript?.speech_timeline == null ||
      ($("frameDialog")?.open &&
        ($("frameHasSpeech")?.checked === false ||
          !(
            project?.data_json?.preferences?.voice_enabled === true ||
            project?.data_json?.preferences?.subtitle_enabled === true
          )));
    $("frameSpeechTimelineText").textContent = "";
    if (panel.hidden) return;
    try {
      $("frameSpeechTimelineText").textContent =
        window.MotionTranscriptContract.formatTimeline(frame.transcript, {
          duration: Number(frame.end) - Number(frame.start),
          translate:
            project?.data_json?.preferences?.translate_enabled === true,
          speak: motionText("timelineSpeak", "N\xF3i"),
          pause: motionText("timelinePause", "Ngh\u1EC9"),
        });
    } catch (_) {
      panel.hidden = true;
    }
  }
  async function showFrameVideo(frameId, kind) {
    const requestEpoch = ++frameMediaEpoch;
    setFrameResultPlaceholderRatio();
    const sourceRevision = Number(project?.data_json?.source_revision || 0);
    const record = await MotionArtifactStore.get({
      userId,
      toolProjectId: projectId,
      sourceRevision,
      frameId,
      kind,
      artifactRevision:
        kind === "generated_clip"
          ? window.MotionFrameSteps.hasFlowResult(
              project?.data_json?.frames?.[frameId],
            )
            ? Number(project.data_json.frames[frameId].input_revision)
            : generatedPreviewRevisions.get(frameId) || 1
          : 1,
    });
    const sourceRecord =
      kind === "generated_clip"
        ? await MotionArtifactStore.get({
            userId,
            toolProjectId: projectId,
            sourceRevision,
            frameId,
            kind: "source_clip",
          })
        : null;
    let original =
      kind === "generated_clip" && !sourceRecord?.blob
        ? await MotionArtifactStore.get({
            userId,
            toolProjectId: projectId,
            sourceRevision,
            kind: "source_video",
          })
        : null;
    const remoteResult =
      kind === "generated_clip" && !record?.blob
        ? await resolveGeneratedFlowPreview(frameId).catch(() => null)
        : null;
    const remoteSource =
      kind === "source_clip" && record?.uploadReceipt
        ? await resolveUploadedSource(record).catch((error) => {
            console.warn("[Motion] Uploaded frame preview unavailable", {
              frameId,
              code: error?.code || error?.message,
            });
            return null;
          })
        : kind === "generated_clip" && !sourceRecord?.blob && !original?.blob
          ? await resolveUploadedSource(sourceRecord).catch((error) => {
              console.warn("[Motion] Frame source preview unavailable", {
                frameId,
                code: error?.code || error?.message,
              });
              return null;
            })
          : null;
    if (kind === "source_clip" && !record?.blob && !remoteSource)
      original = await MotionArtifactStore.get({
        userId,
        toolProjectId: projectId,
        sourceRevision,
        kind: "source_video",
      });
    if (
      scopeInvalid ||
      selectedFrameId !== frameId ||
      requestEpoch !== frameMediaEpoch
    )
      return;
    if (kind === "source_clip")
      console.info(
        "[MotionSourcePreview]",
        JSON.stringify({
          frameId,
          hasRecord: !!record,
          hasClip: !!record?.blob,
          hasReceipt: !!record?.uploadReceipt,
          hasUuid: !!record?.uploadReceipt?.mediaUuid,
          hasAsb: !!record?.uploadReceipt?.persistentMediaId,
          hasFlowUrl: !!remoteSource,
          hasOriginal: !!original?.blob,
        }),
      );
    $("frameDialogVideo").pause();
    $("frameDialogVideo").removeAttribute("src");
    $("frameDialogVideo").load();
    $("frameCompareSourceVideo").pause();
    $("frameCompareSourceVideo").removeAttribute("src");
    $("frameCompareSourceVideo").load();
    revokeUrl(frameDialogUrl);
    frameDialogUrl = null;
    revokeUrl(frameDialogSourceUrl);
    frameDialogSourceUrl = null;
    selectedFrameKind = kind;
    const sourceFrame = project.data_json?.frames?.[frameId];
    renderFrameDialogStatus(frameId, kind);
    frameSourceBounds =
      kind === "source_clip" &&
      !record?.blob &&
      !remoteSource &&
      original?.blob &&
      Number.isFinite(Number(sourceFrame?.start)) &&
      Number.isFinite(Number(sourceFrame?.end)) &&
      Number(sourceFrame.end) > Number(sourceFrame.start)
        ? {
            start: Math.max(0, Number(sourceFrame.start)),
            end: Number(sourceFrame.end),
          }
        : null;
    $("frameDialogVideo").muted = !!frameSourceBounds;
    frameCompareOffset =
      kind === "generated_clip" && !sourceRecord?.blob && original?.blob
        ? Math.max(0, Number(project.data_json?.frames?.[frameId]?.start) || 0)
        : 0;
    $("frameCompareSource").hidden = kind !== "generated_clip";
    $("frameVideoGrid").classList.toggle(
      "is-compare",
      kind === "generated_clip",
    );
    $("frameResultLabel").textContent =
      kind === "generated_clip"
        ? motionText("text165", "K\u1EBFt qu\u1EA3 Flow")
        : motionText("text008", "Video g\u1ED1c");
    const compareBlob = sourceRecord?.blob || original?.blob;
    $("frameCompareSourceEmpty").hidden = !!compareBlob || !!remoteSource;
    $("frameCompareSourceVideo").hidden = !compareBlob && !remoteSource;
    if (compareBlob) {
      frameDialogSourceUrl = URL.createObjectURL(compareBlob);
      $("frameCompareSourceVideo").src = frameDialogSourceUrl;
    } else if (kind === "generated_clip" && remoteSource)
      $("frameCompareSourceVideo").src = remoteSource;
    $("framePlaySource").classList.toggle(
      "is-selected",
      kind === "source_clip",
    );
    $("framePlayResult").classList.toggle(
      "is-selected",
      kind === "generated_clip",
    );
    $("frameDownload").disabled =
      !record?.blob && !(kind === "source_clip" && remoteSource);
    if (
      record?.blob ||
      remoteResult?.video_url ||
      frameSourceBounds ||
      (kind === "source_clip" && remoteSource)
    ) {
      frameDialogUrl =
        record?.blob && !(kind === "source_clip" && remoteSource)
          ? URL.createObjectURL(record.blob)
          : frameSourceBounds
            ? URL.createObjectURL(original.blob)
            : null;
      if (
        kind === "source_clip" &&
        remoteSource &&
        record?.blob &&
        record.uploadReceipt
      ) {
        const video = $("frameDialogVideo");
        video.addEventListener(
          "playing",
          () => {
            if (
              scopeInvalid ||
              selectedFrameId !== frameId ||
              requestEpoch !== frameMediaEpoch ||
              video.src !== remoteSource
            )
              return;
            void cleanPlayedUploadedSource(
              frameId,
              sourceRevision,
              record.uploadReceipt,
            ).catch((error) =>
              console.warn("[Motion] Played source cleanup failed", {
                frameId,
                mode: record.uploadReceipt.mode,
                sourceRevision,
                code: error?.code || error?.message,
              }),
            );
          },
          { once: true },
        );
      }
      $("frameDialogVideo").src =
        frameDialogUrl || remoteResult?.video_url || remoteSource;
      $("frameDialogVideo").hidden = false;
      $("frameDialogVideoEmpty").hidden = true;
      if (!frameSourceBounds)
        $("frameDialogVideo")
          .play()
          .catch(() => {});
    } else {
      $("frameDialogVideo").hidden = true;
      $("frameDialogVideoEmpty").hidden = false;
    }
  }
  async function openFrameDialog(frameId, kind) {
    if (scopeInvalid) return;
    const frame = project?.data_json?.frames?.[frameId];
    if (!frame) return;
    closeFrameDialog();
    selectedFrameId = frameId;
    $("frameDialogTitle").textContent = `Frame ${frameId}`;
    $("frameDialogKicker").textContent =
      kind === "source_clip"
        ? motionText("text166", "VIDEO NGU\u1ED2N")
        : motionText("text167", "K\u1EBET QU\u1EA2 FLOW");
    $("frameDialogKicker").classList.add("is-video");
    const isSource = kind === "source_clip";
    $("framePlaySource").hidden = !isSource;
    $("framePlayResult").hidden = isSource;
    $("frameUploadClip").hidden = !isSource;
    $("frameResub").hidden = false;
    $("frameFetchFlow").hidden = isSource;
    $("frameRegen").textContent = isSource
      ? motionText("text098", "C\u1EAFt l\u1EA1i")
      : motionText("text073", "Ch\u1EA1y l\u1EA1i frame");
    $("frameRegen").classList.toggle("is-cut", isSource);
    $("frameDialogTime").textContent =
      `${Number(frame.start).toFixed(2)}s \u2013 ${Number(frame.end).toFixed(2)}s`;
    renderFrameDialogStatus(frameId, kind);
    const transcript = frame.transcript || null;
    $("frameHasSpeech").checked = transcript?.has_speech !== false;
    $("frameTranscriptInput").value = transcript?.text || "";
    $("frameTranslationInput").value = transcript?.translated_text || "";
    $("framePlaySource").disabled = false;
    $("framePlayResult").disabled =
      !generatedFrameIds.has(frameId) &&
      !window.MotionFrameSteps.hasFlowResult(frame);
    $("frameFetchFlow").disabled =
      busy ||
      scopeInvalid ||
      !resolutions.length ||
      frame.stages?.monitor?.state !== "ready" ||
      !["web", "api"].includes(frame.stages.monitor.flow_mode) ||
      (!frame.stages.monitor.provider_operation_id &&
        !(
          frame.stages.monitor.flow_mode === "web" &&
          frame.stages.monitor.manual_result === true
        )) ||
      !frame.stages.monitor.provider_media_id ||
      (frame.stages.monitor.flow_mode === "api" &&
        !frame.stages.monitor.api_driver);
    const accepted =
      frame.stages?.submit?.state === "ready" &&
      !["ready", "failed"].includes(frame.stages?.monitor?.state);
    const unsettled =
      accepted ||
      ["running", "needs_review"].includes(frame.stages?.submit?.state);
    $("frameSubEmpty").hidden = !!transcript;
    $("frameResub").disabled = !canGetFrameSub(frame);
    $("frameResub").textContent = motionText("text067", "T\u1EA1o Sub");
    const needsAudio =
      frame.stages?.split?.audio_state === "audio_not_requested";
    $("frameSubHint").hidden = !needsAudio;
    $("frameSubHint").textContent = needsAudio
      ? motionText(
          "text175",
          "Ch\u01B0a c\xF3 audio c\u1EE7a frame. D\xF9ng menu Audio \u0111\u1EC3 t\u1EA1o l\u1EA1i audio t\u1EA5t c\u1EA3 frame.",
        )
      : "";
    $("frameRegen").disabled =
      busy ||
      motionRunning ||
      !["ready", ...(isSource ? ["pending"] : [])].includes(
        frame.stages?.split?.state,
      );
    const sourceUploaded = isSourceUploadReady(frameId, frame);
    $("frameUploadClip").textContent = sourceUploaded
      ? `${motionText("text099", "\u0110\xE3 upload l\xEAn Flow")} \xB7 ${window.I18n?.t("common.retry") || ""}`
      : "Upload clip Flow";
    $("frameUploadClip").disabled =
      busy ||
      motionRunning ||
      scopeInvalid ||
      project.data_json?.requires_resplit === true ||
      frame.stages?.split?.state !== "ready" ||
      !project.data_json?.flow_run_mode ||
      unsettled;
    $("frameSaveTranscript").disabled =
      busy || frame.stages?.split?.state !== "ready" || accepted;
    $("frameDialog").showModal();
    updateFrameSpeechEditor();
    await Promise.all([showFrameVideo(frameId, kind), loadFrameAudio(frameId)]);
  }
  async function loadFrameAudio(frameId) {
    if (!frameId || scopeInvalid || !audioFrameIds.has(frameId)) return;
    const record = await MotionArtifactStore.get({
      userId,
      toolProjectId: projectId,
      sourceRevision: Number(project?.data_json?.source_revision || 0),
      frameId,
      kind: "source_audio",
    });
    if (
      !record?.blob ||
      scopeInvalid ||
      selectedFrameId !== frameId ||
      !$("frameDialog").open
    )
      return;
    $("frameDialogAudio").pause();
    $("frameDialogAudio").removeAttribute("src");
    $("frameDialogAudio").load();
    revokeUrl(frameDialogAudioUrl);
    frameDialogAudioUrl = URL.createObjectURL(record.blob);
    $("frameDialogAudio").src = frameDialogAudioUrl;
    $("frameDialogAudio").hidden = false;
  }
  async function saveFrameTranscript() {
    const frameId = selectedFrameId;
    if (!frameId || scopeInvalid || busy) return;
    const hasSpeech = $("frameHasSpeech").checked;
    const transcript = $("frameTranscriptInput").value.trim();
    const translated = $("frameTranslationInput").value.trim();
    if (hasSpeech && !transcript) {
      status(
        motionText(
          "text176",
          "Nh\u1EADp l\u1EDDi tho\u1EA1i ho\u1EB7c b\u1ECF ch\u1ECDn Frame c\xF3 l\u1EDDi n\xF3i.",
        ),
      );
      return;
    }
    busy = true;
    updateButtons();
    $("frameSaveTranscript").disabled = true;
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh();
          if (scopeInvalid || selectedFrameId !== frameId)
            throw new Error("FRAME_SCOPE_CHANGED");
          const frame = project.data_json?.frames?.[frameId];
          if (!frame) throw new Error("FRAME_NOT_FOUND");
          project = await api(
            "PATCH",
            `${endpoint}/frames/${encodeURIComponent(frameId)}/transcript`,
            {
              revision: project.revision,
              source_revision: Number(project.data_json.source_revision),
              run_id: frame.run_id,
              input_revision: frame.input_revision,
              has_speech: hasSpeech,
              transcript: hasSpeech ? transcript : "",
              translated_text: hasSpeech && translated ? translated : null,
              detected_language: frame.transcript?.detected_language || null,
            },
          );
          await refresh();
          await openFrameDialog(frameId, selectedFrameKind);
          status(
            motionFormat(
              "text217",
              "\u0110\xE3 l\u01B0u l\u1EDDi tho\u1EA1i {0}; k\u1EBFt qu\u1EA3 Flow c\u0169 c\u1EA7n t\u1EA1o l\u1EA1i.",
              [frameId],
            ),
          );
        },
      );
    } catch (error) {
      status(motionErrorMessage(error));
    } finally {
      busy = false;
      updateButtons();
    }
  }
  async function finalBlob() {
    if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
    if (!finalArtifact) throw new Error("VIDEO_FINAL_NOT_READY");
    const expectedUserId = userId;
    const expectedSourceRevision = Number(finalArtifact.source_revision);
    const expectedArtifactRevision = Number(finalArtifact.artifact_revision);
    const record = await MotionArtifactStore.get({
      userId,
      toolProjectId: projectId,
      sourceRevision: finalArtifact.source_revision,
      kind: "merged_video",
      artifactRevision: finalArtifact.artifact_revision,
    });
    if (scopeInvalid || userId !== expectedUserId)
      throw new Error("ACCOUNT_SCOPE_CHANGED");
    if (
      Number(finalArtifact?.source_revision) !== expectedSourceRevision ||
      Number(finalArtifact?.artifact_revision) !== expectedArtifactRevision
    ) {
      throw new Error("MOTION_FINAL_SCOPE_CHANGED");
    }
    if (!record?.blob)
      throw new Error(
        motionText(
          "text122",
          "Kh\xF4ng t\xECm th\u1EA5y video ho\xE0n ch\u1EC9nh tr\xEAn thi\u1EBFt b\u1ECB n\xE0y.",
        ),
      );
    return record.blob;
  }
  async function exportFinal(
    blob,
    { watermarkMode = "inherit", assertScope } = {},
  ) {
    if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
    const exportStartedAt = Date.now();
    console.info(
      "[MotionFinalDownload]",
      JSON.stringify({ stage: "prepare", bytes: blob.size }),
    );
    const expectedUserId = userId;
    const expectedSourceRevision = Number(
      project?.data_json?.source_revision || 0,
    );
    const assertCurrent = () => {
      if (scopeInvalid || userId !== expectedUserId)
        throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (
        Number(project?.data_json?.source_revision || 0) !==
        expectedSourceRevision
      )
        throw new Error("MOTION_FINAL_SCOPE_CHANGED");
      assertScope?.();
    };
    assertCurrent();
    let output = blob;
    const settings =
      (await chrome.storage.local.get("af_settings")).af_settings || {};
    const savedWatermark =
      project?.data_json?.preferences?.remove_final_video_watermark;
    const effectiveMode =
      watermarkMode === "inherit" && typeof savedWatermark === "boolean"
        ? savedWatermark
          ? "clean"
          : "original"
        : watermarkMode;
    const forceClean = effectiveMode === "clean";
    if (
      forceClean ||
      (effectiveMode === "inherit" &&
        [true, 1, "1"].includes(settings.autoRemoveWatermarkVideo))
    ) {
      const config = await chrome.runtime.sendMessage({
        action: "getWatermarkConfig",
        mediaType: "video",
      });
      assertCurrent();
      if (config?.success && self.VideoWmClient) {
        const label =
          window.I18n?.t?.("download.phaseCleaning") ||
          "Removing watermark\u2026";
        status(`${label} \xB7 0%`);
        motionToast(`${label} \xB7 0%`, { persistent: true });
        let lastLogAt = 0,
          lastPhase = "";
        let watermarkPercent = 0;
        const result = await self.VideoWmClient.process(blob, config.cfg, {
          isCancelled: () => {
            try {
              assertCurrent();
              return false;
            } catch (_) {
              return true;
            }
          },
          onProgress: (progress) => {
            const now = Date.now();
            if (progress.phase === "complete") watermarkPercent = 100;
            else if (Number.isFinite(progress.ratio))
              watermarkPercent = Math.max(
                watermarkPercent,
                Math.max(0, Math.min(99, Math.floor(progress.ratio * 100))),
              );
            if (progress.phase !== lastPhase || now - lastLogAt >= 5e3) {
              lastPhase = progress.phase;
              lastLogAt = now;
              console.info(
                "[MotionFinalDownload]",
                JSON.stringify({
                  stage: "watermark",
                  phase: progress.phase,
                  frame: Number.isFinite(progress.frame)
                    ? progress.frame
                    : null,
                  percent: watermarkPercent,
                  elapsedMs: now - exportStartedAt,
                }),
              );
            }
            const message = `${label} \xB7 ${watermarkPercent}%`;
            status(message);
            motionToast(message, { persistent: true });
          },
        });
        console.info(
          "[MotionFinalDownload]",
          JSON.stringify({
            stage: "watermark_complete",
            applied: result?.applied === true,
            reason: result?.reason || null,
            elapsedMs: Date.now() - exportStartedAt,
          }),
        );
        if (result?.applied && result.blob) output = result.blob;
        else if (
          !["not_found", "below_threshold", "already_clean_output"].includes(
            result?.reason,
          )
        ) {
          if (forceClean)
            throw new Error(result?.reason || "VIDEO_WM_NOT_APPLIED");
          $("preferencesStatus").textContent = motionErrorMessage(
            result?.reason || "VIDEO_WM_NOT_APPLIED",
          );
        }
      } else if (forceClean) {
        throw new Error(config?.error || "VIDEO_WM_CONFIG_UNAVAILABLE");
      } else if (config?.error !== "NOT_ALLOWED") {
        $("preferencesStatus").textContent = motionErrorMessage(
          config?.error || "VIDEO_WM_CONFIG_UNAVAILABLE",
        );
      }
    }
    assertCurrent();
    const filename = await window.DownloadHelper.buildMotionFilename(project);
    assertCurrent();
    const url = URL.createObjectURL(output);
    const startedAt = Date.now();
    try {
      motionToast(
        window.I18n?.t?.("download.downloading") || "Downloading...",
        { persistent: true },
      );
      console.info(
        "[MotionFinalDownload]",
        JSON.stringify({ stage: "started", bytes: output.size }),
      );
      const result = await chrome.runtime.sendMessage({
        action: "chromeDownload",
        url,
        filename,
        waitForComplete: true,
        waitTimeoutMs: 6e5,
        flowApiDownloadRetry: true,
      });
      if (result?.success !== true)
        throw new Error(result?.error || "MOTION_FINAL_DOWNLOAD_FAILED");
      console.info(
        "[MotionFinalDownload]",
        JSON.stringify({
          stage: "complete",
          elapsedMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      console.warn(
        "[MotionFinalDownload]",
        JSON.stringify({
          stage: "failed",
          elapsedMs: Date.now() - startedAt,
          code: error?.code || error?.message || "MOTION_FINAL_DOWNLOAD_FAILED",
        }),
      );
      throw error;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  async function downloadFinalWithToast(getBlob, options = {}) {
    const translate = (key, fallback) => {
      const value = window.I18n?.t?.(key);
      return value && value !== key ? value : fallback;
    };
    motionToast(translate("download.downloading", "Downloading..."), {
      persistent: true,
    });
    try {
      options.assertScope?.();
      await exportFinal(await getBlob(), options);
      motionToast(translate("download.success", "Downloaded successfully!"));
    } catch (error) {
      const message = `${translate("download.failed", "Download failed")}: ${motionErrorMessage(error)}`;
      status(message);
      motionToast(message, { error: true });
      throw error;
    }
  }
  async function openFinalDownload() {
    if (scopeInvalid || busy || !finalArtifact || finalDownloadPending) return;
    const expectedUserId = userId;
    const expectedSource = Number(finalArtifact.source_revision);
    const expectedRevision = Number(finalArtifact.artifact_revision);
    const expectedArtifactId = finalArtifact.artifact_id;
    const assertScope = () => {
      if (scopeInvalid || userId !== expectedUserId)
        throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (
        Number(project?.data_json?.source_revision) !== expectedSource ||
        Number(finalArtifact?.source_revision) !== expectedSource ||
        Number(finalArtifact?.artifact_revision) !== expectedRevision ||
        finalArtifact?.artifact_id !== expectedArtifactId
      )
        throw new Error("MOTION_FINAL_SCOPE_CHANGED");
    };
    finalDownloadPending = true;
    updateButtons();
    try {
      await window.storageSettings.init();
      await window.featureGate.init();
      assertScope();
      const savedWatermark =
        project?.data_json?.preferences?.remove_final_video_watermark;
      const watermarkMode = await window.DownloadHelper.pickWatermarkVersion({
        mediaType: "video",
        defaultMode:
          typeof savedWatermark === "boolean"
            ? savedWatermark
              ? "clean"
              : "original"
            : null,
      });
      if (watermarkMode === null) return;
      assertScope();
      await downloadFinalWithToast(finalBlob, { watermarkMode, assertScope });
    } finally {
      finalDownloadPending = false;
      updateButtons();
    }
  }
  function mergeClips(clips, options = {}) {
    const task = window.MotionMergeTask.start(
      clips,
      (result) => {
        $("progress").value = result.percent;
        status(
          motionFormat("text202", "\u0110ang gh\xE9p {0}/{1}...", [
            result.index,
            result.count,
          ]),
        );
      },
      options,
    );
    worker = task.worker;
    cancelSplit = () => task.cancel();
    return task.promise.finally(() => {
      if (worker === task.worker) worker = null;
      cancelSplit = null;
    });
  }
  function videoBlobDuration(blob) {
    return window.MotionMergeTask.measureDuration(blob);
  }
  async function mergeFinal({ requireAll = false } = {}) {
    if (scopeInvalid || busy || !canMerge) return;
    const previousStage = activeMotionStage;
    activeMotionStage = "merge";
    const operationId = crypto.randomUUID();
    let mergeStage = "start";
    const startedAt = Date.now();
    busy = true;
    cancelled = false;
    startActivity();
    updateButtons();
    $("progress").value = 0;
    $("resultStageVideo").pause();
    $("resultMergeLoading").hidden = false;
    status(motionText("text178", "\u0110ang gh\xE9p video..."), {
      state: "running",
    });
    try {
      await window.ExecutionConfig.getConfig();
      if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh();
          if (
            !canMerge ||
            scopeInvalid ||
            (requireAll && project.data_json?.paused)
          )
            throw new Error("FRAMES_NOT_READY");
          const sourceRevision = Number(project.data_json.source_revision);
          const local = await MotionArtifactStore.listProject(
            userId,
            projectId,
          );
          const frameIds = Object.entries(project.data_json.frames)
            .filter(
              ([frameId, frame]) =>
                frame.stages?.persist?.state === "ready" &&
                local.some(
                  (item) =>
                    item.sourceRevision === sourceRevision &&
                    item.kind === "generated_clip" &&
                    item.frameId === frameId &&
                    item.artifactRevision === Number(frame.input_revision),
                ),
            )
            .sort((a, b) => a[1].start - b[1].start)
            .map(([frameId]) => frameId);
          if (
            !frameIds.length ||
            (requireAll &&
              frameIds.length !== Object.keys(project.data_json.frames).length)
          )
            throw new Error("FRAMES_NOT_READY");
          console.info(
            "[MotionMerge]",
            JSON.stringify({
              operationId,
              stage: "frames_selected",
              selectedCount: frameIds.length,
              totalCount: Object.keys(project.data_json.frames).length,
            }),
          );
          const frameVersions = Object.fromEntries(
            frameIds.map((frameId) => [
              frameId,
              {
                runId: project.data_json.frames[frameId].run_id,
                inputRevision: project.data_json.frames[frameId].input_revision,
              },
            ]),
          );
          const clips = [];
          for (const frameId of frameIds) {
            const frame = project.data_json.frames[frameId];
            const record = await MotionArtifactStore.get({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              kind: "generated_clip",
              artifactRevision: Number(frame.input_revision),
            });
            if (!record?.blob)
              throw new Error(`MISSING_GENERATED_CLIP:${frameId}`);
            clips.push(record.blob);
          }
          const useOriginalAudio =
            project.data_json?.preferences?.use_original_audio === true;
          const audioOptions = useOriginalAudio
            ? await MotionOriginalAudio.options({
                project,
                frameIds,
                scope: {
                  userId,
                  toolProjectId: projectId,
                  flowProjectId: project.flow_project_id,
                  sourceRevision,
                },
                shouldStop: () => cancelled || scopeInvalid,
                assertScope: async () => {
                  if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                  const current = await api("GET", endpoint);
                  if (
                    current.flow_project_id !== project.flow_project_id ||
                    Number(current.data_json?.source_revision) !==
                      sourceRevision ||
                    (current.data_json?.preferences?.use_original_audio ===
                      true) !==
                      useOriginalAudio
                  )
                    throw new Error("SOURCE_CHANGED_DURING_MERGE");
                },
              })
            : {};
          mergeStage = "prepare_video";
          const merged =
            clips.length === 1 && !useOriginalAudio
              ? { blob: clips[0], duration: await videoBlobDuration(clips[0]) }
              : await mergeClips(clips, audioOptions);
          if (cancelled || scopeInvalid) throw new Error("MOTION_CANCELLED");
          const fresh = await api("GET", endpoint);
          if (
            (requireAll &&
              (fresh.data_json?.paused ||
                Object.keys(fresh.data_json?.frames || {}).length !==
                  frameIds.length)) ||
            Number(fresh.data_json?.source_revision) !== sourceRevision ||
            (fresh.data_json?.preferences?.use_original_audio === true) !==
              useOriginalAudio ||
            frameIds.some(
              (frameId) =>
                fresh.data_json.frames[frameId]?.run_id !==
                  frameVersions[frameId].runId ||
                fresh.data_json.frames[frameId]?.input_revision !==
                  frameVersions[frameId].inputRevision ||
                fresh.data_json.frames[frameId]?.stages?.persist?.state !==
                  "ready",
            )
          ) {
            throw new Error("SOURCE_CHANGED_DURING_MERGE");
          }
          project = fresh;
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          const artifactRevision =
            Number(project.data_json?.final_artifact_revision || 0) + 1;
          mergeStage = "store_video";
          await MotionArtifactStore.put({
            userId,
            toolProjectId: projectId,
            flowProjectId: project.flow_project_id,
            sourceRevision,
            kind: "merged_video",
            artifactRevision,
            blob: merged.blob,
            duration: merged.duration,
          });
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          mergeStage = "finalize";
          const artifactId = `merged_${sourceRevision}_${artifactRevision}`;
          try {
            project = await api("POST", `${endpoint}/finalize`, {
              revision: project.revision,
              source_revision: sourceRevision,
              artifact_revision: artifactRevision,
              artifact_id: artifactId,
              duration: merged.duration,
              frame_ids: frameIds,
              use_original_audio: useOriginalAudio,
            });
          } catch (error) {
            const latest = !scopeInvalid
              ? await api("GET", endpoint).catch(() => null)
              : null;
            const final = latest?.data_json?.final;
            if (
              final?.artifact_id === artifactId &&
              Number(final.source_revision) === sourceRevision &&
              (final.use_original_audio === true) === useOriginalAudio &&
              Number(final.artifact_revision) === artifactRevision
            ) {
              project = latest;
            } else {
              if (
                latest &&
                !scopeInvalid &&
                Number(latest.data_json?.source_revision) === sourceRevision &&
                Number(latest.data_json?.final_artifact_revision || 0) <
                  artifactRevision
              ) {
                await MotionArtifactStore.delete({
                  userId,
                  toolProjectId: projectId,
                  sourceRevision,
                  kind: "merged_video",
                  artifactRevision,
                }).catch((cleanupError) =>
                  console.warn(
                    "[MotionMerge] Uncommitted artifact cleanup failed",
                    cleanupError?.message,
                  ),
                );
              }
              throw error;
            }
          }
          try {
            const old = (
              await MotionArtifactStore.listProject(userId, projectId)
            ).filter(
              (item) =>
                item.sourceRevision === sourceRevision &&
                item.kind === "merged_video" &&
                item.artifactRevision !== artifactRevision,
            );
            for (const artifact of old) {
              await MotionArtifactStore.delete({
                userId,
                toolProjectId: projectId,
                sourceRevision,
                kind: "merged_video",
                artifactRevision: artifact.artifactRevision,
              });
            }
          } catch (error) {
            console.warn(
              "[MotionMerge] Old artifact cleanup failed",
              error?.message,
            );
          }
          await refresh();
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          status(
            motionFormat("text203", "\u0110\xE3 gh\xE9p {0} frame \xB7 {1}s", [
              frameIds.length,
              merged.duration.toFixed(2),
            ]),
          );
          console.info(
            "[MotionMerge]",
            JSON.stringify({
              operationId,
              stage: "complete",
              selectedCount: frameIds.length,
              elapsedMs: Date.now() - startedAt,
            }),
          );
          $("progress").value = 100;
          if (project.data_json?.preferences?.auto_download_final === true) {
            try {
              await downloadFinalWithToast(async () => merged.blob);
            } catch (error) {
              console.warn(
                "[MotionMerge] Final download failed",
                error?.code || error?.message,
              );
              status(motionErrorMessage(error));
            }
          }
        },
      );
    } catch (error) {
      console.warn(
        "[MotionMerge]",
        JSON.stringify({
          operationId,
          stage: mergeStage,
          elapsedMs: Date.now() - startedAt,
          code: error?.code || error?.message || "MOTION_MERGE_FAILED",
          httpStatus: error?.httpStatus || null,
        }),
      );
      if (!scopeInvalid) await refresh().catch(() => {});
      status(motionErrorMessage(error));
    } finally {
      activeMotionStage = previousStage;
      $("resultMergeLoading").hidden = true;
      busy = false;
      cancelSplit = null;
      worker?.terminate();
      worker = null;
      settleActivity();
      updateButtons();
    }
  }
  function mediaButtons(frameId, kind, label) {
    const actions = document.createElement("span");
    actions.className = "motion-media-actions";
    for (const [action, text] of [
      ["play", `\u25B6 ${label}`],
      ["download", `\u2193 ${label}`],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.addEventListener("click", () =>
        mediaAction(frameId, kind, action).catch((error) =>
          status(motionErrorMessage(error)),
        ),
      );
      actions.append(button);
    }
    return actions;
  }
  async function loadResolutions() {
    try {
      await ProviderConfigManager._fetchApiConfigs();
      const config = ProviderConfigManager.getDownloadResolutionsSync("flow");
      resolutions = (Array.isArray(config?.video) ? config.video : []).filter(
        (item) =>
          item &&
          /^[A-Za-z0-9]{1,20}$/.test(item.value) &&
          typeof item.label === "string",
      );
      if (!resolutions.length)
        throw new window.ConfigRequiredError(
          "flow_download_resolutions",
          "data_missing",
        );
      MotionResolutionPolicy.candidates(config, resolutions[0].value);
      const select = $("flowResolution");
      select.replaceChildren();
      for (const item of resolutions) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.append(option);
      }
      const stored = project.data_json?.preferences?.flow_download_resolution;
      await window.storageSettings?.init?.();
      renderProjectFlowMode();
      select.value = MotionResolutionPolicy.preferredValue(resolutions, stored);
      select.disabled = scopeInvalid || busy || motionSettingsRunLocked();
      $("savePreferences").disabled = select.disabled;
      ratios = ProviderConfigManager.getRatiosSync("flow", "video").map((r) => (typeof r === "string" ? r : r?.value)).filter(
        (value) =>
          typeof value === "string" && /^[0-9]{1,2}:[0-9]{1,2}$/.test(value),
      );
      if (!ratios.length)
        throw new window.ConfigRequiredError(
          "ratios_flow_video",
          "data_missing",
        );
      const ratioSelect = $("motionRatio");
      ratioSelect.replaceChildren();
      for (const value of ratios) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        ratioSelect.append(option);
      }
      const savedRatio = project.data_json?.preferences?.ratio;
      if (ratios.includes(savedRatio)) ratioSelect.value = savedRatio;
      else if (!savedRatio) {
        const userRatio =
          window.storageSettings?.getSettings?.()?.defaultVideoRatio;
        if (ratios.includes(userRatio)) ratioSelect.value = userRatio;
      }
      ratioSelect.disabled = scopeInvalid || busy || motionSettingsRunLocked();
      window.motionRatioPickerRender?.();
      $("saveMotionSettings").disabled = ratioSelect.disabled;
    } catch (error) {
      $("motionSettingsStatus").textContent = motionErrorMessage(error);
      throw error;
    }
  }
  async function initializeNewProjectRatio() {
    if (
      scopeInvalid ||
      project?.data_json?.preferences?.ratio ||
      Number(project?.data_json?.source_revision || 0) !== 0 ||
      Object.keys(project?.data_json?.frames || {}).length
    )
      return;
    const userRatio =
      window.storageSettings?.getSettings?.()?.defaultVideoRatio;
    if (!ratios.includes(userRatio)) return;
    if (!navigator.locks?.request) throw new Error("PROJECT_LOCK_UNAVAILABLE");
    await navigator.locks.request(
      `motion:${userId}:${projectId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
        const fresh = await api("GET", endpoint);
        if (scopeInvalid || fresh?.tool_project_id !== projectId)
          throw new Error("PROJECT_SCOPE_MISMATCH");
        if (
          !fresh.data_json?.preferences?.ratio &&
          Number(fresh.data_json?.source_revision || 0) === 0 &&
          !Object.keys(fresh.data_json?.frames || {}).length
        ) {
          await api("PATCH", endpoint, {
            revision: fresh.revision,
            ratio: userRatio,
          });
        }
        await refresh();
      },
    );
  }
  function updateMotionVisibility() {
    const [ratioW, ratioH] = $("motionRatio").value.split(":").map(Number);
    if (ratioW > 0 && ratioH > 0) {
      document.documentElement.style.setProperty(
        "--motion-preview-ratio",
        String(ratioW / ratioH),
      );
    }
    $("removeFinalVideoWatermarkRow").hidden = !$("autoDownloadFinal").checked;
    const needsSpeech =
      $("voiceEnabled").checked || $("subtitleEnabled").checked;
    const agentField = $("motionSpeechAgentField");
    if (agentField) agentField.hidden = !needsSpeech;
    $("reviewSubtitleRow").hidden =
      !needsSpeech ||
      window.ExecutionConfig?.getMotionExecutionModeSync(
        profile?.settings?.execution_mode,
        $("transcriptionAgent").value ||
          profile?.settings?.transcription_provider,
      ) !== "parallel";
    $("reviewSubtitle").disabled =
      !needsSpeech || busy || motionSettingsRunLocked() || scopeInvalid;
    $("translateDialogueRow").hidden = !needsSpeech;
    $("translateEnabled").disabled =
      !needsSpeech || busy || motionSettingsRunLocked() || scopeInvalid;
    if (!needsSpeech) $("translateEnabled").checked = false;
    $("targetLanguageRow").hidden = !$("translateEnabled").checked;
    $("voiceDescriptionRow").hidden = !$("voiceEnabled").checked;
    $("voiceModeRow").hidden = !$("voiceEnabled").checked;
    $("voiceModeHint").hidden = window.MotionPromptComposer.hasVoiceStyle(
      profile,
      $("motionVoiceMode").value,
    );
    const showFlowVoice = profile?.settings?.show_flow_voice !== false;
    $("voicePickerRow").hidden = !$("voiceEnabled").checked || !showFlowVoice;
    $("voicePickerRow").parentElement?.classList.toggle(
      "is-single-field",
      !showFlowVoice,
    );
    $("motionVoiceTrigger").disabled =
      scopeInvalid ||
      busy ||
      motionSettingsRunLocked() ||
      !$("voiceEnabled").checked ||
      !showFlowVoice;
    updateFrameSpeechEditor();
  }
  function motionSettingsRunLocked() {
    return (
      motionRunning ||
      project?.data_json?.split_operation?.state === "running" ||
      Object.values(project?.data_json?.frames || {}).some((frame) =>
        [
          "upload",
          "transcribe",
          "continuity",
          "submit",
          "monitor",
          "persist",
        ].some((stage) =>
          ["running", "needs_review"].includes(frame.stages?.[stage]?.state),
        ),
      )
    );
  }
  function showMotionSettingsLocked() {
    const message = motionText("settingsLocked", "");
    $("motionSettingsStatus").textContent = message;
    $("preferencesStatus").textContent = message;
  }
  function effectiveFlowModel() {
    return (
      project?.data_json?.preferences?.flow_model ||
      profile?.settings?.flow_model ||
      ""
    );
  }
  function renderFlowModels({ preservePending = true } = {}) {
    const select = $("motionFlowModel");
    if (!select || !profile) return;
    const selected =
      preservePending && settingsDirty && select.value
        ? select.value
        : effectiveFlowModel();
    const models = window.ModelRegistry.getModelsSync("flow", "video").filter(
      (model) => model.config?.supports_ref_video === true,
    );
    select.replaceChildren();
    for (const model of models) select.add(new Option(model.name, model.value));
    if (selected && !models.some((model) => model.value === selected)) {
      const unavailable = new Option(selected, selected);
      unavailable.disabled = true;
      select.add(unavailable);
    }
    select.value = selected;
    select.disabled =
      scopeInvalid || busy || motionSettingsRunLocked() || !models.length;
  }
  let speechDecisionPending = false;
  function renderSplitSummary() {
    const summary = $("motionSplitSummary");
    if (
      !summary ||
      !window.MotionSplitPolicy ||
      !window.MotionSplitSettingsDialog
    )
      return;
    try {
      const text = (key, values) =>
        window.MotionSplitSettingsDialog.text(key, values);
      const applied = window.MotionSplitPolicy.applied(project);
      const desired = window.MotionSplitPolicy.desired(
        project?.data_json?.preferences,
      );
      const frames = Object.values(project?.data_json?.frames || {});
      const limit = applied
        ? project.data_json.source.split_limit_seconds ||
          Math.max(
            ...frames.map(
              (frame) => Math.round((frame.end - frame.start) * 1e3) / 1e3,
            ),
          )
        : window.MotionSplitPolicy.limit(project, profile);
      if (!Number.isFinite(Number(limit)) || Number(limit) <= 0) {
        summary.hidden = true;
        return;
      }
      const lines = [
        text(applied ? "applied" : "planned", {
          strategy: text(applied || desired),
          seconds: limit,
        }),
      ];
      if (applied && applied !== desired)
        lines.push(text("nextSplit", { strategy: text(desired) }));
      const state =
        desired === "duration"
          ? "speechOff"
          : frames.some(
                (frame) =>
                  frame.stages?.split?.audio_state === "audio_not_requested",
              )
            ? "audioPending"
            : frames.length &&
                frames.every(
                  (frame) =>
                    frame.stages?.split?.audio_state === "audio_track_absent",
                )
              ? "noAudio"
              : frames.length &&
                  frames.every(
                    (frame) => frame.stages?.transcribe?.state === "ready",
                  )
                ? "speechReady"
                : "speechPending";
      lines.push(text(state));
      const fallbackCuts = project?.data_json?.source?.split_time_cuts;
      if (applied === "silence" && fallbackCuts > 0)
        lines.push(text("fallbackCuts", { count: fallbackCuts }));
      if (applied === "duration" && desired === "silence")
        lines.push(text("boundaryWarning"));
      summary.textContent = lines.join(" \u2022 ");
      summary.hidden = false;
    } catch (_) {
      summary.textContent = "";
      summary.hidden = true;
    }
  }
  async function decideSpeechSettingsChange(event) {
    if (!window.MotionSplitPolicy || !project) return;
    const next = {
      ...project.data_json?.preferences,
      voice_enabled: $("voiceEnabled").checked,
      subtitle_enabled: $("subtitleEnabled").checked,
    };
    if (!window.MotionSplitPolicy.needsDecision(project, next)) return;
    event.stopImmediatePropagation();
    const previous = {
      voice: project.data_json?.preferences?.voice_enabled === true,
      subtitle: project.data_json?.preferences?.subtitle_enabled === true,
    };
    const restore = () => {
      $("voiceEnabled").checked = previous.voice;
      $("subtitleEnabled").checked = previous.subtitle;
    };
    if (
      speechDecisionPending ||
      scopeInvalid ||
      busy ||
      motionSettingsRunLocked()
    ) {
      restore();
      return;
    }
    const expected = {
      userId,
      sourceRevision: project.data_json.source_revision,
      flowProjectId: project.flow_project_id,
    };
    const wasDirty = settingsDirty;
    const discardUnappliedChange = () => {
      restore();
      if (
        !wasDirty &&
        !scopeInvalid &&
        (project.data_json?.preferences?.voice_enabled === true) ===
          previous.voice &&
        (project.data_json?.preferences?.subtitle_enabled === true) ===
          previous.subtitle
      )
        settingsDirty = false;
    };
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    speechDecisionPending = true;
    updateButtons();
    let applied = false,
      cancelledChoice = false;
    try {
      const saved = await MotionArtifactStore.get({
        userId,
        toolProjectId: projectId,
        sourceRevision: expected.sourceRevision,
        kind: "source_video",
      });
      const choice = await window.MotionSplitSettingsDialog.open({
        frameCount: Object.keys(project.data_json.frames || {}).length,
        resultCount: window.MotionSplitPolicy.resultCount(project),
        canResplit: !!saved?.blob,
      });
      console.info("[MotionSplitSettings]", {
        sourceRevision: expected.sourceRevision,
        appliedStrategy: "duration",
        requestedStrategy: "silence",
        choice: choice || "cancel",
      });
      if (!choice) {
        cancelledChoice = true;
        restore();
        return;
      }
      if (
        scopeInvalid ||
        userId !== expected.userId ||
        project.data_json.source_revision !== expected.sourceRevision ||
        project.flow_project_id !== expected.flowProjectId
      )
        throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
      settingsDirty = true;
      $("voiceEnabled").checked = next.voice_enabled;
      $("subtitleEnabled").checked = next.subtitle_enabled;
      await saveMotionSettings();
      if (settingsDirty || scopeInvalid) {
        discardUnappliedChange();
        return;
      }
      applied = true;
      if (choice === "resplit") {
        await prepareSource({ forceResplit: true, replacementConfirmed: true });
      } else status(window.MotionSplitSettingsDialog.text("kept"));
    } catch (error) {
      if (!applied) discardUnappliedChange();
      status(motionErrorMessage(error));
    } finally {
      speechDecisionPending = false;
      updateButtons();
      renderSplitSummary();
      if (
        cancelledChoice &&
        wasDirty &&
        settingsDirty &&
        !scopeInvalid &&
        !busy
      )
        scheduleSettingsSave();
    }
  }
  async function saveMotionSettings() {
    globalThis.MotionTextFieldLimits?.refresh();
    if (motionSettingsRunLocked()) {
      showMotionSettingsLocked();
      return;
    }
    if (
      document.activeElement === $("voiceDescription") ||
      document.activeElement === $("motionCustomPrompt")
    )
      return;
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    clearTimeout(savedHintTimer);
    for (const id of ["motionSettingsStatus", "preferencesStatus"])
      $(id).classList.remove("is-saved");
    if (
      scopeInvalid ||
      busy ||
      !profile ||
      !ratios.includes($("motionRatio").value)
    )
      return;
    const invalidText = ["voiceDescription", "motionCustomPrompt"]
      .map($)
      .find((input) => input?.validity?.customError === true);
    if (invalidText) {
      $("motionSettingsStatus").textContent = invalidText.validationMessage;
      $("preferencesStatus").textContent = motionText(
        "text113",
        "Ch\u01B0a l\u01B0u thay \u0111\u1ED5i.",
      );
      return;
    }
    const requested = {
      voice_enabled: $("voiceEnabled").checked,
      voice_mode: $("motionVoiceMode").value,
      transcription_provider: $("transcriptionAgent").value,
      subtitle_enabled: $("subtitleEnabled").checked,
      review_subtitle: $("reviewSubtitle").checked,
      translate_enabled: $("translateEnabled").checked,
      target_language: $("translateEnabled").checked
        ? $("targetLanguage").value.trim()
        : null,
      ratio: $("motionRatio").value,
      flow_model: $("motionFlowModel").value || null,
      voice_description: $("voiceEnabled").checked
        ? $("voiceDescription").value.trim()
        : null,
      custom_prompt: $("motionCustomPrompt").value.trim() || null,
      voice_slug: $("motionVoiceSlug").value || null,
      references: { ...references, mode: $("referenceMode").value },
      ...(Number($("characterCount").value) === 2 ||
      Object.hasOwn(project.data_json?.preferences || {}, "character_count")
        ? { character_count: Number($("characterCount").value) }
        : {}),
      auto_download_final: $("autoDownloadFinal").checked,
      use_original_audio: $("useOriginalAudio").checked,
      continuity_enabled: $("continuityEnabled").checked,
      remove_final_video_watermark: $("removeFinalVideoWatermark").checked,
      ...(resolutions.some((item) => item.value === $("flowResolution").value)
        ? { flow_download_resolution: $("flowResolution").value }
        : {}),
    };
    if (requested.translate_enabled && !requested.target_language) {
      $("motionSettingsStatus").textContent = motionText(
        "text116",
        "Nh\u1EADp ng\xF4n ng\u1EEF \u0111\xEDch tr\u01B0\u1EDBc khi l\u01B0u.",
      );
      return;
    }
    busy = true;
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh({ preserveMotionSettings: true });
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          if (motionSettingsRunLocked())
            throw new Error("MOTION_SETTINGS_LOCKED");
          project = await api("PATCH", endpoint, {
            revision: project.revision,
            ...requested,
          });
          await refresh();
          settingsDirty = false;
          voiceDescriptionDirty = false;
          showSettingsSaved();
        },
      );
    } catch (error) {
      if (!scopeInvalid) {
        for (const [id, key] of Object.entries({
          voiceEnabled: "voice_enabled",
          subtitleEnabled: "subtitle_enabled",
          reviewSubtitle: "review_subtitle",
          translateEnabled: "translate_enabled",
          autoDownloadFinal: "auto_download_final",
          useOriginalAudio: "use_original_audio",
          continuityEnabled: "continuity_enabled",
          removeFinalVideoWatermark: "remove_final_video_watermark",
        }))
          $(id).checked = requested[key] === true;
        for (const [id, key] of Object.entries({
          transcriptionAgent: "transcription_provider",
          targetLanguage: "target_language",
          motionRatio: "ratio",
          voiceDescription: "voice_description",
          motionCustomPrompt: "custom_prompt",
          motionVoiceSlug: "voice_slug",
          motionVoiceMode: "voice_mode",
        }))
          $(id).value = requested[key] ?? "";
        $("motionFlowModel").value =
          requested.flow_model || profile?.settings?.flow_model || "";
        if (requested.flow_download_resolution)
          $("flowResolution").value = requested.flow_download_resolution;
        $("referenceMode").value = requested.references.mode;
        $("characterCount").value = String(
          requested.character_count ??
            project.data_json?.preferences?.character_count ??
            1,
        );
        renderReferences();
      }
      $("motionSettingsStatus").textContent = motionErrorMessage(error);
      $("preferencesStatus").textContent = motionText(
        "text113",
        "Ch\u01B0a l\u01B0u thay \u0111\u1ED5i.",
      );
    } finally {
      busy = false;
      settleActivity();
      updateButtons();
    }
  }
  function showSettingsSaved(
    message = motionText("text112", "\u0110\xE3 l\u01B0u"),
  ) {
    clearTimeout(savedHintTimer);
    $("motionSettingsStatus").textContent = "";
    $("motionSettingsStatus").classList.remove("is-saved");
    const hint = $("preferencesStatus");
    hint.textContent = message;
    hint.classList.add("is-saved");
    savedHintTimer = setTimeout(() => {
      hint.textContent = "";
      hint.classList.remove("is-saved");
    }, 2500);
  }
  async function refreshAgentStatus() {
    if (scopeInvalid) return;
    if (
      !$("voiceEnabled").checked &&
      !$("subtitleEnabled").checked &&
      !activeFrameMenu
    ) {
      agentStatusEpoch++;
      agentHealthPending = false;
      clearTimeout(agentHealthDebounce);
      return;
    }
    renderAgentConnection();
    if (agentHealthInFlight) {
      agentHealthPending = true;
      return agentHealthInFlight;
    }
    agentHealthInFlight = performAgentStatusCheck();
    try {
      await agentHealthInFlight;
    } finally {
      agentHealthInFlight = null;
      if (agentHealthPending && settingsReady && !scopeInvalid) {
        agentHealthPending = false;
        clearTimeout(agentHealthDebounce);
        agentHealthDebounce = setTimeout(() => void refreshAgentStatus(), 1500);
      }
    }
  }
  async function performAgentStatusCheck() {
    const epoch = ++agentStatusEpoch;
    const provider = $("transcriptionAgent").value;
    const label = $("transcriptionAgentStatus");
    if (agentHealth?.provider !== provider) agentHealth = null;
    renderAgentConnection();
    updateFrameMenuAgentStatus();
    if (!agentHealth) {
      label.textContent =
        agentConnection?.provider === provider
          ? window.I18n.t("auth.connecting")
          : motionText("text023", "\u0110ang ki\u1EC3m tra...");
      label.classList.remove("is-ready", "is-warning");
      label.classList.add("is-checking");
      label.parentElement.hidden = false;
      updateButtons();
    }
    const result = await chrome.runtime
      .sendMessage({
        action: "i2p:checkProviders",
        excludeWorkerTabs: profile?.settings?.execution_mode === "parallel",
      })
      .catch(() => null);
    if (
      scopeInvalid ||
      epoch !== agentStatusEpoch ||
      provider !== $("transcriptionAgent").value
    )
      return;
    document.querySelectorAll("[data-motion-agent]").forEach((button) => {
      const status2 = result?.ok
        ? result.providers?.[button.dataset.motionAgent]
        : null;
      button.classList.toggle("is-ready", status2?.ready === true);
      button.title = status2?.ready
        ? motionText("text007", "S\u1EB5n s\xE0ng")
        : status2?.tabOpen
          ? "C\u1EA7n ki\u1EC3m tra trang"
          : motionText("text182", "Ch\u01B0a m\u1EDF trang provider");
    });
    const state = result?.ok ? result.providers?.[provider] : null;
    const healthChanged =
      agentHealth?.provider !== provider ||
      agentHealth?.ready !== (state?.ready === true);
    agentHealth = {
      provider,
      ready: state?.ready === true,
      tabOpen: state?.tabOpen === true,
    };
    const message = state?.ready
      ? ""
      : state?.tabOpen
        ? motionText(
            "text181",
            "C\u1EA7n \u0111\u0103ng nh\u1EADp / ki\u1EC3m tra trang",
          )
        : motionText("text182", "Ch\u01B0a m\u1EDF trang provider");
    if (label.textContent !== message) label.textContent = message;
    if (label.parentElement.hidden !== (state?.ready === true))
      label.parentElement.hidden = state?.ready === true;
    label.classList.toggle("is-ready", state?.ready === true);
    label.classList.remove("is-checking");
    label.classList.toggle("is-warning", state?.ready !== true);
    $("transcriptionAgentOpen").hidden = state?.ready === true;
    renderAgentConnection();
    updateFrameMenuAgentStatus();
    if (healthChanged) updateButtons();
  }
  function isSelectedAgentReady() {
    return (
      agentHealth?.provider === $("transcriptionAgent").value &&
      agentHealth.ready === true
    );
  }
  function isAgentReadyForGeneration() {
    if (!$("voiceEnabled").checked && !$("subtitleEnabled").checked)
      return true;
    const frames = Object.values(project?.data_json?.frames || {});
    const preferences = project?.data_json?.preferences || {};
    if (
      !pendingSourceFile &&
      frames.length &&
      frames.every((frame) => {
        if (
          frame.stages?.persist?.state === "ready" ||
          frame.stages?.monitor?.state === "ready" ||
          [
            "audio_track_absent",
            "silent_verified",
            "audio_decode_unsupported",
          ].includes(frame.stages?.split?.audio_state)
        )
          return true;
        return (
          !!frame.transcript &&
          !(
            preferences.translate_enabled === true &&
            frame.transcript.has_speech === true &&
            (frame.transcript.translation_stale === true ||
              !String(frame.transcript.translated_text || "").trim())
          )
        );
      })
    )
      return true;
    return isSelectedAgentReady();
  }
  function updateFrameMenuAgentStatus() {
    if (activeFrameMenu?.refreshState) {
      activeFrameMenu.refreshState();
      return;
    }
    const button = activeFrameMenu?.querySelector("[data-motion-create-sub]");
    if (button)
      button.disabled = busy || motionRunning || !isSelectedAgentReady();
  }
  function scheduleAgentHealthCheck() {
    if (
      !settingsReady ||
      scopeInvalid ||
      (!$("voiceEnabled").checked &&
        !$("subtitleEnabled").checked &&
        !activeFrameMenu)
    )
      return;
    agentStatusEpoch++;
    clearTimeout(agentHealthDebounce);
    agentHealthDebounce = setTimeout(() => void refreshAgentStatus(), 1500);
  }
  function renderAgentConnection() {
    const provider = $("transcriptionAgent").value;
    const connecting = agentConnection?.provider === provider;
    const button = $("transcriptionAgentOpen");
    const copy = button.querySelector?.("[data-i18n]");
    if (copy) {
      copy.dataset.i18n = connecting
        ? "auth.connecting"
        : "motionEditor.text024";
      copy.textContent = connecting
        ? window.I18n.t("auth.connecting")
        : motionText("text024", "Connect");
    }
    button.disabled = scopeInvalid || connecting;
    button.setAttribute?.("aria-busy", String(connecting));
    if (agentConnection && !connecting && agentHealth?.provider !== provider) {
      const label = $("transcriptionAgentStatus");
      label.textContent = motionText("text023", "\u0110ang ki\u1EC3m tra...");
      label.parentElement.hidden = false;
      button.hidden = false;
    }
    if (connecting && !isSelectedAgentReady()) {
      const label = $("transcriptionAgentStatus");
      label.textContent = window.I18n.t("auth.connecting");
      label.classList.remove("is-ready", "is-warning");
      label.classList.add("is-checking");
      label.parentElement.hidden = false;
      button.hidden = false;
    }
  }
  function connectSpeechAgent() {
    if (scopeInvalid || !settingsReady) return Promise.resolve();
    const provider = $("transcriptionAgent").value;
    if (agentConnection?.provider === provider) return agentConnection.flight;
    const connection = { provider, flight: null };
    agentConnection = connection;
    agentHealth = null;
    agentStatusEpoch++;
    renderAgentConnection();
    updateFrameMenuAgentStatus();
    updateButtons();
    connection.flight = (async () => {
      try {
        const budget =
          await window.ExecutionConfig.getProviderStartupTimeoutMs(provider);
        if (
          agentConnection !== connection ||
          scopeInvalid ||
          $("transcriptionAgent").value !== provider
        )
          return;
        const opened = await chrome.runtime.sendMessage({
          action: "i2p:openProviderLogin",
          provider,
        });
        if (!opened?.ok)
          throw new Error(opened?.error || "PROVIDER_PAGE_OPEN_FAILED");
        const deadline = Date.now() + budget;
        while (
          !scopeInvalid &&
          agentConnection === connection &&
          $("transcriptionAgent").value === provider &&
          Date.now() < deadline
        ) {
          await refreshAgentStatus();
          if (isSelectedAgentReady()) break;
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      } catch (error) {
        if (
          agentConnection === connection &&
          $("transcriptionAgent").value === provider &&
          !scopeInvalid
        ) {
          $("transcriptionAgentStatus").textContent = motionErrorMessage(error);
          $("transcriptionAgentStatus").classList.remove("is-checking");
          $("transcriptionAgentStatus").classList.add("is-warning");
          if (
            window.ConfigRequiredError?.is?.(error) ||
            error?.name === "ConfigRequiredError"
          )
            window.ConfigErrorHandler?.handle?.(error, "Motion agent connect");
        }
      } finally {
        if (agentConnection === connection) {
          agentConnection = null;
          renderAgentConnection();
          if (!scopeInvalid) {
            const label = $("transcriptionAgentStatus");
            if (agentHealth?.provider === $("transcriptionAgent").value) {
              label.textContent = agentHealth.ready
                ? ""
                : agentHealth.tabOpen
                  ? motionText(
                      "text181",
                      "C\u1EA7n \u0111\u0103ng nh\u1EADp / ki\u1EC3m tra trang",
                    )
                  : motionText("text182", "Ch\u01B0a m\u1EDF trang provider");
              label.classList.remove("is-checking");
              label.classList.toggle("is-warning", !agentHealth.ready);
            } else if (label.textContent === window.I18n.t("auth.connecting")) {
              label.textContent = motionText(
                "text181",
                "C\u1EA7n \u0111\u0103ng nh\u1EADp / ki\u1EC3m tra trang",
              );
              label.classList.remove("is-checking");
              label.classList.add("is-warning");
            }
          }
        }
      }
    })();
    return connection.flight;
  }
  function scheduleSettingsSave(event) {
    if (!settingsReady || scopeInvalid || busy) return;
    if (motionSettingsRunLocked()) {
      showMotionSettingsLocked();
      return;
    }
    const voiceInput = event?.target === $("voiceDescription");
    const textInput = voiceInput || event?.target === $("motionCustomPrompt");
    if (textInput && event.type === "focus") {
      clearTimeout(settingsSaveTimer);
      settingsSaveTimer = null;
      updateButtons();
      return;
    }
    if (
      textInput &&
      event.type === "blur" &&
      !settingsDirty &&
      !voiceDescriptionDirty
    )
      return;
    if (
      voiceInput &&
      ["input", "change", "compositionend"].includes(event.type)
    )
      voiceDescriptionDirty = true;
    settingsDirty = true;
    clearTimeout(savedHintTimer);
    for (const id of ["motionSettingsStatus", "preferencesStatus"])
      $(id).classList.remove("is-saved");
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    $("motionSettingsStatus").textContent = motionText(
      "text114",
      "\u0110ang ch\u1EDD l\u01B0u...",
    );
    $("preferencesStatus").textContent = motionText(
      "text114",
      "\u0110ang ch\u1EDD l\u01B0u...",
    );
    if (
      document.activeElement === $("voiceDescription") ||
      document.activeElement === $("motionCustomPrompt") ||
      (textInput && event.isComposing)
    ) {
      updateButtons();
      return;
    }
    settingsSaveTimer = setTimeout(() => {
      settingsSaveTimer = null;
      if (
        document.activeElement === $("voiceDescription") ||
        document.activeElement === $("motionCustomPrompt")
      )
        return;
      if (motionSettingsRunLocked()) {
        showMotionSettingsLocked();
        return;
      }
      if (scopeInvalid || busy) {
        $("motionSettingsStatus").textContent = motionText(
          "text115",
          "Ch\u01B0a l\u01B0u. Th\u1EED l\u1EA1i khi t\xE1c v\u1EE5 ho\xE0n t\u1EA5t.",
        );
        return;
      }
      $("motionSettingsStatus").textContent = motionText(
        "text183",
        "\u0110ang l\u01B0u...",
      );
      void saveMotionSettings();
    }, 600);
    updateButtons();
  }
  async function savePreferences() {
    if (motionSettingsRunLocked()) {
      showMotionSettingsLocked();
      return;
    }
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
    if (
      scopeInvalid ||
      busy ||
      !resolutions.some((item) => item.value === $("flowResolution").value)
    )
      return;
    const requested = {
      auto_download_final: $("autoDownloadFinal").checked,
      use_original_audio: $("useOriginalAudio").checked,
      continuity_enabled: $("continuityEnabled").checked,
      remove_final_video_watermark: $("removeFinalVideoWatermark").checked,
      flow_download_resolution: $("flowResolution").value,
    };
    busy = true;
    updateButtons();
    $("savePreferences").disabled = true;
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh({ preserveMotionSettings: true });
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          if (motionSettingsRunLocked())
            throw new Error("MOTION_SETTINGS_LOCKED");
          project = await api("PATCH", endpoint, {
            revision: project.revision,
            ...requested,
          });
          $("autoDownloadFinal").checked = requested.auto_download_final;
          $("useOriginalAudio").checked = requested.use_original_audio;
          $("continuityEnabled").checked = requested.continuity_enabled;
          $("removeFinalVideoWatermark").checked =
            requested.remove_final_video_watermark;
          showSettingsSaved();
        },
      );
    } catch (error) {
      $("preferencesStatus").textContent = motionErrorMessage(error);
    } finally {
      busy = false;
      updateButtons();
    }
  }
  async function saveProjectName() {
    const name = $("projectNameInput").value.trim();
    if (scopeInvalid || busy || settingsSaveTimer) return;
    if (!name || name.length > 160) {
      $("projectNameInput").setCustomValidity(
        "T\xEAn project c\u1EA7n c\xF3 1\u2013160 k\xFD t\u1EF1.",
      );
      $("projectNameInput").reportValidity();
      return;
    }
    if (name === project?.name) {
      finishNameEdit();
      return;
    }
    busy = true;
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh();
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          project = await api("PATCH", endpoint, {
            revision: project.revision,
            name,
          });
          await chrome.storage.local
            .set({
              motion_project_changed: {
                userId,
                projectId,
                nonce: crypto.randomUUID(),
              },
            })
            .catch((error) =>
              console.warn(
                "[Motion] Project list notification failed",
                error?.message,
              ),
            );
          $("projectName").textContent = project.name;
          document.title = `${project.name} \xB7 Motion Studio`;
          finishNameEdit();
          showSettingsSaved();
        },
      );
    } catch (error) {
      status(motionErrorMessage(error));
    } finally {
      busy = false;
      updateButtons();
    }
  }
  async function pauseLocalMotionProvider(diagnostic, frameId) {
    if (
      scopeInvalid ||
      cancelled ||
      !motionQueueJobId ||
      localMotionProviderPause
    )
      return;
    const held = (localMotionProviderPause = {
      jobId: motionQueueJobId,
      frameId,
      error: MotionFlowQueueRequest.errorCode(
        diagnostic.code,
        diagnostic.reason,
      ),
    });
    activeFlowStartedAt = 0;
    settleActivity(true);
    status(motionErrorMessage(held.error), { state: "paused" });
    updateButtons();
    const saved = await setPaused(true, { providerPause: true });
    if (scopeInvalid || localMotionProviderPause !== held) return;
    console.info(
      "[MotionProviderPause]",
      JSON.stringify({
        frameId,
        jobId: held.jobId,
        stage: "editor_paused",
        pauseSaved: saved === true,
        code: held.error,
      }),
    );
    status(motionErrorMessage(held.error), { state: "paused" });
    settleActivity(true);
    updateButtons();
    motionToast(motionErrorMessage(held.error), { error: true });
  }
  async function setPaused(paused, { providerPause = false } = {}) {
    if (scopeInvalid) return;
    if (
      !paused &&
      !busy &&
      !motionRunning &&
      !pausedStandaloneTask &&
      externalMotionRun?.state !== "needs_review" &&
      isMotionProjectComplete()
    ) {
      status(motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh"), {
        state: "ready",
      });
      settleActivity();
      updateButtons();
      return true;
    }
    if (
      externalMotionRun &&
      (!paused ||
        ["preparing", "running", "pausing"].includes(externalMotionRun.state))
    ) {
      try {
        const response = await chrome.runtime.sendMessage({
          action: paused ? "motionRunner:pause" : "motionRunner:resume",
          projectId,
          flowProjectId: project?.flow_project_id,
          runId: externalMotionRun.runId,
          screen: {
            screenLeft: window.screen?.availLeft,
            screenTop: window.screen?.availTop,
            screenWidth: window.screen?.availWidth,
            screenHeight: window.screen?.availHeight,
          },
        });
        if (response?.success !== true)
          throw new Error(response?.error || "MOTION_RUN_FAILED");
        externalMotionRun = {
          ...externalMotionRun,
          state: paused ? "pausing" : "preparing",
          runId: response.runId || externalMotionRun.runId,
        };
        motionRunning = true;
        updateButtons();
        if (paused)
          status(
            motionText(
              "text137",
              "\u0110\xE3 t\u1EA1m d\u1EEBng l\u01B0\u1EE3t m\u1EDBi. Frame \u0111\xE3 g\u1EEDi Flow v\u1EABn ti\u1EBFp t\u1EE5c \u0111\u01B0\u1EE3c theo d\xF5i.",
            ),
            { state: "paused" },
          );
        if (!paused) {
          const stored = await chrome.storage.local
            .get(`motion_runner_status:${userId}:${projectId}`)
            .catch(() => ({}));
          await acceptExternalMotionStatus(
            stored?.[`motion_runner_status:${userId}:${projectId}`],
          );
        }
        return true;
      } catch (error) {
        status(motionErrorMessage(error || "MOTION_RUN_FAILED"));
        return false;
      }
    }
    if (paused && motionRunning && activeMotionStage === "audio") {
      deferredUploadPause = true;
      motionQueuePauseRequested = true;
      status(motionText("pausingAudio", ""), { state: "pausing" });
      updateButtons();
      return true;
    }
    if (busy) {
      if (
        paused &&
        motionRunning &&
        (activeUploadFrameId || activeMotionStage === "download")
      ) {
        deferredUploadPause = true;
        motionQueuePauseRequested = true;
        status(
          motionText(
            "text137",
            "\u0110\xE3 t\u1EA1m d\u1EEBng l\u01B0\u1EE3t m\u1EDBi. Frame \u0111\xE3 g\u1EEDi Flow v\u1EABn ti\u1EBFp t\u1EE5c \u0111\u01B0\u1EE3c theo d\xF5i.",
          ),
        );
        updateButtons();
      }
      return;
    }
    let settlePauseTransition;
    motionPauseTransition = new Promise((resolve) => {
      settlePauseTransition = resolve;
    });
    const queue = window.PromptQueue?.getInstance?.();
    if (paused) {
      motionQueuePauseRequested = true;
      if (motionQueueJobId)
        queue?.pauseJob?.(motionQueueJobId, "manual", "motion");
    }
    let resumed = false;
    let pauseSaved = false;
    busy = true;
    updateButtons();
    $("pauseBtn").disabled = true;
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
          await refresh();
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          project = await api("PATCH", endpoint, {
            revision: project.revision,
            pause: paused,
          });
          pauseSaved = true;
          await refresh();
          $("pauseStatus").textContent = paused
            ? motionText(
                "text137",
                "\u0110\xE3 t\u1EA1m d\u1EEBng l\u01B0\u1EE3t m\u1EDBi. Frame \u0111\xE3 g\u1EEDi Flow v\u1EABn ti\u1EBFp t\u1EE5c \u0111\u01B0\u1EE3c theo d\xF5i.",
              )
            : motionText("text138", "\u0110\xE3 ti\u1EBFp t\u1EE5c project.");
          status(
            paused
              ? motionText(
                  "text135",
                  "\u0110\xE3 t\u1EA1m d\u1EEBng Motion project.",
                )
              : motionText(
                  "text136",
                  "\u0110\xE3 ti\u1EBFp t\u1EE5c Motion project.",
                ),
            { state: paused ? "paused" : "running" },
          );
          resumed = !paused;
        },
      );
    } catch (error) {
      $("pauseStatus").textContent = motionErrorMessage(error);
    } finally {
      busy = false;
      updateButtons();
      settlePauseTransition();
      motionPauseTransition = null;
    }
    if (paused && !pauseSaved && !providerPause) {
      motionQueuePauseRequested = false;
      if (motionQueueJobId) await queue?.resumeJob?.(motionQueueJobId);
    } else if (!paused && pauseSaved) {
      if (localMotionProviderPause) {
        localMotionProviderPause = null;
        if (motionRunning) {
          activeFlowStartedAt = Date.now();
          startActivity();
        }
      }
      motionQueuePauseRequested = false;
      if (motionQueueJobId) await queue?.resumeJob?.(motionQueueJobId);
      await refresh().catch((error) =>
        console.warn("[MotionProviderPause]", {
          stage: "resume_refresh",
          code: error?.code || error?.message,
        }),
      );
    }
    if (resumed && !motionRunning) {
      const task = pausedStandaloneTask;
      pausedStandaloneTask = null;
      if (task?.kind === "sub") void generateBatchTranscripts(task.remaining);
      else if (task?.kind === "upload")
        void uploadAllSourceFrames({
          manual: task.manual === true,
          frameIds: task.remaining || null,
          confirmedFlowMode: task.confirmedFlowMode || null,
        });
      else void runMotionFrames();
    }
    return pauseSaved;
  }
  async function cleanupInvalidatedFrameArtifacts(
    frameId,
    sourceRevision,
    oldInputRevision,
    oldFinal,
    { preserveGenerated = false } = {},
  ) {
    if (
      scopeInvalid ||
      Number(project?.data_json?.source_revision) !== sourceRevision ||
      !(
        Number(project.data_json?.frames?.[frameId]?.input_revision) >
        oldInputRevision
      )
    )
      return;
    const records = await MotionArtifactStore.listProject(userId, projectId);
    for (const record of records) {
      if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (
        record.sourceRevision !== sourceRevision ||
        record.kind !== "generated_clip" ||
        record.frameId !== frameId ||
        record.artifactRevision > oldInputRevision
      )
        continue;
      if (preserveGenerated) continue;
      await MotionArtifactStore.delete({
        userId,
        toolProjectId: projectId,
        sourceRevision,
        frameId,
        kind: "generated_clip",
        artifactRevision: record.artifactRevision,
      });
    }
    if (
      oldFinal &&
      !project.data_json?.final &&
      Number(oldFinal.source_revision) === sourceRevision
    ) {
      await MotionArtifactStore.delete({
        userId,
        toolProjectId: projectId,
        sourceRevision,
        kind: "merged_video",
        artifactRevision: Number(oldFinal.artifact_revision),
      });
    }
  }
  async function forceResetForManualRegen(frameId) {
    await refresh();
    if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
    const before = project.data_json?.frames?.[frameId];
    if (!before || before.stages?.split?.state !== "ready")
      throw new Error("MOTION_SPLIT_NOT_READY");
    const oldRunId = before.run_id,
      oldInputRevision = Number(before.input_revision);
    const reset = await editFrameResult(frameId, "reset", null, null, null, {
      preserveGenerated: true,
      propagate: true,
    });
    await refresh();
    const after = project.data_json?.frames?.[frameId];
    if (
      reset !== true ||
      after?.run_id === oldRunId ||
      Number(after?.input_revision) !== oldInputRevision + 1 ||
      ["submit", "monitor", "persist"].some((stage) => after?.stages?.[stage])
    )
      throw new Error("MOTION_REGEN_RESET_UNVERIFIED");
    console.info(
      "[MotionManualRegen]",
      JSON.stringify({
        frameId,
        stage: "reset_ready",
        inputRevision: after.input_revision,
      }),
    );
  }
  async function rerunFrame(frameId) {
    if (scopeInvalid || busy || motionRunning) return;
    openManualRunConfirmation?.(frameId);
  }
  async function saveSourcePoster(
    blob,
    sourceRevision,
    frameId,
    { persist = true } = {},
  ) {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    let timeout = null;
    try {
      const poster = await new Promise((resolve, reject) => {
        const timeoutMs = Number(
          window.SystemConfig?.safeGetTimeout?.("api_timeout_ms"),
        );
        if (Number.isFinite(timeoutMs) && timeoutMs > 0)
          timeout = setTimeout(
            () => reject(new Error("MOTION_POSTER_TIMEOUT")),
            timeoutMs,
          );
        video.onloadeddata = () => {
          const canvas = document.createElement("canvas");
          const scale = Math.min(
            1,
            240 / Math.max(video.videoWidth, video.videoHeight),
          );
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const context = canvas.getContext("2d");
          if (!context || !video.videoWidth || !video.videoHeight) {
            reject(new Error("MOTION_POSTER_FAILED"));
            return;
          }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(new Error("MOTION_POSTER_FAILED")),
            "image/jpeg",
            0.8,
          );
        };
        video.onerror = () => reject(new Error("MOTION_POSTER_FAILED"));
        video.src = url;
      });
      if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (Number(project?.data_json?.source_revision) !== sourceRevision)
        throw new Error("FRAME_SCOPE_CHANGED");
      if (persist)
        await MotionArtifactStore.put({
          userId,
          toolProjectId: projectId,
          flowProjectId: project.flow_project_id,
          sourceRevision,
          frameId,
          kind: "poster",
          blob: poster,
        });
      return poster;
    } finally {
      clearTimeout(timeout);
      video.onloadeddata = video.onerror = null;
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    }
  }
  async function uploadFrameClip(
    frameId,
    {
      propagate = false,
      manual = false,
      resumePaused = false,
      manualRetry = false,
      confirmedFlowMode = null,
      batchScope = null,
    } = {},
  ) {
    const inBatch =
      !!batchScope && batchScope === uploadAllSourceFrames.apiBatch;
    if (batchScope && !inBatch) throw new Error("FRAME_SCOPE_CHANGED");
    if (scopeInvalid || (busy && !inBatch)) return;
    if (manual) {
      try {
        if (!navigator.locks?.request)
          throw new Error("PROJECT_LOCK_UNAVAILABLE");
        return await navigator.locks.request(
          `motion-run:${userId}:${projectId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) throw new Error("PROJECT_ALREADY_RUNNING");
            cancelled = false;
            return uploadFrameClip(frameId, {
              propagate,
              resumePaused: true,
              manualRetry: true,
              confirmedFlowMode,
            });
          },
        );
      } catch (error) {
        status(motionErrorMessage(error || "MOTION_UPLOAD_FAILED"));
        if (propagate) throw error;
        return;
      }
    }
    let restoreManualPause = false;
    if (inBatch) batchScope.active.set(frameId, Date.now());
    const firstActive = inBatch
      ? batchScope.active.entries().next().value
      : [frameId, Date.now()];
    [activeUploadFrameId, activeUploadStartedAt] = firstActive;
    const refreshUpload = () =>
      refresh(
        inBatch
          ? {
              canApply: () =>
                !scopeInvalid && uploadAllSourceFrames.apiBatch === batchScope,
            }
          : {},
      );
    busy = true;
    startActivity();
    updateButtons();
    status(motionFormat("text204", "\u0110ang upload clip {0}...", [frameId]));
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      const performUpload = async () => {
        await refreshUpload();
        if (scopeInvalid || project.data_json?.requires_resplit)
          throw new Error("MOTION_UPLOAD_NOT_ALLOWED");
        if (resumePaused && project.data_json?.paused === true) {
          project = await api("PATCH", endpoint, {
            revision: project.revision,
            pause: false,
          });
          restoreManualPause = true;
        }
        if (project.data_json?.paused)
          throw new Error("MOTION_UPLOAD_NOT_ALLOWED");
        const runMode = confirmedFlowMode ?? project.data_json?.flow_run_mode;
        if (!["web", "api"].includes(runMode))
          throw new Error("MOTION_CONFIRM_RUN_REQUIRED");
        const frame = project.data_json?.frames?.[frameId];
        if (!frame || frame.stages?.split?.state !== "ready")
          throw new Error("MOTION_SPLIT_NOT_READY");
        const submit = frame.stages?.submit?.state;
        if (
          ["running", "needs_review"].includes(submit) ||
          (submit === "ready" &&
            !["ready", "failed"].includes(frame.stages?.monitor?.state))
        )
          throw new Error("FRAME_OPERATION_MUST_RECONCILE");
        const sourceRevision = Number(project.data_json.source_revision);
        if (
          inBatch &&
          (sourceRevision !== batchScope.sourceRevision ||
            project.flow_project_id !== batchScope.flowProjectId ||
            runMode !== "api" ||
            frame.run_id !== batchScope.frames.get(frameId)?.run_id ||
            frame.input_revision !==
              batchScope.frames.get(frameId)?.input_revision)
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        await MotionArtifactStore.hydrateUploadReceipt({
          userId,
          project,
          frameId,
        });
        const local = (await MotionArtifactStore.get({
          userId,
          toolProjectId: projectId,
          sourceRevision,
          frameId,
          kind: "source_clip",
        })) || { flowProjectId: project.flow_project_id };
        if (
          local.flowProjectId &&
          local.flowProjectId !== project.flow_project_id
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        const uploadAudit = (stage, extra = {}) =>
          console.info(
            "[MotionUploadAudit]",
            JSON.stringify({
              frameId,
              sourceRevision,
              frameRunId: frame.run_id,
              inputRevision: frame.input_revision,
              mode: runMode,
              confirmedMode: confirmedFlowMode,
              storedMode: project.data_json?.flow_run_mode || null,
              stage,
              ...extra,
            }),
          );
        const checkpoint = async (state, extra = {}) => {
          const body = {
            source_revision: sourceRevision,
            run_id: frame.run_id,
            input_revision: frame.input_revision,
            stage: "upload",
            state,
            ...extra,
          };
          try {
            return await api(
              "PATCH",
              `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
              body,
            );
          } catch (error) {
            const fresh = !scopeInvalid
              ? await api("GET", endpoint).catch(() => null)
              : null;
            const current = fresh?.data_json?.frames?.[frameId];
            if (
              !scopeInvalid &&
              fresh?.flow_project_id === project.flow_project_id &&
              Number(fresh.data_json?.source_revision) === sourceRevision &&
              current?.run_id === frame.run_id &&
              current?.input_revision === frame.input_revision &&
              current.stages?.upload?.state === state &&
              Object.entries(extra).every(
                ([key, value]) =>
                  key === "replace_existing" ||
                  (current.stages.upload[key] ?? null) === (value ?? null),
              )
            ) {
              uploadAudit("checkpoint_reconciled", { state });
              return fresh;
            }
            throw error;
          }
        };
        const previousUpload = frame.stages?.upload;
        const priorReceipt = local.uploadReceipt;
        const hasReceiptUuid =
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            String(priorReceipt?.mediaUuid || ""),
          ) &&
          priorReceipt.projectId === project.flow_project_id &&
          !!priorReceipt.mediaId &&
          ["web", "api"].includes(priorReceipt.mode);
        uploadAudit("receipt_check", {
          uploadState: previousUpload?.state || null,
          hasReceipt: !!local.uploadReceipt,
          hasBlob: !!local.blob,
          hasReceiptUuid,
          manualRetry,
        });
        let receipt = !manualRetry && hasReceiptUuid ? priorReceipt : null;
        if (!receipt) {
          if (!flowRuntimeReady) {
            if (!window.storageSettings?.init || !window.featureGate?.init) {
              throw new Error("MOTION_FLOW_RUNTIME_UNAVAILABLE");
            }
            await window.storageSettings.init();
            await window.featureGate.init();
            flowRuntimeReady = true;
          }
          const target = await getMotionFlowTarget();
          assertPinnedFlowTarget(target);
          const config = await window.ExecutionConfig.getConfig();
          const configured = config?.workflow?.max_retries;
          if (!Number.isInteger(configured) || configured < 0)
            throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
          const maxRetries =
            window.featureGate.canUse("retry_on_fail") === true
              ? configured
              : 0;
          let restored = false;
          if (!local.blob) {
            if (frame.source_edit)
              throw new Error("MOTION_SOURCE_NOT_AVAILABLE");
            if (
              maxRetries > 0 &&
              (!Number.isFinite(config.workflow.delay_nodes_sec) ||
                config.workflow.delay_nodes_sec < 0)
            )
              throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
            const original = await MotionArtifactStore.get({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              kind: "source_video",
            });
            if (
              !original?.blob ||
              original.flowProjectId !== project.flow_project_id
            )
              throw new Error("MOTION_SOURCE_NOT_AVAILABLE");
            uploadAudit("restore_source_clip");
            local.blob = await window.MotionFlowUpload.restoreSourceClip({
              blob: original.blob,
              start: Number(frame.start),
              end: Number(frame.end),
              maxSeconds: Number(profile?.settings?.max_split_clip_seconds),
              abortFn: () => scopeInvalid || cancelled,
              maxRetries,
              waitBeforeRetry: () =>
                new Promise((resolve) =>
                  setTimeout(resolve, config.workflow.delay_nodes_sec * 1e3),
                ),
              beforeRetry: async () => {
                if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                const fresh2 = await api("GET", endpoint),
                  current2 = fresh2?.data_json?.frames?.[frameId];
                if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                if (cancelled || fresh2?.data_json?.paused)
                  throw new Error("MOTION_CANCELLED");
                if (
                  fresh2?.flow_project_id !== target.projectId ||
                  Number(fresh2.data_json?.source_revision) !==
                    sourceRevision ||
                  current2?.run_id !== frame.run_id ||
                  current2?.input_revision !== frame.input_revision
                )
                  throw new Error("FRAME_SCOPE_CHANGED");
              },
              onRetry: (retryCount, maxRetries2, error) =>
                uploadAudit("restore_source_clip_retry", {
                  retryCount,
                  maxRetries: maxRetries2,
                  code: error.code || error.message,
                }),
            });
            restored = true;
            const fresh = await api("GET", endpoint);
            const current = fresh?.data_json?.frames?.[frameId];
            if (
              scopeInvalid ||
              fresh?.flow_project_id !== project.flow_project_id ||
              Number(fresh?.data_json?.source_revision) !== sourceRevision ||
              current?.run_id !== frame.run_id ||
              current?.input_revision !== frame.input_revision
            )
              throw new Error("FRAME_SCOPE_CHANGED");
          }
          const replacingReady = previousUpload?.state === "ready";
          await checkpoint(
            "running",
            replacingReady
              ? {
                  replace_existing: true,
                  provider_media_id: previousUpload.provider_media_id,
                }
              : {},
          );
          if (priorReceipt) {
            await MotionArtifactStore.clearUploadReceipt({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              projectId: project.flow_project_id,
              expectedMediaId: priorReceipt.mediaId,
              blob: local.blob,
            });
            delete local.uploadReceipt;
            uploadAudit("cached_receipt_replaced", {
              hadReceipt: true,
              replacingReady,
            });
          } else if (restored) {
            await MotionArtifactStore.put({
              userId,
              toolProjectId: projectId,
              flowProjectId: project.flow_project_id,
              sourceRevision,
              frameId,
              kind: "source_clip",
              blob: local.blob,
              duration: Number(frame.end) - Number(frame.start),
            });
          }
          sourceUploadReceipts.delete(frameId);
          let dispatched = false;
          try {
            receipt = await window.MotionFlowUpload.retryPreDispatch(
              async () => {
                dispatched = false;
                try {
                  return await window.MotionFlowUpload.upload({
                    blob: local.blob,
                    name: `motion_${frameId}.mp4`,
                    target,
                    mode: runMode,
                    parallelApi: inBatch,
                    stopScope: {
                      userId,
                      toolProjectId: projectId,
                      runId: frame.run_id,
                    },
                    abortFn: () => !dispatched && (scopeInvalid || cancelled),
                    onDispatch: async () => {
                      if (
                        scopeInvalid ||
                        cancelled ||
                        (inBatch && (deferredUploadPause || batchScope.halted))
                      )
                        throw Object.assign(new Error("MOTION_CANCELLED"), {
                          notDispatched: true,
                          noRetry: true,
                          noReplay: true,
                        });
                      if (inBatch) {
                        const fresh = await api("GET", endpoint),
                          current = fresh?.data_json?.frames?.[frameId];
                        if (
                          scopeInvalid ||
                          cancelled ||
                          deferredUploadPause ||
                          batchScope.halted ||
                          fresh?.data_json?.paused
                        )
                          throw Object.assign(new Error("MOTION_CANCELLED"), {
                            notDispatched: true,
                            noRetry: true,
                            noReplay: true,
                          });
                        if (
                          fresh.flow_project_id !== target.projectId ||
                          Number(fresh.data_json?.source_revision) !==
                            sourceRevision ||
                          current?.run_id !== frame.run_id ||
                          current?.input_revision !== frame.input_revision
                        )
                          throw Object.assign(
                            new Error("FRAME_SCOPE_CHANGED"),
                            {
                              notDispatched: true,
                              noRetry: true,
                              noReplay: true,
                            },
                          );
                      }
                      dispatched = true;
                      uploadAudit("transport_started");
                    },
                  });
                } catch (error) {
                  if (!dispatched && error && typeof error === "object")
                    error.notDispatched = true;
                  throw error;
                }
              },
              {
                maxRetries,
                retryTransientUpload: true,
                beforeRetry: async () => {
                  const fresh = await api("GET", endpoint);
                  const current = fresh?.data_json?.frames?.[frameId];
                  if (scopeInvalid || cancelled || fresh?.data_json?.paused)
                    throw new Error("MOTION_CANCELLED");
                  if (
                    Number(fresh?.data_json?.source_revision) !==
                      sourceRevision ||
                    current?.run_id !== frame.run_id ||
                    current?.input_revision !== frame.input_revision ||
                    fresh?.flow_project_id !== target.projectId ||
                    (!confirmedFlowMode &&
                      fresh?.data_json?.flow_run_mode !== runMode)
                  ) {
                    throw new Error("FRAME_SCOPE_CHANGED");
                  }
                },
                onRetry: (attempt, limit, error) =>
                  console.info(
                    "[MotionUploadRetry]",
                    JSON.stringify({
                      frameId,
                      stage: "pre_dispatch",
                      attempt,
                      maxRetries: limit,
                      reason: error.code || error.message,
                    }),
                  ),
                delay: () =>
                  new Promise((resolve) => setTimeout(resolve, 1200)),
              },
            );
            uploadAudit("receipt_received", {
              receiptMode: receipt.mode,
              hasUuid: !!receipt.mediaUuid,
              hasAsb: !!receipt.persistentMediaId,
            });
            await MotionArtifactStore.setUploadReceipt({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              receipt,
            });
            uploadAudit("receipt_stored");
          } catch (error) {
            const notDispatched = !dispatched || error?.notDispatched === true;
            const rawCode = String(
              error?.code || error?.message || "MOTION_UPLOAD_FAILED",
            );
            uploadAudit("upload_failed", {
              notDispatched,
              code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawCode)
                ? rawCode
                : "MOTION_UPLOAD_FAILED",
            });
            if (!scopeInvalid) {
              try {
                await checkpoint(
                  notDispatched ? "failed" : "needs_review",
                  notDispatched
                    ? {
                        error_code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(
                          rawCode,
                        )
                          ? rawCode
                          : "MOTION_UPLOAD_PRE_DISPATCH_FAILED",
                        retry_exhausted: false,
                      }
                    : {},
                );
              } catch (_) {
                uploadAudit("failure_checkpoint_unverified");
              }
            }
            throw error;
          }
        }
        if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
        await checkpoint("ready", {
          ...MotionArtifactStore.uploadMetadata(receipt),
          provider_media_id: receipt.mediaId,
          flow_mode: receipt.mode,
          api_driver: receipt.apiDriver || null,
          protocol_revision: receipt.protocolRevision || null,
          protocol_fingerprint: receipt.protocolFingerprint || null,
        });
        uploadAudit("ready");
        if (
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            String(receipt.mediaUuid || ""),
          )
        ) {
          try {
            await saveSourcePoster(local.blob, sourceRevision, frameId);
            if (
              !(await resolveUploadedSource({
                ...local,
                uploadReceipt: receipt,
              }))
            )
              throw new Error("MOTION_SOURCE_FLOW_PREVIEW_UNAVAILABLE");
            await MotionArtifactStore.clearUploadedSourceBlob({
              userId,
              toolProjectId: projectId,
              sourceRevision,
              frameId,
              mediaId: receipt.mediaId,
              projectId: project.flow_project_id,
            });
          } catch (error) {
            console.warn("[Motion] Uploaded source cleanup failed", {
              frameId,
              mode: receipt.mode,
              sourceRevision,
              code: error?.code || error?.message,
            });
          }
        } else {
          console.info("[Motion] Uploaded source cleanup skipped", {
            frameId,
            mode: receipt.mode,
            sourceRevision,
            reason: "missing_media_uuid",
          });
        }
        await refreshUpload();
        if (!inBatch)
          status(
            motionFormat(
              "text205",
              "{0}: \u0111\xE3 upload clip qua Flow {1}.",
              [frameId, receipt.mode.toUpperCase()],
            ),
          );
      };
      if (inBatch) await performUpload();
      else
        await navigator.locks.request(
          `motion:${userId}:${projectId}`,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
            return performUpload();
          },
        );
    } catch (error) {
      status(motionErrorMessage(error, { videoUpload: true }), {
        state: "failed",
      });
      if (propagate) throw error;
      void showVideoUploadFailure(error, frameId);
    } finally {
      if (inBatch) {
        batchScope.active.delete(frameId);
        [activeUploadFrameId, activeUploadStartedAt] = batchScope.active
          .entries()
          .next().value || [null, 0];
      } else {
        activeUploadFrameId = null;
        activeUploadStartedAt = 0;
        busy = false;
      }
      settleActivity();
      updateButtons();
      if (restoreManualPause && !scopeInvalid) await setPaused(true);
      if (!inBatch && deferredUploadPause && !scopeInvalid) {
        deferredUploadPause = false;
        if (!(await setPaused(true)))
          throw new Error("MOTION_PAUSE_SAVE_FAILED");
      }
      if (!scopeInvalid)
        await refreshUpload().catch((error) =>
          console.warn("[Motion] Upload refresh failed", error?.message),
        );
    }
  }
  async function uploadApiSourceFrames({ ids, manual, sourceRevision }) {
    return navigator.locks.request(
      `motion:${userId}:${projectId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
        const batch = {
          sourceRevision,
          flowProjectId: project.flow_project_id,
          active: new Map(),
          halted: false,
          frames: new Map(
            ids.map((id) => [
              id,
              {
                run_id: project.data_json.frames[id]?.run_id,
                input_revision: project.data_json.frames[id]?.input_revision,
              },
            ]),
          ),
        };
        uploadAllSourceFrames.apiBatch = batch;
        window.MotionFlowUpload.activeSourceUploads = batch.active;
        busy = true;
        updateButtons();
        let count = 0,
          processed = 0;
        const failures = [];
        const current = () =>
          !scopeInvalid && uploadAllSourceFrames.apiBatch === batch;
        const stopped = () =>
          !current() ||
          cancelled ||
          deferredUploadPause ||
          batch.halted ||
          project.data_json?.paused === true;
        try {
          const result = await window.MotionFlowUpload.runBatch({
            items: ids,
            getLimit: () => window.MotionFlowUpload.getUploadConcurrency(),
            shouldStop: stopped,
            run: async (frameId) => {
              try {
                await refresh({ canApply: current });
                if (stopped()) return;
                if (
                  Number(project.data_json?.source_revision) !==
                    sourceRevision ||
                  project.flow_project_id !== batch.flowProjectId
                )
                  throw new Error("FRAME_SCOPE_CHANGED");
                if (isSourceUploadReady(frameId)) return;
                status(
                  motionFormat(
                    "text206",
                    "\u0110ang upload {0} l\xEAn Flow...",
                    [frameId],
                  ),
                );
                await uploadFrameClip(frameId, {
                  propagate: true,
                  manualRetry: manual,
                  confirmedFlowMode: "api",
                  batchScope: batch,
                });
                await refresh({ canApply: current });
                if (!isSourceUploadReady(frameId))
                  throw new Error("MOTION_UPLOAD_NOT_READY");
                count++;
              } catch (error) {
                const raw = String(
                  error?.code || error?.message || "MOTION_UPLOAD_FAILED",
                );
                const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                  ? raw
                  : "MOTION_UPLOAD_FAILED";
                failures.push({ frameId, code });
                if (
                  [
                    "FRAME_SCOPE_CHANGED",
                    "FLOW_EXECUTION_TARGET_CHANGED",
                    "ACCOUNT_SCOPE_CHANGED",
                    "MOTION_CANCELLED",
                    "MOTION_UPLOAD_RECEIPT_RECONCILE_REQUIRED",
                  ].includes(code) ||
                  project.data_json.frames?.[frameId]?.stages?.upload?.state ===
                    "needs_review"
                )
                  batch.halted = true;
                console.warn(
                  "[MotionFrameFailure]",
                  JSON.stringify({
                    stage: "upload",
                    frameId,
                    code,
                    action: batch.halted ? "stop_admission" : "skip_frame",
                  }),
                );
                status(
                  `${frameId}: ${motionErrorMessage(code, { videoUpload: true })}`,
                  { state: "failed" },
                );
              } finally {
                processed++;
                $("progress").value = (processed / ids.length) * 100;
              }
            },
          });
          if (result.stopped && !batch.halted && current())
            pausedStandaloneTask = {
              kind: "upload",
              manual,
              remaining: ids.filter((id) => !isSourceUploadReady(id)),
              confirmedFlowMode: "api",
            };
          if (!result.stopped) {
            const message = motionFormat(
              "text207",
              "\u0110\xE3 upload {0} frame l\xEAn Flow.",
              [count],
            );
            status(message, { state: failures.length ? "failed" : "ready" });
            motionToast(message, { error: failures.length > 0 });
          }
          if (failures.length)
            void showVideoUploadFailure(failures[0].code, failures[0].frameId);
        } finally {
          uploadAllSourceFrames.apiBatch = null;
          if (window.MotionFlowUpload.activeSourceUploads === batch.active)
            window.MotionFlowUpload.activeSourceUploads = null;
          activeUploadFrameId = null;
          activeUploadStartedAt = 0;
          busy = false;
          if (deferredUploadPause && !scopeInvalid) {
            deferredUploadPause = false;
            if (!(await setPaused(true)))
              throw new Error("MOTION_PAUSE_SAVE_FAILED");
          }
          settleActivity();
          updateButtons();
        }
      },
    );
  }
  async function uploadAllSourceFrames({
    manual = false,
    confirmedFlowMode = null,
    frameIds = null,
  } = {}) {
    if (scopeInvalid || busy || motionRunning) return;
    let restoreManualPause = false;
    motionRunning = true;
    cancelled = false;
    $("progress").value = 0;
    startActivity();
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_RUNNING");
          await refresh();
          if (project.data_json?.requires_resplit)
            throw new Error("MOTION_SOURCE_REQUIRES_RESPLIT");
          if (manual && project.data_json?.paused === true) {
            project = await api("PATCH", endpoint, {
              revision: project.revision,
              pause: false,
            });
            restoreManualPause = true;
          }
          const mode = confirmedFlowMode ?? project.data_json?.flow_run_mode;
          if (!["web", "api"].includes(mode))
            throw new Error("MOTION_CONFIRM_RUN_REQUIRED");
          const sourceRevision = Number(project.data_json?.source_revision);
          const ids = Object.entries(project.data_json?.frames || {})
            .sort((a, b) => Number(a[1].start) - Number(b[1].start))
            .map(([id]) => id)
            .filter(
              (id) =>
                (!frameIds || frameIds.includes(id)) &&
                (!manual || canUploadFrameSource(id)),
            );
          if (
            mode === "api" &&
            project.data_json?.preferences?.continuity_enabled !== true
          )
            return uploadApiSourceFrames({ ids, manual, sourceRevision });
          let count = 0,
            processed = 0;
          const failures = [];
          for (const frameId of ids) {
            if (scopeInvalid || cancelled) throw new Error("MOTION_CANCELLED");
            await refresh();
            if (
              Number(project.data_json?.source_revision) !== sourceRevision ||
              (!confirmedFlowMode && project.data_json?.flow_run_mode !== mode)
            ) {
              throw new Error("FRAME_SCOPE_CHANGED");
            }
            if (project.data_json?.paused) {
              pausedStandaloneTask = {
                kind: "upload",
                manual,
                remaining: ids.slice(processed),
                confirmedFlowMode: mode,
              };
              break;
            }
            try {
              const frame = project.data_json?.frames?.[frameId];
              if (!frame || frame.stages?.split?.state !== "ready")
                throw new Error("MOTION_SPLIT_NOT_READY");
              if (
                manual
                  ? !canUploadFrameSource(frameId)
                  : isSourceUploadReady(frameId)
              )
                continue;
              status(
                motionFormat("text206", "\u0110ang upload {0} l\xEAn Flow...", [
                  frameId,
                ]),
              );
              await uploadFrameClip(frameId, {
                propagate: true,
                manualRetry: manual,
                confirmedFlowMode: mode,
              });
              await refresh();
              if (!isSourceUploadReady(frameId))
                throw new Error("MOTION_UPLOAD_NOT_READY");
              count++;
            } catch (error) {
              const raw = String(
                error?.code || error?.message || "MOTION_UPLOAD_FAILED",
              );
              const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                ? raw
                : "MOTION_UPLOAD_FAILED";
              failures.push({ frameId, code });
              console.warn(
                "[MotionFrameFailure]",
                JSON.stringify({
                  stage: "upload",
                  frameId,
                  code,
                  action: "skip_frame",
                }),
              );
              status(
                `${frameId}: ${motionErrorMessage(code, { videoUpload: true })}`,
                { state: "failed" },
              );
            } finally {
              processed++;
              $("progress").value = (processed / ids.length) * 100;
            }
          }
          if (!project.data_json?.paused) {
            const message = motionFormat(
              "text207",
              "\u0110\xE3 upload {0} frame l\xEAn Flow.",
              [count],
            );
            status(message, { state: failures.length ? "failed" : "ready" });
            motionToast(message, { error: failures.length > 0 });
          } else if (!pausedStandaloneTask)
            pausedStandaloneTask = {
              kind: "upload",
              manual,
              remaining: ids.slice(processed),
              confirmedFlowMode: mode,
            };
          if (failures.length)
            void showVideoUploadFailure(failures[0].code, failures[0].frameId);
        },
      );
    } catch (error) {
      const code = String(
        error?.code || error?.message || "MOTION_UPLOAD_FAILED",
      );
      status(code);
      motionToast(motionErrorMessage(code, { videoUpload: true }), {
        error: true,
      });
      void showVideoUploadFailure(error);
    } finally {
      motionRunning = false;
      settleActivity();
      updateButtons();
      if (restoreManualPause && !scopeInvalid) await setPaused(true);
      if (!scopeInvalid)
        await refresh().catch((error) =>
          console.warn("[Motion] Upload batch refresh failed", error?.message),
        );
    }
  }
  async function sendMotionTranscriptWithRetry(
    payload,
    frameId,
    operationId,
    sourceRevision,
    frame,
    validate,
  ) {
    const pending =
      sendMotionTranscriptWithRetry.cancellations ||
      (sendMotionTranscriptWithRetry.cancellations = new Map());
    let stopped = false,
      dispatched = false,
      resolveCancelled;
    const cancellation = new Promise((resolve) => {
      resolveCancelled = resolve;
    });
    const control = {
      cancel() {
        if (stopped) return;
        stopped = true;
        resolveCancelled({ success: false, error: "MOTION_CANCELLED" });
        console.info(
          "[MotionTranscriptCancel]",
          JSON.stringify({
            operationId,
            frameId,
            stage: "requested",
            dispatched,
          }),
        );
        if (dispatched)
          void chrome.runtime
            .sendMessage({ action: "motion:cancelTranscript", operationId })
            .then((result) =>
              console.info(
                "[MotionTranscriptCancel]",
                JSON.stringify({
                  operationId,
                  frameId,
                  stage: "acknowledged",
                  success: result?.success === true,
                  abortReceived: result?.abortReceived === true,
                  providerStopped: result?.providerStopped === true,
                }),
              ),
            )
            .catch((error) =>
              console.warn("[MotionTranscriptCancel]", {
                operationId,
                frameId,
                code: error?.code || "CANCEL_DELIVERY_FAILED",
              }),
            );
      },
    };
    pending.set(operationId, control);
    try {
      await Promise.race([window.featureGate.init(), cancellation]);
      if (stopped || scopeInvalid || cancelled)
        return { success: false, error: "MOTION_CANCELLED" };
      const config = await Promise.race([
        window.ExecutionConfig.getConfig(),
        cancellation,
      ]);
      if (stopped || scopeInvalid || cancelled)
        return { success: false, error: "MOTION_CANCELLED" };
      const configured = config?.workflow?.max_retries;
      if (!Number.isInteger(configured) || configured < 0)
        throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
      const maxRetries =
        window.featureGate.canUse("retry_on_fail") === true ? configured : 0;
      let result;
      if (stopped || scopeInvalid || cancelled)
        return { success: false, error: "MOTION_CANCELLED" };
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          await refresh();
          if (
            stopped ||
            scopeInvalid ||
            cancelled ||
            project?.data_json?.paused
          )
            throw new Error("MOTION_CANCELLED");
          const current = project?.data_json?.frames?.[frameId];
          if (
            Number(project?.data_json?.source_revision) !== sourceRevision ||
            current?.run_id !== frame.run_id ||
            current?.input_revision !== frame.input_revision
          )
            throw new Error("FRAME_SCOPE_CHANGED");
          console.info(
            "[MotionTranscriptRetry]",
            JSON.stringify({
              operationId,
              frameId,
              stage: "retry",
              attempt,
              maxRetries,
              reason: result?.error || "NO_RESPONSE",
            }),
          );
          await Promise.race([
            new Promise((resolve) => setTimeout(resolve, 1200)),
            cancellation,
          ]);
          if (
            stopped ||
            scopeInvalid ||
            cancelled ||
            project?.data_json?.paused
          )
            throw new Error("MOTION_CANCELLED");
        }
        try {
          const waitForEditorMs = await Promise.race([
            window.ExecutionConfig.getProviderStartupTimeoutMs(
              payload.provider,
            ),
            cancellation,
          ]);
          if (
            stopped ||
            scopeInvalid ||
            cancelled ||
            project?.data_json?.paused
          )
            throw new Error("MOTION_CANCELLED");
          console.info(
            "[MotionTranscriptRetry]",
            JSON.stringify({
              operationId,
              frameId,
              stage: "attempt",
              attempt,
              maxRetries,
              provider: payload.provider,
              waitForEditorMs,
            }),
          );
          dispatched = true;
          result = await Promise.race([
            chrome.runtime.sendMessage({ ...payload, waitForEditorMs }),
            cancellation,
          ]);
          if (stopped || cancelled || scopeInvalid)
            return { success: false, error: "MOTION_CANCELLED" };
          if (!result?.success && result?.error === "PROVIDER_NOT_READY")
            console.warn(
              "[MotionTranscriptReadiness]",
              JSON.stringify({
                operationId,
                frameId,
                provider: payload.provider,
                attempt,
                reason: result.reason || null,
                ...(result.diagnostics && {
                  readyState: result.diagnostics.readyState,
                  composerPresent: result.diagnostics.composerPresent,
                  composerDisabled: result.diagnostics.composerDisabled,
                  composerBusy: result.diagnostics.composerBusy,
                  composerSelectorCount:
                    result.diagnostics.composerSelectorCount,
                }),
              }),
            );
          if (result?.success && validate) validate(result);
        } catch (error) {
          const reason = /^[A-Z_]{1,80}$/.test(
            String(error?.validationReason || ""),
          )
            ? error.validationReason
            : null;
          if (result?.success === true) {
            const text = typeof result.text === "string" ? result.text : "";
            console.info(
              "[MotionTranscriptValidation]",
              JSON.stringify({
                operationId,
                frameId,
                provider: payload.provider,
                attempt,
                stage: "response_rejected",
                code:
                  error?.code ||
                  error?.message ||
                  "MOTION_TRANSCRIPTION_FAILED",
                reason,
                textLength: text.length,
                beginMarkers: text.split("TOBY_MOTION_JSON_BEGIN").length - 1,
                endMarkers: text.split("TOBY_MOTION_JSON_END").length - 1,
              }),
            );
          }
          result = {
            success: false,
            error:
              error?.code || error?.message || "MOTION_TRANSCRIPTION_FAILED",
            reason,
          };
        }
        if (
          result?.success ||
          ["ABORTED", "MOTION_CANCELLED", "ACCOUNT_SCOPE_CHANGED"].includes(
            result?.error,
          )
        )
          break;
      }
      return result;
    } finally {
      if (pending.get(operationId) === control) pending.delete(operationId);
    }
  }
  async function transcribeMotionFrame(
    frameId,
    frame,
    runProfile,
    preferences,
    { preserveOriginal = false, guardBatchState = false } = {},
  ) {
    const operationId = crypto.randomUUID();
    const sourceRevision = Number(project.data_json.source_revision);
    const startedAt = Date.now();
    let failedStage = "prepare_audio";
    let cleanupEnabled = false;
    const attemptProject = {
      tool_project_id: project.tool_project_id,
      flow_project_id: project.flow_project_id,
      revision: project.revision,
      data_json: {
        preferences: structuredClone(project.data_json.preferences || {}),
      },
    };
    const attemptFrame = {
      run_id: frame.run_id,
      input_revision: frame.input_revision,
      transcript: structuredClone(frame.transcript || null),
      stages: { transcribe: structuredClone(frame.stages?.transcribe || null) },
    };
    try {
      if (
        frame.stages?.split?.audio_state === "audio_present" &&
        window.MotionAudioRegenerator?.ensureFrameAudio
      ) {
        const audio = await MotionArtifactStore.get({
          userId,
          toolProjectId: projectId,
          sourceRevision,
          frameId,
          kind: "source_audio",
        });
        if (!audio?.blob) {
          const policy = await window.ExecutionConfig.getConfig();
          project = await MotionAudioRegenerator.ensureFrameAudio({
            project,
            userId,
            frameId,
            api,
            maxRetries:
              window.featureGate.canUse("retry_on_fail") === true
                ? policy?.workflow?.max_retries
                : 0,
            shouldStop: () => scopeInvalid || cancelled,
            resolveFrameSource: resolveAudioFrameSource,
            assertScope: async () => {
              if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
            },
          });
          frame = project.data_json.frames[frameId];
        }
      }
      const audioState = frame.stages?.split?.audio_state;
      let transcript = {
        hasSpeech: false,
        transcript: "",
        detectedLanguage: "",
        translatedText: null,
      };
      let cleanupReceipt = null;
      if (audioState === "audio_present") {
        if (!window.MotionTranscriptContract)
          throw new Error("MOTION_TRANSCRIPT_CONTRACT_UNAVAILABLE");
        const audio = await MotionArtifactStore.get({
          userId,
          toolProjectId: projectId,
          sourceRevision,
          frameId,
          kind: "source_audio",
        });
        if (!audio?.blob || scopeInvalid)
          throw new Error("MOTION_AUDIO_NOT_AVAILABLE");
        const uploadAudio = await window.MotionTranscriptContract.prepareAudio(
          audio.blob,
          { shouldStop: () => cancelled || scopeInvalid },
        );
        console.info(
          "[MotionTranscriptUpload]",
          JSON.stringify({
            operationId,
            frameId,
            fullSound: false,
            inputBytes: audio.blob.size,
            uploadBytes: uploadAudio.size,
          }),
        );
        const manifest = window.MotionTranscriptContract.buildBatches(
          [{ frameId, blob: uploadAudio, duration: frame.end - frame.start }],
          { maxFiles: 1, maxBytes: uploadAudio.size },
        )[0];
        const entry = manifest[0];
        const translate = preferences.translate_enabled === true;
        const prompt = window.MotionTranscriptContract.composePrompt(
          window.MotionPromptComposer.render(
            runProfile.prompts?.[
              translate ? "transcribe_translate" : "transcribe"
            ],
            {
              audio_manifest: JSON.stringify([
                {
                  frame_id: frameId,
                  order: entry.order,
                  file_name: entry.name,
                  duration_seconds: entry.duration,
                },
              ]),
              target_language: preferences.target_language || "",
            },
          ),
          { translate },
        );
        const provider =
          preferences.transcription_provider ||
          runProfile.settings.transcription_provider;
        if (!["chatgpt", "gemini"].includes(provider))
          throw new Error("MOTION_AGENT_NOT_SELECTED");
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onerror = () =>
            reject(reader.error || new Error("MOTION_AUDIO_READ_FAILED"));
          reader.onload = () => resolve(String(reader.result).split(",")[1]);
          reader.readAsDataURL(uploadAudio);
        });
        if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
        if (cancelled) throw new Error("MOTION_CANCELLED");
        const configuredModel =
          provider === runProfile.settings.transcription_provider
            ? runProfile.settings.transcription_model
            : null;
        const catalogModel =
          configuredModel &&
          window.ModelRegistry?.findModel(provider, configuredModel);
        const model =
          provider === "chatgpt"
            ? catalogModel?.value || null
            : catalogModel || null;
        const deleteAfter = true;
        cleanupEnabled = deleteAfter;
        status(
          motionFormat(
            "text208",
            "{0}: \u0111ang \u0111\u1ED3ng b\u1ED9 l\u1EDDi tho\u1EA1i {1}...",
            [frameId, provider],
          ),
        );
        console.info(
          "[MotionTranscript]",
          JSON.stringify({
            operationId,
            frameId,
            stage: "submit",
            provider,
            sourceRevision,
            audioBytes: entry.size,
            translate,
            deleteAfter,
            hadTranscript: !!frame.transcript,
            profileRevision: Number.isSafeInteger(runProfile.revision)
              ? runProfile.revision
              : null,
            promptVariant: runProfile.prompt_variant || null,
            verbatimNumberWords: prompt.includes("MOTION_VERBATIM_NUMBERS_V1"),
            boundaryAlignment: prompt.includes(
              "MOTION_FULL_AUDIO_BOUNDARY_ALIGNMENT_V1",
            ),
            phraseTimeline: prompt.includes("MOTION_SPEECH_TIMELINE_V1"),
          }),
        );
        const validateResponse = (response2) =>
          window.MotionTranscriptContract.validateSingleResponse(
            response2,
            manifest,
            {
              frameId,
              translate,
              preserveOriginalSpeech:
                preserveOriginal && frame.transcript?.has_speech === true,
              requireTimeline: prompt.includes("MOTION_SPEECH_TIMELINE_V1"),
            },
          );
        failedStage = "provider";
        const response = await sendMotionTranscriptWithRetry(
          {
            action: "motion:transcribe",
            provider,
            text: prompt,
            operationId,
            model,
            deleteAfter,
            audioManifest: [
              {
                frame_id: frameId,
                order: entry.order,
                file_name: entry.name,
                duration_seconds: entry.duration,
              },
            ],
            audio: { base64, name: entry.name, type: entry.mime },
          },
          frameId,
          operationId,
          sourceRevision,
          frame,
          validateResponse,
        );
        if (!response?.success) {
          console.warn(
            "[MotionTranscript]",
            JSON.stringify({
              operationId,
              frameId,
              stage: "provider_failed",
              code: response?.error || "MOTION_TRANSCRIPTION_FAILED",
              reason: response?.reason || null,
            }),
          );
          throw new Error(response?.error || "MOTION_TRANSCRIPTION_FAILED");
        }
        failedStage = "parse";
        transcript = validateResponse(response);
        if (
          !translate &&
          transcript.hasSpeech &&
          frame.transcript?.translated_text
        ) {
          transcript.translatedText = frame.transcript.translated_text;
          transcript.speechTimeline = null;
        }
        console.info(
          "[MotionTranscript]",
          JSON.stringify({
            operationId,
            frameId,
            stage: "parsed",
            preserveOriginal,
            hasSpeech: transcript.hasSpeech,
            textLength: transcript.transcript.length,
            translationLength: transcript.translatedText?.length || 0,
            timelineSegments: transcript.speechTimeline?.length ?? null,
            timelineEndSeconds:
              transcript.speechTimeline?.at(-1)?.end_seconds ?? null,
            durationSeconds: Number(frame.end) - Number(frame.start),
          }),
        );
        if (translate && preserveOriginal && frame.transcript) {
          if (
            frame.transcript.has_speech === true &&
            (!transcript.hasSpeech || !transcript.translatedText?.trim())
          ) {
            throw new Error("MOTION_TRANSLATION_INVALID");
          }
          transcript = {
            ...transcript,
            hasSpeech: frame.transcript.has_speech === true,
            transcript: frame.transcript.text || "",
            detectedLanguage: frame.transcript.detected_language || "",
            translatedText:
              frame.transcript.has_speech === true
                ? transcript.translatedText
                : null,
            speechTimeline:
              transcript.transcript.trim() ===
              (frame.transcript.text || "").trim()
                ? transcript.speechTimeline
                : null,
          };
        }
        cleanupReceipt = response.cleanupReceipt || null;
      } else if (
        !["audio_track_absent", "silent_verified"].includes(audioState)
      ) {
        throw new Error(
          audioState === "audio_decode_unsupported"
            ? "AUDIO_DECODE_UNSUPPORTED"
            : "MOTION_AUDIO_STATE_INVALID",
        );
      }
      failedStage = "refresh_before_save";
      console.info(
        "[MotionTranscript]",
        JSON.stringify({
          operationId,
          frameId,
          stage: failedStage,
          elapsedMs: Date.now() - startedAt,
        }),
      );
      await refresh();
      failedStage = "scope_check";
      if (
        scopeInvalid ||
        Number(project.data_json.source_revision) !== sourceRevision ||
        project.data_json.frames?.[frameId]?.run_id !== frame.run_id ||
        project.data_json.frames?.[frameId]?.input_revision !==
          frame.input_revision ||
        (guardBatchState &&
          (JSON.stringify(
            project.data_json.frames?.[frameId]?.transcript || null,
          ) !== JSON.stringify(frame.transcript || null) ||
            [
              "transcription_provider",
              "translate_enabled",
              "target_language",
            ].some(
              (key) =>
                (project.data_json.preferences?.[key] ?? null) !==
                (preferences[key] ?? null),
            )))
      ) {
        throw new Error("FRAME_SCOPE_CHANGED");
      }
      if (cancelled) throw new Error("MOTION_CANCELLED");
      const transcriptPath = `${endpoint}/frames/${encodeURIComponent(frameId)}/transcript`;
      failedStage = "save";
      project = await window.MotionTranscriptCommit.save({
        project,
        sourceRevision,
        frameId,
        frame,
        transcript,
        write: (revision) => {
          console.info(
            "[MotionTranscript]",
            JSON.stringify({
              operationId,
              frameId,
              stage: "save_requested",
              revision,
              sourceRevision,
              inputRevision: frame.input_revision,
              elapsedMs: Date.now() - startedAt,
              profileRevision: Number.isSafeInteger(runProfile.revision)
                ? runProfile.revision
                : null,
              durationSeconds: Number(frame.end) - Number(frame.start),
              timelineSegments: transcript.speechTimeline?.length ?? null,
              timelineEndSeconds:
                transcript.speechTimeline?.at(-1)?.end_seconds ?? null,
            }),
          );
          return api("PATCH", transcriptPath, {
            revision,
            source_revision: sourceRevision,
            run_id: frame.run_id,
            input_revision: frame.input_revision,
            has_speech: transcript.hasSpeech,
            transcript: transcript.transcript,
            translated_text: transcript.translatedText,
            speech_timeline: transcript.speechTimeline || null,
            detected_language: transcript.detectedLanguage || null,
          });
        },
        read: () => api("GET", endpoint),
        invalidScope: () => scopeInvalid,
        cancelled: () => cancelled,
        freshScope: (fresh) =>
          !guardBatchState ||
          ![
            "transcription_provider",
            "translate_enabled",
            "target_language",
          ].some(
            (key) =>
              (fresh.data_json?.preferences?.[key] ?? null) !==
              (preferences[key] ?? null),
          ),
        retryable: (error) => window.FlowApiDownloadRetry?.retryable(error),
        retryEnabled: () =>
          window.featureGate?.canUse("retry_on_fail") === true,
        getRetryLimit: async () =>
          (await window.ExecutionConfig.getConfig())?.workflow?.max_retries,
        onProject: (fresh) => {
          project = fresh;
        },
        onRetry: ({ attempt, maxRetries, error }) => {
          console.info(
            "[MotionTranscriptRetry]",
            JSON.stringify({
              operationId,
              frameId,
              stage: "save",
              attempt,
              maxRetries,
              reason: error.code || error.message,
            }),
          );
        },
      });
      failedStage = "verify_save";
      const savedTranscript = project?.data_json?.frames?.[frameId]?.transcript;
      console.info(
        "[MotionTranscript]",
        JSON.stringify({
          operationId,
          frameId,
          stage: "save_response",
          elapsedMs: Date.now() - startedAt,
          revision: project?.revision ?? null,
          timelineSegments: savedTranscript?.speech_timeline?.length ?? null,
          transcribeState:
            project?.data_json?.frames?.[frameId]?.stages?.transcribe?.state ??
            null,
        }),
      );
      const matches =
        savedTranscript?.has_speech === transcript.hasSpeech &&
        String(savedTranscript?.text || "") === transcript.transcript.trim() &&
        String(savedTranscript?.translated_text || "") ===
          String(transcript.translatedText || "").trim();
      console.info(
        "[MotionTranscript]",
        JSON.stringify({
          operationId,
          frameId,
          stage: "saved",
          matches,
          originalChanged:
            String(frame.transcript?.text || "") !==
            String(savedTranscript?.text || ""),
          translationChanged:
            String(frame.transcript?.translated_text || "") !==
            String(savedTranscript?.translated_text || ""),
        }),
      );
      if (!matches) throw new Error("MOTION_TRANSCRIPT_SAVE_MISMATCH");
      void window.MotionTranscriptCommit.cleanup({
        receipt: cleanupReceipt,
        enabled: cleanupEnabled,
        shouldStop: () => scopeInvalid || cancelled,
        operationId,
        frameId,
        timeoutMs: 1e4,
        remove: (receipt, context) =>
          chrome.runtime.sendMessage({
            action: "motion:cleanupTranscript",
            receipt,
            operationId,
            frameId,
            requestedAt: context.requestedAt,
          }),
      });
      failedStage = "refresh_after_save";
      await refresh();
    } catch (error) {
      const code = String(
        error?.code || error?.message || "MOTION_TRANSCRIPTION_FAILED",
      );
      console.info(
        "[MotionTranscript]",
        JSON.stringify({
          operationId,
          frameId,
          stage: "failed",
          failedStage,
          elapsedMs: Date.now() - startedAt,
          code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(code)
            ? code
            : "MOTION_TRANSCRIPTION_FAILED",
          httpStatus: Number(error?.httpStatus) || null,
          validationFields: [
            "speech_timeline",
            "transcript",
            "translated_text",
            "revision",
            "source_revision",
            "run_id",
            "input_revision",
          ].filter((key) =>
            Object.keys(error?.data?.errors || {}).some(
              (field) => field === key || field.startsWith(`${key}.`),
            ),
          ),
        }),
      );
      try {
        const saved = await window.MotionTranscriptCommit.recordFailure({
          project: attemptProject,
          sourceRevision,
          frameId,
          frame: attemptFrame,
          error,
          invalidScope: () => scopeInvalid,
          read: () => api("GET", endpoint),
          write: (body) =>
            api(
              "PATCH",
              `${endpoint}/frames/${encodeURIComponent(frameId)}/transcription-failure`,
              body,
            ),
        });
        if (saved && !scopeInvalid) project = saved;
      } catch (failure) {
        console.warn("[MotionTranscriptFailure]", {
          operationId,
          frameId,
          stage: "save_error",
          code: failure?.code || "MOTION_TRANSCRIPT_SAVE_FAILED",
        });
      }
      throw error;
    }
  }
  async function generateBatchTranscripts(remaining = null) {
    if (scopeInvalid || busy || motionRunning) return;
    busy = true;
    updateButtons();
    status(motionText("text023", "\u0110ang ki\u1EC3m tra..."));
    try {
      await refreshProfile();
      if (!profile) throw new Error("MOTION_PROFILE_UNPINNED");
    } catch (error) {
      status(motionErrorMessage(error));
      await window.customDialog?.alert?.(motionErrorMessage(error), {
        title: "Motion",
        type: "error",
      });
      return;
    } finally {
      busy = false;
      updateButtons();
    }
    if (scopeInvalid) return;
    console.info(
      "[MotionTranscriptBatch]",
      JSON.stringify({
        stage: "route",
        profileRevision: profile.revision,
        mode: profile.settings?.execution_mode || null,
        paused: project.data_json?.paused === true,
      }),
    );
    if (profile?.settings?.execution_mode === "parallel") {
      motionRunning = true;
      cancelled = false;
      $("progress").value = 0;
      startActivity();
      updateButtons();
      status(
        motionText("text092", "\u0110ang l\u1EA5y l\u1EDDi tho\u1EA1i..."),
      );
      try {
        const response = await chrome.runtime.sendMessage({
          action: "motionRunner:start",
          taskKind: "transcript_batch",
          projectId,
          flowProjectId: project.flow_project_id,
          frameIds: remaining,
          screen: {
            screenLeft: window.screen?.availLeft,
            screenTop: window.screen?.availTop,
            screenWidth: window.screen?.availWidth,
            screenHeight: window.screen?.availHeight,
          },
        });
        if (response?.success !== true)
          throw new Error(response?.error || "MOTION_RUNNER_NOT_READY");
        console.info(
          "[MotionTranscriptBatch]",
          JSON.stringify({
            stage: "host_admitted",
            runId: response.runId,
            mode: "parallel",
            hostEpoch: response.epoch,
          }),
        );
        externalMotionRun = {
          runId: response.runId,
          epoch: response.epoch,
          state: "preparing",
        };
        const stored = await chrome.storage.local.get(
          `motion_runner_status:${userId}:${projectId}`,
        );
        await acceptExternalMotionStatus(
          stored?.[`motion_runner_status:${userId}:${projectId}`],
        );
      } catch (error) {
        motionRunning = false;
        settleActivity();
        updateButtons();
        status(
          motionErrorMessage(error || "MOTION_TRANSCRIPTION_FAILED", {
            transcript: true,
          }),
        );
        await window.customDialog?.alert?.(
          motionErrorMessage(error || "MOTION_TRANSCRIPTION_FAILED", {
            transcript: true,
          }),
          {
            title: motionText(
              "text147",
              "Kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c sub h\xE0ng lo\u1EA1t",
            ),
            type: "error",
          },
        );
      }
      return;
    }
    const operationId = crypto.randomUUID();
    const startedAt = Date.now();
    let restoreBatchPause = false;
    motionRunning = true;
    cancelled = false;
    $("progress").value = 0;
    startActivity();
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_RUNNING");
          try {
            await refresh();
            const sourceRevision = Number(project.data_json.source_revision);
            const preferences = project.data_json.preferences || {};
            const provider =
              preferences.transcription_provider ||
              profile?.settings?.transcription_provider;
            if (!profile) throw new Error("MOTION_PROFILE_UNPINNED");
            const frames = Object.entries(project.data_json.frames || {})
              .filter(([id]) => !remaining || remaining.includes(id))
              .sort((a, b) => Number(a[1].start) - Number(b[1].start));
            if (!frames.length) {
              status(
                motionText(
                  "text162",
                  "Ch\u01B0a c\xF3 frame \u0111\u1EC3 t\u1EA1o sub.",
                ),
              );
              return;
            }
            const invalidFrames = new Map();
            for (const [frameId, frame] of frames) {
              try {
                if (frame.stages?.split?.state !== "ready")
                  throw new Error("MOTION_SPLIT_NOT_READY");
                if (project.data_json?.requires_resplit)
                  throw new Error("MOTION_SOURCE_REQUIRES_RESPLIT");
                const submit = frame.stages?.submit;
                if (
                  ["running", "needs_review"].includes(submit?.state) ||
                  (submit?.state === "ready" &&
                    !["ready", "failed"].includes(frame.stages?.monitor?.state))
                )
                  throw new Error("FRAME_OPERATION_MUST_RECONCILE");
                const audioState = frame.stages?.split?.audio_state;
                if (
                  ![
                    "audio_present",
                    "audio_track_absent",
                    "silent_verified",
                  ].includes(audioState)
                )
                  throw new Error(
                    audioState === "audio_decode_unsupported"
                      ? "AUDIO_DECODE_UNSUPPORTED"
                      : "MOTION_AUDIO_STATE_INVALID",
                  );
                if (audioState === "audio_present") {
                  if (!["chatgpt", "gemini"].includes(provider))
                    throw new Error("MOTION_AGENT_NOT_SELECTED");
                  const record = await MotionArtifactStore.get({
                    userId,
                    toolProjectId: projectId,
                    sourceRevision,
                    frameId,
                    kind: "source_audio",
                  });
                  if (!record?.blob)
                    throw new Error("MOTION_AUDIO_NOT_AVAILABLE");
                }
              } catch (error) {
                invalidFrames.set(
                  frameId,
                  error?.code ||
                    error?.message ||
                    "MOTION_TRANSCRIPTION_FAILED",
                );
              }
            }
            await window.storageSettings.init();
            if (project.data_json.paused === true) {
              project = await api("PATCH", endpoint, {
                revision: project.revision,
                pause: false,
              });
              restoreBatchPause = true;
            }
            pausedStandaloneTask = null;
            console.info(
              "[MotionTranscriptBatch]",
              JSON.stringify({
                operationId,
                stage: "prepared",
                provider,
                sourceRevision,
                count: frames.length,
                mode: "sequential",
              }),
            );
            let completed = 0;
            for (const [index, [frameId, original]] of frames.entries()) {
              await refresh();
              if (project.data_json?.paused) {
                pausedStandaloneTask = {
                  kind: "sub",
                  remaining: frames.slice(index).map(([id]) => id),
                };
                break;
              }
              const current = project.data_json?.frames?.[frameId];
              if (
                scopeInvalid ||
                Number(project.data_json.source_revision) !== sourceRevision ||
                !current ||
                current.run_id !== original.run_id ||
                current.input_revision !== original.input_revision ||
                JSON.stringify(current.transcript || null) !==
                  JSON.stringify(original.transcript || null) ||
                [
                  "transcription_provider",
                  "translate_enabled",
                  "target_language",
                ].some(
                  (key) =>
                    (project.data_json.preferences?.[key] ?? null) !==
                    (preferences[key] ?? null),
                )
              )
                throw new Error("FRAME_SCOPE_CHANGED");
              batchSubFrameIds = new Set([frameId]);
              await refresh();
              status(
                motionFormat(
                  "text209",
                  "\u0110ang l\u1EA5y l\u1EDDi tho\u1EA1i {0}/{1}: {2}...",
                  [index + 1, frames.length, frameId],
                ),
              );
              console.info(
                "[MotionTranscriptBatch]",
                JSON.stringify({
                  operationId,
                  stage: "frame_start",
                  frameId,
                  index: completed + 1,
                  count: frames.length,
                }),
              );
              try {
                if (invalidFrames.has(frameId))
                  throw new Error(invalidFrames.get(frameId));
                await transcribeMotionFrame(
                  frameId,
                  current,
                  profile,
                  preferences,
                  { guardBatchState: true },
                );
                completed++;
              } catch (error) {
                if (scopeInvalid) throw error;
                const raw = String(
                  error?.code ||
                    error?.message ||
                    "MOTION_TRANSCRIPTION_FAILED",
                );
                const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                  ? raw
                  : "MOTION_TRANSCRIPTION_FAILED";
                console.warn(
                  "[MotionFrameFailure]",
                  JSON.stringify({
                    operationId,
                    frameId,
                    stage: "transcript",
                    code,
                    action: "skip_frame",
                  }),
                );
                if (invalidFrames.has(frameId)) {
                  try {
                    const saved =
                      await window.MotionTranscriptCommit.recordFailure({
                        project: { ...project, data_json: { preferences } },
                        sourceRevision,
                        frameId,
                        frame: original,
                        error,
                        invalidScope: () => scopeInvalid,
                        read: () => api("GET", endpoint),
                        write: (body) =>
                          api(
                            "PATCH",
                            `${endpoint}/frames/${encodeURIComponent(frameId)}/transcription-failure`,
                            body,
                          ),
                      });
                    if (saved && !scopeInvalid) project = saved;
                  } catch (failure) {
                    console.warn("[MotionTranscriptFailure]", {
                      operationId,
                      frameId,
                      stage: "save_error",
                      code: failure?.code || "MOTION_TRANSCRIPT_SAVE_FAILED",
                    });
                  }
                }
                status(
                  `${frameId}: ${motionErrorMessage(error, { transcript: true })}`,
                  { state: "failed" },
                );
              } finally {
                batchSubFrameIds.clear();
                $("progress").value = ((index + 1) / frames.length) * 100;
              }
              console.info(
                "[MotionTranscriptBatch]",
                JSON.stringify({
                  operationId,
                  stage: "frame_saved",
                  frameId,
                  completed,
                  count: frames.length,
                  elapsedMs: Date.now() - startedAt,
                }),
              );
            }
            if (!project.data_json?.paused)
              status(
                motionFormat("text210", "\u0110\xE3 t\u1EA1o sub {0} frame.", [
                  completed,
                ]),
                { state: completed === frames.length ? "ready" : "failed" },
              );
            else if (!pausedStandaloneTask)
              pausedStandaloneTask = { kind: "sub", remaining: [] };
          } finally {
            if (restoreBatchPause && !scopeInvalid) {
              await setPaused(true);
              restoreBatchPause = false;
            }
          }
        },
      );
    } catch (error) {
      const code = String(
        error?.code || error?.message || "MOTION_TRANSCRIPTION_FAILED",
      );
      console.warn(
        "[MotionTranscriptBatch]",
        JSON.stringify({
          operationId,
          stage: "failed",
          code,
          elapsedMs: Date.now() - startedAt,
        }),
      );
      status(motionErrorMessage(error, { transcript: true }), {
        state: code === "MOTION_CANCELLED" ? "paused" : "failed",
      });
      motionToast(motionErrorMessage(error, { transcript: true }), {
        error: true,
      });
    } finally {
      if (restoreBatchPause && !scopeInvalid) await setPaused(true);
      batchSubFrameIds.clear();
      motionRunning = false;
      settleActivity();
      updateButtons();
      if (!scopeInvalid)
        await refresh().catch((error) =>
          console.warn("[Motion] Batch refresh failed", error?.message),
        );
    }
  }
  async function generateFrameTranscript(frameId) {
    if (scopeInvalid || busy || motionRunning) return;
    let restoreManualPause = false;
    let failureCode = null;
    motionRunning = true;
    cancelled = false;
    startActivity();
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error("PROJECT_ALREADY_RUNNING");
          await refresh();
          const frame = project.data_json?.frames?.[frameId];
          if (!frame || frame.stages?.split?.state !== "ready")
            throw new Error("MOTION_SPLIT_NOT_READY");
          const submit = frame.stages?.submit;
          if (
            ["running", "needs_review"].includes(submit?.state) ||
            (submit?.state === "ready" &&
              !["ready", "failed"].includes(frame.stages?.monitor?.state))
          ) {
            throw new Error("FRAME_OPERATION_MUST_RECONCILE");
          }
          if (
            (frame.transcript || frame.stages?.persist?.state === "ready") &&
            !(await window.customDialog.confirm(
              motionFormat(
                "text248",
                "T\u1EA1o l\u1EA1i sub {0} s\u1EBD thay l\u1EDDi tho\u1EA1i hi\u1EC7n t\u1EA1i v\xE0 y\xEAu c\u1EA7u t\u1EA1o l\u1EA1i k\u1EBFt qu\u1EA3 Flow. Ti\u1EBFp t\u1EE5c?",
                [frameId],
              ),
              { title: "T\u1EA1o l\u1EA1i sub" },
            ))
          )
            return;
          if (
            !profile ||
            !Number.isSafeInteger(profile.revision) ||
            profile.revision < 1
          )
            throw new Error("MOTION_PROFILE_UNPINNED");
          await window.storageSettings.init();
          if (project.data_json?.paused === true) {
            project = await api("PATCH", endpoint, {
              revision: project.revision,
              pause: false,
            });
            restoreManualPause = true;
          }
          activeMotionFrameId = frameId;
          activeMotionStage = "transcribe";
          await refresh();
          const current = project.data_json?.frames?.[frameId];
          if (
            !current ||
            current.run_id !== frame.run_id ||
            current.input_revision !== frame.input_revision
          )
            throw new Error("FRAME_SCOPE_CHANGED");
          await transcribeMotionFrame(
            frameId,
            current,
            profile,
            project.data_json.preferences || {},
          );
          status(
            motionFormat("text211", "\u0110\xE3 t\u1EA1o sub {0}.", [frameId]),
          );
        },
      );
    } catch (error) {
      const code = String(
        error?.code || error?.message || "MOTION_TRANSCRIPTION_FAILED",
      );
      failureCode = code;
      status(motionErrorMessage(error, { transcript: true }), {
        state: code === "MOTION_CANCELLED" ? "paused" : "failed",
      });
      if (!cancelled && !["MOTION_CANCELLED", "ABORTED"].includes(code))
        await window.customDialog?.alert?.(
          `${frameId}: ${motionErrorMessage(error, { transcript: true })}`,
          {
            title: motionText(
              "text148",
              "Kh\xF4ng t\u1EA1o \u0111\u01B0\u1EE3c sub",
            ),
            type: code === "MOTION_CANCELLED" ? "warning" : "error",
          },
        );
    } finally {
      activeMotionFrameId = null;
      activeMotionStage = null;
      motionRunning = false;
      settleActivity();
      updateButtons();
      if (restoreManualPause && !scopeInvalid) await setPaused(true);
      if (!scopeInvalid)
        await refresh().catch((error) =>
          console.warn("[Motion] Refresh after sub failed", error?.message),
        );
      if (failureCode && !scopeInvalid)
        status(motionErrorMessage(failureCode, { transcript: true }), {
          state: failureCode === "MOTION_CANCELLED" ? "paused" : "failed",
        });
    }
  }
  function publishMotionGeneration(request, result) {
    if (!window.generationHistory || !result || scopeInvalid) return;
    return window.MotionFlowQueueRequest.publishHistory(
      request,
      result,
      projectId,
      () => {
        if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
      },
    ).catch((error) =>
      console.warn(
        "[Motion] Generation history publication failed",
        error?.message,
      ),
    );
  }
  async function runMotionFrames(onlyFrameId = null, confirmedFlowMode = null) {
    if (motionRunning || scopeInvalid) return;
    if (!onlyFrameId && isMotionProjectComplete()) {
      status(motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh"), {
        state: "ready",
      });
      settleActivity();
      updateButtons();
      return;
    }
    busy = true;
    updateButtons();
    try {
      const localTarget = await getMotionFlowTarget();
      project = await window.MotionLocalReferences.recoverProject({
        userId,
        project,
        target: localTarget,
        api,
        assertScope: async () => {
          if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
          assertPinnedFlowTarget(await getMotionFlowTarget(), localTarget);
        },
        onStage: ({ kind, state, error }) => {
          $(kind + "DropZone").setAttribute(
            "aria-busy",
            String(state === "uploading"),
          );
          referenceFailed(
            kind,
            state === "failed" ? motionErrorMessage(error) : "",
          );
        },
      });
      await refresh();
    } catch (error) {
      status(motionErrorMessage(error));
      return;
    } finally {
      busy = false;
      updateButtons();
    }
    if (!onlyFrameId && profile?.settings?.execution_mode === "parallel") {
      motionRunning = true;
      startActivity();
      updateButtons();
      try {
        const response = await chrome.runtime.sendMessage({
          action: "motionRunner:start",
          projectId,
          flowProjectId: project?.flow_project_id,
          confirmedFlowMode,
          screen: {
            screenLeft: window.screen?.availLeft,
            screenTop: window.screen?.availTop,
            screenWidth: window.screen?.availWidth,
            screenHeight: window.screen?.availHeight,
          },
        });
        if (response?.success !== true)
          throw new Error(response?.error || "MOTION_RUN_FAILED");
        externalMotionRun = {
          runId: response.runId,
          epoch: response.epoch,
          state: "preparing",
        };
        motionRunning = true;
        updateButtons();
        const stored = await chrome.storage.local
          .get(`motion_runner_status:${userId}:${projectId}`)
          .catch(() => ({}));
        await acceptExternalMotionStatus(
          stored?.[`motion_runner_status:${userId}:${projectId}`],
        );
      } catch (error) {
        motionRunning = false;
        externalMotionRun = null;
        settleActivity();
        updateButtons();
        status(motionErrorMessage(error || "MOTION_RUN_FAILED"));
        await window.customDialog?.alert?.(
          motionErrorMessage(error || "MOTION_RUN_FAILED"),
          { title: "Motion", type: "error" },
        );
      }
      return;
    }
    referenceScanController?.abort();
    externalMotionRun = null;
    externalFrameProviderStates.clear();
    motionRunning = true;
    cancelled = false;
    motionQueuePauseRequested = false;
    startActivity();
    updateButtons();
    let restoreManualPause = false;
    let deferredApiQueue = null;
    const frameFailures = [];
    const failedStages = new Map();
    const timingRunId = crypto.randomUUID();
    const timedStage = async (frameId, stage, operation) => {
      const startedAt = performance.now();
      let outcome = "success";
      try {
        return await operation();
      } catch (error) {
        outcome = "error";
        failedStages.set(frameId, stage);
        throw error;
      } finally {
        console.info(
          "[MotionFrameTiming]",
          JSON.stringify({
            runId: timingRunId,
            frameId,
            stage,
            outcome,
            elapsedMs: Math.round(performance.now() - startedAt),
          }),
        );
      }
    };
    const runProfile = profile;
    try {
      if (
        !onlyFrameId &&
        runProfile?.settings?.execution_mode &&
        runProfile.settings.execution_mode !== "sequential"
      ) {
        throw new Error("MOTION_PARALLEL_NOT_AVAILABLE");
      }
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-batch:${userId}`,
        { ifAvailable: true, mode: "shared" },
        async (batchLock) => {
          if (!batchLock) throw new Error("MOTION_BATCH_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion-run:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_RUNNING");
              await refresh();
              if (onlyFrameId && project.data_json?.paused === true) {
                project = await api("PATCH", endpoint, {
                  revision: project.revision,
                  pause: false,
                });
                motionQueuePauseRequested = false;
                restoreManualPause = true;
              }
              if (
                !window.PromptQueue ||
                !window.MotionFlowQueueRequest ||
                !window.MotionPromptComposer
              ) {
                throw new Error("MOTION_FLOW_QUEUE_UNAVAILABLE");
              }
              await window.storageSettings.init();
              await window.featureGate.init();
              const executionConfig = await window.ExecutionConfig.getConfig();
              flowRuntimeReady = true;
              if (
                window.MotionAudioRegenerator.needsAudioPreparation(project)
              ) {
                const maxRetries =
                  window.featureGate.canUse("retry_on_fail") === true
                    ? executionConfig?.workflow?.max_retries
                    : 0;
                project = await window.MotionAudioRegenerator.ensureSpeechAudio(
                  {
                    userId,
                    projectId,
                    api,
                    maxRetries,
                    runLockHeld: true,
                    resolveFrameSource: resolveAudioFrameSource,
                    shouldStop: () =>
                      cancelled ||
                      scopeInvalid ||
                      motionQueuePauseRequested ||
                      project.data_json?.paused === true,
                    onProgress: (info) => {
                      activeMotionStage = "audio";
                      activeMotionFrameId = info.frameId;
                      activeAudioFrameId =
                        info.state === "running" ? info.frameId : null;
                      status(
                        info.error
                          ? motionErrorMessage(info.error)
                          : motionFormat("preparingAudio", "", [
                              info.frameId,
                              info.index,
                              info.total,
                            ]),
                      );
                    },
                  },
                );
                activeAudioFrameId = null;
                await refresh();
              }
              const queue = window.PromptQueue.getInstance();
              if (project.data_json?.preferences?.continuity_enabled === true)
                MotionContinuity.validate(project, runProfile);
              const ids = Object.entries(project.data_json.frames || {})
                .sort((a, b) => Number(a[1].start) - Number(b[1].start))
                .map(([id]) => id);
              if (
                !runProfile ||
                !Number.isSafeInteger(runProfile.revision) ||
                runProfile.revision < 1 ||
                !runProfile.settings?.flow_model
              )
                throw new Error("MOTION_PROFILE_UNPINNED");
              for (let index = 0; index < ids.length; index++) {
                if (
                  project.data_json?.preferences?.continuity_enabled === true &&
                  frameFailures.length
                )
                  break;
                if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                if (motionQueuePauseRequested) break;
                const frameId = ids[index];
                if (onlyFrameId && frameId !== onlyFrameId) continue;
                activeMotionFrameId = frameId;
                activeMotionStage = null;
                try {
                  await refresh();
                  if (project.data_json.paused) break;
                  let frame = project.data_json.frames?.[frameId];
                  if (!frame || frame.stages?.split?.state !== "ready")
                    throw new Error("MOTION_SPLIT_NOT_READY");
                  const terminalFailure =
                    MotionFrameResultActions.terminalFailure(frame);
                  if (
                    terminalFailure &&
                    frame.stages?.persist?.state !== "ready"
                  ) {
                    const cancelledFrame =
                      terminalFailure.error_code === "MOTION_CANCELLED";
                    const journal = await MotionRunJournal.get({
                      userId,
                      toolProjectId: projectId,
                    });
                    if (
                      !cancelledFrame &&
                      Object.values(journal?.operations || {}).some(
                        (operation) => operation.frameId === frameId,
                      )
                    )
                      throw new Error("MOTION_SUBMIT_RECONCILE_REQUIRED");
                    project = await MotionFrameResultActions.run({
                      project,
                      frameId,
                      action: "reset",
                      target: { projectId: project.flow_project_id },
                      userId,
                      api,
                      preserveGenerated: !cancelledFrame,
                      assertScope: () => {
                        if (scopeInvalid)
                          throw new Error("ACCOUNT_SCOPE_CHANGED");
                      },
                    });
                    frame = project.data_json.frames[frameId];
                  }
                  if (
                    !onlyFrameId &&
                    frame.stages?.persist?.state === "ready"
                  ) {
                    const result2 = await MotionArtifactStore.get({
                      userId,
                      toolProjectId: projectId,
                      sourceRevision: Number(project.data_json.source_revision),
                      frameId,
                      kind: "generated_clip",
                      artifactRevision: Number(frame.input_revision),
                    });
                    if (result2?.blob) continue;
                    if (frame.stages?.monitor?.state !== "ready")
                      throw new Error("MOTION_RESULT_LOCAL_MISSING");
                    activeMotionFrameId = frameId;
                    activeMotionStage = "download";
                    await downloadFrameFromFlow({ frameId, automatic: true });
                    const restored = await MotionArtifactStore.get({
                      userId,
                      toolProjectId: projectId,
                      sourceRevision: Number(project.data_json.source_revision),
                      frameId,
                      kind: "generated_clip",
                      artifactRevision: Number(frame.input_revision),
                    });
                    if (!restored?.blob) {
                      throw new Error("MOTION_FLOW_DOWNLOAD_FAILED");
                    }
                    continue;
                  }
                  if (
                    !onlyFrameId &&
                    frame.stages?.monitor?.state === "ready"
                  ) {
                    activeMotionFrameId = frameId;
                    activeMotionStage = "download";
                    await downloadFrameFromFlow({ frameId, automatic: true });
                    await refresh();
                    if (
                      project.data_json.frames?.[frameId]?.stages?.persist
                        ?.state !== "ready"
                    )
                      throw new Error("MOTION_FLOW_DOWNLOAD_FAILED");
                    continue;
                  }
                  activeMotionFrameId = frameId;
                  activeMotionStage = "transcribe";
                  await refresh();
                  if (project.data_json.paused) break;
                  frame = project.data_json.frames?.[frameId];
                  if (!frame || frame.stages?.split?.state !== "ready")
                    throw new Error("MOTION_SPLIT_NOT_READY");
                  const preferences = project.data_json.preferences || {};
                  const needsTranslation =
                    preferences.translate_enabled === true &&
                    frame.transcript?.has_speech === true &&
                    (frame.transcript.translation_stale === true ||
                      !frame.transcript.translated_text?.trim());
                  if (
                    (preferences.voice_enabled ||
                      preferences.subtitle_enabled) &&
                    (!frame.transcript || needsTranslation)
                  ) {
                    await timedStage(frameId, "transcribe", () =>
                      transcribeMotionFrame(
                        frameId,
                        frame,
                        runProfile,
                        preferences,
                        { preserveOriginal: needsTranslation },
                      ),
                    );
                    frame = project.data_json.frames?.[frameId];
                    if (!frame?.transcript)
                      throw new Error("MOTION_TRANSCRIPT_INVALID");
                  }
                  activeMotionStage = "flow";
                  await refresh();
                  if (project.data_json.paused) break;
                  frame = project.data_json.frames?.[frameId];
                  const failedFlowGeneration =
                    frame.stages?.submit?.state === "failed" ||
                    (frame.stages?.submit?.state === "ready" &&
                      frame.stages?.monitor?.state === "failed");
                  if (!onlyFrameId && failedFlowGeneration) {
                    const sourceRevision2 = Number(
                      project.data_json.source_revision,
                    );
                    const oldInputRevision = Number(frame.input_revision);
                    const oldFinal = project.data_json?.final;
                    project = await api(
                      "POST",
                      `${endpoint}/frames/${encodeURIComponent(frameId)}/rerun`,
                      {
                        revision: project.revision,
                        source_revision: sourceRevision2,
                      },
                    );
                    await cleanupInvalidatedFrameArtifacts(
                      frameId,
                      sourceRevision2,
                      oldInputRevision,
                      oldFinal,
                      { preserveGenerated: true },
                    ).catch((error) =>
                      console.warn(
                        "[Motion] Frame cleanup failed",
                        error?.message,
                      ),
                    );
                    await refresh();
                    frame = project.data_json.frames?.[frameId];
                  }
                  if (frame.stages?.persist?.state === "ready") continue;
                  if (frame.stages?.monitor?.state === "ready") {
                    activeMotionStage = "download";
                    await downloadFrameFromFlow({ frameId, automatic: true });
                    await refresh();
                    if (
                      project.data_json.frames?.[frameId]?.stages?.persist
                        ?.state !== "ready"
                    ) {
                      throw new Error("MOTION_FLOW_DOWNLOAD_FAILED");
                    }
                    continue;
                  }
                  if (frame.stages?.submit?.state) {
                    console.warn("[MotionSubmitReconcile]", {
                      frameId,
                      stage: "existing_checkpoint",
                      submitState: frame.stages.submit.state,
                      monitorState: frame.stages?.monitor?.state || null,
                      flowMode: frame.stages.submit.flow_mode || null,
                      hasOperationId:
                        !!frame.stages.submit.provider_operation_id,
                    });
                    throw new Error("MOTION_SUBMIT_RECONCILE_REQUIRED");
                  }
                  const refs = project.data_json.references || {};
                  window.MotionCharacterReferences.assert(
                    project.data_json,
                    runProfile,
                  );
                  if (
                    refs.mode === "character_background" &&
                    runProfile.settings.show_background_refs === false
                  ) {
                    throw new Error("MOTION_BACKGROUND_DISABLED");
                  }
                  const selectedRefs = [
                    ...window.MotionCharacterReferences.characters(
                      project.data_json,
                    ),
                    ...(refs.mode === "character_background"
                      ? refs.background || []
                      : []),
                  ];
                  if (
                    !refs.character?.length ||
                    (refs.mode === "character_background" &&
                      !refs.background?.length)
                  ) {
                    throw new Error("MOTION_REFERENCES_REQUIRED");
                  }
                  if (
                    selectedRefs.some(
                      (ref) =>
                        !ref.fileId ||
                        ref.project_id !== project.flow_project_id,
                    )
                  ) {
                    throw new Error("MOTION_REF_PROJECT_MISMATCH");
                  }
                  const caps = window.ImagePickerModal.resolveCapsMulti({
                    provider: "flow",
                    mode: "video",
                    isFrames: false,
                    modelValue:
                      project.data_json?.preferences?.flow_model ||
                      runProfile.settings.flow_model,
                    duration: runProfile.settings.flow_duration,
                  });
                  window.MotionSplitPolicy.assertFrameLimits(
                    project,
                    runProfile,
                  );
                  if (
                    !Number.isInteger(caps.video) ||
                    caps.video < 1 ||
                    !Number.isInteger(caps.image) ||
                    selectedRefs.length > caps.image ||
                    (Number.isInteger(caps.total) &&
                      selectedRefs.length + 1 > caps.total)
                  ) {
                    throw (
                      window.ImagePickerModal.motionReferenceCapError?.({
                        caps,
                        imageCount: selectedRefs.length,
                        stage: "submit",
                        modelValue:
                          project.data_json?.preferences?.flow_model ||
                          runProfile.settings.flow_model,
                      }) || new Error("MOTION_REF_CAP_EXCEEDED")
                    );
                  }
                  if (!isSourceUploadReady(frameId)) {
                    await timedStage(frameId, "upload", () =>
                      uploadFrameClip(frameId, { propagate: true }),
                    );
                    await refresh();
                    frame = project.data_json.frames?.[frameId];
                    if (!isSourceUploadReady(frameId))
                      throw new Error("MOTION_UPLOAD_NOT_READY");
                  }
                  if (project.data_json.paused) break;
                  const sourceRevision = Number(
                    project.data_json.source_revision,
                  );
                  const source = await MotionArtifactStore.get({
                    userId,
                    toolProjectId: projectId,
                    sourceRevision,
                    frameId,
                    kind: "source_clip",
                  });
                  const correctedRefs = { ...project.data_json.references };
                  for (const kind of [
                    "character",
                    "character2",
                    "background",
                  ]) {
                    if (!Array.isArray(correctedRefs[kind])) continue;
                    correctedRefs[kind] = correctedRefs[kind].map(
                      (ref) =>
                        referencePreviewCache.get(`${kind}:${ref.fileId}`)
                          ?.corrected || ref,
                    );
                  }
                  let requestProject = {
                    ...project,
                    data_json: {
                      ...project.data_json,
                      references: correctedRefs,
                      preferences: {
                        ...project.data_json.preferences,
                        ratio:
                          project.data_json?.preferences?.ratio ||
                          $("motionRatio").value,
                      },
                    },
                  };
                  const voiceSlug =
                    requestProject.data_json.preferences?.voice_enabled === true
                      ? requestProject.data_json.preferences?.voice_slug
                      : null;
                  const resolvedVoice = voiceSlug
                    ? await window.MotionFlowQueueRequest.resolveVoice(
                        voiceSlug,
                      )
                    : null;
                  const continuityPolicy = MotionContinuity.enabled(
                    requestProject,
                  )
                    ? await window.ExecutionConfig.getConfig()
                    : null;
                  const continuityRetries =
                    MotionContinuity.enabled(requestProject) &&
                    window.featureGate.canUse("retry_on_fail") === true
                      ? continuityPolicy?.workflow?.max_retries
                      : 0;
                  const continuityDelay =
                    continuityPolicy?.workflow?.delay_nodes_sec;
                  if (
                    MotionContinuity.enabled(requestProject) &&
                    (!Number.isSafeInteger(continuityRetries) ||
                      continuityRetries < 0 ||
                      !Number.isFinite(continuityDelay) ||
                      continuityDelay < 0)
                  )
                    throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
                  const waitContinuityRetry = () =>
                    new Promise((resolve) =>
                      setTimeout(resolve, continuityDelay * 1e3),
                    );
                  const continuityCallbacks = MotionContinuity.enabled(
                    requestProject,
                  )
                    ? MotionContinuity.callbacks({
                        api,
                        endpoint,
                        project: requestProject,
                        frameId,
                        maxRetries: continuityRetries,
                        waitBeforeRetry: waitContinuityRetry,
                        assertScope: async () => {
                          if (scopeInvalid)
                            throw new Error("ACCOUNT_SCOPE_CHANGED");
                        },
                        onProgress: (value) => {
                          activeMotionFrameId = frameId;
                          activeMotionStage = "continuity";
                          activeContinuityPhase = value.detail;
                          status(
                            value.error
                              ? motionErrorMessage(value.error)
                              : continuityStatusText(),
                            { state: value.error ? "failed" : "running" },
                          );
                        },
                        onChange: async (saved) => {
                          project = saved;
                          await refresh();
                        },
                      })
                    : {};
                  const restoreGeneratedClip = (parentFrameId) =>
                    downloadFrameFromFlow({
                      frameId: parentFrameId,
                      automatic: true,
                      resolutionOverride:
                        requestProject.data_json.frames[parentFrameId]?.stages
                          ?.persist?.resolution || null,
                    });
                  const previousRestored = MotionContinuity.enabled(
                    requestProject,
                  )
                    ? await MotionContinuity.restorePreviousCheckpoint({
                        project: requestProject,
                        frameId,
                        restoreGeneratedClip,
                        readProject: () => api("GET", endpoint),
                        shouldStop: () => cancelled || scopeInvalid,
                        assertScope: async () => {
                          if (scopeInvalid)
                            throw new Error("ACCOUNT_SCOPE_CHANGED");
                        },
                      })
                    : requestProject;
                  requestProject = {
                    ...previousRestored,
                    data_json: {
                      ...previousRestored.data_json,
                      references: correctedRefs,
                    },
                  };
                  const continuityParent = MotionContinuity.enabled(
                    requestProject,
                  )
                    ? MotionContinuity.parent(requestProject, frameId)
                    : null;
                  const continuityBinding = continuityParent
                    ? MotionContinuity.identity(...continuityParent)
                    : null;
                  if (continuityParent) activeMotionStage = "continuity";
                  const continuity = await MotionContinuity.prepare({
                    project: requestProject,
                    profile: runProfile,
                    frameId,
                    userId,
                    restoreGeneratedClip,
                    target: await getMotionFlowTarget(),
                    shouldStop: () => cancelled || scopeInvalid,
                    maxRetries: continuityRetries,
                    waitBeforeRetry: waitContinuityRetry,
                    ...continuityCallbacks,
                    assertScope: async () => {
                      if (scopeInvalid)
                        throw new Error("ACCOUNT_SCOPE_CHANGED");
                      const current = await api("GET", endpoint);
                      if (
                        current.data_json?.source_revision !== sourceRevision ||
                        current.data_json?.frames?.[frameId]?.run_id !==
                          frame.run_id
                      )
                        throw new Error("FRAME_SCOPE_CHANGED");
                      MotionContinuity.assertCurrent(
                        current,
                        frameId,
                        continuityBinding,
                      );
                    },
                  });
                  const request = window.MotionFlowQueueRequest.build({
                    project: requestProject,
                    profile: runProfile,
                    frameId,
                    resolvedVoice,
                    continuity,
                    uploadReceipt: source?.uploadReceipt,
                    frameIndex: index + 1,
                    frameCount: ids.length,
                  });
                  request.onQueueAdmitted = (admission) => {
                    if (!admission?.ok || !admission.jobId) return;
                    motionQueueJobId = admission.jobId;
                    if (cancelled) {
                      void queue
                        .stopJobAndPersist(admission.jobId, {
                          stopOrigin: "user",
                          stopReason: "USER_CANCELLED",
                          stopSource: "MOTION_FORCE_STOP",
                        })
                        .catch((error) => status(motionErrorMessage(error)));
                    } else if (
                      motionQueuePauseRequested ||
                      project?.data_json?.paused
                    )
                      queue.pauseJob(admission.jobId, "manual", "motion");
                  };
                  const checkpoint = (stage, state, extra = {}) =>
                    api(
                      "PATCH",
                      `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
                      {
                        source_revision: sourceRevision,
                        run_id: frame.run_id,
                        input_revision: frame.input_revision,
                        stage,
                        state,
                        ...(stage === "submit"
                          ? {
                              profile_revision: runProfile.revision,
                              ...(flowRetryCount > 0 && {
                                retry_count: flowRetryCount,
                              }),
                            }
                          : {}),
                        ...extra,
                      },
                    );
                  let flowRetryCount = Number.isSafeInteger(
                    frame.stages?.submit?.retry_count,
                  )
                    ? frame.stages.submit.retry_count
                    : 0;
                  let acceptedReceipt = null;
                  let submitGuardFailure = null;
                  let acceptance = null,
                    providerFailureCode = null,
                    providerFailureAttempt = null;
                  request.onMotionProviderResult = (diagnostic) => {
                    if (scopeInvalid || cancelled) return;
                    if (
                      ["retrying", "retry_queued"].includes(diagnostic?.state)
                    )
                      providerFailureCode = null;
                    if (typeof externalFrameProviderStates !== "undefined") {
                      const previous =
                        externalFrameProviderStates.get(frameId)?.diagnostic;
                      if (diagnostic.state === "completed")
                        externalFrameProviderStates.delete(frameId);
                      else
                        externalFrameProviderStates.set(frameId, {
                          runId: externalMotionRun?.runId,
                          diagnostic: {
                            phase: "provider_result",
                            eventState: diagnostic.state,
                            code:
                              diagnostic.code ||
                              (["retrying", "retry_queued"].includes(
                                diagnostic.state,
                              )
                                ? previous?.code
                                : null),
                          },
                        });
                    }
                    void refresh().catch((error) =>
                      console.warn(
                        "[MotionProviderStatus]",
                        error?.code || error?.message,
                      ),
                    );
                    if (
                      (diagnostic?.state === "failed" ||
                        (diagnostic?.state === "paused" &&
                          diagnostic.reason === "flow_quota")) &&
                      /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(
                        diagnostic.code || "",
                      )
                    )
                      providerFailureCode = diagnostic.code;
                    if (
                      diagnostic?.state === "paused" &&
                      ["api_unusual_activity", "flow_quota"].includes(
                        diagnostic.reason,
                      )
                    )
                      void pauseLocalMotionProvider(diagnostic, frameId).catch(
                        (error) =>
                          console.warn("[MotionProviderPause]", {
                            frameId,
                            code: error?.code || error?.message,
                          }),
                      );
                  };
                  request.onMotionAccepted = (data) => {
                    if (cancelled) return;
                    if (
                      acceptance ||
                      request.flowModeLock !== "api" ||
                      !data?.operationId ||
                      !data?.protocolRevision ||
                      (data.apiDriver === "v2" && !data.protocolFingerprint)
                    )
                      return;
                    acceptedReceipt = {
                      provider_operation_id: data.operationId,
                      flow_mode: "api",
                      api_driver: data.apiDriver,
                      protocol_revision: data.protocolRevision,
                      ...(data.protocolFingerprint
                        ? { protocol_fingerprint: data.protocolFingerprint }
                        : {}),
                    };
                    acceptance = checkpoint("submit", "ready", acceptedReceipt)
                      .then(async () => {
                        await checkpoint(
                          "monitor",
                          "running",
                          acceptedReceipt,
                        ).catch((error) => {
                          console.warn(
                            "[Motion] Failed to mark monitor running",
                            error?.message,
                          );
                        });
                        return true;
                      })
                      .catch(async (error) => {
                        console.warn(
                          "[Motion] Failed to checkpoint accepted operation",
                          error?.message,
                        );
                        const fresh = await api("GET", endpoint).catch(
                          () => null,
                        );
                        const saved =
                          fresh?.data_json?.frames?.[frameId]?.stages?.submit;
                        return (
                          saved?.state === "ready" &&
                          saved.provider_operation_id === data.operationId &&
                          saved.flow_mode === "api" &&
                          saved.api_driver === data.apiDriver
                        );
                      });
                  };
                  let submitPrepared = false;
                  request.onBeforeMotionSubmit = async (item) => {
                    try {
                      const attempt = item?.attemptId || item?.id;
                      const retryPresentation =
                        submitPrepared &&
                        attempt &&
                        attempt !== providerFailureAttempt;
                      if (attempt && attempt !== providerFailureAttempt) {
                        providerFailureAttempt = attempt;
                        providerFailureCode = null;
                      }
                      if (scopeInvalid || cancelled)
                        throw new Error("MOTION_CANCELLED");
                      const latest = await api("GET", endpoint),
                        current = latest?.data_json?.frames?.[frameId];
                      if (latest?.data_json?.paused)
                        throw new Error("MOTION_CANCELLED");
                      if (
                        current?.run_id !== frame.run_id ||
                        current?.input_revision !== frame.input_revision
                      )
                        throw window.MotionFlowQueueRequest.scopeError(
                          "MOTION_FLOW_FRAME_CHANGED",
                          {
                            frameId,
                            stage: "submit_prepare",
                            current: latest,
                            sourceRevision,
                            inputRevision: frame.input_revision,
                            profileRevision: runProfile.revision,
                          },
                        );
                      if (
                        current?.stages?.submit?.state === "ready" &&
                        request.flowModeLock === "api"
                      ) {
                        const retry =
                          window.MotionFlowQueueRequest.confirmedRetry(
                            item,
                            current.stages.submit,
                            acceptedReceipt,
                          );
                        if (!retry)
                          throw window.MotionFlowQueueRequest.scopeError(
                            "MOTION_FLOW_SUBMIT_STATE_CHANGED",
                            {
                              frameId,
                              stage: "submit_checkpoint",
                              current: latest,
                              sourceRevision,
                              inputRevision: frame.input_revision,
                              profileRevision: runProfile.revision,
                            },
                          );
                        await acceptance;
                        await checkpoint("monitor", "failed", {
                          ...acceptedReceipt,
                          error_code: retry.code,
                          retry_exhausted: false,
                        });
                        const nextRetryCount = flowRetryCount + 1;
                        await checkpoint("submit", "running", {
                          flow_mode: request.flowModeLock,
                          retry_count: nextRetryCount,
                          retry_previous_operation_id:
                            retry.previousOperationId,
                          ...(request.continuity && {
                            continuity: {
                              ...request.continuity.binding,
                              reference_uuid:
                                request.continuity.reference.media_uuid,
                            },
                          }),
                        });
                        flowRetryCount = nextRetryCount;
                        acceptance = null;
                        acceptedReceipt = null;
                        providerFailureCode = null;
                        const afterRetry = await api("GET", endpoint),
                          retryFrame = afterRetry?.data_json?.frames?.[frameId];
                        if (
                          scopeInvalid ||
                          cancelled ||
                          afterRetry?.data_json?.paused
                        )
                          throw new Error("MOTION_CANCELLED");
                        if (
                          Number(afterRetry?.data_json?.source_revision) !==
                            sourceRevision ||
                          retryFrame?.run_id !== frame.run_id ||
                          retryFrame?.input_revision !== frame.input_revision
                        )
                          throw window.MotionFlowQueueRequest.scopeError(
                            "MOTION_FLOW_FRAME_CHANGED",
                            {
                              frameId,
                              stage: "submit_checkpoint",
                              current: afterRetry,
                              sourceRevision,
                              inputRevision: frame.input_revision,
                              profileRevision: runProfile.revision,
                            },
                          );
                      }
                      if (!submitPrepared) {
                        if (
                          latest.data_json?.preferences?.continuity_enabled ===
                            true ||
                          request.continuity
                        )
                          MotionContinuity.assertCurrent(
                            latest,
                            frameId,
                            request.continuity?.binding,
                          );
                        await checkpoint("submit", "running", {
                          flow_mode: request.flowModeLock,
                          ...(request.continuity && {
                            continuity: {
                              ...request.continuity.binding,
                              reference_uuid:
                                request.continuity.reference.media_uuid,
                            },
                          }),
                        });
                        submitPrepared = true;
                        activeFlowStartedAt = Date.now();
                        activeFlowRetryLabel = "";
                        activeMotionStage = "flow";
                        await refresh();
                        status(
                          motionFormat(
                            "text212",
                            "{0}: \u0111ang t\u1EA1o video Flow {1}...",
                            [frameId, request.flowModeLock.toUpperCase()],
                          ),
                        );
                      } else if (retryPresentation) {
                        activeFlowRetryLabel = "";
                        activeMotionStage = "flow";
                        await refresh();
                        status(
                          motionFormat(
                            "text212",
                            "{0}: \u0111ang t\u1EA1o video Flow {1}...",
                            [frameId, request.flowModeLock.toUpperCase()],
                          ),
                          { state: "running" },
                        );
                      }
                    } catch (error) {
                      submitGuardFailure =
                        error?.code ||
                        error?.message ||
                        "MOTION_FLOW_PRE_DISPATCH_FAILED";
                      throw Object.assign(error, {
                        preSubmitFailure: true,
                        noRetry: true,
                        noReplay: true,
                        notDispatched: true,
                      });
                    }
                  };
                  let result;
                  try {
                    if (!deferredApiQueue) {
                      queue.deferApiRefresh();
                      deferredApiQueue = queue;
                    }
                    result = await timedStage(frameId, "flow_queue", () =>
                      queue.submitJob(request),
                    );
                    publishMotionGeneration(request, result);
                  } catch (error) {
                    await checkpoint("submit", "needs_review", {
                      flow_mode: request.flowModeLock,
                    }).catch(() => {});
                    throw error;
                  } finally {
                    motionQueueJobId = null;
                    activeFlowStartedAt = 0;
                    activeFlowRetryLabel = "";
                  }
                  if (motionPauseTransition) await motionPauseTransition;
                  if (
                    submitGuardFailure &&
                    acceptance &&
                    !result?.resultTileIds?.length
                  ) {
                    await acceptance;
                    await checkpoint("monitor", "needs_review", {
                      ...acceptedReceipt,
                      flow_mode: request.flowModeLock,
                    });
                    throw new Error(submitGuardFailure);
                  }
                  if (result?.stopped && cancelled) {
                    const accepted2 = acceptance ? await acceptance : false;
                    await checkpoint(
                      accepted2 ? "monitor" : "submit",
                      "failed",
                      { error_code: "MOTION_CANCELLED", retry_exhausted: true },
                    );
                    await refresh();
                    break;
                  }
                  if (
                    !result?.recoveryRequired &&
                    !result?.stopped &&
                    result?.failed > 0 &&
                    !result?.resultTileIds?.length
                  ) {
                    const failure = result.errorDetails?.[0];
                    if (
                      failure?.apiAmbiguous === true ||
                      ["ambiguous", "accepted_poll"].includes(failure?.apiStage)
                    ) {
                      const accepted3 = acceptance ? await acceptance : false;
                      await checkpoint(
                        accepted3 ? "monitor" : "submit",
                        "needs_review",
                        { flow_mode: request.flowModeLock },
                      );
                      console.warn("[MotionSubmitReconcile]", {
                        frameId,
                        stage: "ambiguous_result",
                        apiStage: failure?.apiStage || null,
                        accepted: accepted3,
                        flowMode: request.flowModeLock,
                      });
                      throw new Error("MOTION_SUBMIT_RECONCILE_REQUIRED");
                    }
                    const code = window.MotionFlowQueueRequest.failureCode(
                      result,
                      providerFailureCode,
                    );
                    const accepted2 = acceptance ? await acceptance : false;
                    window.MotionFlowQueueRequest.logFailure?.({
                      frameId,
                      frame,
                      sourceRevision,
                      mode: request.flowModeLock,
                      accepted: accepted2,
                      code,
                      result,
                    });
                    await checkpoint(
                      accepted2 ? "monitor" : "submit",
                      "failed",
                      { error_code: code, retry_exhausted: true },
                    );
                    await refresh();
                    throw new Error(code);
                  }
                  let receipt;
                  try {
                    receipt = window.MotionFlowQueueRequest.receipt(
                      result,
                      request.flowModeLock,
                      project.flow_project_id,
                    );
                  } catch (error) {
                    await checkpoint("submit", "needs_review", {
                      flow_mode: request.flowModeLock,
                    }).catch(() => {});
                    throw error;
                  }
                  const accepted = acceptance ? await acceptance : false;
                  if (!accepted) await checkpoint("submit", "ready", receipt);
                  await checkpoint("monitor", "ready", receipt);
                  await refresh();
                  activeMotionStage = "download";
                  await timedStage(frameId, "download_persist", () =>
                    downloadFrameFromFlow({ frameId, automatic: true }),
                  );
                  await refresh();
                  if (
                    project.data_json.frames?.[frameId]?.stages?.persist
                      ?.state !== "ready"
                  ) {
                    throw new Error("MOTION_FLOW_DOWNLOAD_FAILED");
                  }
                  if (onlyFrameId)
                    motionToast(
                      `${frameId}: ${motionText("text080", "K\u1EBFt qu\u1EA3 s\u1EB5n s\xE0ng")}`,
                    );
                } catch (error) {
                  if (onlyFrameId || scopeInvalid) throw error;
                  const raw = String(
                    error?.code || error?.message || "MOTION_RUN_FAILED",
                  );
                  const code = /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                    ? raw
                    : "MOTION_RUN_FAILED";
                  frameFailures.push({
                    frameId,
                    stage:
                      failedStages.get(frameId) ||
                      activeMotionStage ||
                      "source",
                    code,
                  });
                  console.warn(
                    "[MotionFrameFailure]",
                    JSON.stringify({
                      runId: timingRunId,
                      ...frameFailures.at(-1),
                      action:
                        project.data_json.preferences?.continuity_enabled ===
                        true
                          ? "block_following_frames"
                          : "skip_frame",
                      voiceEnabled:
                        project.data_json.preferences?.voice_enabled === true,
                      subtitleEnabled:
                        project.data_json.preferences?.subtitle_enabled ===
                        true,
                    }),
                  );
                  status(`${frameId}: ${motionErrorMessage(error)}`);
                  if (
                    cancelled ||
                    project?.data_json?.paused ||
                    motionQueuePauseRequested
                  )
                    break;
                }
              }
              if (frameFailures.length) {
                const labels = {
                  source: motionText("text219", "c\u1EAFt video"),
                  transcribe: motionText(
                    "text220",
                    "l\u1EA5y l\u1EDDi tho\u1EA1i",
                  ),
                  upload: motionText("text221", "t\u1EA3i l\xEAn Flow"),
                  continuity: motionText(
                    "continuityUpload",
                    "Upload \u1EA3nh n\u1ED1i c\u1EA3nh",
                  ),
                  flow: motionText("text222", "gen"),
                  download: motionText("text223", "l\u01B0u k\u1EBFt qu\u1EA3"),
                  download_persist: motionText(
                    "text223",
                    "l\u01B0u k\u1EBFt qu\u1EA3",
                  ),
                };
                const details = frameFailures.map(
                  (item) =>
                    `${item.frameId} \xB7 ${labels[item.stage] || item.stage} \xB7 ${motionErrorMessage(item.code, { videoUpload: item.stage === "upload" })}`,
                );
                status(
                  motionFailureMessage({
                    failures: frameFailures.map((item) => ({
                      ...item,
                      error: item.code,
                    })),
                  }),
                  { state: "failed" },
                );
                $("status").title = details.join("\n");
                const uploadFailure = frameFailures.find(
                  (item) => item.stage === "upload",
                );
                if (uploadFailure)
                  void showVideoUploadFailure(
                    uploadFailure.code,
                    uploadFailure.frameId,
                  );
              }
              if (
                !scopeInvalid &&
                !cancelled &&
                !motionQueuePauseRequested &&
                !project.data_json?.paused &&
                !project.data_json?.requires_resplit
              ) {
                await refresh();
                const frames = Object.values(project.data_json?.frames || {});
                const final = project.data_json?.final;
                const completeFinal =
                  !!finalArtifact &&
                  final?.stale !== true &&
                  Array.isArray(final?.frame_ids) &&
                  final.frame_ids.length === frames.length &&
                  final.frame_ids.every(
                    (id) =>
                      project.data_json.frames?.[id]?.stages?.persist?.state ===
                      "ready",
                  );
                if (
                  !scopeInvalid &&
                  !cancelled &&
                  !project.data_json?.paused &&
                  frames.length > 0 &&
                  frames.every(
                    (frame) => frame.stages?.persist?.state === "ready",
                  ) &&
                  !completeFinal
                ) {
                  await mergeFinal({ requireAll: true });
                }
              }
            },
          );
        },
      );
    } catch (error) {
      const code = String(error?.code || error?.message || "MOTION_RUN_FAILED");
      status(
        motionErrorMessage(error, {
          videoUpload: failedStages.get(activeMotionFrameId) === "upload",
        }),
        { state: code === "MOTION_CANCELLED" ? "paused" : "failed" },
      );
      if (
        code === "MOTION_CANCELLED" &&
        (cancelled ||
          scopeInvalid ||
          motionQueuePauseRequested ||
          project?.data_json?.paused)
      )
        return;
      const message = [
        activeMotionFrameId,
        motionErrorMessage(error, {
          videoUpload: failedStages.get(activeMotionFrameId) === "upload",
        }),
      ]
        .filter(Boolean)
        .join(": ");
      if (onlyFrameId) motionToast(message, { error: true });
      if (failedStages.get(activeMotionFrameId) === "upload")
        await showVideoUploadFailure(code, activeMotionFrameId);
      else
        await window.customDialog?.alert?.(message, {
          title: project?.data_json?.paused
            ? motionText("text151", "Motion t\u1EA1m d\u1EEBng")
            : "Motion",
          type: code === "MOTION_CANCELLED" ? "warning" : "error",
          ...(failedStages.get(activeMotionFrameId) === "flow" && {
            icon: "flow",
          }),
        });
    } finally {
      if (deferredApiQueue) {
        deferredApiQueue.releaseApiRefresh();
        deferredApiQueue
          .flushPendingApiRefresh("api-results-refresh")
          .catch((error) =>
            console.warn(
              "[Motion] API board refresh failed:",
              error?.message || error,
            ),
          );
      }
      localMotionProviderPause = null;
      externalFrameProviderStates.clear();
      activeMotionFrameId = null;
      activeMotionStage = null;
      activeAudioFrameId = null;
      activeFlowStartedAt = 0;
      activeFlowRetryLabel = "";
      motionRunning = false;
      if (deferredUploadPause && !scopeInvalid) {
        deferredUploadPause = false;
        await setPaused(true);
      }
      if (restoreManualPause && !scopeInvalid && !project?.data_json?.paused)
        await setPaused(true);
      settleActivity();
      updateButtons();
      if (!scopeInvalid)
        await refresh().catch((error) =>
          console.warn("[Motion] Refresh after run failed", error?.message),
        );
    }
  }
  function timelineWidth() {
    return 250;
  }
  function hasUploadedSourceUuid(frameId) {
    return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
      String(sourceUploadReceipts.get(frameId)?.mediaUuid || ""),
    );
  }
  function isSourceUploadReady(frameId) {
    return hasUploadedSourceUuid(frameId);
  }
  function canUploadFrameSource(frameId) {
    return sourceBlobFrameIds.has(frameId) && !hasUploadedSourceUuid(frameId);
  }
  function hasPendingSourceUploads() {
    return Object.entries(project?.data_json?.frames || {}).some(
      ([frameId, frame]) =>
        frame.stages?.split?.state === "ready" && canUploadFrameSource(frameId),
    );
  }
  function timelineTile(
    frameId,
    frame,
    kind,
    hasLocal,
    sourceRevision,
    renderEpoch,
    onOpen = null,
  ) {
    const source = kind === "source_clip";
    if (
      !source &&
      hasLocal &&
      window.MotionFrameSteps.hasFlowResult(frame) &&
      generatedPreviewRevisions.get(frameId) !== Number(frame.input_revision)
    )
      hasLocal = false;
    const localUpload =
      window.MotionFlowUpload?.activeSourceUploads?.has(frameId) === true;
    const uploading =
      source &&
      (localUpload ||
        activeUploadFrameId === frameId ||
        frame.stages?.upload?.state === "running");
    const downloading =
      activeResultEditFrameId === frameId ||
      (motionRunning &&
        activeMotionFrameId === frameId &&
        activeMotionStage === "download") ||
      (!source &&
        frame.stages?.persist?.state === "running" &&
        frame.stages?.monitor?.state === "ready");
    const stage = frameStage(frame, { resultOnly: !source });
    const remoteResult =
      !source && !hasLocal && window.MotionFrameSteps.hasFlowResult(frame);
    const uploadFailure = ["failed", "needs_review"].includes(
      frame.stages?.upload?.state,
    )
      ? frame.stages.upload
      : null;
    const uploadError = uploadFailure
      ? motionErrorMessage(
          uploadFailure.error_code ||
            (uploadFailure.state === "needs_review"
              ? "MOTION_UPLOAD_RECEIPT_RECONCILE_REQUIRED"
              : "MOTION_UPLOAD_FAILED"),
          { videoUpload: true },
        )
      : "";
    const blockedByUpload =
      !source &&
      !!uploadFailure &&
      !hasLocal &&
      !frame.stages?.submit?.state &&
      !frame.stages?.monitor?.state;
    const localProviderError =
      !source &&
      typeof localMotionProviderPause !== "undefined" &&
      localMotionProviderPause?.frameId === frameId
        ? localMotionProviderPause.error
        : null;
    const providerError =
      localProviderError ||
      (!source && externalFlowProviderError(frameId)) ||
      (!source &&
      typeof externalMotionRun !== "undefined" &&
      externalMotionRun?.state === "paused" &&
      ["api_unusual_activity", "flow_quota"].includes(
        externalMotionRun.pauseReason,
      ) &&
      externalMotionRun.frameId === frameId
        ? externalMotionRun.error
        : null);
    const retry = !source && externalFlowProviderError(frameId, true);
    const retryKey = "flowStatus.retrying",
      retryText = window.I18n?.t?.(retryKey);
    const retryLabel = retry
      ? [
          retryText && retryText !== retryKey
            ? retryText
            : "\u0110ang th\u1EED l\u1EA1i\u2026",
          typeof retry === "string" ? `(${retry})` : null,
        ]
          .filter(Boolean)
          .join(" \xB7 ")
      : null;
    const state = source
      ? uploading
        ? "running"
        : uploadFailure
          ? "failed"
          : hasLocal && frame.stages?.split?.state === "ready"
            ? "ready"
            : "waiting"
      : retry
        ? "running"
        : downloading
          ? "running"
          : stage.state === "warning"
            ? "warning"
            : providerError
              ? "failed"
              : stage.state === "failed"
                ? "failed"
                : (activeMotionFrameId === frameId &&
                      activeFlowStartedAt > 0 &&
                      activeUploadFrameId !== frameId) ||
                    (stage.state === "running" &&
                      ["continuity", "submit", "monitor", "persist"].includes(
                        stage.stage,
                      ))
                  ? "running"
                  : hasLocal && frame.stages?.persist?.state === "ready"
                    ? "ready"
                    : "waiting";
    const tile = document.createElement("button");
    let thumbnailUrl = null;
    let thumbnailObserver = null;
    let thumbnailDisposed = false;
    const thumbnailCurrent = () =>
      !thumbnailDisposed &&
      tile.isConnected &&
      !scopeInvalid &&
      Number(project?.data_json?.source_revision) === Number(sourceRevision);
    tile.disposeTimelineTile = () => {
      thumbnailDisposed = true;
      thumbnailObserver?.disconnect();
      if (thumbnailUrl) {
        URL.revokeObjectURL(thumbnailUrl);
        timelineThumbUrls.delete(thumbnailUrl);
        thumbnailUrl = null;
      }
    };
    tile.type = "button";
    tile.dataset.frameId = frameId;
    tile.className = `timeline-clip ${source ? "source" : "result"} ${hasLocal ? "" : "empty"} is-${state}`;
    if (timelineWidth(frame) < 80) tile.classList.add("is-compact");
    tile.style.width = `${timelineWidth(frame)}px`;
    tile.style.minWidth = tile.style.width;
    const timelineStatus =
      state === "warning"
        ? stage.label
        : retryLabel ||
          (providerError
            ? motionErrorMessage(providerError)
            : downloading
              ? motionFormat("text198", "\u0110ang t\u1EA3i video {0}...", [
                  frameId,
                ])
              : uploading
                ? motionText("text088", "\u0110ang upload...")
                : (source && uploadFailure && state === "failed") ||
                    blockedByUpload
                  ? uploadError
                  : state === "failed"
                    ? timelineError(stage)
                    : state === "running"
                      ? stage.state === "running"
                        ? stage.label
                        : motionText("text089", "\u0110ang gen...")
                      : stage.label);
    tile.setAttribute(
      "aria-label",
      `${frameId} \xB7 ${source ? "video g\u1ED1c" : "k\u1EBFt qu\u1EA3 Flow"} \xB7 ${source ? (state === "failed" || state === "running" ? timelineStatus : hasLocal ? motionText("text007", "S\u1EB5n s\xE0ng") : "Thi\u1EBFu file local") : timelineStatus}`,
    );
    if (state === "failed" || state === "warning" || blockedByUpload)
      tile.title = timelineStatus;
    const top = document.createElement("span");
    top.className = "timeline-clip-top";
    const title = document.createElement("strong");
    title.textContent = frameId;
    const indicator = document.createElement("i");
    indicator.textContent =
      state === "failed" || state === "running"
        ? ""
        : hasLocal
          ? "\u25CF"
          : "\u25CB";
    top.append(title, indicator);
    const bottom = document.createElement("span");
    bottom.className = "timeline-clip-bottom";
    const time = document.createElement("span");
    time.className = "timeline-clip-time";
    time.textContent = `${Number(frame.start).toFixed(1)}\u2013${Number(frame.end).toFixed(1)}s`;
    const label = document.createElement("span");
    if (!source) label.className = "timeline-flow-status";
    if (
      !source &&
      state === "failed" &&
      window.FlowApiAdapter?.isProviderGenerationError?.(
        providerError ||
          (["submit", "monitor"].includes(stage.stage)
            ? stage.data?.error_code
            : null),
        window.ProviderConfigManager?.getApiConfigValueSync?.(
          "flow",
          "api_error_codes",
        ) || {},
      )
    )
      label.dataset.errorTone = "provider";
    label.textContent = source
      ? state === "running"
        ? motionText("text088", "\u0110ang upload...")
        : state === "failed"
          ? timelineStatus
          : hasLocal
            ? motionText("text084", "Clip ngu\u1ED3n")
            : motionText("text085", "Thi\u1EBFu local")
      : state === "failed" || state === "warning" || blockedByUpload
        ? timelineStatus
        : state === "running"
          ? retryLabel ||
            (activeMotionFrameId === frameId && activeFlowRetryLabel) ||
            timelineStatus
          : state === "ready"
            ? motionText("text086", "\u0110\xE3 gen")
            : hasLocal
              ? motionText("text087", "K\u1EBFt qu\u1EA3 c\u0169")
              : stage.label;
    bottom.append(label);
    const thumb = document.createElement("span");
    thumb.className = "clip-thumb";
    thumb.setAttribute("aria-hidden", "true");
    thumb.append(time);
    const uploaded = source && hasUploadedSourceUuid(frameId);
    if (uploaded) {
      const badge = document.createElement("span");
      badge.className = "motion-source-flow-badge";
      badge.setAttribute(
        "aria-label",
        motionText("text099", "\u0110\xE3 upload l\xEAn Flow"),
      );
      badge.innerHTML = window.ProviderBrandIcons?.get?.("flow") || "";
      thumb.append(badge);
      if (!uploadFailure)
        tile.title = motionText(
          "text189",
          "\u0110\xE3 upload clip l\xEAn Flow",
        );
    }
    if (state === "running") {
      const loading = document.createElement("span");
      loading.className = "motion-frame-loading";
      thumb.append(loading);
      const localStarted = source
        ? window.MotionFlowUpload?.activeSourceUploads?.get(frameId) ||
          (activeUploadFrameId === frameId ? activeUploadStartedAt : 0)
        : activeMotionFrameId === frameId
          ? activeFlowStartedAt
          : 0;
      const stages = source
        ? ["upload"]
        : downloading
          ? ["persist"]
          : ["submit", "monitor"];
      const times = stages
        .map((name) => frame.stages?.[name])
        .filter((item) => ["running", "pending", "ready"].includes(item?.state))
        .map((item) => Date.parse(item.updated_at || ""))
        .filter(Number.isFinite);
      const started = localStarted || (times.length ? Math.min(...times) : 0);
      if (started) {
        const timer = document.createElement("span");
        timer.className = "motion-frame-timer";
        timer.dataset.startedAt = String(started);
        timer.dataset.activityKey = JSON.stringify([
          sourceRevision,
          frameId,
          frame.run_id,
          frame.input_revision,
          source ? "upload" : downloading ? "download" : "flow",
        ]);
        timer.textContent = formatElapsed(Date.now() - started);
        thumb.append(timer);
      }
    }
    tile.append(thumb, top, bottom);
    if (hasLocal || remoteResult) {
      const loadThumbnail = async () => {
        if (remoteResult) {
          const info = await resolveGeneratedFlowPreview(frameId, [
            "thumbnail",
          ]);
          if (!thumbnailCurrent() || !info?.thumbnail) return;
          const image = document.createElement("img");
          image.alt = "";
          image.src = info.thumbnail;
          thumb.append(image);
          thumb.classList.add("has-video");
          return;
        }
        const record = await MotionArtifactStore.get({
          userId,
          toolProjectId: projectId,
          sourceRevision,
          frameId,
          kind,
          artifactRevision: source
            ? 1
            : generatedPreviewRevisions.get(frameId) || 1,
        });
        if (source && !record?.blob) {
          const poster = await MotionArtifactStore.get({
            userId,
            toolProjectId: projectId,
            sourceRevision,
            frameId,
            kind: "poster",
          });
          if (!thumbnailCurrent()) return;
          let url2 = record?.thumbnailUrl || "";
          if (poster?.blob) {
            url2 = URL.createObjectURL(poster.blob);
            thumbnailUrl = url2;
            timelineThumbUrls.add(url2);
          } else if (
            record?.uploadReceipt?.mediaUuid &&
            window.MessageBridge?.getThumbnailsByIds
          ) {
            const id = record.uploadReceipt.mediaUuid;
            const lookup = await MessageBridge.getThumbnailsByIds([id], {
              deep: false,
              ownerRecords: [
                { resultId: id, mediaUuid: id, mediaType: "video" },
              ],
            }).catch(() => null);
            const info = lookup?.results?.[id];
            if (
              (!lookup?.projectId ||
                lookup.projectId === project.flow_project_id) &&
              info?.type === "video" &&
              String(info.media_uuid || "").toLowerCase() === id.toLowerCase()
            )
              url2 = info.thumbnail || url2;
          }
          if (!thumbnailCurrent() || !url2) return;
          const image = document.createElement("img");
          image.alt = "";
          image.src = url2;
          thumb.append(image);
          thumb.classList.add("has-video");
          return;
        }
        if (!thumbnailCurrent() || !record?.blob) return;
        const url = URL.createObjectURL(record.blob);
        thumbnailUrl = url;
        timelineThumbUrls.add(url);
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.preload = "metadata";
        video.style.visibility = "hidden";
        thumb.append(video);
        video.addEventListener(
          "loadeddata",
          () => {
            video.style.visibility = "visible";
            thumb.classList.add("has-video");
          },
          { once: true },
        );
        video.src = url;
      };
      if (window.IntersectionObserver) {
        const observer = new IntersectionObserver(
          (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            loadThumbnail().catch(() => {});
          },
          { root: $("sourceTrack").closest(".timeline-scroll") },
        );
        thumbnailObserver = observer;
        observer.observe(tile);
      } else loadThumbnail().catch(() => {});
      const play = document.createElement("span");
      play.className = "clip-play";
      play.textContent = "\u25B6";
      play.setAttribute("aria-hidden", "true");
      tile.append(play);
    }
    tile.addEventListener("click", () => {
      if (
        !source &&
        !hasLocal &&
        !onOpen &&
        !["running", "failed"].includes(state) &&
        frame.stages?.monitor?.state !== "ready"
      )
        return;
      Promise.resolve(onOpen ? onOpen() : openFrameDialog(frameId, kind)).catch(
        (error) => status(motionErrorMessage(error)),
      );
    });
    return tile;
  }
  async function editFrameSource(frameId, media, expected, target) {
    if (scopeInvalid || busy || motionRunning) return;
    busy = true;
    startActivity();
    updateButtons();
    let editStage = "selection_validation";
    const mutationId = crypto.randomUUID();
    const uuid = (value) =>
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
        String(value || ""),
      );
    const audit = (stage, details = {}) =>
      console.info(
        "[MotionSourceEdit]",
        JSON.stringify({ frameId, mutationId, stage, ...details }),
      );
    try {
      if (
        media?.source !== "flow" ||
        media.type !== "video" ||
        !target?.projectId ||
        (media.project_id && media.project_id !== target.projectId)
      )
        throw new Error("MOTION_FLOW_MEDIA_SELECTION_INVALID");
      let mediaId = [media.media_uuid, media.fileId, media.file_id].find(uuid);
      audit("selection", {
        hasUuid: !!mediaId,
        hasPersistentId: !!media.persistent_media_id,
      });
      if (!mediaId) {
        editStage = "catalog_identity";
        assertPinnedFlowTarget(await getMotionFlowTarget(), target);
        const keys = [
          ...new Set(
            [media.persistent_media_id, media.file_name, media.fileId].filter(
              (value) =>
                typeof value === "string" &&
                /^[A-Za-z0-9_:-]{1,1024}$/.test(value),
            ),
          ),
        ];
        const catalog =
          keys.length && (await MessageBridge.lookupFlowMediaCatalog(keys));
        assertPinnedFlowTarget(await getMotionFlowTarget(), target);
        let known = keys.map((key) => catalog?.known?.[key]).filter(Boolean);
        let identitySource = "page_catalog";
        if (
          !known.length &&
          (!catalog?.projectId || catalog.projectId === target.projectId)
        ) {
          const local = await MotionArtifactStore.listProject(
            userId,
            projectId,
          );
          const selectedAsbs = new Set(
            keys.filter(
              (value) => !uuid(value) && /^[A-Za-z0-9_-]{32,1024}$/.test(value),
            ),
          );
          known = local
            .filter(
              (record) =>
                record.kind === "source_clip" &&
                record.flowProjectId === target.projectId &&
                record.uploadReceipt?.projectId === target.projectId &&
                ["web", "api"].includes(record.uploadReceipt?.mode) &&
                [
                  record.uploadReceipt.persistentMediaId,
                  record.uploadReceipt.fileName,
                  record.uploadReceipt.mediaId,
                ].some((value) => selectedAsbs.has(value)),
            )
            .map((record) => ({
              type: "video",
              media_uuid:
                record.uploadReceipt.mediaUuid || record.uploadReceipt.mediaId,
              persistent_media_id:
                record.uploadReceipt.persistentMediaId ||
                record.uploadReceipt.fileName,
            }));
          identitySource = "saved_upload_receipt";
        }
        const ids = new Set(known.map((item) => item.media_uuid).filter(uuid));
        const verified =
          (!catalog?.projectId || catalog.projectId === target.projectId) &&
          (identitySource === "saved_upload_receipt" ||
            catalog?.supported === true) &&
          known.length > 0 &&
          known.every(
            (item) => item.type === "video" && uuid(item.media_uuid),
          ) &&
          ids.size === 1;
        audit(editStage, {
          identitySource,
          supported: catalog?.supported === true,
          projectMatches: catalog?.projectId === target.projectId,
          requested: keys.length,
          known: known.length,
          verified,
        });
        if (!verified) throw new Error("MOTION_FLOW_MEDIA_SELECTION_INVALID");
        mediaId = [...ids][0];
        media = {
          ...media,
          media_uuid: mediaId,
          persistent_media_id:
            known[0].persistent_media_id || media.persistent_media_id,
        };
      }
      editStage = "project_lock";
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              editStage = "project_refresh";
              await refresh();
              const frame = project.data_json?.frames?.[frameId];
              if (
                scopeInvalid ||
                !frame ||
                frame.run_id !== expected.runId ||
                frame.input_revision !== expected.inputRevision ||
                project.data_json.source_revision !== expected.sourceRevision
              )
                throw new Error("FRAME_SCOPE_CHANGED");
              assertPinnedFlowTarget(await getMotionFlowTarget(), target);
              const scope = {
                userId,
                toolProjectId: projectId,
                sourceRevision: Number(expected.sourceRevision),
                frameId,
                frameRunId: frame.run_id,
                inputRevision: Number(frame.input_revision),
              };
              editStage = "journal_check";
              await MotionRunJournal.editFrameResult({
                ...scope,
                checkOnly: true,
              });
              const asb = [
                media.persistent_media_id,
                media.file_name,
                media.fileId,
              ].find(
                (value) =>
                  typeof value === "string" &&
                  /^[A-Za-z0-9_-]{32,1024}$/.test(value) &&
                  !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value),
              );
              const body = {
                revision: project.revision,
                source_revision: scope.sourceRevision,
                run_id: frame.run_id,
                input_revision: scope.inputRevision,
                mutation_id: mutationId,
                flow_project_id: project.flow_project_id,
                media_id: mediaId,
                ...(asb && { persistent_media_id: asb }),
                ...(media.display_name && {
                  display_name: Array.from(String(media.display_name))
                    .slice(0, 255)
                    .join(""),
                }),
                ...(media.upload_name && {
                  upload_name: Array.from(String(media.upload_name))
                    .slice(0, 255)
                    .join(""),
                }),
              };
              let saved;
              editStage = "backend_save";
              audit(editStage);
              try {
                saved = await api(
                  "POST",
                  `${endpoint}/frames/${encodeURIComponent(frameId)}/source`,
                  body,
                );
              } catch (error) {
                const fresh = !scopeInvalid
                  ? await api("GET", endpoint).catch(() => null)
                  : null;
                if (
                  fresh?.data_json?.frames?.[frameId]?.source_edit
                    ?.mutation_id !== body.mutation_id
                )
                  throw error;
                saved = fresh;
              }
              if (
                scopeInvalid ||
                saved?.flow_project_id !== target.projectId ||
                saved?.data_json?.source_revision !== scope.sourceRevision ||
                saved.data_json.frames?.[frameId]?.source_edit?.mutation_id !==
                  body.mutation_id ||
                saved.data_json.frames[frameId].source_edit.media_id !== mediaId
              )
                throw new Error("FRAME_SCOPE_CHANGED");
              project = saved;
              editStage = "journal_fence";
              audit("backend_saved");
              await MotionRunJournal.editFrameResult(scope);
              editStage = "local_save";
              await MotionArtifactStore.syncFlowSources({
                userId,
                project,
                thumbnails: {
                  [frameId]:
                    media.thumbnail ||
                    media.thumbnail_url ||
                    media.source_thumbnail,
                },
              });
              editStage = "preview_refresh";
              if (selectedFrameId === frameId) closeFrameDialog();
              await refresh();
              const label = `${frameId}: ${window.I18n?.t?.("common.saved") || "Saved"}`;
              status(label);
              motionToast(label);
              audit("complete");
            },
          );
        },
      );
    } catch (error) {
      const rawCode = String(error?.code || error?.message || "");
      console.warn(
        "[MotionSourceEdit]",
        JSON.stringify({
          frameId,
          mutationId,
          stage: editStage,
          httpStatus: error?.httpStatus || null,
          code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawCode)
            ? rawCode
            : "MOTION_SOURCE_EDIT_FAILED",
        }),
      );
      status(motionErrorMessage(error));
      motionToast(motionErrorMessage(error), { error: true });
    } finally {
      busy = false;
      settleActivity();
      updateButtons();
      if (!scopeInvalid) await refresh().catch(() => {});
    }
  }
  async function pickFrameSource(frameId) {
    if (scopeInvalid || busy || motionRunning) return;
    try {
      const target = await getMotionFlowTarget();
      assertPinnedFlowTarget(target);
      const frame = project.data_json?.frames?.[frameId];
      if (!frame) throw new Error("FRAME_SCOPE_CHANGED");
      const expected = {
        runId: frame.run_id,
        inputRevision: frame.input_revision,
        sourceRevision: project.data_json.source_revision,
      };
      window.imagePickerModal.open({
        expectedFlowTarget: target,
        cleanFlowRefs: false,
        mediaFilter: "video",
        flowOnly: true,
        singleSelect: true,
        maxSelections: 1,
        maxVideoSelections: 1,
        maxImageSelections: 0,
        maxTotalSelections: 1,
        refAuditContext: {
          surface: "motion_source",
          toolProjectId: projectId,
          frameId,
        },
        onConfirm: (items) => {
          if (!Array.isArray(items) || items.length !== 1) {
            motionToast(
              motionErrorMessage("MOTION_FLOW_MEDIA_SELECTION_INVALID"),
              { error: true },
            );
            return;
          }
          void editFrameSource(frameId, items[0], expected, target);
        },
      });
    } catch (error) {
      status(motionErrorMessage(error));
      motionToast(motionErrorMessage(error), { error: true });
    }
  }
  function sourceTimelineTile(
    frameId,
    frame,
    hasLocal,
    sourceRevision,
    renderEpoch,
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "motion-source-cell";
    wrapper.dataset.frameId = frameId;
    const tile = timelineTile(
      frameId,
      frame,
      "source_clip",
      hasLocal,
      sourceRevision,
      renderEpoch,
    );
    wrapper.style.width = tile.style.width;
    wrapper.style.minWidth = tile.style.width;
    wrapper.disposeTimelineTile = () => tile.disposeTimelineTile?.();
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "motion-frame-menu-trigger motion-source-menu-trigger";
    trigger.textContent = "\u22EF";
    trigger.setAttribute(
      "aria-label",
      `${frameId} \xB7 ${motionText("text084", "Clip ngu\u1ED3n")}`,
    );
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (scopeInvalid) return;
      activeFrameMenu?.remove();
      const menu = document.createElement("div");
      menu.className = "motion-frame-menu";
      menu.setAttribute("role", "menu");
      const states = [];
      menu.refreshState = () =>
        states.forEach(({ button, disabled }) => {
          button.disabled = disabled();
        });
      const add = (label, icon, disabled, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        states.push({ button, disabled });
        const glyph = document.createElement("span");
        glyph.className = icon;
        glyph.setAttribute("aria-hidden", "true");
        button.append(glyph, document.createTextNode(label));
        button.addEventListener("click", () => {
          menu.remove();
          activeFrameMenu = null;
          trigger.setAttribute("aria-expanded", "false");
          Promise.resolve()
            .then(action)
            .catch((error) => {
              const raw = String(error?.code || error?.message || "");
              console.warn(
                "[MotionSourceAction]",
                JSON.stringify({
                  frameId,
                  action: icon,
                  httpStatus: error?.httpStatus || null,
                  code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(raw)
                    ? raw
                    : "MOTION_SOURCE_ACTION_FAILED",
                }),
              );
              status(motionErrorMessage(error));
              motionToast(motionErrorMessage(error), { error: true });
            });
        });
        menu.append(button);
      };
      add(
        motionText("text098", "C\u1EAFt l\u1EA1i"),
        "motion-menu-cut-icon",
        () =>
          scopeInvalid ||
          busy ||
          motionRunning ||
          !project.data_json?.frames?.[frameId],
        () => recutFrame(frameId),
      );
      add(
        window.I18n?.t?.("common.download") || "Download",
        "motion-menu-download-icon",
        () => scopeInvalid || busy || !hasLocal,
        () => mediaAction(frameId, "source_clip", "download"),
      );
      add(
        motionText("replace", "Replace"),
        "motion-menu-edit-icon",
        () =>
          scopeInvalid ||
          busy ||
          motionRunning ||
          !project.data_json?.frames?.[frameId],
        () => pickFrameSource(frameId),
      );
      if (canUploadFrameSource(frameId))
        add(
          motionText("text100", "Upload to Flow"),
          "motion-menu-upload-icon",
          () =>
            scopeInvalid ||
            busy ||
            motionRunning ||
            !project.data_json?.frames?.[frameId] ||
            !canUploadFrameSource(frameId) ||
            project.data_json?.requires_resplit === true ||
            !canGetFrameSub(project.data_json.frames[frameId]),
          () => openUploadConfirmation?.(frameId),
        );
      menu.refreshState();
      document.body.append(menu);
      activeFrameMenu = menu;
      trigger.setAttribute("aria-expanded", "true");
      const bounds = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, bounds.top - menu.offsetHeight - 4)}px`;
      (menu.querySelector("button:not(:disabled)") || trigger).focus();
    });
    wrapper.append(tile, trigger);
    return wrapper;
  }
  async function editFrameResult(
    frameId,
    action,
    media = null,
    expected = null,
    target = null,
    { preserveGenerated = false, propagate = false, batch = false } = {},
  ) {
    if (resettingAllFlowResults && !batch) return false;
    if (scopeInvalid || (action !== "reset" && (busy || motionRunning))) return;
    if (
      action === "reset" &&
      motionQueueJobId &&
      activeMotionFrameId === frameId &&
      !externalMotionRun
    ) {
      cancelled = true;
      motionQueuePauseRequested = true;
      await window.PromptQueue.getInstance().stopJobAndPersist(
        motionQueueJobId,
        {
          stopOrigin: "user",
          stopReason: "USER_CANCELLED",
          stopSource: "MOTION_FRAME_RESET",
        },
      );
    }
    if (action === "reset") {
      try {
        const response = await chrome.runtime.sendMessage({
          action: "motionRunner:resetFrame",
          projectId,
          flowProjectId: project.flow_project_id,
          frameId,
          preserveGenerated,
        });
        if (response?.success) {
          externalMotionRun = MotionFrameResultActions.withoutFrameFailure(
            externalMotionRun,
            {
              userId,
              toolProjectId: projectId,
              sourceRevision: Number(project.data_json.source_revision),
              frameId,
            },
          );
          if (localMotionProviderPause?.frameId === frameId)
            localMotionProviderPause = null;
          externalFrameProviderStates.delete(frameId);
          lastExternalMotionFailure = null;
          if (selectedFrameId === frameId) closeFrameDialog();
          await refresh();
          await resetMotionHeaderTimer();
          status(`${frameId}: Reset OK`);
          return true;
        }
        if (response?.error !== "MOTION_RUNNER_NOT_FOUND")
          throw new Error(response?.error || "MOTION_RUN_FAILED");
      } catch (error) {
        console.warn(
          "[MotionResultEdit]",
          JSON.stringify({
            frameId,
            action,
            stage: "runner_reset",
            code: error?.code || error?.message,
          }),
        );
        status(motionErrorMessage(error));
        motionToast(motionErrorMessage(error), { error: true });
        if (propagate) throw error;
        return false;
      }
    }
    busy = true;
    startActivity();
    updateButtons();
    activeResultEditFrameId = action === "replace" ? frameId : null;
    if (activeResultEditFrameId)
      motionToast(
        motionFormat("text198", "\u0110ang t\u1EA3i video {0}...", [frameId]),
        { persistent: true },
      );
    status(
      action === "replace"
        ? motionFormat("text198", "\u0110ang t\u1EA3i video {0}...", [frameId])
        : "Reset\u2026",
    );
    let editStage = "project_lock";
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        action === "reset" ? {} : { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              const frame = project.data_json?.frames?.[frameId];
              if (
                expected &&
                (frame?.run_id !== expected.runId ||
                  frame?.input_revision !== expected.inputRevision ||
                  project.data_json.source_revision !== expected.sourceRevision)
              )
                throw new Error("FRAME_SCOPE_CHANGED");
              editStage = "target";
              target ||
                (target =
                  action === "reset"
                    ? { projectId: project.flow_project_id }
                    : await getMotionFlowTarget());
              const assertScope = async () => {
                if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                if (action !== "reset")
                  assertPinnedFlowTarget(await getMotionFlowTarget(), target);
              };
              await assertScope();
              editStage = "result_action";
              project = await MotionFrameResultActions.run({
                project,
                frameId,
                action,
                media,
                target,
                userId,
                api,
                assertScope,
                config:
                  action === "replace"
                    ? ProviderConfigManager.getDownloadResolutionsSync("flow")
                    : null,
                selectedResolution:
                  action === "replace" ? $("flowResolution").value : null,
                preserveGenerated,
              });
              externalMotionRun = MotionFrameResultActions.withoutFrameFailure(
                externalMotionRun,
                {
                  userId,
                  toolProjectId: projectId,
                  sourceRevision: Number(project.data_json.source_revision),
                  frameId,
                },
              );
              if (localMotionProviderPause?.frameId === frameId)
                localMotionProviderPause = null;
              externalFrameProviderStates.delete(frameId);
              lastExternalMotionFailure = null;
              if (action === "reset") await resetMotionHeaderTimer();
              activeResultEditFrameId = null;
              activeFlowStartedAt = 0;
              activeMotionFrameId = null;
              activeMotionStage = null;
              if (selectedFrameId === frameId) closeFrameDialog();
              await refresh();
              const message =
                action === "replace"
                  ? motionFormat(
                      "text200",
                      "{0}: \u0111\xE3 l\u01B0u video Flow {1}.",
                      [
                        frameId,
                        project.data_json.frames[frameId].stages.persist
                          .resolution,
                      ],
                    )
                  : `${frameId}: Reset OK`;
              status(message);
              motionToast(message);
            },
          );
        },
      );
      return true;
    } catch (error) {
      const rawCode = String(
        error?.code || error?.error_code || error?.message || "",
      );
      console.warn(
        "[MotionResultEdit]",
        JSON.stringify({
          frameId,
          action,
          stage: editStage,
          code: /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(rawCode)
            ? rawCode
            : "MOTION_RESULT_EDIT_FAILED",
          httpStatus: error?.httpStatus || null,
        }),
      );
      activeResultEditFrameId = null;
      await refresh().catch(() => {});
      status(motionErrorMessage(error));
      motionToast(motionErrorMessage(error), { error: true });
      if (propagate) throw error;
      return false;
    } finally {
      activeResultEditFrameId = null;
      busy = batch;
      settleActivity();
      updateButtons();
    }
  }
  async function resetAllFlowResults() {
    if (scopeInvalid || busy || motionRunning || resettingAllFlowResults)
      return;
    const frames = Object.entries(project?.data_json?.frames || {}).filter(
      ([, frame]) => frame.stages?.split?.state === "ready",
    );
    if (!frames.length) return;
    const label = `${window.I18n.t("common.reset")} ${window.I18n.t("common.all")} \xB7 ${motionText("text059", "K\u1EBFt qu\u1EA3 gen")}`;
    if (
      !(await window.customDialog.confirm(`${label} (${frames.length})?`, {
        title: label,
        confirmText: window.I18n.t("common.reset"),
        cancelText: window.I18n.t("common.cancel"),
      }))
    )
      return;
    if (scopeInvalid || busy || motionRunning) return;
    const sourceRevision = project.data_json.source_revision;
    resettingAllFlowResults = true;
    busy = true;
    updateButtons();
    let completed = 0;
    try {
      for (const [frameId, frame] of frames) {
        await refresh();
        const current = project?.data_json?.frames?.[frameId];
        if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
        if (
          project.data_json.source_revision !== sourceRevision ||
          current?.run_id !== frame.run_id ||
          current?.input_revision !== frame.input_revision
        )
          throw new Error("FRAME_SCOPE_CHANGED");
        const reset = await editFrameResult(
          frameId,
          "reset",
          null,
          null,
          null,
          { propagate: true, batch: true },
        );
        if (!reset) throw new Error("MOTION_RESULT_EDIT_UNVERIFIED");
        completed++;
        status(`${label}: ${completed}/${frames.length}`);
      }
      motionToast(`${label}: ${completed}/${frames.length}`);
    } catch (error) {
      const message = `${label}: ${completed}/${frames.length}
${motionErrorMessage(error)}`;
      status(message, { state: "failed" });
      motionToast(message, { error: true });
    } finally {
      resettingAllFlowResults = false;
      busy = false;
      settleActivity();
      updateButtons();
    }
  }
  async function pickFrameResult(frameId) {
    if (scopeInvalid || busy || motionRunning) return;
    try {
      const target = await getMotionFlowTarget();
      assertPinnedFlowTarget(target);
      const frame = project.data_json?.frames?.[frameId];
      const expected = {
        runId: frame?.run_id,
        inputRevision: frame?.input_revision,
        sourceRevision: project.data_json.source_revision,
      };
      window.imagePickerModal.open({
        expectedFlowTarget: target,
        cleanFlowRefs: false,
        mediaFilter: "video",
        flowOnly: true,
        singleSelect: true,
        maxSelections: 1,
        maxVideoSelections: 1,
        maxImageSelections: 0,
        maxTotalSelections: 1,
        refAuditContext: {
          surface: "motion_result",
          toolProjectId: projectId,
          frameId,
        },
        onConfirm: (items) => {
          if (
            !Array.isArray(items) ||
            items.length !== 1 ||
            items[0].source !== "flow" ||
            items[0].type !== "video"
          ) {
            motionToast(
              motionErrorMessage("MOTION_FLOW_MEDIA_SELECTION_INVALID"),
              { error: true },
            );
            return;
          }
          void editFrameResult(frameId, "replace", items[0], expected, target);
        },
      });
    } catch (error) {
      status(motionErrorMessage(error));
      motionToast(motionErrorMessage(error), { error: true });
    }
  }
  function createResultMenuButton(frameId, frame) {
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "motion-frame-menu-trigger motion-result-menu-trigger";
    trigger.textContent = "\u22EF";
    trigger.setAttribute("aria-label", `${frameId} \xB7 Flow result`);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (scopeInvalid) return;
      activeFrameMenu?.remove();
      const menu = document.createElement("div");
      menu.className = "motion-frame-menu";
      menu.setAttribute("role", "menu");
      const add = (label, icon, disabled, action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.disabled = disabled;
        const image =
          icon === "motion-menu-gen-icon" && motionGenerateIcon
            ? motionGenerateIcon.cloneNode(true)
            : document.createElement("span");
        image.classList.add(icon);
        image.setAttribute("aria-hidden", "true");
        button.append(image, document.createTextNode(label));
        button.addEventListener("click", () => {
          menu.remove();
          activeFrameMenu = null;
          trigger.setAttribute("aria-expanded", "false");
          action();
        });
        menu.append(button);
        return button;
      };
      const monitor = frame.stages?.monitor,
        mode = monitor?.flow_mode;
      add(
        window.I18n?.t?.("gen.generate") || "Generate",
        "motion-menu-gen-icon",
        busy || motionRunning || frame.stages?.split?.state !== "ready",
        () => openManualRunConfirmation?.(frameId),
      );
      const localResult =
        monitor?.state !== "ready" && generatedPreviewRevisions.has(frameId);
      add(
        localResult
          ? window.I18n?.t?.("common.download") || "Download"
          : motionText("text101", "T\u1EA3i t\u1EEB Flow"),
        "motion-menu-download-icon",
        busy ||
          motionRunning ||
          (!localResult &&
            (monitor?.state !== "ready" ||
              !monitor.provider_media_id ||
              !resolutions.length ||
              !["web", "api"].includes(mode) ||
              (!monitor.provider_operation_id &&
                !(mode === "web" && monitor.manual_result === true)) ||
              (mode === "api" && !monitor.api_driver))),
        () => {
          void openDirectFlowDownload(frameId).catch((error) => {
            status(motionErrorMessage(error));
            motionToast(motionErrorMessage(error), { error: true });
          });
        },
      );
      const ready = frame.stages?.split?.state === "ready";
      const reset = add(
        window.I18n?.t?.("common.reset") || "Reset",
        "motion-menu-reset-icon",
        false,
        () => {
          void editFrameResult(frameId, "reset");
        },
      );
      reset.dataset.action = "reset-result";
      add(
        motionText("replace", "Replace"),
        "motion-menu-edit-icon",
        busy || motionRunning || !ready,
        () => {
          void pickFrameResult(frameId);
        },
      );
      document.body.append(menu);
      activeFrameMenu = menu;
      trigger.setAttribute("aria-expanded", "true");
      const bounds = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, bounds.top - menu.offsetHeight - 4)}px`;
      (menu.querySelector("button:not(:disabled)") || trigger).focus();
    });
    return trigger;
  }
  function resultTimelineTile(
    frameId,
    frame,
    hasLocal,
    sourceRevision,
    renderEpoch,
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "motion-result-cell";
    wrapper.dataset.frameId = frameId;
    const tile = timelineTile(
      frameId,
      frame,
      "generated_clip",
      hasLocal,
      sourceRevision,
      renderEpoch,
    );
    wrapper.style.width = tile.style.width;
    wrapper.style.minWidth = tile.style.width;
    wrapper.disposeTimelineTile = () => tile.disposeTimelineTile?.();
    wrapper.append(tile, createResultMenuButton(frameId, frame));
    return wrapper;
  }
  function externalFlowProviderError(frameId, retry = false) {
    if (typeof externalMotionRun === "undefined") return null;
    const saved =
      typeof externalFrameProviderStates !== "undefined"
        ? externalFrameProviderStates.get(frameId)
        : null;
    const current =
      externalMotionRun?.frameId === frameId &&
      externalMotionRun.stage === "flow"
        ? externalMotionRun.apiDiagnostic
        : null;
    const diagnostic =
      saved && saved.runId === externalMotionRun?.runId
        ? saved.diagnostic
        : current;
    if (
      retry &&
      diagnostic?.phase === "provider_result" &&
      ["retry_queued", "retrying"].includes(diagnostic.eventState)
    )
      return /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(diagnostic.code || "")
        ? diagnostic.code
        : true;
    if (retry) return null;
    return diagnostic?.phase === "provider_result" &&
      diagnostic.eventState === "failed" &&
      /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(diagnostic.code || "")
      ? diagnostic.code
      : null;
  }
  function createFrameMenuButton(frameId, frame) {
    const menuButton = document.createElement("button");
    menuButton.type = "button";
    menuButton.className = "motion-frame-menu-trigger";
    menuButton.textContent = "\u22EF";
    menuButton.setAttribute("aria-label", `Thao t\xE1c ${frameId}`);
    menuButton.setAttribute("aria-haspopup", "menu");
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.disabled = !["ready", "pending"].includes(
      frame.stages?.split?.state,
    );
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (scopeInvalid) return;
      const currentFrame = project?.data_json?.frames?.[frameId];
      if (!currentFrame) return;
      frame = currentFrame;
      if (activeFrameMenu) {
        activeFrameMenu.remove();
        activeFrameMenu = null;
      }
      const menu = document.createElement("div");
      menu.className = "motion-frame-menu";
      menu.setAttribute("role", "menu");
      const createSub = document.createElement("button");
      createSub.type = "button";
      createSub.setAttribute("role", "menuitem");
      createSub.dataset.motionCreateSub = "true";
      createSub.disabled = busy || motionRunning || !isSelectedAgentReady();
      const subIcon = document.createElement("span");
      subIcon.className = "motion-menu-sub-icon";
      subIcon.setAttribute("aria-hidden", "true");
      createSub.append(
        subIcon,
        document.createTextNode(motionText("text067", "T\u1EA1o Sub")),
      );
      createSub.addEventListener("click", () => {
        menu.remove();
        activeFrameMenu = null;
        menuButton.setAttribute("aria-expanded", "false");
        openSubRunConfirmation?.(frameId);
      });
      const generate = document.createElement("button");
      generate.type = "button";
      generate.setAttribute("role", "menuitem");
      const genIcon = motionGenerateIcon?.cloneNode(true);
      if (genIcon) {
        genIcon.classList.add("motion-menu-gen-icon");
        genIcon.setAttribute("aria-hidden", "true");
        generate.append(genIcon);
      }
      generate.append(document.createTextNode("Generate"));
      generate.disabled = busy || motionRunning;
      generate.addEventListener("click", () => {
        menu.remove();
        activeFrameMenu = null;
        menuButton.setAttribute("aria-expanded", "false");
        openManualRunConfirmation?.(frameId);
      });
      const cut = document.createElement("button");
      cut.type = "button";
      cut.setAttribute("role", "menuitem");
      const cutIcon = document.createElement("span");
      cutIcon.className = "motion-menu-cut-icon";
      cutIcon.setAttribute("aria-hidden", "true");
      cut.append(
        cutIcon,
        document.createTextNode(motionText("text098", "C\u1EAFt l\u1EA1i")),
      );
      cut.disabled = busy || motionRunning;
      cut.addEventListener("click", () => {
        menu.remove();
        activeFrameMenu = null;
        menuButton.setAttribute("aria-expanded", "false");
        void recutFrame(frameId);
      });
      const upload = document.createElement("button");
      upload.type = "button";
      upload.setAttribute("role", "menuitem");
      const uploadIcon = document.createElement("span");
      uploadIcon.className = "motion-menu-upload-icon";
      uploadIcon.setAttribute("aria-hidden", "true");
      const alreadyUploaded = isSourceUploadReady(frameId, frame);
      upload.append(
        uploadIcon,
        document.createTextNode(motionText("text100", "Upload to Flow")),
      );
      upload.disabled =
        busy ||
        motionRunning ||
        project?.data_json?.requires_resplit === true ||
        ["running", "needs_review"].includes(frame.stages?.submit?.state) ||
        (frame.stages?.submit?.state === "ready" &&
          !["ready", "failed"].includes(frame.stages?.monitor?.state));
      console.info("[MotionUploadMenu]", {
        surface: "frame",
        frameId,
        disabled: upload.disabled,
        paused: project?.data_json?.paused === true,
        requiresResplit: project?.data_json?.requires_resplit === true,
        alreadyUploaded,
        splitState: frame.stages?.split?.state || null,
        submitState: frame.stages?.submit?.state || null,
        monitorState: frame.stages?.monitor?.state || null,
      });
      upload.addEventListener("click", () => {
        menu.remove();
        activeFrameMenu = null;
        menuButton.setAttribute("aria-expanded", "false");
        openUploadConfirmation?.(frameId);
      });
      menu.append(createSub, generate, cut);
      if (canUploadFrameSource(frameId)) menu.append(upload);
      let download = null;
      if (
        generatedPreviewRevisions.has(frameId) ||
        (frame.stages?.monitor?.state === "ready" &&
          frame.stages.monitor.provider_media_id)
      ) {
        download = document.createElement("button");
        download.type = "button";
        download.setAttribute("role", "menuitem");
        const icon = document.createElement("span");
        icon.className = "motion-menu-download-icon";
        icon.setAttribute("aria-hidden", "true");
        const localResult =
          frame.stages?.monitor?.state !== "ready" &&
          generatedPreviewRevisions.has(frameId);
        download.append(
          icon,
          document.createTextNode(
            localResult
              ? window.I18n?.t?.("common.download") || "Download"
              : motionText("text101", "T\u1EA3i t\u1EEB Flow"),
          ),
        );
        const monitor = frame.stages?.monitor,
          mode = monitor?.flow_mode;
        download.disabled =
          busy ||
          motionRunning ||
          (!localResult &&
            (!resolutions.length ||
              !["web", "api"].includes(mode) ||
              (!monitor.provider_operation_id &&
                !(mode === "web" && monitor.manual_result === true)) ||
              (mode === "api" && !monitor.api_driver)));
        download.addEventListener("click", () => {
          menu.remove();
          activeFrameMenu = null;
          menuButton.setAttribute("aria-expanded", "false");
          void openDirectFlowDownload(frameId).catch((error) =>
            status(motionErrorMessage(error)),
          );
        });
        menu.append(download);
      }
      menu.refreshState = () => {
        const current = project?.data_json?.frames?.[frameId];
        const blocked =
          scopeInvalid ||
          busy ||
          motionRunning ||
          !current ||
          !["ready", "pending"].includes(current.stages?.split?.state);
        menuButton.disabled =
          scopeInvalid ||
          !["ready", "pending"].includes(current?.stages?.split?.state);
        createSub.disabled = blocked || !isSelectedAgentReady();
        generate.disabled = cut.disabled = blocked;
        const submit = current?.stages?.submit,
          monitor = current?.stages?.monitor;
        upload.disabled =
          blocked ||
          !canUploadFrameSource(frameId) ||
          project?.data_json?.requires_resplit === true ||
          ["running", "needs_review"].includes(submit?.state) ||
          (submit?.state === "ready" &&
            !["ready", "failed"].includes(monitor?.state));
        if (download) {
          const localResult =
            monitor?.state !== "ready" &&
            generatedPreviewRevisions.has(frameId);
          download.disabled =
            blocked ||
            (!localResult &&
              (monitor?.state !== "ready" ||
                !monitor.provider_media_id ||
                !resolutions.length ||
                !["web", "api"].includes(monitor.flow_mode) ||
                (!monitor.provider_operation_id &&
                  !(
                    monitor.flow_mode === "web" &&
                    monitor.manual_result === true
                  )) ||
                (monitor.flow_mode === "api" && !monitor.api_driver)));
        }
      };
      menu.refreshState();
      document.body.append(menu);
      activeFrameMenu = menu;
      void refreshAgentStatus();
      menuButton.setAttribute("aria-expanded", "true");
      const bounds = menuButton.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(bounds.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, bounds.top - menu.offsetHeight - 4)}px`;
      (menu.querySelector("button:not(:disabled)") || menuButton).focus();
    });
    return menuButton;
  }
  async function refresh({
    canApply = null,
    applyTemplateSettings = false,
    preserveMotionSettings = false,
  } = {}) {
    const previousSourceRevision = Number(
      project?.data_json?.source_revision || 0,
    );
    const fetched = await api("GET", endpoint);
    if (canApply && !canApply()) return false;
    const olderReply =
      canApply &&
      Number.isSafeInteger(Number(project?.revision)) &&
      Number.isSafeInteger(Number(fetched?.revision)) &&
      Number(fetched.revision) < Number(project.revision);
    if (!olderReply) project = fetched;
    if (!project || project.tool_project_id !== projectId)
      throw new Error("PROJECT_SCOPE_MISMATCH");
    if (
      Object.values(project.data_json?.frames || {}).some(
        (frame) => frame.source_edit,
      )
    )
      await MotionArtifactStore.syncFlowSources({ userId, project });
    if (
      previousSourceRevision &&
      previousSourceRevision !== Number(project.data_json?.source_revision || 0)
    ) {
      closePreview();
      closeFrameDialog();
    }
    $("projectName").textContent = project.name;
    document.title = `${project.name} \xB7 Motion Studio`;
    renderProjectFlowMode();
    MotionTemplateLibrary.guidance(
      $("motionTemplateGuide"),
      project.data_json?.motion_template,
    );
    const stepFrames = Object.values(project.data_json?.frames || {});
    const currentStep = !stepFrames.length
      ? 0
      : stepFrames.every((frame) => frame.stages?.persist?.state === "ready")
        ? 2
        : 1;
    document.querySelectorAll(".studio-steps .step").forEach((step, index) => {
      step.classList.toggle("is-current", index === currentStep);
      const completed =
        index === 0
          ? stepFrames.length > 0 &&
            stepFrames.every((frame) => frame.stages?.split?.state === "ready")
          : index === 1
            ? stepFrames.length > 0 &&
              stepFrames.every(
                (frame) => frame.stages?.persist?.state === "ready",
              )
            : false;
      step.classList.toggle("is-complete", completed && index !== currentStep);
      if (index === currentStep) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
    const preferences = project.data_json?.preferences || {};
    if (!preserveMotionSettings) {
      references = project.data_json?.references || {
        mode: "character_only",
        character: [],
        background: [],
      };
      $("referenceMode").value = references.mode || "character_only";
      $("characterCount").value = String(preferences.character_count ?? 1);
      $("continuityEnabled").checked = preferences.continuity_enabled === true;
      renderFlowModels({ preservePending: !applyTemplateSettings });
      renderReferences();
      $("autoDownloadFinal").checked = preferences.auto_download_final === true;
      $("useOriginalAudio").checked = preferences.use_original_audio === true;
      $("continuityEnabled").checked = preferences.continuity_enabled === true;
      $("removeFinalVideoWatermark").checked =
        typeof preferences.remove_final_video_watermark === "boolean"
          ? preferences.remove_final_video_watermark
          : [true, 1, "1"].includes(
              window.storageSettings.getSettings()?.autoRemoveWatermarkVideo,
            );
      $("voiceEnabled").checked = preferences.voice_enabled === true;
      $("motionVoiceMode").value = ["lip_sync", "narration"].includes(
        preferences.voice_mode,
      )
        ? preferences.voice_mode
        : "character";
      $("subtitleEnabled").checked = preferences.subtitle_enabled === true;
      $("reviewSubtitle").checked = preferences.review_subtitle === true;
      $("translateEnabled").checked = preferences.translate_enabled === true;
      $("targetLanguage").value = preferences.target_language || "";
      if ($("targetLanguageTrigger"))
        $("targetLanguageTrigger").textContent =
          $("targetLanguage").value ||
          motionText("text107", "Gi\u1EEF ng\xF4n ng\u1EEF g\u1ED1c");
      if (
        applyTemplateSettings ||
        (!voiceDescriptionDirty &&
          document.activeElement !== $("voiceDescription"))
      )
        $("voiceDescription").value = preferences.voice_description || "";
      if (
        applyTemplateSettings ||
        (!settingsDirty && document.activeElement !== $("motionCustomPrompt"))
      )
        $("motionCustomPrompt").value = preferences.custom_prompt || "";
      $("motionVoiceSlug").value = preferences.voice_slug || "";
      voicePicker?.setSelected(preferences.voice_slug || "");
      if (ratios.includes(preferences.ratio))
        $("motionRatio").value = preferences.ratio;
      $("transcriptionAgent").value =
        preferences.transcription_provider ||
        profile?.settings?.transcription_provider ||
        "";
    }
    updateMotionVisibility();
    const paused = project.data_json?.paused === true;
    $("pauseBtn").textContent = paused
      ? motionText("text078", "Ti\u1EBFp t\u1EE5c")
      : motionText("text039", "T\u1EA1m d\u1EEBng");
    $("pauseBtn").disabled = scopeInvalid || busy;
    try {
      const usage = await MotionArtifactStore.usage(userId, projectId);
      $("usage").textContent =
        `${formatBytes(usage.bytes)} \xB7 ${usage.artifacts} files`;
      const estimate = await navigator.storage?.estimate?.();
      const quota = Number(estimate?.quota || 0);
      $("usageFill").style.width =
        quota > 0 ? `${Math.min(100, (usage.bytes / quota) * 100)}%` : "0%";
    } catch (error) {
      $("usage").textContent = "\u2014";
      $("usageFill").style.width = "0%";
    }
    const local = await MotionArtifactStore.listProject(userId, projectId);
    const sourceRevision = Number(project.data_json?.source_revision || 0);
    const localClips = new Set(
      local
        .filter(
          (item) =>
            item.sourceRevision === sourceRevision &&
            item.kind === "source_clip",
        )
        .map((item) => item.frameId),
    );
    sourceUploadReceipts = new Map(
      local
        .filter(
          (item) =>
            item.sourceRevision === sourceRevision &&
            item.kind === "source_clip" &&
            item.uploadReceipt?.projectId === project.flow_project_id,
        )
        .map((item) => [item.frameId, item.uploadReceipt]),
    );
    sourceBlobFrameIds = new Set(
      local
        .filter(
          (item) =>
            item.sourceRevision === sourceRevision &&
            item.kind === "source_clip" &&
            MotionArtifactStore.hasLocalBytes(item),
        )
        .map((item) => item.frameId),
    );
    const generatedRecords = local.filter(
      (item) =>
        item.sourceRevision === sourceRevision &&
        item.kind === "generated_clip",
    );
    const frames = project.data_json?.frames || {};
    generatedPreviewRevisions = new Map();
    for (const item of generatedRecords) {
      const frame = frames[item.frameId];
      const currentRevision = Number(frame?.input_revision || 0);
      if (
        !frame ||
        item.artifactRevision > currentRevision ||
        (item.artifactRevision === currentRevision &&
          frame.stages?.persist?.state !== "ready")
      )
        continue;
      if (
        frame.source_edit &&
        item.artifactRevision <= Number(frame.source_edit.input_revision)
      )
        continue;
      if (
        item.artifactRevision >
        (generatedPreviewRevisions.get(item.frameId) || 0)
      ) {
        generatedPreviewRevisions.set(item.frameId, item.artifactRevision);
      }
    }
    const generatedClips = new Set(generatedPreviewRevisions.keys());
    generatedFrameIds = generatedClips;
    audioFrameIds = new Set(
      local
        .filter(
          (item) =>
            item.sourceRevision === sourceRevision &&
            item.kind === "source_audio",
        )
        .map((item) => item.frameId),
    );
    const entries = Object.entries(frames).sort(
      (a, b) => a[1].start - b[1].start,
    );
    const mediaSources = {
      sourceRevision,
      frames: entries.slice(0, 16).map(([frameId]) => {
        const clip = local.find(
          (item) =>
            item.sourceRevision === sourceRevision &&
            item.frameId === frameId &&
            item.kind === "source_clip",
        );
        return {
          frameId,
          sourceClip: MotionArtifactStore.hasLocalBytes(clip),
          sourceReceipt: !!clip?.uploadReceipt,
          sourceUuid: !!clip?.uploadReceipt?.mediaUuid,
          sourcePoster: local.some(
            (item) =>
              item.sourceRevision === sourceRevision &&
              item.frameId === frameId &&
              item.kind === "poster" &&
              MotionArtifactStore.hasLocalBytes(item),
          ),
          generatedClip: generatedClips.has(frameId),
        };
      }),
      omitted: Math.max(0, entries.length - 16),
    };
    const mediaSourcesKey = JSON.stringify(mediaSources);
    if (refresh._mediaSourcesKey !== mediaSourcesKey) {
      refresh._mediaSourcesKey = mediaSourcesKey;
      console.info("[MotionMediaSources]", mediaSourcesKey);
    }
    canMerge =
      project.data_json?.requires_resplit !== true &&
      entries.some(
        ([frameId, frame]) =>
          generatedRecords.some(
            (item) =>
              item.frameId === frameId &&
              item.artifactRevision === Number(frame.input_revision),
          ) && frame.stages?.persist?.state === "ready",
      );
    const final = project.data_json?.final;
    finalArtifact =
      final &&
      Number(final.source_revision) === sourceRevision &&
      (final.use_original_audio === true) ===
        (preferences.use_original_audio === true) &&
      local.some(
        (item) =>
          item.sourceRevision === sourceRevision &&
          item.kind === "merged_video" &&
          item.artifactRevision === Number(final.artifact_revision),
      )
        ? final
        : null;
    renderFinalSpeedHint(local, sourceRevision);
    $("finalState").textContent = finalArtifact
      ? `${Number(final.duration).toFixed(2)}s \xB7 ${motionText("savedLocally", "Saved locally")}`
      : final
        ? motionText(
            "text164",
            "Thi\u1EBFu video ho\xE0n ch\u1EC9nh tr\xEAn thi\u1EBFt b\u1ECB n\xE0y",
          )
        : motionText("text106", "Ch\u01B0a c\xF3 video ho\xE0n ch\u1EC9nh");
    const source = project.data_json?.source;
    if (pendingSourceFile)
      renderSourceMeta(
        pendingSourceFile.name,
        null,
        sourcePlaybackRates.get(pendingSourceFile),
        { pending: true },
      );
    else if (source)
      renderSourceMeta(
        source.file_name || motionText("text239", "Video ngu\u1ED3n"),
        Number(source.duration || 0),
        local.find(
          (item) =>
            item.kind === "source_video" &&
            item.sourceRevision === sourceRevision,
        )?.playbackRate,
      );
    else {
      $("sourceMeta").textContent = motionText(
        "text041",
        "Ch\u01B0a ch\u1ECDn video",
      );
      $("sourceMeta").removeAttribute("title");
    }
    $("frameCount").textContent = `${entries.length} frame`;
    syncMotionCompletionDisplay();
    const structureKey = JSON.stringify([
      sourceRevision,
      entries.map(([id, frame]) => [id, frame.start, frame.end]),
    ]);
    if (timelineStructureKey !== structureKey) {
      timelineStructureKey = structureKey;
      timelineRenderEpoch++;
      for (const track of [
        "timelineRuler",
        "sourceTrack",
        "resultTrack",
        "subtitleTrack",
        "audioTrack",
      ]) {
        for (const child of $(track).children) child.disposeTimelineTile?.();
        $(track).replaceChildren();
      }
      for (const url of timelineThumbUrls) URL.revokeObjectURL(url);
      timelineThumbUrls.clear();
    }
    if (!entries.length && !$("sourceTrack").firstChild) {
      const empty = document.createElement("p");
      empty.className = "timeline-empty";
      empty.textContent = motionText(
        "text194",
        "C\u1EAFt video ngu\u1ED3n \u0111\u1EC3 t\u1EA1o timeline frame.",
      );
      $("sourceTrack").append(empty);
    }
    const renderEpoch = timelineRenderEpoch;
    const artifactKeys = new Map();
    for (const item of local) {
      if (item.sourceRevision !== sourceRevision) continue;
      const key = JSON.stringify([item.frameId, item.kind]);
      if (!artifactKeys.has(key)) artifactKeys.set(key, []);
      artifactKeys
        .get(key)
        .push([item.artifactRevision, item.createdAt, item.size, item.hash]);
    }
    const artifactKey = (frameId, kind) =>
      artifactKeys.get(JSON.stringify([frameId, kind])) || null;
    const updateTile = (trackId, index, key, create) => {
      const track = $(trackId),
        previous = track.children[index];
      if (previous?.dataset.timelineKey === key) return;
      const next = create();
      next.dataset.timelineKey = key;
      const previousTimer = previous?.querySelector(".motion-frame-timer");
      const nextTimer = next.querySelector(".motion-frame-timer");
      if (
        previousTimer &&
        nextTimer &&
        previousTimer.dataset.activityKey === nextTimer.dataset.activityKey &&
        Number(previousTimer.dataset.startedAt) > 0
      ) {
        nextTimer.dataset.startedAt = String(
          Math.min(
            Number(previousTimer.dataset.startedAt),
            Number(nextTimer.dataset.startedAt),
          ),
        );
        nextTimer.textContent = formatElapsed(
          Date.now() - Number(nextTimer.dataset.startedAt),
        );
      }
      if (previous) {
        previous.disposeTimelineTile?.();
        previous.replaceWith(next);
      } else track.append(next);
    };
    for (const [index, [frameId, frame]] of entries.entries()) {
      updateTile(
        "timelineRuler",
        index,
        JSON.stringify([frameId, frame.start, frame.end]),
        () => {
          const mark = document.createElement("span");
          mark.className = "ruler-mark";
          mark.textContent = `${Number(frame.start).toFixed(1)}s`;
          mark.style.width = `${timelineWidth(frame) + 10}px`;
          mark.append(createFrameMenuButton(frameId, frame));
          return mark;
        },
      );
      $("timelineRuler").children[index].querySelector(
        ".motion-frame-menu-trigger",
      ).disabled =
        scopeInvalid ||
        !["ready", "pending"].includes(frame.stages?.split?.state);
      updateTile(
        "sourceTrack",
        index,
        JSON.stringify([
          frame.start,
          frame.end,
          frame.source_edit,
          frame.stages?.split?.state,
          frame.stages?.upload?.state,
          frame.stages?.upload?.error_code,
          localClips.has(frameId),
          hasUploadedSourceUuid(frameId),
          activeUploadFrameId === frameId,
          window.MotionFlowUpload?.activeSourceUploads?.has(frameId) === true,
          artifactKey(frameId, "source_clip"),
          artifactKey(frameId, "poster"),
        ]),
        () =>
          sourceTimelineTile(
            frameId,
            frame,
            localClips.has(frameId),
            sourceRevision,
            renderEpoch,
          ),
      );
      const resultKey = [
        frame.run_id,
        frame.input_revision,
        frame.start,
        frame.end,
        frame.result_edit,
        frame.previous_result,
        frame.stages?.split?.state,
        frame.stages?.split?.error_code,
        ["failed", "needs_review"].includes(frame.stages?.upload?.state)
          ? [frame.stages.upload.state, frame.stages.upload.error_code]
          : null,
        ...["continuity", "submit", "monitor", "persist"].map(
          (stage) => frame.stages?.[stage],
        ),
      ];
      updateTile(
        "resultTrack",
        index,
        JSON.stringify([
          resultKey,
          generatedClips.has(frameId),
          artifactKey(frameId, "generated_clip"),
          externalFlowProviderError(frameId),
          externalFlowProviderError(frameId, true),
          localMotionProviderPause?.frameId === frameId
            ? localMotionProviderPause.error
            : null,
          externalMotionRun?.state === "paused" &&
          externalMotionRun.frameId === frameId
            ? [externalMotionRun.pauseReason, externalMotionRun.error]
            : null,
          activeMotionFrameId === frameId && activeFlowStartedAt > 0,
          activeUploadFrameId === frameId,
          motionRunning &&
            activeMotionFrameId === frameId &&
            activeMotionStage === "download",
          activeResultEditFrameId === frameId,
        ]),
        () =>
          resultTimelineTile(
            frameId,
            frame,
            generatedClips.has(frameId),
            sourceRevision,
            renderEpoch,
          ),
      );
      updateTile(
        "subtitleTrack",
        index,
        JSON.stringify([
          frame.transcript,
          frame.stages?.transcribe,
          (activeMotionFrameId === frameId &&
            activeMotionStage === "transcribe") ||
            batchSubFrameIds.has(frameId),
        ]),
        () => {
          const sub = document.createElement("button");
          sub.type = "button";
          const localTranscribing =
            (activeMotionFrameId === frameId &&
              activeMotionStage === "transcribe") ||
            batchSubFrameIds.has(frameId);
          const display = motionTranscriptState(frame, localTranscribing);
          const transcribing = display.state === "running";
          sub.className = `timeline-clip subtitle ${transcribing ? "is-transcribing" : display.state === "failed" ? "is-failed" : frame.transcript ? "is-ready" : "empty"}`;
          const text = frame.transcript?.has_speech
            ? frame.transcript.text
            : frame.transcript
              ? motionText("text090", "Kh\xF4ng c\xF3 l\u1EDDi n\xF3i")
              : motionText("text091", "Ch\u01B0a l\u1EA5y l\u1EDDi tho\u1EA1i");
          if (transcribing || display.state === "failed" || frame.transcript) {
            const indicator = document.createElement("span");
            indicator.className = transcribing
              ? "motion-sub-status-spinner"
              : "motion-sub-status-dot";
            indicator.setAttribute("aria-hidden", "true");
            sub.append(indicator);
          }
          const retryKey = "flowStatus.retrying";
          const retryText = window.I18n?.t?.(retryKey);
          const working =
            display.retryCount > 0
              ? `${(retryText && retryText !== retryKey ? retryText : "Retrying").replace(/[.…]+$/, "")}... \xB7 ${display.retryCount}`
              : motionText(
                  "text092",
                  "\u0110ang l\u1EA5y l\u1EDDi tho\u1EA1i...",
                );
          const failed = motionText(
            "transcriptFailed",
            "L\u1ED7i t\u1EA1o sub, h\xE3y th\u1EED l\u1EA1i",
          );
          const subText = document.createElement("span");
          subText.className = "motion-sub-copy";
          const subLabel = document.createElement("span");
          subLabel.className = "motion-sub-label";
          subLabel.textContent = transcribing
            ? working
            : display.state === "failed"
              ? failed
              : text ||
                motionText("text091", "Ch\u01B0a l\u1EA5y l\u1EDDi tho\u1EA1i");
          subText.append(subLabel);
          if (
            display.state === "failed" &&
            /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(
              String(display.errorCode || ""),
            )
          ) {
            const errorCode = document.createElement("small");
            errorCode.className = "motion-sub-error-code";
            errorCode.textContent = display.errorCode;
            subText.append(errorCode);
          }
          sub.append(subText);
          sub.style.width = `${timelineWidth(frame)}px`;
          sub.style.minWidth = sub.style.width;
          sub.title =
            display.state === "failed"
              ? [failed, display.errorCode].filter(Boolean).join(" \xB7 ")
              : motionText(
                  "text154",
                  "M\u1EDF l\u1EDDi tho\u1EA1i v\xE0 ch\u1EC9nh s\u1EEDa",
                );
          sub.addEventListener("click", async () => {
            await openFrameDialog(frameId, "source_clip");
            $("frameTranscriptPanel").scrollIntoView?.({
              behavior: "smooth",
              block: "center",
            });
            $("frameTranscriptInput").focus();
          });
          const wrap = document.createElement("div");
          wrap.className = `motion-track-retry-cell${display.state === "failed" ? " motion-sub-failed-tile is-failed" : transcribing ? " is-transcribing" : ""}`;
          wrap.style.width = `${timelineWidth(frame)}px`;
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "motion-ref-rescan motion-sub-retry";
          retry.title = motionText("text067", "T\u1EA1o Sub");
          retry.setAttribute("aria-label", `${retry.title} \xB7 ${frameId}`);
          retry.disabled = transcribing || !canGetFrameSub(frame);
          retry.addEventListener("click", (event) => {
            event.stopPropagation();
            openSubRunConfirmation?.(frameId);
          });
          wrap.append(sub, retry);
          return wrap;
        },
      );
      updateTile(
        "audioTrack",
        index,
        JSON.stringify([
          frameId,
          frame.start,
          frame.end,
          audioFrameIds.has(frameId),
          artifactKey(frameId, "source_audio"),
        ]),
        () => {
          const audio = document.createElement("button");
          audio.type = "button";
          audio.className = `timeline-clip subtitle audio-clip ${audioFrameIds.has(frameId) ? "is-ready" : "empty"}`;
          renderAudioTile(
            audio,
            frameId,
            audioFrameIds.has(frameId),
            sourceRevision,
          );
          audio.style.width = `${timelineWidth(frame)}px`;
          audio.style.minWidth = audio.style.width;
          audio.disabled = !audioFrameIds.has(frameId);
          audio.addEventListener("click", async () => {
            await openFrameDialog(frameId, "source_clip");
            if (!$("frameDialogAudio").hidden)
              await $("frameDialogAudio")
                .play()
                .catch(() => {});
          });
          const wrap = document.createElement("div");
          wrap.className = "motion-track-retry-cell";
          wrap.style.width = `${timelineWidth(frame)}px`;
          const retry = document.createElement("button");
          retry.type = "button";
          retry.className = "motion-ref-rescan motion-audio-retry";
          retry.title = `${window.I18n?.t?.("common.retry") || "Retry"} \xB7 Audio`;
          retry.setAttribute("aria-label", `${retry.title} \xB7 ${frameId}`);
          retry.disabled = !canGetFrameSub(frame);
          retry.addEventListener("click", (event) => {
            event.stopPropagation();
            void regenerateAllFrameAudio(frameId);
          });
          wrap.append(audio, retry);
          return wrap;
        },
      );
      const subRetry =
        $("subtitleTrack").children[index]?.querySelector(".motion-sub-retry");
      if (subRetry)
        subRetry.disabled =
          !canGetFrameSub(frame) ||
          motionTranscriptState(
            frame,
            (activeMotionFrameId === frameId &&
              activeMotionStage === "transcribe") ||
              batchSubFrameIds.has(frameId),
          ).state === "running";
      const audioRetry = $("audioTrack").children[index]?.querySelector(
        ".motion-audio-retry",
      );
      if (audioRetry) audioRetry.disabled = !canGetFrameSub(frame);
    }
    if (selectedFrameId && $("frameDialog").open)
      renderFrameDialogStatus(selectedFrameId);
    await refreshStageVideos(sourceRevision, finalArtifact);
    settleActivity();
    updateButtons();
    return true;
  }
  async function cleanupOldRevisions() {
    const current = Number(project?.data_json?.source_revision || 0);
    if (current < 1 || !navigator.locks?.request) return;
    let removed = false;
    await navigator.locks.request(
      `motion:${userId}:${projectId}`,
      { ifAvailable: true },
      async (lock) => {
        if (!lock || scopeInvalid) return;
        if (project?.data_json?.frames_cleared === true) {
          await MotionArtifactStore.deleteFrameArtifacts(userId, projectId);
          removed = true;
        }
        const records = await MotionArtifactStore.listProject(
          userId,
          projectId,
        );
        const revisions = new Set(
          records
            .map((item) => item.sourceRevision)
            .filter(
              (revision) =>
                Number.isSafeInteger(revision) &&
                revision > 0 &&
                revision < current,
            ),
        );
        for (const revision of revisions) {
          await MotionArtifactStore.deleteSourceRevision(
            userId,
            projectId,
            revision,
          );
          removed = true;
        }
      },
    );
    if (removed) await refresh();
  }
  async function reconcileUploadedSources() {
    if (scopeInvalid || busy || motionRunning || !navigator.locks?.request)
      return;
    const expectedUserId = userId,
      sourceRevision = Number(project?.data_json?.source_revision);
    const target = await getMotionFlowTarget();
    assertPinnedFlowTarget(target);
    const records = await MotionArtifactStore.listProject(userId, projectId);
    let changed = false;
    for (const item of records) {
      if (item.kind !== "source_clip" || item.sourceRevision !== sourceRevision)
        continue;
      const frame = project.data_json?.frames?.[item.frameId],
        stage = frame?.stages?.upload;
      if (
        stage?.state !== "ready" ||
        stage.provider_media_id !== item.uploadReceipt?.mediaId ||
        item.uploadReceipt?.projectId !== target.projectId ||
        stage.flow_mode !== item.uploadReceipt?.mode
      )
        continue;
      const frameRunId = frame.run_id,
        inputRevision = frame.input_revision;
      const current = () =>
        !scopeInvalid &&
        userId === expectedUserId &&
        !busy &&
        !motionRunning &&
        Number(project?.data_json?.source_revision) === sourceRevision &&
        project.data_json?.frames?.[item.frameId]?.run_id === frameRunId &&
        project.data_json.frames[item.frameId].input_revision === inputRevision;
      if (!current()) break;
      try {
        const scope = {
          userId,
          toolProjectId: projectId,
          sourceRevision,
          frameId: item.frameId,
        };
        const record = await MotionArtifactStore.get({
          ...scope,
          kind: "source_clip",
        });
        if (!record?.uploadReceipt || !current()) continue;
        const receipt = await correctUploadedSourceReceipt(record, target, {
          persist: false,
        }).catch(() => record.uploadReceipt);
        if (!current()) continue;
        let poster = null,
          playable = false;
        if (
          record.blob &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(
            String(receipt.mediaUuid || ""),
          )
        ) {
          playable = !!(await resolveUploadedSource(
            { ...record, uploadReceipt: receipt },
            { persistReceipt: false, correctReceipt: false },
          ));
          if (!current()) continue;
          if (
            playable &&
            !(await MotionArtifactStore.get({ ...scope, kind: "poster" }))?.blob
          )
            poster = await saveSourcePoster(
              record.blob,
              sourceRevision,
              item.frameId,
              { persist: false },
            );
        }
        if (!current()) continue;
        await navigator.locks.request(
          `motion-run:${userId}:${projectId}`,
          { ifAvailable: true },
          async (runLock) => {
            if (!runLock || !current()) return;
            await navigator.locks.request(
              `motion:${userId}:${projectId}`,
              { ifAvailable: true },
              async (lock) => {
                if (!lock || !current()) return;
                const saved = await MotionArtifactStore.get({
                  ...scope,
                  kind: "source_clip",
                });
                if (
                  !current() ||
                  saved?.uploadReceipt?.mediaId !==
                    record.uploadReceipt.mediaId ||
                  saved.uploadReceipt.projectId !== target.projectId ||
                  saved.uploadReceipt.mode !== receipt.mode
                )
                  return;
                if (
                  receipt.mediaUuid !== saved.uploadReceipt.mediaUuid ||
                  receipt.persistentMediaId !==
                    saved.uploadReceipt.persistentMediaId
                ) {
                  await MotionArtifactStore.setUploadReceipt({
                    ...scope,
                    receipt,
                  });
                  changed = true;
                }
                if (!current()) return;
                if (poster)
                  await MotionArtifactStore.put({
                    ...scope,
                    flowProjectId: target.projectId,
                    kind: "poster",
                    blob: poster,
                  });
                if (playable && current()) {
                  await MotionArtifactStore.clearUploadedSourceBlob({
                    ...scope,
                    mediaId: receipt.mediaId,
                    projectId: target.projectId,
                  });
                  changed = true;
                }
              },
            );
          },
        );
      } catch (error) {
        console.warn("[Motion] Source reconciliation failed", {
          frameId: item.frameId,
          sourceRevision,
          code: error?.code || error?.message,
        });
      }
    }
    if (changed && !scopeInvalid && !busy && !motionRunning) await refresh();
  }
  function cancelMotionTask() {
    if (scopeInvalid) return;
    settleActivity(true);
    if (externalMotionRun && motionRunning) {
      const runId2 = externalMotionRun.runId;
      console.info(
        "[MotionControl]",
        JSON.stringify({ action: "stop", stage: "requested", runId: runId2 }),
      );
      const key = "uploadControls.cancelling",
        label = window.I18n?.t?.(key);
      status(label && label !== key ? label : "Cancelling\u2026", {
        state: "paused",
      });
      externalUploadToolbar?.update({
        completed: externalUploadCompleted,
        total:
          externalUploadTotal ||
          Object.keys(project.data_json?.frames || {}).length,
        cancelled: true,
      });
      void chrome.runtime
        .sendMessage({
          action: "motionRunner:stop",
          projectId,
          flowProjectId: project?.flow_project_id,
          runId: runId2,
        })
        .then((response) => {
          console.info(
            "[MotionControl]",
            JSON.stringify({
              action: "stop",
              stage: "acknowledged",
              success: response?.success === true,
            }),
          );
          if (!response?.success)
            throw new Error(response?.error || "MOTION_RUN_FAILED");
          if (externalMotionRun?.runId === runId2 && motionRunning) {
            externalMotionRun = { ...externalMotionRun, state: "pausing" };
            updateButtons();
          }
        })
        .catch((error) => status(motionErrorMessage(error)));
      return;
    }
    if (busy || motionRunning) {
      for (const control of window.MessageBridge?._uploadControls || []) {
        const scope = control.motionScope;
        if (scope?.userId === userId && scope.toolProjectId === projectId)
          control.cancel();
      }
    }
    if (motionRunning) {
      cancelled = true;
      motionQueuePauseRequested = true;
      for (const control of sendMotionTranscriptWithRetry.cancellations?.values() ||
        [])
        control.cancel();
      const queue = window.PromptQueue?.getInstance();
      const stopping = motionQueueJobId
        ? queue.stopJobAndPersist(motionQueueJobId, {
            stopOrigin: "user",
            stopReason: "USER_CANCELLED",
            stopSource: "MOTION_FORCE_STOP",
          })
        : Promise.resolve();
      void stopping
        .then(() => setPaused(true))
        .catch((error) => status(motionErrorMessage(error)));
      return;
    }
    if (!busy) return;
    cancelled = true;
    cancelSplit?.();
    status(
      motionText(
        "text232",
        "\u0110\xE3 h\u1EE7y. \u0110ang d\u1ECDn artifact t\u1EA1m...",
      ),
      { state: "paused" },
    );
  }
  function renderExternalUploadToolbar(value) {
    if (externalUploadToolbarRun !== value.runId) {
      externalUploadToolbarRun = value.runId;
      externalUploadFrames.clear();
      externalUploadCompleted = 0;
      externalUploadTotal = 0;
    }
    if (value.stage === "upload" && value.frameId) {
      if (["running", "retrying", "preparing"].includes(value.detail))
        externalUploadFrames.add(value.frameId);
      else if (["ready", "failed", "needs_review"].includes(value.detail))
        externalUploadFrames.delete(value.frameId);
      if (Number.isSafeInteger(value.completedCount))
        externalUploadCompleted = value.completedCount;
      if (Number.isSafeInteger(value.totalCount))
        externalUploadTotal = value.totalCount;
    }
    if (!motionRunning) externalUploadFrames.clear();
    if (!externalUploadFrames.size) {
      externalUploadToolbar?.remove();
      externalUploadToolbar = null;
      return;
    }
    if (!externalUploadToolbar) {
      externalUploadToolbar = MessageBridge.createUploadControlPanel({
        id: "motionRunnerUploadControls",
        onPause: () =>
          void setPaused(
            !(project?.data_json?.paused === true || localMotionProviderPause),
          ),
        onCancel: cancelMotionTask,
      });
    }
    externalUploadToolbar.update({
      completed: externalUploadCompleted,
      total:
        externalUploadTotal ||
        Object.keys(project.data_json?.frames || {}).length,
      pauseDisabled: value.state === "pausing",
      paused: project?.data_json?.paused === true,
    });
  }
  function renderExternalFinalization(value) {
    const loading = $("resultMergeLoading");
    if (!loading || busy) return;
    const operation =
      value.apiDiagnostic?.phase === "final"
        ? value.apiDiagnostic.operation
        : null;
    const videoStep = [
      "project_read",
      "merge_submit",
      "original_audio",
      "measure_duration",
      "merge",
      "artifact_stage",
      "artifact_promote",
      "finalize_checkpoint",
      "artifact_finish",
      "merge_settle",
    ].includes(operation);
    const finalizing =
      motionRunning &&
      value.stage === "final" &&
      value.detail !== "failed" &&
      !value.error &&
      (videoStep || !loading.hidden);
    if (finalizing && loading.hidden) $("resultStageVideo")?.pause();
    loading.hidden = !finalizing;
    if (finalizing) {
      const label = motionText("text178", "\u0110ang gh\xE9p video...");
      if ($("status")?.textContent !== label)
        status(label, { state: "running" });
    }
  }
  async function acceptExternalMotionStatus(value, { notify = true } = {}) {
    if (
      !value ||
      Number(value.userId) !== userId ||
      value.projectId !== projectId ||
      typeof value.runId !== "string" ||
      !Number.isSafeInteger(value.epoch) ||
      (externalMotionRun?.runId && externalMotionRun.runId !== value.runId) ||
      (value.flowProjectId &&
        value.flowProjectId !== project?.flow_project_id) ||
      (motionRunning && !externalMotionRun)
    )
      return;
    const reportStatus = (message, options) =>
      status(message, { ...options, notify });
    if (
      !scopeInvalid &&
      !motionRunning &&
      value &&
      project &&
      window.MotionFrameResultActions
    ) {
      for (const [frameId, frame] of Object.entries(
        project.data_json?.frames || {},
      )) {
        if (
          !frame.result_edit ||
          frame.result_edit.input_revision + 1 !== frame.input_revision ||
          frame.result_edit.run_id === frame.run_id ||
          frame.stages?.submit
        )
          continue;
        const next = window.MotionFrameResultActions.withoutFrameFailure(
          value,
          {
            userId,
            toolProjectId: projectId,
            sourceRevision: Number(project.data_json.source_revision),
            frameId,
          },
        );
        if (!next) {
          externalMotionRun = null;
          lastExternalMotionFailure = null;
          const stage = frameStage(frame, { resultOnly: true });
          reportStatus(stage.label, { state: stage.state });
          return;
        }
        value = next;
      }
    }
    if (
      !scopeInvalid &&
      !busy &&
      !motionRunning &&
      Number(value.sourceRevision) ===
        Number(project?.data_json?.source_revision) &&
      ["ready", "failed", "paused", "stopped", "needs_review"].includes(
        value.state,
      ) &&
      Number.isSafeInteger(value.elapsedMs) &&
      value.elapsedMs >= 0 &&
      $("motionTimer")
    ) {
      $("motionTimer").dataset.elapsedMs = String(value.elapsedMs);
      activityStartedAt = null;
      tickActivity();
      if (value.timerReset === true) $("motionTimer").dataset.reset = "true";
    }
    const ticket = ++externalMotionStatusTicket;
    try {
      const host = (
        await chrome.storage.session.get("tobyflow_motion_runner_host")
      )?.tobyflow_motion_runner_host;
      if (ticket !== externalMotionStatusTicket || scopeInvalid) return;
      const lost = () => {
        if (!["preparing", "running", "pausing"].includes(value.state)) return;
        externalMotionRun = {
          ...value,
          state: "needs_review",
          error: "MOTION_RUNNER_HOST_CLOSED",
        };
        motionRunning = false;
        renderExternalFinalization(externalMotionRun);
        settleActivity();
        reportStatus("MOTION_RUNNER_HOST_CLOSED");
        updateButtons();
        renderExternalUploadToolbar({ ...value, state: "needs_review" });
      };
      const terminalSnapshot =
        [
          "ready",
          "failed",
          "paused",
          "stopped",
          "cancelled",
          "needs_review",
        ].includes(value.state) &&
        !busy &&
        Number(value.sourceRevision) ===
          Number(project?.data_json?.source_revision) &&
        (!value.flowProjectId ||
          value.flowProjectId === project?.flow_project_id) &&
        (!externalMotionRun || externalMotionRun.epoch === value.epoch);
      if (!host) {
        if (!terminalSnapshot) {
          lost();
          return;
        }
      } else {
        if (host.userId !== userId || !Number.isInteger(host.tabId)) return;
        if (host.epoch !== value.epoch) {
          lost();
          return;
        }
        const tab = await chrome.tabs.get(host.tabId).catch(() => null);
        if (!tab) {
          if (!terminalSnapshot) {
            lost();
            return;
          }
        } else if (
          ticket !== externalMotionStatusTicket ||
          scopeInvalid ||
          host.userId !== userId ||
          tab.windowId !== host.windowId ||
          tab.url !==
            (host.url || chrome.runtime.getURL("motion-runner.html")) ||
          (value.sourceRevision != null &&
            Number(value.sourceRevision) <
              Number(project?.data_json?.source_revision))
        )
          return;
      }
      if (ticket !== externalMotionStatusTicket || scopeInvalid) return;
      const safeCode = (code) =>
        /^[A-Za-z][A-Za-z0-9_:-]{0,99}$/.test(String(code || ""))
          ? String(code)
          : null;
      const diagnostic = {
        runId: value.runId,
        hostEpoch: value.epoch,
        sourceRevision: value.sourceRevision ?? null,
        ...(Number.isSafeInteger(value.transcriptMaxRetries) && {
          maxRetries: value.transcriptMaxRetries,
        }),
        state: value.state,
        stage: value.stage || null,
        detail: value.detail || null,
        frameId: value.frameId || null,
        ...(value.apiDiagnostic && {
          api: Object.fromEntries(
            [
              "phase",
              "method",
              "operation",
              "eventState",
              "code",
              "conflictReason",
              "submitState",
              "monitorState",
              "providerCode",
            ]
              .map((key) => [key, safeCode(value.apiDiagnostic[key])])
              .concat(
                [
                  "revision",
                  "serverRevision",
                  "sourceRevision",
                  "inputRevision",
                  "retryCount",
                  "httpStatus",
                  "elapsedMs",
                  "pollingGapMs",
                  "stableMs",
                  "textLength",
                  "fullLength",
                  "frameLength",
                  "firstMismatch",
                  "beginMarkers",
                  "endMarkers",
                ].map((key) => [
                  key,
                  Number.isFinite(value.apiDiagnostic[key])
                    ? value.apiDiagnostic[key]
                    : null,
                ]),
              ),
          ),
        }),
        ...(value.error === "MOTION_RUN_SNAPSHOT_CHANGED" &&
          value.snapshot && {
            snapshot: {
              ...(value.snapshot.settings &&
                typeof value.snapshot.settings.matchesSavedFingerprint ===
                  "boolean" && {
                  settings: {
                    matchesSavedFingerprint:
                      value.snapshot.settings.matchesSavedFingerprint,
                    pinnedFields: (Array.isArray(
                      value.snapshot.settings.pinnedFields,
                    )
                      ? value.snapshot.settings.pinnedFields
                      : []
                    ).filter((field) =>
                      [
                        "auto_download_final",
                        "use_original_audio",
                        "continuity_enabled",
                        "ratio",
                        "flow_download_resolution",
                        "transcription_provider",
                        "translate_enabled",
                        "target_language",
                      ].includes(field),
                    ),
                  },
                }),
              reason: safeCode(value.snapshot.reason),
              fields: (Array.isArray(value.snapshot.fields)
                ? value.snapshot.fields
                : []
              )
                .filter(
                  (field) =>
                    typeof field === "string" &&
                    /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(field),
                )
                .slice(0, 30),
            },
          }),
        error: safeCode(value.error),
        failures: (Array.isArray(value.failures) ? value.failures : []).map(
          (item) => ({
            frameId: item.frameId,
            stage: item.stage,
            error: safeCode(item.error),
            retries: item.retries ?? null,
          }),
        ),
      };
      const signature = JSON.stringify(diagnostic);
      if (signature !== lastExternalMotionStatusSignature) {
        lastExternalMotionStatusSignature = signature;
        console.info("[MotionRunnerStatus]", signature);
      }
      const wasRunning = motionRunning;
      if (typeof externalFrameProviderStates !== "undefined") {
        if (
          externalMotionRun?.runId !== value.runId ||
          !["preparing", "running", "pausing"].includes(value.state)
        )
          externalFrameProviderStates.clear();
        if (
          value.stage === "flow" &&
          value.frameId &&
          value.apiDiagnostic?.phase === "provider_result"
        ) {
          const prior = externalFrameProviderStates.get(
            value.frameId,
          )?.diagnostic;
          const diagnostic2 = { ...value.apiDiagnostic };
          if (["retry_queued", "retrying"].includes(diagnostic2.eventState))
            diagnostic2.code || (diagnostic2.code = prior?.code || null);
          if (diagnostic2.eventState === "completed")
            externalFrameProviderStates.delete(value.frameId);
          else
            externalFrameProviderStates.set(value.frameId, {
              runId: value.runId,
              diagnostic: diagnostic2,
            });
        } else if (
          value.frameId &&
          (value.stage === "download" ||
            ["failed", "needs_review", "ready"].includes(value.detail))
        )
          externalFrameProviderStates.delete(value.frameId);
      }
      const retainedScopeDiagnostic =
        !value.apiDiagnostic &&
        value.error &&
        externalMotionRun?.runId === value.runId &&
        externalMotionRun?.frameId === value.frameId &&
        externalMotionRun?.apiDiagnostic?.phase === "flow_scope" &&
        externalMotionRun.apiDiagnostic.code === value.error
          ? externalMotionRun.apiDiagnostic
          : null;
      externalMotionRun = {
        ...value,
        hostTabId: host?.tabId ?? null,
        ...(retainedScopeDiagnostic && {
          apiDiagnostic: retainedScopeDiagnostic,
        }),
      };
      const downloadState = value.downloadError
        ? "failed"
        : value.stage === "final_download"
          ? value.detail
          : null;
      if (
        ["running", "ready", "failed"].includes(downloadState) &&
        lastExternalDownloadNotice !== `${value.runId}:${downloadState}`
      ) {
        lastExternalDownloadNotice = `${value.runId}:${downloadState}`;
        const key =
          downloadState === "running"
            ? "download.downloading"
            : downloadState === "ready"
              ? "download.success"
              : "download.failed";
        const fallback =
          downloadState === "running"
            ? "Downloading..."
            : downloadState === "ready"
              ? "Downloaded successfully!"
              : "Download failed";
        const text = window.I18n?.t?.(key);
        if (notify)
          motionToast(text && text !== key ? text : fallback, {
            persistent: downloadState === "running",
            error: downloadState === "failed",
          });
      }
      motionRunning = ["preparing", "running", "pausing"].includes(value.state);
      renderExternalFinalization(value);
      activeAudioFrameId =
        motionRunning && value.stage === "audio" && value.detail === "running"
          ? value.frameId
          : null;
      renderExternalUploadToolbar(value);
      if (["transcript", "transcribe"].includes(value.stage) && value.frameId) {
        if (
          motionRunning &&
          ["running", "preparing", "retrying"].includes(value.detail)
        )
          batchSubFrameIds.add(value.frameId);
        else if (
          [
            "ready",
            "saved",
            "failed",
            "needs_review",
            "sync_pending",
            "paused",
            "cancelled",
          ].includes(value.detail)
        )
          batchSubFrameIds.delete(value.frameId);
      }
      if (!motionRunning) batchSubFrameIds.clear();
      if (value.timerReset === true && $("motionTimer")) {
        activityStartedAt = null;
        $("motionTimer").dataset.elapsedMs = "0";
        $("motionTimer").dataset.reset = "true";
      } else if (value.timerPaused === true || value.state === "pausing") {
        if (
          Number.isSafeInteger(value.elapsedMs) &&
          value.elapsedMs >= 0 &&
          $("motionTimer")
        )
          $("motionTimer").dataset.elapsedMs = String(value.elapsedMs);
        activityStartedAt = null;
      } else if (
        Number.isSafeInteger(value.startedAt) &&
        value.startedAt > 0 &&
        motionRunning
      ) {
        if ($("motionTimer")) delete $("motionTimer").dataset.reset;
        activityStartedAt = value.startedAt;
      }
      if (
        !motionRunning &&
        Number.isSafeInteger(value.elapsedMs) &&
        value.elapsedMs >= 0 &&
        $("motionTimer")
      ) {
        $("motionTimer").dataset.elapsedMs = String(value.elapsedMs);
        activityStartedAt = null;
      }
      if (
        motionRunning &&
        !wasRunning &&
        value.timerReset !== true &&
        value.timerPaused !== true &&
        value.state !== "pausing"
      )
        startActivity();
      if (
        value.sourceRevision != null &&
        Number(value.sourceRevision) >
          Number(project?.data_json?.source_revision)
      ) {
        externalProjectDirty = true;
        scheduleExternalProjectRefresh();
      }
      activeContinuityPhase =
        value.stage === "continuity" ? value.detail : null;
      const previousFrameId = activeMotionFrameId,
        previousStage = activeMotionStage;
      activeMotionFrameId = motionRunning ? value.frameId || null : null;
      activeMotionStage = motionRunning
        ? value.stage === "download"
          ? ["running", "retrying"].includes(value.detail)
            ? "download"
            : null
          : value.stage === "transcript"
            ? ["running", "retrying", "preparing"].includes(value.detail)
              ? "transcribe"
              : null
            : value.stage || null
        : null;
      if (activeMotionStage === "download") {
        if (
          previousFrameId !== activeMotionFrameId ||
          previousStage !== "download"
        )
          activeFlowStartedAt = Date.now();
      } else activeFlowStartedAt = 0;
      if (
        [
          "audio",
          "continuity",
          "upload",
          "flow",
          "download",
          "transcript",
          "transcribe",
        ].includes(value.stage)
      ) {
        externalProjectDirty = true;
        scheduleExternalProjectRefresh();
      }
      if (value.state === "pausing") {
        const key = "uploadControls.cancelling",
          label = window.I18n?.t?.(key);
        reportStatus(label && label !== key ? label : "Cancelling\u2026", {
          state: "pausing",
        });
      } else if (
        motionRunning &&
        (!value.apiDiagnostic ||
          (value.apiDiagnostic.phase === "provider_result" &&
            ["retry_queued", "retrying", "processing", "completed"].includes(
              value.apiDiagnostic.eventState,
            )))
      ) {
        const total = Number(value.totalCount),
          completed = Number(value.completedCount);
        const count =
          Number.isSafeInteger(total) &&
          total > 0 &&
          Number.isSafeInteger(completed)
            ? `${Math.min(completed, total)}/${total}`
            : "";
        if (count)
          $("progress").value = Math.min(
            100,
            Math.max(0, (completed / total) * 100),
          );
        const frameId = value.frameId || "";
        const queuedKey = "genBatch.status_queued",
          queuedText = window.I18n?.t?.(queuedKey);
        const label =
          value.stage === "audio"
            ? motionFormat("preparingAudio", "", [
                frameId,
                value.index,
                value.total,
              ])
            : ["transcript", "transcribe"].includes(value.stage)
              ? value.detail === "saved"
                ? motionFormat("text211", "\u0110\xE3 t\u1EA1o sub {0}.", [
                    frameId,
                  ])
                : motionText(
                    "text092",
                    "\u0110ang l\u1EA5y l\u1EDDi tho\u1EA1i...",
                  )
              : value.stage === "continuity"
                ? continuityStatusText()
                : value.stage === "upload"
                  ? motionFormat(
                      "text206",
                      "\u0110ang upload {0} l\xEAn Flow...",
                      [frameId],
                    )
                  : value.stage === "flow" && value.detail === "queued"
                    ? `${frameId}: ${queuedText && queuedText !== queuedKey ? queuedText : "Queued"}`
                    : value.stage === "flow" &&
                        ["retry_queued", "retrying"].includes(
                          value.apiDiagnostic?.eventState,
                        )
                      ? [
                          window.I18n?.t?.("flowStatus.retrying") ||
                            "\u0110ang th\u1EED l\u1EA1i\u2026",
                          value.apiDiagnostic.code &&
                            `(${value.apiDiagnostic.code})`,
                        ]
                          .filter(Boolean)
                          .join(" \xB7 ")
                      : value.stage === "flow"
                        ? motionFormat(
                            "text212",
                            "{0}: \u0111ang t\u1EA1o video Flow {1}...",
                            [
                              frameId,
                              String(
                                project?.data_json?.flow_run_mode || "",
                              ).toUpperCase(),
                            ],
                          )
                        : null;
        if (value.error)
          reportStatus(
            `${frameId}: ${motionErrorMessage(value.error, { transcript: ["transcribe", "transcript", "transcript_batch"].includes(value.stage) })}`,
            {
              state:
                value.detail === "sync_pending" ? "needs_review" : "failed",
            },
          );
        else if (label)
          reportStatus(
            [
              label,
              count,
              ["transcript", "transcribe"].includes(value.stage) && frameId,
            ]
              .filter(Boolean)
              .join(" \xB7 "),
            { state: "running" },
          );
      }
      const observedProviderError = externalFlowProviderError(value.frameId);
      if (observedProviderError) {
        reportStatus(
          `${value.frameId}: ${motionErrorMessage(observedProviderError)}`,
          { state: "failed" },
        );
      }
      if (!motionRunning) {
        settleActivity();
        externalProjectDirty = true;
        scheduleExternalProjectRefresh();
        if (["stopped", "cancelled"].includes(value.state)) {
          const message = [
            motionErrorMessage(value.error || "MOTION_CANCELLED"),
            value.cleanupError && motionErrorMessage(value.cleanupError),
          ]
            .filter(Boolean)
            .join(" \xB7 ");
          reportStatus(message, {
            state: value.cleanupError ? "failed" : "paused",
          });
        }
        if (
          value.state === "paused" &&
          value.pauseReason === "subtitle_review"
        ) {
          const message = value.reviewFailed
            ? motionText("reviewSubtitleFailed", "")
            : motionText("reviewSubtitleReady", "");
          reportStatus(message, { state: "paused" });
          const signature2 = JSON.stringify([
            value.runId,
            value.pauseReason,
            value.reviewFailed,
          ]);
          if (lastExternalMotionFailure !== signature2) {
            lastExternalMotionFailure = signature2;
            if (notify)
              motionToast(message, { error: value.reviewFailed === true });
          }
        }
        if (
          value.state === "paused" &&
          !["api_unusual_activity", "flow_quota", "subtitle_review"].includes(
            value.pauseReason,
          )
        )
          reportStatus(
            value.error
              ? motionErrorMessage(value.error)
              : motionText(
                  "text135",
                  "\u0110\xE3 t\u1EA1m d\u1EEBng Motion project.",
                ),
            { state: "paused" },
          );
        if (
          value.state === "paused" &&
          ["api_unusual_activity", "flow_quota"].includes(value.pauseReason) &&
          value.error
        ) {
          const message = motionErrorMessage(value.error);
          reportStatus(message, { state: "paused" });
          const signature2 = JSON.stringify([
            value.runId,
            value.state,
            value.frameId,
            value.error,
          ]);
          if (lastExternalMotionFailure !== signature2) {
            lastExternalMotionFailure = signature2;
            if (notify) motionToast(message, { error: true });
          }
        }
        if (value.state === "ready" && value.stage === "transcript_batch") {
          const message = motionFormat(
            "text210",
            "\u0110\xE3 t\u1EA1o sub {0} frame.",
            [value.completedCount || 0],
          );
          reportStatus(message, { state: "ready" });
          if (notify) motionToast(message);
        }
        if (value.state === "ready" && value.stage !== "transcript_batch") {
          $("progress").value = 100;
          const warning = [
            value.mergeError,
            value.downloadError,
            value.cleanupError,
          ]
            .filter(Boolean)
            .map((code) => motionErrorMessage(code))
            .join(" \xB7 ");
          reportStatus(
            value.mergeError
              ? `${motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh")} \xB7 ${warning}`
              : warning || motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh"),
            {
              state:
                value.downloadError || value.cleanupError ? "failed" : "ready",
            },
          );
        }
        if (["failed", "needs_review"].includes(value.state)) {
          const message = [
            motionFailureMessage(value),
            value.cleanupError && motionErrorMessage(value.cleanupError),
          ]
            .filter(Boolean)
            .join("\n");
          const signature2 = JSON.stringify([
            value.runId,
            value.state,
            value.frameId,
            value.error,
            value.failures,
          ]);
          reportStatus(message, { state: value.state });
          updateButtons();
          if (lastExternalMotionFailure !== signature2) {
            lastExternalMotionFailure = signature2;
            if (notify) motionToast(message, { error: true });
            const uploadFailure = (
              Array.isArray(value.failures) ? value.failures : []
            ).find((item) => item.stage === "upload");
            if (notify && (uploadFailure || value.stage === "upload"))
              void showVideoUploadFailure(
                uploadFailure?.error || value.error || "MOTION_UPLOAD_FAILED",
                uploadFailure?.frameId || value.frameId,
              );
          }
        }
        if (!["paused", "needs_review"].includes(value.state))
          externalMotionRun = null;
      }
      updateButtons();
    } catch (_) {}
  }
  function scheduleExternalProjectRefresh() {
    const canRefresh = () =>
      !externalProjectRefreshStopped &&
      !scopeInvalid &&
      !!project &&
      !busy &&
      (!motionRunning || !!externalMotionRun) &&
      !settingsDirty &&
      !settingsSaveTimer;
    if (
      !externalProjectDirty ||
      externalProjectRefreshTimer ||
      externalProjectRefreshFlight ||
      !canRefresh()
    )
      return;
    externalProjectRefreshTimer = setTimeout(async () => {
      externalProjectRefreshTimer = null;
      if (!canRefresh()) return;
      externalProjectDirty = false;
      let failed = false;
      const flight = Promise.resolve().then(() =>
        refresh({ canApply: canRefresh }),
      );
      externalProjectRefreshFlight = flight;
      try {
        if ((await flight) === false) externalProjectDirty = true;
      } catch (error) {
        failed = true;
        externalProjectDirty = true;
        console.warn(
          "[Motion] External project refresh failed",
          error?.message,
        );
      } finally {
        if (externalProjectRefreshFlight === flight)
          externalProjectRefreshFlight = null;
        if (!failed && externalProjectDirty) scheduleExternalProjectRefresh();
      }
    }, 400);
  }
  function isMotionProjectComplete() {
    const data = project?.data_json,
      final = data?.final;
    const ids = Object.keys(data?.frames || {});
    if (
      !pendingSourceFile &&
      window.MotionRunJournal?.isGenerationComplete?.(data) &&
      ids.every((id) => generatedFrameIds.has(id))
    )
      return true;
    return (
      !pendingSourceFile &&
      data?.requires_resplit !== true &&
      !!finalArtifact &&
      final?.stale !== true &&
      Number(final?.source_revision) === Number(data?.source_revision) &&
      Number(finalArtifact.artifact_revision) ===
        Number(final?.artifact_revision) &&
      ids.length > 0 &&
      Array.isArray(final?.frame_ids) &&
      final.frame_ids.length === ids.length &&
      new Set(final.frame_ids).size === ids.length &&
      ids.every(
        (id) =>
          final.frame_ids.includes(id) &&
          generatedFrameIds.has(id) &&
          data.frames[id]?.stages?.persist?.state === "ready",
      )
    );
  }
  function isMotionProjectIdleComplete() {
    return (
      !busy &&
      !motionRunning &&
      !pausedStandaloneTask &&
      externalMotionRun?.state !== "needs_review" &&
      isMotionProjectComplete()
    );
  }
  function syncMotionCompletionDisplay(
    complete = isMotionProjectIdleComplete(),
  ) {
    if (!project) return;
    const paused = project.data_json?.paused === true && !complete;
    const overall = Object.values(project.data_json?.frames || {}).map(
      frameStage,
    );
    $("projectState").previousElementSibling?.classList.toggle(
      "dot-paused",
      paused,
    );
    $("projectState").textContent =
      project.data_json?.requires_resplit === true
        ? window.MotionAudioRegenerator?.needsAudioPreparation?.(project) ===
          true
          ? motionText("resumeAudioPending", "")
          : motionText("text093", "C\u1EA7n c\u1EAFt l\u1EA1i ngu\u1ED3n")
        : complete
          ? motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh")
          : paused
            ? motionText("text094", "\u0110ang t\u1EA1m d\u1EEBng")
            : overall.some((item) => item.state === "failed")
              ? motionText("text095", "C\xF3 frame l\u1ED7i")
              : motionRunning ||
                  overall.some((item) => item.state === "running")
                ? motionText("text056", "\u0110ang x\u1EED l\xFD...")
                : motionText("text007", "S\u1EB5n s\xE0ng");
    if (
      complete &&
      $("status").textContent ===
        motionText("text135", "\u0110\xE3 t\u1EA1m d\u1EEBng Motion project.")
    )
      status(motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh"), {
        state: "ready",
      });
    if (
      complete &&
      window.MotionRunJournal?.isGenerationComplete?.(project.data_json) &&
      $("status").textContent ===
        motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh")
    )
      status(
        `${motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh")} \xB7 ${motionErrorMessage(project.data_json.generation_completion.merge_error)}`,
        { state: "ready" },
      );
  }
  function updateButtons() {
    renderFrameLimitHint();
    renderSplitSummary();
    globalThis.MotionTextFieldLimits?.refresh();
    if (activeFrameMenu?.refreshState) activeFrameMenu.refreshState();
    else if (activeFrameMenu && (busy || motionRunning))
      activeFrameMenu.querySelectorAll("button").forEach((button) => {
        if (button.dataset.action !== "reset-result") button.disabled = true;
      });
    if (externalProjectDirty) scheduleExternalProjectRefresh();
    if (!busy && !motionRunning && profileDirty && !scopeInvalid)
      void refreshProfile();
    const canResplit =
      project?.data_json?.requires_resplit === true &&
      !!stageSourceUrl &&
      window.MotionAudioRegenerator?.needsAudioPreparation?.(project) !== true;
    const hasFrames = Object.keys(project?.data_json?.frames || {}).length > 0;
    const hasSource =
      !!pendingSourceFile || (!!project?.data_json?.source && !!stageSourceUrl);
    const hasCharacter = !!project?.data_json?.references?.character?.length;
    const externalBusy = !!externalMotionRun && motionRunning;
    $("characterDropZone").classList.toggle(
      "is-required",
      (hasSource || hasFrames) && !hasCharacter,
    );
    $("clearFramesBtn").disabled =
      scopeInvalid ||
      busy ||
      motionRunning ||
      !!settingsSaveTimer ||
      !Object.keys(project?.data_json?.frames || {}).length;
    $("motionRunBtn").title = project?.data_json?.flow_run_mode
      ? `Flow ${project.data_json.flow_run_mode.toUpperCase()}`
      : "Generate";
    $("splitBtn").disabled =
      scopeInvalid ||
      busy ||
      externalBusy ||
      !!settingsSaveTimer ||
      (!pendingSourceFile && !canResplit) ||
      !profile;
    $("splitBtn").textContent =
      canResplit && !pendingSourceFile
        ? motionText("text097", "C\u1EAFt l\u1EA1i ngu\u1ED3n")
        : motionText("text046", "C\u1EAFt v\xE0 l\u01B0u");
    $("cancelBtn").disabled = scopeInvalid || (!busy && !motionRunning);
    const forceStop = $("motionForceStopBtn");
    if (forceStop) {
      forceStop.hidden = !motionRunning && !activeUploadFrameId;
      forceStop.disabled = scopeInvalid;
    }
    const cancelLabel = $("cancelBtn").querySelector("[data-i18n]");
    if (cancelLabel) {
      cancelLabel.dataset.i18n = motionRunning
        ? "workflow.forceStop"
        : "motionEditor.text054";
      cancelLabel.textContent = window.I18n.t(cancelLabel.dataset.i18n);
    }
    $("sourceInput").disabled =
      scopeInvalid || busy || motionSettingsRunLocked() || !!settingsSaveTimer;
    $("motionTemplateBtn").disabled =
      scopeInvalid ||
      busy ||
      motionSettingsRunLocked() ||
      !!settingsSaveTimer ||
      !profile ||
      window.featureGate?.canUse?.("motion_tool_enabled") !== true;
    $("replaceSourceBtn").disabled =
      scopeInvalid || busy || motionSettingsRunLocked() || !!settingsSaveTimer;
    if ($("slowSourceBtn"))
      $("slowSourceBtn").disabled =
        scopeInvalid ||
        busy ||
        motionSettingsRunLocked() ||
        !!settingsSaveTimer ||
        !profile ||
        !hasSource;
    const runActive =
      motionRunning ||
      project?.status === "running" ||
      project?.data_json?.paused === true ||
      Object.values(project?.data_json?.frames || {}).some((frame) =>
        ["transcribe", "upload", "submit", "monitor", "persist"].some((stage) =>
          ["running", "pending"].includes(frame.stages?.[stage]?.state),
        ),
      );
    const paused =
      project?.data_json?.paused === true ||
      !!localMotionProviderPause ||
      externalMotionRun?.state === "needs_review";
    const complete = isMotionProjectIdleComplete();
    syncMotionCompletionDisplay(complete);
    const controlState = complete
      ? "complete"
      : paused
        ? "paused"
        : runActive
          ? "running"
          : "idle";
    const control = $("motionRunBtn");
    control.disabled =
      complete ||
      scopeInvalid ||
      (busy &&
        !(
          motionRunning &&
          (activeUploadFrameId || activeMotionStage === "download") &&
          !deferredUploadPause
        )) ||
      !!settingsSaveTimer ||
      !project ||
      (controlState === "idle" &&
        (settingsDirty ||
          !hasCharacter ||
          (!hasFrames && !hasSource) ||
          !isAgentReadyForGeneration()));
    if (control.dataset.controlState !== controlState) {
      control.dataset.controlState = controlState;
      const currentIcon = control.querySelector("svg");
      const icon = ["idle", "complete"].includes(controlState)
        ? motionGenerateIcon?.cloneNode(true)
        : document.createElementNS("http://www.w3.org/2000/svg", "svg");
      if (icon && !["idle", "complete"].includes(controlState)) {
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", "18");
        icon.setAttribute("height", "18");
        icon.setAttribute("fill", "currentColor");
        icon.setAttribute("aria-hidden", "true");
        if (controlState === "paused") {
          const path = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          path.setAttribute("d", "M7 4v16l13-8z");
          icon.append(path);
        } else {
          for (const x of [6, 14]) {
            const rect = document.createElementNS(
              "http://www.w3.org/2000/svg",
              "rect",
            );
            rect.setAttribute("x", x);
            rect.setAttribute("y", "4");
            rect.setAttribute("width", "4");
            rect.setAttribute("height", "16");
            rect.setAttribute("rx", "1");
            icon.append(rect);
          }
        }
      }
      if (icon && currentIcon) currentIcon.replaceWith(icon);
    }
    control.querySelector("span").textContent =
      controlState === "complete"
        ? motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh")
        : controlState === "paused"
          ? motionText("text078", "Ti\u1EBFp t\u1EE5c")
          : controlState === "running"
            ? motionText("text039", "T\u1EA1m d\u1EEBng")
            : "Generate";
    if (controlState !== "idle")
      control.title = control.querySelector("span").textContent;
    control.classList.toggle("is-pause-control", controlState === "running");
    $("pauseBtn").hidden = true;
    const settingsLocked = motionSettingsRunLocked();
    const settingsNote = $("motionSettingsLockNote");
    if (settingsNote) {
      settingsNote.hidden = !settingsLocked;
      settingsNote.textContent = motionText("settingsLocked", "");
    }
    const languageTrigger = $("targetLanguageTrigger");
    if (languageTrigger)
      languageTrigger.disabled = scopeInvalid || busy || settingsLocked;
    for (const id of [
      "characterDropZone",
      "character2DropZone",
      "backgroundDropZone",
    ])
      $(id).setAttribute(
        "aria-disabled",
        String(scopeInvalid || busy || settingsLocked),
      );
    $("savePreferences").disabled =
      scopeInvalid ||
      busy ||
      settingsLocked ||
      externalBusy ||
      !resolutions.length;
    $("saveMotionSettings").disabled =
      scopeInvalid ||
      busy ||
      settingsLocked ||
      !ratios.length ||
      !profile ||
      ["voiceDescription", "motionCustomPrompt"].some(
        (id) => $(id)?.validity?.customError === true,
      );
    $("motionVoiceTrigger").disabled =
      scopeInvalid ||
      busy ||
      settingsLocked ||
      !$("voiceEnabled").checked ||
      profile?.settings?.show_flow_voice === false;
    $("transcriptionAgent").disabled =
      scopeInvalid || busy || settingsLocked || !profile;
    document.querySelectorAll("[data-motion-agent]").forEach((button) => {
      button.disabled = scopeInvalid || busy || settingsLocked || !profile;
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.motionAgent === $("transcriptionAgent").value),
      );
    });
    $("referenceMode").disabled = scopeInvalid || busy || settingsLocked;
    $("characterCount").disabled = scopeInvalid || busy || settingsLocked;
    $("character2DropZone").setAttribute(
      "aria-disabled",
      String(
        scopeInvalid ||
          busy ||
          settingsLocked ||
          profile?.settings?.show_two_characters !== true,
      ),
    );
    $("motionFlowModel").disabled =
      scopeInvalid ||
      busy ||
      settingsLocked ||
      !profile ||
      !$("motionFlowModel").options.length;
    window.motionReferenceModePickerRender?.();
    window.motionCharacterCountPickerRender?.();
    $("autoDownloadFinal").disabled =
      scopeInvalid || busy || settingsLocked || !profile;
    $("useOriginalAudio").disabled =
      scopeInvalid || busy || settingsLocked || !profile;
    $("continuityEnabled").disabled =
      scopeInvalid || busy || settingsLocked || motionRunning || !profile;
    $("removeFinalVideoWatermark").disabled =
      scopeInvalid ||
      busy ||
      settingsLocked ||
      !profile ||
      (!$("removeFinalVideoWatermark").checked &&
        (window.SystemConfig?.getBool?.("remove_watermark_enabled") !== true ||
          window.featureGate?.canUse?.("video_remove_watermark_enabled") !==
            true));
    $("flowResolution").disabled =
      scopeInvalid || busy || settingsLocked || !resolutions.length;
    $("motionRatio").disabled =
      scopeInvalid || busy || settingsLocked || !ratios.length;
    window.motionRatioPickerRender?.();
    for (const id of [
      "voiceEnabled",
      "subtitleEnabled",
      "translateEnabled",
      "voiceDescription",
      "motionCustomPrompt",
      "targetLanguage",
      "motionVoiceMode",
    ]) {
      $(id).disabled =
        scopeInvalid || busy || settingsLocked || speechDecisionPending;
    }
    updateMotionVisibility();
    $("mergeBtn").disabled =
      scopeInvalid || busy || !!settingsSaveTimer || !canMerge;
    $("playFinal").disabled = scopeInvalid || busy || !finalArtifact;
    $("downloadFinal").disabled =
      scopeInvalid || busy || finalDownloadPending || !finalArtifact;
    if ($("finalSpeedBtn"))
      $("finalSpeedBtn").disabled =
        scopeInvalid ||
        busy ||
        motionSettingsRunLocked() ||
        !!settingsSaveTimer ||
        finalDownloadPending ||
        !finalArtifact ||
        finalArtifact.stale === true;
    $("editNameBtn").disabled = scopeInvalid || busy || !project;
    $("saveNameBtn").disabled = scopeInvalid || busy;
    $("headerSaveBtn").disabled =
      scopeInvalid || busy || headerSaving || !project;
    $("headerResetBtn").disabled =
      scopeInvalid || busy || motionRunning || !!settingsSaveTimer || !project;
    if ($("frameDialog").open)
      $("frameResub").disabled = !canGetFrameSub(
        project?.data_json?.frames?.[selectedFrameId],
      );
  }
  async function resetMotionProject() {
    if (
      scopeInvalid ||
      busy ||
      motionRunning ||
      !project ||
      resetConfirmationOpen
    )
      return;
    resetConfirmationOpen = true;
    let confirmed;
    try {
      const resetLabel = window.I18n?.t?.("common.reset");
      confirmed = await window.customDialog.confirmDangerous(
        motionText(
          "text254",
          "X\xF3a video g\u1ED1c, to\xE0n b\u1ED9 frame, l\u1EDDi tho\u1EA1i v\xE0 video k\u1EBFt qu\u1EA3 c\u1EE7a Motion project tr\xEAn thi\u1EBFt b\u1ECB? Thi\u1EBFt l\u1EADp v\xE0 \u1EA3nh tham chi\u1EBFu \u0111\u01B0\u1EE3c gi\u1EEF l\u1EA1i.",
        ),
        {
          title: "Reset Motion project",
          confirmText:
            resetLabel && resetLabel !== "common.reset" ? resetLabel : "Reset",
          cancelText: motionText("text006", "H\u1EE7y"),
        },
      );
    } finally {
      resetConfirmationOpen = false;
    }
    if (!confirmed || scopeInvalid || busy || motionRunning || !project) return;
    busy = true;
    updateButtons();
    const resetId = crypto.randomUUID();
    let resetCommitted = false;
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
              try {
                await MotionRunJournal.assertSourceResettable({
                  userId,
                  toolProjectId: projectId,
                });
                project = await api("POST", `${endpoint}/reset`, {
                  revision: project.revision,
                  reset_id: resetId,
                });
              } catch (error) {
                const current = await api("GET", endpoint).catch(() => null);
                if (current?.data_json?.reset_id !== resetId) throw error;
                project = current;
              }
              resetCommitted = true;
              await MotionRunJournal.acknowledgeSourceChange(
                { userId, toolProjectId: projectId },
                project,
              );
              const revision = Number(project.data_json.source_revision);
              pendingSourceFile = null;
              pendingBulkDraftKey = null;
              pausedStandaloneTask = null;
              $("sourceInput").value = "";
              $("progress").value = 0;
              closeFrameDialog();
              closePreview();
              releaseStageMedia();
              const records = await MotionArtifactStore.listProject(
                userId,
                projectId,
              );
              const oldRevisions = new Set(
                records
                  .filter(
                    (item) =>
                      item.sourceRevision > 0 && item.sourceRevision < revision,
                  )
                  .map((item) => item.sourceRevision),
              );
              const splitRevisions =
                await MotionArtifactStore.clearSplitJournalsAfterReset({
                  userId,
                  toolProjectId: projectId,
                  maxRevision: revision,
                  serverResetVerified: true,
                });
              for (const splitRevision of splitRevisions)
                oldRevisions.add(splitRevision);
              for (const oldRevision of oldRevisions)
                await MotionArtifactStore.deleteSourceRevision(
                  userId,
                  projectId,
                  oldRevision,
                );
              await MotionArtifactStore.deleteSourceDraft(userId, projectId);
              await refresh();
              status(motionText("text105", "\u0110\xE3 reset Motion project."));
            },
          );
        },
      );
    } catch (error) {
      const message = resetCommitted
        ? motionText(
            "text256",
            "\u0110\xE3 reset project tr\xEAn server, nh\u01B0ng ch\u01B0a d\u1ECDn h\u1EBFt d\u1EEF li\u1EC7u local. M\u1EDF l\u1EA1i project \u0111\u1EC3 th\u1EED d\u1ECDn ti\u1EBFp.",
          )
        : motionErrorMessage(error);
      status(message);
      await window.customDialog?.alert?.(message, {
        title: "Reset Motion project",
      });
    } finally {
      busy = false;
      settleActivity();
      updateButtons();
      if (!scopeInvalid) await refresh().catch(() => {});
    }
  }
  async function clearAllFrames() {
    if (
      scopeInvalid ||
      busy ||
      motionRunning ||
      !project ||
      !$("clearFramesBtn") ||
      $("clearFramesBtn").disabled
    )
      return;
    if (
      !(await window.customDialog.confirmDangerous(
        motionText(
          "text255",
          "X\xF3a t\u1EA5t c\u1EA3 frame, audio v\xE0 video k\u1EBFt qu\u1EA3 c\u1EE7a project tr\xEAn thi\u1EBFt b\u1ECB? Video ngu\u1ED3n s\u1EBD \u0111\u01B0\u1EE3c gi\u1EEF \u0111\u1EC3 c\u1EAFt l\u1EA1i.",
        ),
        {
          title: motionText("text055", "X\xF3a t\u1EA5t c\u1EA3 frame"),
          confirmText: motionText("text160", "X\xF3a t\u1EA5t c\u1EA3"),
          cancelText: motionText("text006", "H\u1EE7y"),
        },
      ))
    )
      return;
    busy = true;
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
              project = await api("PATCH", endpoint, {
                revision: project.revision,
                clear_frames: true,
              });
              closeFrameDialog();
              closePreview();
              await MotionArtifactStore.deleteFrameArtifacts(userId, projectId);
              await refresh();
              status(
                motionText(
                  "text225",
                  "\u0110\xE3 x\xF3a t\u1EA5t c\u1EA3 frame. Video ngu\u1ED3n s\u1EB5n s\xE0ng \u0111\u1EC3 c\u1EAFt l\u1EA1i.",
                ),
              );
            },
          );
        },
      );
    } catch (error) {
      await refresh().catch(() => {});
      if (
        !scopeInvalid &&
        project?.data_json?.frames_cleared === true &&
        navigator.locks?.request
      ) {
        try {
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await MotionArtifactStore.deleteFrameArtifacts(userId, projectId);
            },
          );
          await refresh();
          status(
            motionText(
              "text225",
              "\u0110\xE3 x\xF3a t\u1EA5t c\u1EA3 frame. Video ngu\u1ED3n s\u1EB5n s\xE0ng \u0111\u1EC3 c\u1EAFt l\u1EA1i.",
            ),
          );
        } catch (_) {
          status(
            motionText(
              "text226",
              "\u0110\xE3 x\xF3a frame tr\xEAn server; ch\u01B0a d\u1ECDn \u0111\u01B0\u1EE3c d\u1EEF li\u1EC7u tr\xEAn thi\u1EBFt b\u1ECB. M\u1EDF l\u1EA1i project \u0111\u1EC3 th\u1EED ti\u1EBFp.",
            ),
          );
        }
      } else status(motionErrorMessage(error));
    } finally {
      busy = false;
      settleActivity();
      updateButtons();
    }
  }
  async function resolveAudioFrameSource({
    frameId,
    frame,
    project: snapshot,
    signal,
  }) {
    if (scopeInvalid || signal?.aborted) throw new Error("MOTION_CANCELLED");
    const revision = Number(snapshot.data_json?.source_revision);
    const record = await MotionArtifactStore.get({
      userId,
      toolProjectId: projectId,
      sourceRevision: revision,
      frameId,
      kind: "source_clip",
    });
    if (record?.uploadReceipt?.mediaUuid !== frame.source_edit?.media_id)
      throw new Error("FRAME_SCOPE_CHANGED");
    let blob = record.blob;
    if (!blob) {
      let abort;
      const stopped = new Promise((_, reject) => {
        abort = () => reject(new Error("MOTION_CANCELLED"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      let url;
      try {
        url = await Promise.race([resolveUploadedSource(record), stopped]);
      } finally {
        signal?.removeEventListener("abort", abort);
      }
      if (!url) throw new Error("MOTION_SOURCE_NOT_AVAILABLE");
      const response = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("MOTION_SOURCE_NOT_AVAILABLE");
      blob = await response.blob();
    }
    if (
      scopeInvalid ||
      signal?.aborted ||
      Number(project.data_json?.source_revision) !== revision
    )
      throw new Error("MOTION_CANCELLED");
    return {
      blob,
      frame: { start: 0, end: Number(frame.end) - Number(frame.start) },
    };
  }
  async function regenerateAllFrameAudio(frameId = null) {
    if (scopeInvalid || busy || motionRunning) return;
    if (
      frameId === null &&
      !(await window.customDialog.confirm(
        motionText(
          "regenerateAudioConfirm",
          "T\u1EA1o l\u1EA1i audio cho t\u1EA5t c\u1EA3 frame t\u1EEB video ngu\u1ED3n?",
        ),
        {
          title: motionText(
            "regenerateAudioAll",
            "T\u1EA1o l\u1EA1i audio t\u1EA5t c\u1EA3 frame",
          ),
          confirmText: motionText("text159", "T\u1EA1o l\u1EA1i"),
          cancelText: motionText("text006", "H\u1EE7y"),
        },
      ))
    )
      return;
    if (scopeInvalid || busy || motionRunning) return;
    const controller = new AbortController();
    let audioFailures = 0;
    busy = true;
    cancelled = false;
    cancelSplit = () => controller.abort();
    startActivity();
    updateButtons();
    try {
      await window.featureGate.init();
      if (!window.featureGate.canUse("motion_tool_enabled"))
        throw new Error("MOTION_FEATURE_REQUIRED");
      const config = await window.ExecutionConfig.getConfig();
      const configured = config?.workflow?.max_retries;
      if (!Number.isSafeInteger(configured) || configured < 0)
        throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      const count = await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          return navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              return window.MotionAudioRegenerator.run({
                userId,
                projectId,
                api,
                signal: controller.signal,
                frameId,
                resolveFrameSource: resolveAudioFrameSource,
                timeoutMs: window.MotionMergeTask.timeoutMs(),
                maxRetries:
                  window.featureGate.canUse("retry_on_fail") === true
                    ? configured
                    : 0,
                onProgress: ({
                  frameId: frameId2,
                  index,
                  total,
                  state,
                  error,
                }) => {
                  activeAudioFrameId = state === "running" ? frameId2 : null;
                  if (selectedFrameId && $("frameDialog").open)
                    renderFrameDialogStatus(selectedFrameId);
                  if (state !== "running" && !scopeInvalid)
                    void refresh().catch(() => {});
                  $("progress").value =
                    state === "running"
                      ? ((index - 1) / total) * 100
                      : (index / total) * 100;
                  if (state === "running")
                    status(
                      motionFormat(
                        "regeneratingAudio",
                        "\u0110ang t\u1EA1o l\u1EA1i audio {0} \xB7 {1}/{2}...",
                        [frameId2, index, total],
                      ),
                    );
                  if (state === "failed") {
                    audioFailures++;
                    status(`${frameId2}: ${motionErrorMessage(error)}`, {
                      state: "failed",
                    });
                  }
                },
              });
            },
          );
        },
      );
      status(
        motionFormat(
          "audioRegenerated",
          "\u0110\xE3 t\u1EA1o l\u1EA1i audio cho {0} frame.",
          [count],
        ),
        { state: audioFailures ? "failed" : "ready" },
      );
      motionToast(
        motionFormat(
          "audioRegenerated",
          "\u0110\xE3 t\u1EA1o l\u1EA1i audio cho {0} frame.",
          [count],
        ),
        { error: audioFailures > 0 },
      );
    } catch (error) {
      status(motionErrorMessage(error || "MOTION_AUDIO_EXTRACT_FAILED"));
      if (!cancelled)
        motionToast(
          motionErrorMessage(error || "MOTION_AUDIO_EXTRACT_FAILED"),
          { error: true },
        );
    } finally {
      controller.abort();
      activeAudioFrameId = null;
      cancelSplit = null;
      busy = false;
      settleActivity();
      updateButtons();
      if (!scopeInvalid) {
        await refresh().catch(() => {});
        if (selectedFrameId)
          await loadFrameAudio(selectedFrameId).catch(() => {});
      }
    }
  }
  function addTrackBatchMenu(
    label,
    { key, fallback, iconClass, run, resetResults = false },
  ) {
    if (!label) return;
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "motion-frame-menu-trigger motion-track-menu-trigger";
    trigger.textContent = "\u22EE";
    trigger.setAttribute("aria-label", motionText(key, fallback));
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (scopeInvalid) return;
      activeFrameMenu?.remove();
      document
        .querySelectorAll('.motion-frame-menu-trigger[aria-expanded="true"]')
        .forEach((button) => button.setAttribute("aria-expanded", "false"));
      const menu = document.createElement("div");
      menu.className = "motion-frame-menu";
      menu.setAttribute("role", "menu");
      const action = document.createElement("button");
      action.type = "button";
      action.setAttribute("role", "menuitem");
      const icon =
        iconClass === "motion-menu-gen-icon" && motionGenerateIcon
          ? motionGenerateIcon.cloneNode(true)
          : document.createElement("span");
      icon.classList.add(iconClass);
      icon.setAttribute("aria-hidden", "true");
      action.append(icon, document.createTextNode(motionText(key, fallback)));
      action.disabled =
        busy ||
        motionRunning ||
        !Object.keys(project?.data_json?.frames || {}).length ||
        project?.data_json?.requires_resplit === true;
      action.addEventListener("click", () => {
        menu.remove();
        activeFrameMenu = null;
        trigger.setAttribute("aria-expanded", "false");
        if (!scopeInvalid && !busy && !motionRunning) void run();
      });
      menu.append(action);
      if (resetResults) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.setAttribute("role", "menuitem");
        const resetIcon = document.createElement("span");
        resetIcon.className = "motion-menu-reset-icon";
        resetIcon.setAttribute("aria-hidden", "true");
        reset.append(
          resetIcon,
          document.createTextNode(
            `${window.I18n.t("common.reset")} ${window.I18n.t("common.all")}`,
          ),
        );
        reset.disabled =
          busy ||
          motionRunning ||
          !Object.values(project?.data_json?.frames || {}).some(
            (frame) => frame.stages?.split?.state === "ready",
          );
        reset.addEventListener("click", () => {
          menu.remove();
          activeFrameMenu = null;
          trigger.setAttribute("aria-expanded", "false");
          void resetAllFlowResults();
        });
        menu.append(reset);
      }
      document.body.append(menu);
      activeFrameMenu = menu;
      trigger.setAttribute("aria-expanded", "true");
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 8))}px`;
      (action.disabled ? trigger : action).focus();
    });
    label.append(trigger);
  }
  async function acknowledgeRecutUploads(frameId) {
    if (!window.MotionRunJournal?.supersedeFrameUpload || scopeInvalid) return;
    const scope = { userId, toolProjectId: projectId };
    const run = await window.MotionRunJournal.get(scope);
    const frame = project?.data_json?.frames?.[frameId];
    if (
      !run ||
      run.flowProjectId !== project.flow_project_id ||
      run.sourceRevision !== Number(project.data_json?.source_revision) ||
      !frame
    )
      return;
    for (const [operationId, operation] of Object.entries(
      run.operations || {},
    )) {
      if (
        operation.stage !== "upload" ||
        operation.frameId !== frameId ||
        operation.frameRunId === frame.run_id ||
        operation.inputRevision >= frame.input_revision
      )
        continue;
      await window.MotionRunJournal.supersedeFrameUpload({
        ...scope,
        operationId,
        project,
      });
    }
  }
  async function recutFrame(frameId) {
    if (scopeInvalid || busy || motionRunning || !profile) return;
    if (
      !(await window.customDialog.confirm(
        motionFormat(
          "text249",
          "C\u1EAFt l\u1EA1i {0} s\u1EBD x\xF3a l\u1EDDi tho\u1EA1i, upload v\xE0 k\u1EBFt qu\u1EA3 Flow c\u1EE7a frame n\xE0y. Ti\u1EBFp t\u1EE5c?",
          [frameId],
        ),
        {
          title: motionText("text228", "C\u1EAFt l\u1EA1i frame"),
          confirmText: motionText("text098", "C\u1EAFt l\u1EA1i"),
          cancelText: motionText("text006", "H\u1EE7y"),
        },
      ))
    )
      return;
    busy = true;
    cancelled = false;
    startActivity();
    updateButtons();
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              const revision = Number(project.data_json.source_revision);
              const frame = project.data_json.frames?.[frameId];
              if (
                !frame ||
                !["ready", "pending"].includes(frame.stages?.split?.state)
              )
                throw new Error("MOTION_SPLIT_NOT_READY");
              const submit = frame.stages?.submit;
              if (
                ["running", "needs_review"].includes(submit?.state) ||
                (submit?.state === "ready" &&
                  !["ready", "failed"].includes(frame.stages?.monitor?.state))
              )
                throw new Error("FRAME_OPERATION_MUST_RECONCILE");
              const source = await MotionArtifactStore.get({
                userId,
                toolProjectId: projectId,
                sourceRevision: revision,
                kind: "source_video",
              });
              if (!source?.blob) throw new Error("MOTION_SOURCE_NOT_AVAILABLE");
              const preferences = project.data_json.preferences || {};
              const includeAudio = true;
              const id = crypto.randomUUID();
              const output = await new Promise((resolve, reject) => {
                let clip = null,
                  audio = null,
                  plan = null;
                worker = new Worker(
                  chrome.runtime.getURL("src/core/video-split-worker.js"),
                );
                const finish = (error, value) => {
                  worker?.terminate();
                  worker = null;
                  cancelSplit = null;
                  error ? reject(error) : resolve(value);
                };
                cancelSplit = () => finish(new Error("MOTION_CANCELLED"));
                worker.onerror = (event) =>
                  finish(new Error(event.message || "SPLIT_WORKER_FAILED"));
                worker.onmessage = (event) => {
                  const msg = event.data || {};
                  if (msg.id !== id) return;
                  if (
                    ["audio_diagnostic", "media_diagnostic"].includes(msg.type)
                  ) {
                    console.warn(
                      msg.type === "audio_diagnostic"
                        ? "[MotionAudioDecode]"
                        : "[MotionMediaDecode]",
                      JSON.stringify({ runId: id, ...msg.diagnostic }),
                    );
                    return;
                  }
                  if (msg.type === "error") return finish(new Error(msg.code));
                  if (msg.type === "plan") plan = msg;
                  if (msg.type === "clip") clip = msg;
                  if (msg.type === "audio") audio = msg;
                  if (msg.type === "progress") {
                    $("progress").value = msg.percent;
                    status(
                      motionFormat(
                        "text213",
                        "\u0110ang c\u1EAFt {0} \xB7 {1}%...",
                        [frameId, msg.percent],
                      ),
                    );
                  }
                  if (msg.type === "done") {
                    if (
                      !clip?.blob ||
                      !plan ||
                      (plan.audioState === "audio_present" && !audio?.blob)
                    )
                      return finish(new Error("SPLIT_ARTIFACT_COUNT_MISMATCH"));
                    finish(null, { clip, audio, audioState: plan.audioState });
                  }
                };
                worker.postMessage({
                  type: "split",
                  mode: "motion",
                  id,
                  blob: source.blob,
                  includeAudio,
                  maxSeconds: Number(profile.settings?.max_split_clip_seconds),
                  range: { start: Number(frame.start), end: Number(frame.end) },
                });
              });
              await refresh();
              const current = project.data_json.frames?.[frameId];
              if (
                scopeInvalid ||
                Number(project.data_json.source_revision) !== revision ||
                !current ||
                current.run_id !== frame.run_id ||
                current.input_revision !== frame.input_revision
              )
                throw new Error("FRAME_SCOPE_CHANGED");
              project = await api(
                "POST",
                `${endpoint}/frames/${encodeURIComponent(frameId)}/recut`,
                { revision: project.revision, source_revision: revision },
              );
              const next = project.data_json.frames[frameId];
              sourceUploadReceipts.delete(frameId);
              if (selectedFrameId === frameId) closeFrameDialog();
              await acknowledgeRecutUploads(frameId).catch((error) =>
                console.warn("[MotionRecut]", {
                  frameId,
                  stage: "journal_reset",
                  code: error?.message,
                }),
              );
              const records = await MotionArtifactStore.listProject(
                userId,
                projectId,
              );
              for (const record of records) {
                if (
                  record.sourceRevision !== revision ||
                  !(
                    (record.frameId === frameId &&
                      [
                        "source_clip",
                        "source_audio",
                        "poster",
                        "generated_clip",
                      ].includes(record.kind)) ||
                    record.kind === "merged_video"
                  )
                )
                  continue;
                await MotionArtifactStore.delete({
                  userId,
                  toolProjectId: projectId,
                  sourceRevision: revision,
                  frameId: record.frameId,
                  kind: record.kind,
                  artifactRevision: record.artifactRevision,
                });
              }
              await MotionArtifactStore.put({
                userId,
                toolProjectId: projectId,
                flowProjectId: project.flow_project_id,
                sourceRevision: revision,
                frameId,
                kind: "source_clip",
                blob: output.clip.blob,
                duration: output.clip.duration,
              });
              if (output.audio)
                await MotionArtifactStore.put({
                  userId,
                  toolProjectId: projectId,
                  flowProjectId: project.flow_project_id,
                  sourceRevision: revision,
                  frameId,
                  kind: "source_audio",
                  blob: output.audio.blob,
                  duration: output.audio.duration,
                });
              await api(
                "PATCH",
                `${endpoint}/frames/${encodeURIComponent(frameId)}/checkpoint`,
                {
                  source_revision: revision,
                  run_id: next.run_id,
                  input_revision: next.input_revision,
                  stage: "split",
                  state: "ready",
                  artifact_id: `clip_${revision}_${frameId}`,
                  audio_state: output.audioState,
                  audio_artifact_id: output.audio
                    ? `audio_${revision}_${frameId}`
                    : null,
                },
              );
              await refresh();
              status(
                motionFormat("text214", "\u0110\xE3 c\u1EAFt l\u1EA1i {0}.", [
                  frameId,
                ]),
              );
            },
          );
        },
      );
    } catch (error) {
      status(motionErrorMessage(error));
      await window.customDialog?.alert?.(
        motionErrorMessage(
          error ||
            motionText(
              "text133",
              "Kh\xF4ng c\u1EAFt \u0111\u01B0\u1EE3c frame",
            ),
        ),
        {
          title: motionText("text228", "C\u1EAFt l\u1EA1i frame"),
          type: "error",
        },
      );
    } finally {
      busy = false;
      cancelSplit = null;
      worker?.terminate();
      worker = null;
      settleActivity();
      updateButtons();
      if (!scopeInvalid) await refresh().catch(() => {});
    }
  }
  function split(
    file,
    maxSeconds,
    sourceRevision,
    includeAudio,
    cutStrategy = "silence",
  ) {
    const timeoutMs = window.MotionMergeTask.timeoutMs();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      runId = id;
      const clips = [];
      const audios = [];
      const writes = [];
      const pendingAudio = new Map();
      let plan = null;
      let settled = false;
      let writeError = null;
      let failed = false;
      let timer;
      worker = new Worker(
        chrome.runtime.getURL("src/core/video-split-worker.js"),
      );
      const fail = (error) => {
        failed = true;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (worker) {
          worker.onmessage = worker.onerror = null;
          worker.terminate();
          worker = null;
        }
        Promise.allSettled(writes).then(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      };
      cancelSplit = () => fail(new Error("MOTION_CANCELLED"));
      worker.onerror = (event) =>
        fail(new Error(event.message || "SPLIT_WORKER_FAILED"));
      worker.onmessage = (event) => {
        const message = event.data || {};
        if (message.id !== id || settled) return;
        if (["audio_diagnostic", "media_diagnostic"].includes(message.type)) {
          console.warn(
            message.type === "audio_diagnostic"
              ? "[MotionAudioDecode]"
              : "[MotionMediaDecode]",
            JSON.stringify({ runId: id, ...message.diagnostic }),
          );
          return;
        }
        if (message.type === "error") {
          fail(new Error(message.code));
          return;
        }
        if (message.type === "plan") {
          if ((message.cutStrategy || "silence") !== cutStrategy) {
            fail(new Error("MOTION_SPLIT_PLAN_INVALID"));
            return;
          }
          if (
            message.cutStrategy &&
            (!Number.isSafeInteger(message.quietCuts) ||
              message.quietCuts < 0 ||
              !Number.isSafeInteger(message.timeCuts) ||
              message.timeCuts < 0 ||
              message.quietCuts + message.timeCuts !== message.count - 1 ||
              (cutStrategy === "duration" && message.quietCuts !== 0))
          ) {
            fail(new Error("MOTION_SPLIT_PLAN_INVALID"));
            return;
          }
          plan = message;
          timelineStructureKey = null;
          timelineRenderEpoch++;
          for (const track of [
            "timelineRuler",
            "sourceTrack",
            "resultTrack",
            "subtitleTrack",
            "audioTrack",
          ])
            for (const child of $(track).children)
              child.disposeTimelineTile?.();
          for (const url of timelineThumbUrls) URL.revokeObjectURL(url);
          timelineThumbUrls.clear();
          for (const track of [
            "sourceTrack",
            "resultTrack",
            "subtitleTrack",
            "audioTrack",
            "timelineRuler",
          ])
            $(track).replaceChildren();
          return;
        }
        if (message.type === "progress") {
          $("progress").value = Math.round(
            (100 * (message.index + message.percent / 100)) / message.count,
          );
          status(
            motionFormat("text215", "\u0110ang c\u1EAFt {0}/{1} \xB7 {2}%...", [
              message.index + 1,
              message.count,
              message.percent,
            ]),
          );
          return;
        }
        if (message.type === "clip" || message.type === "audio") {
          const index = message.index;
          const frameId = `f${String(index + 1).padStart(4, "0")}`;
          const kind = message.type === "clip" ? "source_clip" : "source_audio";
          const target = message.type === "clip" ? clips : audios;
          const write = MotionArtifactStore.put({
            userId,
            toolProjectId: projectId,
            flowProjectId: project.flow_project_id,
            sourceRevision,
            frameId,
            kind,
            blob: message.blob,
            duration: message.duration,
          });
          writes.push(
            write
              .then(() => {
                if (failed || scopeInvalid || cancelled || runId !== id) return;
                if (kind === "source_audio") {
                  pendingAudio.set(frameId, message.blob);
                  const tile = $("audioTrack").querySelector(
                    `[data-frame-id="${frameId}"]`,
                  );
                  if (tile) {
                    tile.disabled = false;
                    tile.classList.remove("empty");
                    tile.classList.add("is-ready");
                    renderAudioTile(
                      tile,
                      frameId,
                      true,
                      sourceRevision,
                      message.blob,
                    );
                  }
                  return;
                }
                const frame = {
                  start: message.start,
                  end: message.end,
                  input_revision: 1,
                  stages: { split: { state: "ready" } },
                };
                const source = timelineTile(
                  frameId,
                  frame,
                  "source_clip",
                  true,
                  sourceRevision,
                  timelineRenderEpoch,
                  () => {
                    if (!scopeInvalid && !cancelled && runId === id)
                      playBlob(message.blob, `${frameId} \xB7 Video g\u1ED1c`);
                  },
                );
                const result = timelineTile(
                  frameId,
                  frame,
                  "generated_clip",
                  false,
                  sourceRevision,
                  timelineRenderEpoch,
                  () =>
                    status(
                      motionText(
                        "text155",
                        "\u0110ang c\u1EAFt video ngu\u1ED3n...",
                      ),
                    ),
                );
                const sub = document.createElement("button");
                sub.type = "button";
                sub.disabled = true;
                sub.className = "timeline-clip subtitle empty";
                const subText = document.createElement("span");
                subText.textContent = motionText(
                  "text168",
                  "Ch\u1EDD l\u1EDDi tho\u1EA1i...",
                );
                sub.append(subText);
                sub.style.width = `${timelineWidth(frame)}px`;
                sub.style.minWidth = sub.style.width;
                const audio = document.createElement("button");
                audio.type = "button";
                audio.className = "timeline-clip subtitle audio-clip empty";
                audio.dataset.frameId = frameId;
                audio.style.width = sub.style.width;
                audio.style.minWidth = sub.style.width;
                audio.disabled = !pendingAudio.has(frameId);
                renderAudioTile(
                  audio,
                  frameId,
                  !audio.disabled,
                  sourceRevision,
                  pendingAudio.get(frameId),
                );
                audio.addEventListener("click", () => {
                  if (
                    !scopeInvalid &&
                    !cancelled &&
                    runId === id &&
                    pendingAudio.has(frameId)
                  )
                    playBlob(
                      pendingAudio.get(frameId),
                      `${frameId} \xB7 Audio`,
                    );
                });
                const mark = document.createElement("span");
                mark.className = "ruler-mark";
                mark.textContent = `${Number(frame.start).toFixed(1)}s`;
                mark.style.width = `${timelineWidth(frame) + 10}px`;
                for (const tile of [source, result, sub, audio, mark])
                  tile.style.order = String(index);
                $("sourceTrack").append(source);
                $("resultTrack").append(result);
                $("subtitleTrack").append(sub);
                $("audioTrack").append(audio);
                $("timelineRuler").append(mark);
                $("frameCount").textContent =
                  `${$("sourceTrack").children.length}/${message.count} frame`;
              })
              .catch((error) => {
                writeError || (writeError = error);
                fail(error);
                return null;
              }),
          );
          target[index] = {
            frameId,
            start: message.start,
            end: message.end,
            duration: message.duration,
            size: message.blob.size,
          };
          $("progress").value = Math.round((100 * (index + 1)) / message.count);
          return;
        }
        if (message.type === "done") {
          settled = true;
          clearTimeout(timer);
          worker?.terminate();
          worker = null;
          Promise.all(writes)
            .then(() => {
              if (writeError) throw writeError;
              if (
                !plan ||
                clips.length !== message.count ||
                clips.some((item) => !item) ||
                (plan.audioState === "audio_present" &&
                  (audios.length !== message.count ||
                    audios.some((item) => !item)))
              ) {
                throw new Error("SPLIT_ARTIFACT_COUNT_MISMATCH");
              }
              cancelSplit = null;
              resolve({ plan, clips, audios });
            })
            .catch(reject);
        }
      };
      timer = setTimeout(
        () => fail(new Error("MOTION_SPLIT_TIMEOUT")),
        timeoutMs,
      );
      try {
        worker.postMessage({
          type: "split",
          mode: "motion",
          includeAudio,
          cutStrategy,
          id,
          blob: file,
          maxSeconds,
        });
      } catch (error) {
        fail(error);
      }
    });
  }
  async function releaseInterruptedSplitForManualCut(sourceRevision) {
    const records = await MotionArtifactStore.listProject(userId, projectId);
    const journals = records.filter(
      (item) =>
        item.kind === "split_journal" && item.sourceRevision === sourceRevision,
    );
    if (
      !journals.length ||
      (journals.length === 1 && journals[0].state === "committed")
    )
      return;
    const journal = journals[0];
    const matches = (value) =>
      !scopeInvalid &&
      value?.tool_project_id === projectId &&
      value.flow_project_id === journal.flowProjectId &&
      sourceRevision === 1 &&
      Number(value.data_json?.source_revision || 0) === 0 &&
      !Object.keys(value.data_json?.frames || {}).length &&
      (!value.data_json?.split_operation ||
        (value.data_json.split_operation.operation_id === journal.operationId &&
          value.data_json.split_operation.draft_id === journal.draftId));
    if (journals.length !== 1 || !matches(project))
      throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
    if (project.data_json?.split_operation?.state === "running") {
      try {
        project = await api("POST", `${endpoint}/split-attempt`, {
          revision: project.revision,
          operation_id: journal.operationId,
          draft_id: journal.draftId,
          state: "failed",
          error_code: "MOTION_SPLIT_SUPERSEDED",
        });
      } catch (error) {
        const current = await api("GET", endpoint).catch(() => null);
        if (
          !matches(current) ||
          current.data_json?.split_operation?.state !== "failed"
        )
          throw error;
        project = current;
      }
    }
    if (
      !matches(project) ||
      project.data_json?.split_operation?.state === "running"
    )
      throw new Error("MOTION_SPLIT_SCOPE_CHANGED");
    await MotionArtifactStore.clearInterruptedSplitJournal({
      userId,
      toolProjectId: projectId,
      flowProjectId: journal.flowProjectId,
      sourceRevision,
      operationId: journal.operationId,
      draftId: journal.draftId,
    });
    console.info(
      "[MotionSplitRecovery]",
      JSON.stringify({
        projectId,
        sourceRevision,
        operationId: journal.operationId,
        stage: "interrupted_journal_released",
        paused: project.data_json?.paused === true,
      }),
    );
  }
  async function openMotionTemplates() {
    if (scopeInvalid || busy || motionSettingsRunLocked() || !profile) return;
    if (window.featureGate?.canUse?.("motion_tool_enabled") !== true) return;
    if (settingsDirty || settingsSaveTimer) await saveMotionSettings();
    const library = new MotionTemplateLibrary({
      api: (...args) => window.authManager._apiCall(...args),
      text: (key, values) => window.I18n.t(`motionTemplates.${key}`, values),
      onApply: applyMotionTemplate,
    });
    await library.open();
  }
  async function prepareTemplateDraft() {
    const template = project?.data_json?.pending_motion_template;
    if (
      !template ||
      !pendingSourceFile ||
      Number(project.data_json?.source_revision || 0) !== 0
    )
      return;
    const message = window.I18n.t("motionTemplates.applying", {
      ratio: project.data_json.preferences?.ratio,
    });
    const lock = MotionTemplateLibrary.lock(message);
    motionToast(message, { persistent: true, loading: true });
    try {
      if (!ratios.includes(project.data_json.preferences?.ratio))
        throw new Error("MOTION_TEMPLATE_RATIO_UNAVAILABLE");
      const prepared = await prepareSource({
        template,
        expected: { revision: project.revision, sourceRevision: 0 },
        replacementConfirmed: true,
      });
      const result = window.I18n.t(
        prepared ? "motionTemplates.applied" : "motionTemplates.notApplied",
      );
      motionToast(result, { error: !prepared });
    } catch (error) {
      motionToast(motionErrorMessage(error), { error: true });
    } finally {
      lock.close();
    }
  }
  async function applyMotionTemplate(template) {
    if (scopeInvalid || busy || motionSettingsRunLocked()) return false;
    if (settingsDirty || settingsSaveTimer) await saveMotionSettings();
    if (settingsDirty || scopeInvalid || busy || motionSettingsRunLocked())
      return false;
    const expected = {
      revision: project.revision,
      sourceRevision: Number(project.data_json?.source_revision || 0),
    };
    const oldPending = pendingSourceFile,
      oldDraft = pendingBulkDraftKey;
    const controller = new AbortController();
    const assertCurrent = () => {
      if (
        scopeInvalid ||
        window.featureGate?.canUse?.("motion_tool_enabled") !== true
      )
        throw new Error("ACCOUNT_SCOPE_CHANGED");
    };
    let timer = null,
      lastPercent = -1;
    busy = true;
    updateButtons();
    const notice = (key, args = {}) => {
      const message = window.I18n.t(`motionTemplates.${key}`, args);
      status(message, { state: "running" });
      motionToast(message, { persistent: true, loading: true });
    };
    try {
      const ratios2 = [...$("motionRatio").options].map(
        (option) => option.value,
      );
      if (!ratios2.includes(template.ratio))
        throw new Error("MOTION_TEMPLATE_RATIO_UNAVAILABLE");
      const timeout = Number(
        window.SystemConfig?.safeGetTimeout?.("api_timeout_ms"),
      );
      if (!Number.isFinite(timeout) || timeout <= 0)
        throw new Error("CONFIG_REQUIRED:api_timeout_ms");
      timer = setTimeout(() => controller.abort(), timeout);
      notice("downloading", { percent: 0 });
      const file = await MotionTemplateLibrary.download(template, {
        signal: controller.signal,
        assertCurrent,
        progress: (percent) => {
          if (percent !== lastPercent) {
            lastPercent = percent;
            notice("downloading", { percent });
          }
        },
      });
      clearTimeout(timer);
      timer = null;
      assertCurrent();
      notice("downloaded");
      const replacement =
        !!oldPending ||
        expected.sourceRevision > 0 ||
        !!project.data_json?.preferences?.custom_prompt;
      if (
        replacement &&
        !(await window.customDialog.confirm(
          window.I18n.t("motionTemplates.confirmReplace"),
          {
            title: window.I18n.t("motionTemplates.apply"),
            confirmText: motionText("replace", "Thay th\u1EBF"),
            cancelText: motionText("text006", "H\u1EE7y"),
          },
        ))
      ) {
        status(window.I18n.t("motionTemplates.notApplied"), { state: "ready" });
        motionToast(window.I18n.t("motionTemplates.notApplied"));
        return false;
      }
      assertCurrent();
      pendingSourceFile = file;
      pendingBulkDraftKey = null;
      notice("applying", { ratio: template.ratio });
      const prepared = await prepareSource({
        template,
        expected,
        replacementConfirmed: true,
      });
      if (!prepared) {
        pendingSourceFile = oldPending;
        pendingBulkDraftKey = oldDraft;
        await refresh();
        motionToast(window.I18n.t("motionTemplates.notApplied"), {
          error: true,
        });
        return false;
      }
      const message = window.I18n.t("motionTemplates.applied");
      status(message, { state: "ready" });
      motionToast(message);
      return true;
    } catch (error) {
      pendingSourceFile = oldPending;
      pendingBulkDraftKey = oldDraft;
      const key = {
        MOTION_TEMPLATE_RATIO_UNAVAILABLE: "ratioUnavailable",
        MOTION_TEMPLATE_VIDEO_INVALID: "videoInvalid",
        MOTION_TEMPLATE_DOWNLOAD_FAILED: "downloadFailed",
        MOTION_TEMPLATE_CHANGED: "changed",
      }[error?.code || error?.message];
      const message =
        error?.name === "AbortError" || error instanceof TypeError
          ? window.I18n.t("motionTemplates.downloadFailed")
          : key
            ? window.I18n.t(`motionTemplates.${key}`)
            : motionErrorMessage(error);
      status(message, { state: "failed" });
      motionToast(message, { error: true });
      return false;
    } finally {
      clearTimeout(timer);
      busy = false;
      updateButtons();
    }
  }
  function motionSpeedFormat(key, values) {
    const translated = motionFormat(key, "", values);
    if (translated && translated !== `motionEditor.${key}`) return translated;
    const source = motionText("text008", ""),
      final = motionText("text040", "");
    if (key === "finalSpeedHint")
      return `${source} ${values[0]}\xD7 \u2192 ${final} ${values[1]}\xD7`;
    if (key === "finalSpeedApplied")
      return `${source} ${values[0]}\xD7 \xB7 ${final} ${values[1]}\xD7`;
    if (key === "finalSpeedCompensated")
      return `${motionText("text096", "")} \xB7 ${source} ${values[0]}\xD7 \u2713`;
    const processing =
      key === "speedProcessing" || key === "finalSpeedProcessing";
    return [
      motionText(processing ? "text056" : "text096", ""),
      key.startsWith("final") ? final : source,
      `${values[0]}\xD7`,
      processing
        ? `${values[1]}%`
        : key === "speedReady"
          ? motionText("text046", "")
          : null,
    ]
      .filter(Boolean)
      .join(" \xB7 ");
  }
  function renderSourceMeta(
    fileName,
    duration,
    playbackRate,
    { pending = false } = {},
  ) {
    const meta = $("sourceMeta");
    if (!meta) return;
    const parts = [fileName];
    if (Number.isFinite(duration)) parts.push(`${duration.toFixed(1)}s`);
    if (pending) parts.push(motionText("text046", ""));
    meta.replaceChildren(
      document.createTextNode(parts.filter(Boolean).join(" \xB7 ")),
    );
    if (
      Number.isFinite(playbackRate) &&
      playbackRate > 0 &&
      playbackRate !== 1
    ) {
      const speed = document.createElement("span");
      speed.className = "motion-source-speed";
      speed.textContent = `${Number(playbackRate.toFixed(3))}\xD7`;
      meta.append(document.createTextNode(" \xB7 "), speed);
    }
    meta.title = meta.textContent;
  }
  function renderFinalSpeedHint(records, sourceRevision) {
    const hint = $("finalSpeedHint"),
      select = $("finalSpeedBtn");
    if (!hint || !select) return;
    try {
      hint.hidden = true;
      hint.textContent = "";
      select.removeAttribute("title");
      for (const option of [...select.options]) {
        if (option.dataset.recommendedExtra) option.remove();
        else {
          option.textContent = option.dataset.baseLabel || option.textContent;
          option.dataset.baseLabel = option.textContent;
        }
      }
      const source = records.find(
        (item) =>
          item.kind === "source_video" &&
          item.sourceRevision === sourceRevision,
      );
      const rate = source?.playbackRate;
      if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) return;
      const final = records.find(
        (item) =>
          item.kind === "merged_video" &&
          item.sourceRevision === sourceRevision &&
          item.artifactRevision === Number(finalArtifact?.artifact_revision),
      );
      const applied = final?.playbackRate;
      const rateLabel = String(Number(rate.toFixed(3))),
        inverse = 1 / rate;
      if (Number.isFinite(applied) && applied > 1) {
        hint.textContent =
          Math.abs(rate * applied - 1) < 0.005
            ? motionSpeedFormat("finalSpeedCompensated", [rateLabel])
            : motionSpeedFormat("finalSpeedApplied", [
                rateLabel,
                String(Number(applied.toFixed(2))),
              ]);
      } else {
        const inverseLabel = String(Number(inverse.toFixed(2)));
        hint.textContent = motionSpeedFormat("finalSpeedHint", [
          rateLabel,
          inverseLabel,
        ]);
        let option = [...select.options].find(
          (item) => item.value && Math.abs(Number(item.value) - rate) < 1e-9,
        );
        if (!option) {
          option = document.createElement("option");
          option.value = String(rate);
          option.textContent = `${inverseLabel}\xD7 (${rateLabel}\xD7)`;
          option.dataset.recommendedExtra = "true";
          select.append(option);
        }
        option.textContent += " \u2605";
      }
      select.title = hint.textContent;
      hint.hidden = false;
    } catch (_) {
      hint.hidden = true;
    }
  }
  async function speedFinalVideo(playbackRate) {
    if (!Number.isFinite(playbackRate) || playbackRate <= 1) return false;
    if (
      scopeInvalid ||
      busy ||
      motionSettingsRunLocked() ||
      settingsSaveTimer ||
      finalDownloadPending ||
      !finalArtifact
    )
      return false;
    const owner = {
      userId,
      projectId,
      flowProjectId: project?.flow_project_id,
    };
    const operationId = crypto.randomUUID();
    const label = String(Number(playbackRate.toFixed(2)));
    let sourceRevision,
      artifactRevision,
      stored = false,
      committed = false;
    const assertOwner = () => {
      if (
        scopeInvalid ||
        userId !== owner.userId ||
        projectId !== owner.projectId
      )
        throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (cancelled) throw new Error("MOTION_CANCELLED");
      if (project?.flow_project_id !== owner.flowProjectId)
        throw new Error("MOTION_FINAL_SCOPE_CHANGED");
    };
    busy = true;
    cancelled = false;
    startActivity();
    updateButtons();
    $("progress").value = 0;
    status(motionSpeedFormat("finalSpeedProcessing", [label, 0]), {
      state: "running",
    });
    try {
      await window.ExecutionConfig.getConfig();
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${owner.userId}:${owner.projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${owner.userId}:${owner.projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              assertOwner();
              if (
                motionSettingsRunLocked() ||
                !finalArtifact ||
                finalArtifact.stale === true
              )
                throw new Error("MOTION_FINAL_SCOPE_CHANGED");
              const previous = structuredClone(project.data_json.final);
              const revision = project.revision;
              sourceRevision = Number(previous.source_revision);
              const blob = await finalBlob();
              assertOwner();
              status(motionSpeedFormat("finalSpeedProcessing", [label, 0]), {
                state: "running",
              });
              const task = window.MotionMergeTask.setSpeed(
                blob,
                playbackRate,
                (progress) => {
                  if (scopeInvalid || cancelled) return;
                  $("progress").value = progress.percent;
                  status(
                    motionSpeedFormat("finalSpeedProcessing", [
                      label,
                      progress.percent,
                    ]),
                    { state: "running" },
                  );
                },
              );
              worker = task.worker;
              cancelSplit = () => task.cancel();
              let result;
              try {
                result = await task.promise;
              } finally {
                if (worker === task.worker) worker = null;
                cancelSplit = null;
              }
              assertOwner();
              if (
                !(result?.blob instanceof Blob) ||
                !result.blob.size ||
                !Number.isFinite(result.duration) ||
                result.duration <= 0
              )
                throw new Error("MOTION_VIDEO_SPEED_FAILED");
              const fresh = await api("GET", endpoint);
              assertOwner();
              if (
                fresh.revision !== revision ||
                fresh.flow_project_id !== owner.flowProjectId ||
                Number(fresh.data_json?.source_revision) !== sourceRevision ||
                fresh.data_json?.final?.artifact_id !== previous.artifact_id ||
                fresh.data_json?.final?.artifact_revision !==
                  previous.artifact_revision
              )
                throw new Error("MOTION_FINAL_SCOPE_CHANGED");
              artifactRevision =
                Number(fresh.data_json.final_artifact_revision) + 1;
              const artifactId = `speed_${sourceRevision}_${artifactRevision}_${operationId}`;
              const scope = {
                userId: owner.userId,
                toolProjectId: owner.projectId,
                sourceRevision,
                kind: "merged_video",
                artifactRevision,
              };
              await MotionArtifactStore.put({
                ...scope,
                flowProjectId: owner.flowProjectId,
                blob: result.blob,
                duration: result.duration,
                playbackRate:
                  playbackRate *
                  ((
                    await MotionArtifactStore.get({
                      ...scope,
                      artifactRevision: Number(previous.artifact_revision),
                    })
                  )?.playbackRate || 1),
              });
              stored = true;
              assertOwner();
              try {
                project = await api("POST", `${endpoint}/finalize`, {
                  revision: fresh.revision,
                  source_revision: sourceRevision,
                  artifact_revision: artifactRevision,
                  artifact_id: artifactId,
                  duration: result.duration,
                  frame_ids: previous.frame_ids,
                  use_original_audio: previous.use_original_audio === true,
                });
                committed = true;
              } catch (error) {
                const latest = !scopeInvalid
                  ? await api("GET", endpoint).catch(() => null)
                  : null;
                if (
                  latest?.data_json?.final?.artifact_id === artifactId &&
                  Number(latest.data_json.final.source_revision) ===
                    sourceRevision &&
                  Number(latest.data_json.final.artifact_revision) ===
                    artifactRevision
                ) {
                  project = latest;
                  committed = true;
                } else {
                  if (
                    latest &&
                    Number(latest.data_json?.source_revision) ===
                      sourceRevision &&
                    Number(latest.data_json?.final_artifact_revision || 0) <
                      artifactRevision
                  )
                    await MotionArtifactStore.delete(scope).catch(() => {});
                  throw error;
                }
              }
              assertOwner();
              await refresh();
              assertOwner();
              await MotionArtifactStore.delete({
                userId: owner.userId,
                toolProjectId: owner.projectId,
                sourceRevision,
                kind: "merged_video",
                artifactRevision: Number(previous.artifact_revision),
              }).catch(() => {});
              $("progress").value = 100;
              status(motionSpeedFormat("finalSpeedReady", [label]), {
                state: "ready",
              });
            },
          );
        },
      );
    } catch (error) {
      if (!scopeInvalid) status(motionErrorMessage(error));
      console.warn(
        "[MotionFinalSpeed]",
        JSON.stringify({
          operationId,
          sourceRevision,
          artifactRevision,
          stored,
          committed,
          code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message || "")
            ? error.message
            : "MOTION_VIDEO_SPEED_FAILED",
        }),
      );
    } finally {
      busy = false;
      cancelSplit = null;
      worker?.terminate();
      worker = null;
      settleActivity();
      updateButtons();
    }
    return committed;
  }
  async function slowSourceVideo(playbackRate) {
    if (![0.7, 0.6, 0.5, 0.4].includes(playbackRate)) return false;
    if (
      scopeInvalid ||
      busy ||
      motionSettingsRunLocked() ||
      settingsSaveTimer ||
      !profile
    )
      return;
    const owner = {
      userId,
      projectId,
      flowProjectId: project?.flow_project_id,
    };
    const pending = pendingSourceFile;
    const sourceRevision = Number(project?.data_json?.source_revision || 0);
    const operationId = crypto.randomUUID();
    const assertCurrent = () => {
      if (
        scopeInvalid ||
        userId !== owner.userId ||
        projectId !== owner.projectId
      )
        throw new Error("ACCOUNT_SCOPE_CHANGED");
      if (cancelled) throw new Error("MOTION_CANCELLED");
      if (
        project?.flow_project_id !== owner.flowProjectId ||
        Number(project?.data_json?.source_revision || 0) !== sourceRevision ||
        pendingSourceFile !== pending
      )
        throw new Error("MOTION_SOURCE_DRAFT_CHANGED");
    };
    let replaced = false;
    busy = true;
    cancelled = false;
    startActivity();
    updateButtons();
    $("progress").value = 0;
    status(motionSpeedFormat("speedProcessing", [playbackRate, 0]), {
      state: "running",
    });
    try {
      await window.ExecutionConfig.getConfig();
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${owner.userId}:${owner.projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${owner.userId}:${owner.projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              assertCurrent();
              status(motionSpeedFormat("speedProcessing", [playbackRate, 0]), {
                state: "running",
              });
              if (motionSettingsRunLocked())
                throw new Error("MOTION_SETTINGS_LOCKED");
              const sourceRecord = pending
                ? null
                : await MotionArtifactStore.get({
                    userId: owner.userId,
                    toolProjectId: owner.projectId,
                    sourceRevision,
                    kind: "source_video",
                  });
              const source = pending || sourceRecord?.blob;
              const cumulativeRate =
                playbackRate *
                (pending
                  ? sourcePlaybackRates.get(pending) || 1
                  : sourceRecord?.playbackRate || 1);
              assertCurrent();
              if (!source?.size)
                throw new Error("MOTION_SOURCE_LOCAL_BLOB_MISSING");
              const task = window.MotionMergeTask.setSpeed(
                source,
                playbackRate,
                (progress) => {
                  if (scopeInvalid || cancelled) return;
                  $("progress").value = progress.percent;
                  status(
                    motionSpeedFormat("speedProcessing", [
                      playbackRate,
                      progress.percent,
                    ]),
                    { state: "running" },
                  );
                },
              );
              worker = task.worker;
              cancelSplit = () => task.cancel();
              let result;
              try {
                result = await task.promise;
              } finally {
                if (worker === task.worker) worker = null;
                cancelSplit = null;
              }
              assertCurrent();
              if (
                !(result?.blob instanceof Blob) ||
                !result.blob.size ||
                !Number.isFinite(result.duration) ||
                result.duration <= 0
              )
                throw new Error("MOTION_VIDEO_SPEED_FAILED");
              const fresh = await api("GET", endpoint);
              assertCurrent();
              if (
                fresh.flow_project_id !== owner.flowProjectId ||
                fresh.revision !== project.revision ||
                Number(fresh.data_json?.source_revision || 0) !== sourceRevision
              )
                throw new Error("MOTION_SOURCE_DRAFT_CHANGED");
              const name =
                pending?.name ||
                project.data_json?.source?.file_name ||
                "video.mp4";
              const file = new File(
                [result.blob],
                name.replace(/\.[^.]+$/, "") + `_${playbackRate}x.mp4`,
                { type: "video/mp4" },
              );
              await MotionArtifactStore.saveSourceDraft({
                userId: owner.userId,
                toolProjectId: owner.projectId,
                flowProjectId: owner.flowProjectId,
                blob: file,
                fileName: file.name,
                baseSourceRevision: sourceRevision,
                playbackRate: cumulativeRate,
              });
              assertCurrent();
              sourcePlaybackRates.set(file, cumulativeRate);
              pendingSourceFile = file;
              pendingBulkDraftKey = null;
              await setStageVideo(
                "source",
                `pending:speed:${operationId}`,
                file,
              );
              $("sourceInput").value = "";
              renderSourceMeta(file.name, result.duration, cumulativeRate, {
                pending: true,
              });
              $("progress").value = 100;
              status(motionSpeedFormat("speedReady", [playbackRate]), {
                state: "ready",
              });
              replaced = true;
              console.info(
                "[MotionVideoSpeed]",
                JSON.stringify({
                  operationId,
                  stage: "complete",
                  sourceRevision,
                  playbackRate,
                  duration: result.duration,
                  bytes: result.blob.size,
                }),
              );
            },
          );
        },
      );
    } catch (error) {
      if (!scopeInvalid) status(motionErrorMessage(error));
      console.warn(
        "[MotionVideoSpeed]",
        JSON.stringify({
          operationId,
          stage: "failed",
          sourceRevision,
          code: /^[A-Z][A-Z0-9_]{0,99}$/.test(error?.message || "")
            ? error.message
            : "MOTION_VIDEO_SPEED_FAILED",
        }),
      );
    } finally {
      busy = false;
      cancelSplit = null;
      worker?.terminate();
      worker = null;
      settleActivity();
      updateButtons();
    }
    return replaced;
  }
  async function prepareSource(options = {}) {
    if (scopeInvalid || (busy && !options.template) || !profile) return false;
    const forceResplit = options.forceResplit === true;
    const resplitSavedSource =
      forceResplit ||
      (!pendingSourceFile && project?.data_json?.requires_resplit === true);
    const resplitSourceRevision = resplitSavedSource
      ? Number(project.data_json.source_revision || 0)
      : null;
    let file = pendingSourceFile;
    if (resplitSavedSource) {
      const previousRevision = Number(project.data_json.source_revision || 0);
      const savedSource = await MotionArtifactStore.get({
        userId,
        toolProjectId: projectId,
        sourceRevision: previousRevision,
        kind: "source_video",
      });
      file = savedSource?.blob || null;
      if (file && savedSource?.playbackRate)
        sourcePlaybackRates.set(file, savedSource.playbackRate);
    }
    if (!file) {
      status(motionErrorMessage(new Error("MOTION_SOURCE_NOT_AVAILABLE")));
      return false;
    }
    let prepared = false;
    busy = true;
    cancelled = false;
    updateButtons();
    $("progress").value = 0;
    try {
      if (!navigator.locks?.request)
        throw new Error("PROJECT_LOCK_UNAVAILABLE");
      await navigator.locks.request(
        `motion-run:${userId}:${projectId}`,
        { ifAvailable: true },
        async (runLock) => {
          if (!runLock) throw new Error("PROJECT_ALREADY_RUNNING");
          await navigator.locks.request(
            `motion:${userId}:${projectId}`,
            { ifAvailable: true },
            async (lock) => {
              if (!lock) throw new Error("PROJECT_ALREADY_EDITING");
              await refresh();
              if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
              const previousRevision = Number(
                project.data_json?.source_revision || 0,
              );
              if (
                options.template &&
                (project.revision !== options.expected?.revision ||
                  previousRevision !== options.expected?.sourceRevision)
              )
                throw new Error("FRAME_SCOPE_CHANGED");
              if (
                resplitSavedSource &&
                (previousRevision !== resplitSourceRevision ||
                  (!forceResplit &&
                    project.data_json?.requires_resplit !== true))
              )
                throw new Error("SOURCE_CHANGED_DURING_RESPLIT");
              const hasExistingResults =
                Object.keys(project.data_json?.frames || {}).length > 0 ||
                !!project.data_json?.final;
              if (
                !options.replacementConfirmed &&
                previousRevision > 0 &&
                hasExistingResults &&
                !(await window.customDialog.confirm(
                  resplitSavedSource
                    ? motionText(
                        "text244",
                        "C\u1EAFt l\u1EA1i video \u0111\xE3 l\u01B0u s\u1EBD thay m\u1ECDi frame v\xE0 k\u1EBFt qu\u1EA3 c\u0169. Ti\u1EBFp t\u1EE5c?",
                      )
                    : motionText(
                        "text245",
                        "Thay video g\u1ED1c s\u1EBD thay m\u1ECDi frame v\xE0 k\u1EBFt qu\u1EA3 c\u0169. Ti\u1EBFp t\u1EE5c?",
                      ),
                  {
                    title: resplitSavedSource
                      ? motionText("text157", "C\u1EAFt l\u1EA1i video")
                      : motionText("text158", "Thay video g\u1ED1c"),
                    confirmText: motionText("text078", "Ti\u1EBFp t\u1EE5c"),
                    cancelText: motionText("text006", "H\u1EE7y"),
                  },
                ))
              )
                return;
              if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
              startActivity();
              const sourceRevision = previousRevision + 1;
              const profileMaxSeconds = window.MotionSplitPolicy.limit(
                project,
                profile,
              );
              const maxSeconds = profileMaxSeconds;
              if (
                !Number.isFinite(profileMaxSeconds) ||
                profileMaxSeconds < 1 ||
                !Number.isFinite(maxSeconds) ||
                maxSeconds < 1 ||
                maxSeconds > profileMaxSeconds
              )
                throw new Error("INVALID_SPLIT_PROFILE");
              await releaseInterruptedSplitForManualCut(sourceRevision);
              await MotionArtifactStore.deleteSourceRevision(
                userId,
                projectId,
                sourceRevision,
              );
              try {
                status(
                  motionText(
                    "text130",
                    "\u0110ang l\u01B0u video ngu\u1ED3n...",
                  ),
                );
                if (pendingBulkDraftKey && !resplitSavedSource) {
                  await MotionArtifactStore.linkBulkDraftToSource({
                    userId,
                    toolProjectId: projectId,
                    flowProjectId: project.flow_project_id,
                    sourceRevision,
                    draftKey: pendingBulkDraftKey,
                  });
                } else {
                  await MotionArtifactStore.put({
                    userId,
                    toolProjectId: projectId,
                    flowProjectId: project.flow_project_id,
                    sourceRevision,
                    kind: "source_video",
                    blob: file,
                    playbackRate: sourcePlaybackRates.get(file) ?? null,
                  });
                }
                if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                status(motionText("text131", "\u0110ang c\u1EAFt video..."));
                const preferences = {
                  ...(project.data_json?.preferences || {}),
                  ...(options.template?.settings || {}),
                };
                const includeAudio = true;
                const cutStrategy =
                  window.MotionSplitPolicy.desired(preferences);
                const policy = (await window.ExecutionConfig.getConfig())
                  ?.workflow;
                if (
                  !Number.isSafeInteger(policy?.max_retries) ||
                  policy.max_retries < 0 ||
                  !Number.isFinite(policy.delay_nodes_sec) ||
                  policy.delay_nodes_sec < 0
                )
                  throw new Error("EXECUTION_RETRY_CONFIG_INVALID");
                const retryLimit =
                  window.featureGate.canUse("retry_on_fail") === true
                    ? policy.max_retries
                    : 0;
                let result;
                for (let attempt = 0; ; attempt++) {
                  try {
                    result = await split(
                      file,
                      maxSeconds,
                      sourceRevision,
                      includeAudio,
                      cutStrategy,
                    );
                    break;
                  } catch (error) {
                    if (
                      cancelled ||
                      scopeInvalid ||
                      error?.message === "MOTION_CANCELLED" ||
                      attempt >= retryLimit
                    )
                      throw error;
                    console.info(
                      "[MotionSplitRetry]",
                      JSON.stringify({
                        runId,
                        sourceRevision,
                        attempt: attempt + 1,
                        maxRetries: retryLimit,
                        reason:
                          error?.code ||
                          error?.message ||
                          "MOTION_SPLIT_FAILED",
                      }),
                    );
                    await new Promise((resolve) =>
                      setTimeout(resolve, policy.delay_nodes_sec * 1e3),
                    );
                    if (cancelled || scopeInvalid)
                      throw new Error("MOTION_CANCELLED");
                    const current = await api("GET", endpoint);
                    if (
                      current?.flow_project_id !== project.flow_project_id ||
                      Number(current.data_json?.source_revision || 0) !==
                        previousRevision
                    )
                      throw new Error("SOURCE_CHANGED_DURING_RESPLIT");
                    project = current;
                  }
                }
                if (cancelled || scopeInvalid)
                  throw new Error("MOTION_CANCELLED");
                if (
                  ((profile.settings.execution_mode === "parallel" &&
                    profile.settings.full_audio_transcription === true) ||
                    preferences.use_original_audio === true) &&
                  result.plan.audioState === "audio_present"
                )
                  await MotionFullAudioTranscript.audio({
                    scope: {
                      userId,
                      toolProjectId: projectId,
                      flowProjectId: project.flow_project_id,
                      sourceRevision,
                    },
                    duration: result.plan.duration,
                    shouldStop: () => cancelled || scopeInvalid,
                    assertScope: async () => {
                      if (scopeInvalid)
                        throw new Error("ACCOUNT_SCOPE_CHANGED");
                      const current = await api("GET", endpoint);
                      if (
                        current.flow_project_id !== project.flow_project_id ||
                        Number(current.data_json?.source_revision || 0) !==
                          previousRevision
                      )
                        throw new Error("SOURCE_CHANGED_DURING_RESPLIT");
                    },
                  });
                const frames = result.clips.map((clip, index) => ({
                  frame_id: clip.frameId,
                  run_id: runId,
                  input_revision: 1,
                  start: result.plan.boundaries[index],
                  end: result.plan.boundaries[index + 1],
                }));
                if (!frames.length) throw new Error("NO_FRAMES");
                const saved = await api("PUT", `${endpoint}/source`, {
                  revision: project.revision,
                  source_revision: sourceRevision,
                  ...(options.template && {
                    motion_template: {
                      id: options.template.id,
                      revision: options.template.revision,
                    },
                  }),
                  ...(resplitSavedSource && { preserve_motion_template: true }),
                  source: {
                    artifact_id: `source_${sourceRevision}`,
                    file_name:
                      file.name ||
                      project.data_json?.source?.file_name ||
                      "source-video",
                    mime: file.type || "application/octet-stream",
                    size: file.size,
                    duration: result.plan.duration,
                    split_strategy: cutStrategy,
                    split_limit_seconds: maxSeconds,
                    ...(Number.isSafeInteger(result.plan.quietCuts) && {
                      split_quiet_cuts: result.plan.quietCuts,
                      split_time_cuts: result.plan.timeCuts,
                    }),
                  },
                  frames,
                });
                project = saved;
                if (options.template) {
                  const settings = options.template.settings;
                  const unmatchedSettings = Object.keys(settings || {}).filter(
                    (key) => {
                      const actual =
                        key === "reference_mode"
                          ? saved.data_json?.references?.mode
                          : saved.data_json?.preferences?.[key];
                      return actual !== settings[key];
                    },
                  );
                  console.info(
                    "[MotionTemplateApply]",
                    JSON.stringify({
                      projectId,
                      templateId: options.template.id,
                      templateRevision: options.template.revision,
                      sourceRevision,
                      stage: "source_committed",
                      settingsAvailable: !!settings,
                      unmatchedSettings,
                    }),
                  );
                }
                if (pendingBulkDraftKey && !resplitSavedSource) {
                  await MotionArtifactStore.commitBulkSource({
                    userId,
                    toolProjectId: projectId,
                    flowProjectId: project.flow_project_id,
                    sourceRevision,
                    draftKey: pendingBulkDraftKey,
                  });
                }
                for (const clip of result.clips) {
                  if (scopeInvalid) throw new Error("ACCOUNT_SCOPE_CHANGED");
                  await api(
                    "PATCH",
                    `${endpoint}/frames/${clip.frameId}/checkpoint`,
                    {
                      source_revision: sourceRevision,
                      run_id: runId,
                      input_revision: 1,
                      stage: "split",
                      state: "ready",
                      artifact_id: `clip_${sourceRevision}_${clip.frameId}`,
                      audio_state: result.plan.audioState,
                      audio_artifact_id:
                        result.plan.audioState === "audio_present"
                          ? `audio_${sourceRevision}_${clip.frameId}`
                          : null,
                    },
                  );
                }
                let cleanupPending = false;
                if (previousRevision > 0) {
                  try {
                    await MotionArtifactStore.deleteSourceRevision(
                      userId,
                      projectId,
                      previousRevision,
                    );
                  } catch (_) {
                    cleanupPending = true;
                  }
                }
                await MotionArtifactStore.deleteSourceDraft(
                  userId,
                  projectId,
                ).catch((error) =>
                  console.warn(
                    "[Motion] Source draft cleanup failed",
                    error?.message,
                  ),
                );
                pendingSourceFile = null;
                pendingBulkDraftKey = null;
                await refresh({ applyTemplateSettings: !!options.template });
                renderSourceMeta(
                  file.name || motionText("text239", "Video ngu\u1ED3n"),
                  Number(result.plan.duration),
                  sourcePlaybackRates.get(file),
                );
                $("sourceInput").value = "";
                status(
                  motionFormat(
                    "text252",
                    "\u0110\xE3 l\u01B0u {0} frame \xB7 audio: {1}",
                    [frames.length, result.plan.audioState],
                  ) +
                    (cleanupPending
                      ? " \xB7 artifact c\u0169 ch\u1EDD d\u1ECDn khi m\u1EDF l\u1EA1i"
                      : ""),
                );
                $("progress").value = 100;
                prepared = true;
              } catch (error) {
                try {
                  const current = await api("GET", endpoint);
                  if (
                    Number(current.data_json?.source_revision || 0) <
                    sourceRevision
                  ) {
                    await MotionArtifactStore.deleteSourceRevision(
                      userId,
                      projectId,
                      sourceRevision,
                    );
                  } else if (
                    Number(current.data_json?.source_revision || 0) ===
                      sourceRevision &&
                    previousRevision > 0 &&
                    !scopeInvalid
                  ) {
                    await MotionArtifactStore.deleteSourceRevision(
                      userId,
                      projectId,
                      previousRevision,
                    );
                  }
                  project = current;
                } catch (_) {}
                throw error;
              }
            },
          );
        },
      );
    } catch (error) {
      if (!scopeInvalid) await refresh().catch(() => {});
      status(motionErrorMessage(error));
    } finally {
      busy = false;
      cancelSplit = null;
      worker?.terminate();
      worker = null;
      if (profileDirty && !scopeInvalid) await refreshProfile();
      settleActivity();
      updateButtons();
    }
    return prepared;
  }
  function renderFrameLimitHint() {
    const hint = $("motionFrameLimitHint");
    if (!hint) return;
    let seconds = null;
    try {
      const selectedModel = $("motionFlowModel")?.value;
      const selectedProject = selectedModel
        ? {
            ...project,
            data_json: {
              ...project?.data_json,
              preferences: {
                ...project?.data_json?.preferences,
                flow_model: selectedModel,
              },
            },
          }
        : project;
      seconds = window.MotionSplitPolicy.limit(selectedProject, profile);
    } catch (_) {}
    const valid = !scopeInvalid && Number.isFinite(seconds) && seconds >= 1;
    const key = "motionEditor.frameLimitHint";
    const text = valid ? window.I18n?.t?.(key, { seconds }) : null;
    hint.textContent = text && text !== key ? text : "";
    hint.hidden = !hint.textContent;
  }
  async function refreshProfile({ required = false } = {}) {
    profileDirty = false;
    try {
      await window.ExecutionConfig.getConfig();
      const response = await RequestSigner.fetchProtected("motionTool", {
        force: true,
        promptVariant: "timeline",
      });
      profile =
        response.data?.tool_key === "motion_studio" ? response.data : null;
      if (!profile) {
        if (required)
          throw new window.ConfigRequiredError(
            "motionTool",
            "response_invalid",
          );
        status(
          motionText("text229", "Profile Motion kh\xF4ng h\u1EE3p l\u1EC7."),
        );
      }
      $("transcriptionAgent").value =
        project?.data_json?.preferences?.transcription_provider ||
        profile?.settings?.transcription_provider ||
        "";
      renderFlowModels();
      renderReferences();
      updateMotionVisibility();
      if ($("targetLanguageTrigger"))
        $("targetLanguageTrigger").textContent =
          $("targetLanguage").value ||
          motionText("text107", "Gi\u1EEF ng\xF4n ng\u1EEF g\u1ED1c");
    } catch (error) {
      profile = null;
      if (required) throw error;
      if (window.ConfigRequiredError?.is?.(error))
        window.ConfigErrorHandler?.handle?.(error, "Motion profile");
      status(motionErrorMessage(error));
    }
    renderFrameLimitHint();
    updateButtons();
  }
  async function boot() {
    const bootRead = async (stage, read) => {
      const startedAt = Date.now();
      try {
        return await read();
      } catch (error) {
        if (error && typeof error === "object")
          error.motionBootStage || (error.motionBootStage = stage);
        console.warn(
          "[MotionBootConfig]",
          JSON.stringify({
            stage,
            elapsedMs: Date.now() - startedAt,
            code: /^[A-Z][A-Z0-9_]{0,80}$/.test(error?.code || "")
              ? error.code
              : null,
            httpStatus: Number.isInteger(error?.httpStatus)
              ? error.httpStatus
              : null,
          }),
        );
        throw error;
      }
    };
    if (!/^[0-9a-f-]{36}$/i.test(String(projectId || "")))
      throw new Error("INVALID_PROJECT_ID");
    window.eventBus || (window.eventBus = new EventBus());
    window.eventBus.on("config:protected_ready", () => {
      if (configBootFailed) window.location.reload();
    });
    await window.generationHistory?.init?.();
    stopMotionQueueStatus = window.eventBus.on(
      "queue:state_changed",
      updateMotionQueueStatus,
    );
    window.eventBus.on("i18n:changed", refreshMotionTranslations);
    window.eventBus.on("i18n:reloaded", refreshMotionTranslations);
    window.eventBus.on("provider:models_updated", () => {
      if (profile) {
        renderFlowModels();
        renderReferences();
        renderFrameLimitHint();
        updateButtons();
      }
    });
    window.eventBus.on("featuregate:refreshed", () => {
      if (project) updateButtons();
    });
    window.eventBus.on("storageSettings:loaded", ({ settings } = {}) =>
      renderProjectFlowMode(settings),
    );
    if (window.I18n) {
      try {
        await window.I18n.init();
        const locale = window.I18n.getLocale();
        let motionKeys = window.I18n._translations?.[locale]?.motionEditor;
        if (
          !motionKeys?.text003 ||
          !motionKeys?.text014 ||
          !motionKeys?.text040
        ) {
          const refreshed = await window.I18n._fetchServerTranslations(locale);
          motionKeys = window.I18n._translations?.[locale]?.motionEditor;
          console.warn("[MotionI18n] Motion translations missing from cache", {
            locale,
            refreshed,
            hasLoading: !!motionKeys?.text003,
            hasRatio: !!motionKeys?.text014,
            hasFinalVideo: !!motionKeys?.text040,
          });
        }
        i18nReady = true;
        window.I18n.applyTranslations();
        $("motionEditorLoadingText").hidden =
          locale !== "vi" && !motionKeys?.text003;
      } catch (error) {
        i18nReady = false;
        console.warn("[MotionI18n] Initialization failed", error?.message);
      }
    }
    window.authManager = new AuthManager();
    await bootRead("auth", () => window.authManager.init());
    if (!window.authManager.isLoggedIn()) throw new Error("AUTH_REQUIRED");
    userId = Number(window.authManager.getUser()?.id);
    if (!Number.isSafeInteger(userId) || userId < 1)
      throw new Error("INVALID_ACCOUNT");
    window.ExtensionDeviceManager?.init?.();
    await bootRead("system_settings", async () => {
      await window.SystemConfig.restoreFromStorage();
      await window.SystemConfig.fetch();
      if (!(Number(window.SystemConfig.safeGetTimeout("api_timeout_ms")) > 0))
        throw new window.ConfigRequiredError(
          "system_settings",
          "api_timeout_ms",
        );
    });
    await Promise.all([
      bootRead("provider_api_configs", () =>
        window.ProviderConfigManager._fetchApiConfigs(),
      ),
      bootRead("provider_models", () => window.ModelRegistry.fetch()),
    ]);
    initLanguagePicker();
    initRatioPicker();
    initReferenceModePicker();
    initCharacterCountPicker();
    initMotionPromptResizers();
    initRunConfirmation();
    for (const kind of ["character", "character2", "background"]) {
      const rescan = document.createElement("button");
      rescan.type = "button";
      rescan.id = kind + "RefRescan";
      rescan.className = "motion-ref-rescan";
      rescan.title = window.I18n?.t?.("motionEditor.refVerify") || "";
      rescan.setAttribute("aria-label", rescan.title);
      rescan.disabled = true;
      rescan.addEventListener("click", (event) => {
        event.stopPropagation();
        void rescanReference(kind);
      });
      rescan.addEventListener("keydown", (event) => event.stopPropagation());
      const zone = $(kind + "DropZone");
      const reupload = document.createElement("button");
      reupload.type = "button";
      reupload.id = kind + "RefReupload";
      reupload.className = "motion-ref-reupload";
      reupload.title = window.I18n?.t?.("motionEditor.refReupload") || "";
      reupload.setAttribute("aria-label", reupload.title);
      reupload.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/></svg>';
      reupload.addEventListener("click", (event) => {
        event.stopPropagation();
        void reuploadReference(kind);
      });
      reupload.addEventListener("keydown", (event) => event.stopPropagation());
      zone.append(reupload, rescan);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.id = kind + "RefRemove";
      remove.className = "motion-ref-remove";
      remove.hidden = true;
      remove.title = window.I18n?.t?.("common.delete") || "Delete";
      remove.setAttribute("aria-label", `${remove.title} ${kind}`);
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/></svg>';
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void removeReference(kind);
      });
      remove.addEventListener("keydown", (event) => event.stopPropagation());
      zone.append(remove);
    }
    await window.featureGate.init();
    await window.storageSettings.init();
    flowHeaderHealth = null;
    flowHeaderHealthAt = 0;
    window.eventBus.on("featuregate:refreshed", () => {
      flowHeaderHealthAt = 0;
      renderProjectFlowMode();
    });
    flowHeaderTimer = setInterval(() => renderProjectFlowMode(), 5e3);
    document.querySelectorAll("[data-motion-agent]").forEach((button) => {
      const logo = document.createElement("span");
      logo.className = "motion-agent-brand";
      logo.setAttribute("aria-hidden", "true");
      logo.innerHTML =
        window.ProviderBrandIcons?.get?.(button.dataset.motionAgent) || "";
      const statusDot = button.querySelector("i");
      if (statusDot) statusDot.after(logo);
      else button.prepend(logo);
    });
    $("motionFlowVoiceIcon").innerHTML =
      window.ProviderBrandIcons?.get?.("flow") || "";
    const subtitleRow = document.createElement("div");
    subtitleRow.className = "timeline-track subtitle-track motion-sub-track";
    const sourceLabel = document.querySelector(".track-source");
    if (sourceLabel) {
      const sourceMenu = document.createElement("button");
      sourceMenu.type = "button";
      sourceMenu.className =
        "motion-frame-menu-trigger motion-track-menu-trigger";
      sourceMenu.textContent = "\u22EE";
      sourceMenu.setAttribute(
        "aria-label",
        motionText("text243", "Thao t\xE1c video ngu\u1ED3n"),
      );
      sourceMenu.setAttribute("aria-haspopup", "menu");
      sourceMenu.setAttribute("aria-expanded", "false");
      sourceMenu.addEventListener("click", (event) => {
        event.stopPropagation();
        if (scopeInvalid) return;
        if (activeFrameMenu) {
          activeFrameMenu.remove();
          activeFrameMenu = null;
        }
        const menu = document.createElement("div");
        menu.className = "motion-frame-menu";
        menu.setAttribute("role", "menu");
        const action = document.createElement("button");
        action.type = "button";
        action.setAttribute("role", "menuitem");
        const icon = document.createElement("span");
        icon.className = "motion-menu-upload-icon";
        icon.setAttribute("aria-hidden", "true");
        action.append(
          icon,
          document.createTextNode("Upload t\u1EA5t c\u1EA3 l\xEAn Flow"),
        );
        action.disabled =
          busy ||
          motionRunning ||
          !hasPendingSourceUploads() ||
          project?.data_json?.requires_resplit === true;
        menu.refreshState = () => {
          action.disabled =
            scopeInvalid ||
            busy ||
            motionRunning ||
            !hasPendingSourceUploads() ||
            project?.data_json?.requires_resplit === true;
        };
        menu.refreshState();
        console.info("[MotionUploadMenu]", {
          surface: "source",
          disabled: action.disabled,
          paused: project?.data_json?.paused === true,
          requiresResplit: project?.data_json?.requires_resplit === true,
          frameCount: Object.keys(project?.data_json?.frames || {}).length,
        });
        action.addEventListener("click", () => {
          menu.remove();
          activeFrameMenu = null;
          sourceMenu.setAttribute("aria-expanded", "false");
          openBatchUploadConfirmation?.();
        });
        menu.append(action);
        document.body.append(menu);
        activeFrameMenu = menu;
        sourceMenu.setAttribute("aria-expanded", "true");
        const rect = sourceMenu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 8))}px`;
        (action.disabled ? sourceMenu : action).focus();
      });
      sourceLabel.append(sourceMenu);
    }
    const subtitleLabel = document.createElement("div");
    subtitleLabel.className = "track-label track-sub";
    const subtitleTitle = document.createElement("strong");
    subtitleTitle.textContent = "SUB";
    const batchMenu = document.createElement("button");
    batchMenu.type = "button";
    batchMenu.className = "motion-frame-menu-trigger motion-sub-menu-trigger";
    batchMenu.textContent = "\u22EE";
    batchMenu.setAttribute(
      "aria-label",
      motionText("text242", "Thao t\xE1c ph\u1EE5 \u0111\u1EC1"),
    );
    batchMenu.setAttribute("aria-haspopup", "menu");
    batchMenu.setAttribute("aria-expanded", "false");
    batchMenu.addEventListener("click", (event) => {
      event.stopPropagation();
      if (scopeInvalid) return;
      if (activeFrameMenu) {
        activeFrameMenu.remove();
        activeFrameMenu = null;
      }
      const menu = document.createElement("div");
      menu.className = "motion-frame-menu";
      menu.setAttribute("role", "menu");
      const action = document.createElement("button");
      action.type = "button";
      action.setAttribute("role", "menuitem");
      const icon = document.createElement("span");
      icon.className = "motion-menu-sub-icon";
      icon.setAttribute("aria-hidden", "true");
      action.append(
        icon,
        document.createTextNode(motionText("text067", "T\u1EA1o Sub")),
      );
      action.disabled = busy || motionRunning || !isSelectedAgentReady();
      action.dataset.motionCreateSub = "true";
      action.addEventListener("click", () => {
        menu.remove();
        activeFrameMenu = null;
        batchMenu.setAttribute("aria-expanded", "false");
        openBatchSubConfirmation?.();
      });
      menu.append(action);
      document.body.append(menu);
      activeFrameMenu = menu;
      batchMenu.setAttribute("aria-expanded", "true");
      const rect = batchMenu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.right, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - menu.offsetHeight - 8))}px`;
      (action.disabled ? batchMenu : action).focus();
    });
    subtitleLabel.append(subtitleTitle, batchMenu);
    const subtitleTrack = document.createElement("div");
    subtitleTrack.id = "subtitleTrack";
    subtitleTrack.className = "track-clips";
    subtitleRow.append(subtitleLabel, subtitleTrack);
    $("resultTrack").parentElement.before(subtitleRow);
    const audioRow = document.createElement("div");
    audioRow.className = "timeline-track subtitle-track";
    const audioLabel = document.createElement("div");
    audioLabel.className = "track-label track-audio";
    const audioTitle = document.createElement("strong");
    audioTitle.textContent = "AUDIO";
    audioLabel.append(audioTitle);
    addTrackBatchMenu(audioLabel, {
      key: "regenerateAudioAll",
      fallback: "T\u1EA1o l\u1EA1i audio t\u1EA5t c\u1EA3 frame",
      iconClass: "motion-menu-reset-icon",
      run: regenerateAllFrameAudio,
    });
    addTrackBatchMenu(document.querySelector(".track-label.track-flow"), {
      key: "generateFlowAll",
      fallback: "Gen t\u1EA5t c\u1EA3 frame",
      iconClass: "motion-menu-gen-icon",
      resetResults: true,
      run: () => {
        if (project?.data_json?.paused === true) {
          pausedStandaloneTask = null;
          return setPaused(false);
        }
        return openManualRunConfirmation?.(null);
      },
    });
    const audioTrack = document.createElement("div");
    audioTrack.id = "audioTrack";
    audioTrack.className = "track-clips";
    audioRow.append(audioLabel, audioTrack);
    subtitleRow.before(audioRow);
    $("mergeBtn").innerHTML =
      '<svg class="frame-slot-icon" width="16" height="16" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 3.5H2.6C2.03995 3.5 1.75992 3.5 1.54601 3.60899C1.35785 3.70487 1.20487 3.85785 1.10899 4.04601C1 4.25992 1 4.53995 1 5.1V6.9C1 7.46005 1 7.74008 1.10899 7.95399C1.20487 8.14215 1.35785 8.29513 1.54601 8.39101C1.75992 8.5 2.03995 8.5 2.6 8.5H6.5M8.5 3.5H9.4C9.96005 3.5 10.2401 3.5 10.454 3.60899C10.6422 3.70487 10.7951 3.85785 10.891 4.04601C11 4.25992 11 4.53995 11 5.1V6.9C11 7.46005 11 7.74008 10.891 7.95399C10.7951 8.14215 10.6422 8.29513 10.454 8.39101C10.2401 8.5 9.96005 8.5 9.4 8.5H8.5M8.5 10.5L8.5 1.5M9.75 1.5L7.25 1.5M9.75 10.5L7.25 10.5"></path></svg><span data-i18n="motionEditor.text195">Gh\xE9p video th\u1EE7 c\xF4ng</span>';
    const timer = document.createElement("span");
    timer.id = "motionTimer";
    timer.className = "motion-timer";
    timer.textContent = "00:00";
    timer.setAttribute("aria-label", "Th\u1EDDi gian x\u1EED l\xFD Motion");
    $("usageLink").before(timer);
    activityTimer = setInterval(tickActivity, 1e3);
    await refresh();
    const draft = await MotionArtifactStore.getSourceDraft(userId, projectId);
    if (
      draft?.bulkCreateId &&
      draft.flowProjectId === project.flow_project_id &&
      Number(draft.baseSourceRevision) + 1 ===
        Number(project.data_json?.source_revision)
    ) {
      const sourceRevision = Number(project.data_json.source_revision);
      const source = await MotionArtifactStore.get({
        userId,
        toolProjectId: projectId,
        sourceRevision,
        kind: "source_video",
      });
      if (source?.blobKey === draft.key)
        await MotionArtifactStore.commitBulkSource({
          userId,
          toolProjectId: projectId,
          flowProjectId: project.flow_project_id,
          sourceRevision,
          draftKey: draft.key,
        });
    }
    if (
      draft?.blob &&
      draft.flowProjectId === project.flow_project_id &&
      draft.baseSourceRevision ===
        Number(project.data_json?.source_revision || 0)
    ) {
      pendingSourceFile = new File([draft.blob], draft.fileName, {
        type: draft.mime,
      });
      if (draft.playbackRate)
        sourcePlaybackRates.set(pendingSourceFile, draft.playbackRate);
      renderSourceMeta(pendingSourceFile.name, null, draft.playbackRate, {
        pending: true,
      });
      pendingBulkDraftKey = draft.bulkCreateId ? draft.key : null;
      await setStageVideo(
        "source",
        `pending:${draft.createdAt}`,
        pendingSourceFile,
      );
    }
    let cleanupWarning = false;
    try {
      await cleanupOldRevisions();
    } catch (_) {
      cleanupWarning = true;
    }
    await bootRead("motion_tool_profile", () =>
      refreshProfile({ required: true }),
    );
    if (i18nReady) {
      window.I18n.applyTranslations();
      await refresh();
    }
    if (window.VoicePicker && window.VoiceRegistry && window.VoiceSelectModal) {
      window.VoiceRegistry.initCrossContextSync?.();
      voicePicker = new window.VoicePicker({
        triggerEl: $("motionVoiceTrigger"),
        thumbEl: $("motionVoiceThumb"),
        labelEl: $("motionVoiceLabel"),
        hiddenSelectEl: $("motionVoiceSlug"),
        providerSlug: "flow",
        getSelected: () => $("motionVoiceSlug").value || "",
        onChange: () => scheduleSettingsSave(),
      });
      voicePicker.init();
      voicePicker.setSelected(project.data_json?.preferences?.voice_slug || "");
    }
    await loadResolutions();
    await initializeNewProjectRatio();
    if (profile?.tool_key !== "motion_studio")
      throw new Error("INVALID_TOOL_PROFILE");
    const configAccessStatus = await window.ConfigAccessUI.refresh();
    console.info(
      "[MotionConfigAccess]",
      JSON.stringify({
        projectId,
        stage: "boot_config_reconciled",
        ready: configAccessStatus?.ready === true,
        code: configAccessStatus?.code || null,
        uiCode: window.ConfigAccessUI._state?.code || null,
        profileReady: profile?.tool_key === "motion_studio",
      }),
    );
    updateButtons();
    settingsReady = true;
    void refreshAgentStatus();
    agentHealthTimer = setInterval(() => {
      if (!scopeInvalid) void refreshAgentStatus();
    }, 1e4);
    void reconcileUploadedSources().catch((error) =>
      console.warn(
        "[Motion] Source reconciliation unavailable",
        error?.message,
      ),
    );
    status(
      cleanupWarning
        ? motionText(
            "text109",
            "S\u1EB5n s\xE0ng; artifact c\u0169 ch\u01B0a d\u1ECDn \u0111\u01B0\u1EE3c.",
          )
        : isMotionProjectIdleComplete()
          ? motionText("text096", "\u0110\xE3 ho\xE0n th\xE0nh")
          : project?.data_json?.paused
            ? motionText(
                "text135",
                "\u0110\xE3 t\u1EA1m d\u1EEBng Motion project.",
              )
            : motionText("editorReady", "Motion Editor ready"),
    );
    await prepareTemplateDraft();
  }
  $("sourceInput").addEventListener("change", () => {
    if (scopeInvalid || busy || motionSettingsRunLocked()) return;
    pendingSourceFile = $("sourceInput").files?.[0] || null;
    pendingBulkDraftKey = null;
    updateButtons();
    const file = pendingSourceFile;
    if (file) {
      renderSourceMeta(file.name, null, sourcePlaybackRates.get(file), {
        pending: true,
      });
      void setStageVideo("source", `pending:${Date.now()}`, file);
    }
  });
  $("motionTemplateBtn").addEventListener("click", () => {
    void openMotionTemplates().catch((error) => {
      motionToast(motionErrorMessage(error), { error: true });
    });
  });
  $("replaceSourceBtn").addEventListener("click", () =>
    $("sourceInput").click(),
  );
  $("finalSpeedBtn")?.addEventListener("change", (event) => {
    const playbackRate = 1 / Number(event.target.value);
    event.target.value = "";
    void speedFinalVideo(playbackRate);
  });
  $("slowSourceBtn")?.addEventListener("change", (event) => {
    const playbackRate = Number(event.target.value);
    event.target.value = "";
    void slowSourceVideo(playbackRate);
  });
  function installDropZone(id, accept, open) {
    const zone = $(id);
    zone.addEventListener("click", (event) => {
      if (event.target.closest("video")) return;
      open();
    });
    zone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (scopeInvalid || busy || motionSettingsRunLocked()) return;
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      zone.classList.add("is-drag-over");
    });
    zone.addEventListener("dragleave", (event) => {
      if (!zone.contains(event.relatedTarget))
        zone.classList.remove("is-drag-over");
    });
    zone.addEventListener("drop", (event) => {
      event.preventDefault();
      zone.classList.remove("is-drag-over");
      const files = [...(event.dataTransfer?.files || [])];
      if (!files.length || files.length !== 1 || !files.every(accept)) {
        status(
          motionText(
            "text231",
            "File kh\xF4ng \u0111\xFAng \u0111\u1ECBnh d\u1EA1ng ho\u1EB7c s\u1ED1 l\u01B0\u1EE3ng cho v\xF9ng n\xE0y.",
          ),
        );
        return;
      }
      if (id === "sourceDropZone") {
        if (
          scopeInvalid ||
          busy ||
          motionSettingsRunLocked() ||
          settingsSaveTimer
        )
          return;
        pendingSourceFile = files[0];
        pendingBulkDraftKey = null;
        renderSourceMeta(
          files[0].name,
          null,
          sourcePlaybackRates.get(files[0]),
          { pending: true },
        );
        void setStageVideo("source", `pending:${Date.now()}`, files[0]);
        updateButtons();
      } else {
        const kind =
          id === "characterDropZone"
            ? "character"
            : id === "character2DropZone"
              ? "character2"
              : "background";
        void (async () => {
          const trace = await prepareReferenceInteraction(kind, "drop");
          if (!trace) return;
          try {
            trace("target_lookup");
            const target = await getMotionFlowTarget();
            assertPinnedFlowTarget(target);
            const saved = await savePickedReferences(
              kind,
              files.map((file) => ({ source: "upload", file })),
              target,
              project.revision,
              Number(project.data_json?.source_revision || 0),
              trace,
            );
            trace(saved ? "drop_finished" : "drop_not_saved");
          } catch (error) {
            trace("failed", error?.code || error?.message);
            setReferenceStatus(motionErrorMessage(error));
          }
        })();
      }
    });
  }
  installDropZone(
    "sourceDropZone",
    (file) =>
      ["video/mp4", "video/quicktime", "video/webm"].includes(file.type),
    () => $("sourceInput").click(),
  );
  installDropZone(
    "character2DropZone",
    (file) => file.type?.startsWith("image/"),
    () => openReferencePicker("character2"),
  );
  installDropZone(
    "characterDropZone",
    (file) => file.type?.startsWith("image/"),
    () => openReferencePicker("character"),
  );
  installDropZone(
    "backgroundDropZone",
    (file) => file.type?.startsWith("image/"),
    () => openReferencePicker("background"),
  );
  $("splitBtn").addEventListener("click", prepareSource);
  $("cancelBtn").addEventListener("click", cancelMotionTask);
  $("closeBtn").addEventListener("click", () => window.close());
  document.addEventListener("click", (event) => {
    if (!activeFrameMenu || activeFrameMenu.contains(event.target)) return;
    activeFrameMenu.remove();
    activeFrameMenu = null;
    document
      .querySelectorAll('.motion-frame-menu-trigger[aria-expanded="true"]')
      .forEach((button) => button.setAttribute("aria-expanded", "false"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeFrameMenu) return;
    activeFrameMenu.remove();
    activeFrameMenu = null;
    const trigger = document.querySelector(
      '.motion-frame-menu-trigger[aria-expanded="true"]',
    );
    trigger?.setAttribute("aria-expanded", "false");
    trigger?.focus();
  });
  document.querySelector(".timeline-scroll")?.addEventListener(
    "scroll",
    () => {
      if (!activeFrameMenu) return;
      activeFrameMenu.remove();
      activeFrameMenu = null;
      document
        .querySelectorAll('.motion-frame-menu-trigger[aria-expanded="true"]')
        .forEach((button) => button.setAttribute("aria-expanded", "false"));
    },
    { passive: true },
  );
  $("clearFramesBtn").addEventListener("click", clearAllFrames);
  function finishNameEdit() {
    $("nameEditor").hidden = true;
    $("projectTitleRow").hidden = false;
  }
  function beginNameEdit() {
    if (scopeInvalid || busy || settingsSaveTimer) return;
    $("nameEditor").hidden = false;
    $("projectTitleRow").hidden = true;
    $("projectNameInput").value = project?.name || "";
    $("projectNameInput").focus();
    $("projectNameInput").select();
  }
  $("editNameBtn").addEventListener("click", beginNameEdit);
  $("projectName").addEventListener("click", beginNameEdit);
  $("projectName").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      beginNameEdit();
    }
  });
  $("cancelNameBtn").addEventListener("click", finishNameEdit);
  $("saveNameBtn").addEventListener("click", saveProjectName);
  $("projectNameInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      $("projectNameInput").blur();
    }
    if (event.key === "Escape") finishNameEdit();
  });
  $("projectNameInput").addEventListener("blur", () => {
    if (!$("nameEditor").hidden) void saveProjectName();
  });
  $("projectNameInput").addEventListener("input", () =>
    $("projectNameInput").setCustomValidity(""),
  );
  $("closeFrameDialog").addEventListener("click", closeFrameDialog);
  $("frameDialog").addEventListener("close", closeFrameDialog);
  const stageSourceVideo = $("sourceStageVideo");
  const stageResultVideo = $("resultStageVideo");
  $("playBothVideos").addEventListener("click", async () => {
    if (!stageSourceUrl || !stageResultUrl) return;
    if (stageCompareActive && !stageResultVideo.paused) {
      stageResultVideo.pause();
      stageSourceVideo.pause();
      updateStageCompareButton();
      return;
    }
    stageCompareActive = true;
    stageSourceVideo.muted = true;
    stageResultVideo.muted = false;
    if (stageResultVideo.ended) stageResultVideo.currentTime = 0;
    try {
      stageSourceVideo.currentTime = stageResultVideo.currentTime;
    } catch (_) {}
    try {
      await Promise.all([stageSourceVideo.play(), stageResultVideo.play()]);
    } catch (error) {
      stageCompareActive = false;
      stageSourceVideo.pause();
      stageResultVideo.pause();
      console.warn("[MotionCompare] playback failed", error?.message || error);
    }
    updateStageCompareButton();
  });
  const syncStageSource = () => {
    if (!stageCompareActive || !stageSourceUrl || !stageResultUrl) return;
    if (
      Math.abs(stageSourceVideo.currentTime - stageResultVideo.currentTime) >
      0.2
    ) {
      try {
        stageSourceVideo.currentTime = stageResultVideo.currentTime;
      } catch (_) {}
    }
  };
  stageResultVideo.addEventListener("seeking", syncStageSource);
  stageResultVideo.addEventListener("timeupdate", syncStageSource);
  stageResultVideo.addEventListener("pause", () => {
    if (stageCompareActive) stageSourceVideo.pause();
    updateStageCompareButton();
  });
  stageResultVideo.addEventListener("play", () => {
    if (stageCompareActive) {
      syncStageSource();
      stageSourceVideo.play().catch(() => {});
    }
    updateStageCompareButton();
  });
  const frameMasterVideo = $("frameDialogVideo");
  const frameCompareVideo = $("frameCompareSourceVideo");
  frameMasterVideo.addEventListener("loadedmetadata", () => {
    if (!frameSourceBounds || selectedFrameKind !== "source_clip") return;
    frameMasterVideo.currentTime = frameSourceBounds.start;
    frameMasterVideo.play().catch(() => {});
  });
  frameMasterVideo.addEventListener("timeupdate", () => {
    if (
      selectedFrameKind === "source_clip" &&
      frameSourceBounds &&
      frameMasterVideo.currentTime >= frameSourceBounds.end
    )
      frameMasterVideo.pause();
  });
  frameMasterVideo.addEventListener("seeking", () => {
    if (selectedFrameKind !== "source_clip" || !frameSourceBounds) return;
    if (frameMasterVideo.currentTime < frameSourceBounds.start)
      frameMasterVideo.currentTime = frameSourceBounds.start;
    else if (frameMasterVideo.currentTime > frameSourceBounds.end)
      frameMasterVideo.currentTime = frameSourceBounds.end;
  });
  frameMasterVideo.addEventListener("play", () => {
    if (
      selectedFrameKind === "source_clip" &&
      frameSourceBounds &&
      frameMasterVideo.currentTime >= frameSourceBounds.end
    )
      frameMasterVideo.currentTime = frameSourceBounds.start;
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.code !== "Space" ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.defaultPrevented
    )
      return;
    const target = event.target;
    if (
      target instanceof Element &&
      (target.isContentEditable ||
        target.closest(
          'input,textarea,select,button,a,[role="button"],video,audio,[contenteditable="true"]',
        ))
    )
      return;
    const modal = document.querySelector("dialog[open]");
    if (
      !modal &&
      finalArtifact &&
      stageSourceUrl &&
      stageResultUrl &&
      !$("playBothVideos").disabled
    ) {
      event.preventDefault();
      $("playBothVideos").click();
      return;
    }
    const video = modal
      ? modal.id === "frameDialog" && selectedFrameKind === "source_clip"
        ? frameMasterVideo
        : null
      : $("sourceStageVideo");
    if (!video || video.hidden || !video.currentSrc) return;
    event.preventDefault();
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  });
  const syncFrameSource = () => {
    if (selectedFrameKind !== "generated_clip" || !frameCompareVideo.src)
      return;
    const sourceTime = frameMasterVideo.currentTime + frameCompareOffset;
    if (
      Number.isFinite(sourceTime) &&
      Math.abs(frameCompareVideo.currentTime - sourceTime) > 0.2
    ) {
      try {
        frameCompareVideo.currentTime = sourceTime;
      } catch (_) {}
    }
  };
  frameMasterVideo.addEventListener("play", () => {
    syncFrameSource();
    if (selectedFrameKind === "generated_clip" && frameCompareVideo.src)
      frameCompareVideo.play().catch(() => {});
  });
  frameMasterVideo.addEventListener("pause", () => frameCompareVideo.pause());
  frameMasterVideo.addEventListener("seeking", syncFrameSource);
  frameMasterVideo.addEventListener("timeupdate", syncFrameSource);
  frameCompareVideo.addEventListener("loadeddata", () => {
    syncFrameSource();
    if (selectedFrameKind === "generated_clip" && !frameMasterVideo.paused)
      frameCompareVideo.play().catch(() => {});
  });
  for (const video of [frameMasterVideo, frameCompareVideo]) {
    video.addEventListener("loadedmetadata", () => {
      if (!video.videoWidth || !video.videoHeight) return;
      const wrap = video.closest(".frame-video-wrap");
      wrap.style.setProperty(
        "--frame-video-ratio",
        String(video.videoWidth / video.videoHeight),
      );
      wrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      if (video === frameMasterVideo)
        $("frameDialog").dataset.videoLayout =
          video.videoWidth >= video.videoHeight ? "landscape" : "portrait";
    });
  }
  $("framePlaySource").addEventListener(
    "click",
    () =>
      selectedFrameId &&
      showFrameVideo(selectedFrameId, "source_clip").catch((error) =>
        status(motionErrorMessage(error)),
      ),
  );
  $("framePlayResult").addEventListener(
    "click",
    () =>
      selectedFrameId &&
      showFrameVideo(selectedFrameId, "generated_clip").catch((error) =>
        status(motionErrorMessage(error)),
      ),
  );
  $("frameHasSpeech").addEventListener("change", updateFrameSpeechEditor);
  $("frameTranscriptInput").addEventListener("input", updateFrameSpeechEditor);
  const confirmFrameSub = () => {
    const frameId = selectedFrameId;
    if (!frameId || busy || motionRunning || scopeInvalid) return;
    const dialog = $("frameDialog");
    if (dialog.open) {
      dialog.addEventListener(
        "close",
        () => {
          if (!scopeInvalid && !busy && !motionRunning)
            openSubRunConfirmation?.(frameId);
        },
        { once: true },
      );
      closeFrameDialog();
      return;
    }
    closeFrameDialog();
    openSubRunConfirmation?.(frameId);
  };
  $("frameResub").addEventListener("click", confirmFrameSub);
  $("frameSaveTranscript").addEventListener("click", saveFrameTranscript);
  $("frameRegen").addEventListener("click", async () => {
    const id = selectedFrameId;
    if (!id || busy) return;
    const kind = selectedFrameKind;
    if (kind === "source_clip") {
      closeFrameDialog();
      await recutFrame(id);
      return;
    }
    closeFrameDialog();
    if (!scopeInvalid) await rerunFrame(id);
  });
  $("headerSaveBtn").addEventListener("click", async () => {
    if (scopeInvalid || busy || headerSaving || !project) return;
    headerSaving = true;
    const savingStartedAt = Date.now();
    const button = $("headerSaveBtn");
    const label = button.querySelector("span");
    const previousLabel = label?.textContent;
    if (label) {
      label.dataset.i18n = "motionEditor.text183";
      label.textContent = motionText("text183", "Saving...");
    }
    button.setAttribute("aria-busy", "true");
    button.classList.add("is-saving");
    updateButtons();
    const saving = motionText("text183", "Saving...");
    clearTimeout(savedHintTimer);
    $("preferencesStatus").classList.remove("is-saved");
    $("preferencesStatus").textContent = saving;
    try {
      if (!$("nameEditor").hidden) {
        await saveProjectName();
        if (!$("nameEditor").hidden) {
          motionToast($("status").textContent, { error: true });
          return;
        }
      }
      if (settingsDirty) {
        await saveMotionSettings();
        if (settingsDirty || scopeInvalid) {
          if (!scopeInvalid)
            motionToast(
              $("motionSettingsStatus").textContent ||
                motionText("text180", "Unable to save Motion."),
              { error: true },
            );
          return;
        }
      }
      if (pendingSourceFile) {
        try {
          busy = true;
          updateButtons();
          if (pendingBulkDraftKey) {
            const draft = await MotionArtifactStore.getSourceDraft(
              userId,
              projectId,
            );
            if (
              draft?.key !== pendingBulkDraftKey ||
              draft.flowProjectId !== project.flow_project_id ||
              draft.baseSourceRevision !==
                Number(project.data_json?.source_revision || 0)
            ) {
              throw new Error("MOTION_SOURCE_DRAFT_CHANGED");
            }
          } else {
            await MotionArtifactStore.saveSourceDraft({
              userId,
              toolProjectId: projectId,
              flowProjectId: project.flow_project_id,
              blob: pendingSourceFile,
              fileName: pendingSourceFile.name,
              baseSourceRevision: Number(
                project.data_json?.source_revision || 0,
              ),
              playbackRate: sourcePlaybackRates.get(pendingSourceFile) ?? null,
            });
          }
          showSettingsSaved();
        } catch (error) {
          const message = motionErrorMessage(
            error || "MOTION_SOURCE_SAVE_FAILED",
          );
          status(message);
          motionToast(message, { error: true });
        } finally {
          busy = false;
          updateButtons();
        }
        return;
      }
      showSettingsSaved();
    } finally {
      const feedbackRemaining = 300 - (Date.now() - savingStartedAt);
      if (feedbackRemaining > 0)
        await new Promise((resolve) => setTimeout(resolve, feedbackRemaining));
      headerSaving = false;
      if (label) {
        label.dataset.i18n = "motionEditor.text005";
        label.textContent = motionText("text005", previousLabel);
      }
      button.removeAttribute("aria-busy");
      button.classList.remove("is-saving");
      if (
        !$("preferencesStatus").classList.contains("is-saved") &&
        $("preferencesStatus").textContent === saving
      )
        $("preferencesStatus").textContent = "";
      updateButtons();
    }
  });
  $("headerResetBtn").addEventListener("click", resetMotionProject);
  $("frameUploadClip").addEventListener(
    "click",
    () => selectedFrameId && openUploadConfirmation?.(selectedFrameId),
  );
  $("frameDownload").addEventListener(
    "click",
    () =>
      selectedFrameId &&
      mediaAction(selectedFrameId, selectedFrameKind, "download").catch(
        (error) => status(motionErrorMessage(error)),
      ),
  );
  const frameFetchFlow = document.createElement("button");
  frameFetchFlow.id = "frameFetchFlow";
  frameFetchFlow.type = "button";
  frameFetchFlow.textContent = motionText(
    "text196",
    "T\u1EA3i l\u1EA1i t\u1EEB Flow",
  );
  frameFetchFlow.setAttribute("data-i18n", "motionEditor.text196");
  $("frameDownload").before(frameFetchFlow);
  frameFetchFlow.addEventListener("click", () => {
    const frameId = selectedFrameId;
    if (!frameId) return;
    closeFrameDialog();
    void openDirectFlowDownload(frameId).catch((error) =>
      status(motionErrorMessage(error)),
    );
  });
  $("closeFlowDownload").addEventListener("click", () =>
    $("flowDownloadDialog").close(),
  );
  $("confirmFlowDownload").addEventListener("click", () =>
    downloadFrameFromFlow(),
  );
  $("closePreview").addEventListener("click", closePreview);
  $("previewDialog").addEventListener("close", closePreview);
  $("savePreferences").addEventListener("click", savePreferences);
  for (const id of ["voiceEnabled", "subtitleEnabled"])
    $(id).addEventListener("change", decideSpeechSettingsChange, true);
  $("voiceEnabled").addEventListener("change", () => {
    updateMotionVisibility();
    updateButtons();
    void refreshAgentStatus();
  });
  $("motionVoiceMode").addEventListener("change", updateMotionVisibility);
  $("motionRatio").addEventListener("change", updateMotionVisibility);
  $("subtitleEnabled").addEventListener("change", () => {
    updateMotionVisibility();
    updateButtons();
    void refreshAgentStatus();
  });
  $("translateEnabled").addEventListener("change", updateMotionVisibility);
  $("saveMotionSettings").addEventListener("click", saveMotionSettings);
  for (const id of [
    "transcriptionAgent",
    "voiceEnabled",
    "subtitleEnabled",
    "translateEnabled",
    "targetLanguage",
    "voiceDescription",
    "motionCustomPrompt",
    "motionVoiceSlug",
    "motionVoiceMode",
    "motionRatio",
    "motionFlowModel",
    "referenceMode",
    "characterCount",
    "autoDownloadFinal",
    "useOriginalAudio",
    "continuityEnabled",
    "reviewSubtitle",
    "removeFinalVideoWatermark",
    "flowResolution",
  ]) {
    $(id).addEventListener("change", scheduleSettingsSave);
    if (id === "voiceDescription" || id === "motionCustomPrompt") {
      $(id).addEventListener("input", scheduleSettingsSave);
      $(id).addEventListener("compositionend", scheduleSettingsSave);
      $(id).addEventListener("focus", scheduleSettingsSave);
      $(id).addEventListener("blur", scheduleSettingsSave);
    }
  }
  $("transcriptionAgent").addEventListener("change", refreshAgentStatus);
  $("transcriptionAgent").addEventListener("change", updateMotionVisibility);
  $("transcriptionAgent").addEventListener("focus", refreshAgentStatus);
  document.querySelectorAll("[data-motion-agent]").forEach((button) => {
    button.addEventListener("click", () => {
      if (scopeInvalid || busy || !profile) return;
      if ($("transcriptionAgent").value === button.dataset.motionAgent) {
        void refreshAgentStatus();
        return;
      }
      $("transcriptionAgent").value = button.dataset.motionAgent;
      $("transcriptionAgent").dispatchEvent(
        new Event("change", { bubbles: true }),
      );
      updateButtons();
    });
  });
  $("transcriptionAgentOpen").addEventListener("click", () => {
    void connectSpeechAgent();
  });
  $("referenceMode").addEventListener("change", renderReferences);
  $("characterCount").addEventListener("change", renderReferences);
  $("motionFlowModel").addEventListener("change", renderReferences);
  $("continuityEnabled").addEventListener("change", renderReferences);
  $("usageLink").addEventListener("click", () => {
    chrome.runtime
      .sendMessage({ action: "openSettings", tab: "storage" })
      .catch((error) => {
        console.warn("[Motion] Cannot open storage settings", error?.message);
        status(
          motionText(
            "text152",
            "Kh\xF4ng m\u1EDF \u0111\u01B0\u1EE3c c\xE0i \u0111\u1EB7t dung l\u01B0\u1EE3ng.",
          ),
        );
      });
  });
  $("projectFlowMode").addEventListener("click", () => {
    chrome.runtime
      .sendMessage({ action: "openSettings", tab: "max-speed" })
      .then((result) => {
        if (result?.ok === false) status(motionErrorMessage(result.error));
      })
      .catch((error) => {
        status(motionErrorMessage(error));
      });
  });
  $("pauseBtn").addEventListener("click", () =>
    setPaused(project?.data_json?.paused !== true),
  );
  $("mergeBtn").addEventListener("click", async () => {
    if (mergeConfirmationOpen || scopeInvalid || busy || !canMerge) return;
    mergeConfirmationOpen = true;
    try {
      const confirmed = await window.customDialog.confirm(
        motionText(
          "mergeConfirm",
          "Gh\xE9p c\xE1c frame \u0111\xE3 c\xF3 k\u1EBFt qu\u1EA3? Video ho\xE0n ch\u1EC9nh hi\u1EC7n t\u1EA1i s\u1EBD \u0111\u01B0\u1EE3c thay th\u1EBF.",
        ),
        {
          title: motionText("text195", "Gh\xE9p video th\u1EE7 c\xF4ng"),
          type: "video-gen",
          confirmText: motionText("text195", "Gh\xE9p video th\u1EE7 c\xF4ng"),
          cancelText: motionText("text006", "H\u1EE7y"),
        },
      );
      if (confirmed) await mergeFinal();
    } catch (error) {
      status(motionErrorMessage(error));
    } finally {
      mergeConfirmationOpen = false;
    }
  });
  $("playFinal").addEventListener("click", () =>
    finalBlob()
      .then((blob) =>
        playBlob(blob, motionText("text040", "Video ho\xE0n ch\u1EC9nh"), {
          final: true,
        }),
      )
      .catch((error) => status(motionErrorMessage(error))),
  );
  $("downloadFinal").addEventListener("click", () =>
    openFinalDownload().catch((error) => {
      const message = motionErrorMessage(error);
      status(message);
      motionToast(message, { error: true });
    }),
  );
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.action === "sseRelay:system_settings_changed") {
      if (message.data && typeof message.data === "object")
        window.SystemConfig?.handleSseUpdate?.(message.data);
      if (project) updateButtons();
      return;
    }
    if (
      message?.action === "motionProjectDeleted" &&
      message.toolProjectId === projectId
    ) {
      cancelled = true;
      scopeInvalid = true;
      cancelSplit?.();
      closePreview();
      closeFrameDialog();
      window.imagePickerModal?.close?.();
      releaseStageMedia();
      profile = null;
      updateButtons();
      status(
        motionText(
          "text236",
          "Project \u0111\xE3 x\xF3a. \u0110\xF3ng c\u1EEDa s\u1ED5 n\xE0y.",
        ),
      );
      return;
    }
    if (
      message?.action !== "sseRelay:tool_config_updated" ||
      message.tool_key !== "motion_studio"
    )
      return;
    if (busy) profileDirty = true;
    else refreshProfile();
  });
  window.eventBus?.on?.("execution_config:refreshed", updateMotionVisibility);
  window.addEventListener("pagehide", () =>
    window.eventBus?.off?.(
      "execution_config:refreshed",
      updateMotionVisibility,
    ),
  );
  const refreshMotionTranslations = () => {
    window.I18n?.applyTranslations?.();
    renderFrameLimitHint();
    renderSplitSummary();
    for (const id of ["voiceDescription", "motionCustomPrompt"])
      $(id + "Resizer")?.setAttribute(
        "aria-label",
        motionText("resizePrompt", "Resize prompt"),
      );
    window.motionReferenceModePickerRender?.();
    window.motionCharacterCountPickerRender?.();
    languageChoices = null;
    timelineStructureKey = null;
    if (project && !scopeInvalid) void refresh().catch(() => {});
  };
  window.addEventListener("pagehide", () => {
    externalProjectRefreshStopped = true;
    clearTimeout(externalProjectRefreshTimer);
    stopMotionQueueStatus?.();
    clearInterval(activityTimer);
    clearInterval(flowHeaderTimer);
    clearInterval(flowProjectMonitor);
    clearInterval(agentHealthTimer);
    clearTimeout(agentHealthDebounce);
    clearTimeout(flowProjectCheckTimer);
    clearTimeout(toastTimer);
    closePreview();
    closeFrameDialog();
    window.imagePickerModal?.close?.();
    releaseStageMedia();
    cancelSplit?.();
    voicePicker?.destroy();
    window.VoiceSelectModal?.hide?.();
    worker?.terminate();
    worker = null;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    const uploadDiagnostic =
      area === "local" && changes.toby_flow_upload_diagnostic?.newValue;
    if (
      uploadDiagnostic &&
      project?.flow_project_id &&
      uploadDiagnostic.projectId === project.flow_project_id &&
      !scopeInvalid
    ) {
      const keys = [
        "requestId",
        "phase",
        "at",
        "visibility",
        "fileIndex",
        "elapsedMs",
        "ownerLatched",
        "pendingObserved",
        "ownerMounted",
        "mountedCount",
        "deltaCount",
        "ownerState",
        "hasPending",
        "hasVideoOwner",
        "hasDurableIdentity",
        "fullScanMs",
        "usedJsHeapMb",
        "totalJsHeapMb",
        "reusedExisting",
        "reconciledPending",
        "sourceFingerprint",
      ];
      console.info(
        "[MotionFlowUploadReceipt]",
        JSON.stringify(
          Object.fromEntries(
            keys
              .filter((key) => uploadDiagnostic[key] !== void 0)
              .map((key) => [key, uploadDiagnostic[key]]),
          ),
        ),
      );
    }
    const externalRun =
      area === "local" && changes.motion_runner_status?.newValue;
    if (externalRun)
      void acceptExternalMotionStatus(externalRun, {
        notify: externalMotionNoticesReady,
      });
    const changedProject =
      area === "local" && changes.motion_project_changed?.newValue;
    if (
      changedProject &&
      Number(changedProject.userId) === userId &&
      changedProject.projectId === projectId
    ) {
      externalProjectDirty = true;
      scheduleExternalProjectRefresh();
    }
    const locale = window.I18n?.getLocale?.();
    const updatedTranslations =
      area === "local" && locale
        ? changes[`toby_i18n_${locale}`]?.newValue?.data
        : null;
    if (updatedTranslations && typeof updatedTranslations === "object") {
      window.I18n?._mergeTranslations?.(locale, updatedTranslations);
      refreshMotionTranslations();
    }
    if (
      area === "local" &&
      changes.af_locale?.newValue &&
      window.I18n?.getLocale?.() !== changes.af_locale.newValue
    ) {
      void window.I18n?.setLocale?.(changes.af_locale.newValue);
    }
    if (
      area === "session" &&
      (changes.targetFlowTabId || changes.targetFlowContext)
    )
      scheduleFlowProjectCheck();
    if (area === "local" && changes.af_settings) {
      flowHeaderHealth = null;
      flowHeaderHealthAt = 0;
      renderProjectFlowMode(changes.af_settings.newValue);
    }
    if (area !== "local" || !changes.af_auth) return;
    const next = changes.af_auth.newValue;
    if (Number(next?.user?.id) !== userId) {
      cancelled = true;
      scopeInvalid = true;
      cancelSplit?.();
      closePreview();
      closeFrameDialog();
      window.imagePickerModal?.close?.();
      releaseStageMedia();
      profile = null;
      updateButtons();
      status(
        motionText(
          "text237",
          "T\xE0i kho\u1EA3n \u0111\xE3 thay \u0111\u1ED5i. \u0110\xF3ng v\xE0 m\u1EDF l\u1EA1i Motion project.",
        ),
      );
      return;
    }
    if (next.token) window.authManager.token = next.token;
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(settingsSaveTimer);
    clearTimeout(savedHintTimer);
    clearTimeout(referenceStatusTimer);
    settingsReady = false;
    helperObserver.disconnect();
    for (const timer of helperTimers.values()) clearTimeout(timer);
    helperTimers.clear();
  });
  $("motionEditorLoadingRetry").addEventListener("click", async () => {
    if (!configBootFailed) {
      window.location.reload();
      return;
    }
    const button = $("motionEditorLoadingRetry");
    if (button.disabled) return;
    button.disabled = true;
    try {
      const result = await window.ConfigAccessUI.retry("motion_boot");
      if (!result?.success)
        window.ConfigAccessUI.showForAction({
          code: result?.error?.code || "CONFIG_FETCH_FAILED",
        });
    } catch (error) {
      window.ConfigAccessUI.showForAction({
        code: error?.code || "CONFIG_FETCH_FAILED",
        retryable: true,
      });
    } finally {
      button.disabled = false;
    }
  });
  $("motionFlowProjectRetry").addEventListener(
    "click",
    () => void checkOpenFlowProject({ manual: true }),
  );
  $("motionFlowProjectClose").addEventListener("click", () => window.close());
  chrome.tabs.onUpdated.addListener(scheduleFlowProjectCheck);
  chrome.tabs.onRemoved.addListener((tabId) => {
    scheduleFlowProjectCheck();
    if (externalMotionRun?.hostTabId !== tabId || !motionRunning) return;
    externalMotionRun = {
      ...externalMotionRun,
      state: "needs_review",
      error: "MOTION_RUNNER_HOST_CLOSED",
    };
    motionRunning = false;
    settleActivity();
    updateButtons();
    status("MOTION_RUNNER_HOST_CLOSED");
  });
  chrome.tabs.onCreated.addListener(scheduleAgentHealthCheck);
  chrome.tabs.onUpdated.addListener(scheduleAgentHealthCheck);
  chrome.tabs.onRemoved.addListener(scheduleAgentHealthCheck);
  window.addEventListener("focus", scheduleFlowProjectCheck);
  window.addEventListener("focus", scheduleAgentHealthCheck);
  boot()
    .then(async () => {
      void offerNewProjectMaxSpeed();
      await checkOpenFlowProject();
      const savedRun = (
        await chrome.storage.local
          .get(`motion_runner_status:${userId}:${projectId}`)
          .catch(() => ({}))
      )?.[`motion_runner_status:${userId}:${projectId}`];
      if (savedRun)
        await acceptExternalMotionStatus(savedRun, { notify: false });
      externalMotionNoticesReady = true;
      flowProjectMonitor = setInterval(() => void checkOpenFlowProject(), 5e3);
      const overlay = $("motionEditorLoading");
      overlay.classList.add("is-out");
      overlay.addEventListener("transitionend", () => overlay.remove(), {
        once: true,
      });
      setTimeout(() => overlay.remove(), 400);
    })
    .catch((error) => {
      const missingConfig = window.ConfigRequiredError?.is?.(error) === true;
      configBootFailed = missingConfig || error?.message === "AUTH_REQUIRED";
      if (missingConfig)
        window.ConfigErrorHandler.handle(error, "Motion initialization");
      else if (error?.message === "AUTH_REQUIRED")
        window.ConfigAccessUI.show({ code: "AUTH_REQUIRED" });
      const accessGroup = missingConfig
        ? window.ConfigAccessUI._accessGroup(error?.code || "")
        : null;
      const accessMessageKey =
        accessGroup === "pending"
          ? "common.loading"
          : accessGroup && accessGroup !== "service"
            ? `configAccess.${accessGroup}`
            : null;
      const accessMessage = accessMessageKey
        ? window.I18n?.t?.(accessMessageKey)
        : null;
      const message = accessMessageKey
        ? accessMessage && accessMessage !== accessMessageKey
          ? accessMessage
          : error.code
        : missingConfig
          ? window.ConfigErrorHandler._t("config.offline")
          : motionErrorMessage(error);
      console.error("[Motion] Editor initialization failed", {
        code: error?.code || error?.message,
        configKey: error?.configKey || null,
        httpStatus: error?.httpStatus || null,
        stage: error?.motionBootStage || null,
      });
      $("motionEditorLoadingSpinner").hidden = true;
      $("motionEditorLoadingText").hidden = false;
      $("motionEditorLoadingText").textContent =
        accessGroup === "pending"
          ? message
          : motionFormat(
              "text218",
              "Kh\xF4ng t\u1EA3i \u0111\u01B0\u1EE3c Motion Studio: {0}",
              [message],
            );
      $("motionEditorLoadingRetry").hidden = false;
    });
})();
